import { waitUntil } from "@vercel/functions";
import {
  acquireLock,
  getMeta,
  getResult,
  isScheduleStoreConfigured,
  releaseLock,
  setResult,
} from "@/app/lib/schedule-store";
import { runScheduledTask } from "@/app/lib/run-schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Manually trigger a scheduled task. Bypasses the per-app hourly budget —
 * that cap exists to contain runaway cron sweeps, not to throttle a user
 * who deliberately clicks Run now (especially after a failed scan, when
 * sitting on a "wait 5 hours" message is the worst possible UX). The lock
 * still serializes concurrent clicks so two runs never race.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ appId: string }> }) {
  if (!isScheduleStoreConfigured()) {
    return Response.json({ error: "Schedules disabled." }, { status: 503 });
  }
  const { appId } = await ctx.params;
  if (!appId) return Response.json({ error: "appId required." }, { status: 400 });

  const meta = await getMeta(appId);
  if (!meta) return Response.json({ error: "Not registered." }, { status: 404 });

  const got = await acquireLock(appId);
  if (!got) {
    return Response.json({ error: "Another run is in progress." }, { status: 409 });
  }
  // Write status="running" SYNCHRONOUSLY before returning 202. The actual work
  // runs inside waitUntil and may not have started by the time the client
  // calls refresh(); without this pre-mark, the client sees a stale snapshot,
  // useSchedule's "poll while running" branch never trips, and the panel
  // looks frozen until the user hits reload. Preserve the prior result so
  // a successful "Last scan" timestamp/payload doesn't disappear during a
  // mid-run refresh.
  const prior = await getResult(appId);
  await setResult(appId, {
    result: prior?.result ?? null,
    runAt: prior?.runAt ?? Date.now(),
    status: "running",
  });
  waitUntil(
    (async () => {
      try {
        await runScheduledTask(appId, meta.task);
      } finally {
        await releaseLock(appId);
      }
    })()
  );
  return Response.json({ ok: true }, { status: 202 });
}
