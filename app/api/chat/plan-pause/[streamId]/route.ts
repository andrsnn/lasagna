// User-initiated pause for a plan-mode stream that's still running.
//
// Writes a pause-requested flag into the per-stream scratchpad. The plan
// orchestrator polls this flag between steps, and the step executor polls
// it between rounds; either site throws PlanPausedNeedsContinueError on a
// hit, which routes through the same flow as the graceful chain-exhaust
// pause: emit `plan_paused`, save checkpoint, set meta.status="error" with
// error="plan_paused". The UI's existing "Continue plan" button then routes
// back through /api/chat/plan-continue to resume from the next un-done step
// with no replanning.
//
// Best-effort: if the worker has already finished or died before the flag
// is observed, the bubble simply terminates as it would have anyway. The
// flag is cleared on the next plan-continue so a stale flag never auto-
// pauses the resumed worker.
//
// Auth: session-cookie via proxy.ts middleware.

import {
  getMeta,
  isStreamStoreConfigured,
  setStreamScratchpad,
} from "@/app/lib/stream-store";
import { PLAN_PAUSE_REQUEST_KEY } from "@/app/api/chat/plan/pause-flag";

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
    return err(409, "Stream is not running; nothing to pause.");
  }

  await setStreamScratchpad(streamId, PLAN_PAUSE_REQUEST_KEY, {
    requestedAt: Date.now(),
  });

  return Response.json({ streamId, paused: "requested" }, { status: 202 });
}
