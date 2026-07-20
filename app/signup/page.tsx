"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Fingerprint, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PaperCard } from "@/app/components/paper-card";
import { H2 } from "@/app/components/serif-heading";
import {
  enrollPasskey,
  passkeysSupported,
  snoozeEnrollPrompt,
} from "@/app/lib/passkey-client";

function SignupForm() {
  const params = useSearchParams();
  const token = params.get("invite") ?? "";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // After the account is created we offer passkey enrollment as a second step
  // (rather than bouncing straight into the app) so a new user sets up
  // passwordless sign-in while they're already thinking about their account.
  const [step, setStep] = useState<"form" | "enroll">("form");
  const [enrolling, setEnrolling] = useState(false);
  const [inviteState, setInviteState] = useState<"checking" | "valid" | "invalid">(
    token ? "checking" : "invalid"
  );

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/invites/preview?token=${encodeURIComponent(token)}`,
          { cache: "no-store" }
        );
        const body = (await res.json().catch(() => ({}))) as { valid?: boolean };
        if (cancelled) return;
        setInviteState(body.valid ? "valid" : "invalid");
      } catch {
        if (!cancelled) setInviteState("invalid");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    if (!email || !password || !confirm) {
      setError("Fill in every field.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, email, password }),
      });
      if (res.ok) {
        // Account created and a session cookie is now set. Offer to add a
        // passkey if the browser supports it; otherwise go straight in.
        if (passkeysSupported()) {
          setStep("enroll");
          setPending(false);
        } else {
          window.location.href = "/";
        }
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `HTTP ${res.status}`);
      setPending(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setPending(false);
    }
  }

  async function addPasskey() {
    if (enrolling) return;
    setEnrolling(true);
    setError(null);
    const result = await enrollPasskey();
    if (result.ok) {
      window.location.href = "/";
      return;
    }
    if (!result.cancelled) setError(result.error);
    setEnrolling(false);
  }

  if (step === "enroll") {
    return (
      <div className="safe-top safe-bottom flex h-full items-center justify-center px-4">
        <PaperCard tone="raised" className="w-full max-w-sm rounded-3xl p-8">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <Fingerprint className="h-6 w-6" />
          </div>
          <H2 className="mt-5 text-center">Add a passkey</H2>
          <p className="mt-1 text-center text-xs text-muted-foreground">
            Sign in next time with your phone, Face ID, fingerprint, or a
            security key - no password to remember. You can add more devices
            later from Preferences.
          </p>

          {error && (
            <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="mt-6 flex flex-col gap-2">
            <Button
              type="button"
              onClick={() => void addPasskey()}
              disabled={enrolling}
              className="h-10 gap-2"
            >
              {enrolling ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Fingerprint className="h-4 w-4" />
              )}
              Set up a passkey
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                // They just declined here — don't re-nag with the global
                // prompt the instant they land in the app.
                snoozeEnrollPrompt();
                window.location.href = "/";
              }}
              disabled={enrolling}
              className="h-10"
            >
              Skip for now
            </Button>
          </div>
        </PaperCard>
      </div>
    );
  }

  if (inviteState === "checking") {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (inviteState === "invalid") {
    return (
      <div className="safe-top safe-bottom flex h-full items-center justify-center px-4">
        <PaperCard tone="raised" className="w-full max-w-sm rounded-3xl p-8 text-center">
          <H2>Invite invalid</H2>
          <p className="mt-2 text-sm text-muted-foreground">
            This invite link is invalid, has expired, or has already been used.
            Ask the person who invited you for a new one.
          </p>
        </PaperCard>
      </div>
    );
  }

  return (
    <div className="safe-top safe-bottom flex h-full items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm">
        <PaperCard tone="raised" className="rounded-3xl p-8">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <Sparkles className="h-6 w-6" />
          </div>
          <H2 className="mt-5 text-center">Create your account</H2>
          <p className="mt-1 text-center text-xs text-muted-foreground">
            Pick an email and password. Your data will be yours alone.
          </p>

          <div className="mt-6 flex flex-col gap-2">
            <Input
              type="email"
              autoFocus
              placeholder="Email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={pending}
              className="h-10 text-base"
            />
            <Input
              type="password"
              placeholder="Password (min 8 characters)"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={pending}
              className="h-10 text-base"
            />
            <Input
              type="password"
              placeholder="Confirm password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={pending}
              className="h-10 text-base"
            />
            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                {error}
              </div>
            )}
            <Button
              type="submit"
              disabled={pending || !email || !password || !confirm}
              className="mt-2 h-10"
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create account"}
            </Button>
          </div>
        </PaperCard>
      </form>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <SignupForm />
    </Suspense>
  );
}
