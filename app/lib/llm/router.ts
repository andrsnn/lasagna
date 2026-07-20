// Provider-agnostic LLM factory. Every server route that needs to talk to a
// model imports `chatClientFor(modelId)` from here instead of constructing a
// provider-specific client directly. The router inspects the model id, picks
// the right backend (Ollama Cloud or RunPod), and returns an object with the
// subset of the `ollama` SDK shape this app uses (`.chat()` + `.list()`).
//
// Keeps the ~13 one-shot callsites pointed at a single, stable import while
// the underlying provider logic lives behind `providerFor()`.

import type { ChatRequest, ChatResponse } from "ollama";
import type { RawOllamaModel } from "@/app/models";
import { modelContextTokens } from "@/app/models";
import {
  friendlyOllamaError,
  isTransientOllamaError,
  ollamaClient,
} from "@/app/lib/ollama/client";
import {
  friendlyRunpodError,
  isTransientRunpodError,
  runpodClient,
} from "@/app/lib/runpod/client";
import { providerFor, upstreamModelId, type Provider } from "@/app/lib/llm/provider";

/**
 * Structural subset of the Ollama SDK we actually call. Both adapters return
 * something compatible with this. The `chat()` overloads carry the
 * streaming/non-streaming distinction so callers retain the right return type.
 *
 * `list()` is typed against the loose `RawOllamaModel` shape (rather than
 * the SDK's stricter `ModelResponse`) so the RunPod adapter — which only has
 * an OpenAI `/v1/models` payload to work with — can satisfy it.
 */
export type LlmClient = {
  chat(req: ChatRequest & { stream: true }): Promise<AsyncIterable<ChatResponse>>;
  chat(req: ChatRequest & { stream?: false }): Promise<ChatResponse>;
  chat(req: ChatRequest): Promise<ChatResponse | AsyncIterable<ChatResponse>>;
  list(): Promise<{ models: RawOllamaModel[] }>;
};

/**
 * Per-request options for `chatClientFor` / `probeClientFor`. Passed through
 * to provider clients so the caller can override the static env-based
 * defaults — e.g. send a user-configured RunPod endpoint id from Settings.
 */
export type ChatClientOpts = {
  /** RunPod endpoint id from the user's Settings. Falls back to the
   *  RUNPOD_ENDPOINT_ID env var when undefined. */
  runpodEndpointId?: string;
};

/**
 * Resolve a chat client for `modelId`. The model id is preserved on the
 * returned client's invocation: the RunPod adapter strips its own `runpod:`
 * prefix internally before hitting the upstream API, and the Ollama adapter
 * passes the id straight through.
 *
 * Throws if credentials for the resolved provider are missing — caller
 * decides how to surface that (the chat probe path returns 500; one-shot
 * routes wrap it in a try/catch and forward the message to the user).
 */
export function chatClientFor(modelId: string, opts?: ChatClientOpts): LlmClient {
  if (providerFor(modelId) === "runpod") {
    const rp = runpodClient({ endpointId: opts?.runpodEndpointId });
    // Wrap so the caller can pass the prefixed id through unchanged — the
    // upstream API only knows the bare model name.
    return {
      chat: ((req: ChatRequest) =>
        rp.chat({ ...req, model: upstreamModelId(req.model) })) as LlmClient["chat"],
      list: () => rp.list(),
    };
  }
  return ollamaClient() as unknown as LlmClient;
}

/**
 * Validate that creds are present for whichever provider would handle
 * `modelId`. Used by `POST /api/chat` to fail the handshake fast (500)
 * instead of letting the deferred worker blow up after the stream is open.
 */
export function probeClientFor(modelId: string, opts?: ChatClientOpts): void {
  // Constructing the client throws on missing creds. Discard the result.
  if (providerFor(modelId) === "runpod") {
    runpodClient({ endpointId: opts?.runpodEndpointId });
  } else {
    ollamaClient();
  }
}

/**
 * True if `err` looks like a transient blip from the upstream provider
 * handling `modelId`. Used by `withRetry` and by mid-stream reconnect logic.
 */
export function isTransientErrorFor(modelId: string, err: unknown): boolean {
  return providerFor(modelId) === "runpod"
    ? isTransientRunpodError(err)
    : isTransientOllamaError(err);
}

/**
 * Translate a raw upstream error message into prose the user can act on.
 * Pass-through for messages that don't match a known transient pattern.
 */
export function friendlyErrorFor(modelId: string, message: string): string {
  return providerFor(modelId) === "runpod"
    ? friendlyRunpodError(message)
    : friendlyOllamaError(message);
}

