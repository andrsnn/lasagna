"use client";

// /admin/diagnostics — one screen that answers "why is this chat stuck?"
//
// A chat that hangs on "Thinking…" has three usual causes, and this page tells
// them apart at a glance:
//   1. The model provider is down (Ollama/RunPod row is red) → wait it out.
//   2. The provider is up but the Chat queue is backed up and the worker is
//      stopped/wedged → Reset worker here.
//   3. Providers up, queues empty, but streams piling up → stale stream state;
//      clear it from /admin/redis.
//
// Read-only status plus the one fix that lives here (worker reset). Surgical
// Redis clears stay on /admin/redis, which this page links to.

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Database,
  Layers,
  Loader2,
  RefreshCw,
  Server,
  XCircle,
} from "lucide-react";
import { PaperCard } from "@/app/components/paper-card";
import { H1 } from "@/app/components/serif-heading";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AdminDiagnostics } from "@/app/lib/health";

const STATE_TONE: Record<string, string> = {
  started: "bg-emerald-100 text-emerald-700 border-emerald-200",
  stopped: "bg-slate-200 text-slate-700 border-slate-300",
  stopping: "bg-amber-100 text-amber-700 border-amber-200",
  starting: "bg-blue-100 text-blue-700 border-blue-200",
  replacing: "bg-amber-100 text-amber-700 border-amber-200",
};

/** A green check / red X pill for a single up-or-down signal. */
function StatusDot({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
  ) : (
    <XCircle className="h-4 w-4 shrink-0 text-destructive" />
  );
}

function latency(ms?: number): string {
  if (typeof ms !== "number") return "";
  return `${ms} ms`;
}

