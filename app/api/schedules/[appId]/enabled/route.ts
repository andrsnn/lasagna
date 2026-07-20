import {
  getSnapshot,
  isScheduleStoreConfigured,
  setScheduleEnabled,
} from "@/app/lib/schedule-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pause or resume an app's scheduled task without removing it. Body:
 * `{ enabled: boolean }`. Pausing leaves the cron, cached result, and run
 * history in place — the sweep and catch-up-on-visit just skip it until
 * resumed. Manual "Run now" stays available either way. Returns the updated
 * snapshot so the caller can reflect the new state immediately.
 */
export async function POST(req: Request, ctx: { params: Promise<{ appId: string }> }) {
  if (!isScheduleStoreConfigured()) {
    return Response.json({ error: "Schedules disabled." }, { status: 503 });
  }
  const { appId } = await ctx.params;
  if (!appId) return Response.json({ error: "appId required." }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") {
    return Response.json({ error: "Body must be { enabled: boolean }." }, { status: 400 });
  }

  const found = await setScheduleEnabled(appId, body.enabled);
  if (!found) return Response.json({ error: "Not registered." }, { status: 404 });

  const snap = await getSnapshot(appId);
  return Response.json(snap, { status: 200 });
}
