// Shared key + helpers for the user-initiated abrupt-stop signal.
//
// Distinct from the plan-pause flag in app/api/chat/plan/pause-flag.ts:
//   - plan-pause is a graceful pause that preserves the plan's cached
//     step state and routes through Continue plan with no replanning.
//   - stop is a hard terminate: when the user clicks the composer Stop
//     button, the worker should bail at the next safe boundary and the
//     bubble should land in a regular `error: "Stopped by user."` state
//     so the standard Continue / Retry affordance picks up from there.
//
// On Vercel the composer Stop never actually halted the worker (Vercel's
// own maxDuration eventually cuts it off), so the flag was unnecessary.
// In Fly-worker mode the producer is a long-lived Node process with no
// per-request wall clock — without this flag a Stop click only kills the
// client-side SSE while the worker keeps generating tokens (and burning
// Fly minutes) for as long as the model takes to finish.
//
// The work loop polls this flag at round boundaries and the plan
// orchestrator / step executor poll it alongside the pause flag. Cleared
// at the top of /api/chat/plan-continue and at the start of every fresh
// /api/chat so a stale flag from a prior turn doesn't auto-terminate the
// next one.

import {
  clearStreamScratchpad,
  getStreamScratchpad,
  setStreamScratchpad,
} from "@/app/lib/stream-store";

export const STOP_REQUEST_KEY = "chat:stop-requested";

/** Thrown inside runChatWork / orchestrators when a stop flag is observed.
 *  The outer catch in work.ts treats this as a non-transient terminal
 *  error and surfaces `error: "Stopped by user."` to the client. */
export class UserStoppedError extends Error {
  constructor(message = "Stopped by user.") {
    super(message);
    this.name = "UserStoppedError";
  }
}

export type StopPayload = { requestedAt: number };

export async function setStopRequest(streamId: string): Promise<void> {
  await setStreamScratchpad(streamId, STOP_REQUEST_KEY, {
    requestedAt: Date.now(),
  });
}

export async function isStopRequested(streamId: string): Promise<boolean> {
  const v = await getStreamScratchpad<StopPayload>(streamId, STOP_REQUEST_KEY);
  return v != null;
}

export async function clearStopRequest(streamId: string): Promise<void> {
  await clearStreamScratchpad(streamId, STOP_REQUEST_KEY);
}
