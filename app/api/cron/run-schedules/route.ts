import { parseCron, isDue } from "@/app/lib/cron-eval";
import {
  acquireBudget,
  acquireLock,
  getMeta,
  getPauseState,
  getResult,
  isScheduleStoreConfigured,
  listAllAppsWithSchedules,
  listPausedUsers,
  recordLastRun,
  releaseLock,
} from "@/app/lib/schedule-store";
import { runScheduledTask } from "@/app/lib/run-schedule";
import { captureError } from "@/app/lib/error-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_APPS_PER_INVOCATION = 50;

export type SweepReport = {
  total: number;
  attempted: number;
  ran: number;
  skippedNotDue: number;
  skippedRateLimit: number;
  skippedLocked: number;
  /** Apps whose schedule the user paused (meta.enabled === false). Counted
   *  but never run, so a paused task costs nothing per sweep. */
  skippedDisabled: number;
  /** Apps whose owner paused ALL their scheduled tasks from the Control
   *  Center (per-user kill-switch). Skipped without touching the schedule so
   *  resuming re-arms every one of that user's apps at once. */
  skippedUserPaused: number;
  /** When `force` is true the cron-due check is bypassed; callers should
   *  use this for admin-triggered "run all enqueued tasks" testing only. */
  forced?: boolean;
  /** Set when the admin pause flag short-circuited the sweep before any
   *  app was visited. The Vercel cron tick still costs a tiny invocation,
   *  but no app tasks (and their LLM calls) run. */
  paused?: boolean;
  errors: string[];
};

/**
 * Walk every registered app, run any whose cron is due (or all if `force`),
 * and return a summary. Used by both the Vercel Cron entrypoint and the
 * admin sweep endpoint. Hard caps to 50 apps per invocation so a long queue
 * doesn't blow Vercel's 5-min Hobby limit.
 */
export async function runScheduleSweep({ force }: { force?: boolean } = {}): Promise<SweepReport> {
  // Admin "pause crons" short-circuit. Vercel still fires the cron tick on
  // its configured schedule (vercel.json), but exiting here means no app
  // tasks run — the savings come from skipping the per-app fan-out.
  const pause = await getPauseState();
  if (pause.paused) {
    return {
      total: 0,
      attempted: 0,
      ran: 0,
      skippedNotDue: 0,
      skippedRateLimit: 0,
      skippedLocked: 0,
      skippedDisabled: 0,
      skippedUserPaused: 0,
      forced: force,
      paused: true,
      errors: [],
    };
  }
  // Owners who paused all their tasks from the Control Center. One read up
  // front, then an O(1) membership test per app below.
  const pausedUsers = await listPausedUsers();
  const apps = await listAllAppsWithSchedules();
  const slice = apps.slice(0, MAX_APPS_PER_INVOCATION);
  const now = Date.now();
  let attempted = 0;
  let ran = 0;
  let skippedRateLimit = 0;
  let skippedNotDue = 0;
  let skippedLocked = 0;
  let skippedDisabled = 0;
  let skippedUserPaused = 0;
  const errors: string[] = [];

  for (const appId of slice) {
    attempted++;
    try {
      const meta = await getMeta(appId);
      if (!meta) continue;
      // Owner paused ALL their scheduled tasks (per-user kill-switch). Leave
      // the schedule intact and skip — resuming re-arms every one of their
      // apps at once. "Run now" stays available.
      if (meta.ownerEmail && pausedUsers.has(meta.ownerEmail.toLowerCase())) {
        skippedUserPaused++;
        continue;
      }
      // User paused this one in the Control Center — keep the schedule and its
      // cached result, just don't auto-fire. "Run now" stays available.
      if (meta.enabled === false) {
        skippedDisabled++;
        continue;
      }
      const cron = parseCron(meta.task.cron);
      if (!cron.ok) {
        errors.push(`${appId}: bad cron (${cron.error})`);
        await captureError({
          source: "sweep",
          message: `Bad cron expression: ${cron.error}`,
          appId,
          context: { cron: meta.task.cron },
        });
        continue;
      }
      // Prefer meta.lastRunAt (1 read) over getResult() (2 reads) for the
      // due check. Schedules registered before lastRunAt existed fall back
      // to the result blob once and get stamped on the next run completion.
      let lastRunAt: number | null = meta.lastRunAt ?? null;
      if (lastRunAt === null) {
        const prior = await getResult(appId);
        lastRunAt = prior?.runAt ?? null;
      }
      if (!force && !isDue(cron.spec, lastRunAt, now)) {
        skippedNotDue++;
        continue;
      }
      const budget = await acquireBudget(appId);
      if (!budget.ok) {
        skippedRateLimit++;
        continue;
      }
      const got = await acquireLock(appId);
      if (!got) {
        skippedLocked++;
        continue;
      }
      try {
        await runScheduledTask(appId, meta.task);
        ran++;
      } finally {
        await releaseLock(appId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${appId}: ${message}`);
      await captureError({
        source: "sweep",
        message,
        stack: err instanceof Error ? err.stack : undefined,
        appId,
      });
    }
  }

  return {
    total: apps.length,
    attempted,
    ran,
    skippedNotDue,
    skippedRateLimit,
    skippedLocked,
    skippedDisabled,
    skippedUserPaused,
    forced: force,
    errors: errors.slice(0, 20),
  };
}

/**
 * Vercel Cron entrypoint. Auth: Vercel injects `CRON_SECRET` in production;
 * we require it via `Authorization: Bearer` so a public URL can't trigger
 * runs.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }
  }
  if (!isScheduleStoreConfigured()) {
    return Response.json({ error: "Schedules disabled." }, { status: 503 });
  }
  const report = await runScheduleSweep();
  return Response.json(report);
}
