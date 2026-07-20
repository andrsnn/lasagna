// Read or delete a single key. The `?key=` param is the literal Redis key.

import { deleteKey, isRedisConfigured, readKey } from "@/app/lib/redis-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isRedisConfigured()) {
    return Response.json(
      { error: "Redis is not configured for this deployment." },
      { status: 503 }
    );
  }
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (!key) {
    return Response.json({ error: "Missing `key` query param." }, { status: 400 });
  }
  try {
    const value = await readKey(key);
    return Response.json(value);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Read failed." },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  if (!isRedisConfigured()) {
    return Response.json(
      { error: "Redis is not configured for this deployment." },
      { status: 503 }
    );
  }
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (!key) {
    return Response.json({ error: "Missing `key` query param." }, { status: 400 });
  }
  try {
    const removed = await deleteKey(key);
    return Response.json({ ok: true, removed });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Delete failed." },
      { status: 500 }
    );
  }
}
