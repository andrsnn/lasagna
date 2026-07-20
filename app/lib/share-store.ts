// Server-side store for app share links.
//
// When the owner clicks "Share", the browser:
//   1. Serializes the designer + app via `serializeForShare` (lives in
//      share-payload.ts so the dialog can use it without pulling Redis
//      into the bundle).
//   2. Uploads the serialized JSON straight to Vercel Blob via
//      /api/share-blob-upload — getting a token + signed URL handshake
//      that lets the browser PUT directly to the blob CDN, bypassing
//      the Vercel function body cap (~4.5 MB) and the per-Upstash-value
//      cap (~1 MB) that used to bound `MAX_SHARE_BYTES = 500_000`.
//   3. POSTs `/api/share` with `{ token, blobUrl }`. Server fetches the
//      blob to extract material for the Gemma summary, then writes the
//      tiny pointer record into Upstash with a 7-day TTL.
//
// The recipient `GET /api/share/[token]` reads the Redis pointer, fetches
// the blob from the public Vercel Blob CDN, and returns the original
// SharedAppPayload shape — no client change required downstream.
//
// Redis is purely the courier (per-token pointer); blobs are the real
// payload; IndexedDB on each device remains canonical.

import { del } from "@vercel/blob";
import { Redis } from "@upstash/redis";
import { appShareBlobPath, fetchBlobJson } from "./blob-store";
import {
  SHARE_TOKEN_REGEX,
  SHARE_TTL_SECONDS,
  serializeForShare,
  type SharedApp,
  type SharedAppPayload,
  type SharedDesigner,
} from "./share-payload";

export {
  SHARE_TOKEN_REGEX,
  SHARE_TTL_SECONDS,
  serializeForShare,
  type SharedApp,
  type SharedAppPayload,
  type SharedDesigner,
};

const KEY_PREFIX = "artifacts:share";

/**
 * The tiny record we actually store in Redis. The heavy SharedAppPayload
 * lives in Vercel Blob at `share/app/{token}.json`. We cache the summary
 * + the timestamps next to the pointer so the recipient's first request
 * doesn't need TWO upstream fetches just to render the OG card.
 */
export type ShareIndexRecord = {
  blobUrl: string;
  summary: string;
  createdAt: number;
  expiresAt: number;
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
      "App sharing needs Redis credentials. Provision an Upstash Redis (or Vercel KV) " +
        "database and expose either UPSTASH_REDIS_REST_URL+UPSTASH_REDIS_REST_TOKEN or " +
        "KV_REST_API_URL+KV_REST_API_TOKEN to the project."
    );
    throw cachedError;
  }
  cached = new Redis({ url, token });
  return cached;
}

export function isShareStoreConfigured(): boolean {
  const { url, token } = readRedisCreds();
  return !!(url && token);
}

function shareKey(token: string): string {
  return `${KEY_PREFIX}:${token}`;
}

export async function putShareIndex(
  token: string,
  record: ShareIndexRecord
): Promise<void> {
  const redis = getRedis();
  await redis.set(shareKey(token), JSON.stringify(record), {
    ex: SHARE_TTL_SECONDS,
  });
}

/** Revoke a share link: delete the Redis pointer (which makes the public read
 *  route 410 immediately) and best-effort delete the backing blob. */
export async function delShare(token: string): Promise<void> {
  const redis = getRedis();
  await redis.del(shareKey(token));
  try {
    await del(appShareBlobPath(token));
  } catch {
    // Blob may not exist / token malformed — the pointer is gone either way.
  }
}

export async function getShareIndex(
  token: string
): Promise<ShareIndexRecord | null> {
  const redis = getRedis();
  const raw = await redis.get<string | ShareIndexRecord>(shareKey(token));
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ShareIndexRecord;
    } catch {
      return null;
    }
  }
  return raw;
}

/**
 * Hydrate the full SharedAppPayload that the share page expects. Reads
 * the Redis pointer, then fetches the blob. Returns null if either is
 * missing (expired / cleaned up / never written).
 *
 * Back-compat: a small fraction of legacy share rows wrote the full
 * payload inline (pre-blob). We detect that by sniffing for the inline
 * `designer` field on the raw Redis value and return it directly.
 */
export async function getShare(
  token: string
): Promise<SharedAppPayload | null> {
  const redis = getRedis();
  const raw = await redis.get<string | Record<string, unknown>>(shareKey(token));
  if (raw == null) return null;
  let parsed: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else {
    parsed = raw as Record<string, unknown>;
  }
  if (!parsed) return null;

  // Legacy inline path: payload was stored directly, no blob involved.
  if ("designer" in parsed && "app" in parsed) {
    return parsed as unknown as SharedAppPayload;
  }

  // New pointer path: fetch the blob.
  const idx = parsed as unknown as ShareIndexRecord;
  if (!idx.blobUrl) return null;
  const stored = await fetchBlobJson<{
    designer: SharedDesigner;
    app: SharedApp;
  }>(idx.blobUrl);
  if (!stored) return null;
  return {
    designer: stored.designer,
    app: stored.app,
    summary: idx.summary,
    createdAt: idx.createdAt,
    expiresAt: idx.expiresAt,
  };
}
