// Stage 1 of the research flow: decompose the user's question into a
// small set of independent sub-questions that parallel sub-agents will then
// research. One non-streaming LLM call, JSON-formatted output, then we
// validate the shape and clamp to the allowed sub-question count.

import type { ChatResponse, Message as OllamaMessage } from "ollama";
import { chatClientFor, withRetry } from "@/app/lib/llm/router";
import { stripJsonFences } from "@/app/lib/llm/json";
import { renderResearchFramingForPlanner } from "@/app/lib/research/prompts";
import { currentDateSystemLine } from "@/app/lib/system-context";
import {
  PLANNER_SYSTEM,
  type PlannerOutput,
  type SubAgentBrief,
  type SubQuestion,
} from "./prompts";

export type RunPlannerOpts = {
  streamId: string;
  model: string;
  runpodEndpointId?: string;
  /** The full conversation (system + history + final user message). The planner
   *  prepends its own system prompt and feeds in only the user-visible turns;
   *  the chat system prompt would skew it toward chat-style output. */
  conv: OllamaMessage[];
  /** Optional user-answered scoping payload. When present and non-empty, a
   *  RESEARCH SCOPE block is prepended to the planner's user content so the
   *  sub-question decomposition reflects the confirmed scope. */
  framing?: {
    rationale: string;
    questions: { id: string; question: string }[];
    answers: Record<string, string>;
  };
  /** Follow-up rounds only. When present, the planner gets a PRIOR ROUND
   *  block listing previously collected briefs and the lead's gap /
   *  conflict notes, and is asked to emit ONLY the new sub-questions
   *  needed to fill those specific holes. */
  priorRound?: {
    briefs: SubAgentBrief[];
    gaps: string[];
    conflicts: string[];
  };
};

const MIN_SUBQS = 1;
const MAX_SUBQS = 4;

/** Returns a validated PlannerOutput. Throws on hard failure (model unreachable,
 *  unparseable JSON after the retry, empty sub-question list). The caller is
 *  expected to catch and fall back to single-loop research with a logged warning. */
export async function runPlanner(opts: RunPlannerOpts): Promise<PlannerOutput> {
  const { streamId, model, runpodEndpointId, conv, framing, priorRound } = opts;
  const llm = chatClientFor(model, { runpodEndpointId });

  // Strip the original system prompt — it's tuned for the synthesizer and
  // confuses a JSON-output planner. Keep only user / assistant turns.
  const userOnly = conv.filter((m) => m.role !== "system");
  const scopeBlock = renderResearchFramingForPlanner(framing);
  const priorBlock = renderPriorRoundForPlanner(priorRound);
  const messages: OllamaMessage[] = [
    { role: "system", content: `${currentDateSystemLine()}\n\n${PLANNER_SYSTEM}` },
    // Scope block goes as a user-role prefix so the planner reads the
    // confirmed scope before the chat history. Skipped when there's no
    // framing payload — keeps the no-scope case byte-identical to before.
    ...(scopeBlock ? [{ role: "user" as const, content: scopeBlock }] : []),
    // Prior-round block (only set on follow-up rounds) — gives the planner
    // the briefs already collected plus the lead's gap / conflict notes so
    // the new decomposition fills concrete holes instead of repeating work.
    ...(priorBlock ? [{ role: "user" as const, content: priorBlock }] : []),
    ...userOnly,
  ];

  const resp = (await withRetry(
    model,
    () =>
      llm.chat({
        model,
        messages,
        stream: false,
        think: false,
        format: "json",
      }),
    {
      onRetry: (attempt, err) =>
        console.warn(
          `[research ${streamId}] planner transient (attempt ${attempt}): ${
            err instanceof Error ? err.message : String(err)
          }`
        ),
    }
  )) as ChatResponse;

  const raw = resp.message?.content ?? "";
  const cleaned = stripJsonFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `Planner returned non-JSON content: ${(err as Error).message} · payload head: ${raw.slice(0, 160)}`
    );
  }

  return validate(parsed);
}

function validate(raw: unknown): PlannerOutput {
  if (!raw || typeof raw !== "object") {
    throw new Error("Planner output is not an object");
  }
  const obj = raw as Record<string, unknown>;
  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";
  const subQsRaw = Array.isArray(obj.subQuestions) ? obj.subQuestions : null;
  if (!subQsRaw || subQsRaw.length === 0) {
    throw new Error("Planner returned no sub-questions");
  }

  const seen = new Set<string>();
  const subQuestions: SubQuestion[] = [];
  for (let i = 0; i < subQsRaw.length && subQuestions.length < MAX_SUBQS; i++) {
    const item = subQsRaw[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : `q${i + 1}`;
    const question =
      typeof rec.question === "string" ? rec.question.trim() : "";
    if (!question) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    subQuestions.push({ id, question });
  }

  if (subQuestions.length < MIN_SUBQS) {
    throw new Error("Planner sub-questions failed validation (all empty)");
  }
  return { rationale, subQuestions };
}

/** Render the PRIOR ROUND block — only emitted on follow-up rounds. Sits as a
 *  user-role prefix so the planner reads it before the chat history. Returns
 *  the empty string when there's no prior round, so we can omit the message
 *  entirely on round 0 and keep that path byte-identical to single-round mode. */
function renderPriorRoundForPlanner(
  priorRound: RunPlannerOpts["priorRound"]
): string {
  if (!priorRound) return "";
  const { briefs, gaps, conflicts } = priorRound;
  if (briefs.length === 0 && gaps.length === 0 && conflicts.length === 0) {
    return "";
  }
  const lines: string[] = [];
  lines.push("=== PRIOR ROUND ===");
  lines.push(
    "You are running a FOLLOW-UP round. The decomposition below was already explored. Emit ONLY new sub-questions that fill the gaps or resolve the conflicts the lead identified below — do not re-decompose the original question, and do not re-issue sub-questions already adequately covered."
  );
  if (briefs.length > 0) {
    lines.push("");
    lines.push("Prior briefs (truncated to ~600 chars each):");
    for (const b of briefs) {
      const head = b.brief.length > 600 ? `${b.brief.slice(0, 600)}…` : b.brief;
      lines.push(`- [${b.id}] ${b.question}`);
      lines.push(`  ${head.replace(/\n+/g, " ").trim()}`);
    }
  }
  if (gaps.length > 0) {
    lines.push("");
    lines.push("Lead identified GAPS (turn these into sub-questions):");
    for (const g of gaps) lines.push(`- ${g}`);
  }
  if (conflicts.length > 0) {
    lines.push("");
    lines.push("Lead identified CONFLICTS (a sub-question to resolve each):");
    for (const c of conflicts) lines.push(`- ${c}`);
  }
  lines.push("");
  lines.push("Prefer 1–2 sub-questions in this follow-up round. Hard cap: 3.");
  return lines.join("\n");
}
