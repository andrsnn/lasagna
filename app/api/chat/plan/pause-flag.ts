// Shared key + helpers for the user-initiated plan pause signal.
//
// The /api/chat/plan-pause route writes a flag into the per-stream
// scratchpad under this key; the orchestrator polls it between steps and
// the step executor polls it between rounds. A non-null read means the
// user clicked Stop and the worker should gracefully bail with
// PlanPausedNeedsContinueError (same path as chain-exhaust pause).
//
// The flag is cleared at the top of /api/chat/plan-continue so a fresh
// chain doesn't immediately re-pause.

import {
  clearStreamScratchpad,
  getStreamScratchpad,
} from "@/app/lib/stream-store";

export const PLAN_PAUSE_REQUEST_KEY = "plan:pause-requested";

export type PausePayload = { requestedAt: number };

export async function isPauseRequested(streamId: string): Promise<boolean> {
  const v = await getStreamScratchpad<PausePayload>(
    streamId,
    PLAN_PAUSE_REQUEST_KEY
  );
  return v != null;
}

export async function clearPauseRequest(streamId: string): Promise<void> {
  await clearStreamScratchpad(streamId, PLAN_PAUSE_REQUEST_KEY);
}
