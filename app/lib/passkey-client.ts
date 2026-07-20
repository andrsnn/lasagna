"use client";

// Browser-side passkey helpers: thin wrappers around @simplewebauthn/browser
// that talk to our /api/passkey/* routes and normalize errors into friendly,
// user-facing strings. Every function is safe to call unconditionally — they
// no-op with a clear error if WebAuthn isn't available.

import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type { PasskeySummary } from "@/app/lib/passkey-store";

export type PasskeyResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string; cancelled?: boolean };

export function passkeysSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

// ---- enroll-prompt snooze (shared by the global nudge + signup skip) ----

const SNOOZE_KEY = "artifacts:passkey-prompt-snooze-until";
const DEFAULT_SNOOZE_DAYS = 3;

/** Suppress the global enroll nudge for `days`. Best-effort (private mode). */
export function snoozeEnrollPrompt(days: number = DEFAULT_SNOOZE_DAYS): void {
  try {
    localStorage.setItem(
      SNOOZE_KEY,
      String(Date.now() + days * 24 * 60 * 60 * 1000)
    );
  } catch {
    /* storage disabled — worst case the nudge re-appears on the next load */
  }
}

export function isEnrollPromptSnoozed(): boolean {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    if (!raw) return false;
    const until = Number(raw);
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

/**
 * Turn a WebAuthn ceremony error into something we can show a human. The most
 * common one by far is NotAllowedError — the user dismissed the OS sheet or it
 * timed out — which we treat as a soft cancel, not a failure to shout about.
 */
function describeCeremonyError(err: unknown): { error: string; cancelled: boolean } {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "NotAllowedError" || name === "AbortError") {
    return { error: "Passkey prompt was dismissed.", cancelled: true };
  }
  if (name === "InvalidStateError") {
    return { error: "This device already has a passkey for your account.", cancelled: false };
  }
  if (name === "SecurityError") {
    return {
      error: "Passkeys require a secure (https) connection on this domain.",
      cancelled: false,
    };
  }
  return { error: message || "Passkey request failed.", cancelled: false };
}

async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `HTTP ${res.status}`;
}

/**
 * Enroll a passkey for the CURRENT (already-authenticated) user. `label` is an
 * optional friendly device name; the server derives one from the User-Agent
 * when omitted.
 */
export async function enrollPasskey(
  label?: string
): Promise<PasskeyResult<{ passkey: PasskeySummary }>> {
  if (!passkeysSupported()) {
    return { ok: false, error: "This browser doesn't support passkeys." };
  }
  let optionsJSON;
  try {
    const res = await fetch("/api/passkey/register/options", { method: "POST" });
    if (!res.ok) return { ok: false, error: await errorFrom(res) };
    optionsJSON = await res.json();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error." };
  }

  let attResp;
  try {
    attResp = await startRegistration({ optionsJSON });
  } catch (err) {
    const { error, cancelled } = describeCeremonyError(err);
    return { ok: false, error, cancelled };
  }

  try {
    const res = await fetch("/api/passkey/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response: attResp, label }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      passkey?: PasskeySummary;
      error?: string;
    };
    if (!res.ok || !body.ok || !body.passkey) {
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, passkey: body.passkey };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error." };
  }
}

/**
 * Sign in with a passkey (usernameless / discoverable). On success the session
 * cookies are set by the server and the caller should navigate into the app.
 */
export async function loginWithPasskey(): Promise<
  PasskeyResult<{ email: string; isAdmin: boolean }>
> {
  if (!passkeysSupported()) {
    return { ok: false, error: "This browser doesn't support passkeys." };
  }
  let optionsJSON;
  try {
    const res = await fetch("/api/passkey/login/options", { method: "POST" });
    if (!res.ok) return { ok: false, error: await errorFrom(res) };
    optionsJSON = await res.json();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error." };
  }

  let asseResp;
  try {
    asseResp = await startAuthentication({ optionsJSON });
  } catch (err) {
    const { error, cancelled } = describeCeremonyError(err);
    return { ok: false, error, cancelled };
  }

  try {
    const res = await fetch("/api/passkey/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response: asseResp }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      email?: string;
      isAdmin?: boolean;
      error?: string;
    };
    if (!res.ok || !body.ok) {
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, email: body.email ?? "", isAdmin: !!body.isAdmin };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error." };
  }
}
