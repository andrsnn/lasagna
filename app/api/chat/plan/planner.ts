// Stage 1 of plan mode: decompose a large coding task into bounded steps.
// One non-streaming JSON-format LLM call. Same shape as the novel outliner,
// scoped to coding: the input is the conversation plus a summary of the
// current VFS (entry path, file sizes, file heads) and the output is a
// validated Plan the orchestrator can iterate over.

import type { ChatResponse, Message as OllamaMessage } from "ollama";
import { chatClientFor, withRetry } from "@/app/lib/llm/router";
import { stripJsonFences } from "@/app/lib/llm/json";
import {
  MAX_PLAN_STEPS,
  MIN_PLAN_STEPS,
  PLANNER_SYSTEM,
  type Plan,
  type PlanStep,
} from "./prompts";

export type VfsSummary = {
  entry: string;
  files: { path: string; size: number; head: string }[];
};

export type RunPlannerOpts = {
  streamId: string;
  model: string;
  runpodEndpointId?: string;
  /** Full conversation. The planner strips the chat-mode system prompt the
   *  same way the novel outliner does — a chat-mode system layered on top of
   *  the planner's JSON-output system reliably steers the model toward prose. */
  conv: OllamaMessage[];
  /** Snapshot of the VFS the orchestrator was handed. The planner reads
   *  file sizes + heads to choose meaningful step boundaries. */
  vfsSummary: VfsSummary;
};

export type PlannerResult = {
  plan: Plan;
  promptTokens: number;
  completionTokens: number;
};

const HEAD_CHARS = 600;
const MAX_FILES_IN_SUMMARY = 20;

export function buildVfsSummary(
  files: Record<string, string>,
  entry: string
): VfsSummary {
  const entries = Object.entries(files);
  // Prefer the entry first, then largest files, capped so a giant VFS
  // doesn't blow the planner's context budget.
  entries.sort((a, b) => {
    if (a[0] === entry) return -1;
    if (b[0] === entry) return 1;
    return b[1].length - a[1].length;
  });
  return {
    entry,
    files: entries.slice(0, MAX_FILES_IN_SUMMARY).map(([path, content]) => ({
      path,
      size: content.length,
      head: content.slice(0, HEAD_CHARS),
    })),
  };
}

export async function runPlanner(opts: RunPlannerOpts): Promise<PlannerResult> {
  const { streamId, model, runpodEndpointId, conv, vfsSummary } = opts;
  const llm = chatClientFor(model, { runpodEndpointId });

  const systemPrompt = PLANNER_SYSTEM
    .replace(/\{\{minSteps\}\}/g, String(MIN_PLAN_STEPS))
    .replace(/\{\{maxSteps\}\}/g, String(MAX_PLAN_STEPS));

  const userOnly = conv.filter((m) => m.role !== "system");

  const vfsBlock = [
    `CURRENT FILES (entry: ${vfsSummary.entry}):`,
    ...vfsSummary.files.map((f) => {
      const headLines = f.head.split("\n").slice(0, 12).join("\n");
      return `--- ${f.path} (${f.size.toLocaleString()} chars) ---\n${headLines}${
        f.head.length > headLines.length || f.size > f.head.length ? "\n…" : ""
      }`;
    }),
    "",
    "Produce the plan now. Output STRICT JSON only.",
  ].join("\n");

  const messages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    ...userOnly,
    { role: "user", content: vfsBlock },
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
          `[plan ${streamId}] planner transient (attempt ${attempt}): ${
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
      `Planner returned non-JSON: ${(err as Error).message} · payload head: ${raw.slice(0, 160)}`
    );
  }

  const plan = validate(parsed);
  return {
    plan,
    promptTokens: resp.prompt_eval_count ?? 0,
    completionTokens: resp.eval_count ?? 0,
  };
}

function validate(raw: unknown): Plan {
  if (!raw || typeof raw !== "object") {
    throw new Error("Plan is not an object");
  }
  const obj = raw as Record<string, unknown>;
  const brief = typeof obj.brief === "string" && obj.brief.trim()
    ? obj.brief.trim()
    : "Apply the requested changes.";

  const stepsRaw = Array.isArray(obj.steps) ? obj.steps : [];
  const steps: PlanStep[] = [];
  for (let i = 0; i < stepsRaw.length && steps.length < MAX_PLAN_STEPS; i++) {
    const item = stepsRaw[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const idCandidate = typeof rec.id === "string" && rec.id.trim()
      ? rec.id.trim()
      : `s${steps.length + 1}`;
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    const description = typeof rec.description === "string" ? rec.description.trim() : "";
    if (!title || !description) continue;

    // Reject "verify" / "test" / "review" steps — they have no executable
    // semantics for our VFS-only tool surface and confuse the executor.
    // Match the keyword anywhere in the title (not just at the start) so
    // composite titles like "Build and verify no crash" get filtered too.
    const lowered = `${title} ${description}`.toLowerCase();
    if (/\b(verify|review|double[- ]?check|qa|validate|smoke[- ]?test|sanity[- ]?check)\b/.test(title.toLowerCase())) {
      continue;
    }
    if (lowered.includes("produce_artifact")) continue;

    const targetFiles = Array.isArray(rec.targetFiles)
      ? rec.targetFiles
          .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
          .map((p) => p.trim())
      : [];
    const estimatedEditsRaw = Number(rec.estimatedEdits);
    const estimatedEdits = Number.isFinite(estimatedEditsRaw)
      ? Math.max(1, Math.min(8, Math.trunc(estimatedEditsRaw)))
      : 3;

    steps.push({
      id: idCandidate,
      title,
      description,
      targetFiles,
      estimatedEdits,
    });
  }

  if (steps.length < MIN_PLAN_STEPS) {
    throw new Error(
      `Plan must include at least ${MIN_PLAN_STEPS} steps; got ${steps.length}`
    );
  }

  // Renumber ids so they're contiguous "s1..sN" regardless of what the
  // model emitted — the orchestrator keys scratchpad cache entries by id
  // and needs stable, predictable values.
  for (let i = 0; i < steps.length; i++) {
    steps[i] = { ...steps[i], id: `s${i + 1}` };
  }

  return { brief, steps };
}
