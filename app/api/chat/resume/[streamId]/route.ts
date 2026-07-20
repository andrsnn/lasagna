// Resume an in-flight or recently-finished chat stream from a cursor offset.
//
// Flow: when a client reconnects (e.g. user reopened the app after their
// phone slept), it calls GET /api/chat/resume/{streamId}?cursor=N. We replay
// every event recorded after `cursor` from Upstash Redis, then long-poll for
// new ones until status flips to `complete` or `error` (or until the stream
// key is evicted by TTL). The original POST /api/chat handler is the one
// keeping the LLM alive via waitUntil — this endpoint never starts new work.

import {
  appendEvents,
  getEventCount,
  getEvents,
  getMeta,
  getWorkerTraces,
  isStreamStoreConfigured,
  setMeta,
  summarizeWorkerTraces,
  MAX_WORKER_SEQ,
} from "@/app/lib/stream-store";
import { captureError } from "@/app/lib/error-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Each poll cycle costs 2 Upstash commands (getEvents + getMeta). At 200ms
// that's 600 cmd/min per active resumer — devastating on the free tier when
// a long chat sits in the resume tail. A 1s interval cuts that to 120 cmd/min
// while only adding ~800ms worst-case to the time-to-first-replayed-event,
// which is unnoticeable next to the SSE replay itself.
const POLL_INTERVAL_MS = Number(
  process.env.CHAT_RESUME_POLL_INTERVAL_MS ?? 1000
);
// Hard cap so a stuck stream can't hold a connection forever. The client will
// reconnect with the latest cursor and pick up where it left off.
const MAX_TAIL_MS = 5 * 60 * 1000;
// Vercel kills the POST /api/chat function at maxDuration (300s). If meta
// still says `running` past that plus a small teardown buffer, the producer's
// `finally` provably never ran — declare it dead and persist a terminal
// error so future resume opens short-circuit. We base liveness on producer
// start time (meta.createdAt) rather than silence between events: a single
// long tool call (e.g. web search) can legitimately go quiet for >90s while
// the worker is healthy, and an inter-event timeout falsely killed those.
const MAX_PRODUCER_LIFETIME_MS_VERCEL = 305 * 1000;
// Fly worker's hard kill (worker/index.ts:WORKER_KILL_AFTER_MS) defaults to
// 1h. A small buffer past that covers the gap between the kill timer firing
// and the worker writing the terminal `error` event into Redis; if even that
// fails, the next resume open will short-circuit on the persisted error.
// Without this longer ceiling, Fly-mode streams get falsely declared dead at
// 305s while the worker is still happily producing — and the user sees
// "upstream worker died" on a perfectly healthy run.
const MAX_PRODUCER_LIFETIME_MS_FLY = 65 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(
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

  const url = new URL(req.url);
  const cursorParam = url.searchParams.get("cursor");
  const cursor = Math.max(0, Number.parseInt(cursorParam ?? "0", 10) || 0);

  // 404 fast if neither the meta nor any events exist — TTL has elapsed or
  // the streamId is bogus. Parallelise the two probes since they're
  // independent — sequential awaits add a full Upstash round-trip to every
  // resume open, which is the most user-visible latency on retry.
  const [initialMeta, initialCount] = await Promise.all([
    getMeta(streamId),
    getEventCount(streamId),
  ]);
  if (!initialMeta && initialCount === 0) {
    return Response.json(
      { error: "Stream not found or expired.", streamId },
      { status: 404 }
    );
  }

  const encoder = new TextEncoder();
  const sse = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream({
    async start(controller) {
      const startedAt = Date.now();
      let nextCursor = cursor;
      let active = true;
      // The original POST emits `done` as its terminal event; if that event
      // made it into Redis we replay it as part of the normal loop and must
      // NOT also synthesize a second one. Without this guard the client sees
      // two `done` events back-to-back and the resume route breaks the
      // "exactly one terminal event" contract that other readers may rely on.
      let realDoneSeen = false;
      // Surface a lossy buffer to the user exactly once — they need to know
      // the recovered transcript is incomplete so they can resend.
      let warnedLossy = false;

      const safeEnqueue = (chunk: Uint8Array): boolean => {
        if (!active) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          active = false;
          return false;
        }
      };

      try {
        // iOS Safari buffers streaming response bodies until ~2KB accumulates.
        if (!safeEnqueue(encoder.encode(`: ${" ".repeat(2048)}\n\n`))) return;

        // Tell the client which id this connection is replaying — useful for
        // correlation if the resume request was issued speculatively.
        if (!safeEnqueue(sse("stream_id", { id: streamId, resumed: true }))) return;

        let lastWriteAt = Date.now();

        while (active) {
          // Pipeline events + meta — they're independent, and on a fresh
          // stream waiting for first-token we'd otherwise spend a full
          // Upstash round-trip per probe per cycle. With 200ms POLL_INTERVAL,
          // halving the network time per cycle is the difference between
          // ~250ms and ~400ms time-to-first-event on a cold resume.
          const [events, meta] = await Promise.all([
            getEvents(streamId, nextCursor),
            getMeta(streamId),
          ]);
          if (events.length > 0) {
            // Concatenate the whole drain into a single chunk so the client
            // reads it in one `reader.read()` and React can batch the
            // resulting state updates — replaying thousands of buffered
            // delta events as separate enqueues makes the catch-up pace
            // visually like the original stream.
            let payload = "";
            for (const ev of events) {
              if (ev.event === "done") realDoneSeen = true;
              payload += `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
            }
            if (!safeEnqueue(encoder.encode(payload))) return;
            nextCursor += events.length;
            lastWriteAt = Date.now();
          }

          const finished = meta && (meta.status === "complete" || meta.status === "error");

          // If the upstream marked the buffer lossy (some RPUSHes were dropped
          // after retries), tell the client before we close out — its
          // recovered message is missing events the live reader saw.
          if (meta?.kvLossy && !warnedLossy) {
            warnedLossy = true;
            safeEnqueue(
              sse("error", {
                message:
                  "Resume buffer lost some events — the recovered message may be incomplete. Try sending again.",
              })
            );
            lastWriteAt = Date.now();
          }

          if (finished && events.length === 0) {
            // Drained. Only synthesize `done` if the upstream didn't already
            // emit one (which would already have been replayed above).
            if (!realDoneSeen) safeEnqueue(sse("done", {}));
            break;
          }

          // Stale-producer detection: meta still says `running` and the
          // CURRENT producer started long enough ago that Vercel must have
          // already killed it at maxDuration before its `finally` could mark
          // meta `complete`. Fail this connection out fast, and persist a
          // terminal `error` event + meta so the user's next reopen-and-
          // reconnect attempt short-circuits instead of waiting again.
          // Without this the user spends N × MAX_TAIL_MS minutes watching a
          // "Thinking..." spinner that will never advance.
          //
          // We track the *current* worker's start time (workerStartedAt) —
          // a chained chat generation may run for ~15 minutes total across 3
          // sequential workers, but each individual worker is still bounded
          // by maxDuration. Falling back to `createdAt` covers legacy meta
          // written before chained workers existed; self-resolves within the
          // 6h Redis TTL.
          const workerStartedAt = meta?.workerStartedAt ?? meta?.createdAt;
          // Pick the ceiling per producer. Legacy meta written before the
          // `producer` field existed defaults to the Vercel ceiling — safer
          // than the Fly one because mis-applying the Fly cap to a stuck
          // Vercel function would hang the reader for an hour.
          const maxLifetimeMs =
            meta?.producer === "fly"
              ? MAX_PRODUCER_LIFETIME_MS_FLY
              : MAX_PRODUCER_LIFETIME_MS_VERCEL;
          if (
            meta?.status === "running" &&
            typeof workerStartedAt === "number" &&
            Date.now() - workerStartedAt > maxLifetimeMs
          ) {
            // Wording depends on the producer. Fly runs the whole job in one
            // worker bounded by the ~1h kill timer — there is no chain or
            // handoff to mention, so saying "died before handing off" would
            // be a lie. On Vercel, wording also depends on whether the chain
            // has slots left: the final worker (workerSeq === MAX_WORKER_SEQ)
            // means we used the full ~15-minute budget; otherwise an earlier
            // worker died without successfully handing off to the next one.
            const seq = meta.workerSeq ?? 1;
            const headline =
              meta.producer === "fly"
                ? "Generation stopped responding — the Fly worker exceeded its hard kill timer. Try sending again."
                : seq >= MAX_WORKER_SEQ
                ? "Generation stopped responding — exhausted the ~15-minute (3-worker) generation budget. Try sending again with a more specific prompt."
                : "Generation stopped responding — the upstream worker died before handing off to the next chunk. Try sending again.";
            // Read the per-worker chain trace so the user (and the admin
            // error log) see exactly what happened: which workers actually
            // ran, for how long, and whether the handoffs landed. Without
            // this, "exhausted the 15-minute budget" is unverifiable from
            // the client side — we want the proof inline.
            const traces = await getWorkerTraces(streamId);
            const summary = summarizeWorkerTraces(traces);
            // Inline form: chat UI renders error in a single inline span
            // where newlines collapse, so the user-facing message has to
            // fit on one (wrappable) line.
            const message = `${headline} Chain trace: ${summary.inline}.`;
            console.warn(
              `[chat ${streamId}] chain stale-declared seq=${seq} workerStartedAt=${workerStartedAt} timeSinceWorkerStartMs=${Date.now() - workerStartedAt} chainElapsedMs=${meta.createdAt != null ? Date.now() - meta.createdAt : "unknown"}\n${summary.multiline}`
            );
            // Persist to the admin error log so a developer staring at the
            // dashboard sees the same per-worker breakdown the user got.
            void captureError({
              source: "chat",
              message: headline,
              context: {
                streamId,
                chatId: meta.chatId,
                messageId: meta.messageId,
                workerSeq: seq,
                workerStartedAt,
                createdAt: meta.createdAt,
                timeSinceWorkerStartMs: Date.now() - workerStartedAt,
                chainElapsedMs:
                  meta.createdAt != null ? Date.now() - meta.createdAt : null,
                traceSummary: summary.multiline,
                traces,
              },
            });
            // Stale producer is recoverable by re-sending: the new POST gets
            // a fresh worker. Tag transient so the client auto-retries
            // instead of parking the message under a Retry button.
            try {
              await appendEvents(streamId, [
                {
                  event: "error",
                  data: {
                    message,
                    transient: true,
                    trace: summary.multiline,
                  },
                },
                { event: "done", data: {} },
              ]);
              await setMeta(streamId, {
                ...meta,
                status: "error",
                error: message,
                finishedAt: Date.now(),
              });
            } catch {
              // Best-effort persistence — even if the write fails, this
              // connection still emits the terminal pair below so the active
              // client recovers.
            }
            safeEnqueue(
              sse("error", {
                message,
                transient: true,
                trace: summary.multiline,
              })
            );
            if (!realDoneSeen) safeEnqueue(sse("done", {}));
            break;
          }

          if (Date.now() - startedAt > MAX_TAIL_MS) {
            // Soft cap. The client treats this as terminal (the error event
            // clears `streamId` on its side); the real upstream may still be
            // running and the user can retry by sending again.
            safeEnqueue(
              sse("error", {
                message:
                  "Resume window timed out. The original stream may still be running — try sending again.",
              })
            );
            if (!realDoneSeen) safeEnqueue(sse("done", {}));
            break;
          }

          // Heartbeat during quiet polling so iOS Safari doesn't stall the
          // connection while waiting for the next Redis event.
          if (Date.now() - lastWriteAt > 15000) {
            if (!safeEnqueue(encoder.encode(": keep-alive\n\n"))) return;
            lastWriteAt = Date.now();
          }

          await sleep(POLL_INTERVAL_MS);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Resume failed";
        safeEnqueue(sse("error", { message }));
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
