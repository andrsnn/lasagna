"use client";

// Preferences → Debug. The on-device diagnostic surface for the mobile chat
// crash. Flip "Phone debug mode" on, reproduce the crash (open the failing
// chat → the tab dies), then come BACK here after reloading: the diagnostic
// trail persisted through the crash and its last line is where it blew up.
//
// "Safe render" is a bisect switch: it skips decoding attached-image bytes in
// the transcript. If the chat opens with it on, images are the cause; if it
// still crashes, they aren't.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Check,
  CheckCircle2,
  Copy,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UserHealth } from "@/app/lib/health";
import {
  type Crumb,
  clearServerTrail,
  clearTrail,
  deviceInfo,
  fetchServerTrail,
  installGlobalHandlers,
  isDebugEnabled,
  isSafeRender,
  readTrail,
  setDebugEnabled,
  setSafeRender,
} from "@/app/lib/debug-log";

export function DebugPanel() {
  const [enabled, setEnabled] = useState(false);
  const [safe, setSafe] = useState(false);
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [info, setInfo] = useState<Record<string, unknown>>({});
  const [copied, setCopied] = useState(false);
  const [loadingTrail, setLoadingTrail] = useState(false);
  // Admin-only shortcut into the admin dashboard. The browser never sees the
  // user record, so we ask the server whether this account is an admin and only
  // reveal the link when it is. A non-admin (or a 401/failed fetch) leaves it
  // hidden — the /admin/* routes are still gated server-side regardless.
  const [isAdmin, setIsAdmin] = useState(false);
  // System status: is the model provider / sync backend reachable? Answers the
  // "is llama down, or is it something else?" fork when a chat hangs on
  // "Thinking…". Admins get a deeper view under /admin/diagnostics.
  const [health, setHealth] = useState<UserHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);

  const checkHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(null);
    try {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setHealth((await res.json()) as UserHealth);
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : "Status check failed.");
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    setInfo(deviceInfo());
    // The durable server trail is the one that survives a crashed tab; fall
    // back to the local copy only if the server has nothing.
    setLoadingTrail(true);
    void fetchServerTrail().then((server) => {
      setTrail(server.length > 0 ? server : readTrail());
      setLoadingTrail(false);
    });
  }, []);

  useEffect(() => {
    setEnabled(isDebugEnabled());
    setSafe(isSafeRender());
    if (isDebugEnabled()) installGlobalHandlers();
    refresh();
    void checkHealth();
    let alive = true;
    void fetch("/api/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (alive && body?.isAdmin === true) setIsAdmin(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [refresh, checkHealth]);

  const onToggleEnabled = useCallback(
    (on: boolean) => {
      setDebugEnabled(on);
      setEnabled(on);
      refresh();
    },
    [refresh]
  );

  const onToggleSafe = useCallback((on: boolean) => {
    setSafeRender(on);
    setSafe(on);
  }, []);

  const onCopy = useCallback(async () => {
    const server = await fetchServerTrail();
    const payload = JSON.stringify(
      { device: deviceInfo(), trail: server.length > 0 ? server : readTrail() },
      null,
      2
    );
    try {
      await navigator.clipboard?.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }, []);

  const onClear = useCallback(() => {
    clearTrail();
    void clearServerTrail().then(refresh);
  }, [refresh]);

  const t0 = trail.length ? trail[0].t : 0;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {isAdmin && (
        <Link
          href="/admin/worker"
          className="flex items-center justify-between gap-3 rounded-xl border border-[color-mix(in_oklab,var(--color-accent-2)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-accent-2)_8%,transparent)] p-3 text-left transition hover:bg-[color-mix(in_oklab,var(--color-accent-2)_14%,transparent)]"
        >
          <span className="flex items-center gap-2.5">
            <ShieldCheck className="h-4 w-4 shrink-0 text-[var(--color-accent-2)]" />
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium text-foreground">
                Open admin dashboard
              </span>
              <span className="text-xs text-muted-foreground">
                Manage Fly workers, accounts, schedules, and more.
              </span>
            </span>
          </span>
        </Link>
      )}

      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Activity className="h-4 w-4 text-[var(--color-accent-2)]" />
            System status
          </span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => void checkHealth()}
            disabled={healthLoading}
          >
            <RotateCcw className={cn("h-3.5 w-3.5", healthLoading && "animate-spin")} />
            {healthLoading ? "Checking…" : "Check"}
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">
          If a chat is stuck on &ldquo;Thinking&hellip;&rdquo;, check here first: a red
          model provider means the model is down (wait and retry); if everything
          is green, it&apos;s something on our side.
        </span>

        {healthError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
            {healthError}
          </div>
        ) : null}

        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          <HealthRow
            label="Model provider (Ollama Cloud)"
            loading={healthLoading && !health}
            ok={health?.providers.ollama.ok}
            detail={
              health?.providers.ollama.ok
                ? `${health.providers.ollama.count} models · ${health.providers.ollama.latencyMs ?? "?"} ms`
                : health?.providers.ollama.error
            }
          />
          {health?.providers.runpod ? (
            <HealthRow
              label="Model provider (RunPod)"
              loading={false}
              ok={health.providers.runpod.ok}
              detail={
                health.providers.runpod.ok
                  ? `${health.providers.runpod.count} models · ${health.providers.runpod.latencyMs ?? "?"} ms`
                  : health.providers.runpod.error
              }
            />
          ) : null}
          <HealthRow
            label="Sync & streaming"
            loading={healthLoading && !health}
            ok={health?.sync.ok}
            detail={
              health?.sync.ok
                ? `Reachable · ${health.sync.latencyMs ?? "?"} ms`
                : health?.sync.error
            }
          />
        </div>

        {isAdmin ? (
          <Link
            href="/admin/diagnostics"
            className="text-xs text-[var(--color-accent-2)] underline"
          >
            Open full diagnostics (worker, queues, streams) →
          </Link>
        ) : null}
      </div>

      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
        Turn this on, then open the chat that crashes. When the tab dies, reload
        and come back here - the trail below survives the crash and its last
        line shows where it failed. Tap <span className="font-medium">Copy</span>{" "}
        and send it over.
      </div>

      <ToggleRow
        label="Phone debug mode"
        hint="Records crash-surviving breadcrumbs as pages render. No-op when off."
        checked={enabled}
        onChange={onToggleEnabled}
      />
      <ToggleRow
        label="Safe render (skip image decode)"
        hint="Renders the transcript without decoding attached photos. If the chat opens with this on, images are the cause."
        checked={safe}
        onChange={onToggleSafe}
      />

      <div className="flex flex-col gap-1">
        <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Device
        </div>
        <pre className="w-full max-w-full whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-2 font-mono text-[10px] leading-relaxed">
          {JSON.stringify(info, null, 2)}
        </pre>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Diagnostic trail ({loadingTrail ? "…" : trail.length})
          </div>
          <div className="flex gap-1">
            <Button variant="outline" size="icon-sm" onClick={refresh} title="Refresh">
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => void onCopy()}
              title="Copy trail"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
            <Button variant="outline" size="icon-sm" onClick={onClear} title="Clear trail">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        {trail.length === 0 ? (
          <div className="rounded-lg bg-muted/40 p-3 text-center text-xs text-muted-foreground">
            {loadingTrail
              ? "Loading…"
              : "No breadcrumbs yet. Enable debug mode, then open the failing chat and reload."}
          </div>
        ) : (
          <div className="max-h-64 w-full max-w-full overflow-y-auto rounded-lg bg-muted/50 p-2 font-mono text-[10px] leading-relaxed">
            {trail.map((c, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                <span className="text-muted-foreground">
                  +{((c.t - t0) / 1000).toFixed(2)}s
                </span>{" "}
                <span className="text-foreground">{c.label}</span>
                {c.data != null && (
                  <span className="text-muted-foreground">
                    {" "}
                    {typeof c.data === "string" ? c.data : JSON.stringify(c.data)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One up/down row in the System status card: a status icon, a label, and a
 *  detail line (model count + latency when up, the error message when down). */
function HealthRow({
  label,
  ok,
  detail,
  loading,
}: {
  label: string;
  ok: boolean | undefined;
  detail: string | null | undefined;
  loading: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 px-2.5 py-2">
      {loading || ok === undefined ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
      ) : ok ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <XCircle className="h-4 w-4 shrink-0 text-destructive" />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs font-medium text-foreground">{label}</span>
        {detail ? (
          <span className="truncate text-[11px] text-muted-foreground">{detail}</span>
        ) : null}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-card p-3 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
