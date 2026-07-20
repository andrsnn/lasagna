// Queue a follow-up user message into an in-flight chat stream.
//
// Flow: the user types a second message while the assistant is still
// streaming. The client POSTs here fire-and-forget; we push the message
// into a Redis list keyed by streamId. The chat worker (app/api/chat/work.ts)
// drains this list between turns and emits user_turn / assistant_turn SSE
// events into the same Redis stream the client is already reading — so the
// frontend's existing resume connection just keeps receiving events.
//
// Returns 410 Gone if the stream has already terminated; the client falls
// back to a normal POST /api/chat in that case.

import {
  appendQueuedMessage,
  clearQueue,
  getMeta,
  isStreamStoreConfigured,
  type QueuedUserMsg,
} from "@/app/lib/stream-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type QueueBody = {
  id?: unknown;
  content?: unknown;
  images?: unknown;
  pdfs?: unknown;
  csvs?: unknown;
};

export async function POST(
  req: Request,
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
  if (!streamId || typeof streamId !== "string") {
    return Response.json({ error: "Missing streamId." }, { status: 400 });
  }

  let body: QueueBody;
  try {
    body = (await req.json()) as QueueBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const id =
    typeof body.id === "string" && body.id.length > 0
      ? body.id
      : crypto.randomUUID();
  const content = typeof body.content === "string" ? body.content : "";
  const images = Array.isArray(body.images)
    ? (body.images as QueuedUserMsg["images"])
    : undefined;
  const pdfs = Array.isArray(body.pdfs)
    ? (body.pdfs as QueuedUserMsg["pdfs"])
    : undefined;
  const csvs = Array.isArray(body.csvs)
    ? (body.csvs as QueuedUserMsg["csvs"])
    : undefined;

  if (!content.trim() && !images?.length && !pdfs?.length && !csvs?.length) {
    return Response.json(
      { error: "Queued message must have content or attachments." },
      { status: 400 }
    );
  }

  // Reject early if the stream has already terminated. The client falls back
  // to a normal POST /api/chat when it sees 410, so the user's message still
  // gets through — it just becomes a fresh turn instead of a queued one.
  const meta = await getMeta(streamId);
  if (!meta) {
    return Response.json(
      { error: "Stream not found or expired.", streamId },
      { status: 404 }
    );
  }
  if (meta.status !== "running") {
    // Make sure no orphaned queue entries linger after a finished stream.
    await clearQueue(streamId);
    return Response.json(
      { error: "Stream has already finished.", streamId },
      { status: 410 }
    );
  }

  const entry: QueuedUserMsg = {
    id,
    content,
    images: images?.length ? images : undefined,
    pdfs: pdfs?.length ? pdfs : undefined,
    csvs: csvs?.length ? csvs : undefined,
    createdAt: Date.now(),
  };

  try {
    await appendQueuedMessage(streamId, entry);
  } catch (err) {
    console.warn(`[chat-queue ${streamId}] append failed`, err);
    return Response.json(
      { error: "Failed to enqueue message." },
      { status: 503 }
    );
  }

  return Response.json({ queued: true, id }, { status: 202 });
}
