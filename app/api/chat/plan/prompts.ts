// Prompts + shared types for plan-mode (long-coding-task) orchestration.
// Mirrors the layout of app/api/chat/novel/prompts.ts — the orchestrator
// breaks a large code edit into bounded steps, each step is its own
// constrained agentic sub-call against the VFS tools, and progress is
// cached in the Redis scratchpad so handoffs (and the user-driven
// "Continue plan" button) resume from the first uncached step.

export type PlanStep = {
  /** Stable id, "s1", "s2", … No gaps. */
  id: string;
  /** Short label used in the timeline / progress card. */
  title: string;
  /** 1–3 sentence brief the step executor reads as its only instructions. */
  description: string;
  /** Paths the planner expects this step to touch. Advisory — not enforced. */
  targetFiles: string[];
  /** Rough budget hint (1–8). Bounds the step's inner round loop. */
  estimatedEdits: number;
};

export type Plan = {
  /** One-sentence summary of the overall objective, displayed in the card head. */
  brief: string;
  /** 1–12 bounded steps. */
  steps: PlanStep[];
};

export const MIN_PLAN_STEPS = 1;
export const MAX_PLAN_STEPS = 12;
/** Per-step rounds cap. A focused step that calls (Read?+)MultiEdit+Finish
 *  runs ~2-3 rounds when targetFiles are pre-loaded into the system prompt;
 *  a bulk-data step that fills records one MultiEdit at a time can run
 *  longer. 15 leaves headroom for retries, an empty-turn nudge, and
 *  iterative refinement while still bounding a degenerate loop. */
export const MAX_STEP_ROUNDS = 15;

export const PLANNER_SYSTEM = `You are the PLANNER for a long-running code edit. The user has a large file or set of files and asked for a change that is too big to do in one pass without hitting the per-worker wall-clock budget.

Your only job is to decompose the work into between {{minSteps}} and {{maxSteps}} bounded steps. A WORKER picks them up one at a time and executes each with Read/Edit/MultiEdit/Write tools. The plan is saved server-side and survives worker restarts.

Output STRICT JSON, no prose, no code fences:
{
  "brief": "One sentence describing the overall change.",
  "steps": [
    {
      "id": "s1",
      "title": "Short label (5-8 words).",
      "description": "1-3 sentences. Concrete enough that an executor reading only this string can complete the step. Reference file paths, specific selectors, function names — not vague intent.",
      "targetFiles": ["index.html"],
      "estimatedEdits": 3
    }
  ]
}

Rules:
- Each step modifies a bounded slice of the work — roughly 1–8 Edit/MultiEdit calls. A step that needs more than ~8 edits should be split.
- Each step also has a wall-clock budget of ~3 minutes of model generation. If a step would emit a large volume of text (e.g. generating dozens of records, a long table of data, a big JSON literal, many similar functions), split it by quantity even when it's logically one slice — e.g. "records 1-25", "records 26-50" — so a single worker can finish it. Underestimating volume per step is the most common reason a plan stalls on the final worker.
- Order matters. Later steps may depend on earlier steps' results. Do NOT plan steps in parallel.
- Do NOT include "verify", "test", "review", or "double-check" steps — we cannot execute them.
- Do NOT include a "produce_artifact" or "deliver" step — the orchestrator delivers the final artifact automatically once all steps complete.
- targetFiles lists the file paths the step is expected to touch. If a step is exploratory (Read-only), list the files it expects to inspect.
- Step ids are "s1", "s2", … in order, no gaps.
- A whole-file rewrite is one step, not several, UNLESS the file's contents are bulk data or repeated structure — in that case split by chunks (see the wall-clock rule above).
- 2 steps is fine for moderately-sized work. Reserve the full 12 only for genuinely large changes.`;

/** Cap on per-file content embedded in the step system prompt. Files larger
 *  than this get a head + "use Read with offset to see the rest" hint so the
 *  model can pull in additional context if it really needs it without us
 *  blowing the prompt budget on a giant file by default. */
