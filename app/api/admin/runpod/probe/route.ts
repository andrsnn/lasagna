// Raw RunPod probe for the /admin/runpod debug page. Bypasses the chat work
// loop, the Redis stream buffer, and the retry wrapper — sends a single
// fetch directly to the configured RunPod endpoint and returns every layer
// of the exchange (request URL/headers/body, response status/headers, raw
// body or full SSE event log) so the operator can see exactly what's going
// back and forth when chat responses come back empty.
//
// Three actions:
//   - "list":   GET /v2/{ep}/openai/v1/models        — connectivity check
//   - "chat":   POST /v2/{ep}/openai/v1/chat/completions, stream:false
//   - "stream": same endpoint, stream:true, full SSE event log captured
//
// API key is read from RUNPOD_API_KEY and never sent to the client; the
// returned `requestHeaders` redacts it.

import type { ChatRequest } from "ollama";
import {
  fromOpenAIResponse,
  fromOpenAIStream,
  toOpenAIRequest,
  type OpenAINonStreamResponse,
} from "@/app/lib/runpod/openai-translate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREVIEW_BODY_BYTES = 64 * 1024; // cap raw response bodies in JSON payload

type ProbeAction = "list" | "chat" | "stream";

type RawSseEvent = {
  // Time since the request was sent, in ms.
  tMs: number;
  // The literal payload after `data: `, or `<other>` for non-data lines.
  data: string;
  // Best-effort JSON parse of `data`. null when it isn't JSON.
  parsed?: unknown;
};

function badRequest(msg: string) {
  return Response.json({ error: msg }, { status: 400 });
}

function readableHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function redactedRequestHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === "authorization") {
      out[k] = v.replace(/Bearer\s+(\S{4})\S+/i, "Bearer $1…<redacted>");
    } else {
      out[k] = v;
    }
  }
  return out;
}

function resolveConfig(opts: { endpointIdOverride?: string }) {
  const apiKey = process.env.RUNPOD_API_KEY;
  const endpointId =
    opts.endpointIdOverride?.trim() || process.env.RUNPOD_ENDPOINT_ID;
  const root = process.env.RUNPOD_API_BASE ?? "https://api.runpod.ai";
  if (!apiKey) {
    return { error: "RUNPOD_API_KEY is not set on the server." } as const;
  }
  if (!endpointId) {
    return {
      error:
        "No endpoint id. Pass endpointId in the request or set RUNPOD_ENDPOINT_ID.",
    } as const;
  }
  const base = `${root.replace(/\/+$/, "")}/v2/${endpointId}/openai/v1`;
  return { apiKey, endpointId, base, root } as const;
}

