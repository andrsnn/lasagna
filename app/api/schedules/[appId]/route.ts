import { waitUntil } from "@vercel/functions";
import { parseCron, isDue } from "@/app/lib/cron-eval";
import { getCurrentUserEmail } from "@/app/lib/current-user";
import {
  acquireBudget,
  acquireLock,
  getPauseState,
  getSnapshot,
  getUserPauseState,
  isScheduleStoreConfigured,
  releaseLock,
  unregisterApp,
} from "@/app/lib/schedule-store";
import { runScheduledTask } from "@/app/lib/run-schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Read the current snapshot for an app's schedule. If the cached result is
 * stale per the cron and the per-app hourly budget is available, fires a
 * background run via waitUntil. The response always returns immediately —
 * the iframe polls until status flips out of "running".
 */
export async function GET(req: Request, ctx: { params: Promise<{ appId: string }> }) {
  if (!isScheduleStoreConfigured()) {
    return Response.json({ error: "Schedules disabled." }, { status: 503 });
  }
  const { appId } = await ctx.params;
  if (!appId) return Response.json({ error: "appId required." }, { status: 400 });

  const snap = await getSnapshot(appId);
  if (!snap) return Response.json({ error: "Not registered." }, { status: 404 });

  // A pause must suppress EVERY unattended auto-run, not just the cron sweep.
  // Without this guard, merely opening an app (or the Control Center polling
  // each row's snapshot) would catch-up-fire a due task and burn tokens -
  // exactly what pausing is meant to prevent. Two flags apply: the global
  // (admin) kill-switch, and the per-user pause set from the Control Center
  // (the caller is viewing their own app, so their pause governs it). Manual
  // "Run now" stays exempt: that's a deliberate click, handled by a separate
  // route that never reaches here.
  const email = await getCurrentUserEmail(req);
  const [globalPause, userPause] = await Promise.all([
    getPauseState(),
    email ? getUserPauseState(email) : Promise.resolve({ paused: false }),
  ]);
  const paused = globalPause.paused || userPause.paused;

  const cron = parseCron(snap.task.cron);
  // Only catch up when no pause is in effect, the user hasn't paused this
  // schedule, and there's a prior result that's gone stale. A brand-new
  // artifact's first run waits for an explicit "Run now" or the next cron
  // sweep, so the user isn't locked out by an auto-fire they never asked for.
  if (
    !paused &&
    snap.enabled &&
    cron.ok &&
    snap.runAt != null &&
    isDue(cron.spec, snap.runAt, Date.now())
  ) {
    // Try to grab the budget + lock. If either fails, just return the
    // current snapshot — the next visit will retry.
    const budget = await acquireBudget(appId);
    if (budget.ok) {
      const got = await acquireLock(appId);
      if (got) {
        snap.status = "running";
        waitUntil(
          (async () => {
            try {
              await runScheduledTask(appId, snap.task);
            } finally {
              await releaseLock(appId);
            }
          })()
        );
      }
    }
  }

  return Response.json(snap, { status: 200 });
}

/**
 * Unregister this app's schedule. Best-effort cleanup called from the
 * client when an app is archived.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ appId: string }> }) {
  if (!isScheduleStoreConfigured()) {
    return Response.json({ ok: true }, { status: 200 });
  }
  const { appId } = await ctx.params;
  if (!appId) return Response.json({ error: "appId required." }, { status: 400 });
  await unregisterApp(appId);
  return Response.json({ ok: true }, { status: 200 });
}
