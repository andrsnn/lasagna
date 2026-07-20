import { isScheduleStoreConfigured } from "@/app/lib/schedule-store";
import { runScheduleSweep } from "@/app/api/cron/run-schedules/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Admin trigger — runs every registered schedule regardless of whether its
 * cron is "due", subject to the per-app 6h budget + lock. Use this to
 * verify the executor end-to-end without waiting for the next Vercel Cron
 * tick.
 *
 * Same auth posture as the other /api/admin/* routes — gate behind whatever
 * fronts /admin in your deployment.
 */
export async function POST(req: Request) {
  if (!isScheduleStoreConfigured()) {
    return Response.json({ error: "Schedules disabled." }, { status: 503 });
  }
  const body = (await req
    .json()
    .catch(() => ({}))) as { force?: boolean };
  const report = await runScheduleSweep({ force: body.force === true });
  return Response.json(report);
}
