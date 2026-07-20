// Lightweight, non-blocking progress read for an in-flight Structured-research
// run. The viewer polls this every few seconds for a liveness signal while the
// resumable result long-poll (GET /api/query/resume) waits for the final
// payload. Returns the most recent `progress` event's stage, or null.

import { getEvents, getMeta, isStreamStoreConfigured } from "@/app/lib/stream-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ streamId: string }> }
) {
  if (!isStreamStoreConfigured()) {
    return Response.json({ stage: null }, { status: 200 });
  }
  const { streamId } = await params;
  if (!streamId) return Response.json({ error: "Missing streamId." }, { status: 400 });

  const [events, meta] = await Promise.all([getEvents(streamId, 0), getMeta(streamId)]);
  let stage: string | null = null;
  let at: number | null = null;
  for (const ev of events) {
    if (ev.event === "progress" && ev.data && typeof ev.data === "object") {
      const d = ev.data as { stage?: unknown; at?: unknown };
      if (typeof d.stage === "string") {
        stage = d.stage;
        at = typeof d.at === "number" ? d.at : null;
      }
    }
  }
  return Response.json(
    { stage, at, status: meta?.status ?? null },
    { status: 200 }
  );
}
