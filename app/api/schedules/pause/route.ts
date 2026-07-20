import { getCurrentUserEmail } from "@/app/lib/current-user";
import {
  getPauseState,
  getUserPauseState,
  isScheduleStoreConfigured,
  setPaused,
  setUserPaused,
} from "@/app/lib/schedule-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * User-facing "pause my scheduled tasks" toggle, surfaced in the Control
 * Center (Manage). Scoped to the signed-in account: pausing here flips a
 * per-user flag (keyed by the caller's email) that the cron sweep and the
 * catch-up-on-visit path both honor, so only THIS user's apps stop
 * auto-firing — everyone else's schedules keep running.
 *
 * This is deliberately NOT the deployment-wide kill-switch: that stays behind
 * the admin route (/api/admin/schedules/pause), which flips the global
 * PAUSED_KEY. When no authenticated email is available (single-tenant / no-auth
 * deployments where getCurrentUserEmail returns null), we fall back to the
 * global flag — for a single user that IS their account-level pause, so the
 * button keeps working unchanged.
 */
export async function GET(req: Request) {
  if (!isScheduleStoreConfigured()) {
    return Response.json({ error: "Schedules disabled." }, { status: 503 });
  }
  const email = await getCurrentUserEmail(req);
  const state = email
    ? await getUserPauseState(email)
    : await getPauseState();
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
  const email = await getCurrentUserEmail(req);
  const state = email
    ? await setUserPaused(email, body.paused)
    : await setPaused(body.paused);
  return Response.json(state);
}
