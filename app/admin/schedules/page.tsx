"use client";

// /admin/schedules — debug surface for scheduled artifact tasks. Lists every
// registered app, shows the cron + last-run + cached result, and lets you
// trigger the sweep handler so all enqueued tasks fire on demand without
// waiting for the next Vercel Cron tick.

import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, Pause, Play, RefreshCw, Trash2 } from "lucide-react";
import { PaperCard } from "@/app/components/paper-card";
import { H1, H2 } from "@/app/components/serif-heading";
import { Button } from "@/components/ui/button";
import { formatCron } from "@/app/lib/cron-eval";
import { relativeTime } from "@/app/lib/visuals";
import type { ScheduleSnapshot } from "@/app/lib/artifact/sdk-protocol";

type ListResponse = {
  count: number;
  items: Array<{ appId: string; snapshot: ScheduleSnapshot | null }>;
};

type SweepReport = {
  total: number;
  attempted: number;
  ran: number;
  skippedNotDue: number;
  skippedRateLimit: number;
  skippedLocked: number;
  skippedDisabled: number;
  skippedUserPaused: number;
  forced?: boolean;
  paused?: boolean;
  errors: string[];
};

type PauseState = { paused: boolean; since?: number };

export default function SchedulesAdmin() {
  const [items, setItems] = useState<ListResponse["items"]>([]);
  const [loading, setLoading] = useState(false);
  const [sweep, setSweep] = useState<SweepReport | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [force, setForce] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pause, setPauseState] = useState<PauseState | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listRes, pauseRes] = await Promise.all([
        fetch("/api/admin/schedules/list", { cache: "no-store" }),
        fetch("/api/admin/schedules/pause", { cache: "no-store" }),
      ]);
      if (!listRes.ok) {
        const body = (await listRes.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `list failed (${listRes.status})`);
        setItems([]);
      } else {
        const body = (await listRes.json()) as ListResponse;
        setItems(body.items);
      }
      if (pauseRes.ok) {
        setPauseState((await pauseRes.json()) as PauseState);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onTogglePause = useCallback(async () => {
    const next = !(pause?.paused ?? false);
    if (next && !confirm("Pause the cron sweep? Scheduled tasks will stop running until resumed.")) {
      return;
    }
    setPauseBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/schedules/pause", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused: next }),
      });
      const body = (await r.json()) as PauseState | { error?: string };
      if (!r.ok) {
        setError(("error" in body && body.error) || `pause failed (${r.status})`);
      } else {
        setPauseState(body as PauseState);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPauseBusy(false);
    }
  }, [pause]);

  const onSweep = useCallback(async () => {
    setSweeping(true);
    setSweep(null);
    setError(null);
    try {
      const r = await fetch("/api/admin/schedules/sweep", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const body = (await r.json()) as SweepReport | { error?: string };
      if (!r.ok) {
        setError(("error" in body && body.error) || `sweep failed (${r.status})`);
      } else {
        setSweep(body as SweepReport);
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSweeping(false);
    }
  }, [force, refresh]);

  const onUnregister = useCallback(
    async (appId: string) => {
      if (!confirm(`Unregister schedule for ${appId}?`)) return;
      const r = await fetch(`/api/schedules/${encodeURIComponent(appId)}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `unregister failed (${r.status})`);
        return;
      }
      await refresh();
    },
    [refresh]
  );

  const downloadResult = useCallback(
    (appId: string, snap: ScheduleSnapshot) => {
      if (!snap || snap.result == null) return;
      const blob = new Blob([JSON.stringify(snap.result, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `schedule-${appId}-${snap.runAt ?? "result"}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    []
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <H1>Scheduled tasks</H1>
      <p className="text-sm text-muted-foreground">
        Every artifact app with a registered schedule. The Vercel Cron sweep
        runs every 30 minutes; use <em>Run sweep</em> here to fire it on
        demand for testing. Per-app 1-hour budget still applies — a schedule
        that already ran in the current window is skipped (counted as
        &quot;skippedRateLimit&quot;).
      </p>

      <PaperCard className="flex flex-col gap-3 p-4">
        <H2>Run sweep now</H2>
        {pause?.paused && (
          <div className="rounded border border-[#8a4a14]/30 bg-[#8a4a14]/5 px-2 py-1 text-xs text-[#8a4a14]">
            Cron sweep paused{pause.since ? ` ${relativeTime(pause.since)}` : ""}.
            The Vercel cron tick still fires every 30 minutes but exits
            immediately — no app tasks run.
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
            />
            <span>Force-run every app (bypass cron-due check)</span>
          </label>
          <Button onClick={() => void onSweep()} disabled={sweeping} className="gap-2">
            {sweeping ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            Run sweep
          </Button>
          <Button
            variant={pause?.paused ? "default" : "destructive"}
            onClick={() => void onTogglePause()}
            disabled={pauseBusy || pause === null}
            className="gap-2"
          >
            {pauseBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : pause?.paused ? (
              <Play className="h-4 w-4" />
            ) : (
              <Pause className="h-4 w-4" />
            )}
            {pause?.paused ? "Resume crons" : "Pause crons"}
          </Button>
          <Button
            variant="outline"
            onClick={() => void refresh()}
            disabled={loading}
            className="gap-2"
          >
            <RefreshCw className={"h-4 w-4 " + (loading ? "animate-spin" : "")} />
            Refresh
          </Button>
        </div>
        {sweep && (
          <pre className="overflow-x-auto rounded border border-border bg-muted/50 p-3 text-xs">
            {JSON.stringify(sweep, null, 2)}
          </pre>
        )}
        {error && (
          <div className="rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
            {error}
          </div>
        )}
      </PaperCard>

      <PaperCard className="flex flex-col gap-2 p-4">
        <H2>Registered schedules ({items.length})</H2>
        {items.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No registered schedules. Open an app whose manifest declares a
            <code className="mx-1">schedule</code> or that calls
            <code className="mx-1">artifact.defineSchedule()</code> from inside the iframe.
          </div>
        )}
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <ScheduleRow
              key={item.appId}
              appId={item.appId}
              snap={item.snapshot}
              onDownload={downloadResult}
              onUnregister={onUnregister}
            />
          ))}
        </div>
      </PaperCard>
    </div>
  );
}

function ScheduleRow({
  appId,
  snap,
  onDownload,
  onUnregister,
}: {
  appId: string;
  snap: ScheduleSnapshot | null;
  onDownload: (appId: string, snap: ScheduleSnapshot) => void;
  onUnregister: (appId: string) => void | Promise<void>;
}) {
  if (!snap) {
    return (
      <div className="rounded border border-border bg-card px-3 py-2 text-sm">
        <div className="font-mono text-xs">{appId}</div>
        <div className="text-muted-foreground">snapshot missing</div>
      </div>
    );
  }
  return (
    <div className="rounded border border-border bg-card px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs">{appId}</div>
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">{snap.task.type}</span> ·{" "}
            <span className="font-mono">{formatCron(snap.task.cron)}</span> ·{" "}
            origin {snap.origin} · last {relativeTime(snap.runAt ?? undefined)} ·{" "}
            <span
              className={
                snap.status === "error"
                  ? "text-destructive"
                  : snap.status === "running"
                    ? "text-[#8a4a14]"
                    : ""
              }
            >
              {snap.status}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={snap.result == null}
            onClick={() => onDownload(appId, snap)}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onUnregister(appId)}
            className="gap-1.5"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Unregister
          </Button>
        </div>
      </div>
      {snap.error && (
        <div className="mt-1 rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
          {snap.error}
        </div>
      )}
      {snap.result != null && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Result preview
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted/40 p-2 text-[11px]">
            {JSON.stringify(snap.result, null, 2).slice(0, 4000)}
          </pre>
        </details>
      )}
    </div>
  );
}
