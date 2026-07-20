"use client";

// /admin/accounts — single account-management dashboard.
//
// Two stacked sections on one page:
//   1. Users  — every account in the system. Each row exposes an inline
//               "Reset password" form: type a new password, click Save, and
//               the server rehashes it with a fresh salt at the current
//               PBKDF2 iteration count.
//   2. Invites — same generate/revoke flow that used to live on
//               /admin/invites, embedded here so the admin doesn't have to
//               flip between tabs. The standalone /admin/invites page is
//               still mounted in the header for convenience.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import { PaperCard } from "@/app/components/paper-card";
import { H1 } from "@/app/components/serif-heading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { relativeTime } from "@/app/lib/visuals";

type UserSummary = {
  email: string;
  createdAt: number;
  isAdmin: boolean;
  passkeysDisabled: boolean;
  passkeyCount: number;
};

type InviteSummary = {
  token: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
};

type UsersResponse = { users: UserSummary[] } | { error: string };
type InvitesResponse =
  | { invites: InviteSummary[]; ttlSeconds: number }
  | { error: string };
type CreateInviteResponse =
  | { token: string; url: string; createdAt: number; expiresAt: number }
  | { error: string };

export default function AccountsAdminPage() {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <H1>Accounts</H1>
        <p className="text-sm text-muted-foreground">
          Every signed-up account, plus pending invites. Reset a password by
          typing a new one inline — the server rehashes it with a fresh
          salt. Generate a new invite link to onboard another user.
        </p>
      </header>

      <UsersSection />
      <InvitesSection />
    </div>
  );
}

function UsersSection() {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/accounts", { cache: "no-store" });
      const body = (await r.json()) as UsersResponse;
      if (!r.ok || "error" in body) {
        throw new Error(("error" in body && body.error) || `HTTP ${r.status}`);
      }
      setUsers(body.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <PaperCard className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Users ({users.length})
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

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading && users.length === 0 ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : users.length === 0 ? (
        <div className="text-sm text-muted-foreground">No accounts yet.</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {users.map((u) => (
            <UserRow
              key={u.email}
              user={u}
              isOpen={editing === u.email}
              onToggle={() =>
                setEditing((cur) => (cur === u.email ? null : u.email))
              }
              onChanged={() => void refresh()}
            />
          ))}
        </ul>
      )}
    </PaperCard>
  );
}

