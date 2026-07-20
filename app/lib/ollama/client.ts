import { Ollama } from "ollama";

let cached: Ollama | null = null;

export function ollamaClient(): Ollama {
  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing OLLAMA_API_KEY. Set it in .env.local or in Vercel project settings."
    );
  }
  if (cached) return cached;
  cached = new Ollama({
    host: "https://ollama.com",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return cached;
}

/**
 * True if `err` looks like a transient upstream blip from Ollama Cloud or the
 * fetch transport — the kind of failure where the request itself is fine and
 * an immediate retry is likely to succeed.
 *
 * The most user-visible offender is the `Internal Server Error (ref: <uuid>)`
 * body Ollama Cloud's edge gateway returns when its upstream model service
 * has a momentary failure. The Ollama JS SDK propagates that body verbatim
 * as the thrown Error message, so we detect it by prefix.
 */
export function isTransientOllamaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { status_code?: number }).status_code;
  if (typeof status === "number") {
    if (status === 408 || status === 425 || status === 429) return true;
    if (status >= 500 && status <= 599) return true;
  }
  const msg = err.message ?? "";
  if (/Internal Server Error \(ref:/i.test(msg)) return true;
  if (/\b(Bad Gateway|Service Unavailable|Gateway Timeout)\b/i.test(msg)) return true;
  if (
    /(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET|fetch failed|socket hang up|Premature close|other side closed|terminated)/i.test(
      msg
    )
  )
    return true;
  return false;
}

/**
 * User-facing rewrite of an upstream error message. Ollama Cloud's raw edge
 * body — `Internal Server Error (ref: <uuid>)` — is opaque and looks like a
 * bug in this app. Translate it (and the other usual transients) into prose
 * the user can act on.
 */
export function friendlyOllamaError(message: string): string {
  if (
    /Internal Server Error \(ref:/i.test(message) ||
    /\b(Bad Gateway|Service Unavailable|Gateway Timeout)\b/i.test(message) ||
    /(ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|Premature close|other side closed|terminated)/i.test(
      message
    )
  ) {
    return "The model service had a transient error after a few retries. Tap Retry to try again.";
  }
  return message;
}

