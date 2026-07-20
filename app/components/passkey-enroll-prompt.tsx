"use client";

// Global, one-per-load nudge that invites a signed-in user who hasn't set up
// a passkey to add one. Mounted once at the root layout so it can appear on
// any page after login (including right after a password sign-in, satisfying
// "prompt them next time they sign in").
//
// It stays quiet unless ALL of these hold:
//   - the browser supports WebAuthn,
//   - we're on an in-app page (not /login, /signup, /share, /marketing),
//   - the user is authenticated, passkeys aren't disabled for them, and they
//     have zero enrolled credentials,
//   - they haven't snoozed the nudge recently (localStorage).
//
// Actions: enroll now, "Not now" (snooze), or "Don't ask again" (which flips
// the account-level passkey toggle off via the server, the same switch the
// user or an admin can control from settings).

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Fingerprint, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/app/components/toast";
import {
  enrollPasskey,
  isEnrollPromptSnoozed,
  passkeysSupported,
  snoozeEnrollPrompt,
} from "@/app/lib/passkey-client";

// Don't intrude while the login/signup/share/marketing chrome owns the screen.
const HIDE_ON_PREFIXES = ["/login", "/signup", "/marketing", "/share"];

export function PasskeyEnrollPrompt() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hidden = HIDE_ON_PREFIXES.some((p) => pathname.startsWith(p));

  useEffect(() => {
    if (hidden) return;
    if (!passkeysSupported()) return;
    if (isEnrollPromptSnoozed()) return;

    let alive = true;
    // A small delay keeps the nudge from racing the page's own first paint.
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch("/api/passkey", { cache: "no-store" });
          if (!res.ok) return; // 401 (not signed in yet) or transient error
          const body = (await res.json()) as {
            configured?: boolean;
            disabled?: boolean;
            credentials?: unknown[];
          };
          if (!alive) return;
          if (!body.configured || body.disabled) return;
          if ((body.credentials?.length ?? 0) > 0) return;
          setOpen(true);
        } catch {
          /* offline / network blip — try again on the next load */
        }
      })();
    }, 1200);

    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // Re-run when the user navigates into an eligible route from an excluded one.
  }, [hidden, pathname]);

  const onEnroll = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await enrollPasskey();
    if (result.ok) {
      setOpen(false);
      toast.success("Passkey added. You can now sign in without a password.");
      return;
    }
    if (result.cancelled) {
      setBusy(false);
      return;
    }
    setError(result.error);
    setBusy(false);
  }, [busy]);

  const onNotNow = useCallback(() => {
    snoozeEnrollPrompt();
    setOpen(false);
  }, []);

  const onNever = useCallback(async () => {
    snoozeEnrollPrompt();
    setOpen(false);
    try {
      await fetch("/api/passkey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      });
      toast("Passkey prompts turned off. Turn them back on in Preferences → Security.");
    } catch {
      /* best effort — the snooze already suppresses it for a while */
    }
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onNotNow();
      }}
    >
      <DialogContent variant="sheet" showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader>
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <Fingerprint className="h-6 w-6" />
          </div>
          <DialogTitle className="mt-3 text-center">
            Sign in faster with a passkey
          </DialogTitle>
          <DialogDescription className="text-center">
            Skip the password next time - unlock with your phone, Face ID,
            fingerprint, or a security key. Works across every device you add.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Button onClick={() => void onEnroll()} disabled={busy} className="h-10 gap-2">
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Fingerprint className="h-4 w-4" />
            )}
            Set up a passkey
          </Button>
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onNotNow}
              disabled={busy}
              className="flex-1"
            >
              Not now
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void onNever()}
              disabled={busy}
              className="flex-1 text-muted-foreground"
            >
              Don&apos;t ask again
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
