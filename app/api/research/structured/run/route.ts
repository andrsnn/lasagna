// Kick off one chat "Structured research" run. Mirrors POST /api/query: the
// handshake returns a streamId only; the client reads the {columns, schema,
// records} result via GET /api/query/resume/{streamId} (same `result` event
// shape), so a tab close mid-run is recoverable from any later mount.
//
// The work runs on the Fly worker when configured (research takes minutes,
// beyond a Vercel function's wall clock); otherwise it falls back to an
// in-process waitUntil producer for shorter runs / local dev.

import { waitUntil } from "@vercel/functions";
import {
  appendEvent,
  enqueueResearchRunJob,
  isStreamStoreConfigured,
  saveResearchRunJob,
  setMeta,
} from "@/app/lib/stream-store";
import { runStructuredResearch } from "@/app/lib/structured-research";
import { isFlyWorkerConfigured, wakeWorker } from "@/app/lib/fly-wake";
import { captureException } from "@/app/lib/error-log";
import { isStopRequested, UserStoppedError } from "@/app/api/chat/stop-flag";
import type { ResearchColumn, ResearchRecord } from "@/app/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Body = {
  query?: string;
  columns?: ResearchColumn[];
  idKeys?: string[];
  priorRecords?: ResearchRecord[];
  model?: string;
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return Response.json({ error: "query is required." }, { status: 400 });
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
    console.warn(`[research-run ${streamId}] setMeta(running) failed`, err);
    return Response.json({ error: "Failed to initialize stream buffer." }, { status: 503 });
  }

  const job = {
    v: 1 as const,
    query,
    columns: body.columns,
    idKeys: body.idKeys,
    priorRecords: body.priorRecords,
    model: body.model,
  };

  if (isFlyWorkerConfigured()) {
    try {
      await saveResearchRunJob(streamId, job);
      await enqueueResearchRunJob(streamId);
    } catch (err) {
      console.warn(`[research-run ${streamId}] enqueue failed`, err);
      return Response.json({ error: "Failed to enqueue research job." }, { status: 503 });
    }
    void wakeWorker();
    return Response.json({ streamId }, { status: 202 });
  }

  // Fallback: in-process producer (no Fly). Bounded by maxDuration.
  waitUntil(
    (async () => {
      try {
        const result = await runStructuredResearch({
          ...job,
          onProgress: (stage) => {
            void appendEvent(streamId, { event: "progress", data: { stage, at: Date.now() } });
          },
          shouldStop: () => isStopRequested(streamId),
        });
        await appendEvent(streamId, {
          event: "result",
          data: { status: 200, payload: result },
        });
        await setMeta(streamId, { status: "complete", finishedAt: Date.now() });
      } catch (err) {
        // User Stop: terminal, but not a failure — write a clean stopped result
        // (the viewer already marked itself stopped) and skip exception logging.
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
        await captureException(err, { source: "query", context: { streamId, kind: "research-run" } });
      }
    })()
  );

  return Response.json({ streamId }, { status: 202 });
}
