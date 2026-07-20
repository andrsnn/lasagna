// Server-side helper for reading the authenticated user out of a request.
//
// The middleware (proxy.ts) sets `x-user-email` on every request that
// passes its auth check, so most API routes can call `getCurrentUserEmail`
// for free. `getCurrentUser` round-trips to Redis to fetch the full
// StoredUser (for isAdmin checks etc.) — only call it when you need more
// than the email.

import { SESSION_COOKIE, verifySessionToken } from "./auth";
import { getSessionEpoch } from "./session-epoch";
import { getUserByEmail, type StoredUser } from "./user-store";

const USER_EMAIL_HEADER = "x-user-email";

/**
 * Reads the authenticated user's email — first from the middleware-injected
 * header, then by re-verifying the session cookie if the header is absent
 * (e.g. routes that bypass middleware via PUBLIC_PREFIXES but want to
 * detect an authenticated caller).
 */
export async function getCurrentUserEmail(req: Request): Promise<string | null> {
  const headerEmail = req.headers.get(USER_EMAIL_HEADER);
  if (headerEmail) return headerEmail.toLowerCase();

  const cookieHeader = req.headers.get("cookie") ?? "";
  const token = parseCookie(cookieHeader, SESSION_COOKIE);
  if (!token) return null;
  const epoch = await getSessionEpoch();
  const session = await verifySessionToken(token, epoch);
  return session?.email ?? null;
}

export async function getCurrentUser(req: Request): Promise<StoredUser | null> {
  const email = await getCurrentUserEmail(req);
  if (!email) return null;
  return getUserByEmail(email);
}

function parseCookie(header: string, name: string): string | null {
  if (!header) return null;
  const parts = header.split(";");
  for (const raw of parts) {
    const eq = raw.indexOf("=");
    if (eq < 0) continue;
    const key = raw.slice(0, eq).trim();
    if (key === name) return raw.slice(eq + 1).trim();
  }
  return null;
}
