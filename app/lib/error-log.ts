// Server-side error log — an internal Sentry-lite. Every server-side path
// that catches a user-visible failure pushes a structured event into a
// single Redis ZSET, scored by timestamp. The /admin/errors page reads it
// back. Entries auto-evict after `TTL_S` and we cap the set at `MAX_ENTRIES`
// so a chatty schedule can't blow out Upstash storage.
//
// Logging is best-effort: every public function swallows its own errors so
// a misbehaving Redis can't take down the path that's already failing. We
// log the secondary failure to the console and move on.

import { Redis } from "@upstash/redis";

const PREFIX = "ollchat:errors";
const KEY = `${PREFIX}:events`;
// 3 days of error history matches the schedule result TTL — once a run's
// result has aged out, the matching error entry isn't useful either.
const TTL_S = 3 * 24 * 60 * 60;
// Hard cap on retained events so a flapping schedule can't unbound the set.
const MAX_ENTRIES = 5000;
// Largest stack/message we'll persist. Anything bigger is truncated with a
// "(…)" marker so a single huge error can't push out hundreds of useful ones.
const MAX_FIELD_CHARS = 4000;

export type ErrorSource =
  | "schedule"
  | "query"
  | "sweep"
  | "chat"
  | "proxy"
  | "tool"
  | "other";

export type ErrorEvent = {
  /** Unique id so ZADD doesn't collide when two errors land on the same ms. */
  id: string;
  /** Unix ms, mirrors the ZSET score. */
  ts: number;
  source: ErrorSource;
  message: string;
  stack?: string;
  /** Originating artifact appId, when known. Drives the dashboard's
   *  "group by app" filter. */
  appId?: string;
  /** Free-form structured context. Kept small (model id, prompt summary,
   *  task type, etc.) — not the full payload. */
  context?: Record<string, unknown>;
};

let cached: Redis | null = null;
let cachedError: Error | null = null;

function readCreds(): { url?: string; token?: string } {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  };
}

export function isErrorLogConfigured(): boolean {
  const { url, token } = readCreds();
  return !!(url && token);
}

function getRedis(): Redis | null {
  if (cached) return cached;
  if (cachedError) return null;
  const { url, token } = readCreds();
  if (!url || !token) {
    cachedError = new Error("error-log: Redis creds missing");
    return null;
  }
  cached = new Redis({ url, token });
  return cached;
}

function truncate(s: string | undefined): string | undefined {
  if (s == null) return s;
  if (s.length <= MAX_FIELD_CHARS) return s;
  return s.slice(0, MAX_FIELD_CHARS) + "\n…(truncated)";
}

