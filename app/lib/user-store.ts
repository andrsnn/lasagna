// User and invite store backed by Upstash Redis.
//
// Layout:
//   user:{emailLower}        → JSON { email, passwordHash, salt, iterations, createdAt, isAdmin }
//   users:index              → SET of lowercase emails (cheap "list all users")
//   invite:{token}           → JSON { createdBy, createdAt } with EX = INVITE_TTL_SECONDS
//
// Public summaries (UserSummary) never leak passwordHash/salt — admin
// callers get email + isAdmin + createdAt only.
//
// Passwords are hashed with PBKDF2-SHA256 using Web Crypto (Edge-compatible)
// with a 16-byte random salt and 310,000 iterations (OWASP 2023 baseline for
// SHA-256). Verification uses a timing-safe byte compare.
//
// Invite tokens are 32 random bytes (base64url) and single-use — `consumeInvite`
// atomically reads-and-deletes via Redis GETDEL.

import { Redis } from "@upstash/redis";

export const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;
const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_KEY_BYTES = 32;
const SALT_BYTES = 16;

export type StoredUser = {
  email: string;
  passwordHash: string; // base64url of derived bits
  salt: string;         // base64url of salt
  iterations: number;
  createdAt: number;
  isAdmin: boolean;
  /**
   * Stable, non-PII WebAuthn user handle (base64url of 16 random bytes),
   * generated lazily the first time this user enrolls a passkey. Kept on the
   * record so every device the user enrolls maps back to the same handle.
   */
  webauthnId?: string;
  /**
   * When true, passkeys are turned off for this account: the enroll prompt
   * never shows, enrollment is refused, and passkey login is rejected. Set by
   * the user themselves (Preferences → Security) or by an admin — handy for QA
   * / shared accounts that shouldn't collect device credentials.
   */
  passkeysDisabled?: boolean;
};

export type StoredInvite = {
  createdBy: string;
  createdAt: number;
};

export type InviteSummary = {
  token: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
};

export type UserSummary = {
  email: string;
  createdAt: number;
  isAdmin: boolean;
  passkeysDisabled: boolean;
};

let cached: Redis | null = null;

function readRedisCreds(): { url?: string; token?: string } {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    token:
      process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  };
}

export function isUserStoreConfigured(): boolean {
  const { url, token } = readRedisCreds();
  return !!(url && token);
}

function getRedis(): Redis {
  if (cached) return cached;
  const { url, token } = readRedisCreds();
  if (!url || !token) {
    throw new Error(
      "User store needs Redis credentials. Provision Upstash Redis (or Vercel KV) " +
        "and expose UPSTASH_REDIS_REST_URL+UPSTASH_REDIS_REST_TOKEN or " +
        "KV_REST_API_URL+KV_REST_API_TOKEN."
    );
  }
  cached = new Redis({ url, token });
  return cached;
}

// ---------- base64url ----------

function bytesToB64Url(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlToBytes(s: string): Uint8Array {
  const padCount = (4 - (s.length % 4)) % 4;
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padCount);
  const str = atob(normalized);
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

// ---------- hashing ----------

async function derive(
  password: string,
  saltBytes: Uint8Array,
  iterations: number,
  keyBytes: number
): Promise<Uint8Array> {
  // Materialize a fresh ArrayBuffer (rather than handing Web Crypto a view
  // backed by SharedArrayBuffer) so the lib.dom typings accept it.
  const passwordBuf = new TextEncoder().encode(password);
  const passwordCopy = new ArrayBuffer(passwordBuf.byteLength);
  new Uint8Array(passwordCopy).set(passwordBuf);
  const saltCopy = new ArrayBuffer(saltBytes.byteLength);
  new Uint8Array(saltCopy).set(saltBytes);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    passwordCopy,
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltCopy, iterations, hash: "SHA-256" },
    keyMaterial,
    keyBytes * 8
  );
  return new Uint8Array(bits);
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let result = 0;
  for (let i = 0; i < a.byteLength; i++) result |= a[i] ^ b[i];
  return result === 0;
}

export async function hashPassword(password: string): Promise<{
  passwordHash: string;
  salt: string;
  iterations: number;
}> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await derive(password, saltBytes, PBKDF2_ITERATIONS, PBKDF2_KEY_BYTES);
  return {
    passwordHash: bytesToB64Url(derived),
    salt: bytesToB64Url(saltBytes),
    iterations: PBKDF2_ITERATIONS,
  };
}

