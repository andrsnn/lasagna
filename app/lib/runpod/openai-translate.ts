// Translation between the Ollama SDK's chat shapes and the OpenAI
// Chat-Completions wire format that RunPod Serverless workers (including
// svenbrnn/runpod-ollama via its `/openai/v1` route) speak.
//
// We ONLY translate the subset of fields the rest of this app actually uses
// — see app/api/chat/work.ts and app/lib/executors.ts for the call sites.
// Adding fields here should be a deliberate, reviewed change.
//
// Pure functions only (no I/O, no globals). The runpod client owns fetch.

import type {
  ChatRequest,
  ChatResponse,
  Message as OllamaMessage,
  Tool,
  ToolCall,
} from "ollama";

// -- OpenAI wire shapes (only the fields we read/write) ----------------------

type OpenAITextPart = { type: "text"; text: string };
type OpenAIImagePart = { type: "image_url"; image_url: { url: string } };
type OpenAIContentPart = OpenAITextPart | OpenAIImagePart;

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type OpenAIChatRequest = {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  response_format?:
    | { type: "json_object" | "text" }
    | {
        type: "json_schema";
        json_schema: {
          name: string;
          schema: Record<string, unknown>;
          strict?: boolean;
        };
      };
};

export type OpenAIChunkChoiceDeltaToolCall = {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
};

export type OpenAIStreamChunk = {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: OpenAIChunkChoiceDeltaToolCall[];
      reasoning_content?: string;
      reasoning?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export type OpenAINonStreamResponse = {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
      reasoning_content?: string;
      reasoning?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

// -- Ollama → OpenAI request -------------------------------------------------

/**
 * Convert an Ollama-shape `chat()` argument into the OpenAI Chat-Completions
 * request body. The `model` field must already be the bare upstream id (the
 * caller strips any `runpod:` prefix).
 */
export function toOpenAIRequest(req: ChatRequest): OpenAIChatRequest {
  const out: OpenAIChatRequest = {
    model: req.model,
    messages: (req.messages ?? []).map(toOpenAIMessage),
  };

  if (req.tools && req.tools.length > 0) {
    out.tools = req.tools.map(toOpenAITool);
  }

  if (req.stream) {
    out.stream = true;
    // Without this, OpenAI-compatible streams omit the usage block — we
    // depend on it for the `usage` SSE event the chat UI displays.
    out.stream_options = { include_usage: true };
  }

  // Map the subset of `options` fields work.ts actually sets in
  // optionsForModel(). Other Ollama-specific fields (min_p, repeat_penalty,
  // num_ctx, etc.) have no portable OpenAI equivalent — drop silently.
  const opts = (req.options ?? {}) as Record<string, unknown>;
  if (typeof opts.temperature === "number") out.temperature = opts.temperature;
  if (typeof opts.top_p === "number") out.top_p = opts.top_p;
  if (typeof opts.frequency_penalty === "number") {
    out.frequency_penalty = opts.frequency_penalty;
  }
  if (typeof opts.presence_penalty === "number") {
    out.presence_penalty = opts.presence_penalty;
  }
  if (typeof opts.num_predict === "number" && opts.num_predict > 0) {
    out.max_tokens = opts.num_predict;
  }

  // Ollama's `format: "json"` → OpenAI's response_format.json_object.
  // Ollama's `format: <JSON schema object>` → response_format.json_schema,
  // which vLLM, SGLang and most modern OpenAI-compat workers honor as a hard
  // decoder constraint. The schema name is required by the OpenAI shape;
  // "structured_output" is a safe generic label.
  if (req.format === "json") {
    out.response_format = { type: "json_object" };
  } else if (req.format && typeof req.format === "object") {
    out.response_format = {
      type: "json_schema",
      json_schema: {
        name: "structured_output",
        schema: req.format as Record<string, unknown>,
        strict: true,
      },
    };
  }

  // `think: true` is Ollama-proprietary. RunPod's OpenAI-compat path doesn't
  // surface a thinking channel, so we drop the flag silently rather than
  // sending an unsupported field that some workers will 400 on.

  return out;
}

function toOpenAIMessage(m: OllamaMessage): OpenAIMessage {
  // Tool-result messages: Ollama uses { role: "tool", content, tool_name }.
  // OpenAI uses { role: "tool", content, tool_call_id, name? }. We don't
  // track ids per-call so we synthesize one from the tool name; vLLM and
  // most OpenAI-compat workers tolerate the missing-id case.
  if (m.role === "tool") {
    const toolName = (m as { tool_name?: string }).tool_name;
    return {
      role: "tool",
      content: typeof m.content === "string" ? m.content : "",
      tool_call_id: toolName ?? "tool",
      ...(toolName ? { name: toolName } : {}),
    };
  }

  const role: OpenAIMessage["role"] =
    m.role === "system" || m.role === "user" || m.role === "assistant"
      ? m.role
      : "user";

  // Assistant turns may carry tool calls. Translate Ollama's
  // { function: { name, arguments: object } } into OpenAI's
  // { id, type, function: { name, arguments: string } }.
  if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
    return {
      role,
      content: typeof m.content === "string" ? m.content : "",
      tool_calls: m.tool_calls.map((tc, idx) => ({
        id: `call_${idx}`,
        type: "function" as const,
        function: {
          name: tc.function?.name ?? "",
          arguments:
            typeof tc.function?.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments ?? {}),
        },
      })),
    };
  }

  // Images attached to a user/assistant turn → OpenAI multimodal content array.
  // Ollama stores images as base64 strings (no data-url prefix); the OpenAI
  // shape wants a full data URL.
  if (Array.isArray(m.images) && m.images.length > 0) {
    const parts: OpenAIContentPart[] = [];
    const text = typeof m.content === "string" ? m.content : "";
    if (text) parts.push({ type: "text", text });
    for (const img of m.images) {
      const url = typeof img === "string" && img.startsWith("data:")
        ? img
        : `data:image/jpeg;base64,${img}`;
      parts.push({ type: "image_url", image_url: { url } });
    }
    return { role, content: parts };
  }

  return {
    role,
    content: typeof m.content === "string" ? m.content : "",
  };
}

