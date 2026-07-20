// Generic long-poll for a Redis-backed single-result stream. Used by every
// non-streaming long-running LLM endpoint (research framer, council framer,
// novel-outline). Each producer:
//
//   1. validates input, allocates `crypto.randomUUID()` as streamId
//   2. calls `setMeta(streamId, {status: "running"})`
//   3. kicks the actual work into `waitUntil(...)` so the lambda survives the
//      client disconnect
//   4. on completion writes a single `{event: "result", data: {status, payload}}`
//      and flips meta to "complete" / "error"
//
// This helper polls the Redis bucket until the `result` event lands and
// returns its payload with the work function's HTTP status code. A tab
// close / phone sleep mid-call is recoverable: the client just re-opens
// this endpoint with the same streamId and picks up where it left off.
//
// Originally factored out of /api/query/resume — the framing and outline
// endpoints inherit the same shape since they're all "single LLM call,
// optional tool loop, single JSON payload".

import {
  getEvents,
  getMeta,
  isStreamStoreConfigured,
  type SseEvent,
} from "@/app/lib/stream-store";

// Each poll cycle costs 2 Upstash commands (getMeta + getEvents). The
// callers run ~40–90s worst-case, so polling every 1500ms (~60 cmd/min per
// active resumer) is fine on the free tier while keeping time-to-first-
// result well under a second once the work finishes.
const POLL_INTERVAL_MS = Number(
  process.env.SINGLE_RESULT_RESUME_POLL_INTERVAL_MS ?? 1500
);
// Hard cap; bounded by the producer's own maxDuration. Anything past 5min
// is definitely dead.
const MAX_WAIT_MS = 5 * 60 * 1000;

// Stale-producer ceiling. Single-result producers (research framer, council
// framer, novel outline) run either in a Vercel `waitUntil` background task
// bounded by their route's `maxDuration` (120s today), or — when the Fly
// worker is configured — on the worker, bounded only by its per-job kill
// timer. If the producer is killed before its `finally` writes the `result`
// event + flips meta to complete/error, the stream is stranded at
// status="running" with no result for the full Redis TTL. Without the check
// below the resume endpoint returns 504 ("still running") forever and the
// client — which treats 504 as "reopen the poll" — spins on a dead producer
// indefinitely (the "Working…" / "Framing the question…" card that never
// advances). Once a running stream is older than the producer's max possible
// lifetime, the producer must have been killed: declare it dead so the caller
// resolves to its "run as-is" fallback instead of looping.
//
// The ceiling depends on where the producer ran (meta.producer). 305s mirrors
// the streaming chat resume route's MAX_PRODUCER_LIFETIME_MS_VERCEL —
// comfortably above the 120s Vercel cap. The Fly default is generous (matches
// the chat resume's Fly ceiling) so a slow-but-healthy worker job is never
// falsely declared dead; callers whose Fly producer has a tighter kill timer
// pass a smaller value for faster recovery.
const DEFAULT_MAX_PRODUCER_LIFETIME_MS_VERCEL = 305 * 1000;
const DEFAULT_MAX_PRODUCER_LIFETIME_MS_FLY = 65 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cursor-poll cadence for the streaming variant. Tighter than the single-
// result poll because the caller wants reasoning deltas to land promptly; we
// still return early the moment any new event appears, so this only governs
// the idle gap between flushes.
const STREAM_POLL_INTERVAL_MS = Number(
  process.env.SINGLE_RESULT_STREAM_POLL_INTERVAL_MS ?? 700
);
// How long one streaming poll holds the connection open waiting for the next
// event before returning an empty "still running" tick the client re-polls.
// Bounded well under the Vercel/Fly route maxDuration so the function returns
// cleanly rather than being killed mid-poll.
const STREAM_MAX_WAIT_MS = 25 * 1000;

type CachedResult = {
  status: number;
  payload: Record<string, unknown>;
};

function findResultEvent(
  events: Awaited<ReturnType<typeof getEvents>>
): CachedResult | null {
  for (const ev of events) {
    if (ev.event === "result" && ev.data && typeof ev.data === "object") {
      return ev.data as CachedResult;
    }
  }
  return null;
}