export async function POST(req: Request) {
  let body: {
    action?: ProbeAction;
    endpointId?: string;
    model?: string;
    // Either a free-form prompt (becomes a single user message) or an
    // explicit messages array. Messages wins if both are supplied.
    prompt?: string;
    messages?: ChatRequest["messages"];
    options?: Record<string, number>;
    responseFormat?: "json" | null;
  };
  try {
    body = await req.json();
  } catch {
    return badRequest("Body must be JSON.");
  }

  const action: ProbeAction = body.action ?? "chat";
  const cfg = resolveConfig({ endpointIdOverride: body.endpointId });
  if ("error" in cfg) {
    return Response.json({ error: cfg.error }, { status: 503 });
  }

  if (action === "list") {
    return await runList(cfg);
  }

  const model = (body.model ?? "").trim();
  if (!model) return badRequest("model is required.");
  const messages =
    body.messages && Array.isArray(body.messages) && body.messages.length > 0
      ? body.messages
      : [
          {
            role: "user" as const,
            content: body.prompt ?? "",
          },
        ];

  const stream = action === "stream";
  const chatReq: ChatRequest = {
    model,
    messages,
    stream,
    ...(body.options ? { options: body.options } : {}),
    ...(body.responseFormat === "json" ? { format: "json" as const } : {}),
  } as ChatRequest;

  const openAIBody = toOpenAIRequest(chatReq);
  const url = `${cfg.base}/chat/completions`;
  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
  };

  const t0 = performance.now();
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(openAIBody),
    });
  } catch (err) {
    return Response.json(
      {
        action,
        request: {
          url,
          method: "POST",
          headers: redactedRequestHeaders(requestHeaders),
          body: openAIBody,
        },
        error:
          err instanceof Error
            ? `fetch failed: ${err.message}`
            : "fetch failed",
        durationMs: Math.round(performance.now() - t0),
      },
      { status: 502 }
    );
  }

  const headersDurationMs = Math.round(performance.now() - t0);

  if (!stream) {
    const rawText = await resp.text();
    const truncated = rawText.length > PREVIEW_BODY_BYTES;
    const previewText = truncated
      ? rawText.slice(0, PREVIEW_BODY_BYTES)
      : rawText;
    let parsedJson: unknown = null;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      parsedJson = null;
    }
    let parsedOllama: unknown = null;
    try {
      if (parsedJson) {
        parsedOllama = fromOpenAIResponse(
          parsedJson as OpenAINonStreamResponse,
          model
        );
      }
    } catch (err) {
      parsedOllama = {
        _translateError: err instanceof Error ? err.message : "translate failed",
      };
    }

    return Response.json({
      action,
      ok: resp.ok,
      request: {
        url,
        method: "POST",
        headers: redactedRequestHeaders(requestHeaders),
        body: openAIBody,
      },
      response: {
        status: resp.status,
        statusText: resp.statusText,
        headers: readableHeaders(resp.headers),
        bodyText: previewText,
        bodyTruncated: truncated,
        bodyByteLength: rawText.length,
        json: parsedJson,
      },
      parsedOllama,
      timing: {
        headersMs: headersDurationMs,
        totalMs: Math.round(performance.now() - t0),
      },
    });
  }

  // Streaming path: drain the SSE body ourselves so we can record every
  // record with timestamps. We then run the same body through
  // `fromOpenAIStream` to surface what the chat work loop *would* parse —
  // the gap between "what RunPod sent" and "what the app extracted" is
  // exactly where 0-token responses show up.
  const events: RawSseEvent[] = [];
  let rawText = "";
  let nonOkBodySnippet: string | null = null;

  if (!resp.ok) {
    const errText = await resp.text();
    nonOkBodySnippet =
      errText.length > PREVIEW_BODY_BYTES
        ? errText.slice(0, PREVIEW_BODY_BYTES) + "…"
        : errText;
    return Response.json({
      action,
      ok: false,
      request: {
        url,
        method: "POST",
        headers: redactedRequestHeaders(requestHeaders),
        body: openAIBody,
      },
      response: {
        status: resp.status,
        statusText: resp.statusText,
        headers: readableHeaders(resp.headers),
        bodyText: nonOkBodySnippet,
      },
      events,
      timing: {
        headersMs: headersDurationMs,
        totalMs: Math.round(performance.now() - t0),
      },
    });
  }

  if (!resp.body) {
    return Response.json({
      action,
      ok: false,
      request: {
        url,
        method: "POST",
        headers: redactedRequestHeaders(requestHeaders),
        body: openAIBody,
      },
      response: {
        status: resp.status,
        statusText: resp.statusText,
        headers: readableHeaders(resp.headers),
      },
      error: "Response had no body.",
      events,
      timing: {
        headersMs: headersDurationMs,
        totalMs: Math.round(performance.now() - t0),
      },
    });
  }

  // Tee the body so both consumers see every byte. One side captures raw
  // events; the other feeds fromOpenAIStream.
  const [streamA, streamB] = resp.body.tee();
  const decoder = new TextDecoder();

  const recordEvents = (async () => {
    const reader = streamA.getReader();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        rawText += chunk;
        buffer += chunk;
        let sep: number;
        while (
          (sep = (() => {
            const a = buffer.indexOf("\n\n");
            const b = buffer.indexOf("\r\n\r\n");
            if (a < 0) return b;
            if (b < 0) return a;
            return Math.min(a, b);
          })()) >= 0
        ) {
          const record = buffer.slice(0, sep);
          buffer = buffer.slice(sep).replace(/^(\r?\n){1,2}/, "");
          for (const line of record.split(/\r?\n/)) {
            const tMs = Math.round(performance.now() - t0);
            if (line.startsWith("data:")) {
              const data = line.slice(5).trimStart();
              let parsed: unknown = undefined;
              if (data && data !== "[DONE]") {
                try {
                  parsed = JSON.parse(data);
                } catch {
                  parsed = undefined;
                }
              }
              events.push(parsed === undefined ? { tMs, data } : { tMs, data, parsed });
            } else if (line.length > 0) {
              events.push({ tMs, data: `<non-data> ${line}` });
            }
          }
        }
      }
      // Any tail content that didn't terminate with a blank line.
      if (buffer.trim().length > 0) {
        events.push({
          tMs: Math.round(performance.now() - t0),
          data: `<unterminated tail> ${buffer.slice(0, 200)}`,
        });
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  })();

  const accumulate = (async () => {
    type Acc = {
      content: string;
      thinking: string;
      promptTokens: number;
      completionTokens: number;
      doneReason: string | null;
      toolCalls: Array<{ name: string; arguments: unknown }>;
      chunkCount: number;
      firstChunkMs: number | null;
      lastChunkMs: number | null;
    };
    const acc: Acc = {
      content: "",
      thinking: "",
      promptTokens: 0,
      completionTokens: 0,
      doneReason: null,
      toolCalls: [],
      chunkCount: 0,
      firstChunkMs: null,
      lastChunkMs: null,
    };
    try {
      for await (const part of fromOpenAIStream(streamB, model)) {
        acc.chunkCount += 1;
        const tNow = Math.round(performance.now() - t0);
        if (acc.firstChunkMs == null) acc.firstChunkMs = tNow;
        acc.lastChunkMs = tNow;
        const msg = (part as { message?: { content?: string; thinking?: string; tool_calls?: unknown[] } })
          .message;
        if (msg?.content) acc.content += msg.content;
        if (msg?.thinking) acc.thinking += msg.thinking;
        if ((part as { done?: boolean }).done) {
          acc.doneReason =
            (part as { done_reason?: string }).done_reason ?? "stop";
          acc.promptTokens =
            (part as { prompt_eval_count?: number }).prompt_eval_count ?? 0;
          acc.completionTokens =
            (part as { eval_count?: number }).eval_count ?? 0;
          if (Array.isArray(msg?.tool_calls)) {
            acc.toolCalls = (msg!.tool_calls as Array<{
              function?: { name?: string; arguments?: unknown };
            }>).map((tc) => ({
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? {},
            }));
          }
        }
      }
      return { ok: true as const, acc };
    } catch (err) {
      return {
        ok: false as const,
        acc,
        error: err instanceof Error ? err.message : "stream parse failed",
      };
    }
  })();

  const [, parsedResult] = await Promise.all([recordEvents, accumulate]);

  return Response.json({
    action,
    ok: true,
    request: {
      url,
      method: "POST",
      headers: redactedRequestHeaders(requestHeaders),
      body: openAIBody,
    },
    response: {
      status: resp.status,
      statusText: resp.statusText,
      headers: readableHeaders(resp.headers),
      bodyText:
        rawText.length > PREVIEW_BODY_BYTES
          ? rawText.slice(0, PREVIEW_BODY_BYTES)
          : rawText,
      bodyTruncated: rawText.length > PREVIEW_BODY_BYTES,
      bodyByteLength: rawText.length,
    },
    events,
    parsedStream: parsedResult,
    timing: {
      headersMs: headersDurationMs,
      totalMs: Math.round(performance.now() - t0),
    },
  });
}

