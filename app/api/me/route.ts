// /api/me — the current user's identity for the client.
//
// The proxy middleware injects `x-user-email` on every authenticated request,
// but the browser never sees the user record, so client UI can't tell whether
// the signed-in user is an admin. This endpoint round-trips to the user store
// and returns the safe summary the client needs (email + isAdmin) so admin-only
// affordances (e.g. the "Open admin dashboard" shortcut in Preferences → Debug)
// can render conditionally. Never leaks the password hash or salt.
//
// Admin resolution mirrors the proxy gate (proxy.ts): the configured
// ADMIN_EMAIL is treated as admin even before its user record is bootstrapped,
// so the admin isn't locked out on their very first visit.

import { getCurrentUserEmail } from "@/app/lib/current-user";
import { getAdminEmail, getUserByEmail } from "@/app/lib/user-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const email = await getCurrentUserEmail(req);
  if (!email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await getUserByEmail(email).catch(() => null);
  const isAdmin = user?.isAdmin === true || email === getAdminEmail();
  return Response.json({ email, isAdmin });
}