export default function DiagnosticsPage() {
  const [data, setData] = useState<AdminDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/diagnostics");
      const body = (await res.json()) as AdminDiagnostics | { error: string };
      if (!res.ok || "error" in body) {
        throw new Error(("error" in body && body.error) || `HTTP ${res.status}`);
      }
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read diagnostics.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resetWorker = useCallback(async () => {
    if (
      !confirm(
        "Force-kill the worker and boot a fresh one? In-flight chats on it will error out and can be retried."
      )
    ) {
      return;
    }
    setResetting(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/admin/worker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "restart" }),
      });
      const body = (await res.json()) as { ok?: true; state?: string; error?: string };
      if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
      setNote(`Worker reset. Machine is now "${body.state}".`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Worker reset failed.");
    } finally {
      setResetting(false);
    }
  }, [refresh]);

  const worker = data?.worker;
  const workerState =
    worker && worker.configured && "state" in worker ? worker.state : null;
  const workerError =
    worker && worker.configured && "error" in worker ? worker.error : null;
  const runpod = data?.providers.runpod ?? null;
  const busyQueues = data?.queues.filter((q) => q.depth > 0) ?? [];

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col overflow-y-auto px-4 pt-6 pb-16">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <H1>Diagnostics</H1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live health of the model providers, the Fly worker, and the job
            queues. Use it to tell a provider outage apart from a wedged worker
            or stale stream state when a chat is stuck on &ldquo;Thinking&hellip;&rdquo;.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => void refresh()}
          disabled={loading}
          className="gap-1.5"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </header>

      {error ? (
        <div className="mt-5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {note ? (
        <div className="mt-5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          {note}
        </div>
      ) : null}

      {/* ---- Providers ---- */}
      <SectionHeading icon={<Server className="h-4 w-4" />}>Model providers</SectionHeading>
      <PaperCard tone="raised" className="mt-2 flex flex-col divide-y divide-border rounded-2xl">
        <ProviderRow
          name="Ollama Cloud"
          health={data?.providers.ollama}
          loading={loading && !data}
        />
        {runpod ? (
          <ProviderRow name="RunPod" health={runpod} loading={false} />
        ) : null}
      </PaperCard>

      {/* ---- Sync backend ---- */}
      <SectionHeading icon={<Database className="h-4 w-4" />}>Sync &amp; streaming</SectionHeading>
      <PaperCard tone="raised" className="mt-2 rounded-2xl p-4">
        <div className="flex items-center gap-3">
          {data ? <StatusDot ok={data.sync.ok} /> : <Loader2 className="h-4 w-4 animate-spin" />}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Redis (streaming + account sync)</div>
            <div className="truncate text-xs text-muted-foreground">
              {!data
                ? "Checking…"
                : !data.sync.configured
                  ? "Not configured on this deployment."
                  : data.sync.ok
                    ? `Reachable · ${latency(data.sync.latencyMs)}`
                    : data.sync.error ?? "Unreachable."}
            </div>
          </div>
        </div>
      </PaperCard>

      {/* ---- Worker ---- */}
      <SectionHeading icon={<Cpu className="h-4 w-4" />}>Fly worker</SectionHeading>
      <PaperCard tone="raised" className="mt-2 flex flex-col gap-4 rounded-2xl p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-secondary/60 text-[var(--color-accent-2)]">
            <Cpu className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Durable chat worker</div>
            <div className="truncate font-mono text-xs text-muted-foreground">
              {!data
                ? "Checking…"
                : worker && worker.configured && "app" in worker
                  ? `${worker.app} · ${worker.machineId}`
                  : "Not configured"}
            </div>
          </div>
          {workerState ? (
            <span
              className={cn(
                "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                STATE_TONE[workerState] ?? "bg-muted text-muted-foreground border-border"
              )}
            >
              {workerState}
            </span>
          ) : null}
        </div>

        {workerError ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            Couldn&apos;t read the machine state from Fly: {workerError}
          </div>
        ) : null}

        {worker?.configured ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="destructive"
              onClick={() => void resetWorker()}
              disabled={resetting}
              className="gap-1.5"
            >
              {resetting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Reset worker
            </Button>
            <a href="/admin/worker" className="text-xs text-muted-foreground underline">
              More worker controls
            </a>
          </div>
        ) : null}
      </PaperCard>

      {/* ---- Queues ---- */}
      <SectionHeading icon={<Layers className="h-4 w-4" />}>Job queues</SectionHeading>
      <PaperCard tone="raised" className="mt-2 rounded-2xl p-4">
        {!data ? (
          <div className="text-sm text-muted-foreground">Checking…</div>
        ) : data.queues.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No Redis backend — queues run in-process and can&apos;t be inspected.
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              {busyQueues.length > 0 ? (
                <>
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                  <span>
                    Work is queued. If the worker isn&apos;t{" "}
                    <span className="font-medium">started</span> above, wake or
                    reset it so these drain.
                  </span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span>All queues are empty — nothing is waiting on the worker.</span>
                </>
              )}
            </div>
            <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
              {data.queues.map((q) => (
                <li key={q.key} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate text-muted-foreground">{q.label}</span>
                  <span
                    className={cn(
                      "font-mono tabular-nums",
                      q.depth > 0 ? "font-semibold text-amber-600 dark:text-amber-400" : "text-foreground"
                    )}
                  >
                    {q.depth}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </PaperCard>

      {/* ---- In-flight streams ---- */}
      <SectionHeading icon={<Activity className="h-4 w-4" />}>In-flight streams</SectionHeading>
      <PaperCard tone="raised" className="mt-2 rounded-2xl p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {!data ? "Checking…" : `${data.activeStreams} active stream${data.activeStreams === 1 ? "" : "s"}`}
            </div>
            <div className="text-xs text-muted-foreground">
              One per chat currently streaming. A count that only grows suggests
              chats wedged on stale stream state.
            </div>
          </div>
          <a
            href="/admin/redis"
            className="shrink-0 whitespace-nowrap text-xs text-muted-foreground underline"
          >
            Clear in Redis
          </a>
        </div>
      </PaperCard>

      {data ? (
        <p className="mt-6 text-center text-[11px] text-muted-foreground">
          Checked {new Date(data.fetchedAt).toLocaleTimeString()}
        </p>
      ) : null}
    </div>
  );
}

function SectionHeading({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-6 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {icon}
      {children}
    </div>
  );
}

function ProviderRow({
  name,
  health,
  loading,
}: {
  name: string;
  health: { ok: boolean; configured: boolean; count: number; latencyMs?: number; error?: string } | null | undefined;
  loading: boolean;
}) {
  return (
    <div className="flex items-center gap-3 p-4">
      {loading || !health ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <StatusDot ok={health.ok} />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {loading || !health
            ? "Checking…"
            : !health.configured
              ? "Not configured."
              : health.ok
                ? `${health.count} model${health.count === 1 ? "" : "s"} · ${latency(health.latencyMs)}`
                : health.error ?? "Unreachable."}
        </div>
      </div>
    </div>
  );
}