function toOpenAITool(t: Tool): OpenAITool {
  return {
    type: "function",
    function: {
      // Ollama types `name` as optional but OpenAI requires it; an empty
      // name will fail upstream validation, which is the right outcome.
      name: t.function.name ?? "",
      description: t.function.description,
      parameters: (t.function.parameters ?? {}) as Record<string, unknown>,
    },
  };
}

// -- OpenAI → Ollama response (non-streaming) --------------------------------

/**
 * Convert a non-streaming OpenAI Chat-Completions response into the Ollama
 * `ChatResponse` shape. Used for `stream: false` callers (summarize,
 * chat-title, app-name, ...).
 *
 * `elapsedNs` is the wall-clock time the caller measured for the upstream
 * fetch — OpenAI's response has no native timing fields, so we let the
 * caller pass in what it observed and surface it as both `total_duration`
 * and `eval_duration` so the chat UI's tok/s math has a real denominator.
 */
export function fromOpenAIResponse(
  body: OpenAINonStreamResponse,
  model: string,
  elapsedNs: number = 0
): ChatResponse {
  const choice = body.choices?.[0];
  const msg = choice?.message;
  const rawContent = typeof msg?.content === "string" ? msg.content : "";
  const toolCalls = Array.isArray(msg?.tool_calls)
    ? msg!.tool_calls.map(parseToolCall)
    : undefined;

  // Some workers emit thinking inline as <think>…</think> in the content
  // string instead of via reasoning_content; lift it to the thinking channel
  // so the UI's thoughts pane lights up regardless of which convention the
  // worker uses.
  const split = splitThinkInline(rawContent, { inside: false, pending: "" }, true);
  const content = split.content;
  const fieldThinking =
    (typeof msg?.reasoning_content === "string" ? msg.reasoning_content : "") ||
    (typeof msg?.reasoning === "string" ? msg.reasoning : "");
  const thinking = fieldThinking + split.thinking;

  return {
    model,
    created_at: new Date(),
    message: {
      role: "assistant",
      content,
      ...(thinking ? { thinking } : {}),
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    } as ChatResponse["message"],
    done: true,
    done_reason: choice?.finish_reason ?? "stop",
    total_duration: elapsedNs,
    load_duration: 0,
    prompt_eval_count: body.usage?.prompt_tokens ?? 0,
    prompt_eval_duration: 0,
    eval_count: body.usage?.completion_tokens ?? 0,
    eval_duration: elapsedNs,
  } as ChatResponse;
}

