// /api/admin/diagnostics — the deep health readout behind /admin/diagnostics.
//
// Everything /api/health returns, plus the Fly worker's machine state, the
// depth of every job queue, and the count of chat streams in flight. This is
// the "what's actually wedged?" view: providers green but the Chat queue is
// backed up and the worker is stopped → wake/reset the worker; providers green,
// queues empty, but streams piling up → stale stream state to clear in Redis.
//
// Auth: /api/admin/* is gated to admins by proxy.ts before the handler runs,
// so no per-route isAdmin check is needed here.

import { collectAdminDiagnostics } from "@/app/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const runpodEndpoint = new URL(req.url).searchParams.get("runpodEndpoint")?.trim();
  const diagnostics = await collectAdminDiagnostics(runpodEndpoint || undefined);
  return Response.json(diagnostics);
}
