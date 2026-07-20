"use client";

import { useEffect, useState } from "react";
import { Fingerprint, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PaperCard } from "@/app/components/paper-card";
import { H2 } from "@/app/components/serif-heading";
import { loginWithPasskey, passkeysSupported } from "@/app/lib/passkey-client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [passkeyPending, setPasskeyPending] = useState(false);
  // Resolved after mount so SSR and the first client render agree (WebAuthn
  // availability is a browser-only fact).
  const [supportsPasskey, setSupportsPasskey] = useState(false);

  useEffect(() => {
    setSupportsPasskey(passkeysSupported());
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending || !email || !password) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        window.location.href = "/";
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

  async function signInWithPasskey() {
    if (passkeyPending || pending) return;
    setPasskeyPending(true);
    setError(null);
    const result = await loginWithPasskey();
    if (result.ok) {
      window.location.href = "/";
      return;
    }
    // A dismissed OS prompt isn't an error worth shouting about.
    if (!result.cancelled) setError(result.error);
    setPasskeyPending(false);
  }

  return (
    <div className="safe-top safe-bottom flex h-full items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm">
        <PaperCard tone="raised" className="rounded-3xl p-8">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <Sparkles className="h-6 w-6" />
          </div>
          <H2 className="mt-5 text-center">Welcome back</H2>
          <p className="mt-1 text-center text-xs text-muted-foreground">
            Sign in to open your artifacts.
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
              placeholder="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
              disabled={pending || passkeyPending || !email || !password}
              className="mt-2 h-10"
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sign in"}
            </Button>
          </div>

          {supportsPasskey && (
            <>
              <div className="my-4 flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  or
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void signInWithPasskey()}
                disabled={pending || passkeyPending}
                className="h-10 w-full gap-2"
              >
                {passkeyPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Fingerprint className="h-4 w-4" />
                )}
                Sign in with a passkey
              </Button>
              <p className="mt-2 text-center text-[11px] text-muted-foreground">
                Use your phone, Face ID, fingerprint, or security key - no
                password needed.
              </p>
            </>
          )}

          <div className="mt-5 text-center text-[11px] text-muted-foreground">
            Session lasts 7 days on this browser. Need an account? Ask an admin
            for an invite link.
          </div>
        </PaperCard>
      </form>
    </div>
  );
}