async function runList(cfg: { apiKey: string; base: string; endpointId: string }) {
  const url = `${cfg.base}/models`;
  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    Accept: "application/json",
  };
  const t0 = performance.now();
  let resp: Response;
  try {
    resp = await fetch(url, { method: "GET", headers: requestHeaders });
  } catch (err) {
    return Response.json(
      {
        action: "list" as const,
        request: {
          url,
          method: "GET",
          headers: redactedRequestHeaders(requestHeaders),
        },
        error: err instanceof Error ? `fetch failed: ${err.message}` : "fetch failed",
        durationMs: Math.round(performance.now() - t0),
      },
      { status: 502 }
    );
  }

  const rawText = await resp.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {}

  return Response.json({
    action: "list" as const,
    ok: resp.ok,
    request: {
      url,
      method: "GET",
      headers: redactedRequestHeaders(requestHeaders),
    },
    response: {
      status: resp.status,
      statusText: resp.statusText,
      headers: readableHeaders(resp.headers),
      bodyText:
        rawText.length > PREVIEW_BODY_BYTES
          ? rawText.slice(0, PREVIEW_BODY_BYTES)
          : rawText,
      bodyTruncated: rawText.length > PREVIEW_BODY_BYTES,
      bodyByteLength: rawText.length,
      json: parsed,
    },
    timing: { totalMs: Math.round(performance.now() - t0) },
  });
}
