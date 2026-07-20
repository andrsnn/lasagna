// Revoke an app share link. Owner-only: this path is NOT under the public
// `/api/share/` prefix, so the proxy session check gates it. Deleting the
// Redis pointer makes the public read route 410 immediately.

import { delShare, isShareStoreConfigured } from "@/app/lib/share-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

export async function POST(req: Request) {
  if (!isShareStoreConfigured()) {
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
    await delShare(token);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to revoke link." },
      { status: 500 }
    );
  }
}
