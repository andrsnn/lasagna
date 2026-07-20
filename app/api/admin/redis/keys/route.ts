// SCAN-paginated key listing for the /admin/redis viewer.
//
// Query params:
//   cursor — SCAN cursor; "0" to start, opaque string returned on next page.
//   match  — glob pattern (e.g. "ollchat:stream:*"); defaults to "*".
//   count  — SCAN hint; we cap it server-side to keep responses bounded.

import {
  dbsize,
  describeKeys,
  isRedisConfigured,
  scanKeys,
} from "@/app/lib/redis-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_COUNT = 500;
const DEFAULT_COUNT = 200;

export async function GET(req: Request) {
  if (!isRedisConfigured()) {
    return Response.json(
      { error: "Redis is not configured for this deployment." },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor") ?? "0";
  const match = url.searchParams.get("match") || "*";
  const countParam = Number(url.searchParams.get("count") ?? DEFAULT_COUNT);
  const count = Math.min(
    MAX_COUNT,
    Math.max(1, Number.isFinite(countParam) ? countParam : DEFAULT_COUNT)
  );

  try {
    const [{ cursor: nextCursor, keys }, total] = await Promise.all([
      scanKeys(cursor, match, count),
      dbsize().catch(() => -1),
    ]);
    const infos = await describeKeys(keys);
    return Response.json({
      cursor: nextCursor,
      done: nextCursor === "0",
      keys: infos,
      total,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Redis scan failed." },
      { status: 500 }
    );
  }
}
