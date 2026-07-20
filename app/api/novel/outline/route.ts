// POST /api/novel/outline — handshake-only. Two modes (initial outline and
// revision) are both kicked into a waitUntil background producer; the
// client reads the final outline JSON via GET
// /api/novel/outline/resume/{streamId}. A phone going to sleep mid-call
// (the iOS Safari "Load failed" case) no longer kills the outliner — the
// work survives on the server and the client reconnects to pick up the
// result. Same pattern as the framers and the chat itself.
//
// The actual premise-research + outliner pipeline lives in ./work.ts; this
// file only handles input validation, streamId allocation, and the
// result-event mirror.

import { waitUntil } from "@vercel/functions";
import type { Message as OllamaMessage } from "ollama";
import { probeClientFor } from "@/app/lib/llm/router";
import {
  appendEvent,
  isStreamStoreConfigured,
  setMeta,
} from "@/app/lib/stream-store";
import {
  runNovelOutlineWork,
  type NovelOutlineWorkOutcome,
} from "./work";
import type {
  NovelLength,
  NovelOutline,
} from "@/app/api/chat/novel/prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type IncomingMsg = { role: "user" | "assistant" | "system"; content: string };

type IncomingBody = {
  messages?: IncomingMsg[];
  model?: string;
  length?: NovelLength | "off" | string;
  runpodEndpointId?: string;
  /** Revision mode: the outline the user is iterating on. */
  priorOutline?: NovelOutline;
  /** Revision mode: free-text feedback to apply. */
  feedback?: string;
};

function isLength(v: unknown): v is NovelLength {
  return v === "short" || v === "standard" || v === "long";
}

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
  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : null;
  if (!model) {
    return Response.json(
      { error: "model must be a non-empty string." },
      { status: 400 }
    );
  }
  if (!isLength(body.length)) {
    return Response.json(
      { error: "length must be 'short' | 'standard' | 'long'." },
      { status: 400 }
    );
  }
  const length = body.length;
  const runpodEndpointId =
    typeof body.runpodEndpointId === "string" && body.runpodEndpointId.trim()
      ? body.runpodEndpointId.trim()
      : undefined;

  // Probe the resolved provider's client up front so a missing API key
  // fails the handshake itself rather than mid-flow once we've already
  // returned 202 — keeps the auth-error UX matching what the old
  // synchronous endpoint surfaced.
  try {
    probeClientFor(model, { runpodEndpointId });
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : "LLM provider unavailable",
      },
      { status: 500 }
    );
  }

  const conv: OllamaMessage[] = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  if (conv.length === 0) {
    return Response.json(
      { error: "messages contained no user or assistant turns." },
      { status: 400 }
    );
  }

  // Producer is Redis-only — without it the client has nowhere to read the
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

  // Keep the same `novel-outline-` prefix the synchronous version used as
  // its internal tracing id, so log lines remain greppable.
  const streamId = `novel-outline-${crypto.randomUUID()}`;

  try {
    await setMeta(streamId, { status: "running", createdAt: Date.now() });
  } catch (err) {
    console.warn(`[novel-outline ${streamId}] setMeta(running) failed`, err);
    return Response.json(
      { error: "Failed to initialize stream buffer." },
      { status: 503 }
    );
  }

  waitUntil(
    (async () => {
      let outcome: NovelOutlineWorkOutcome;
      try {
        outcome = await runNovelOutlineWork({
          streamId,
          conv,
          model,
          length,
          runpodEndpointId,
          publicOrigin,
          priorOutline: body.priorOutline,
          feedback: body.feedback,
        });
      } catch (err) {
        outcome = {
          status: 500,
          payload: {
            error: err instanceof Error ? err.message : "Outline work failed",
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
        console.warn(`[novel-outline ${streamId}] KV mirror failed`, err);
      }
    })()
  );

  return Response.json({ streamId }, { status: 202 });
}