export async function verifyPassword(
  password: string,
  stored: { passwordHash: string; salt: string; iterations: number }
): Promise<boolean> {
  try {
    const saltBytes = b64UrlToBytes(stored.salt);
    const expected = b64UrlToBytes(stored.passwordHash);
    const derived = await derive(password, saltBytes, stored.iterations, expected.byteLength);
    return timingSafeEqualBytes(derived, expected);
  } catch {
    return false;
  }
}

// ---------- email normalization ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(s: unknown): s is string {
  return typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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

// ---------- user CRUD ----------

function userKey(emailLower: string): string {
  return `user:${emailLower}`;
}

const USERS_INDEX_KEY = "users:index";

export async function getUserByEmail(email: string): Promise<StoredUser | null> {
  const redis = getRedis();
  const raw = await redis.get<StoredUser | string>(userKey(normalizeEmail(email)));
  return parseJsonOrObject<StoredUser>(raw);
}

export async function createUser(opts: {
  email: string;
  password: string;
  isAdmin?: boolean;
}): Promise<StoredUser> {
  const redis = getRedis();
  const emailLower = normalizeEmail(opts.email);
  if (!isValidEmail(emailLower)) {
    throw new Error("Invalid email address.");
  }
  if (opts.password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  // Cheap pre-check, then a NX set below to close the race.
  const existing = await redis.get<unknown>(userKey(emailLower));
  if (existing != null) {
    throw new Error("An account with that email already exists.");
  }
  const { passwordHash, salt, iterations } = await hashPassword(opts.password);
  const user: StoredUser = {
    email: emailLower,
    passwordHash,
    salt,
    iterations,
    createdAt: Date.now(),
    isAdmin: !!opts.isAdmin,
  };
  // NX guards against two concurrent signups racing on the same email.
  const set = await redis.set(userKey(emailLower), JSON.stringify(user), { nx: true });
  if (set === null) {
    throw new Error("An account with that email already exists.");
  }
  await redis.sadd(USERS_INDEX_KEY, emailLower);
  return user;
}

/**
 * Lists every user. Reads `users:index` for the email roster, then fetches
 * each record in parallel. Strips secrets — only email, createdAt, isAdmin
 * are returned. Falls back to a SCAN of `user:*` if the index is empty
 * (covers accounts created before the index existed).
 */
export async function listUsers(): Promise<UserSummary[]> {
  const redis = getRedis();
  let emails = await redis.smembers(USERS_INDEX_KEY);
  if (!emails || emails.length === 0) {
    const scanned: string[] = [];
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, { match: "user:*", count: 200 });
      cursor = next;
      for (const key of keys) {
        if (key.startsWith("user:")) scanned.push(key.slice("user:".length));
      }
    } while (cursor !== "0");
    emails = scanned;
  }
  const records = await Promise.all(
    emails.map((e) => redis.get<StoredUser | string>(userKey(e)))
  );
  const out: UserSummary[] = [];
  for (let i = 0; i < emails.length; i++) {
    const parsed = parseJsonOrObject<StoredUser>(records[i]);
    if (!parsed) continue;
    out.push({
      email: parsed.email,
      createdAt: parsed.createdAt,
      isAdmin: !!parsed.isAdmin,
      passkeysDisabled: !!parsed.passkeysDisabled,
    });
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/**
 * Overwrites the password hash on an existing user. Generates a fresh salt
 * and re-hashes at the current PBKDF2_ITERATIONS so old accounts get a
 * work-factor bump for free. Returns false if the user doesn't exist.
 */
export async function resetUserPassword(
  email: string,
  newPassword: string
): Promise<boolean> {
  if (newPassword.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const redis = getRedis();
  const emailLower = normalizeEmail(email);
  const raw = await redis.get<StoredUser | string>(userKey(emailLower));
  const existing = parseJsonOrObject<StoredUser>(raw);
  if (!existing) return false;
  const { passwordHash, salt, iterations } = await hashPassword(newPassword);
  const updated: StoredUser = {
    ...existing,
    passwordHash,
    salt,
    iterations,
  };
  await redis.set(userKey(emailLower), JSON.stringify(updated));
  return true;
}

// ---------- passkeys ----------

/**
 * Returns the account's stable WebAuthn user handle, generating and
 * persisting one on first use. The handle is 16 random bytes (base64url) —
 * stable across every device the user enrolls, and carrying no PII (unlike
 * the email) so it's safe to hand to an authenticator.
 */
export async function getOrCreateWebauthnId(email: string): Promise<string | null> {
  const redis = getRedis();
  const lower = normalizeEmail(email);
  const raw = await redis.get<StoredUser | string>(userKey(lower));
  const existing = parseJsonOrObject<StoredUser>(raw);
  if (!existing) return null;
  if (existing.webauthnId) return existing.webauthnId;
  const webauthnId = bytesToB64Url(crypto.getRandomValues(new Uint8Array(16)));
  await redis.set(userKey(lower), JSON.stringify({ ...existing, webauthnId }));
  return webauthnId;
}

/**
 * Turn passkeys on/off for an account. Callable by the user themselves or an
 * admin. Returns false if the account doesn't exist.
 */
export async function setPasskeysDisabled(
  email: string,
  disabled: boolean
): Promise<boolean> {
  const redis = getRedis();
  const lower = normalizeEmail(email);
  const raw = await redis.get<StoredUser | string>(userKey(lower));
  const existing = parseJsonOrObject<StoredUser>(raw);
  if (!existing) return false;
  await redis.set(
    userKey(lower),
    JSON.stringify({ ...existing, passkeysDisabled: disabled })
  );
  return true;
}

// ---------- invites ----------

function inviteKey(token: string): string {
  return `invite:${token}`;
}

function newInviteToken(): string {
  return bytesToB64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createInvite(createdBy: string): Promise<{
  token: string;
  createdAt: number;
  expiresAt: number;
}> {
  const redis = getRedis();
  const token = newInviteToken();
  const createdAt = Date.now();
  const payload: StoredInvite = { createdBy: normalizeEmail(createdBy), createdAt };
  await redis.set(inviteKey(token), JSON.stringify(payload), { ex: INVITE_TTL_SECONDS });
  return { token, createdAt, expiresAt: createdAt + INVITE_TTL_SECONDS * 1000 };
}

export async function peekInvite(token: string): Promise<StoredInvite | null> {
  const redis = getRedis();
  const raw = await redis.get<StoredInvite | string>(inviteKey(token));
  return parseJsonOrObject<StoredInvite>(raw);
}

/**
 * Atomically reads and deletes an invite token. Returns the invite payload
 * (so the caller can record `invitedBy`) or null if the token doesn't exist
 * or has expired. Caller is responsible for restoring the token via
 * `restoreInvite` if downstream account creation fails.
 */
export async function consumeInvite(token: string): Promise<StoredInvite | null> {
  const redis = getRedis();
  const raw = await redis.getdel<StoredInvite | string>(inviteKey(token));
  return parseJsonOrObject<StoredInvite>(raw);
}

/**
 * Put a previously-consumed invite back with a fresh full TTL. Used when
 * signup fails after token consumption — we'd rather over-extend a still-
 * valid invite by a few ms than burn the token on a server error.
 */
export async function restoreInvite(token: string, payload: StoredInvite): Promise<void> {
  const redis = getRedis();
  await redis.set(inviteKey(token), JSON.stringify(payload), { ex: INVITE_TTL_SECONDS });
}

export async function revokeInvite(token: string): Promise<void> {
  const redis = getRedis();
  await redis.del(inviteKey(token));
}

/**
 * Lists every pending invite by SCAN-ing `invite:*`. Cheap because invite
 * volume is human-scale (admin clicks a button to create one). For each
 * key we read its TTL to compute expiresAt; rows whose TTL is -2 (expired
 * between SCAN and TTL) are filtered out.
 */
export async function listInvites(): Promise<InviteSummary[]> {
  const redis = getRedis();
  const out: InviteSummary[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, { match: "invite:*", count: 200 });
    cursor = next;
    for (const key of keys) {
      const token = key.startsWith("invite:") ? key.slice("invite:".length) : key;
      const [raw, ttl] = await Promise.all([
        redis.get<StoredInvite | string>(key),
        redis.ttl(key),
      ]);
      const payload = parseJsonOrObject<StoredInvite>(raw);
      if (!payload || ttl < 0) continue;
      out.push({
        token,
        createdBy: payload.createdBy,
        createdAt: payload.createdAt,
        expiresAt: Date.now() + ttl * 1000,
      });
    }
  } while (cursor !== "0");
  // Newest first so the admin sees what they just created at the top.
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

// ---------- admin bootstrap ----------

export function getAdminEmail(): string {
  return normalizeEmail(process.env.ADMIN_EMAIL ?? "admin@example.com");
}
