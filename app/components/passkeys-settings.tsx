"use client";

// Preferences → Security. The user's own passkey management surface: list the
// devices they've enrolled, add a new one, rename or remove them, and a switch
// to turn passkeys (and their enroll prompt) off for this account entirely -
// the user-level counterpart to the admin's per-account toggle.

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Fingerprint,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirm } from "@/app/components/confirm";
import { toast } from "@/app/components/toast";
import { relativeTime } from "@/app/lib/visuals";
import { enrollPasskey, passkeysSupported } from "@/app/lib/passkey-client";
import type { PasskeySummary } from "@/app/lib/passkey-store";

type StatusResponse = {
  configured: boolean;
  disabled: boolean;
  credentials: PasskeySummary[];
};

export function PasskeysSection() {
  const [state, setState] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    setSupported(passkeysSupported());
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/passkey", { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setState((await res.json()) as StatusResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAdd = useCallback(async () => {
    if (adding) return;
    setAdding(true);
    setError(null);
    const result = await enrollPasskey();
    if (result.ok) {
      toast.success("Passkey added.");
      await refresh();
    } else if (!result.cancelled) {
      setError(result.error);
    }
    setAdding(false);
  }, [adding, refresh]);

  const onRemove = useCallback(
    async (cred: PasskeySummary) => {
      const ok = await confirm({
        title: `Remove "${cred.name}"?`,
        body: "This device won't be able to sign in with a passkey anymore. You can always add it again.",
        confirmLabel: "Remove",
      });
      if (!ok) return;
      try {
        const res = await fetch(`/api/passkey?id=${encodeURIComponent(cred.id)}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't remove passkey.");
      }
    },
    [refresh]
  );

  const onRename = useCallback(
    async (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        setEditingId(null);
        return;
      }
      try {
        const res = await fetch("/api/passkey", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, name: trimmed }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        setEditingId(null);
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't rename passkey.");
      }
    },
    [refresh]
  );

  const onToggleDisabled = useCallback(
    async (disabled: boolean) => {
      // Optimistic; revert on failure.
      setState((s) => (s ? { ...s, disabled } : s));
      try {
        const res = await fetch("/api/passkey", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ disabled }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch {
        setState((s) => (s ? { ...s, disabled: !disabled } : s));
        toast.error("Couldn't update the setting.");
      }
    },
    []
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (state && !state.configured) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
        Passkeys aren&apos;t available on this deployment - the server needs
        Redis configured to store them.
      </div>
    );
  }

  const credentials = state?.credentials ?? [];
  const disabled = state?.disabled ?? false;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <SectionLabel icon={<Fingerprint className="h-3.5 w-3.5" />}>
          Passkeys
        </SectionLabel>
        <span className="text-xs text-muted-foreground">
          Sign in without a password using your phone, Face ID, fingerprint, or
          a security key. Add one per device you use - they all unlock the same
          account.
        </span>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          {error}
        </div>
      )}

      {!supported && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          This browser doesn&apos;t support passkeys, so you can&apos;t add one
          here. Try a recent Safari, Chrome, or Edge.
        </div>
      )}

      {/* Enrolled devices */}
      {credentials.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No passkeys yet. Add one to sign in without your password.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {credentials.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-card p-3"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-secondary/60 text-[var(--color-accent-2)]">
                <KeyRound className="h-[17px] w-[17px]" />
              </span>
              <div className="min-w-0 flex-1">
                {editingId === c.id ? (
                  <RenameField
                    initial={c.name}
                    onCancel={() => setEditingId(null)}
                    onSave={(name) => void onRename(c.id, name)}
                  />
                ) : (
                  <>
                    <div className="truncate text-sm font-medium">{c.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      Added {relativeTime(c.createdAt)}
                      {c.lastUsedAt > c.createdAt
                        ? ` · last used ${relativeTime(c.lastUsedAt)}`
                        : ""}
                    </div>
                  </>
                )}
              </div>
              {editingId !== c.id && (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setEditingId(c.id)}
                    aria-label={`Rename ${c.name}`}
                    className="tap rounded p-1.5 text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void onRemove(c)}
                    aria-label={`Remove ${c.name}`}
                    className="tap rounded p-1.5 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Button
        type="button"
        onClick={() => void onAdd()}
        disabled={adding || !supported}
        className="h-10 gap-2"
      >
        {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        Add a passkey
      </Button>

      {/* Account-level switch */}
      <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-card p-3 text-xs">
        <input
          type="checkbox"
          checked={!disabled}
          onChange={(e) => void onToggleDisabled(!e.target.checked)}
          className="mt-0.5 h-4 w-4"
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">
            Use passkeys on this account
          </span>
          <span className="text-muted-foreground">
            When off, passkey sign-in is disabled and we won&apos;t prompt you to
            add one. Existing passkeys stop working until you turn this back on.
          </span>
        </span>
      </label>
    </div>
  );
}

function RenameField({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="flex items-center gap-1.5">
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSave(value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        maxLength={60}
        className="h-8 text-sm"
        aria-label="Passkey name"
      />
      <button
        type="button"
        onClick={() => onSave(value)}
        aria-label="Save name"
        className="tap rounded p-1.5 text-[var(--color-accent-2)] hover:opacity-80"
      >
        <Check className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel rename"
        className="tap rounded p-1.5 text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Small uppercase section heading with a hairline rule (mirrors settings). */
function SectionLabel({
  children,
  icon,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {icon}
      <span>{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
