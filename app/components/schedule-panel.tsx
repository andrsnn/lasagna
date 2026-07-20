"use client";

import { useState } from "react";
import { AlertCircle, CalendarPlus, CheckCircle2, ChevronRight, Clock, Download, Loader2, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCron } from "@/app/lib/cron-eval";
import { relativeTime } from "@/app/lib/visuals";
import { useSchedule } from "@/app/lib/use-schedule";
import { confirm } from "@/app/components/confirm";
import { toast } from "@/app/components/toast";
import type {
  ScheduleHistoryEntry,
  ScheduleSnapshot,
} from "@/app/lib/artifact/sdk-protocol";

type SnapNonNull = NonNullable<ScheduleSnapshot>;

// Presets all satisfy the 1-hour minimum enforced by parseCron().
const CADENCE_PRESETS: { value: string; label: string }[] = [
  { value: "0 * * * *", label: "Every hour" },
  { value: "0 */2 * * *", label: "Every 2 hours" },
  { value: "0 */3 * * *", label: "Every 3 hours" },
  { value: "0 */4 * * *", label: "Every 4 hours" },
  { value: "0 */6 * * *", label: "Every 6 hours" },
  { value: "0 */8 * * *", label: "Every 8 hours" },
  { value: "0 */12 * * *", label: "Every 12 hours" },
  { value: "0 9 * * *", label: "Daily · 09:00 UTC" },
  { value: "0 9 * * 1", label: "Weekly · Mon 09:00 UTC" },
];

/** Plain-English label for the schedule status; null when there's nothing
 *  worth saying (e.g. a fresh "idle" run that's about to fire). */
function statusLabel(snap: SnapNonNull): { text: string; tone: "muted" | "warn" | "error" } | null {
  if (snap.status === "running") return { text: "Scanning…", tone: "warn" };
  if (snap.status === "error") return { text: "Last scan failed", tone: "error" };
  if (snap.status === "complete") return null;
  return null;
}

function cadenceLabel(snap: SnapNonNull): string {
  const cadence = formatCron(snap.task.cron);
  if (cadence === snap.task.cron) return "Runs automatically.";
  return `Runs ${cadence}.`;
}

