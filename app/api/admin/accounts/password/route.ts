// /api/admin/accounts/password
//
//   POST { email, password } → rehash and overwrite the user's password.
//                              Returns { ok: true } or 404 if email missing.
//
// Auth: gated by the proxy admin check on /api/admin/*. The new password
// is hashed with PBKDF2-SHA256 + a fresh 16-byte salt (see user-store
// `hashPassword`) so this also bumps the work factor on legacy accounts.
//
// Note: this does NOT bump the session epoch — the target user keeps
// their existing browser session unless the admin separately runs the
// /admin/sessions "expire all" flow.

import {
  isUserStoreConfigured,
  isValidEmail,
  normalizeEmail,
  resetUserPassword,
} from "@/app/lib/user-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isUserStoreConfigured()) {
    return Response.json(
      { error: "Accounts unavailable — Redis isn't configured." },
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

  if (!isValidEmail(rawEmail)) {
    return Response.json(
      { error: "Please provide a valid email address." },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    return Response.json(
      { error: "Password must be at least 8 characters." },
      { status: 400 }
    );
  }

  try {
    const ok = await resetUserPassword(normalizeEmail(rawEmail), password);
    if (!ok) {
      return Response.json(
        { error: "No account found for that email." },
        { status: 404 }
      );
    }
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to reset password.",
      },
      { status: 500 }
    );
  }
}
