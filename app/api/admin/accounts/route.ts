// /api/admin/accounts
//
//   GET → list every user (email, createdAt, isAdmin). Passwords are never
//         returned — only metadata the admin dashboard needs to render.
//
// Auth: the proxy admin gate already blocks non-admins on /api/admin/*, so
// no per-route isAdmin check is needed here.

import { isUserStoreConfigured, listUsers } from "@/app/lib/user-store";
import { isPasskeyStoreConfigured, listPasskeys } from "@/app/lib/passkey-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notConfigured() {
  return Response.json(
    { error: "Accounts unavailable — Redis isn't configured." },
    { status: 503 }
  );
}

export async function GET() {
  if (!isUserStoreConfigured()) return notConfigured();
  try {
    const users = await listUsers();
    // Enrich each row with a live passkey count so the admin can see who has
    // enrolled devices at a glance. Volume is human-scale (a handful of users),
    // so a parallel per-user read is cheap; skip entirely if Redis-for-passkeys
    // isn't wired up.
    const counts = isPasskeyStoreConfigured()
      ? await Promise.all(
          users.map((u) => listPasskeys(u.email).then((p) => p.length).catch(() => 0))
        )
      : users.map(() => 0);
    const enriched = users.map((u, i) => ({ ...u, passkeyCount: counts[i] }));
    return Response.json({ users: enriched });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to list users." },
      { status: 500 }
    );
  }
}
