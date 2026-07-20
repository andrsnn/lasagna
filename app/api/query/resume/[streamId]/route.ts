// Pick up the JSON result of a previously-issued /api/query call.
//
// Unlike chat resume (which replays an SSE stream), query is single-shot, so
// this endpoint just polls the KV bucket until the `result` event lands and
// returns it as JSON. If the original handler failed, the cached error
// payload comes back with the same shape POST /api/query would have returned.

import {
  getEvents,
  getMeta,
  isStreamStoreConfigured,
} from "@/app/lib/stream-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Query is single-shot: we just wait for the `result` event. Each poll cycle
// is 2 Upstash commands (getMeta + getEvents). 250ms is overkill — the
// underlying LLM call typically takes seconds; an extra second of wait on
// the tail is invisible. 1500ms cuts free-tier spend by ~6× per resume.
const POLL_INTERVAL_MS = Number(
  process.env.QUERY_RESUME_POLL_INTERVAL_MS ?? 1500
);
const MAX_WAIT_MS = 5 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CachedResult = {
  status: number;
  payload: Record<string, unknown>;
};

function findResultEvent(events: Awaited<ReturnType<typeof getEvents>>): CachedResult | null {
  for (const ev of events) {
    if (ev.event === "result" && ev.data && typeof ev.data === "object") {
      return ev.data as CachedResult;
    }
  }
  return null;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ streamId: string }> }
) {
  if (!isStreamStoreConfigured()) {
    return Response.json(
      {
        error:
          "Resumable streams are disabled — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      },
      { status: 503 }
    );
  }

  const { streamId } = await params;
  if (!streamId) {
    return Response.json({ error: "Missing streamId." }, { status: 400 });
  }

  const startedAt = Date.now();
  while (true) {
    const meta = await getMeta(streamId);
    const events = await getEvents(streamId, 0);

    if (!meta && events.length === 0) {
      return Response.json(
        { error: "Stream not found or expired.", streamId },
        { status: 404 }
      );
    }

    const result = findResultEvent(events);
    if (result) {
      return Response.json({ ...result.payload, streamId }, { status: result.status });
    }

    if (meta && meta.status === "error") {
      return Response.json(
        { error: meta.error ?? "Query failed.", streamId },
        { status: 500 }
      );
    }

    if (Date.now() - startedAt > MAX_WAIT_MS) {
      return Response.json(
        {
          error: "Resume window timed out — the upstream query is still running.",
          streamId,
        },
        { status: 504 }
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }
}
