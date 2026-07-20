// POST /api/research/framing — handshake-only. Mirrors the /api/query
// pattern: validate the body, kick off `runResearchFraming` in a waitUntil
// background producer, and return `{streamId}` 202. The client reads the
// final JSON via GET /api/research/framing/resume/{streamId}, so a phone
// going to sleep mid-flight (the iOS Safari "Load failed" case) no longer
// kills the framer — the work survives on the server and the client
// reconnects to pick up the result.
//
// The framer LLM tool loop lives in ./work.ts; this file only handles input
// validation, streamId allocation, and the result-event mirror.

import { waitUntil } from "@vercel/functions";
import {
  appendEvent,
  enqueueResearchFramingJob,
  isStreamStoreConfigured,
  saveResearchFramingJob,
  setMeta,
} from "@/app/lib/stream-store";
import { isFlyWorkerConfigured, wakeWorker } from "@/app/lib/fly-wake";
import {
  runResearchFraming,
  type ResearchFramerTurn,
} from "./work";
import type { FramerWorkOutcome } from "@/app/lib/framing/work-output";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type IncomingBody = {
  messages?: ResearchFramerTurn[];
  /** Model id for the framer call. Caller (chat.tsx) sends the active chat
   *  model so framing inherits the user's existing model preferences and
   *  RunPod routing. */
  framerModel?: string;
  runpodEndpointId?: string;
};

export async function POST(req: Request) {
  const fwdHost =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const fwdProto =
    req.headers.get("x-forwarded-proto") ??
    (fwdHost && /^(localhost|127\.|0\.0\.0\.0)/.test(fwdHost) ? "http" : "https");
  const publicOrigin = fwdHost
    ? `${fwdProto}://${fwdHost}`
    : new URL(req.url).origin;

  let body: IncomingBody;
  try {
    body = (await req.json()) as IncomingBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return Response.json(
      { error: "messages must be a non-empty array." },
      { status: 400 }
    );
  }
  const framerModel =
    typeof body.framerModel === "string" && body.framerModel.trim()
      ? body.framerModel.trim()
      : null;
  if (!framerModel) {
    return Response.json(
      { error: "framerModel must be a non-empty string." },
      { status: 400 }
    );
  }
  const runpodEndpointId =
    typeof body.runpodEndpointId === "string" && body.runpodEndpointId.trim()
      ? body.runpodEndpointId.trim()
      : undefined;

  // Strip system messages — the framer brings its own. Preserve attached
  // images / PDFs on the surviving turns so we can inline their content into
  // the transcript before the framer sees it.
  const turns = messages.filter((m) => m.role !== "system");
  if (turns.length === 0) {
    return Response.json(
      { error: "messages contained no user or assistant turns." },
      { status: 400 }
    );
  }

  // Producer is Redis-only — without it the client has nowhere to read the
  // result back if its in-flight POST gets cancelled (the original bug).
  if (!isStreamStoreConfigured()) {
    return Response.json(
      {
        error:
          "Resumable streams are disabled — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      },
      { status: 503 }
    );
  }

  const streamId = crypto.randomUUID();

  // Prefer the Fly worker when it's configured: framing is meant to be quick,
  // but a wedged provider / web_fetch call can outrun the 120s Vercel cap and
  // strand the stream. On the worker there's no per-request wall clock and a
  // kill timer is a real backstop. Tag `producer: "fly"` up front so the
  // resume route applies the Fly stale-ceiling (minutes) instead of the
  // Vercel one (~150s) from the very first poll.
  const useFly = isFlyWorkerConfigured();

  // Mark the stream running BEFORE returning so a client that hits the
  // resume endpoint immediately doesn't race the early-404 check.
  try {
    await setMeta(streamId, {
      status: "running",
      createdAt: Date.now(),
      ...(useFly ? { producer: "fly" as const } : {}),
    });
  } catch (err) {
    console.warn(`[research-framing ${streamId}] setMeta(running) failed`, err);
    return Response.json(
      { error: "Failed to initialize stream buffer." },
      { status: 503 }
    );
  }

  if (useFly) {
    // Persist the job + enqueue, then wake the worker. The worker writes the
    // same `result` event the waitUntil branch does, so the client's resume
    // path is identical. Survives the phone going to sleep with no Vercel
    // wall clock hanging over the framer.
    try {
      await saveResearchFramingJob(streamId, {
        v: 1,
        turns,
        framerModel,
        ...(runpodEndpointId ? { runpodEndpointId } : {}),
        publicOrigin,
      });
      await enqueueResearchFramingJob(streamId);
    } catch (err) {
      console.warn(`[research-framing ${streamId}] enqueue failed`, err);
      return Response.json(
        { error: "Failed to enqueue framing job." },
        { status: 503 }
      );
    }
    void wakeWorker();
    return Response.json({ streamId }, { status: 202 });
  }

  // Fallback (no Fly worker — local dev / unconfigured): in-process producer.
  // waitUntil keeps the function alive on Vercel until `runResearchFraming`
  // resolves (bounded by maxDuration).
  waitUntil(
    (async () => {
      let outcome: FramerWorkOutcome;
      try {
        outcome = await runResearchFraming({
          turns,
          framerModel,
          runpodEndpointId,
          publicOrigin,
          // Mirror live reasoning / progress into the events list so the resume
          // endpoint can stream it to the framing card. Best-effort: a Redis
          // hiccup on a progress append must never fail the framer.
          onEvent: async (ev) => {
            try {
              await appendEvent(streamId, ev);
            } catch {
              /* progress is diagnostic — drop on failure */
            }
          },
        });
      } catch (err) {
        outcome = {
          status: 500,
          payload: {
            error: err instanceof Error ? err.message : "Framer failed",
          },
        };
      }
      try {
        await appendEvent(streamId, { event: "result", data: outcome });
        const ok = outcome.status >= 200 && outcome.status < 300;
        await setMeta(streamId, {
          status: ok ? "complete" : "error",
          finishedAt: Date.now(),
          error: ok ? undefined : (outcome.payload as { error?: string }).error,
        });
      } catch (err) {
        console.warn(`[research-framing ${streamId}] KV mirror failed`, err);
      }
    })()
  );

  return Response.json({ streamId }, { status: 202 });
}
