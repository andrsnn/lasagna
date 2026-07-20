"use client";

// /admin/worker — hard-reset the Fly.io chat worker.
//
// The durable producer for chat/query/research/render/exec jobs is a
// scale-to-zero Fly machine (worker/index.ts). It can wedge on a provider or
// tool call that never returns, pinning a slot until the hour-long kill timer
// fires — chats then look "stuck" with no self-service recovery. This page
// force-kills the machine (SIGKILL) and boots a fresh one so those jobs clear.
//
// Reset only helps in-flight/wedged work on the worker itself. A chat that's
// stuck on stale Redis stream state is cleared from /admin/redis instead
// (delete the ollchat:stream:* / ollchat:*-jobs keys).

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Cloud, Loader2, Power, RefreshCw } from "lucide-react";
import { PaperCard } from "@/app/components/paper-card";
import { H1 } from "@/app/components/serif-heading";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Status =
  | { configured: false }
  | { configured: true; app: string; machineId: string; state: string; region?: string }
  | { configured: true; app: string; machineId: string; error: string };

// Fly machine states → a tone for the status pill. Unknown states fall back to
// neutral so the raw value still shows rather than being hidden.
const STATE_TONE: Record<string, string> = {
  started: "bg-emerald-100 text-emerald-700 border-emerald-200",
  stopped: "bg-slate-200 text-slate-700 border-slate-300",
  stopping: "bg-amber-100 text-amber-700 border-amber-200",
  starting: "bg-blue-100 text-blue-700 border-blue-200",
  replacing: "bg-amber-100 text-amber-700 border-amber-200",
};

export default function WorkerAdminPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"restart" | "stop" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/worker");
      const body = (await res.json()) as Status | { error: string };
      if (!res.ok || "error" in body) {
        throw new Error(("error" in body && body.error) || `HTTP ${res.status}`);
      }
      setStatus(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read worker status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (action: "restart" | "stop") => {
      const label =
        action === "restart"
          ? "Force-kill the worker and boot a fresh one? Any in-flight chats on it will error out and can be retried."
          : "Force-kill the worker? It comes back on its own on the next chat. In-flight chats on it will error out.";
      if (!confirm(label)) return;
      setBusy(action);
      setError(null);
      setNote(null);
      try {
        const res = await fetch("/api/admin/worker", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const body = (await res.json()) as
          | { ok: true; action: string; state: string }
          | { error: string };
        if (!res.ok || "error" in body) {
          throw new Error(("error" in body && body.error) || `HTTP ${res.status}`);
        }
        setNote(
          action === "restart"
            ? `Worker reset. Machine is now "${body.state}".`
            : `Worker killed. Machine is now "${body.state}" — it'll boot fresh on the next chat.`
        );
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Worker action failed.");
      } finally {
        setBusy(null);
      }
    },
    [refresh]
  );

  const configured = status?.configured === true;
  const state =
    status && status.configured && "state" in status ? status.state : null;
  const statusError =
    status && status.configured && "error" in status ? status.error : null;

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto px-4 pt-6 pb-16">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <H1>Worker</H1>
          <p className="mt-1 text-sm text-muted-foreground">
            The Fly.io machine that runs chats, research, and other long jobs.
            Hard-reset it when a chat is stuck on a wedged worker and Stop
            won&apos;t clear it.
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

      <PaperCard tone="raised" className="mt-5 flex flex-col gap-4 rounded-2xl p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary/60 text-[var(--color-accent-2)]">
            <Cloud className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Fly chat worker</div>
            <div className="truncate font-mono text-xs text-muted-foreground">
              {loading && !status
                ? "Checking…"
                : configured && status && "app" in status
                  ? `${status.app} · ${status.machineId}${"region" in status && status.region ? ` · ${status.region}` : ""}`
                  : "Not configured"}
            </div>
          </div>
          {state ? (
            <span
              className={cn(
                "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                STATE_TONE[state] ?? "bg-muted text-muted-foreground border-border"
              )}
            >
              {state}
            </span>
          ) : null}
        </div>

        {statusError ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            Couldn&apos;t read the machine state from Fly: {statusError}. The reset
            buttons may still work.
          </div>
        ) : null}

        {!configured && !loading ? (
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              No Fly worker is configured for this deployment
              (FLY_API_TOKEN / FLY_APP_NAME / FLY_MACHINE_ID). Chats run on the
              in-process path, which has nothing durable to reset.
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Danger zone
            </div>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Hard reset</span> force-kills
              the worker (SIGKILL) and immediately boots a fresh one.{" "}
              <span className="font-medium text-foreground">Kill</span> just stops
              it — Fly leaves it stopped until the next chat wakes it. Either way,
              chats streaming on the killed worker will land in an error state you
              can retry.
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="destructive"
                onClick={() => void run("restart")}
                disabled={busy !== null}
                className="gap-1.5"
              >
                {busy === "restart" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Hard reset worker
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void run("stop")}
                disabled={busy !== null}
                className="gap-1.5"
              >
                {busy === "stop" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Power className="h-3.5 w-3.5" />
                )}
                Kill only
              </Button>
            </div>
          </div>
        )}
      </PaperCard>

      <p className="mt-4 text-xs text-muted-foreground">
        Still stuck after a reset? A chat wedged on stale stream state clears
        from{" "}
        <a href="/admin/redis" className="underline">
          Redis
        </a>{" "}
        — delete its <code className="font-mono">ollchat:stream:*</code> keys or
        the <code className="font-mono">ollchat:*-jobs</code> queues.
      </p>
    </div>
  );
}