// -- Inline <think>…</think> splitter ---------------------------------------

type ThinkSplitState = {
  /** True when we're currently between an opened <think> and its </think>. */
  inside: boolean;
  /** Carry-over from the previous chunk: the trailing fragment that might be
   *  the start of <think> or </think> spanning the chunk boundary. */
  pending: string;
};

/**
 * Route bytes between the content channel and the thinking channel based on
 * inline <think>…</think> tags. Holds back any tail that could be the
 * beginning of an open/close tag so a tag split across chunks still
 * classifies correctly.
 *
 * Pass `flush: true` at end-of-stream to drain the carry buffer; without it,
 * the tail is preserved in the returned state for the next call.
 */
function splitThinkInline(
  input: string,
  state: ThinkSplitState,
  flush = false
): { content: string; thinking: string; state: ThinkSplitState } {
  const OPEN = "<think>";
  const CLOSE = "</think>";

  let buf = state.pending + input;
  let inside = state.inside;
  let content = "";
  let thinking = "";

  while (buf.length > 0) {
    const tag = inside ? CLOSE : OPEN;
    const idx = buf.indexOf(tag);
    if (idx >= 0) {
      const before = buf.slice(0, idx);
      if (inside) thinking += before;
      else content += before;
      buf = buf.slice(idx + tag.length);
      inside = !inside;
      continue;
    }
    if (flush) {
      if (inside) thinking += buf;
      else content += buf;
      buf = "";
      break;
    }
    // No complete tag — emit everything except the longest suffix of `buf`
    // that is a proper prefix of `tag`, since that suffix might still grow
    // into a real tag on the next chunk.
    let keep = 0;
    const maxKeep = Math.min(tag.length - 1, buf.length);
    for (let k = maxKeep; k > 0; k--) {
      if (buf.endsWith(tag.slice(0, k))) {
        keep = k;
        break;
      }
    }
    const emit = buf.slice(0, buf.length - keep);
    if (inside) thinking += emit;
    else content += emit;
    buf = buf.slice(buf.length - keep);
    break;
  }

  return { content, thinking, state: { inside, pending: buf } };
}

// -- OpenAI SSE stream → AsyncIterable<ChatResponse-ish chunks> --------------

/**
 * Parse an OpenAI-format SSE stream (text/event-stream of `data: {...}` lines
 * terminated by `data: [DONE]`) into the Ollama streaming chunk shape that
 * the chat work loop's `for await (const part of iter)` expects.
 *
 * Per-token content arrives as `delta.content` and is yielded immediately.
 * Tool-call argument fragments are accumulated per `index` and emitted as a
 * single complete `tool_calls` array on the chunk that carries the
 * `finish_reason` (or `[DONE]` marker), so the work loop never sees a
 * partially-built tool_calls array.
 */
