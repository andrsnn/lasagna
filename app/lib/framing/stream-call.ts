// Streaming variant of the framer's single model turn. The framers used to
// call `llm.chat({ stream: false, think: false })` and the user stared at a
// spinner with zero signal — "I can't tell if it's stuck." This streams the
// model's reasoning (`think: true`) and forwards it as `thinking` events the
// framing card renders live, so the user watches the framer work instead of
// guessing.
//
// It keeps the same wall-clock guarantee the old `withDeadline` wrapper gave:
// the Ollama SDK exposes no AbortSignal on the returned promise, but the
// streaming iterator IS abortable, so we arm a timer that aborts it at the
// per-call cap (or the run deadline, whichever is sooner). A timed-out call
// with partial output returns what it has (the caller's parse/retry logic
// handles malformed JSON); a timed-out call with nothing throws the same
// labelled timeout the old path did so the caller's catch still fires.

import type { ChatResponse, Message as OllamaMessage, ToolCall } from "ollama";
import { withRetry, type LlmClient } from "@/app/lib/llm/router";

export type FramerEvent = { event: string; data: unknown };
/** Best-effort sink for progress/thinking events. Implementations append to
 *  the stream's Redis events list; they must never throw (a Redis hiccup must
 *  not kill the framer), so callers wrap their append in a try/catch. */
export type FramerEmit = (ev: FramerEvent) => void | Promise<void>;

// Batch reasoning deltas before pushing to Redis: reasoning models emit many
// tiny chunks, and one RPUSH per token would hammer Upstash. Flush on either
// a ~500ms cadence or an ~800-char buffer so the card updates smoothly without
// a write per token.
const THINKING_FLUSH_MS = 500;
const THINKING_FLUSH_CHARS = 800;

/** Emit a one-line progress milestone (e.g. "Searching the web…"). Swallows
 *  emit failures — progress is diagnostic, never load-bearing. */
export async function emitProgress(
  emit: FramerEmit | undefined,
  text: string
): Promise<void> {
  if (!emit) return;
  try {
    await emit({ event: "progress", data: { text } });
  } catch {
    /* best-effort */
  }
}

/**
 * Run one streaming model turn, forwarding reasoning as `thinking` events.
 * Returns the assembled content + tool calls so the caller extracts the
 * framing JSON exactly as it did from the non-streaming `resp.message`.
 */
export async function streamFramerCall(opts: {
  llm: LlmClient;
  model: string;
  messages: OllamaMessage[];
  tools?: unknown[];
  /** Structured-output JSON schema, passed through to constrain the content
   *  channel. Reasoning still streams on the separate thinking channel. */
  format?: unknown;
  /** Epoch ms the whole framer run must finish by. */
  deadlineAt: number;
  /** Hard ceiling for this single call regardless of the run deadline. */
  hardCapMs: number;
  /** Label used in the timeout error message (names the step that gave up). */
  label: string;
  emit?: FramerEmit;
}): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const { llm, model, messages, tools, format, deadlineAt, hardCapMs, label, emit } =
    opts;

  const ms = Math.min(deadlineAt - Date.now(), hardCapMs);
  if (ms <= 0) throw new Error(`${label} timed out`);

  // withRetry guards only the initial handshake (getting the iterator). Once
  // the stream yields we can't safely replay, so iteration errors propagate.
  const iter = await withRetry(model, () =>
    llm.chat({
      model,
      messages,
      ...(tools ? { tools } : {}),
      think: true,
      stream: true,
      ...(format ? { format } : {}),
    } as ChatRequestStreaming)
  );

  const maybeAbortable = iter as unknown as { abort?: () => void };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      maybeAbortable.abort?.();
    } catch {
      /* SDK without abort — the deadline elsewhere still bounds the producer */
    }
  }, ms);

  let content = "";
  const toolCalls: ToolCall[] = [];
  let buf = "";
  let lastFlush = Date.now();
  const flush = async (force: boolean): Promise<void> => {
    if (!emit || !buf) return;
    if (
      !force &&
      Date.now() - lastFlush < THINKING_FLUSH_MS &&
      buf.length < THINKING_FLUSH_CHARS
    ) {
      return;
    }
    const text = buf;
    buf = "";
    lastFlush = Date.now();
    try {
      await emit({ event: "thinking", data: { text } });
    } catch {
      /* best-effort */
    }
  };

  try {
    for await (const part of iter as AsyncIterable<ChatResponse>) {
      const thinking = part.message?.thinking;
      if (thinking) {
        buf += thinking;
        await flush(false);
      }
      const c = part.message?.content;
      if (c) content += c;
      const calls = part.message?.tool_calls;
      if (calls && calls.length) toolCalls.push(...calls);
    }
  } catch (err) {
    if (!timedOut) {
      clearTimeout(timer);
      await flush(true);
      throw err;
    }
    // Aborted by our deadline timer — fall through and use partial output.
  } finally {
    clearTimeout(timer);
  }

  await flush(true);

  if (timedOut && !content && toolCalls.length === 0) {
    throw new Error(`${label} timed out after ${ms}ms`);
  }
  return { content, toolCalls };
}

// The `stream: true` overload's request type. Inlined to avoid exporting a
// fresh name from the router just for this cast.
type ChatRequestStreaming = Parameters<LlmClient["chat"]>[0] & { stream: true };
