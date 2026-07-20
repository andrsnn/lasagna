// Continuation handler for chained chat workers.
//
// The original POST /api/chat worker fires a fire-and-forget POST here once
// it has been alive long enough that Vercel will soon kill it at maxDuration.
// We pick up the checkpoint from Redis, advance meta.workerSeq, and run
// `runChatWork` again — emitting into the SAME streamId so the client's
// existing /api/chat/resume reader keeps streaming without noticing the swap.

import { waitUntil } from "@vercel/functions";
import {
  MAX_WORKER_SEQ,
  getMeta,
  isStreamStoreConfigured,
  loadCheckpoint,
  setMeta,
  tryAcquireWorkerSlot,
} from "@/app/lib/stream-store";
import { runChatWork } from "@/app/api/chat/work";
import { verifyHmac } from "@/app/api/chat/continue/_sig";
import type { VfsContext } from "@/app/lib/ollama/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function err(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ streamId: string }> }
) {
  if (!isStreamStoreConfigured()) {
    return err(503, "Resumable streams are disabled.");
  }

  const { streamId } = await params;
  if (!streamId || typeof streamId !== "string") {
    return err(400, "Missing streamId.");
  }

  const seqHeader = req.headers.get("x-continue-seq");
  const sigHeader = req.headers.get("x-continue-sig");
  const seq = Number(seqHeader);
  if (!seqHeader || !sigHeader || !Number.isFinite(seq)) {
    return err(400, "Missing continuation headers.");
  }
  // Cheap upper bound to reject nonsense before we touch Redis. The real
  // per-stream cap comes from the checkpoint's cfg.maxWorkerSeq below — deep
  // research streams pass a higher value than the global default.
  if (seq < 2 || seq > 10) {
    return err(400, `Invalid seq ${seq}.`);
  }
  if (!verifyHmac(`${streamId}|${seq}`, sigHeader)) {
    return err(403, "Invalid signature.");
  }

  const meta = await getMeta(streamId);
  if (!meta) return err(410, "Stream meta expired.");
  if (meta.status !== "running") {
    // Already terminal — the previous worker emitted done/error before
    // the handoff fired. No-op so we don't reanimate a finished chain.
    return err(409, `Stream is ${meta.status}.`);
  }
  // Idempotency: if a duplicate continuation arrives we don't want to spin
  // up a second worker concurrently with the first.
  if ((meta.workerSeq ?? 1) >= seq) {
    return err(409, "Worker sequence already advanced.");
  }
  if (!(await tryAcquireWorkerSlot(streamId, seq))) {
    return err(409, "Continuation slot already taken.");
  }

  const cp = await loadCheckpoint(streamId);
  if (!cp) return err(410, "No checkpoint to resume from.");

  // Authoritative per-stream worker cap (research streams set this higher
  // than the global default). Reject continuations past the cap — the previous
  // worker was supposed to run to its 300s wall on the final seq instead of
  // handing off, but a stale signed URL could still arrive here.
  const cap = cp.cfg.maxWorkerSeq ?? MAX_WORKER_SEQ;
  if (seq > cap) {
    return err(400, `Invalid seq ${seq} (cap ${cap}).`);
  }

  const now = Date.now();
  await setMeta(streamId, {
    ...meta,
    status: "running",
    workerStartedAt: now,
    workerSeq: seq,
    // Chained continuations always run via waitUntil on Vercel — even when
    // the prior worker ran on Fly. Override producer so the resume route
    // applies the Vercel stale-detection ceiling against the new wall
    // clock instead of inheriting "fly" from the prior worker.
    producer: "vercel",
  });

  // Rehydrate the VFS context — the checkpoint stores readPaths as an array
  // because Sets aren't JSON-serializable.
  const vfsCtx: VfsContext | null = cp.vfsCtx
    ? {
        files: cp.vfsCtx.files,
        entry: cp.vfsCtx.entry,
        readPaths: new Set(cp.vfsCtx.readPaths),
        changes: cp.vfsCtx.changes,
        lastBuild: cp.vfsCtx.lastBuild,
        mode: cp.vfsCtx.mode,
        selection: cp.vfsCtx.selection,
      }
    : null;

  waitUntil(
    runChatWork({
      streamId,
      workerSeq: seq,
      conv: cp.conv,
      vfsCtx,
      initialFiles: cp.initialFiles,
      cfg: cp.cfg,
      parserState: cp.parser,
      totals: cp.totals,
      flags: cp.flags,
      startRound: cp.round,
      skipPreprocessing: true,
      kvLossy: cp.kvLossy,
    })
  );

  return new Response(null, { status: 202 });
}
