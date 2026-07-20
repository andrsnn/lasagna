// Global "min-valid-issued-at" stamp for session tokens. Lets an admin
// invalidate every outstanding login in one move without having a
// per-session store — tokens whose implied issuedAt falls below the epoch
// fail verification on the next request.
//
// Stored as a single Redis string (`auth:session-epoch`) holding a unix-ms
// integer. Cached in-process for `CACHE_TTL_MS` because the proxy reads it
// on every authenticated request; without the cache we'd add a Redis round
// trip to every page load.

import { Redis } from "@upstash/redis";

const KEY = "auth:session-epoch";
// 30s feels like the right ceiling on "how long until an expire-all click
// takes effect for everyone". Long enough to make Redis costs negligible,
// short enough that a forgotten device gets booted promptly.
const CACHE_TTL_MS = 30 * 1000;

let cached: Redis | null = null;

function readCreds(): { url?: string; token?: string } {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  };
}

export function isSessionEpochConfigured(): boolean {
  const { url, token } = readCreds();
  return !!(url && token);
}

function getRedis(): Redis | null {
  if (cached) return cached;
  const { url, token } = readCreds();
  if (!url || !token) return null;
  cached = new Redis({ url, token });
  return cached;
}

let memo: { value: number; readAt: number } | null = null;

/**
 * Returns the current session epoch (ms). `0` means "no enforcement" —
 * which is what we want when Redis isn't configured or the key is missing:
 * the feature is opt-in via the admin button, so absence == disabled.
 *
 * Failures are swallowed and return the last cached value (or 0). We'd
 * rather log everyone in than 500 every request if Redis blips.
 */
export async function getSessionEpoch(): Promise<number> {
  const now = Date.now();
  if (memo && now - memo.readAt < CACHE_TTL_MS) return memo.value;

  const redis = getRedis();
  if (!redis) {
    memo = { value: 0, readAt: now };
    return 0;
  }

  try {
    const raw = await redis.get<number | string | null>(KEY);
    const value =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.length > 0
          ? Number(raw)
          : 0;
    const safe = Number.isFinite(value) && value > 0 ? value : 0;
    memo = { value: safe, readAt: now };
    return safe;
  } catch {
    // Keep serving the last good value if we have one; otherwise fail open.
    return memo?.value ?? 0;
  }
}

/**
 * Bumps the epoch to `at`, invalidating every token issued before it.
 * Returns the new value. Throws if Redis isn't configured — the caller
 * (admin endpoint) reports a 503 in that case.
 */
export async function setSessionEpoch(at: number): Promise<number> {
  const redis = getRedis();
  if (!redis) {
    throw new Error(
      "Session epoch unavailable — Redis is not configured. Set UPSTASH_REDIS_REST_URL+UPSTASH_REDIS_REST_TOKEN."
    );
  }
  await redis.set(KEY, at);
  memo = { value: at, readAt: Date.now() };
  return at;
}

/** Test/debug helper — drop the in-memory cache so the next read hits Redis. */
export function invalidateSessionEpochCache(): void {
  memo = null;
}
