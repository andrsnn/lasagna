"use client";

import { setAppArchived } from "@/app/db";

/**
 * User-facing archive/restore orchestration for apps.
 *
 * Archiving an app is two coordinated actions:
 *   1. Flip the local `archivedAt` flag (setAppArchived) so every client
 *      surface - the Apps list, the Home widgets board, the Control Center -
 *      hides the app and the archive panel picks it up.
 *   2. Pause (or resume) the app's server-side scheduled task, because the
 *      cron sweep runs off Redis and can't see IndexedDB. We reuse the same
 *      /enabled route the Control Center uses for its per-app pause.
 *
 * The schedule call is best-effort: apps without a registered schedule return
 * 404 and unconfigured deployments return 503; neither should block the
 * archive itself, so failures are swallowed.
 */

async function setSchedulePaused(appId: string, paused: boolean): Promise<void> {
  try {
    await fetch(`/api/schedules/${encodeURIComponent(appId)}/enabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !paused }),
    });
  } catch {
    // Best-effort: the schedule store may be unconfigured, or the app may have
    // no registered schedule. The local archive flag is the source of truth for
    // the UI either way.
  }
}

/** Archive a single app: flag it locally and pause its schedule. */
export async function archiveAppById(appId: string): Promise<void> {
  await setAppArchived(appId, true);
  await setSchedulePaused(appId, true);
}

/** Archive several apps at once (bulk action from the Apps list). */
export async function archiveAppsByIds(appIds: string[]): Promise<void> {
  await Promise.all(appIds.map((id) => archiveAppById(id)));
}

/** Restore a previously-archived app: clear the flag and resume its schedule. */
export async function restoreAppById(appId: string): Promise<void> {
  await setAppArchived(appId, false);
  await setSchedulePaused(appId, false);
}
