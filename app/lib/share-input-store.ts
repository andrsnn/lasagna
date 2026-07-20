// Server-side store for inputs collected from public viewers of a shared
// HTML artifact. Pairs with `app/lib/html-share-store.ts`: that one stores
// the read-only HTML payload at `artifacts:share-html:{token}`; this one
// stores the append-only data viewers contribute back via
// `artifact.shared.append(...)`.
//
// Data model — per share token:
//   artifacts:share-html-input:{token}:{collection}     Redis HASH
//     field = entry id (12-char URL-safe base64)
//     value = JSON.stringify({ value, createdAt })
//   artifacts:share-html-collections:{token}            Redis SET of collection names
//     used to enforce the collections-per-token cap and to short-cut auth.
//
// Plus a small mapping so the authenticated owner's frame can look up its
// active share token by appId without listing keys:
//   artifacts:app-share-token:{appId} → token string (7-day TTL, refreshed
//   whenever the owner shares again).
//
// All keys share the 7-day TTL of the parent share (refreshed on each
// write so a busy collection keeps the share alive for the full window).
// Storage is Upstash Redis only — same credential discovery as the parent.

import { Redis } from "@upstash/redis";

import { HTML_SHARE_TTL_SECONDS } from "./html-share-store";

const KEY_INPUT_PREFIX = "artifacts:share-html-input";
const KEY_COLLECTIONS_PREFIX = "artifacts:share-html-collections";
const KEY_APP_TOKEN_PREFIX = "artifacts:app-share-token";

export const SHARE_INPUT_TTL_SECONDS = HTML_SHARE_TTL_SECONDS;

/** Names of collections an artifact author can pass to artifact.shared.*. */
export const COLLECTION_NAME_REGEX = /^[a-z0-9_-]{1,32}$/;

/** Hard caps — see plan. Server-enforced; client-side caps in the SDK
 *  match these so the artifact fails fast before the round-trip. */
export const MAX_COLLECTIONS_PER_TOKEN = 10;
export const MAX_ENTRIES_PER_COLLECTION = 200;
export const MAX_ENTRY_VALUE_BYTES = 2_048;
export const MAX_JSON_DEPTH = 5;
export const APPEND_RATE_PER_MINUTE = 20;
export const DELETE_RATE_PER_MINUTE = 30;
// Live shared-viewer execution limits. `artifact.query()` hits the LLM, so
// it carries a tight per-viewer cap AND a per-token ceiling (summed across
// every viewer) so a single popular link can't run up unbounded Ollama spend.
// `artifact.fetch()` only proxies cheap HTTPS reads, so it gets a looser cap.
export const QUERY_RATE_PER_MINUTE = 8;
export const QUERY_RATE_PER_MINUTE_PER_TOKEN = 40;
export const FETCH_RATE_PER_MINUTE = 20;
/** Sentinel "IP" used to bucket the per-token (all-viewers) query ceiling. */
export const RATE_ALL_VIEWERS = "__all__";

export type ShareInputEntry = {
  id: string;
  value: unknown;
  createdAt: number;
};

let cached: Redis | null = null;
let cachedError: Error | null = null;

function readRedisCreds(): { url?: string; token?: string } {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  };
}

function getRedis(): Redis {
  if (cached) return cached;
  if (cachedError) throw cachedError;
  const { url, token } = readRedisCreds();
  if (!url || !token) {
    cachedError = new Error(
      "Shared inputs need Redis credentials. Provision an Upstash Redis (or " +
        "Vercel KV) database and expose either UPSTASH_REDIS_REST_URL+" +
        "UPSTASH_REDIS_REST_TOKEN or KV_REST_API_URL+KV_REST_API_TOKEN."
    );
    throw cachedError;
  }
  cached = new Redis({ url, token });
  return cached;
}

export function isShareInputStoreConfigured(): boolean {
  const { url, token } = readRedisCreds();
  return !!(url && token);
}

function inputKey(token: string, collection: string): string {
  return `${KEY_INPUT_PREFIX}:${token}:${collection}`;
}

function collectionsKey(token: string): string {
  return `${KEY_COLLECTIONS_PREFIX}:${token}`;
}

function appTokenKey(appId: string): string {
  return `${KEY_APP_TOKEN_PREFIX}:${appId}`;
}

export function isValidCollectionName(name: unknown): name is string {
  return typeof name === "string" && COLLECTION_NAME_REGEX.test(name);
}

/** 12 URL-safe base64 chars (~72 bits of entropy from 9 random bytes). */
export function newEntryId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Cheap structural check: reject deeply nested or non-JSON-y values
 *  before they reach Redis. Numbers/strings/bools/null/arrays/plain objects
 *  only. Throws with a structured message — caller maps to a 4xx. */