export async function* fromOpenAIStream(
  body: ReadableStream<Uint8Array>,
  model: string
): AsyncGenerator<ChatResponse> {
  // Per-tool-call accumulators keyed by `index` from the OpenAI delta.
  type Accum = { name: string; args: string };
  const toolAccum = new Map<number, Accum>();

  // State for the inline <think>…</think> splitter — many workers (raw
  // DeepSeek-R1, GPT-OSS, vLLM/llama.cpp without a reasoning parser) emit
  // thoughts inside content rather than as a separate reasoning_content
  // channel. We track open/close across chunk boundaries so a tag split
  // mid-stream still classifies correctly.
  let thinkState: ThinkSplitState = { inside: false, pending: "" };

  let promptTokens = 0;
  let completionTokens = 0;
  let finishReason: string | null = null;

  // Wall-clock timing — OpenAI's wire format carries no per-request latency,
  // so we measure it ourselves. `firstContentMs` is set when the first
  // content/thinking delta arrives; the gap between it and the stream end
  // approximates decode time, which is what the UI's tok/s math wants as
  // `eval_duration`.
  const startMs = performance.now();
  let firstContentMs: number | null = null;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on the SSE blank-line terminator. Tolerant of `\n\n` and
      // `\r\n\r\n`. Any partial trailing record stays in `buffer`.
      let sep: number;
      while ((sep = findRecordEnd(buffer)) >= 0) {
        const record = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){1,2}/, "");

        const dataLine = extractDataLine(record);
        if (dataLine == null) continue;
        if (dataLine === "[DONE]") {
          // Flush any held think-splitter tail, then any pending tool calls
          // + final usage chunk.
          const doneTail = splitThinkInline("", thinkState, true);
          thinkState = doneTail.state;
          if (doneTail.content || doneTail.thinking) {
            yield ({
              model,
              created_at: new Date(),
              message: {
                role: "assistant",
                content: doneTail.content,
                ...(doneTail.thinking ? { thinking: doneTail.thinking } : {}),
              },
              done: false,
            } as unknown) as ChatResponse;
          }
          yield finalChunk({
            model,
            promptTokens,
            completionTokens,
            toolAccum,
            finishReason,
            totalNs: msToNs(performance.now() - startMs),
            evalNs: msToNs(
              firstContentMs === null ? 0 : performance.now() - firstContentMs
            ),
          });
          return;
        }

        let parsed: OpenAIStreamChunk;
        try {
          parsed = JSON.parse(dataLine) as OpenAIStreamChunk;
        } catch {
          continue;
        }

        // Usage may arrive on a dedicated tail chunk (choices: []) when
        // stream_options.include_usage is set.
        if (parsed.usage) {
          promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
          completionTokens = parsed.usage.completion_tokens ?? completionTokens;
        }

        const choice = parsed.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta ?? {};

        // Tool-call fragments. Each fragment refines the entry at
        // delta.tool_calls[i].index — which is NOT the array index here,
        // it's the canonical id for that call across chunks.
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const slot = toolAccum.get(tc.index) ?? { name: "", args: "" };
            if (tc.function?.name) slot.name = tc.function.name;
            if (typeof tc.function?.arguments === "string") {
              slot.args += tc.function.arguments;
            }
            toolAccum.set(tc.index, slot);
          }
        }

        // Content delta — emit immediately as an Ollama-shape partial chunk.
        // Two ways thinking can arrive: (a) a dedicated `reasoning_content`
        // (vLLM/SGLang with a reasoning parser) or `reasoning` (some custom
        // workers) field, and (b) inline <think>…</think> tags inside the
        // content stream itself. We forward both into Ollama's `thinking`
        // slot so the UI's existing thinking pane lights up regardless of
        // which convention the worker chose.
        const rawContent = typeof delta.content === "string" ? delta.content : "";
        const fieldThinking =
          (typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : "") ||
          (typeof delta.reasoning === "string" ? delta.reasoning : "");

        const split = splitThinkInline(rawContent, thinkState);
        thinkState = split.state;
        const content = split.content;
        const thinking = fieldThinking + split.thinking;

        if (content || thinking) {
          if (firstContentMs === null) firstContentMs = performance.now();
          yield ({
            model,
            created_at: new Date(),
            message: {
              role: "assistant",
              content,
              ...(thinking ? { thinking } : {}),
            },
            done: false,
          } as unknown) as ChatResponse;
        }
      }
    }

    // Stream ended without an explicit `[DONE]` — flush whatever we have.
    const tail = splitThinkInline("", thinkState, true);
    thinkState = tail.state;
    if (tail.content || tail.thinking) {
      yield ({
        model,
        created_at: new Date(),
        message: {
          role: "assistant",
          content: tail.content,
          ...(tail.thinking ? { thinking: tail.thinking } : {}),
        },
        done: false,
      } as unknown) as ChatResponse;
    }
    yield finalChunk({
      model,
      promptTokens,
      completionTokens,
      toolAccum,
      finishReason,
      totalNs: msToNs(performance.now() - startMs),
      evalNs: msToNs(
        firstContentMs === null ? 0 : performance.now() - firstContentMs
      ),
    });
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

