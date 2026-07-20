// Passkey (WebAuthn) credential store backed by Upstash Redis.
//
// Layout:
//   passkeys:{emailLower}          → JSON array of StoredPasskey (a user's
//                                    registered authenticators — one per
//                                    device: phone, laptop, security key…).
//   passkey:owner:{credentialId}   → emailLower. Reverse index so a
//                                    usernameless ("discoverable") login can
//                                    resolve the credential the browser hands
//                                    back to the account that owns it.
//   passkey:regchal:{emailLower}   → registration challenge (EX 300s).
//   passkey:authchal:{flowId}      → authentication challenge (EX 300s). The
//                                    flowId travels in a short-lived HttpOnly
//                                    cookie because login is unauthenticated.
//
// Public keys (COSE) are stored base64url. The signature counter + backup
// flags are persisted per the WebAuthn spec so a rolled-back counter (a sign
// of a cloned authenticator) can be detected on the next login.
//
// Credential volume is human-scale (a handful per user), so the per-user list
// is read-modify-written rather than sharded — the same shape as the invite
// and user stores in this codebase.

import { Redis } from "@upstash/redis";

const CHALLENGE_TTL_SECONDS = 300;

export type StoredPasskey = {
  /** Credential ID, base64url. Unique per authenticator. */
  id: string;
  /** COSE public key bytes, base64url. */
  publicKey: string;
  /** Signature counter last seen from this authenticator. */
  counter: number;
  transports?: string[];
  deviceType?: "singleDevice" | "multiDevice";
  backedUp?: boolean;
  /** Human-friendly label ("iPhone", "Mac · Chrome"). Renameable. */
  name: string;
  createdAt: number;
  lastUsedAt: number;
};

/** Safe view for the client — never exposes the public key or counter. */
export type PasskeySummary = {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number;
  transports?: string[];
};

export function toPasskeySummary(p: StoredPasskey): PasskeySummary {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt,
    transports: p.transports,
  };
}

let cached: Redis | null = null;

function readRedisCreds(): { url?: string; token?: string } {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    token:
      process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  };
}

export function isPasskeyStoreConfigured(): boolean {
  const { url, token } = readRedisCreds();
  return !!(url && token);
}

function getRedis(): Redis {
  if (cached) return cached;
  const { url, token } = readRedisCreds();
  if (!url || !token) {
    throw new Error(
      "Passkey store needs Redis credentials. Set UPSTASH_REDIS_REST_URL+UPSTASH_REDIS_REST_TOKEN or KV_REST_API_URL+KV_REST_API_TOKEN."
    );
  }
  cached = new Redis({ url, token });
  return cached;
}

// ---------- base64url ----------

export function bytesToB64Url(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Returns an explicitly ArrayBuffer-backed view (not ArrayBufferLike) so the
// bytes satisfy @simplewebauthn's `Uint8Array<ArrayBuffer>` parameters and the
// Web Crypto typings without a cast.
export function b64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const padCount = (4 - (s.length % 4)) % 4;
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padCount);
  const str = atob(normalized);
  const buf = new ArrayBuffer(str.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

export function randomB64Url(byteLength: number): string {
  return bytesToB64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function parseJsonOrObject<T>(raw: T | string | null): T | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return raw;
}

// ---------- keys ----------

const emailLower = (email: string) => email.trim().toLowerCase();
const listKey = (email: string) => `passkeys:${emailLower(email)}`;
const ownerKey = (credentialId: string) => `passkey:owner:${credentialId}`;
const regChallengeKey = (email: string) => `passkey:regchal:${emailLower(email)}`;
const authChallengeKey = (flowId: string) => `passkey:authchal:${flowId}`;

// ---------- credential CRUD ----------

export async function listPasskeys(email: string): Promise<StoredPasskey[]> {
  const redis = getRedis();
  const raw = await redis.get<StoredPasskey[] | string>(listKey(email));
  const parsed = parseJsonOrObject<StoredPasskey[]>(raw);
  return Array.isArray(parsed) ? parsed : [];
}

/** Which account owns a credential ID, or null. Used by usernameless login. */
export async function getPasskeyOwner(credentialId: string): Promise<string | null> {
  const redis = getRedis();
  const raw = await redis.get<string>(ownerKey(credentialId));
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * Append a freshly-verified credential to the user's list and record the
 * reverse-index owner mapping. Idempotent on the credential ID — re-adding an
 * existing ID replaces it rather than duplicating.
 */
export async function addPasskey(
  email: string,
  cred: StoredPasskey
): Promise<void> {
  const redis = getRedis();
  const key = listKey(email);
  const existing = await listPasskeys(email);
  const next = existing.filter((p) => p.id !== cred.id);
  next.push(cred);
  await redis.set(key, JSON.stringify(next));
  await redis.set(ownerKey(cred.id), emailLower(email));
}

/** Update a credential's signature counter + last-used time after a login. */
export async function touchPasskey(
  email: string,
  credentialId: string,
  counter: number
): Promise<void> {
  const redis = getRedis();
  const existing = await listPasskeys(email);
  let changed = false;
  const next = existing.map((p) => {
    if (p.id !== credentialId) return p;
    changed = true;
    return { ...p, counter, lastUsedAt: Date.now() };
  });
  if (changed) await redis.set(listKey(email), JSON.stringify(next));
}

export async function renamePasskey(
  email: string,
  credentialId: string,
  name: string
): Promise<boolean> {
  const redis = getRedis();
  const existing = await listPasskeys(email);
  let found = false;
  const next = existing.map((p) => {
    if (p.id !== credentialId) return p;
    found = true;
    return { ...p, name };
  });
  if (found) await redis.set(listKey(email), JSON.stringify(next));
  return found;
}

export async function deletePasskey(
  email: string,
  credentialId: string
): Promise<boolean> {
  const redis = getRedis();
  const existing = await listPasskeys(email);
  const next = existing.filter((p) => p.id !== credentialId);
  if (next.length === existing.length) return false;
  if (next.length === 0) await redis.del(listKey(email));
  else await redis.set(listKey(email), JSON.stringify(next));
  await redis.del(ownerKey(credentialId));
  return true;
}

/** Wipe every passkey for an account (admin QA reset, or account cleanup). */
export async function deleteAllPasskeys(email: string): Promise<number> {
  const redis = getRedis();
  const existing = await listPasskeys(email);
  if (existing.length === 0) return 0;
  await redis.del(listKey(email));
  await Promise.all(existing.map((p) => redis.del(ownerKey(p.id))));
  return existing.length;
}

// ---------- challenge storage ----------

export async function setRegistrationChallenge(
  email: string,
  challenge: string
): Promise<void> {
  const redis = getRedis();
  await redis.set(regChallengeKey(email), challenge, { ex: CHALLENGE_TTL_SECONDS });
}

/** Atomically read + delete the registration challenge (single use). */
export async function consumeRegistrationChallenge(
  email: string
): Promise<string | null> {
  const redis = getRedis();
  const raw = await redis.getdel<string>(regChallengeKey(email));
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export async function setAuthenticationChallenge(
  flowId: string,
  challenge: string
): Promise<void> {
  const redis = getRedis();
  await redis.set(authChallengeKey(flowId), challenge, { ex: CHALLENGE_TTL_SECONDS });
}

export async function consumeAuthenticationChallenge(
  flowId: string
): Promise<string | null> {
  const redis = getRedis();
  const raw = await redis.getdel<string>(authChallengeKey(flowId));
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}
