// Plan-completion verifier. The executor model occasionally does the work
// for several plan steps inside a single Finish (a "fill records 11–25"
// kickoff prompts a MultiEdit that also covers 26–50). The orchestrator
// only marks the step it dispatched as done, so a chain-exhaust pause
// would leave those follow-on steps stranded as pending — the plan card
// shows a Continue CTA for work that's already in the VFS.
//
// This verifier runs on plan exit paths (chain exhausted, step-errored)
// and asks the model whether any remaining steps are already accomplished
// by inspecting the current file state. Steps it confirms are cached and
// re-emitted as plan_step_done with `cached:true` so the client treats
// them like a replayed cached step.

import type { ChatResponse } from "ollama";
import type { VfsContext } from "@/app/lib/ollama/tools";
import { chatClientFor, withRetry } from "@/app/lib/llm/router";
import { stripJsonFences } from "@/app/lib/llm/json";
import type { Plan } from "./prompts";

export type VerifyRemainingOpts = {
  streamId: string;
  model: string;
  runpodEndpointId?: string;
  plan: Plan;
  /** Step ids already marked complete via the normal cache/Finish path. */
  completedStepIds: string[];
  vfsCtx: VfsContext;
};

export type VerifyRemainingResult = {
  /** Subset of remaining step ids whose work the verifier judged complete. */
  confirmedStepIds: string[];
  promptTokens: number;
  completionTokens: number;
};

/** Hard cap on bytes of per-file content embedded in the verifier prompt.
 *  The verifier is a single non-streaming call against the same model the
 *  executor uses, so it needs to fit comfortably alongside the remaining
 *  steps' descriptions without blowing the context budget. */
const FILE_HEAD_CHARS = 12_000;
const MAX_FILES = 20;

const VERIFIER_SYSTEM = `You are the VERIFIER for a plan-mode code edit. The executor finished early with some plan steps still marked pending. Your job: inspect the CURRENT FILE STATE and decide which of the remaining steps are ALREADY ACCOMPLISHED by the files as they stand.

Output STRICT JSON, no prose, no code fences:
{ "done": ["s2", "s4"] }

Rules:
- Include a step id in "done" only when the file content visibly satisfies that step's described change in full. Partial completion does NOT count.
- If you cannot see the relevant files (or they don't exist), do NOT include the id — that step still needs to run.
- Do NOT execute work. You only judge what's already present.
- Bias toward caution. If unsure, omit the id.`;

export async function verifyRemainingSteps(
  opts: VerifyRemainingOpts
): Promise<VerifyRemainingResult> {
  const { streamId, model, runpodEndpointId, plan, completedStepIds, vfsCtx } =
    opts;

  const completedSet = new Set(completedStepIds);
  const remaining = plan.steps.filter((s) => !completedSet.has(s.id));
  if (remaining.length === 0) {
    return { confirmedStepIds: [], promptTokens: 0, completionTokens: 0 };
  }

  // Bias the file snapshot toward files the remaining steps name as targets.
  // Fall back to the entry file when a step has no targetFiles so the
  // verifier still has *something* to read.
  const relevantPaths = new Set<string>();
  for (const step of remaining) {
    for (const p of step.targetFiles) relevantPaths.add(p);
  }
  if (relevantPaths.size === 0 && typeof vfsCtx.entry === "string") {
    relevantPaths.add(vfsCtx.entry);
  }

  const files: { path: string; content: string; truncated: boolean }[] = [];
  for (const path of relevantPaths) {
    const content = vfsCtx.files[path];
    if (typeof content !== "string") continue;
    const truncated = content.length > FILE_HEAD_CHARS;
    files.push({
      path,
      content: truncated ? content.slice(0, FILE_HEAD_CHARS) : content,
      truncated,
    });
    if (files.length >= MAX_FILES) break;
  }

  const stepsBlock = remaining
    .map(
      (s) =>
        `${s.id}: ${s.title}\n  ${s.description}\n  targetFiles: ${
          s.targetFiles.join(", ") || "(none)"
        }`
    )
    .join("\n\n");

  const filesBlock = files.length
    ? files
        .map(
          (f) =>
            `--- ${f.path} ---\n${f.content}${
              f.truncated ? "\n…(truncated)" : ""
            }`
        )
        .join("\n\n")
    : "(no target files exist in the VFS)";

  const userPrompt = [
    `PLAN BRIEF: ${plan.brief}`,
    "",
    "REMAINING STEPS TO CHECK:",
    stepsBlock,
    "",
    "CURRENT FILE STATE:",
    filesBlock,
    "",
    'Return JSON: { "done": [ids…] } listing the step ids that are already fully accomplished.',
  ].join("\n");

  const llm = chatClientFor(model, { runpodEndpointId });
  let resp: ChatResponse;
  try {
    resp = (await withRetry(
      model,
      () =>
        llm.chat({
          model,
          messages: [
            { role: "system", content: VERIFIER_SYSTEM },
            { role: "user", content: userPrompt },
          ],
          stream: false,
          think: false,
          format: "json",
        }),
      {
        onRetry: (attempt, err) =>
          console.warn(
            `[plan ${streamId}] verifier transient (attempt ${attempt}): ${
              err instanceof Error ? err.message : String(err)
            }`
          ),
      }
    )) as ChatResponse;
  } catch (err) {
    // Verifier failure is non-fatal — the plan just pauses as it normally
    // would. Don't let an upstream blip turn a graceful pause into a hard
    // error.
    console.warn(
      `[plan ${streamId}] verifier failed, skipping: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return { confirmedStepIds: [], promptTokens: 0, completionTokens: 0 };
  }

  const raw = resp.message?.content ?? "";
  const cleaned = stripJsonFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      confirmedStepIds: [],
      promptTokens: resp.prompt_eval_count ?? 0,
      completionTokens: resp.eval_count ?? 0,
    };
  }

  const remainingIds = new Set(remaining.map((s) => s.id));
  let confirmedRaw: unknown[] = [];
  if (parsed && typeof parsed === "object") {
    const arr = (parsed as Record<string, unknown>).done;
    if (Array.isArray(arr)) confirmedRaw = arr;
  }
  const confirmedStepIds = confirmedRaw
    .filter((v): v is string => typeof v === "string")
    .filter((id) => remainingIds.has(id));

  return {
    confirmedStepIds,
    promptTokens: resp.prompt_eval_count ?? 0,
    completionTokens: resp.eval_count ?? 0,
  };
}
