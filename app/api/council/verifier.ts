// Council VERIFIER. Runs after the user submits framing answers and before
// the round loop. Uses a tight web_search + web_fetch tool loop (modelled on
// `runSubAgent`) to fact-check the user's load-bearing claims so the council
// members and synthesizer argue from sourced reality instead of whatever the
// user happened to assert.
//
// Output is a short markdown brief that the orchestrator injects into the
// member context (every round) and the synthesizer context.

import type { ChatResponse, Message as OllamaMessage, ToolCall } from "ollama";
import {
  chatClientFor,
  isTransientErrorFor,
  withRetry,
} from "@/app/lib/llm/router";
import {
  MAX_FETCH_CHARS,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  executeTool,
} from "@/app/lib/ollama/tools";
import {
  buildVerifierContext,
  VERIFIER_SYSTEM,
} from "@/app/lib/council/prompts";
import type { CouncilFramingPayload } from "@/app/db";

export type RunVerifierOpts = {
  streamId: string;
  /** Model id used for verification — orchestrator passes the synthesizer
   *  model so the most-capable model in the council is doing the fact-check. */
  model: string;
  runpodEndpointId?: string;
  /** Public origin so the tools can build same-origin proxy URLs (only
   *  relevant for image_search, which the verifier doesn't use, but the
   *  executor signature requires it). */
  publicOrigin: string;
  chatTranscript: string;
  framing: CouncilFramingPayload | undefined;
  /** Hard wall-clock cap. Tuned so the verifier fits well inside the council
   *  orchestrator's 300s worker deadline before the round loop starts. */
  budgetMs: number;
  /** Max tool calls the verifier may make. Hard cap on top of the time
   *  budget — a model that issues many quick searches still terminates. */
  maxToolCalls: number;
  /** Hook so the orchestrator can surface per-tool progress as SSE events
   *  alongside the existing council:member events. */
  onToolCall?: (info: {
    callIndex: number;
    name: string;
    args: Record<string, unknown>;
  }) => void;
  onToolResult?: (info: {
    callIndex: number;
    name: string;
    summary?: string;
    error?: string;
  }) => void;
};

export type VerifierResult = {
  /** Markdown brief — the format VERIFIER_SYSTEM asks for. May start with
   *  "NO EXTERNAL CLAIMS TO VERIFY:" when the chat is purely subjective, or
   *  with "INSUFFICIENT EVIDENCE:" when retries were exhausted. */
  findings: string;
  toolCallCount: number;
  elapsedMs: number;
  /** Set when the call failed AND we have no usable brief — caller should
   *  treat the council as running without verifier output. */
  error?: string;
};

const FINALIZE_RESERVE_MS = 8_000;

export async function runCouncilVerifier(
  opts: RunVerifierOpts
): Promise<VerifierResult> {
  const {
    streamId,
    model,
    runpodEndpointId,
    publicOrigin,
    chatTranscript,
    framing,
    budgetMs,
    maxToolCalls,
    onToolCall,
    onToolResult,
  } = opts;

  const startedAt = Date.now();
  const deadlineAt = startedAt + budgetMs;
  const llm = chatClientFor(model, { runpodEndpointId });

  const conv: OllamaMessage[] = [
    { role: "system", content: VERIFIER_SYSTEM },
    {
      role: "user",
      content: buildVerifierContext({ chatTranscript, framing }),
    },
  ];

  const tools = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL];
  let toolCallCount = 0;
  let finalText = "";

  for (let round = 0; round < maxToolCalls + 2; round++) {
    const now = Date.now();
    const timeLeftForFinalize = deadlineAt - now;
    const mustFinalize =
      toolCallCount >= maxToolCalls || timeLeftForFinalize <= FINALIZE_RESERVE_MS;

    if (mustFinalize) {
      conv.push({
        role: "system",
        content:
          "Stop researching now. Using ONLY what you've already gathered, produce your final verifier brief per the VERIFIER instructions above. Do not call any more tools. If your evidence is thin, lead with 'INSUFFICIENT EVIDENCE:' and a one-sentence reason. If there was nothing factual to verify, lead with 'NO EXTERNAL CLAIMS TO VERIFY:'.",
      });
    }

    let resp: ChatResponse;
    try {
      resp = (await withRetry(
        model,
        () =>
          llm.chat({
            model,
            messages: conv,
            tools: mustFinalize ? undefined : tools,
            stream: false,
            think: false,
          }),
        {
          onRetry: (attempt, err) =>
            console.warn(
              `[council ${streamId}] verifier round ${round} transient (attempt ${attempt}): ${
                err instanceof Error ? err.message : String(err)
              }`
            ),
        }
      )) as ChatResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isTransientErrorFor(model, err)) {
        return {
          findings: `INSUFFICIENT EVIDENCE: verifier failed (${message}).`,
          toolCallCount,
          elapsedMs: Date.now() - startedAt,
          error: message,
        };
      }
      // Transient AND withRetry already gave up — soft-fail so the council
      // still runs, just without verifier output.
      return {
        findings: `INSUFFICIENT EVIDENCE: verifier timed out after retries (${message}).`,
        toolCallCount,
        elapsedMs: Date.now() - startedAt,
        error: message,
      };
    }

    const content = (resp.message?.content ?? "").trim();
    const calls = (resp.message?.tool_calls ?? []) as ToolCall[];

    if (mustFinalize || calls.length === 0) {
      finalText = content;
      break;
    }

    conv.push({
      role: "assistant",
      content,
      tool_calls: calls,
    });

    for (const call of calls) {
      if (toolCallCount >= maxToolCalls) break;
      const name = call.function.name;
      const args = (call.function.arguments as Record<string, unknown>) ?? {};
      const callIndex = toolCallCount;
      onToolCall?.({ callIndex, name, args });
      const r = await executeTool(name, args, Math.min(MAX_FETCH_CHARS, 4000), {
        publicOrigin,
      });
      toolCallCount += 1;
      if (r.ok) {
        onToolResult?.({
          callIndex,
          name,
          summary: typeof r.summary === "string" ? r.summary : undefined,
        });
        conv.push({
          role: "tool",
          content: JSON.stringify(r.result),
          tool_name: name,
        } as OllamaMessage);
      } else {
        onToolResult?.({ callIndex, name, error: r.error });
        conv.push({
          role: "tool",
          content: JSON.stringify({ error: r.error }),
          tool_name: name,
        } as OllamaMessage);
      }
    }
  }

  return {
    findings:
      finalText ||
      "INSUFFICIENT EVIDENCE: verifier produced an empty brief.",
    toolCallCount,
    elapsedMs: Date.now() - startedAt,
  };
}
