// Sign-up via a valid invite token.
//
// Sequence:
//   1. Validate body shape (token, email, password).
//   2. Atomically GETDEL the invite token. If absent → 400.
//   3. Reject if an account already exists for the email; restore the
//      invite so the user can retry with a different address.
//   4. Create the user (non-admin), then issue a session cookie.
//   5. On any failure between (2) and (4), restore the invite so the link
//      stays usable.

import {
  consumeInvite,
  createUser,
  getUserByEmail,
  isUserStoreConfigured,
  isValidEmail,
  normalizeEmail,
  restoreInvite,
} from "@/app/lib/user-store";
import { getSessionSecret } from "@/app/lib/auth";
import { issueSession } from "../login/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!getSessionSecret()) {
    return Response.json(
      { error: "Server is not configured." },
      { status: 503 }
    );
  }
  if (!isUserStoreConfigured()) {
    return Response.json(
      { error: "Sign-up is unavailable — Redis isn't configured." },
      { status: 503 }
    );
  }

  let body: { token?: unknown; email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  const rawEmail = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!token) {
    return Response.json({ error: "Missing invite token." }, { status: 400 });
  }
  if (!isValidEmail(rawEmail)) {
    return Response.json(
      { error: "Please enter a valid email address." },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    return Response.json(
      { error: "Password must be at least 8 characters." },
      { status: 400 }
    );
  }

  const email = normalizeEmail(rawEmail);
  const invite = await consumeInvite(token);
  if (!invite) {
    return Response.json(
      { error: "This invite link is invalid or has already been used." },
      { status: 400 }
    );
  }

  try {
    const existing = await getUserByEmail(email);
    if (existing) {
      await restoreInvite(token, invite);
      return Response.json(
        { error: "An account with that email already exists." },
        { status: 409 }
      );
    }
    await createUser({ email, password, isAdmin: false });
  } catch (err) {
    // Hand the token back so the user (or the admin) doesn't have to
    // generate a fresh one after a transient failure.
    await restoreInvite(token, invite).catch(() => {});
    return Response.json(
      {
        error:
          err instanceof Error ? err.message : "Could not create your account.",
      },
      { status: 500 }
    );
  }

  return issueSession({ email, isAdmin: false });
}
