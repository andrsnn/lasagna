// User-initiated stop for an in-flight chat "Structured research" run.
//
// Writes the same per-stream stop flag the chat work loop uses. The
// structured-research producer (Fly worker or the in-process waitUntil
// fallback) threads a `shouldStop` check down through executeResearch into
// the orchestrator's round loop, so on a hit the run bails at the next safe
// boundary (round / sub-agent / synthesis) instead of running to completion
// and burning compute.
//
// Best-effort by design: the in-chat viewer marks the run "stopped" locally
// the moment the user clicks Stop (and halts its own polling), so a 410 (meta
// expired) or 409 (already terminal) here is a no-op the client can ignore —
// there's nothing left to halt.
//
// Auth: session-cookie via proxy.ts middleware.

import { getMeta, isStreamStoreConfigured } from "@/app/lib/stream-store";
import { setStopRequest } from "@/app/api/chat/stop-flag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  if (meta.status !== "running") {
    return err(409, "Run is not in progress; nothing to stop.");
  }

  await setStopRequest(streamId);

  return Response.json({ streamId, stopped: "requested" }, { status: 202 });
}
