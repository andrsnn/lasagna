import {
  clearUserCronOverride,
  isScheduleStoreConfigured,
} from "@/app/lib/schedule-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drop the user's cadence override and (when known) restore the artifact's
 * default cron. Subsequent manifest / SDK auto-registers regain the right
 * to set cadence.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ appId: string }> }) {
  if (!isScheduleStoreConfigured()) {
    return Response.json({ error: "Schedules disabled." }, { status: 503 });
  }
  const { appId } = await ctx.params;
  if (!appId) return Response.json({ error: "appId required." }, { status: 400 });
  try {
    await clearUserCronOverride(appId);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Reset failed" },
      { status: 500 }
    );
  }
  return Response.json({ ok: true }, { status: 200 });
}
