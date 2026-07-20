// Server-side store for shared pinned notes.
//
// A pinned note can carry any combination of: an HTML artifact, an
// assistant-message in markdown, and a chat-snapshot (transcript copy). The
// share dialog on /notes lets the owner publish a 7-day public link; this
// module persists the payload to Upstash Redis under
// `artifacts:share-note:{token}`. The matching public viewer at
// /share/note/{token} re-fetches via /api/share/note/{token} and renders the
// body kind it finds.
//
// Mirrors html-share-store.ts in lifecycle and credential discovery, but the
// payload is richer so non-HTML notes (the Message-type pin shown on /notes)
// can be shared with a rendered markdown page rather than a full-bleed
// iframe.

import { Redis } from "@upstash/redis";

export const NOTE_SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Upstash REST has a ~1 MB request limit; leave headroom for auth + overhead. */
export const MAX_NOTE_SHARE_BYTES = 800_000;

/** 22 URL-safe base64 chars from 16 random bytes. */
export const NOTE_SHARE_TOKEN_REGEX = /^[A-Za-z0-9_-]{22}$/;

const KEY_PREFIX = "artifacts:share-note";

export type SharedNoteBody =
  | { kind: "html"; html: string }
  | { kind: "markdown"; markdown: string }
  | {
      kind: "snapshot";
      messages: Array<{
        role: "user" | "assistant" | "system";
        content: string;
      }>;
    };

export type SharedNotePayload = {
  /** Short human title for OG card + browser tab. */
  title: string;
  /** 1-3 sentence description for OG card + viewer header. */
  summary: string;
  body: SharedNoteBody;
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
      "Note sharing needs Redis credentials. Provision an Upstash Redis (or Vercel KV) " +
        "database and expose either UPSTASH_REDIS_REST_URL+UPSTASH_REDIS_REST_TOKEN or " +
        "KV_REST_API_URL+KV_REST_API_TOKEN to the project."
    );
    throw cachedError;
  }
  cached = new Redis({ url, token });
  return cached;
}

export function isNoteShareStoreConfigured(): boolean {
  const { url, token } = readRedisCreds();
  return !!(url && token);
}

function shareKey(token: string): string {
  return `${KEY_PREFIX}:${token}`;
}

export async function putNoteShare(
  token: string,
  payload: SharedNotePayload
): Promise<void> {
  const redis = getRedis();
  await redis.set(shareKey(token), JSON.stringify(payload), {
    ex: NOTE_SHARE_TTL_SECONDS,
  });
}

/** Revoke a shared-note link: delete the Redis row so the public read 410s. */
export async function delNoteShare(token: string): Promise<void> {
  const redis = getRedis();
  await redis.del(shareKey(token));
}

export async function getNoteShare(
  token: string
): Promise<SharedNotePayload | null> {
  const redis = getRedis();
  const raw = await redis.get<string | SharedNotePayload>(shareKey(token));
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as SharedNotePayload;
    } catch {
      return null;
    }
  }
  return raw;
}

function base64urlFromBytes(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 22 URL-safe base64 chars (~128 bits of entropy from 16 random bytes). */
export function newNoteShareToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64urlFromBytes(bytes);
}
