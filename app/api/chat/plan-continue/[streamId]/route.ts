// User-initiated continuation for a plan-mode stream that hit the
// chain-exhaustion wall.
//
// When the 3-worker chain runs out mid-plan with steps remaining, the
// final worker throws PlanPausedNeedsContinueError, persists the
// checkpoint, and writes meta.status="error" with error="plan_paused".
// The client surfaces a "Continue plan" button on the assistant message;
// pressing it POSTs here, and this route:
//   1. Loads the paused checkpoint (cfg.planModeEnabled is sticky)
//   2. Resets meta to status="running" with workerSeq=1 — granting a fresh
//      3-worker (~15min) chain budget
//   3. Re-enters runChatWork. The plan orchestrator reads the cached steps
//      from the Redis scratchpad and resumes at the first uncached step.
//
// Auth: session-cookie via proxy.ts middleware (same as POST /api/chat).
// HMAC continuation (used for server-to-server handoffs) is wrong for this
// route because the caller is the user's browser and the route is
// explicitly rewinding workerSeq — both contradicting the HMAC route's
// "only advance seq" semantics.

import { waitUntil } from "@vercel/functions";
import {
  enqueueJob,
  getMeta,
  isStreamStoreConfigured,
  loadCheckpoint,
  saveJobPayload,
  setMeta,
  getStreamScratchpad,
  type JobPayload,
} from "@/app/lib/stream-store";
import { runChatWork } from "@/app/api/chat/work";
import type { VfsContext } from "@/app/lib/ollama/tools";
import { clearPauseRequest } from "@/app/api/chat/plan/pause-flag";
import { clearStopRequest } from "@/app/api/chat/stop-flag";
import type { Plan } from "@/app/api/chat/plan/prompts";
import { isFlyWorkerConfigured, wakeWorker } from "@/app/lib/fly-wake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function err(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ streamId: string }> }
) {
  if (!isStreamStoreConfigured()) {
    return err(503, "Resumable streams are disabled.");
  }

  const { streamId } = await params;
  if (!streamId || typeof streamId !== "string") {
    return err(400, "Missing streamId.");
  }

  const meta = await getMeta(streamId);
  if (!meta) return err(410, "Stream meta expired.");
  // Only valid against a terminal stream — either explicitly plan_paused,
  // or one whose scratchpad still has a plan we could resume. The second
  // case covers a hard error during plan execution where we'd still rather
  // pick up from cached steps than restart.
  if (meta.status === "running") {
    return err(409, "Stream is still running; nothing to continue.");
  }
  const hasPlan = !!(await getStreamScratchpad<Plan>(streamId, "plan:outline"));
  if (!hasPlan) {
    return err(409, "No plan to continue (scratchpad empty or evicted).");
  }

  const cp = await loadCheckpoint(streamId);
  if (!cp) return err(410, "No checkpoint to resume from.");

  // Clear any user pause / stop flag from the prior chain. Otherwise the
  // orchestrator's pre-step check would immediately re-pause / re-terminate
  // the fresh worker.
  await clearPauseRequest(streamId);
  await clearStopRequest(streamId);

  const resumedCfg = { ...cp.cfg, planModeEnabled: true };

  // Pick the producer up front: if this stream was originally launched
  // against Fly AND Fly is still configured, the continuation re-enters
  // the same job queue; otherwise it runs under waitUntil on Vercel.
  // The resume route's stale-detection ceiling depends on which it is.
  const useFlyWorker =
    resumedCfg.flyWorker === true && isFlyWorkerConfigured();

  // Reset meta to running, workerSeq=1 — fresh chain budget. Keep chatId
  // and messageId so the resume route's stale-detection works as before.
  const now = Date.now();
  await setMeta(streamId, {
    status: "running",
    chatId: meta.chatId,
    messageId: meta.messageId,
    createdAt: meta.createdAt ?? now,
    workerStartedAt: now,
    workerSeq: 1,
    producer: useFlyWorker ? "fly" : "vercel",
    kvLossy: meta.kvLossy,
  });

  // Off-Vercel resume path. If this stream was originally launched against
  // the Fly worker (cfg.flyWorker sticky) AND the server still has Fly
  // configured, re-route the continuation through the same job queue the
  // initial POST uses. Without this branch, plan-continue would run the
  // resumed work inside `waitUntil` on Vercel — which has the standard
  // maxDuration cap and defeats the whole point of fly-worker mode for any
  // step that legitimately needs the wall-clock headroom.
  if (useFlyWorker) {
    const payload: JobPayload = {
      v: 1,
      conv: cp.conv,
      vfsCtx: cp.vfsCtx,
      initialFiles: cp.initialFiles,
      cfg: resumedCfg,
      // Resume payloads carry no incoming user messages: the prior worker
      // already inlined images / PDFs into `conv` before checkpointing.
      incoming: [],
      resume: {
        parser: cp.parser,
        totals: cp.totals,
        flags: cp.flags,
        kvLossy: cp.kvLossy,
      },
    };

    try {
      await saveJobPayload(streamId, payload);
      await enqueueJob(streamId);
    } catch (jobErr) {
      console.warn(
        `[chat ${streamId}] plan-continue: failed to enqueue Fly job`,
        jobErr
      );
      return err(503, "Failed to enqueue continuation.");
    }

    void wakeWorker();
    return Response.json({ streamId, resumed: true }, { status: 202 });
  }

  // Fallback: in-process producer on Vercel (local dev / non-Fly deploys).
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
      workerSeq: 1,
      conv: cp.conv,
      vfsCtx,
      initialFiles: cp.initialFiles,
      cfg: resumedCfg,
      parserState: cp.parser,
      totals: cp.totals,
      flags: cp.flags,
      startRound: 0,
      skipPreprocessing: true,
      kvLossy: cp.kvLossy,
    })
  );

  return Response.json({ streamId, resumed: true }, { status: 202 });
}
