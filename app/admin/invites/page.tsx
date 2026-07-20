"use client";

// /admin/invites — mint single-use invite links and manage pending ones.
//
// Layout: a "Generate invite" button that surfaces the freshly-minted URL
// for one-click copy, then a table of every currently-pending invite with
// revoke buttons.

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { PaperCard } from "@/app/components/paper-card";
import { H1 } from "@/app/components/serif-heading";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/app/lib/visuals";

type InviteSummary = {
  token: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
};

type ListResponse = {
  invites: InviteSummary[];
  ttlSeconds: number;
};

type CreateResponse = {
  token: string;
  url: string;
  createdAt: number;
  expiresAt: number;
};

export default function InvitesAdminPage() {
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [latestUrl, setLatestUrl] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/invites", { cache: "no-store" });
      const body = (await r.json()) as ListResponse | { error: string };
      if (!r.ok || "error" in body) {
        throw new Error(("error" in body && body.error) || `HTTP ${r.status}`);
      }
      setInvites(body.invites);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/invites", { method: "POST" });
      const body = (await r.json()) as CreateResponse | { error: string };
      if (!r.ok || "error" in body) {
        throw new Error(("error" in body && body.error) || `HTTP ${r.status}`);
      }
      setLatestUrl(body.url);
      await refresh();
      // Auto-copy for convenience — the admin almost always wants this on
      // the clipboard right after generation.
      try {
        await navigator.clipboard.writeText(body.url);
        setCopiedToken(body.token);
        setTimeout(() => setCopiedToken(null), 2000);
      } catch {
        // Clipboard API can fail in non-secure contexts; the button below
        // gives the admin a manual fallback.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [refresh]);

  const onRevoke = useCallback(
    async (token: string) => {
      if (!confirm("Revoke this invite? The link will stop working.")) return;
      try {
        const r = await fetch(
          `/api/admin/invites?token=${encodeURIComponent(token)}`,
          { method: "DELETE" }
        );
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh]
  );

  const copyUrl = useCallback(async (url: string, token: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    } catch {
      // Some browsers require a secure origin; show the URL inline as a
      // fallback so the admin can copy by hand.
      setError("Copy failed — copy the URL manually.");
    }
  }, []);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <H1>Invites</H1>
        <p className="text-sm text-muted-foreground">
          Generate single-use links so new users can create accounts. Each
          link works for one signup and expires after 7 days.
        </p>
      </header>

      <PaperCard tone="raised" className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            New invite
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
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => void onCreate()}
            disabled={creating}
            className="gap-1.5"
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Generate invite
          </Button>
          {latestUrl && (
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5">
              <code className="min-w-0 flex-1 truncate font-mono text-xs">
                {latestUrl}
              </code>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => void copyUrl(latestUrl, latestUrl)}
                className="gap-1"
              >
                {copiedToken === latestUrl ? (
                  <>
                    <Check className="h-3 w-3" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    Copy
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      </PaperCard>

      <PaperCard className="flex flex-col gap-3 p-4">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Pending invites
        </div>
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
            {error}
          </div>
        )}
        {loading && invites.length === 0 ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : invites.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No pending invites.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {invites.map((invite) => {
              const url = buildLocalUrl(invite.token);
              return (
                <li
                  key={invite.token}
                  className="flex flex-col gap-1 rounded-md border border-border bg-background/60 p-3"
                >
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-xs">
                      {url}
                    </code>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => void copyUrl(url, invite.token)}
                      className="gap-1"
                    >
                      {copiedToken === invite.token ? (
                        <>
                          <Check className="h-3 w-3" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" />
                          Copy
                        </>
                      )}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => void onRevoke(invite.token)}
                      className="gap-1 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                      Revoke
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                    <span>created by {invite.createdBy}</span>
                    <span>{relativeTime(invite.createdAt)}</span>
                    <span>expires {relativeTime(invite.expiresAt)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </PaperCard>
    </div>
  );
}

function buildLocalUrl(token: string): string {
  if (typeof window === "undefined") return `/signup?invite=${token}`;
  return `${window.location.origin}/signup?invite=${encodeURIComponent(token)}`;
}
