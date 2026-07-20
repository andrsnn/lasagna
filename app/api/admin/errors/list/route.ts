// GET /api/admin/errors/list — paginated list of recent error events for the
// /admin/errors dashboard.
//
// Query params:
//   limit  — page size, default 200, capped at 500.
//   before — ms epoch upper bound (exclusive). Pass the oldest `ts` you
//            already have to load older entries.
//   source — filter by ErrorSource (e.g. "schedule").
//   appId  — filter by originating artifact appId.

import {
  errorStats,
  isErrorLogConfigured,
  listErrors,
  type ErrorSource,
} from "@/app/lib/error-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_SOURCES: ReadonlySet<string> = new Set([
  "schedule",
  "query",
  "sweep",
  "chat",
  "proxy",
  "tool",
  "other",
]);

export async function GET(req: Request) {
  if (!isErrorLogConfigured()) {
    return Response.json(
      { error: "Error log unavailable — Redis is not configured." },
      { status: 503 }
    );
  }
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? 200);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 200;
  const beforeRaw = url.searchParams.get("before");
  const before = beforeRaw ? Number(beforeRaw) : undefined;
  const sourceParam = url.searchParams.get("source") ?? undefined;
  const source =
    sourceParam && VALID_SOURCES.has(sourceParam)
      ? (sourceParam as ErrorSource)
      : undefined;
  const appId = url.searchParams.get("appId") ?? undefined;

  const [list, stats] = await Promise.all([
    listErrors({
      limit,
      before: Number.isFinite(before) ? (before as number) : undefined,
      source,
      appId: appId || undefined,
    }),
    errorStats(),
  ]);

  return Response.json({ ...list, stats });
}
