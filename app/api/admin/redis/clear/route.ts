// Bulk-clear keys from Redis.
//
// POST body:
//   { pattern: string }
//
// If `pattern` is "*" we issue a single FLUSHDB — much cheaper than
// SCAN+UNLINK and necessary when the Upstash request budget is already
// exhausted. Anything narrower goes through SCAN+UNLINK in batches.

import { deleteByPattern, flushDb, isRedisConfigured } from "@/app/lib/redis-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isRedisConfigured()) {
    return Response.json(
      { error: "Redis is not configured for this deployment." },
      { status: 503 }
    );
  }

  let body: { pattern?: unknown };
  try {
    body = (await req.json()) as { pattern?: unknown };
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const pattern = typeof body.pattern === "string" ? body.pattern.trim() : "";
  if (!pattern) {
    return Response.json({ error: "Missing `pattern`." }, { status: 400 });
  }

  try {
    if (pattern === "*") {
      await flushDb();
      return Response.json({ ok: true, mode: "flushdb" });
    }
    const result = await deleteByPattern(pattern);
    return Response.json({ ok: true, mode: "scan", ...result });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Clear failed." },
      { status: 500 }
    );
  }
}
