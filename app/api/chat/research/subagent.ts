// Stage 2 of the research flow: a single research sub-agent. Runs its
// own tiny tool loop with web_search + web_fetch, capped by a tool-call budget
// AND a wall-clock budget so a parallel batch fits inside the main worker's
// 250s Vercel timeout. Output is a tight markdown brief that the synthesizer
// will combine with peer briefs.

import type { ChatResponse, Message as OllamaMessage, ToolCall } from "ollama";
import { chatClientFor, withRetry, isTransientErrorFor } from "@/app/lib/llm/router";
import { WEB_SEARCH_TOOL, WEB_FETCH_TOOL, ADVANCED_WEB_TOOLS, executeTool, MAX_FETCH_CHARS } from "@/app/lib/ollama/tools";
import { SUBAGENT_SYSTEM, type SubAgentBrief, type SubQuestion } from "./prompts";
import { currentDateSystemLine } from "@/app/lib/system-context";

// The sub-agent doesn't know which research round it belongs to — that's the
// orchestrator's bookkeeping. We return a brief without `roundIdx` and let
// the orchestrator stamp the round before persisting.
export type SubAgentBriefRaw = Omit<SubAgentBrief, "roundIdx">;

export type RunSubAgentOpts = {
  streamId: string;
  model: string;
  runpodEndpointId?: string;
  publicOrigin: string;
  /** The single sub-question this agent investigates. */
  subQuestion: SubQuestion;
  /** Original user question — gives the agent enough context to interpret
   *  ambiguous sub-questions. */
  userQuestion: string;
  /** Hard wall-clock cap for this sub-agent. Tuned so a 4-way parallel batch
   *  finishes well inside the 250s worker deadline (gives the synthesizer
   *  time to run before the chain has to hand off). */
  budgetMs: number;
  /** Max tool calls this sub-agent may make. Hard cap on top of the time
   *  budget — a model that issues many quick searches still terminates. */
  maxToolCalls: number;
  /** When true, the sub-agent also gets the Advanced Web tools (browse_page /
   *  http_request / run_command) on top of web_search/web_fetch — so a research
   *  run can render JS sites, hit APIs, and run allow-listed commands while
   *  gathering evidence. Screenshots are skipped here (briefs are text-only). */
  advancedWebEnabled?: boolean;
};

const FINALIZE_RESERVE_MS = 8_000;

export async function runSubAgent(opts: RunSubAgentOpts): Promise<SubAgentBriefRaw> {
  const {
    streamId,
    model,
    runpodEndpointId,
    publicOrigin,
    subQuestion,
    userQuestion,
    budgetMs,
    maxToolCalls,
    advancedWebEnabled,
  } = opts;

  const startedAt = Date.now();
  const deadlineAt = startedAt + budgetMs;
  const llm = chatClientFor(model, { runpodEndpointId });

  const conv: OllamaMessage[] = [
    { role: "system", content: `${currentDateSystemLine()}\n\n${SUBAGENT_SYSTEM}` },
    {
      role: "user",
      content: [
        `ORIGINAL USER QUESTION (for context only — do NOT answer this directly):`,
        userQuestion,
        ``,
        `YOUR ASSIGNED SUB-QUESTION (this is what you investigate and brief on):`,
        subQuestion.question,
      ].join("\n"),
    },
  ];

  const tools = advancedWebEnabled
    ? [WEB_SEARCH_TOOL, WEB_FETCH_TOOL, ...ADVANCED_WEB_TOOLS]
    : [WEB_SEARCH_TOOL, WEB_FETCH_TOOL];
  let toolCallCount = 0;
  let finalText = "";

  // Tight loop: at each turn, call the model. If it returned tool calls,
  // execute them and continue. If it returned content with no tool calls,
  // that's the brief. If we hit the budget or call cap, ask the model to
  // wrap up with what it has.
  for (let round = 0; round < maxToolCalls + 2; round++) {
    const now = Date.now();
    const timeLeftForFinalize = deadlineAt - now;
    const mustFinalize =
      toolCallCount >= maxToolCalls || timeLeftForFinalize <= FINALIZE_RESERVE_MS;

    if (mustFinalize) {
      // Push a forced-finalize directive: no more tool calls, just the brief.
      conv.push({
        role: "system",
        content:
          "Stop researching now. Using ONLY what you've already gathered, produce your final brief per the SUBAGENT instructions above. Do not call any more tools. Transcribe every concrete data point you actually saw — prices, dimensions, dates, specs, quotes — directly into the brief, with inline citations; do not summarize your search or describe what the sources discussed. If your evidence is thin, lead with 'INSUFFICIENT EVIDENCE:' and a one-sentence reason about YOUR sub-question only.",
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
              `[research ${streamId}] sub-agent ${subQuestion.id} round ${round} transient (attempt ${attempt}): ${
                err instanceof Error ? err.message : String(err)
              }`
            ),
        }
      )) as ChatResponse;
    } catch (err) {
      // Non-transient or retries exhausted — return what we have if we got
      // any partial draft, otherwise surface as insufficient evidence.
      const message = err instanceof Error ? err.message : String(err);
      if (!isTransientErrorFor(model, err)) {
        return {
          id: subQuestion.id,
          question: subQuestion.question,
          brief: `INSUFFICIENT EVIDENCE: sub-agent failed (${message}).`,
          elapsedMs: Date.now() - startedAt,
          toolCallCount,
        };
      }
      throw err;
    }

    const content = (resp.message?.content ?? "").trim();
    const calls = (resp.message?.tool_calls ?? []) as ToolCall[];

    if (mustFinalize || calls.length === 0) {
      finalText = content;
      break;
    }

    // Execute each tool call sequentially, appending tool results to conv.
    conv.push({
      role: "assistant",
      content,
      tool_calls: calls,
    });

    for (const call of calls) {
      if (toolCallCount >= maxToolCalls) break;
      const name = call.function.name;
      const args = call.function.arguments as Record<string, unknown>;
      // Keep individual tool results small — the brief is short, and a
      // sub-agent's context window doesn't need to carry a full page.
      const r = await executeTool(name, args, Math.min(MAX_FETCH_CHARS, 4000), {
        publicOrigin,
      });
      toolCallCount += 1;
      if (r.ok) {
        conv.push({
          role: "tool",
          content: JSON.stringify(r.result),
          tool_name: name,
        } as OllamaMessage);
      } else {
        conv.push({
          role: "tool",
          content: JSON.stringify({ error: r.error }),
          tool_name: name,
        } as OllamaMessage);
      }
    }
  }

  return {
    id: subQuestion.id,
    question: subQuestion.question,
    brief:
      finalText || `INSUFFICIENT EVIDENCE: sub-agent produced an empty brief.`,
    elapsedMs: Date.now() - startedAt,
    toolCallCount,
  };
}
