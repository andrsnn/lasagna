"use client";

import { useCallback, useEffect, useState } from "react";
import { SCHEDULE_CHANNEL_PREFIX } from "@/app/components/artifact-frame";
import type { ScheduleSnapshot } from "@/app/lib/artifact/sdk-protocol";
import { nextAvailableMessage } from "@/app/lib/visuals";

const POLL_INTERVAL_MS = 4000;
const BROADCAST_ORIGIN = "use-schedule";

// Fan out a freshly-fetched snapshot to other frames for the same app —
// notably the widget on the home dashboard, which doesn't poll on its own.
// The artifact-frame schedule listener filters by origin, so we use a
// non-frame sentinel here that no frame will match.
function broadcast(appId: string, snap: ScheduleSnapshot): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const ch = new BroadcastChannel(`${SCHEDULE_CHANNEL_PREFIX}${appId}`);
    ch.postMessage({
      type: "schedule-updated",
      payload: snap,
      origin: BROADCAST_ORIGIN,
    });
    ch.close();
  } catch {
    // best-effort
  }
}

export type UseScheduleResult = {
  /** "loading" until the first fetch resolves; null when no schedule is configured. */
  snap: ScheduleSnapshot | null | "loading";
  /** True while a Run-now request is in flight (separate from snap.status === "running"). */
  running: boolean;
  /** Latest run-now error (e.g. 429 budget exhaustion). Cleared on next attempt. */
  error: string | null;
  /** Trigger a Run-now request. Polls automatically once started. */
  runNow: () => Promise<void>;
  /** Pause/resume the schedule's unattended auto-fire. No-op when the app has
   *  no schedule registered. Updates the snapshot in place on success. */
  setEnabled: (enabled: boolean) => Promise<void>;
  /** Re-fetch the snapshot. */
  refresh: () => Promise<void>;
};

/**
 * Fetches the schedule snapshot for an app and exposes a Run-now trigger.
 * Auto-polls while a run is in flight so the UI converges to the final state.
 */
export function useSchedule(appId: string, reloadKey?: number): UseScheduleResult {
  const [snap, setSnap] = useState<ScheduleSnapshot | null | "loading">("loading");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/schedules/${encodeURIComponent(appId)}`, {
        cache: "no-store",
      });
      if (r.status === 404) {
        setSnap(null);
        return;
      }
      if (!r.ok) throw new Error(`fetch failed (${r.status})`);
      const next = (await r.json()) as ScheduleSnapshot;
      setSnap(next);
      broadcast(appId, next);
      if (next && next.status === "running") {
        setTimeout(() => void refresh(), POLL_INTERVAL_MS);
      }
    } catch {
      setSnap(null);
    }
  }, [appId]);

  useEffect(() => {
    void refresh();
  }, [refresh, reloadKey]);

  const runNow = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await fetch(`/api/schedules/${encodeURIComponent(appId)}/run`, {
        method: "POST",
      });
      if (r.status === 429) {
        const body = (await r.json().catch(() => ({}))) as {
          error?: string;
          retryAfterMs?: number;
        };
        setError(nextAvailableMessage(body.retryAfterMs));
      } else if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Scan failed (${r.status}). Try again.`);
      } else {
        await refresh();
      }
    } finally {
      setRunning(false);
    }
  }, [appId, refresh]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      // Optimistically flip the local flag so the toggle feels instant; the
      // server response (or a failure refresh) reconciles it.
      setSnap((prev) =>
        prev && prev !== "loading" ? { ...prev, enabled } : prev
      );
      try {
        const r = await fetch(
          `/api/schedules/${encodeURIComponent(appId)}/enabled`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
          }
        );
        if (!r.ok) {
          await refresh();
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `Couldn't update (${r.status}).`);
          return;
        }
        const next = (await r.json()) as ScheduleSnapshot;
        setSnap(next);
        if (next) broadcast(appId, next);
      } catch (e) {
        await refresh();
        setError(e instanceof Error ? e.message : "Couldn't update the schedule.");
      }
    },
    [appId, refresh]
  );

  return { snap, running, error, runNow, setEnabled, refresh };
}