function findRecordEnd(s: string): number {
  // Returns the index AT the blank-line terminator (so callers can slice up
  // to it, then drop the terminator). -1 if no full record yet.
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

function extractDataLine(record: string): string | null {
  // SSE records are line-oriented. We only care about `data:` lines, and
  // multi-`data:`-line payloads are concatenated with `\n` per the spec.
  const lines = record.split(/\r?\n/);
  const datas: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) datas.push(line.slice(5).trimStart());
  }
  if (datas.length === 0) return null;
  return datas.join("\n");
}

function msToNs(ms: number): number {
  return Math.max(0, Math.round(ms * 1e6));
}

function finalChunk(args: {
  model: string;
  promptTokens: number;
  completionTokens: number;
  toolAccum: Map<number, { name: string; args: string }>;
  finishReason: string | null;
  totalNs: number;
  evalNs: number;
}): ChatResponse {
  const tool_calls: ToolCall[] = [];
  for (const slot of args.toolAccum.values()) {
    if (!slot.name) continue;
    let parsedArgs: Record<string, unknown> = {};
    if (slot.args.trim()) {
      try {
        const v = JSON.parse(slot.args);
        if (v && typeof v === "object") parsedArgs = v as Record<string, unknown>;
      } catch {
        // Malformed JSON from the model — pass the raw string under a single
        // `_raw` key so the tool dispatcher can surface a clear error rather
        // than silently dropping the call.
        parsedArgs = { _raw: slot.args };
      }
    }
    tool_calls.push({
      function: {
        name: slot.name,
        arguments: parsedArgs,
      },
    } as ToolCall);
  }

  return ({
    model: args.model,
    created_at: new Date(),
    message: {
      role: "assistant",
      content: "",
      ...(tool_calls.length > 0 ? { tool_calls } : {}),
    },
    done: true,
    done_reason: args.finishReason ?? "stop",
    total_duration: args.totalNs,
    load_duration: 0,
    prompt_eval_count: args.promptTokens,
    prompt_eval_duration: Math.max(0, args.totalNs - args.evalNs),
    eval_count: args.completionTokens,
    eval_duration: args.evalNs > 0 ? args.evalNs : args.totalNs,
  } as unknown) as ChatResponse;
}

function parseToolCall(tc: {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}): ToolCall {
  let parsedArgs: Record<string, unknown> = {};
  if (tc.function.arguments && tc.function.arguments.trim()) {
    try {
      const v = JSON.parse(tc.function.arguments);
      if (v && typeof v === "object") parsedArgs = v as Record<string, unknown>;
    } catch {
      parsedArgs = { _raw: tc.function.arguments };
    }
  }
  return {
    function: { name: tc.function.name, arguments: parsedArgs },
  } as ToolCall;
}