export function assertJsonValue(value: unknown, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new Error(`value too deeply nested (max depth ${MAX_JSON_DEPTH})`);
  }
  if (value === null) return;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return;
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, depth + 1);
    return;
  }
  if (t === "object") {
    const proto = Object.getPrototypeOf(value as object);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("value must be a plain object");
    }
    for (const k of Object.keys(value as Record<string, unknown>)) {
      assertJsonValue((value as Record<string, unknown>)[k], depth + 1);
    }
    return;
  }
  throw new Error(`unsupported value type: ${t}`);
}

export async function appendInput(
  token: string,
  collection: string,
  value: unknown
): Promise<ShareInputEntry> {
  const redis = getRedis();

  // Reject up-front if value oversize. JSON.stringify can throw on cycles —
  // surface that as a clean 4xx, not a 500.
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    throw new Error(
      err instanceof Error ? `value is not JSON-serializable: ${err.message}` : "value is not JSON-serializable"
    );
  }
  if (serialized.length > MAX_ENTRY_VALUE_BYTES) {
    throw Object.assign(
      new Error(
        `value too large (${serialized.length} bytes, max ${MAX_ENTRY_VALUE_BYTES})`
      ),
      { httpStatus: 413 }
    );
  }

  // Track which collections exist on this share — enforces the per-token
  // collection cap and lets the owner later enumerate / clean up.
  const colKey = collectionsKey(token);
  const isMember = await redis.sismember(colKey, collection);
  if (!isMember) {
    const total = await redis.scard(colKey);
    if (total >= MAX_COLLECTIONS_PER_TOKEN) {
      throw Object.assign(
        new Error(
          `too many collections on this share (max ${MAX_COLLECTIONS_PER_TOKEN})`
        ),
        { httpStatus: 422 }
      );
    }
    await redis.sadd(colKey, collection);
    await redis.expire(colKey, SHARE_INPUT_TTL_SECONDS);
  }

  const key = inputKey(token, collection);

  // Enforce entries-per-collection BEFORE we generate an id so we don't
  // burn ids on rejected writes. HLEN is O(1) in Redis.
  const count = await redis.hlen(key);
  if (count >= MAX_ENTRIES_PER_COLLECTION) {
    throw Object.assign(
      new Error(
        `collection "${collection}" is full (max ${MAX_ENTRIES_PER_COLLECTION} entries). Delete some to make room.`
      ),
      { httpStatus: 422 }
    );
  }

  const entry: ShareInputEntry = {
    id: newEntryId(),
    value,
    createdAt: Date.now(),
  };
  await redis.hset(key, {
    [entry.id]: JSON.stringify({ value: entry.value, createdAt: entry.createdAt }),
  });
  // Refresh TTL so a live collection survives the full share window.
  await redis.expire(key, SHARE_INPUT_TTL_SECONDS);
  return entry;
}

export async function listInputs(
  token: string,
  collection: string
): Promise<ShareInputEntry[]> {
  const redis = getRedis();
  const raw = await redis.hgetall<Record<string, string | { value: unknown; createdAt: number }>>(
    inputKey(token, collection)
  );
  if (!raw) return [];
  const out: ShareInputEntry[] = [];
  for (const id of Object.keys(raw)) {
    const v = raw[id];
    let parsed: { value: unknown; createdAt: number } | null = null;
    // Upstash may auto-decode JSON depending on configuration; tolerate both.
    if (typeof v === "string") {
      try {
        parsed = JSON.parse(v) as { value: unknown; createdAt: number };
      } catch {
        continue;
      }
    } else if (v && typeof v === "object") {
      parsed = v as { value: unknown; createdAt: number };
    }
    if (!parsed) continue;
    out.push({ id, value: parsed.value, createdAt: parsed.createdAt });
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

export async function deleteInput(
  token: string,
  collection: string,
  id: string
): Promise<boolean> {
  const redis = getRedis();
  const removed = await redis.hdel(inputKey(token, collection), id);
  return removed > 0;
}

export async function listCollections(token: string): Promise<string[]> {
  const redis = getRedis();
  const members = await redis.smembers(collectionsKey(token));
  return members.map(String).sort();
}

export async function putAppShareToken(appId: string, token: string): Promise<void> {
  const redis = getRedis();
  await redis.set(appTokenKey(appId), token, { ex: SHARE_INPUT_TTL_SECONDS });
}

export async function getAppShareToken(appId: string): Promise<string | null> {
  const redis = getRedis();
  const v = await redis.get<string>(appTokenKey(appId));
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Best-effort: bump rate counter for (token, ip, op) and return true when
 *  the caller exceeded the per-minute cap. Window is a 60-second sliding
 *  bucket aligned to wall clock; close enough for abuse protection without
 *  needing a script. */
export async function checkRateLimit(
  token: string,
  ip: string,
  op: "append" | "delete" | "query" | "fetch",
  limitPerMinute: number
): Promise<boolean> {
  const redis = getRedis();
  const bucket = Math.floor(Date.now() / 60_000);
  const key = `artifacts:share-html-rate:${op}:${token}:${ip}:${bucket}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 90);
  return n > limitPerMinute;
}
