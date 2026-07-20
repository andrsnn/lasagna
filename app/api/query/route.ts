import { waitUntil } from "@vercel/functions";
import { executeQuery, executeResearch } from "@/app/lib/executors";
import {
  appendEvent,
  enqueueQueryJob,
  isStreamStoreConfigured,
  saveQueryJob,
  setMeta,
} from "@/app/lib/stream-store";
import { isFlyWorkerConfigured, wakeWorker } from "@/app/lib/fly-wake";
import { captureError, captureException } from "@/app/lib/error-log";
import {
  sanitizeRuntimeConnectors,
  type McpRuntimeConnector,
} from "@/app/lib/mcp/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Simple in-memory per-app rate limiter.
const queryRateLimits = new Map<string, number[]>();

function checkQueryRateLimit(appId: string): boolean {
  const windowMs = 60_000;
  const maxCalls = 10;
  const now = Date.now();
  const timestamps = queryRateLimits.get(appId) ?? [];
  const fresh = timestamps.filter((t) => now - t < windowMs);
  if (fresh.length >= maxCalls) {
    queryRateLimits.set(appId, fresh);
    return true;
  }
  fresh.push(now);
  queryRateLimits.set(appId, fresh);
  return false;
}

type Body = {
  prompt?: string;
  schema?: unknown;
  model?: string;
  webSearch?: boolean;
  system?: string;
  /** Route to the deep multi-agent research engine instead of executeQuery. */
  research?: boolean;
  /** MCP connectors to expose to the run — the client attaches these when the
   *  source/query opted into mcp. Runtime shape (URL + key + tools). */
  connectors?: McpRuntimeConnector[];
  appId?: string;
};

/**
 * Single-shot Ollama call for artifact data fetches. The POST handshake
 * returns a streamId only; the iframe reads the final JSON via
 * GET /api/query/resume/{streamId}, so a tab close mid-fetch is
 * recoverable from any future mount that knows the streamId.
 *
 * The actual LLM tool loop lives in app/lib/executors.ts so the scheduled
 * task runner can share it.
 */
export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const prompt = body.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return Response.json({ error: "prompt is required." }, { status: 400 });
  }

  const appId = body.appId;
  if (typeof appId === "string" && checkQueryRateLimit(appId)) {
    return Response.json({ error: "Too many queries. Slow down." }, { status: 429 });
  }

  const connectors = sanitizeRuntimeConnectors(body.connectors);

  // Producer is Redis-only — without it the iframe has nowhere to read the
  // result back if its in-flight POST gets cancelled.
  if (!isStreamStoreConfigured()) {
    return Response.json(
      {
        error:
          "Resumable streams are disabled — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      },
      { status: 503 }
    );
  }

  // Producer is fully decoupled from the HTTP request. The POST handshake
  // only returns a streamId; the iframe reads the final JSON result via
  // GET /api/query/resume/{streamId}. This way a tab close mid-fetch is
  // recoverable from any future mount that knows the streamId.
  const streamId = crypto.randomUUID();

  // Mark the stream as running BEFORE returning so the iframe can hit
  // /api/query/resume/{streamId} immediately without racing the early-404
  // check (no meta + no events ⇒ 404).
  try {
    await setMeta(streamId, { status: "running" });
  } catch (err) {
    console.warn(`[query ${streamId}] KV setMeta(running) failed`, err);
    return Response.json(
      { error: "Failed to initialize stream buffer." },
      { status: 503 }
    );
  }

  // Off-Vercel worker path: when Fly is configured, hand the query to the
  // long-lived Fly worker instead of running it inside this function's
  // waitUntil. The waitUntil producer dies with the serverless function at
  // maxDuration (~300s) and, more importantly, can be torn down when the
  // phone sleeps mid-flight — leaving the stream stuck on "running" with no
  // result ever written. The Fly worker has no per-request wall clock, so a
  // query started just before the app is backgrounded still completes and
  // lands in Redis for the iframe's resume / pendingQuery sweep to pick up
  // on return. Client behavior is unchanged: it still reads the result from
  // /api/query/resume/{streamId}.
  if (isFlyWorkerConfigured()) {
    try {
      await saveQueryJob(streamId, {
        v: 1,
        prompt,
        schema: body.schema,
        model: body.model,
        webSearch: body.webSearch,
        system: body.system,
        research: body.research,
        connectors,
        appId,
      });
      await enqueueQueryJob(streamId);
    } catch (err) {
      console.warn(`[query ${streamId}] failed to enqueue worker job`, err);
      return Response.json(
        { error: "Failed to enqueue query job." },
        { status: 503 }
      );
    }

    // Fire-and-forget; an already-running worker will drain the queue
    // regardless of whether this wake lands.
    void wakeWorker();

    return Response.json({ streamId }, { status: 202 });
  }

  // Fallback: in-process producer (local dev, or any deploy where the Fly
  // worker env vars aren't set). waitUntil keeps the Vercel function alive
  // until `work` resolves (bounded by maxDuration). The iframe reads the
  // result from /api/query/resume/{streamId}.
  // Deep research is long-running and ideally runs on the Fly worker; in the
  // no-Fly fallback it runs inline under maxDuration (best-effort — a very deep
  // run can hit the QUERY_TIMEOUT_MS budget).
  const work = body.research
    ? executeResearch({ prompt, schema: body.schema, model: body.model })
    : executeQuery({
        prompt,
        schema: body.schema,
        model: body.model,
        webSearch: body.webSearch,
        system: body.system,
        connectors,
      });

  waitUntil(
    (async () => {
      try {
        const outcome = await work;
        // Stash the JSON payload as a single "result" event. The resume
        // endpoint reads this back verbatim.
        await appendEvent(streamId, {
          event: "result",
          data: { status: outcome.status, payload: outcome.payload },
        });
        const ok = outcome.status >= 200 && outcome.status < 300;
        await setMeta(streamId, {
          status: ok ? "complete" : "error",
          finishedAt: Date.now(),
          error: ok ? undefined : (outcome.payload as { error?: string }).error,
        });
        if (!ok) {
          const errPayload = outcome.payload as { error?: string; model?: string };
          await captureError({
            source: "query",
            message: errPayload.error ?? `Query failed (${outcome.status})`,
            appId,
            context: {
              status: outcome.status,
              model: errPayload.model ?? body.model,
              webSearch: !!body.webSearch,
              prompt: prompt.slice(0, 300),
              streamId,
            },
          });
        }
      } catch (err) {
        console.warn(`[query ${streamId}] KV mirror failed`, err);
        await captureException(err, {
          source: "query",
          appId,
          context: { streamId, model: body.model, prompt: prompt.slice(0, 300) },
        });
      }
    })()
  );

  return Response.json({ streamId }, { status: 202 });
}
