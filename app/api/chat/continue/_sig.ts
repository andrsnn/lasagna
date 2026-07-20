// HMAC-signed handoff between chained chat workers.
//
// The original POST /api/chat worker fires a fire-and-forget
// `fetch(/api/chat/continue/{streamId})` to a sibling 300s worker before
// Vercel kills it at maxDuration. The continuation endpoint must verify
// that the request really came from us — Vercel doesn't gate same-origin
// internal calls, and there's no session cookie on a server-to-server
// fetch. We HMAC `${streamId}|${seq}` with a server secret, send it as a
// header, and constant-time compare on the receiving side.
//
// Secret resolution prefers an explicit CHAT_CONTINUE_SECRET, then falls
// back to whichever Redis REST token the stream store is using
// (UPSTASH_REDIS_REST_TOKEN for the Upstash-branded integration,
// KV_REST_API_TOKEN for the Vercel Marketplace KV integration). Both are
// deployment-scoped and not reachable to the browser. If none are
// configured, sign() throws — and we WANT it to: a stream that exceeds
// one worker's lifetime without chaining is the bug we surface.

import { createHmac, timingSafeEqual } from "node:crypto";

function getSecret(): string {
  const s =
    process.env.CHAT_CONTINUE_SECRET ??
    process.env.UPSTASH_REDIS_REST_TOKEN ??
    process.env.KV_REST_API_TOKEN;
  if (!s) {
    throw new Error(
      "Worker chaining requires CHAT_CONTINUE_SECRET, UPSTASH_REDIS_REST_TOKEN, or KV_REST_API_TOKEN."
    );
  }
  return s;
}

export function hmacSign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("hex");
}

export function verifyHmac(payload: string, sig: string): boolean {
  let expected: string;
  try {
    expected = hmacSign(payload);
  } catch {
    return false;
  }
  if (sig.length !== expected.length) return false;
  try {
    // Cast through Uint8Array — Node's typings narrowed Buffer in 22.x and
    // timingSafeEqual now wants ArrayBufferView<ArrayBuffer> precisely.
    const a = new Uint8Array(Buffer.from(sig, "hex"));
    const b = new Uint8Array(Buffer.from(expected, "hex"));
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
