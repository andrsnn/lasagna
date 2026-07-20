// POST /api/admin/errors/clear — drops every retained error event. Used by
// the /admin/errors dashboard's "Clear all" button. Same auth posture as the
// other admin routes — gate at the gateway/CDN layer.

import { clearErrors, isErrorLogConfigured } from "@/app/lib/error-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  if (!isErrorLogConfigured()) {
    return Response.json(
      { error: "Error log unavailable — Redis is not configured." },
      { status: 503 }
    );
  }
  await clearErrors();
  return Response.json({ ok: true });
}
