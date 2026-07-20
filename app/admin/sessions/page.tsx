"use client";

// /admin/sessions — single-button admin tool for forcing everyone to log
// in again. Sessions are HMAC-signed cookies with no server-side record,
// so we can't "delete" them; instead we bump a "min valid issued-at" epoch
// (lib/session-epoch.ts) and the proxy rejects any token issued before it.
//
// Layout intentionally bare — this page has one job. A status row up top,
// a destructive button below, a small banner explaining the consequences.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, LogOut, RefreshCw, ShieldAlert } from "lucide-react";
import { PaperCard } from "@/app/components/paper-card";
import { H1 } from "@/app/components/serif-heading";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/app/lib/visuals";

type Status = {
  configured: boolean;
  epoch: number;
  sessionDurationMs: number;
};

function formatAbsolute(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function SessionsAdminPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expiring, setExpiring] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/sessions", { cache: "no-store" });
      const body = (await r.json()) as Status | { error: string };
      if (!r.ok || "error" in body) {
        throw new Error(("error" in body && body.error) || `HTTP ${r.status}`);
      }
      setStatus(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const expireAll = useCallback(async () => {
    if (
      !confirm(
        "Force every signed-in device — including this one — to log in again? This cannot be undone."
      )
    ) {
      return;
    }
    setExpiring(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "expireAll" }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        epoch?: number;
        error?: string;
      };
      if (!r.ok || !body.ok) {
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      // Our own session was just invalidated. Bounce to /login before the
      // next API call returns a 401 and the user thinks the page is broken.
      router.replace("/login");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setExpiring(false);
    }
  }, [router]);

  const epoch = status?.epoch ?? 0;
  const hasEpoch = epoch > 0;

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <H1>Sessions</H1>
        <p className="text-sm text-muted-foreground">
          Force every signed-in device to log in again. Sessions are
          stateless HMAC cookies with a 7-day TTL — this tool bumps a
          server-side epoch so tokens issued before the click stop
          verifying on their next request.
        </p>
      </header>

      <PaperCard className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Status
          </div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void refresh()}
            disabled={loading}
            className="gap-1"
          >
            <RefreshCw className={loading ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
            Refresh
          </Button>
        </div>

        {status == null ? (
          <div className="text-sm text-muted-foreground">
            {loading ? "Loading…" : error ? "Failed to load." : "—"}
          </div>
        ) : !status.configured ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
            Redis isn't configured, so the session epoch can't be persisted.
            Set <code className="font-mono">UPSTASH_REDIS_REST_URL</code> and{" "}
            <code className="font-mono">UPSTASH_REDIS_REST_TOKEN</code> to
            enable this tool.
          </div>
        ) : hasEpoch ? (
          <div className="flex flex-col gap-1 font-mono text-xs">
            <div className="flex items-baseline gap-2">
              <span className="text-muted-foreground">Last expired:</span>
              <span className="tabular-nums">{formatAbsolute(epoch)}</span>
              <span className="text-muted-foreground">
                ({relativeTime(epoch)})
              </span>
            </div>
            <div className="text-muted-foreground">
              Tokens issued before this moment are rejected. Logins after it
              are valid for{" "}
              {Math.round(status.sessionDurationMs / (24 * 60 * 60 * 1000))}{" "}
              days.
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            No epoch set — every issued session is still valid until its
            natural 7-day expiry.
          </div>
        )}
      </PaperCard>

      <PaperCard tone="raised" className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldAlert className="mt-px h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p>
            This signs out every device that's currently logged in,{" "}
            <strong className="text-foreground">including the one you're using right now</strong>.
            You'll be sent to the login screen and will need to re-enter
            the app password. Other devices will be bounced within ~30
            seconds (proxy cache).
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="destructive"
            onClick={() => void expireAll()}
            disabled={expiring || !status?.configured}
            className="gap-1.5"
          >
            {expiring ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LogOut className="h-3.5 w-3.5" />
            )}
            Expire all sessions
          </Button>
          {error ? (
            <span className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
              {error}
            </span>
          ) : null}
        </div>
      </PaperCard>
    </div>
  );
}
