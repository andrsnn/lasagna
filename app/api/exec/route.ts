// Code-execution sandbox handshake for saved apps (artifact.exec()).
//
// Mirrors /api/query: the POST returns a streamId only; the iframe reads the
// result via GET /api/exec/resume/{streamId}, so a tab close mid-run is
// recoverable. The actual run happens on the Fly worker (where python3 / node
// / ffmpeg live) via the exec job queue; when Fly isn't configured we fall
// back to an in-process waitUntil run, which still works wherever the
// interpreter exists (otherwise the sandbox returns a clear "unavailable"
// error the iframe surfaces).

import { waitUntil } from "@vercel/functions";
import { executeCode } from "@/app/lib/executors";
import {
  appendEvent,
  enqueueExecJob,
  isStreamStoreConfigured,
  saveExecJob,
  setMeta,
} from "@/app/lib/stream-store";
import { isFlyWorkerConfigured, wakeWorker } from "@/app/lib/fly-wake";
import { captureException } from "@/app/lib/error-log";
import { getCurrentUserEmail } from "@/app/lib/current-user";
import { isBlobStoreConfigured, userHash } from "@/app/lib/blob-store";
import type { AttachedFile } from "@/app/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Per-app rate limit — code execution is heavier than a query, so a tighter
// budget than /api/query's 10/min.
const execRateLimits = new Map<string, number[]>();
function checkExecRateLimit(appId: string): boolean {
  const windowMs = 60_000;
  const maxCalls = 6;
  const now = Date.now();
  const fresh = (execRateLimits.get(appId) ?? []).filter((t) => now - t < windowMs);
  if (fresh.length >= maxCalls) {
    execRateLimits.set(appId, fresh);
    return true;
  }
  fresh.push(now);
  execRateLimits.set(appId, fresh);
  return false;
}

type Body = {
  language?: unknown;
  code?: unknown;
  stdin?: unknown;
  files?: unknown;
  timeoutMs?: unknown;
  appId?: unknown;
};

function normalizeFiles(raw: unknown): AttachedFile[] {
  if (!Array.isArray(raw)) return [];
  const out: AttachedFile[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    if (typeof o.name !== "string" || typeof o.url !== "string") continue;
    out.push({
      id: typeof o.id === "string" ? o.id : o.name,
      name: o.name,
      blobKey: typeof o.blobKey === "string" ? o.blobKey : "",
      url: o.url,
      contentType: typeof o.contentType === "string" ? o.contentType : "application/octet-stream",
      bytes: typeof o.bytes === "number" ? o.bytes : 0,
      produced: o.produced === true,
    });
  }
  return out;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const languageRaw = String(body.language ?? "python").toLowerCase();
  const language: "python" | "node" = languageRaw === "node" ? "node" : "python";
  const code = typeof body.code === "string" ? body.code : "";
  if (!code.trim()) {
    return Response.json({ error: "code is required." }, { status: 400 });
  }
  const stdin = typeof body.stdin === "string" ? body.stdin : undefined;
  const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;
  const appId = typeof body.appId === "string" ? body.appId : undefined;
  const inputFiles = normalizeFiles(body.files);

  if (appId && checkExecRateLimit(appId)) {
    return Response.json({ error: "Too many code runs. Slow down." }, { status: 429 });
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

  // Resolve the caller's blob namespace so produced outputs land under their
  // account. Without Blob configured the run still works but can't persist
  // outputs (the sandbox just returns stdout/stderr).
  let resolvedUserHash = "";
  if (isBlobStoreConfigured()) {
    const email = await getCurrentUserEmail(req);
    if (email) resolvedUserHash = await userHash(email);
  }

  const streamId = crypto.randomUUID();
  try {
    await setMeta(streamId, { status: "running" });
  } catch (err) {
    console.warn(`[exec ${streamId}] KV setMeta(running) failed`, err);
    return Response.json(
      { error: "Failed to initialize stream buffer." },
      { status: 503 }
    );
  }

  // Preferred path: hand to the Fly worker, which has the interpreters.
  if (isFlyWorkerConfigured()) {
    try {
      await saveExecJob(streamId, {
        v: 1,
        language,
        code,
        stdin,
        inputFiles,
        userHash: resolvedUserHash,
        timeoutMs,
        appId,
      });
      await enqueueExecJob(streamId);
    } catch (err) {
      console.warn(`[exec ${streamId}] failed to enqueue worker job`, err);
      return Response.json({ error: "Failed to enqueue exec job." }, { status: 503 });
    }
    void wakeWorker();
    return Response.json({ streamId }, { status: 202 });
  }

  // Fallback: in-process run (local dev). executeCode degrades gracefully when
  // the interpreter is absent.
  const work = executeCode({
    language,
    code,
    stdin,
    inputFiles,
    userHash: resolvedUserHash,
    timeoutMs,
    appId,
  });
  waitUntil(
    (async () => {
      try {
        const outcome = await work;
        await appendEvent(streamId, {
          event: "result",
          data: { status: outcome.status, payload: outcome.payload },
        });
        const ok = outcome.status >= 200 && outcome.status < 300;
        await setMeta(streamId, {
          status: ok ? "complete" : "error",
          finishedAt: Date.now(),
          error: ok ? undefined : outcome.payload.error,
        });
      } catch (err) {
        console.warn(`[exec ${streamId}] KV mirror failed`, err);
        await captureException(err, {
          source: "query",
          appId,
          context: { streamId, kind: "exec", language },
        });
      }
    })()
  );

  return Response.json({ streamId }, { status: 202 });
}
