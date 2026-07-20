// /api/health — the user-facing "is anything down?" probe behind
// Preferences → Debug's System status card.
//
// Returns whether the model provider(s) and the sync/streaming backend are
// reachable, so a user staring at a chat stuck on "Thinking…" can tell the
// difference between "the model is down" and "something on our side is wedged"
// (in which case an admin reaches for /admin/diagnostics). Carries no secrets
// and no worker/queue internals — those are admin-only.

import { collectUserHealth } from "@/app/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Honor the caller's per-user RunPod endpoint id (same convention as
  // /api/models) so a RunPod user's provider row reflects their endpoint.
  const runpodEndpoint = new URL(req.url).searchParams.get("runpodEndpoint")?.trim();
  const health = await collectUserHealth(runpodEndpoint || undefined);
  return Response.json(health);
}