/**
 * Provider-recommended sampling params for `modelId`. Currently only overrides
 * defaults for Kimi K2.6, which in thinking mode has a documented "stuck on a
 * single low-probability token (often '!')" loop bug. Moonshot's recommended
 * thinking-mode sampling (temp 1.0, top_p 0.95, min_p 0.01) plus a small
 * frequency_penalty (0.4) suppresses it; num_predict caps damage if a loop
 * slips through. The cap counts thinking + content + tool_calls together
 * (Ollama option), so it has to be large enough that an honest thinking trace
 * plus the follow-up answer can both fit. Returns {} for models with no
 * known override.
 *
 * Pass this as `options:` to every `llm.chat(...)` call that hands the model
 * to a multi-round agentic loop — the per-worker wall-clock deadline is the
 * real guardrail against runaway, but this bounds the degenerate fast loop.
 */
export function optionsForModel(
  model: string,
  numCtx?: number
): Record<string, number> {
  // Ollama Cloud defaults an UNSET `num_ctx` to a small window (~4096 tokens)
  // regardless of the model's real capacity, then silently slides it as the
  // prompt grows. That drops earlier-but-still-recent turns mid-conversation
  // and makes the model fixate on whatever survived the window and fabricate
  // the rest — on chats the client still considers well within budget. Sizing
  // `num_ctx` to the actual prompt (see `contextWindowFor`) keeps the whole
  // conversation visible up to the model's true context length.
  const base: Record<string, number> =
    model === "kimi-k2.6"
      ? {
          temperature: 1.0,
          top_p: 0.95,
          min_p: 0.01,
          frequency_penalty: 0.4,
          repeat_penalty: 1.0,
          num_predict: 32768,
        }
      : {};
  if (numCtx && numCtx > 0) base.num_ctx = numCtx;
  return base;
}

/**
 * Choose an explicit `num_ctx` for a chat request, sized to the prompt with
 * headroom for the reply (and a thinking trace), capped at the model's true
 * context length. Without this, Ollama Cloud clips the conversation to its
 * small default window — see `optionsForModel`.
 *
 * - `FLOOR` guarantees even a tiny prompt gets a usable window for a long
 *   answer + reasoning.
 * - `HEADROOM` reserves space above the prompt for the model's own output so
 *   the prompt itself is never evicted to make room for generation.
 */
export function contextWindowFor(model: string, promptTokens: number): number {
  const max = modelContextTokens(model);
  const HEADROOM = 16384;
  const FLOOR = 32768;
  const want = Math.max(FLOOR, promptTokens + HEADROOM);
  return Math.min(max, want);
}

const RETRY_BASE_MS = 400;

// Kimi K2.6 on Ollama Cloud has been observably flaky — its edge gateway
// returns `Internal Server Error (ref: …)` for blips that frequently last
// longer than the default 3-attempt / ~2.8s budget, especially on the second
// handshake of a turn (after web-search tool calls). Give it more headroom:
// 6 attempts at base 600ms = 600+1200+2400+4800+9600 ≈ 18.6s of retry before
// surfacing the friendly error. Still well inside the 300s function wall.
const KIMI_RETRY_ATTEMPTS = 6;
const KIMI_RETRY_BASE_MS = 600;

function retryDefaultsFor(modelId: string): { attempts: number; baseMs: number } {
  if (modelId === "kimi-k2.6") {
    return { attempts: KIMI_RETRY_ATTEMPTS, baseMs: KIMI_RETRY_BASE_MS };
  }
  return { attempts: 3, baseMs: RETRY_BASE_MS };
}

/**
 * Run an upstream call with bounded retry on transient errors. Backoff is
 * exponential off `RETRY_BASE_MS` (or a model-specific override — see
 * `retryDefaultsFor`). The transient predicate is picked from `modelId`'s
 * provider.
 *
 * Safe ONLY for the initial request — once a streaming iterator has yielded
 * any chunks, the caller has already emitted user-visible state we cannot
 * replay, so mid-stream failures must propagate. The chat work loop's
 * mid-stream reconnect logic handles those separately.
 *
 * Typed `<F extends () => unknown>` so the streaming-vs-non-streaming
 * `chat()` overload return type flows through `ReturnType<F>`.
 */
export async function withRetry<F extends () => unknown>(
  modelId: string,
  call: F,
  opts?: { attempts?: number; onRetry?: (attempt: number, err: unknown) => void }
): Promise<Awaited<ReturnType<F>>> {
  const defaults = retryDefaultsFor(modelId);
  const attempts = Math.max(1, opts?.attempts ?? defaults.attempts);
  const provider: Provider = providerFor(modelId);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return (await call()) as Awaited<ReturnType<F>>;
    } catch (err) {
      lastErr = err;
      const transient =
        provider === "runpod"
          ? isTransientRunpodError(err)
          : isTransientOllamaError(err);
      if (i + 1 >= attempts || !transient) throw err;
      opts?.onRetry?.(i + 1, err);
      await new Promise<void>((r) => setTimeout(r, defaults.baseMs * 2 ** i));
    }
  }
  throw lastErr;
}
