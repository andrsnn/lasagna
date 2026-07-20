// RunPod Serverless client — a structurally-compatible drop-in for the subset
// of the `ollama` SDK this app uses (`.chat()` + `.list()`). Translates
// Ollama-shape calls into the OpenAI-compatible REST API exposed at
// `https://api.runpod.ai/v2/{ENDPOINT_ID}/openai/v1`. The svenbrnn/runpod-ollama
// image surfaces this path natively; OpenAI-compat workers (vLLM, SGLang)
// expose it too. Per-token streaming, tool-calls, and OpenAI-shape model
// listings work without a separate `/run` + `/stream/{id}` polling loop.
//
// NOT cached as a singleton: env vars are re-read on every construction so a
// hot-reload with new credentials picks them up without a restart, and so
// tests that swap RUNPOD_API_BASE between runs aren't poisoned.

import type { ChatRequest, ChatResponse } from "ollama";
import type { RawOllamaModel } from "@/app/models";
import {
  fromOpenAIResponse,
  fromOpenAIStream,
  toOpenAIRequest,
  type OpenAINonStreamResponse,
} from "@/app/lib/runpod/openai-translate";

export type RunpodClient = {
  chat(req: ChatRequest & { stream: true }): Promise<AsyncIterable<ChatResponse>>;
  chat(req: ChatRequest & { stream?: false }): Promise<ChatResponse>;
  chat(req: ChatRequest): Promise<ChatResponse | AsyncIterable<ChatResponse>>;
  list(): Promise<{ models: RawOllamaModel[] }>;
};

export class RunpodConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunpodConfigError";
  }
}

export type RunpodClientOpts = {
  /** Per-request endpoint id (from user Settings). Falls back to the
   *  RUNPOD_ENDPOINT_ID env var when undefined. The API key is always
   *  read from RUNPOD_API_KEY — it never leaves the server. */
  endpointId?: string;
};

function readConfig(opts?: RunpodClientOpts): {
  apiKey: string;
  endpointId: string;
  base: string;
} {
  const apiKey = process.env.RUNPOD_API_KEY;
  const endpointId = opts?.endpointId?.trim() || process.env.RUNPOD_ENDPOINT_ID;
  if (!apiKey) {
    throw new RunpodConfigError(
      "Missing RUNPOD_API_KEY. Set it in .env.local (or your hosting provider's " +
        "secret store) before using runpod: models."
    );
  }
  if (!endpointId) {
    throw new RunpodConfigError(
      "No RunPod endpoint id available. Add one in Preferences → RunPod endpoint, " +
        "or set RUNPOD_ENDPOINT_ID on the server."
    );
  }
  // Hidden override for tests / mock workers. Defaults to RunPod's prod URL.
  const root = process.env.RUNPOD_API_BASE ?? "https://api.runpod.ai";
  const base = `${root.replace(/\/+$/, "")}/v2/${endpointId}/openai/v1`;
  return { apiKey, endpointId, base };
}

/**
 * Construct a RunPod client. Throws `RunpodConfigError` if `RUNPOD_API_KEY`
 * is unset, or if no endpoint id is available (neither `opts.endpointId`
 * from the request nor `RUNPOD_ENDPOINT_ID` from the env).
 */
export function runpodClient(opts?: RunpodClientOpts): RunpodClient {
  const cfg = readConfig(opts);

  async function chatImpl(
    req: ChatRequest
  ): Promise<ChatResponse | AsyncIterable<ChatResponse>> {
    const body = toOpenAIRequest(req);
    const stream = req.stream === true;

    const startMs = performance.now();
    const resp = await fetch(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        ...(stream ? { Accept: "text/event-stream" } : { Accept: "application/json" }),
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw await runpodHttpError(resp, body.model);
    }

    if (stream) {
      if (!resp.body) {
        throw new Error("RunPod stream response had no body");
      }
      // Streaming path measures timing internally — see fromOpenAIStream.
      return fromOpenAIStream(resp.body, req.model);
    }

    const json = (await resp.json()) as OpenAINonStreamResponse;
    const elapsedNs = Math.max(0, Math.round((performance.now() - startMs) * 1e6));
    return fromOpenAIResponse(json, req.model, elapsedNs);
  }

  async function list(): Promise<{ models: RawOllamaModel[] }> {
    const resp = await fetch(`${cfg.base}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      throw await runpodHttpError(resp);
    }
    const body = (await resp.json()) as {
      data?: Array<{ id: string }>;
    };
    const models: RawOllamaModel[] = (body.data ?? []).map((m) => ({
      name: m.id,
      model: m.id,
    }));
    return { models };
  }

  return {
    chat: chatImpl as RunpodClient["chat"],
    list,
  };
}

/**
 * Same shape as `isTransientOllamaError` — used by the router's withRetry
 * wrapper so a flaky RunPod cold start retries cleanly. Matches 408/425/429,
 * 5xx, and the usual fetch network errors.
 */
export function isTransientRunpodError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: number }).status;
  if (typeof status === "number") {
    if (status === 408 || status === 425 || status === 429) return true;
    if (status >= 500 && status <= 599) return true;
  }
  const msg = err.message ?? "";
  if (/\b(Bad Gateway|Service Unavailable|Gateway Timeout)\b/i.test(msg)) return true;
  if (/\b(IN_QUEUE timed out|cold start timed out)\b/i.test(msg)) return true;
  if (
    /(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET|fetch failed|socket hang up|Premature close|other side closed|terminated)/i.test(
      msg
    )
  ) {
    return true;
  }
  return false;
}

/**
 * User-facing rewrite for the noisy RunPod error messages. Mirrors
 * `friendlyOllamaError`'s contract — return prose the user can act on; pass
 * unknown messages through.
 */
export function friendlyRunpodError(message: string): string {
  if (
    /\b(Bad Gateway|Service Unavailable|Gateway Timeout)\b/i.test(message) ||
    /(ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|Premature close|other side closed|terminated)/i.test(
      message
    )
  ) {
    return "The RunPod endpoint had a transient error after a few retries. Tap Retry to try again.";
  }
  if (/\bIN_QUEUE timed out|cold start timed out\b/i.test(message)) {
    return "The RunPod worker is still starting up — give it a minute and tap Retry.";
  }
  // Sent the synthetic placeholder model id to a worker that didn't resolve
  // it. Tell the user exactly what to do — picking the placeholder when a
  // real model exists is a dead-end.
  if (/RunPod 404\b/.test(message) && /\bmodel "?default"?/i.test(message)) {
    return (
      "Your RunPod worker hasn't loaded a model yet, or its OpenAI-compat layer " +
      "doesn't recognize \"default\". Wait for the pull to finish, then refresh " +
      "Preferences → Models and pick a real runpod: model from the list."
    );
  }
  return message;
}

async function runpodHttpError(resp: Response, model?: string): Promise<Error> {
  let text = "";
  try {
    text = await resp.text();
  } catch {}
  const trimmed = text.length > 500 ? `${text.slice(0, 500)}…` : text;
  // Encode the model name into the message so friendlyRunpodError can spot
  // the "sent placeholder, worker 404'd" case without having to thread the
  // model through the router/withRetry layers.
  const modelTag = model ? ` model "${model}"` : "";
  const err = new Error(
    `RunPod ${resp.status} ${resp.statusText}${modelTag}${trimmed ? `: ${trimmed}` : ""}`
  ) as Error & { status?: number };
  err.status = resp.status;
  return err;
}
