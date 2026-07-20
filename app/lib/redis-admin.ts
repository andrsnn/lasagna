// Admin-side read access to the project's Upstash Redis. Used by the
// `/admin/redis` page to browse keys (a la a tiny psql for Redis).
//
// We share the same env vars as `stream-store.ts` so a single Upstash binding
// works for both the streaming buffer and the admin viewer.

import { Redis } from "@upstash/redis";

export type RedisKeyType = "string" | "list" | "set" | "zset" | "hash" | "stream" | "json" | "none";

export type KeyInfo = {
  key: string;
  type: RedisKeyType;
  ttl: number; // -1 no expire, -2 missing, otherwise seconds
  size?: number; // length for collection types, byte length for strings
};

export type KeyValue =
  | { key: string; type: "string"; ttl: number; value: string | null; raw: unknown }
  | { key: string; type: "list"; ttl: number; length: number; entries: unknown[]; truncated: boolean }
  | { key: string; type: "set"; ttl: number; size: number; members: unknown[]; truncated: boolean }
  | { key: string; type: "zset"; ttl: number; size: number; entries: { member: unknown; score: number }[]; truncated: boolean }
  | { key: string; type: "hash"; ttl: number; size: number; fields: Record<string, unknown> }
  | { key: string; type: "stream" | "json" | "none"; ttl: number; note: string };

const PREVIEW_LIMIT = 500;

let cached: Redis | null = null;

function readCreds(): { url?: string; token?: string } {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  };
}

export function isRedisConfigured(): boolean {
  const { url, token } = readCreds();
  return !!(url && token);
}

function client(): Redis {
  if (cached) return cached;
  const { url, token } = readCreds();
  if (!url || !token) {
    throw new Error(
      "Redis not configured. Set UPSTASH_REDIS_REST_URL+UPSTASH_REDIS_REST_TOKEN " +
        "(or KV_REST_API_URL+KV_REST_API_TOKEN)."
    );
  }
  cached = new Redis({ url, token });
  return cached;
}

export async function dbsize(): Promise<number> {
  return await client().dbsize();
}

export async function scanKeys(
  cursor: string,
  match: string,
  count: number
): Promise<{ cursor: string; keys: string[] }> {
  const redis = client();
  const [next, keys] = (await redis.scan(cursor, { match, count })) as [
    string | number,
    string[]
  ];
  return { cursor: String(next), keys };
}

/**
 * Hydrate a batch of bare keys with their type/ttl/size. We do this in
 * parallel — Upstash's REST API is happy with concurrent calls and the
 * alternative (sequential) makes the keys list painfully slow.
 */
export async function describeKeys(keys: string[]): Promise<KeyInfo[]> {
  if (keys.length === 0) return [];
  const redis = client();
  const results = await Promise.all(
    keys.map(async (key) => {
      const [type, ttl] = await Promise.all([
        redis.type(key) as Promise<RedisKeyType>,
        redis.ttl(key),
      ]);
      let size: number | undefined;
      try {
        if (type === "list") size = await redis.llen(key);
        else if (type === "set") size = await redis.scard(key);
        else if (type === "zset") size = await redis.zcard(key);
        else if (type === "hash") size = await redis.hlen(key);
      } catch {
        // size is best-effort
      }
      return { key, type, ttl, size } satisfies KeyInfo;
    })
  );
  return results;
}

export async function readKey(key: string): Promise<KeyValue> {
  const redis = client();
  const type = (await redis.type(key)) as RedisKeyType;
  const ttl = await redis.ttl(key);

  if (type === "none") {
    return { key, type: "none", ttl, note: "Key does not exist." };
  }

  if (type === "string") {
    // Upstash auto-deserializes JSON-looking values. Capture both.
    const raw = await redis.get<unknown>(key);
    const value = raw == null ? null : typeof raw === "string" ? raw : JSON.stringify(raw);
    return { key, type, ttl, value, raw };
  }

  if (type === "list") {
    const length = await redis.llen(key);
    const entries = await redis.lrange<unknown>(key, 0, PREVIEW_LIMIT - 1);
    return {
      key,
      type,
      ttl,
      length,
      entries,
      truncated: length > entries.length,
    };
  }

  if (type === "set") {
    const size = await redis.scard(key);
    const members = await redis.smembers(key);
    const trimmed = members.slice(0, PREVIEW_LIMIT);
    return {
      key,
      type,
      ttl,
      size,
      members: trimmed,
      truncated: members.length > trimmed.length,
    };
  }

  if (type === "zset") {
    const size = await redis.zcard(key);
    const raw = (await redis.zrange<unknown[]>(key, 0, PREVIEW_LIMIT - 1, {
      withScores: true,
    })) as unknown[];
    // zrange withScores returns a flat [member, score, member, score, ...] array
    const entries: { member: unknown; score: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      const member = raw[i];
      const scoreRaw = raw[i + 1];
      const score = typeof scoreRaw === "number" ? scoreRaw : Number(scoreRaw);
      entries.push({ member, score });
    }
    return { key, type, ttl, size, entries, truncated: size > entries.length };
  }

  if (type === "hash") {
    const fields = (await redis.hgetall<Record<string, unknown>>(key)) ?? {};
    const size = Object.keys(fields).length;
    return { key, type, ttl, size, fields };
  }

  // stream / json / unknown — report the type so the UI can show a hint.
  return {
    key,
    type,
    ttl,
    note: `Inspecting ${type} keys is not supported in this viewer.`,
  };
}

export async function deleteKey(key: string): Promise<number> {
  return await client().del(key);
}

export async function flushDb(): Promise<void> {
  await client().flushdb();
}

/**
 * Delete every key matching a glob pattern. Iterates SCAN and batches the
 * deletes via UNLINK so we don't fire one HTTP request per key (which trips
 * Upstash's per-day request cap on large keyspaces).
 *
 * Caps total iterations to keep a single call bounded — callers can re-run
 * if `done` is false.
 */
export async function deleteByPattern(
  pattern: string,
  opts: { scanCount?: number; maxIterations?: number } = {}
): Promise<{ deleted: number; scanned: number; cursor: string; done: boolean }> {
  const redis = client();
  const scanCount = opts.scanCount ?? 500;
  const maxIterations = opts.maxIterations ?? 200;

  let cursor = "0";
  let deleted = 0;
  let scanned = 0;
  let iterations = 0;

  do {
    const [next, batch] = (await redis.scan(cursor, {
      match: pattern,
      count: scanCount,
    })) as [string | number, string[]];
    cursor = String(next);
    scanned += batch.length;
    if (batch.length > 0) {
      deleted += await redis.unlink(...batch);
    }
    iterations += 1;
    if (iterations >= maxIterations) break;
  } while (cursor !== "0");

  return { deleted, scanned, cursor, done: cursor === "0" };
}
