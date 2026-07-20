// Stage 2.5 of the research flow: the LEAD's reflection step. After a
// parallel batch of sub-agents returns, the lead reads the briefs and decides
// whether enough has been learned to answer the user's question or whether
// one more targeted round of research is needed. Single non-streaming JSON
// call, no tools — pure analysis over the briefs already gathered.

import type { ChatResponse, Message as OllamaMessage } from "ollama";
import { chatClientFor, withRetry } from "@/app/lib/llm/router";
import { stripJsonFences } from "@/app/lib/llm/json";
import {
  REFLECTOR_SYSTEM,
  type PlannerOutput,
  type ReflectionOutput,
  type SubAgentBrief,
} from "./prompts";

export type RunReflectorOpts = {
  streamId: string;
  model: string;
  runpodEndpointId?: string;
  /** Original user question — gives the lead enough context to judge whether
   *  the briefs actually answer what was asked, vs. answering tangents. */
  userQuestion: string;
  /** Plans collected so far, one per round. Lets the reflector see what was
   *  asked across rounds, not just the current round, when deciding coverage. */
  plansByRound: PlannerOutput[];
  /** All briefs collected so far across all completed rounds. */
  briefs: SubAgentBrief[];
  /** Which round we just finished (0-indexed). Used to label the reflection
   *  prompt and short-circuit if there's no room left for follow-up rounds. */
  roundIdx: number;
  /** Total round budget — the lead is told how many rounds remain so it can
   *  prefer "complete" when there's no point requesting more. */
  maxRounds: number;
};

const HARD_GAP_CAP = 3;

export async function runReflector(opts: RunReflectorOpts): Promise<ReflectionOutput> {
  const {
    streamId,
    model,
    runpodEndpointId,
    userQuestion,
    plansByRound,
    briefs,
    roundIdx,
    maxRounds,
  } = opts;
  const llm = chatClientFor(model, { runpodEndpointId });

  const roundsLeft = Math.max(0, maxRounds - roundIdx - 1);
  const lines: string[] = [];
  lines.push(`=== ORIGINAL USER QUESTION ===`);
  lines.push(userQuestion);
  lines.push("");
  lines.push(`=== RESEARCH SO FAR ===`);
  lines.push(
    `Just finished round ${roundIdx + 1} of up to ${maxRounds}. ${roundsLeft === 0 ? "NO follow-up rounds available — set shouldContinue=false." : `${roundsLeft} follow-up round${roundsLeft === 1 ? "" : "s"} available if needed.`}`
  );
  lines.push("");
  for (let r = 0; r < plansByRound.length; r++) {
    const plan = plansByRound[r];
    const roundBriefs = briefs.filter((b) => b.roundIdx === r);
    if (roundBriefs.length === 0) continue;
    lines.push(`Round ${r + 1} rationale: ${plan.rationale}`);
    for (const b of roundBriefs) {
      const head = b.brief.length > 800 ? `${b.brief.slice(0, 800)}…` : b.brief;
      lines.push(`--- [r${r + 1}/${b.id}] ${b.question} ---`);
      lines.push(head);
      lines.push("");
    }
  }
  lines.push("=== END RESEARCH SO FAR ===");
  lines.push("");
  lines.push(
    "Decide coverage and emit STRICT JSON per your system instructions. Remember: only request another round when a gap is concrete and load-bearing for the original question."
  );

  const messages: OllamaMessage[] = [
    { role: "system", content: REFLECTOR_SYSTEM },
    { role: "user", content: lines.join("\n") },
  ];

  let resp: ChatResponse;
  try {
    resp = (await withRetry(
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
            `[research ${streamId}] reflector transient (attempt ${attempt}): ${
              err instanceof Error ? err.message : String(err)
            }`
          ),
      }
    )) as ChatResponse;
  } catch (err) {
    // Reflection failure is non-fatal — treat it as "complete" so we exit
    // the loop and let the synthesizer work with what it has.
    console.warn(
      `[research ${streamId}] reflector failed; defaulting to coverage=complete`,
      err
    );
    return {
      coverage: "complete",
      gaps: [],
      conflicts: [],
      shouldContinue: false,
      rationale: "reflector unreachable — proceeding to synthesis",
    };
  }

  const raw = resp.message?.content ?? "";
  try {
    return validate(JSON.parse(stripJsonFences(raw)), roundsLeft);
  } catch (err) {
    console.warn(
      `[research ${streamId}] reflector returned unparseable output: ${(err as Error).message} · head: ${raw.slice(0, 160)}`
    );
    return {
      coverage: "complete",
      gaps: [],
      conflicts: [],
      shouldContinue: false,
      rationale: "reflector output unparseable — proceeding to synthesis",
    };
  }
}

function validate(raw: unknown, roundsLeft: number): ReflectionOutput {
  if (!raw || typeof raw !== "object") {
    throw new Error("reflector output is not an object");
  }
  const obj = raw as Record<string, unknown>;
  const coverageRaw = typeof obj.coverage === "string" ? obj.coverage.trim() : "";
  const coverage: ReflectionOutput["coverage"] =
    coverageRaw === "complete" || coverageRaw === "gaps" || coverageRaw === "conflicts"
      ? coverageRaw
      : "complete";
  const gaps = Array.isArray(obj.gaps)
    ? obj.gaps
        .filter((g): g is string => typeof g === "string" && g.trim().length > 0)
        .map((g) => g.trim())
        .slice(0, HARD_GAP_CAP)
    : [];
  const conflicts = Array.isArray(obj.conflicts)
    ? obj.conflicts
        .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
        .map((c) => c.trim())
        .slice(0, HARD_GAP_CAP)
    : [];
  // Trust the model's signal but never continue when no rounds remain or
  // when there's nothing concrete to chase — both would just burn budget.
  const wantsContinue = obj.shouldContinue === true;
  const shouldContinue =
    wantsContinue && roundsLeft > 0 && gaps.length + conflicts.length > 0;
  const rationale =
    typeof obj.rationale === "string" ? obj.rationale.trim() : "";
  return { coverage, gaps, conflicts, shouldContinue, rationale };
}
