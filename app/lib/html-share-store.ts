// Server-side store for HTML-artifact share links.
//
// Mirrors share-store.ts (apps): the browser uploads the (possibly large)
// HTML payload directly to Vercel Blob via /api/share-blob-upload, then
// posts `{ token, blobUrl, title, summary, appId? }` to /api/share-html;
// the server writes a tiny pointer record into Upstash with a 7-day TTL.
// The recipient `GET /api/share/html/[token]` reads the pointer, fetches
// the blob, and returns the original SharedHtmlPayload shape.
//
// Why blob: the inline path had a hard MAX_HTML_SHARE_BYTES = 800_000 cap
// because Upstash REST has a ~1 MB request limit. With the bytes going
// straight to the blob CDN the cap disappears — blob payloads can be up
// to 5 GB, and the recipient's view fetches them from the CDN.

import { del } from "@vercel/blob";
import { Redis } from "@upstash/redis";
import { fetchBlobJson, htmlShareBlobPath } from "./blob-store";

export const HTML_SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 22 URL-safe base64 chars from 16 random bytes. */
export const HTML_SHARE_TOKEN_REGEX = /^[A-Za-z0-9_-]{22}$/;

const KEY_PREFIX = "artifacts:share-html";

export type SharedHtmlPayload = {
  html: string;
  /** Short human title for OG card + browser tab. */
  title: string;
  /** 1-3 sentence description for OG card + viewer header. */
  summary: string;
  createdAt: number;
  expiresAt: number;
  /** Param values baked in when shared from a designer-paired app, so the
   *  public viewer can hand them to the artifact at init the same way the
   *  owner's frame does. Absent for ad-hoc chat-mode HTML shares (the viewer
   *  then defaults to `{}`). Lives in the blob next to the HTML, not the
   *  Redis pointer. */
  params?: Record<string, unknown>;
  /** Owning app id, when the artifact was shared from a designer/instance.
   *  Lets the owner's live frame look up *this* token via
   *  share-input-store.getAppShareToken so artifact.shared.* writes/reads
   *  the same pool viewers see. Absent for ad-hoc chat-mode HTML shares. */
  appId?: string;
};

/**
 * Small pointer record stored in Redis. The heavy HTML lives in the blob.
 * Title/summary/appId stay here so the OG-image route can render the link
 * preview without paying a blob fetch — the iframe page does the blob
 * fetch anyway.
 */
export type HtmlShareIndexRecord = {
  blobUrl: string;
  title: string;
  summary: string;
  createdAt: number;
  expiresAt: number;
  appId?: string;
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
      "HTML sharing needs Redis credentials. Provision an Upstash Redis (or Vercel KV) " +
        "database and expose either UPSTASH_REDIS_REST_URL+UPSTASH_REDIS_REST_TOKEN or " +
        "KV_REST_API_URL+KV_REST_API_TOKEN to the project."
    );
    throw cachedError;
  }
  cached = new Redis({ url, token });
  return cached;
}

export function isHtmlShareStoreConfigured(): boolean {
  const { url, token } = readRedisCreds();
  return !!(url && token);
}

function shareKey(token: string): string {
  return `${KEY_PREFIX}:${token}`;
}

export async function putHtmlShareIndex(
  token: string,
  record: HtmlShareIndexRecord
): Promise<void> {
  const redis = getRedis();
  await redis.set(shareKey(token), JSON.stringify(record), {
    ex: HTML_SHARE_TTL_SECONDS,
  });
}

/** Revoke a live HTML share: deleting the pointer makes the public read route
 *  410 and `isHtmlShareLive` return false (killing live query/fetch execution).
 *  Backing blob is cleaned up best-effort. */
export async function delHtmlShare(token: string): Promise<void> {
  const redis = getRedis();
  await redis.del(shareKey(token));
  try {
    await del(htmlShareBlobPath(token));
  } catch {
    // Blob may not exist / token malformed — the pointer is gone either way.
  }
}

/**
 * Read the pointer + fetch the blob; return the original SharedHtmlPayload
 * shape so callers don't need to change. Tolerates legacy inline rows
 * (pre-blob) by sniffing for an inline `html` field on the parsed Redis
 * value.
 */
export async function getHtmlShare(
  token: string
): Promise<SharedHtmlPayload | null> {
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

  // Legacy inline path: payload was stored directly.
  if (typeof parsed.html === "string") {
    return parsed as unknown as SharedHtmlPayload;
  }

  // New pointer path: fetch the blob.
  const idx = parsed as unknown as HtmlShareIndexRecord;
  if (!idx.blobUrl) return null;
  const stored = await fetchBlobJson<{
    html: string;
    params?: Record<string, unknown>;
  }>(idx.blobUrl);
  if (!stored) return null;
  return {
    html: stored.html,
    title: idx.title,
    summary: idx.summary,
    createdAt: idx.createdAt,
    expiresAt: idx.expiresAt,
    ...(stored.params && typeof stored.params === "object"
      ? { params: stored.params }
      : {}),
    ...(idx.appId ? { appId: idx.appId } : {}),
  };
}

/**
 * Cheap liveness probe for a share token: a single Redis GET, no blob fetch.
 * Because the pointer carries a 7-day TTL and auto-evicts on expiry, "the key
 * exists" is equivalent to "the share is live". Used by the public execution
 * endpoints (query / fetch) which only need to gate on liveness, not read the
 * HTML back.
 */
export async function isHtmlShareLive(token: string): Promise<boolean> {
  const redis = getRedis();
  const raw = await redis.get(shareKey(token));
  return raw != null;
}

function base64urlFromBytes(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 22 URL-safe base64 chars (~128 bits of entropy from 16 random bytes). */
export function newHtmlShareToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64urlFromBytes(bytes);
}

/**
 * Best-effort title extraction from a raw HTML doc. Looks for the first
 * <title>…</title>, then the first <h1>, then falls back. The result is
 * trimmed, decoded for a tiny set of entities, and capped at 120 chars.
 */
export function extractHtmlTitle(html: string): string | null {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    const t = decodeBasicEntities(titleMatch[1]).replace(/\s+/g, " ").trim();
    if (t) return t.slice(0, 120);
  }
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match?.[1]) {
    const stripped = h1Match[1].replace(/<[^>]+>/g, "");
    const t = decodeBasicEntities(stripped).replace(/\s+/g, " ").trim();
    if (t) return t.slice(0, 120);
  }
  return null;
}

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
