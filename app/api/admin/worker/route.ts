// Admin worker control — hard-reset / kill the Fly.io chat worker.
//
// The scale-to-zero worker (worker/index.ts) can wedge: runChatWork has no
// AbortSignal, so a provider or tool call that never returns pins a
// concurrency slot until the hour-long kill timer fires. When that happens a
// chat looks "stuck" and the round-boundary / mid-stream Stop checks can't
// reach it (they only fire around token streaming, not a hung tool call).
//
// This route drives the Fly Machines API directly so an admin can force-kill
// the wedged process and bring a fresh one up on demand:
//   GET  → machine status ({ configured, state, ... }).
//   POST → { action: "restart" | "stop" } performs it and returns the new state.
//
// There is no long-lived "Vercel worker" to kill — the in-process waitUntil
// path is ephemeral per request and dies with its function invocation. Fly is
// the only durable producer, so it's the only thing worth a reset button.
//
// Auth: /api/admin/* is gated to admins by proxy.ts middleware.

import {
  getWorkerStatus,
  isFlyWorkerConfigured,
  restartWorker,
  stopWorker,
} from "@/app/lib/fly-wake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = await getWorkerStatus();
  return Response.json(status);
}

export async function POST(req: Request) {
  if (!isFlyWorkerConfigured()) {
    return Response.json(
      {
        error:
          "Fly worker is not configured on this deployment (FLY_API_TOKEN / FLY_APP_NAME / FLY_MACHINE_ID). There's no durable worker to reset.",
      },
      { status: 503 }
    );
  }

  let body: { action?: unknown };
  try {
    body = (await req.json()) as { action?: unknown };
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";

  try {
    if (action === "restart") {
      const { state } = await restartWorker();
      return Response.json({ ok: true, action, state });
    }
    if (action === "stop") {
      const { state } = await stopWorker();
      return Response.json({ ok: true, action, state });
    }
    return Response.json(
      { error: `Unknown action "${action}". Use "restart" or "stop".` },
      { status: 400 }
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Worker action failed." },
      { status: 502 }
    );
  }
}