function UserRow({
  user,
  isOpen,
  onToggle,
  onChanged,
}: {
  user: UserSummary;
  isOpen: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  const setPasskeysDisabled = useCallback(
    async (disabled: boolean) => {
      setPasskeyBusy(true);
      setPasskeyError(null);
      try {
        const r = await fetch("/api/admin/accounts/passkeys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: user.email, disabled }),
        });
        const body = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (!r.ok || !body.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        onChanged();
      } catch (err) {
        setPasskeyError(err instanceof Error ? err.message : String(err));
      } finally {
        setPasskeyBusy(false);
      }
    },
    [user.email, onChanged]
  );

  const removeAllPasskeys = useCallback(async () => {
    if (
      !confirm(
        `Remove all ${user.passkeyCount} passkey(s) for ${user.email}? They'll need to re-enroll each device.`
      )
    ) {
      return;
    }
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      const r = await fetch(
        `/api/admin/accounts/passkeys?email=${encodeURIComponent(user.email)}`,
        { method: "DELETE" }
      );
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!r.ok || !body.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      onChanged();
    } catch (err) {
      setPasskeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setPasskeyBusy(false);
    }
  }, [user.email, user.passkeyCount, onChanged]);

  // Drop the typed value when the row closes so reopening it doesn't
  // surface a stale password.
  useEffect(() => {
    if (!isOpen) {
      setPassword("");
      setShowPassword(false);
      setError(null);
    }
  }, [isOpen]);

  const submit = useCallback(async () => {
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/accounts/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!r.ok || !body.ok) {
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      setSavedAt(Date.now());
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [password, user.email]);

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-background/60 p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-xs">{user.email}</span>
            {user.isAdmin && (
              <span className="inline-flex items-center gap-0.5 rounded border border-amber-400/40 bg-amber-100/60 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-900 dark:border-amber-700/40 dark:bg-amber-900/30 dark:text-amber-200">
                <Shield className="h-2.5 w-2.5" />
                Admin
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground">
            created {relativeTime(user.createdAt)}
          </div>
        </div>
        <Button
          type="button"
          size="xs"
          variant={isOpen ? "secondary" : "ghost"}
          onClick={onToggle}
          className="gap-1"
        >
          {isOpen ? (
            <>
              <X className="h-3 w-3" />
              Close
            </>
          ) : (
            <>
              <KeyRound className="h-3 w-3" />
              Reset password
            </>
          )}
        </Button>
      </div>

      {/* Passkeys: enrolled-device count + admin controls. Disabling is the
          escape hatch for QA / shared accounts that shouldn't collect device
          credentials or get nudged to enroll. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2 text-[11px]">
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Fingerprint className="h-3 w-3" />
          {user.passkeyCount} passkey{user.passkeyCount === 1 ? "" : "s"}
        </span>
        {user.passkeysDisabled && (
          <span className="rounded border border-amber-400/40 bg-amber-100/60 px-1 py-0.5 font-medium uppercase tracking-wider text-amber-900 dark:border-amber-700/40 dark:bg-amber-900/30 dark:text-amber-200">
            Passkeys off
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => void setPasskeysDisabled(!user.passkeysDisabled)}
            disabled={passkeyBusy}
            className="gap-1"
          >
            {passkeyBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {user.passkeysDisabled ? "Enable passkeys" : "Disable passkeys"}
          </Button>
          {user.passkeyCount > 0 && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => void removeAllPasskeys()}
              disabled={passkeyBusy}
              className="gap-1 text-destructive hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" />
              Remove all
            </Button>
          )}
        </div>
      </div>
      {passkeyError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {passkeyError}
        </div>
      )}

      {isOpen && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-2 border-t border-border pt-2"
        >
          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            New password
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
                disabled={saving}
                className="pr-8 font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="absolute inset-y-0 right-1.5 inline-flex items-center text-muted-foreground hover:text-foreground"
                tabIndex={-1}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
            <Button
              type="submit"
              size="xs"
              disabled={saving || password.length < 8}
              className="gap-1"
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : savedAt && Date.now() - savedAt < 2500 ? (
                <>
                  <Check className="h-3 w-3" />
                  Saved
                </>
              ) : (
                <>Save</>
              )}
            </Button>
          </div>
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
              {error}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            Hashed with PBKDF2-SHA256 + a fresh 16-byte salt. The user's
            existing browser session keeps working — use{" "}
            <code className="font-mono">Sessions</code> to log everyone out.
          </p>
        </form>
      )}
    </li>
  );
}

function InvitesSection() {
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
      const body = (await r.json()) as InvitesResponse;
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

  const copyUrl = useCallback(async (url: string, token: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    } catch {
      setError("Copy failed — copy the URL manually.");
    }
  }, []);

  const onCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/invites", { method: "POST" });
      const body = (await r.json()) as CreateInviteResponse;
      if (!r.ok || "error" in body) {
        throw new Error(("error" in body && body.error) || `HTTP ${r.status}`);
      }
      setLatestUrl(body.url);
      await refresh();
      try {
        await navigator.clipboard.writeText(body.url);
        setCopiedToken(body.token);
        setTimeout(() => setCopiedToken(null), 2000);
      } catch {
        // Clipboard API can fail outside a secure origin; the inline Copy
        // button is the fallback.
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

  const rows = useMemo(
    () =>
      invites.map((invite) => ({
        invite,
        url: buildInviteUrl(invite.token),
      })),
    [invites]
  );

  return (
    <>
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
            <RefreshCw
              className={loading ? "h-3 w-3 animate-spin" : "h-3 w-3"}
            />
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
          Pending invites ({invites.length})
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
            {rows.map(({ invite, url }) => (
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
            ))}
          </ul>
        )}
      </PaperCard>
    </>
  );
}

function buildInviteUrl(token: string): string {
  if (typeof window === "undefined") return `/signup?invite=${token}`;
  return `${window.location.origin}/signup?invite=${encodeURIComponent(token)}`;
}
