// Stage 0 of the novel flow: upfront web research before the outliner runs.
// Mirrors chapter.ts's per-chapter research pass but is scoped to the
// novel's PREMISE — so the outliner has real-world grounding when it
// invents setting, characters, and chapter beats. Always runs when novel
// mode is on (per product decision), capped at PREMISE_MAX_WEB_SEARCHES.
//
// Returns a "research note" (plain text, no citations) the outliner
// folds into its system context, plus the list of searches issued for
// timeline display in the UI.

import type { ChatResponse, Message as OllamaMessage, ToolCall } from "ollama";
import { chatClientFor, isTransientErrorFor, withRetry } from "@/app/lib/llm/router";
import { WEB_SEARCH_TOOL, executeTool } from "@/app/lib/ollama/tools";
import { PREMISE_RESEARCH_SYSTEM } from "./prompts";

export const PREMISE_MAX_WEB_SEARCHES = 3;

export type PremiseSearch = { query: string; summary: string; error?: string };

export type RunPremiseResearchOpts = {
  streamId: string;
  model: string;
  runpodEndpointId?: string;
  publicOrigin: string;
  /** Full user/assistant conversation. System messages are stripped — the
   *  research pass brings its own system prompt. */
  conv: OllamaMessage[];
  /** Optional callback for streaming timeline events (web_search calls) to
   *  the client while research is happening. The non-streaming /api/novel/outline
   *  endpoint passes a no-op; resumable streams pass an emit closure. */
  emit?: (event: string, data: unknown) => void;
};

export type PremiseResearchResult = {
  /** The plain-text research note. Equals "NO_RESEARCH_NEEDED" if the model
   *  decided the premise didn't need grounding. */
  note: string;
  /** Web searches the model issued. Useful for surfacing in the UI so the
   *  user can see what was looked up. */
  searches: PremiseSearch[];
  promptTokens: number;
  completionTokens: number;
};

export async function runPremiseResearch(
  opts: RunPremiseResearchOpts
): Promise<PremiseResearchResult> {
  const { streamId, model, runpodEndpointId, publicOrigin, conv, emit } = opts;
  const llm = chatClientFor(model, { runpodEndpointId });

  const userOnly = conv.filter((m) => m.role !== "system");
  const researchConv: OllamaMessage[] = [
    { role: "system", content: PREMISE_RESEARCH_SYSTEM },
    ...userOnly,
    {
      role: "user",
      content: `Based on the premise above, decide whether real-world grounding would help an outliner. If yes, issue up to ${PREMISE_MAX_WEB_SEARCHES} web_search calls and then emit the RESEARCH NOTE. If not, emit "NO_RESEARCH_NEEDED" with no searches.`,
    },
  ];

  const searches: PremiseSearch[] = [];
  let webSearchCount = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let note = "NO_RESEARCH_NEEDED";

  for (let round = 0; round <= PREMISE_MAX_WEB_SEARCHES + 1; round++) {
    const mustFinalize = webSearchCount >= PREMISE_MAX_WEB_SEARCHES;
    if (mustFinalize) {
      researchConv.push({
        role: "system",
        content:
          "You have used your research budget. Emit the RESEARCH NOTE now using only what you've already gathered, or 'NO_RESEARCH_NEEDED'. Do not call any more tools.",
      });
    }

    let resp: ChatResponse;
    try {
      resp = (await withRetry(
        model,
        () =>
          llm.chat({
            model,
            messages: researchConv,
            tools: mustFinalize ? undefined : [WEB_SEARCH_TOOL],
            stream: false,
            think: false,
          }),
        {
          onRetry: (attempt, err) =>
            console.warn(
              `[novel ${streamId}] premise research transient (attempt ${attempt}): ${
                err instanceof Error ? err.message : String(err)
              }`
            ),
        }
      )) as ChatResponse;
    } catch (err) {
      if (!isTransientErrorFor(model, err)) {
        // Non-transient failure: bail with whatever we have. The outliner
        // can still run without a research note.
        console.warn(
          `[novel ${streamId}] premise research failed; outlining without research: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return {
          note,
          searches,
          promptTokens,
          completionTokens,
        };
      }
      throw err;
    }

    promptTokens += resp.prompt_eval_count ?? 0;
    completionTokens += resp.eval_count ?? 0;

    const content = (resp.message?.content ?? "").trim();
    const calls = (resp.message?.tool_calls ?? []) as ToolCall[];

    if (mustFinalize || calls.length === 0) {
      if (content) note = content;
      break;
    }

    researchConv.push({
      role: "assistant",
      content,
      tool_calls: calls,
    });

    for (const call of calls) {
      if (webSearchCount >= PREMISE_MAX_WEB_SEARCHES) break;
      const name = call.function.name;
      const args = (call.function.arguments as Record<string, unknown>) ?? {};
      const query = typeof args.query === "string" ? args.query : "";
      const evName = "novel:premise:web_search";
      emit?.("tool_call", { name: evName, args });
      const r = await executeTool(name, args, 2000, { publicOrigin });
      webSearchCount += 1;
      if (r.ok) {
        emit?.("tool_result", { name: evName, summary: r.summary });
        searches.push({ query, summary: r.summary ?? "" });
        researchConv.push({
          role: "tool",
          content: JSON.stringify(r.result),
          tool_name: name,
        } as OllamaMessage);
      } else {
        emit?.("tool_result", { name: evName, error: r.error });
        searches.push({ query, summary: "", error: r.error });
        researchConv.push({
          role: "tool",
          content: JSON.stringify({ error: r.error }),
          tool_name: name,
        } as OllamaMessage);
      }
    }
  }

  return { note, searches, promptTokens, completionTokens };
}