function newId(ts: number): string {
  // ts + 6-char random suffix. Members must be unique strings or the ZADD
  // overwrites the score on collision and we lose the older event.
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts.toString(36)}-${rand}`;
}

/**
 * Persist one error event. Best-effort — never throws. The caller is in a
 * failure path already; we don't want Redis hiccups making things worse.
 */
export async function captureError(input: {
  source: ErrorSource;
  message: string;
  stack?: string;
  appId?: string;
  context?: Record<string, unknown>;
}): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const ts = Date.now();
  const event: ErrorEvent = {
    id: newId(ts),
    ts,
    source: input.source,
    message: truncate(input.message) ?? "(no message)",
    stack: truncate(input.stack),
    appId: input.appId,
    context: input.context,
  };

  try {
    const member = JSON.stringify(event);
    // ZADD with score=ts so range queries by time work directly. We rely on
    // the (id, member) being unique to avoid silent overwrites.
    await redis.zadd(KEY, { score: ts, member });
    // Cap the set: drop the oldest entries beyond MAX_ENTRIES. ZREMRANGEBYRANK
    // 0 N removes the lowest-scored N+1 elements; passing -MAX_ENTRIES-1 as
    // the stop index keeps the newest MAX_ENTRIES.
    await redis.zremrangebyrank(KEY, 0, -MAX_ENTRIES - 1);
    // Sliding TTL: each push refreshes the 3-day window so an active log
    // never expires while errors are still being written.
    await redis.expire(KEY, TTL_S);
  } catch (err) {
    console.error("[error-log] captureError failed", err);
  }
}

/**
 * Convenience wrapper for the common shape "I caught an Error and want to
 * log it." Pulls .message and .stack and forwards everything else as context.
 */
export async function captureException(
  err: unknown,
  input: {
    source: ErrorSource;
    appId?: string;
    context?: Record<string, unknown>;
  }
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  await captureError({ ...input, message, stack });
}

export type ListOptions = {
  limit?: number;
  /** ms epoch upper bound (exclusive). Use for "load older" pagination —
   *  pass the oldest `ts` you already have. */
  before?: number;
  source?: ErrorSource;
  appId?: string;
};

export type ListResult = {
  events: ErrorEvent[];
  total: number;
  hasMore: boolean;
};

/**
 * Read the most recent events, newest-first. Filters are applied
 * client-side over a fetched window — fine because the set is capped at
 * MAX_ENTRIES. If we ever need true server-side filtering, switch to a
 * per-source/per-app index.
 */
export async function listErrors(opts: ListOptions = {}): Promise<ListResult> {
  const redis = getRedis();
  if (!redis) return { events: [], total: 0, hasMore: false };

  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  // Upstash's typed ZRANGE wants a numeric or sentinel here, not a generic
  // string — exclusive lower bounds use the `(${number}` template.
  const max: number | "+inf" | `(${number}` =
    opts.before != null ? (`(${opts.before}` as `(${number}`) : "+inf";

  try {
    const total = await redis.zcard(KEY);
    // Pull a window larger than `limit` so client-side filters can still
    // return `limit` matches without an extra round-trip — but bounded so
    // this stays cheap. 4× was enough in practice.
    const fetchCount = (opts.source || opts.appId) ? limit * 4 : limit;
    const raw = await redis.zrange<string[]>(KEY, max, "-inf", {
      byScore: true,
      rev: true,
      offset: 0,
      count: fetchCount,
    });
    const events: ErrorEvent[] = [];
    for (const item of raw ?? []) {
      let parsed: ErrorEvent | null = null;
      if (typeof item === "string") {
        try {
          parsed = JSON.parse(item) as ErrorEvent;
        } catch {
          continue;
        }
      } else if (item && typeof item === "object") {
        parsed = item as ErrorEvent;
      }
      if (!parsed) continue;
      if (opts.source && parsed.source !== opts.source) continue;
      if (opts.appId && parsed.appId !== opts.appId) continue;
      events.push(parsed);
      if (events.length >= limit) break;
    }
    return {
      events,
      total,
      hasMore: events.length >= limit,
    };
  } catch (err) {
    console.error("[error-log] listErrors failed", err);
    return { events: [], total: 0, hasMore: false };
  }
}

/**
 * Per-source counts over the entire retained window. Drives the dashboard's
 * filter chips ("schedule (12) · query (3) · …"). Cheap because the set is
 * capped at MAX_ENTRIES.
 */
export async function errorStats(): Promise<{
  total: number;
  bySource: Record<string, number>;
  byApp: Array<{ appId: string; count: number }>;
  oldestMs: number | null;
  newestMs: number | null;
}> {
  const redis = getRedis();
  if (!redis) {
    return { total: 0, bySource: {}, byApp: [], oldestMs: null, newestMs: null };
  }
  try {
    const total = await redis.zcard(KEY);
    if (total === 0) {
      return { total: 0, bySource: {}, byApp: [], oldestMs: null, newestMs: null };
    }
    // Whole set, capped, so this is fine. Newest-first.
    const raw = await redis.zrange<string[]>(KEY, "+inf", "-inf", {
      byScore: true,
      rev: true,
      offset: 0,
      count: MAX_ENTRIES,
    });
    const bySource: Record<string, number> = {};
    const appCounts = new Map<string, number>();
    let oldestMs: number | null = null;
    let newestMs: number | null = null;
    for (const item of raw ?? []) {
      let parsed: ErrorEvent | null = null;
      if (typeof item === "string") {
        try {
          parsed = JSON.parse(item) as ErrorEvent;
        } catch {
          continue;
        }
      } else if (item && typeof item === "object") {
        parsed = item as ErrorEvent;
      }
      if (!parsed) continue;
      bySource[parsed.source] = (bySource[parsed.source] ?? 0) + 1;
      if (parsed.appId) {
        appCounts.set(parsed.appId, (appCounts.get(parsed.appId) ?? 0) + 1);
      }
      if (oldestMs == null || parsed.ts < oldestMs) oldestMs = parsed.ts;
      if (newestMs == null || parsed.ts > newestMs) newestMs = parsed.ts;
    }
    const byApp = Array.from(appCounts.entries())
      .map(([appId, count]) => ({ appId, count }))
      .sort((a, b) => b.count - a.count);
    return { total, bySource, byApp, oldestMs, newestMs };
  } catch (err) {
    console.error("[error-log] errorStats failed", err);
    return { total: 0, bySource: {}, byApp: [], oldestMs: null, newestMs: null };
  }
}

export async function clearErrors(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(KEY);
  } catch (err) {
    console.error("[error-log] clearErrors failed", err);
  }
}
