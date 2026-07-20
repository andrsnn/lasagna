import {
  getPauseState,
  isScheduleStoreConfigured,
  setPaused,
} from "@/app/lib/schedule-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin "pause crons" toggle. Sets a Redis flag the schedule sweep checks
 * at the top of each invocation, so the Vercel cron tick still happens but
 * no app tasks fan out. Same auth posture as the other /api/admin routes.
 */
export async function GET() {
  if (!isScheduleStoreConfigured()) {
    return Response.json({ error: "Schedules disabled." }, { status: 503 });
  }
  const state = await getPauseState();
  return Response.json(state);
}

export async function POST(req: Request) {
  if (!isScheduleStoreConfigured()) {
    return Response.json({ error: "Schedules disabled." }, { status: 503 });
  }
  const body = (await req.json().catch(() => ({}))) as { paused?: boolean };
  if (typeof body.paused !== "boolean") {
    return Response.json(
      { error: "Body must be { paused: boolean }." },
      { status: 400 }
    );
  }
  const state = await setPaused(body.paused);
  return Response.json(state);
}
