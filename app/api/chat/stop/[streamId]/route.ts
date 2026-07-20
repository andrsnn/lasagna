// User-initiated hard stop for any chat stream (plan-mode or otherwise).
//
// Writes a flag into the per-stream scratchpad. The main work loop polls
// the flag at round boundaries; the plan orchestrator / step executor
// poll it alongside the existing pause flag. On a hit the worker emits
// a terminal `error: "Stopped by user."` event and exits, so the bubble
// lands in the standard errored shape (Continue / Retry affordances).
//
// Best-effort: a 410 (no meta) or 409 (already terminal) is a no-op the
// client can ignore — the row will already be in (or about to land in)
// the terminal state the user wanted.
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
    return err(409, "Stream is not running; nothing to stop.");
  }

  await setStopRequest(streamId);

  return Response.json({ streamId, stopped: "requested" }, { status: 202 });
}