function cleanErrorMessage(raw: string): string {
  return raw.replace(/[.!?\s]+$/u, "");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function previewOutput(result: unknown): string {
  if (result == null) return "(empty)";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function RunRow({ entry }: { entry: ScheduleHistoryEntry }) {
  const [open, setOpen] = useState(false);
  const isError = entry.status === "error";
  const inputLabel =
    entry.input.type === "fetch" ? entry.input.url : entry.input.prompt;
  return (
    <li className="rounded-md border border-border/60 bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
        aria-expanded={open}
      >
        <ChevronRight
          className={
            "h-3 w-3 shrink-0 text-muted-foreground transition-transform " +
            (open ? "rotate-90" : "")
          }
        />
        {isError ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
        )}
        <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
          {isError
            ? entry.error
              ? cleanErrorMessage(entry.error)
              : "Failed"
            : inputLabel}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {relativeTime(entry.runAt)} · {formatDuration(entry.durationMs)}
        </span>
      </button>
      {open && (
        <div className="border-t border-border/60 px-2 py-2 text-[11px]">
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
            <dt className="text-muted-foreground">Started</dt>
            <dd className="text-foreground">
              {new Date(entry.runAt).toLocaleString()}
            </dd>
            <dt className="text-muted-foreground">Duration</dt>
            <dd className="text-foreground">{formatDuration(entry.durationMs)}</dd>
            {entry.input.type === "query" ? (
              <>
                <dt className="text-muted-foreground">Model</dt>
                <dd className="text-foreground">
                  {entry.modelUsed ?? entry.input.model ?? "(default)"}
                  {entry.input.webSearch ? " · web_search" : ""}
                </dd>
                <dt className="self-start text-muted-foreground">Prompt</dt>
                <dd className="whitespace-pre-wrap break-words text-foreground">
                  {entry.input.prompt}
                </dd>
              </>
            ) : (
              <>
                <dt className="text-muted-foreground">Method</dt>
                <dd className="text-foreground">{entry.input.method ?? "GET"}</dd>
                <dt className="self-start text-muted-foreground">URL</dt>
                <dd className="break-words text-foreground">{entry.input.url}</dd>
              </>
            )}
          </dl>
          {entry.error && (
            <div className="mt-1.5 rounded border border-destructive/30 bg-destructive/5 px-1.5 py-1 text-[11px] text-destructive">
              {entry.error}
            </div>
          )}
          {entry.result !== undefined && entry.result !== null && (
            <div className="mt-1.5">
              <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                Output
              </div>
              <pre className="max-h-48 overflow-auto rounded bg-muted/50 px-1.5 py-1 text-[11px] leading-tight">
                {previewOutput(entry.result).slice(0, 4000)}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// Live "a run is happening right now" row. History entries are only written
// on completion, so without this the list shows nothing while a scan runs -
// leaving the user with no evidence anything started. Rendered at the top
// whenever the snapshot is in the running state.
function RunningRow({ startedAt }: { startedAt: number | null }) {
  return (
    <li className="overflow-hidden rounded-md border border-amber-500/40 bg-amber-500/5">
      <div className="flex w-full items-center gap-2 px-2 py-1.5 text-left">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-amber-700 dark:text-amber-300">
          Scanning now…
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {startedAt ? `started ${relativeTime(startedAt)}` : "just now"}
        </span>
      </div>
    </li>
  );
}

function RunsHistory({
  history,
  runningStartedAt,
}: {
  history: ScheduleHistoryEntry[];
  /** When set, a run is in flight (its markRunning timestamp) - show a live row. */
  runningStartedAt?: number | null;
}) {
  // Only claim "scanning now" for a run that plausibly is: a server run is
  // bounded by Vercel maxDuration (300s). A `running` status older than that
  // is an orphan (the function died mid-run without writing a terminal
  // result) - showing "Scanning now…" for it would be the same kind of lie
  // as a frozen spinner, so we suppress the live row past the window and let
  // the panel's status/error surface it instead.
  const RUNNING_STALE_MS = 6 * 60 * 1000;
  const isRunning =
    runningStartedAt !== undefined &&
    runningStartedAt !== null &&
    Date.now() - runningStartedAt < RUNNING_STALE_MS;
  if ((!history || history.length === 0) && !isRunning) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
        No runs yet. Tap Run now to capture one.
      </div>
    );
  }
  const count = (history?.length ?? 0) + (isRunning ? 1 : 0);
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-medium text-muted-foreground">
        Recent runs ({count})
      </div>
      <ul className="flex flex-col gap-1">
        {isRunning && <RunningRow startedAt={runningStartedAt ?? null} />}
        {history.map((entry, i) => (
          <RunRow key={`${entry.runAt}-${i}`} entry={entry} />
        ))}
      </ul>
    </div>
  );
}

type Props = {
  appId: string;
  /** When the iframe registers a schedule via SDK we won't know about it
   *  until the next fetch — re-fetch when this changes. */
  reloadKey?: number;
};

function downloadResult(
  appId: string,
  snap: NonNullable<ScheduleSnapshot>
): void {
  if (snap.result == null) return;
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
}

export function SchedulePanel({ appId, reloadKey }: Props) {
  const { snap, running, error, runNow } = useSchedule(appId, reloadKey);

  if (snap === "loading") {
    return null;
  }
  if (!snap) return null;

  const isFirstRun = snap.runAt == null && snap.status !== "running";
  const status = statusLabel(snap);
  const lastRun = snap.runAt ? relativeTime(snap.runAt) : null;
  const cadence = cadenceLabel(snap);
  const subline = isFirstRun
    ? `Tap Run now to test. ${cadence}`
    : status
      ? null
      : `Last scan ${lastRun}. ${cadence}`;

  return (
    <div className="mx-3 mb-3 rounded-2xl border border-border bg-card px-4 py-3 sm:mx-4 sm:mb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {isFirstRun ? "Hasn't run yet" : "Scheduled scan"}
            </div>
            {subline && (
              <div className="truncate text-xs text-muted-foreground">{subline}</div>
            )}
            {status && (
              <div className="truncate text-xs">
                <span
                  className={
                    status.tone === "error"
                      ? "text-destructive"
                      : status.tone === "warn"
                        ? "text-[#8a4a14] dark:text-amber-300"
                        : "text-muted-foreground"
                  }
                >
                  {status.text}
                </span>
                {lastRun && status.tone !== "warn" && (
                  <span className="text-muted-foreground"> · {lastRun}</span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={snap.result == null}
            onClick={() => downloadResult(appId, snap)}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Download</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void runNow()}
            disabled={running || snap.status === "running"}
            className="gap-1.5"
          >
            {running || snap.status === "running" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Run now
          </Button>
        </div>
      </div>
      {(() => {
        const message = error
          ? error
          : snap.status === "error" && snap.error
            ? cleanErrorMessage(snap.error)
            : null;
        if (!message) return null;
        return (
          <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
            {message}
          </div>
        );
      })()}
    </div>
  );
}

type DetailsProps = {
  appId: string;
  reloadKey?: number;
};

/**
 * Compact, read-only-ish view of an app's scheduled task. Designed to live
 * inside the Edit params dialog. Renders nothing while loading or when the
 * artifact has no schedule registered.
 */
export function ScheduleDetails({ appId, reloadKey }: DetailsProps) {
  const { snap, running, error, runNow, refresh } = useSchedule(appId, reloadKey);
  const [cadenceSaving, setCadenceSaving] = useState(false);
  const [cadenceError, setCadenceError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Create-form state, used when no schedule exists yet.
  const [createType, setCreateType] = useState<"query" | "fetch">("query");
  const [createPrompt, setCreatePrompt] = useState("");
  const [createUrl, setCreateUrl] = useState("");
  const [createCron, setCreateCron] = useState(CADENCE_PRESETS[0].value);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  if (snap === "loading") return null;

  // No schedule registered yet — let the user create one. Registration is a
  // no-op server-side unless the app is synced to the account, so surface that
  // gate clearly instead of silently doing nothing.
  if (!snap) {
    const canCreate =
      !creating &&
      (createType === "query"
        ? createPrompt.trim().length > 0
        : /^https?:\/\//i.test(createUrl.trim()));
    const handleCreate = async () => {
      if (!canCreate) return;
      setCreating(true);
      setCreateError(null);
      try {
        const schedule =
          createType === "query"
            ? { cron: createCron, type: "query" as const, prompt: createPrompt.trim() }
            : { cron: createCron, type: "fetch" as const, url: createUrl.trim() };
        const r = await fetch("/api/schedules/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appId, schedule, origin: "manifest", userOverride: true }),
        });
        const body = (await r.json().catch(() => ({}))) as {
          shared?: boolean;
          error?: string;
        };
        if (!r.ok) {
          setCreateError(body.error ?? `Couldn't create schedule (${r.status}).`);
          return;
        }
        if (body.shared === false) {
          setCreateError(
            "Turn on “Sync to account” for this app (in the Share dialog) before a schedule can run centrally."
          );
          return;
        }
        toast.success("Schedule created — Run now to test it");
        await refresh();
      } catch (e) {
        setCreateError(e instanceof Error ? e.message : "Couldn't create schedule.");
      } finally {
        setCreating(false);
      }
    };
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border bg-card/50 px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-xs">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium text-foreground">Scheduled task</span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Run a query or fetch on a schedule (at most once per hour) and surface the
          latest result to this app.
        </p>
        <div className="flex items-center gap-1.5 text-xs">
          <select
            value={createType}
            onChange={(e) => setCreateType(e.target.value as "query" | "fetch")}
            disabled={creating}
            aria-label="Task type"
            className="rounded-md border border-border bg-card px-1.5 py-1 text-xs text-foreground outline-none focus:border-foreground/30 disabled:opacity-60"
          >
            <option value="query">Query (LLM)</option>
            <option value="fetch">Fetch (URL)</option>
          </select>
          <select
            value={createCron}
            onChange={(e) => setCreateCron(e.target.value)}
            disabled={creating}
            aria-label="Cadence"
            className="min-w-0 flex-1 rounded-md border border-border bg-card px-1.5 py-1 text-xs text-foreground outline-none focus:border-foreground/30 disabled:opacity-60"
          >
            {CADENCE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {createType === "query" ? (
          <textarea
            value={createPrompt}
            onChange={(e) => setCreatePrompt(e.target.value)}
            disabled={creating}
            rows={2}
            placeholder="What should the model do each run? e.g. Summarize today's top AI news."
            className="w-full resize-none rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground outline-none focus:border-foreground/30 disabled:opacity-60"
          />
        ) : (
          <Input
            value={createUrl}
            onChange={(e) => setCreateUrl(e.target.value)}
            disabled={creating}
            placeholder="https://example.com/api/data.json"
            className="h-8 text-xs"
          />
        )}
        {createError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
            {createError}
          </div>
        )}
        <Button
          size="sm"
          onClick={() => void handleCreate()}
          disabled={!canCreate}
          className="gap-1.5 self-start"
        >
          {creating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CalendarPlus className="h-3.5 w-3.5" />
          )}
          Create schedule
        </Button>
      </div>
    );
  }

  const isFirstRun = snap.runAt == null && snap.status !== "running";
  const status = statusLabel(snap);
  const lastRun = snap.runAt ? relativeTime(snap.runAt) : "never";
  const target = snap.task.type === "fetch" ? snap.task.url : snap.task.prompt;
  const currentCron = snap.task.cron;
  const isPreset = CADENCE_PRESETS.some((p) => p.value === currentCron);
  const taskSnap = snap;
  const isOverridden = taskSnap.userCronOverride === true;
  // Only offer "Reset" when there's a known default to fall back to AND it
  // actually differs from what's running right now — otherwise the link is
  // a no-op that just confuses the user.
  const canResetCadence =
    isOverridden &&
    typeof taskSnap.defaultCron === "string" &&
    taskSnap.defaultCron !== currentCron;

  async function handleCadenceChange(value: string) {
    if (value === taskSnap.task.cron) return;
    setCadenceSaving(true);
    setCadenceError(null);
    try {
      const r = await fetch("/api/schedules/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId,
          schedule: { ...taskSnap.task, cron: value },
          origin: taskSnap.origin,
          // Mark this as an explicit user edit so manifest auto-register
          // and iframe schedule.define calls don't immediately revert it.
          userOverride: true,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setCadenceError(body.error ?? `Save failed (${r.status})`);
        return;
      }
      const body = (await r.json().catch(() => ({}))) as {
        shared?: boolean;
        skipped?: string;
      };
      if (body.shared === false) {
        setCadenceError(
          "This app isn't synced to your account yet — the schedule can't run centrally until you turn on Sync to account in the Share dialog."
        );
        return;
      }
      await refresh();
    } catch (e) {
      setCadenceError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setCadenceSaving(false);
    }
  }

  async function handleDelete() {
    if (deleting) return;
    const ok = await confirm({
      title: "Remove schedule?",
      body: "This stops the scheduled task and deletes its cached result and run history.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/schedules/${encodeURIComponent(appId)}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(`Failed (${r.status})`);
      toast.success("Schedule removed");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove the schedule.");
      setDeleting(false);
    }
  }

  async function handleCadenceReset() {
    setCadenceSaving(true);
    setCadenceError(null);
    try {
      const r = await fetch(
        `/api/schedules/${encodeURIComponent(appId)}/cadence-reset`,
        { method: "POST" }
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setCadenceError(body.error ?? `Reset failed (${r.status})`);
        return;
      }
      await refresh();
    } catch (e) {
      setCadenceError(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setCadenceSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card/50 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium text-foreground">Scheduled scan</span>
        </div>
        {status && (
          <span
            className={
              status.tone === "error"
                ? "text-[11px] text-destructive"
                : status.tone === "warn"
                  ? "text-[11px] text-[#8a4a14] dark:text-amber-300"
                  : "text-[11px] text-muted-foreground"
            }
          >
            {status.text}
          </span>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs">
        <dt className="self-start pt-1.5 text-muted-foreground">Cadence</dt>
        <dd className="flex flex-col gap-0.5 text-foreground">
          <div className="flex items-center gap-1.5">
            <select
              value={currentCron}
              onChange={(e) => void handleCadenceChange(e.target.value)}
              disabled={cadenceSaving}
              className="min-w-0 flex-1 rounded-md border border-border bg-card px-1.5 py-1 text-xs text-foreground outline-none focus:border-foreground/30 disabled:opacity-60"
            >
              {!isPreset && (
                <option value={currentCron}>
                  Custom · {formatCron(currentCron)}
                </option>
              )}
              {CADENCE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            {cadenceSaving && (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
            )}
          </div>
          {canResetCadence && (
            <button
              type="button"
              onClick={() => void handleCadenceReset()}
              disabled={cadenceSaving}
              className="self-start text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground disabled:opacity-60"
            >
              Reset to artifact default
            </button>
          )}
        </dd>
        <dt className="text-muted-foreground">Last scan</dt>
        <dd className="text-foreground">{lastRun}</dd>
        {target ? (
          <>
            <dt className="text-muted-foreground">
              {snap.task.type === "fetch" ? "URL" : "Prompt"}
            </dt>
            <dd className="truncate text-foreground" title={target}>
              {target}
            </dd>
          </>
        ) : null}
      </dl>
      {isFirstRun && (
        <div className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
          Tap Run now to test. After that it'll re-check on its own.
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void runNow()}
          disabled={running || snap.status === "running"}
          className="gap-1.5"
        >
          {running || snap.status === "running" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Run now
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={snap.result == null}
          onClick={() => downloadResult(appId, snap)}
          className="gap-1.5"
        >
          <Download className="h-3.5 w-3.5" />
          Download
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => void handleDelete()}
          disabled={deleting}
          className="ml-auto gap-1.5"
        >
          {deleting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          Remove
        </Button>
      </div>
      {(() => {
        const message = cadenceError
          ? cadenceError
          : error
            ? error
            : snap.status === "error" && snap.error
              ? cleanErrorMessage(snap.error)
              : null;
        if (!message) return null;
        return (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
            {message}
          </div>
        );
      })()}
      <RunsHistory
        history={snap.history ?? []}
        runningStartedAt={snap.status === "running" ? snap.runAt : null}
      />
    </div>
  );
}
