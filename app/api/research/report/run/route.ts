// Run ONE Multi Research report. Mirrors POST /api/research/structured/run —
// the handshake returns a streamId only; the client reads the finished report
// via GET /api/query/resume/{streamId} (same `result` event shape), so closing
// the tab mid-run is recoverable from any later mount.
//
// The one difference from structured/run: this calls the deep-research engine
// WITHOUT a schema, so it synthesizes a full MARKDOWN REPORT (findings + inline
// citations + a Sources list) instead of a records table. N of these run
// independently in parallel, one per drafted prompt.
//
// Stop is shared with structured research: POST /api/research/structured/stop/
// {streamId} sets the same per-stream flag this run polls via isStopRequested.

import { waitUntil } from "@vercel/functions";
import {
  appendEvent,
  enqueueResearchRunJob,
  isStreamStoreConfigured,
  saveResearchRunJob,
  setMeta,
  type ResearchRunJobPayload,
} from "@/app/lib/stream-store";
import { executeResearch } from "@/app/lib/executors";
import { isFlyWorkerConfigured, wakeWorker } from "@/app/lib/fly-wake";
import { captureException } from "@/app/lib/error-log";
import { isStopRequested, UserStoppedError } from "@/app/api/chat/stop-flag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Body = {
  prompt?: string;
  title?: string;
  depth?: "standard" | "deep";
  model?: string;
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return Response.json({ error: "prompt is required." }, { status: 400 });
  }
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
  try {
    await setMeta(streamId, { status: "running" });
  } catch (err) {
    console.warn(`[report-run ${streamId}] setMeta(running) failed`, err);
    return Response.json({ error: "Failed to initialize stream buffer." }, { status: 503 });
  }

  const depth = body.depth === "deep" ? "deep" : "standard";
  const model = typeof body.model === "string" && body.model ? body.model : undefined;

  // Preferred path: hand off to the Fly worker (1-hour budget + kill timer), so
  // a deep report that runs for many minutes actually finishes and writes its
  // result even after the user closes the tab / locks the phone. A bounded
  // Vercel function can't do that — it gets reclaimed mid-run and the result
  // never lands, leaving the card spinning forever. Mirrors structured/run.
  if (isFlyWorkerConfigured()) {
    const job: ResearchRunJobPayload = {
      v: 1,
      kind: "report",
      query: prompt,
      title: body.title,
      depth,
      model,
    };
    try {
      await saveResearchRunJob(streamId, job);
      await enqueueResearchRunJob(streamId);
    } catch (err) {
      console.warn(`[report-run ${streamId}] enqueue failed`, err);
      return Response.json({ error: "Failed to enqueue research job." }, { status: 503 });
    }
    void wakeWorker();
    return Response.json({ streamId }, { status: 202 });
  }

  // Fallback (no Fly configured, e.g. local dev): in-process producer bounded by
  // maxDuration. The generic resume endpoint recovers the result across a tab
  // close either way, but this path can't outlive the function's wall clock.
  waitUntil(
    (async () => {
      try {
        const outcome = await executeResearch({
          prompt,
          model,
          depth,
          onProgress: (stage) => {
            void appendEvent(streamId, { event: "progress", data: { stage, at: Date.now() } });
          },
          shouldStop: () => isStopRequested(streamId),
        });
        await appendEvent(streamId, {
          event: "result",
          data: { status: outcome.status, payload: outcome.payload },
        });
        await setMeta(streamId, {
          status: outcome.status >= 400 ? "error" : "complete",
          finishedAt: Date.now(),
          ...(outcome.status >= 400 && "error" in outcome.payload
            ? { error: outcome.payload.error }
            : {}),
        });
      } catch (err) {
        // User Stop is terminal but not a failure — write a clean stopped result
        // (the card already marked itself stopped) and skip exception logging.
        if (err instanceof UserStoppedError) {
          await appendEvent(streamId, {
            event: "result",
            data: { status: 499, payload: { error: "Stopped by user.", stopped: true } },
          });
          await setMeta(streamId, { status: "error", finishedAt: Date.now(), error: "Stopped by user." });
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        await appendEvent(streamId, {
          event: "result",
          data: { status: 500, payload: { error: msg } },
        });
        await setMeta(streamId, { status: "error", finishedAt: Date.now(), error: msg });
        await captureException(err, { source: "query", context: { streamId, kind: "report-run" } });
      }
    })()
  );

  return Response.json({ streamId }, { status: 202 });
}
