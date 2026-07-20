// Revoke a shared-note link. Owner-only (outside the public /api/share/
// prefix). Deletes the Redis row so the public read route 410s.

import {
  delNoteShare,
  isNoteShareStoreConfigured,
} from "@/app/lib/note-share-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

export async function POST(req: Request) {
  if (!isNoteShareStoreConfigured()) {
    return Response.json(
      { error: "Sharing is unavailable right now." },
      { status: 503 }
    );
  }
  let body: { token?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  if (!TOKEN_RE.test(token)) {
    return Response.json({ error: "Invalid token." }, { status: 400 });
  }
  try {
    await delNoteShare(token);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to revoke link." },
      { status: 500 }
    );
  }
}