/** Long-poll the Redis bucket until the producer writes its `result` event,
 *  then return the cached payload with the producer's status code. Surface
 *  404 when neither meta nor events exist (TTL elapsed or bogus streamId)
 *  and 503 when Redis isn't configured. */
export async function resumeSingleResultStream(
  streamId: string | undefined,
  opts?: {
    /** Max wall-clock a Vercel `waitUntil` producer can live before it's
     *  provably dead (its route's `maxDuration` plus platform slack).
     *  Defaults to the ceiling shared with the streaming chat resume route. */
    maxProducerLifetimeMsVercel?: number;
    /** Max wall-clock a Fly-worker producer can live before it's provably
     *  dead (its per-job kill timer plus slack). Only consulted when
     *  meta.producer === "fly". */
    maxProducerLifetimeMsFly?: number;
  }
): Promise<Response> {
  const maxProducerLifetimeMsVercel =
    opts?.maxProducerLifetimeMsVercel ?? DEFAULT_MAX_PRODUCER_LIFETIME_MS_VERCEL;
  const maxProducerLifetimeMsFly =
    opts?.maxProducerLifetimeMsFly ?? DEFAULT_MAX_PRODUCER_LIFETIME_MS_FLY;
  if (!isStreamStoreConfigured()) {
    return Response.json(
      {
        error:
          "Resumable streams are disabled — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      },
      { status: 503 }
    );
  }

  if (!streamId) {
    return Response.json({ error: "Missing streamId." }, { status: 400 });
  }

  const startedAt = Date.now();
  while (true) {
    const [meta, events] = await Promise.all([
      getMeta(streamId),
      getEvents(streamId, 0),
    ]);

    if (!meta && events.length === 0) {
      return Response.json(
        { error: "Stream not found or expired.", streamId },
        { status: 404 }
      );
    }

    const result = findResultEvent(events);
    if (result) {
      return Response.json(
        { ...result.payload, streamId },
        { status: result.status }
      );
    }

    if (meta && meta.status === "error") {
      return Response.json(
        { error: meta.error ?? "Upstream work failed.", streamId },
        { status: 500 }
      );
    }

    // Stale-producer detection: the stream still says `running` but the
    // producer started long enough ago that its host (Vercel function or Fly
    // worker) must have killed it before it could write its `result` event.
    // Returning a terminal 500 (rather than looping to the 504 the client
    // retries on) lets the caller fall back to its "run as-is" path instead of
    // spinning forever on a dead background task. The ceiling tracks where the
    // producer ran: a Fly job has no per-request wall clock and lives far
    // longer than the 120s Vercel cap. `workerStartedAt` (the Fly worker's
    // actual start) is preferred over `createdAt` (enqueue time) when present.
    const producerStartedAt = meta?.workerStartedAt ?? meta?.createdAt;
    const maxProducerLifetimeMs =
      meta?.producer === "fly"
        ? maxProducerLifetimeMsFly
        : maxProducerLifetimeMsVercel;
    if (
      meta &&
      meta.status === "running" &&
      typeof producerStartedAt === "number" &&
      Date.now() - producerStartedAt > maxProducerLifetimeMs
    ) {
      return Response.json(
        {
          error:
            "The background task stopped responding before it finished — its server function timed out.",
          streamId,
        },
        { status: 500 }
      );
    }

    if (Date.now() - startedAt > MAX_WAIT_MS) {
      return Response.json(
        {
          error:
            "Resume window timed out — the upstream work is still running.",
          streamId,
        },
        { status: 504 }
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Streaming-aware resume for single-result producers that ALSO emit live
 * progress / `thinking` events into the same Redis events list (the framers
 * do this so the card can render the framer reasoning as it happens).
 *
 * Returns incremental progress events from `cursor` onward, plus the terminal
 * result once it lands. The client polls with the returned `nextCursor` until
 * `done` is true.
 *
 * Response body:
 *   { events: SseEvent[], nextCursor: number, done: boolean,
 *     result?: object, resultStatus?: number, streamId, kvLossy? }
 *
 * Distinct from resumeSingleResultStream (which waits for the single result
 * and returns nothing in the meantime) so the spinner-with-no-signal case is
 * replaced by the framer's actual reasoning. Stale-producer detection mirrors
 * the single-result path: a producer that outlives its host ceiling resolves
 * to a terminal 500 result so the card falls back to "run as-is" instead of
 * polling a dead task forever.
 */
export async function resumeEventStream(
  streamId: string | undefined,
  cursor: number,
  opts?: {
    maxProducerLifetimeMsVercel?: number;
    maxProducerLifetimeMsFly?: number;
  }
): Promise<Response> {
  const maxProducerLifetimeMsVercel =
    opts?.maxProducerLifetimeMsVercel ?? DEFAULT_MAX_PRODUCER_LIFETIME_MS_VERCEL;
  const maxProducerLifetimeMsFly =
    opts?.maxProducerLifetimeMsFly ?? DEFAULT_MAX_PRODUCER_LIFETIME_MS_FLY;

  if (!isStreamStoreConfigured()) {
    return Response.json(
      {
        error:
          "Resumable streams are disabled — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      },
      { status: 503 }
    );
  }
  if (!streamId) {
    return Response.json({ error: "Missing streamId." }, { status: 400 });
  }
  const from = Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) : 0;

  const startedAt = Date.now();
  while (true) {
    const [meta, tail] = await Promise.all([
      getMeta(streamId),
      getEvents(streamId, from),
    ]);

    if (!meta && from === 0 && tail.length === 0) {
      return Response.json(
        { error: "Stream not found or expired.", streamId },
        { status: 404 }
      );
    }

    // Split the tail at the terminal `result` event: everything before it is
    // live progress the client renders; the result itself terminates the poll.
    const progress: SseEvent[] = [];
    let result: CachedResult | null = null;
    for (const ev of tail) {
      if (ev.event === "result" && ev.data && typeof ev.data === "object") {
        result = ev.data as CachedResult;
        break;
      }
      progress.push(ev);
    }

    if (result) {
      return Response.json(
        {
          events: progress,
          nextCursor: from + progress.length,
          done: true,
          result: result.payload,
          resultStatus: result.status,
          streamId,
        },
        { status: 200 }
      );
    }

    if (progress.length > 0) {
      // New reasoning/progress to show — return immediately; the client
      // re-polls from nextCursor for the rest.
      return Response.json(
        {
          events: progress,
          nextCursor: from + progress.length,
          done: false,
          streamId,
        },
        { status: 200 }
      );
    }

    if (meta && meta.status === "error") {
      return Response.json(
        {
          events: [],
          nextCursor: from,
          done: true,
          result: { error: meta.error ?? "Upstream work failed." },
          resultStatus: 500,
          streamId,
        },
        { status: 200 }
      );
    }

    // Stale-producer detection — same ceiling logic as the single-result path.
    const producerStartedAt = meta?.workerStartedAt ?? meta?.createdAt;
    const maxProducerLifetimeMs =
      meta?.producer === "fly"
        ? maxProducerLifetimeMsFly
        : maxProducerLifetimeMsVercel;
    if (
      meta &&
      meta.status === "running" &&
      typeof producerStartedAt === "number" &&
      Date.now() - producerStartedAt > maxProducerLifetimeMs
    ) {
      return Response.json(
        {
          events: [],
          nextCursor: from,
          done: true,
          result: {
            error:
              "The background task stopped responding before it finished — its server function timed out.",
          },
          resultStatus: 500,
          streamId,
        },
        { status: 200 }
      );
    }

    if (Date.now() - startedAt > STREAM_MAX_WAIT_MS) {
      // Idle tick — no new events this window. Client re-polls from the same
      // cursor. 200 (not 504) so the streaming consumer stays on one code path.
      return Response.json(
        { events: [], nextCursor: from, done: false, streamId },
        { status: 200 }
      );
    }

    await sleep(STREAM_POLL_INTERVAL_MS);
  }
}