const PRELOAD_FILE_CHAR_CAP = 24_000;

export type PreloadedFile = {
  path: string;
  /** Line-numbered (cat -n) view, same format Read returns. */
  view: string;
  totalLines: number;
  /** True when `view` only contains the first N lines because the file is too
   *  large to embed wholesale. */
  truncated: boolean;
};

/** System prompt for the per-worker plan agent. Issued ONCE at the start of
 *  the worker and reused across every non-cached step the worker executes —
 *  this is what gives the agent Claude-Code-style memory across steps. Tool
 *  results (Read, Edit, …) from step N stay in the conversation when step N+1
 *  starts, so the model doesn't re-Read files it already has in context.
 *
 *  Preloaded file contents go into the system prompt so they're visible from
 *  the first turn — useful when a step targets files that prior (already
 *  cached) steps touched in an earlier worker. */
export function planAgentSystem(opts: {
  plan: Plan;
  responseFormat: "artifact-edit" | "vfs-edit";
  preloaded?: PreloadedFile[];
}): string {
  const { plan, responseFormat, preloaded } = opts;
  const stepList = plan.steps
    .map(
      (s) =>
        `  - ${s.id}: ${s.title} — targets: ${s.targetFiles.join(", ") || "(tbd)"}`
    )
    .join("\n");
  const surface =
    responseFormat === "artifact-edit"
      ? "This is an artifact edit. The entry file is index.html. Do NOT call produce_artifact — the orchestrator delivers the final HTML once all steps complete."
      : "This is a multi-file VFS edit. Do not deliver a final summary; the orchestrator compiles the per-file diff once all steps complete.";

  const preloadBlock =
    preloaded && preloaded.length > 0
      ? `\n\nPRE-LOADED FILE CONTENTS (current state, reflecting any edits made by earlier steps in prior workers). You may call Edit/MultiEdit on these files directly — the Read-before-Edit guard has been satisfied. Only call Read for files NOT listed below, or to re-fetch portions of a file you've already edited and want to re-inspect.\n\n${preloaded
          .map(
            (f) =>
              `--- ${f.path} (${f.totalLines} lines${f.truncated ? `; truncated to first ~${PRELOAD_FILE_CHAR_CAP} chars — call Read with offset for the rest` : ""}) ---\n${f.view}`
          )
          .join("\n\n")}\n--- end pre-loaded files ---`
      : "";

  return `You are executing a multi-step plan for a long code edit. The user already approved this plan; your job is to work through it one step at a time.

OVERALL OBJECTIVE: ${plan.brief}

PLAN STEPS (the user will tell you when to begin each one):
${stepList}

${surface}

Available tools: Read, Edit, MultiEdit, Write, LS, Glob, Grep, Finish.

How this loop works:
- The user will say "Begin step <id>: ..." with the step's brief.
- Stay focused on the CURRENT step only. Do NOT start the next step's work — the user will explicitly kick it off when ready.
- Tool calls and tool results from prior steps stay visible above. Reuse that context — do not re-Read files you've already Read in this conversation; their contents are still in your context window.
- When the current step's work is complete, call Finish with a 1-sentence summary. The user will then tell you to start the next step.
- If a step requires no changes (the work is already done after inspection, or the description is vacuous), call Finish with a summary explaining why.${preloadBlock}`;
}

/** User message that kicks off one step in the shared-conv design. Pushed by
 *  the orchestrator before each non-cached step. Kept short — the heavy
 *  context lives once in the system prompt above, not duplicated per step. */
export function stepKickoffUser(step: PlanStep): string {
  return `Begin step ${step.id}: ${step.title}

${step.description}

Target files: ${step.targetFiles.join(", ") || "(use LS / Glob to discover)"}
Budget hint: ~${step.estimatedEdits} Edit/MultiEdit calls. When this step's work is complete, call Finish with a 1-sentence summary. Do NOT continue into other plan steps.`;
}

export { PRELOAD_FILE_CHAR_CAP };
