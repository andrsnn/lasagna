// /api/admin/invites
//
//   GET    → list every pending invite (token, createdBy, createdAt, expiresAt).
//   POST   → mint a fresh single-use 7-day invite. Returns { token, url, expiresAt }.
//   DELETE ?token=… → revoke a pending invite.
//
// Auth: protected by the proxy admin gate — /api/admin/* is 403 for
// non-admins before we even reach the handler, so no per-route isAdmin
// check is necessary here.

import {
  INVITE_TTL_SECONDS,
  createInvite,
  isUserStoreConfigured,
  listInvites,
  revokeInvite,
} from "@/app/lib/user-store";
import { getCurrentUserEmail } from "@/app/lib/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notConfigured() {
  return Response.json(
    { error: "Invites unavailable — Redis isn't configured." },
    { status: 503 }
  );
}

function buildInviteUrl(req: Request, token: string): string {
  // Prefer the forwarded origin headers Vercel sets behind its edge —
  // they reflect the public origin even when the function sees an
  // internal host. Fall back to request.url for local dev.
  const proto =
    req.headers.get("x-forwarded-proto") ??
    new URL(req.url).protocol.replace(":", "");
  const host =
    req.headers.get("x-forwarded-host") ??
    req.headers.get("host") ??
    new URL(req.url).host;
  return `${proto}://${host}/signup?invite=${encodeURIComponent(token)}`;
}

export async function GET() {
  if (!isUserStoreConfigured()) return notConfigured();
  try {
    const invites = await listInvites();
    return Response.json({ invites, ttlSeconds: INVITE_TTL_SECONDS });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to list invites." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  if (!isUserStoreConfigured()) return notConfigured();
  const email = await getCurrentUserEmail(req);
  if (!email) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const invite = await createInvite(email);
    return Response.json({
      token: invite.token,
      url: buildInviteUrl(req, invite.token),
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to create invite." },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  if (!isUserStoreConfigured()) return notConfigured();
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return Response.json({ error: "token query param required." }, { status: 400 });
  }
  try {
    await revokeInvite(token);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to revoke invite." },
      { status: 500 }
    );
  }
}
