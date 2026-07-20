"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Clock,
  Eye,
  EyeOff,
  Loader2,
  PauseCircle,
  PlayCircle,
  Power,
  Settings2,
} from "lucide-react";
import {
  listApps,
  listDesigners,
  loadSettings,
  putApp,
  saveSettings,
  DEFAULT_SETTINGS,
  type Settings,
  type StoredApp,
  type StoredDesigner,
} from "@/app/db";
import { SettingsDialog } from "@/app/components/settings-dialog";
import { detectWidgetEntry } from "@/app/lib/artifact/manifest";
import { subscribeAccountSyncPull } from "@/app/lib/account-sync";
import { useSchedule } from "@/app/lib/use-schedule";
import { H1 } from "@/app/components/serif-heading";
import { TitleLogo } from "@/app/components/title-logo";
import { PaperPill } from "@/app/components/paper-pill";
import { formatCron } from "@/app/lib/cron-eval";
import { gradientCss, relativeTime } from "@/app/lib/visuals";
import { toast } from "@/app/components/toast";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function ManagePage() {
  const router = useRouter();
  const [apps, setApps] = useState<StoredApp[]>([]);
  const [designers, setDesigners] = useState<StoredDesigner[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    loadSettings().then(setSettings).catch(() => {});
  }, []);

  const updateSettings = useCallback(async (next: Settings) => {
    setSettings(next);
    try {
      await saveSettings(next);
    } catch {
      /* best effort */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [as, ds] = await Promise.all([listApps(), listDesigners()]);
        if (cancelled) return;
        setApps(as);
        setDesigners(ds);
      } catch {
        // Leave the lists empty; the page renders an empty state below.
      } finally {
        if (!cancelled) setHydrated(true);
      }
    }
    void load();
    const unsubscribe = subscribeAccountSyncPull(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const designerById = useMemo(
    () => new Map(designers.map((d) => [d.id, d])),
    [designers]
  );

  // List every app (widgeted or not) so the Control Center can manage them all.
  // Pair each with its designer; an app whose designer is missing can't be
  // meaningfully controlled, so it's dropped.
  const rows = useMemo(() => {
    return apps
      // Archived apps are put away - the Control Center only manages live ones.
      .filter((a) => designerById.has(a.id) && !a.archivedAt)
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      );
  }, [apps, designerById]);

  const onUpdate = useCallback(async (next: StoredApp) => {
    setApps((prev) => prev.map((a) => (a.id === next.id ? next : a)));
    await putApp(next).catch(() => {});
  }, []);

  const activeCount = rows.filter((a) => a.appEnabled !== false).length;

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top safe-x sticky top-0 z-10 border-b border-border/60 bg-background/85 pt-3 pb-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-3 sm:flex-row sm:items-start sm:justify-between sm:px-6">
          <div className="flex flex-col gap-1">
            <H1><TitleLogo />Control Center</H1>
            <p className="text-xs text-muted-foreground">
              Turn apps on or off, show or hide their widgets, and pause or run
              their scheduled tasks - all from one place.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPrefsOpen(true)}
            className="mt-1 shrink-0 gap-1.5"
            aria-label="Open Preferences"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Preferences</span>
          </Button>
        </div>
      </header>

      <div className="scroll-area safe-x min-h-0 flex-1 pb-16">
        <section className="mx-auto w-full max-w-4xl px-3 pt-4 sm:px-6">
          <UserScheduleControl />

          {hydrated && rows.length === 0 ? (
            <div className="mx-auto mt-12 max-w-md rounded-2xl border border-dashed border-border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
              No apps yet. Build one from the Apps tab and it'll show up here,
              ready to manage.
            </div>
          ) : (
            <>
              <div className="mt-4 mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {rows.length} app{rows.length === 1 ? "" : "s"}
                </span>
                <span>
                  {activeCount} active · {rows.length - activeCount} off
                </span>
              </div>
              <ul className="flex flex-col gap-2">
                {rows.map((app) => (
                  <AppControlRow
                    key={app.id}
                    app={app}
                    designer={designerById.get(app.id)!}
                    onUpdate={onUpdate}
                    onOpen={() => router.push(`/apps/${app.id}`)}
                  />
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <SettingsDialog
        open={prefsOpen}
        onOpenChange={setPrefsOpen}
        settings={settings}
        onChange={(next) => void updateSettings(next)}
      />
    </div>
  );
}

/**
 * Account-level "pause every scheduled task" kill-switch. Flips a per-user
 * pause flag (via /api/schedules/pause, keyed by the signed-in email) that the
 * cron sweep and catch-up-on-visit both honor - so it stops only THIS user's
 * crons, not the whole deployment (that stays behind the admin route).
 * Surfaced here as a one-tap panic button for "stop all my crons right now".
 * Independent of per-app pauses: when this is on, none of the user's apps
 * auto-fire regardless of their per-app state.
 */
function UserScheduleControl() {
  const [paused, setPaused] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/schedules/pause", { cache: "no-store" });
        if (!r.ok) {
          if (!cancelled) setPaused(false);
          return;
        }
        const body = (await r.json()) as { paused?: boolean };
        if (!cancelled) setPaused(!!body.paused);
      } catch {
        if (!cancelled) setPaused(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle() {
    if (paused === null || busy) return;
    const next = !paused;
    setBusy(true);
    try {
      const r = await fetch("/api/schedules/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: next }),
      });
      if (!r.ok) throw new Error(`Failed (${r.status})`);
      const body = (await r.json()) as { paused?: boolean };
      setPaused(!!body.paused);
      toast.success(next ? "Your scheduled tasks paused" : "Your scheduled tasks resumed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-2xl border px-4 py-3",
        paused
          ? "border-[#8a4a14]/40 bg-amber-50/60 dark:border-amber-300/30 dark:bg-amber-300/5"
          : "border-border bg-card"
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <Clock
          className={cn(
            "h-4 w-4 shrink-0",
            paused ? "text-[#8a4a14] dark:text-amber-300" : "text-muted-foreground"
          )}
        />
        <div className="min-w-0">
          <div className="text-sm font-medium">Your scheduled tasks</div>
          <div className="truncate text-xs text-muted-foreground">
            {paused === null
              ? "Checking…"
              : paused
                ? "Paused - none of your tasks auto-run until you resume."
                : "Running on their schedules."}
          </div>
        </div>
      </div>
      <Button
        size="sm"
        variant={paused ? "default" : "outline"}
        onClick={() => void toggle()}
        disabled={paused === null || busy}
        className="shrink-0 gap-1.5"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : paused ? (
          <PlayCircle className="h-3.5 w-3.5" />
        ) : (
          <PauseCircle className="h-3.5 w-3.5" />
        )}
        {paused ? "Resume all" : "Pause all"}
      </Button>
    </div>
  );
}

function AppControlRow({
  app,
  designer,
  onUpdate,
  onOpen,
}: {
  app: StoredApp;
  designer: StoredDesigner;
  onUpdate: (next: StoredApp) => Promise<void>;
  onOpen: () => void;
}) {
  const { snap, running, runNow, setEnabled } = useSchedule(app.id);

  const enabled = app.appEnabled !== false;
  const hasWidget = detectWidgetEntry(designer.files, designer.manifest) !== null;
  const hasSchedule = snap != null && snap !== "loading";
  const widgetShown = app.widgetEnabled !== false;
  const cronOn = hasSchedule && snap.enabled !== false;
  const isRunning = running || (hasSchedule && snap.status === "running");

  async function toggleApp() {
    const next = !enabled;
    await onUpdate({ ...app, appEnabled: next, updatedAt: Date.now() });
    // Keep the server-side schedule in lockstep with the master switch so a
    // disabled app's cron actually stops (the sweep can't see IndexedDB).
    if (hasSchedule) await setEnabled(next);
  }

  async function toggleWidget() {
    await onUpdate({
      ...app,
      widgetEnabled: !widgetShown,
      updatedAt: Date.now(),
    });
  }

  // Plain-English status under the name.
  let scheduleLine: string | null = null;
  if (hasSchedule) {
    const cadence = formatCron(snap.task.cron);
    const last = snap.runAt ? `last ran ${relativeTime(snap.runAt)}` : "hasn't run yet";
    scheduleLine = cronOn ? `Runs ${cadence} · ${last}` : `Paused · ${last}`;
  }

  return (
    <li
      className={cn(
        "rounded-2xl border border-border bg-card px-3 py-3 transition sm:px-4",
        !enabled && "opacity-60"
      )}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${app.name}`}
          className="tap h-9 w-9 shrink-0 rounded-xl border border-border"
          style={{ background: gradientCss(app.id) }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onOpen}
              className="tap truncate text-sm font-semibold hover:underline"
            >
              {app.name}
            </button>
            {hasWidget && <PaperPill tone="neutral">Widget</PaperPill>}
            {hasSchedule && <PaperPill tone="neutral">Schedule</PaperPill>}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {!enabled
              ? "Disabled - widget hidden and schedule paused."
              : scheduleLine ?? "No scheduled task."}
          </div>
        </div>

        {/* Master switch */}
        <Button
          size="sm"
          variant={enabled ? "default" : "outline"}
          onClick={() => void toggleApp()}
          aria-pressed={enabled}
          title={enabled ? "App is active - click to disable" : "App is disabled - click to enable"}
          className="shrink-0 gap-1.5"
        >
          <Power className="h-3.5 w-3.5" />
          {enabled ? "On" : "Off"}
        </Button>
      </div>

      {/* Per-capability controls. Disabled while the master switch is off,
          since the app then overrides them anyway. */}
      {enabled && (hasWidget || hasSchedule) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-12">
          {hasWidget && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void toggleWidget()}
              aria-pressed={widgetShown}
              title={
                widgetShown
                  ? "Showing on the Home board - click to hide"
                  : "Hidden from the Home board - click to show"
              }
              className="gap-1.5"
            >
              {widgetShown ? (
                <Eye className="h-3.5 w-3.5" />
              ) : (
                <EyeOff className="h-3.5 w-3.5" />
              )}
              {widgetShown ? "Widget shown" : "Widget hidden"}
            </Button>
          )}
          {hasSchedule && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void setEnabled(!cronOn)}
                aria-pressed={cronOn}
                title={
                  cronOn
                    ? "Scheduled task is on - click to pause auto-runs"
                    : "Scheduled task is paused - click to resume"
                }
                className="gap-1.5"
              >
                <Clock className="h-3.5 w-3.5" />
                {cronOn ? "Auto on" : "Auto off"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void runNow()}
                disabled={isRunning}
                title="Run the scheduled task now"
                className="gap-1.5"
              >
                {isRunning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <PlayCircle className="h-3.5 w-3.5" />
                )}
                Run now
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={onOpen}
            className="ml-auto gap-1.5 text-muted-foreground"
            title="Open the app"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Open</span>
          </Button>
        </div>
      )}
    </li>
  );
}
