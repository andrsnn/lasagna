export const SESSION_COOKIE = "auth";
export const USER_HASH_COOKIE = "user_hash";
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/** Sentinel value placed in the `user_hash` cookie for the admin account.
 *  The client-side IndexedDB code maps this back to the legacy unsuffixed
 *  database name ("ollama-chat") so the admin's pre-multiuser data stays
 *  in place. Non-admin users get a per-email hash and a separate DB. */
export const ADMIN_USER_HASH = "admin";

export function getAppPassword(): string | null {
  const p = process.env.TEMP_PASS;
  return p && p.length > 0 ? p : null;
}

/**
 * Server-side secret used to sign session cookies. Separate from any user
 * password so multiple users can share a single signing key. Falls back to
 * TEMP_PASS so existing single-tenant deployments don't need to set a new
 * env var on the same day they upgrade.
 */
export function getSessionSecret(): string | null {
  const explicit = process.env.SESSION_SECRET;
  if (explicit && explicit.length > 0) return explicit;
  return getAppPassword();
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function base64urlFromBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBuffer(s: string): ArrayBuffer {
  const padCount = (4 - (s.length % 4)) % 4;
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padCount);
  const str = atob(normalized);
  const buf = new ArrayBuffer(str.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return buf;
}

function encodeEmail(email: string): string {
  return base64urlFromBuffer(new TextEncoder().encode(email.toLowerCase()).buffer);
}

function decodeEmail(encoded: string): string | null {
  try {
    return new TextDecoder().decode(base64urlToBuffer(encoded));
  } catch {
    return null;
  }
}

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function sign(secret: string, message: string): Promise<string> {
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64urlFromBuffer(sig);
}

async function verify(secret: string, message: string, signature: string): Promise<boolean> {
  try {
    const key = await getKey(secret);
    const sigBytes = base64urlToBuffer(signature);
    return await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(message)
    );
  } catch {
    return false;
  }
}

/**
 * Session token: `${encodedEmail}.${expiry}.${signature}`.
 *
 * The signature covers `${encodedEmail}.${expiry}` with a server-side
 * SESSION_SECRET (not the user's password) so the same key can verify
 * tokens for every user.
 */
export async function createSessionToken(email: string): Promise<string> {
  const secret = getSessionSecret();
  if (!secret) throw new Error("Session secret unavailable.");
  const encoded = encodeEmail(email);
  const expiry = Date.now() + SESSION_DURATION_MS;
  const expiryStr = String(expiry);
  const message = `${encoded}.${expiryStr}`;
  const signature = await sign(secret, message);
  return `${encoded}.${expiryStr}.${signature}`;
}

export type VerifiedSession = {
  email: string;
  expiry: number;
};

/**
 * `minIssuedAt` is the session epoch (see lib/session-epoch.ts). Tokens
 * whose implied issuedAt (`expiry - SESSION_DURATION_MS`) falls before it
 * are treated as expired, even if their signature still verifies.
 *
 * Pass `0` (the default) to skip the check.
 */
export async function verifySessionToken(
  token: string,
  minIssuedAt: number = 0
): Promise<VerifiedSession | null> {
  const secret = getSessionSecret();
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encoded, expiryStr, signature] = parts;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return null;
  if (minIssuedAt > 0) {
    const issuedAt = expiry - SESSION_DURATION_MS;
    if (issuedAt < minIssuedAt) return null;
  }
  const valid = await verify(secret, `${encoded}.${expiryStr}`, signature);
  if (!valid) return null;
  const email = decodeEmail(encoded);
  if (!email) return null;
  return { email, expiry };
}

/**
 * Stable short fingerprint of an email — base64url-encoded prefix of its
 * SHA-256. Used as the `user_hash` cookie so the client can scope its
 * IndexedDB without learning the user's email.
 */
export async function emailToUserHash(email: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(email.toLowerCase())
  );
  return base64urlFromBuffer(digest).slice(0, 22);
}
