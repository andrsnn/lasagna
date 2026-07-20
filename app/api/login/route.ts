// Email + password login.
//
//   - Looks up `user:{emailLower}` in Redis. If the record exists, verifies
//     the password against the stored PBKDF2 hash.
//   - If the record is missing AND the caller is the configured admin email
//     AND the password matches TEMP_PASS, lazily creates the admin record.
//     This is the only "magic" path; every other login is a normal hash
//     check. Lets a fresh deploy boot the admin without a separate
//     bootstrap command.
//
// Sets two cookies on success:
//   `auth`       — HttpOnly HMAC session token (see lib/auth.ts).
//   `user_hash`  — short non-HttpOnly fingerprint of the email so client
//                  code can scope its IndexedDB per user without learning
//                  the email itself.

import {
  ADMIN_USER_HASH,
  SESSION_COOKIE,
  SESSION_DURATION_MS,
  USER_HASH_COOKIE,
  createSessionToken,
  emailToUserHash,
  getAppPassword,
  getSessionSecret,
  timingSafeEqual,
} from "../../lib/auth";
import {
  createUser,
  getAdminEmail,
  getUserByEmail,
  isUserStoreConfigured,
  isValidEmail,
  normalizeEmail,
  verifyPassword,
} from "../../lib/user-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GENERIC_ERROR = "Invalid email or password.";

export async function POST(req: Request) {
  if (!getSessionSecret()) {
    return Response.json(
      { error: "Server is not configured. Set TEMP_PASS in project settings." },
      { status: 503 }
    );
  }
  if (!isUserStoreConfigured()) {
    return Response.json(
      {
        error:
          "Sign-in is unavailable — Redis isn't configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      },
      { status: 503 }
    );
  }

  let body: { email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const rawEmail = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!isValidEmail(rawEmail) || password.length === 0) {
    return Response.json({ error: GENERIC_ERROR }, { status: 401 });
  }
  const email = normalizeEmail(rawEmail);

  let user = await getUserByEmail(email);
  let ok = false;
  let isAdmin = false;

  if (user) {
    ok = await verifyPassword(password, user);
    isAdmin = user.isAdmin;
  } else {
    // Lazy admin bootstrap path. Only fires when the caller proves they
    // know TEMP_PASS *and* their email matches ADMIN_EMAIL — no other
    // shortcut to admin status exists.
    const adminEmail = getAdminEmail();
    const appPassword = getAppPassword();
    if (
      email === adminEmail &&
      appPassword &&
      timingSafeEqual(password, appPassword)
    ) {
      try {
        user = await createUser({ email, password, isAdmin: true });
        ok = true;
        isAdmin = true;
      } catch {
        // Race against another concurrent bootstrap — try one more verify
        // against whatever record just got created.
        const racedUser = await getUserByEmail(email);
        if (racedUser) {
          ok = await verifyPassword(password, racedUser);
          isAdmin = racedUser.isAdmin;
        }
      }
    }
  }

  if (!ok) {
    return Response.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  return issueSession({ email, isAdmin });
}

export async function issueSession({
  email,
  isAdmin,
}: {
  email: string;
  isAdmin: boolean;
}): Promise<Response> {
  const token = await createSessionToken(email);
  const userHash = isAdmin ? ADMIN_USER_HASH : await emailToUserHash(email);
  const maxAgeSeconds = Math.floor(SESSION_DURATION_MS / 1000);
  const isProd = process.env.NODE_ENV === "production";

  const authCookie = [
    `${SESSION_COOKIE}=${token}`,
    `Max-Age=${maxAgeSeconds}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isProd) authCookie.push("Secure");

  const hashCookie = [
    `${USER_HASH_COOKIE}=${userHash}`,
    `Max-Age=${maxAgeSeconds}`,
    "Path=/",
    "SameSite=Lax",
  ];
  if (isProd) hashCookie.push("Secure");

  // Set-Cookie is allowed multiple times via the Headers API — appending
  // each gives the browser both cookies in one response.
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", authCookie.join("; "));
  headers.append("Set-Cookie", hashCookie.join("; "));

  return new Response(JSON.stringify({ ok: true, email, isAdmin }), {
    status: 200,
    headers,
  });
}
