// Orchestrates the research pre-synthesis stages. Replaces the original
// one-shot fan-out with an ITERATIVE plan → parallel sub-agents → lead
// reflection loop, modeled on the Claude Research / Gemini orchestrator-
// worker pattern. Each round can re-plan based on prior briefs and gap
// notes; the loop exits when the lead reports coverage is complete, the
// round cap is hit, or the worker's wall-clock budget runs out.
//
// Vercel-safety design: every completed stage is cached in Redis under the
// streamId. If the 250s deadline fires mid-orchestration, we throw
// ResearchHandoffNeededError; work.ts catches it, saves the checkpoint, and
// re-enqueues a fresh worker. The next worker re-enters the orchestrator,
// hydrates the per-round caches from Redis, fast-forwards past completed
// rounds, and resumes from the first uncached stage.

import type { Message as OllamaMessage } from "ollama";
import {
  getStreamScratchpad,
  setStreamScratchpad,
} from "@/app/lib/stream-store";
import { UserStoppedError } from "@/app/api/chat/stop-flag";
import { runPlanner } from "./planner";
import { runReflector } from "./reflector";
import { runSubAgent } from "./subagent";
import {
  buildBriefsContext,
  type PlannerOutput,
  type ReflectionOutput,
  type SubAgentBrief,
} from "./prompts";

const SESSION_KEY = "research:session";
const planKey = (round: number) => `research:round:${round}:plan`;
const briefKey = (round: number, id: string) =>
  `research:round:${round}:brief:${id}`;
const reflectionKey = (round: number) => `research:round:${round}:reflection`;

// How many planner → dispatch → reflect cycles the loop will run in the worst
// case before forcibly synthesizing. Default 4 — research wants to feel
// council-like: initial decomposition, then at least one or two gap-filling
// passes after the lead reflects on what's missing, plus a final
// verification-style pass for load-bearing claims. The reflector still
// short-circuits when coverage is genuinely complete, so easy questions
// don't burn all 4 rounds. Env-tunable for evals without a redeploy.
const DEFAULT_MAX_ROUNDS = Number(process.env.RESEARCH_MAX_ROUNDS ?? 4);

// Per-sub-agent wall-clock cap. Sized so a 4-way parallel batch fits well
// inside the 250s worker deadline with synthesis time to spare. The planner
// + synthesizer outside this take perhaps 5–30s combined.
const SUBAGENT_BUDGET_MS = Number(
  process.env.RESEARCH_SUBAGENT_BUDGET_MS ?? 90_000
);
// Per-sub-agent tool-call cap. Bumped from 6 → 10 so a sub-agent can actually
// follow a thread when the first 2–3 searches surface mixed quality. The
// sub-agent prompt now asks for 3–6 web_search queries followed by 2–4
// web_fetch reads, which doesn't fit under 6 calls.
const SUBAGENT_MAX_TOOL_CALLS = Number(
  process.env.RESEARCH_SUBAGENT_MAX_TOOL_CALLS ?? 10
);

// Stage cost estimates the orchestrator uses to decide whether to start the
// next stage on this worker or hand off. Conservative — the goal is to never
// start a stage we can't finish, since partial work that isn't cached gets
// thrown away when the worker dies.
const PLAN_ESTIMATE_MS = 15_000;
const REFLECT_ESTIMATE_MS = 15_000;
const SUBAGENT_PARALLEL_ESTIMATE_MS = SUBAGENT_BUDGET_MS + 5_000;

export class ResearchHandoffNeededError extends Error {
  constructor(message = "research orchestrator handing off mid-run") {
    super(message);
    this.name = "ResearchHandoffNeededError";
  }
}

/** Emit hook so the worker can surface progress events as SSE without this
 *  module knowing the SSE event format. */
export type ResearchEmit = (event: string, data: unknown) => void;

export type OrchestrateOpts = {
  streamId: string;
  model: string;
  runpodEndpointId?: string;
  publicOrigin: string;
  /** Full conversation (system + history + final user message) as it exists
   *  before the round loop starts. */
  conv: OllamaMessage[];
  /** Original user question — used to seed sub-agent context. Resolved from
   *  the last user-role message in `conv`. */
  userQuestion: string;
  /** Optional user-answered scoping payload from /api/research/framing.
   *  Threaded only into the planner — sub-agents see refined sub-questions
   *  alone so they stay focused on their slice. */
  framing?: {
    rationale: string;
    questions: { id: string; question: string }[];
    answers: Record<string, string>;
  };
  /** Wall-clock timestamp by which the orchestrator must hand off to a
   *  successor worker. Checked before each stage; if a stage's estimated
   *  cost would cross it, we throw ResearchHandoffNeededError. */
  workerDeadlineAt: number;
  /** True when a successor worker slot is available. When false (final
   *  worker in the chain), the orchestrator runs to completion or fails —
   *  there's nowhere to hand off to anyway, so we plow through. */
  canHandoff: boolean;
  /** Mirrors cfg.advancedWebEnabled — when true, sub-agents get the Advanced
   *  Web toolset (headless browser, raw HTTP, sandboxed shell) on top of
   *  web_search/web_fetch. */
  advancedWebEnabled?: boolean;
  emit: ResearchEmit;
  /** Optional user-stop check, polled at stage boundaries. When it resolves
   *  truthy the orchestrator throws UserStoppedError and the run bails at the
   *  next safe point. Used by the chat Structured-research Stop button; chat
   *  deep-research leaves it unset (no per-stage stop affordance there). */
  shouldStop?: () => boolean | Promise<boolean>;
};

type ResearchSession = {
  /** 0-indexed round we will run (or are running) next. Persists across
   *  worker handoffs so a resumed worker resumes from the right round. */
  currentRound: number;
  /** Hard cap on rounds for this session. Captured at session init so an
   *  env-var bump mid-flight doesn't change behavior of an in-flight run. */
  maxRounds: number;
};

export type OrchestrateResult = {
  /** All plans, indexed by round. plansByRound[0] is the initial decomposition;
   *  plansByRound[1..] are gap-filling decompositions from follow-up rounds. */
  plansByRound: PlannerOutput[];
  /** All briefs collected across all rounds, tagged with roundIdx. */
  briefs: SubAgentBrief[];
  /** Lead reflections for each round that ran one (the final round skips
   *  reflection, so this can be one element shorter than plansByRound). */
  reflectionsByRound: ReflectionOutput[];
  /** The synthesizer-facing context block to push into `conv`. */
  briefsContext: string;
};

export async function orchestrateResearch(
  opts: OrchestrateOpts
): Promise<OrchestrateResult> {
  const {
    streamId,
    model,
    runpodEndpointId,
    publicOrigin,
    conv,
    userQuestion,
    framing,
    workerDeadlineAt,
    canHandoff,
    advancedWebEnabled,
    emit,
    shouldStop,
  } = opts;

  // Progress surfaces in the existing timeline as synthetic tool_call /
  // tool_result events. This lets the UI render the agentic flow without a
  // dedicated panel — each stage is a tool-shaped line item with a name
  // prefixed by "research:".
  const stageStart = (name: string, args: Record<string, unknown>) =>
    emit("tool_call", { name: `research:${name}`, args });
  const stageDone = (
    name: string,
    summary: string,
    extra?: Record<string, unknown>
  ) => emit("tool_result", { name: `research:${name}`, summary, ...(extra ?? {}) });

  // Helper that throws ResearchHandoffNeededError if `estimateMs` of work
  // wouldn't fit in the remaining worker budget AND a successor is available.
  // When canHandoff is false we plow through — there's nowhere to hand off
  // to, so the only options are "finish or die trying", and finishing
  // partial work is strictly better.
  const ensureBudgetFor = (estimateMs: number, stage: string) => {
    if (!canHandoff) return;
    const remaining = workerDeadlineAt - Date.now();
    if (remaining < estimateMs) {
      throw new ResearchHandoffNeededError(
        `paused before ${stage}; ~${estimateMs}ms needed, ${remaining}ms remaining`
      );
    }
  };

  // Honor a user Stop at stage boundaries. Throwing UserStoppedError unwinds
  // the loop; the caller surfaces it as a terminal "stopped" outcome. Best-
  // effort like the budget guard — a flaky stop check never wedges the run.
  const ensureNotStopped = async (stage: string) => {
    if (!shouldStop) return;
    let stop = false;
    try {
      stop = await shouldStop();
    } catch {
      stop = false;
    }
    if (stop) throw new UserStoppedError(`Stopped before ${stage}.`);
  };

  // ---- session ----
  // Loaded from scratchpad on a resumed worker so we pick up at the right
  // round. Initialized to {currentRound: 0, maxRounds: DEFAULT} on first run.
  let session = await getStreamScratchpad<ResearchSession>(streamId, SESSION_KEY);
  if (!session) {
    session = { currentRound: 0, maxRounds: DEFAULT_MAX_ROUNDS };
    await setStreamScratchpad(streamId, SESSION_KEY, session);
  }

  const plansByRound: PlannerOutput[] = [];
  const briefs: SubAgentBrief[] = [];
  const reflectionsByRound: ReflectionOutput[] = [];

  // Re-hydrate prior completed rounds from cache. A resumed worker reads
  // these out of Redis instead of re-running planning / sub-agents / reflection
  // for rounds the previous worker already finished. We stop hydration the
  // moment we hit a round that doesn't have a cached plan — that's where
  // the previous worker was killed, and where we'll resume.
  for (let r = 0; r < session.currentRound; r++) {
    const plan = await getStreamScratchpad<PlannerOutput>(streamId, planKey(r));
    if (!plan) break;
    plansByRound.push(plan);
    for (const sq of plan.subQuestions) {
      const brief = await getStreamScratchpad<SubAgentBrief>(
        streamId,
        briefKey(r, sq.id)
      );
      if (brief) briefs.push(brief);
    }
    const reflection = await getStreamScratchpad<ReflectionOutput>(
      streamId,
      reflectionKey(r)
    );
    if (reflection) reflectionsByRound.push(reflection);
  }

  // ---- iteration loop ----
  for (let r = session.currentRound; r < session.maxRounds; r++) {
    await ensureNotStopped(`round ${r + 1}`);
    // ---- plan / replan ----
    let plan = await getStreamScratchpad<PlannerOutput>(streamId, planKey(r));
    if (!plan) {
      ensureBudgetFor(PLAN_ESTIMATE_MS, `round ${r + 1} plan`);
      stageStart("plan", r === 0 ? {} : { round: r + 1, followUp: true });
      const priorRound =
        r === 0
          ? undefined
          : {
              briefs,
              gaps: reflectionsByRound[r - 1]?.gaps ?? [],
              conflicts: reflectionsByRound[r - 1]?.conflicts ?? [],
            };
      plan = await runPlanner({
        streamId,
        model,
        runpodEndpointId,
        conv,
        framing,
        priorRound,
      });
      await setStreamScratchpad(streamId, planKey(r), plan);
    } else {
      stageStart("plan", { round: r + 1, cached: true });
    }
    plansByRound.push(plan);
    stageDone(
      "plan",
      r === 0
        ? `${plan.subQuestions.length} sub-question${plan.subQuestions.length === 1 ? "" : "s"}: ${plan.subQuestions.map((q) => q.question.slice(0, 80)).join(" · ")}`
        : `round ${r + 1} follow-up · ${plan.subQuestions.length} sub-question${plan.subQuestions.length === 1 ? "" : "s"}: ${plan.subQuestions.map((q) => q.question.slice(0, 80)).join(" · ")}`,
      {
        round: r + 1,
        rationale: plan.rationale,
        subQuestions: plan.subQuestions,
      }
    );

    // ---- sub-agents (parallel, each cached individually) ----
    await ensureNotStopped(`round ${r + 1} sub-agents`);
    ensureBudgetFor(SUBAGENT_PARALLEL_ESTIMATE_MS, `round ${r + 1} sub-agents`);
    const roundBriefs: SubAgentBrief[] = await Promise.all(
      plan.subQuestions.map(async (sq): Promise<SubAgentBrief> => {
        const cached = await getStreamScratchpad<SubAgentBrief>(
          streamId,
          briefKey(r, sq.id)
        );
        if (cached) {
          // Patch roundIdx onto legacy briefs (the field is new — older
          // cached blobs in already-running streams won't have it).
          const tagged: SubAgentBrief = { ...cached, roundIdx: r };
          stageStart(`subagent:r${r + 1}/${sq.id}`, {
            question: sq.question,
            round: r + 1,
            cached: true,
          });
          stageDone(
            `subagent:r${r + 1}/${sq.id}`,
            `cached · ${tagged.toolCallCount} tool calls · ${tagged.brief.slice(0, 160)}`,
            {
              briefPreview: tagged.brief.slice(0, 280),
              elapsedMs: tagged.elapsedMs,
              round: r + 1,
            }
          );
          return tagged;
        }
        stageStart(`subagent:r${r + 1}/${sq.id}`, {
          question: sq.question,
          round: r + 1,
        });
        const raw = await runSubAgent({
          streamId,
          model,
          runpodEndpointId,
          publicOrigin,
          subQuestion: sq,
          userQuestion,
          budgetMs: SUBAGENT_BUDGET_MS,
          maxToolCalls: SUBAGENT_MAX_TOOL_CALLS,
          advancedWebEnabled,
        });
        const brief: SubAgentBrief = { ...raw, roundIdx: r };
        await setStreamScratchpad(streamId, briefKey(r, sq.id), brief);
        stageDone(
          `subagent:r${r + 1}/${sq.id}`,
          `${brief.toolCallCount} tool calls · ${Math.round(brief.elapsedMs / 1000)}s · ${brief.brief.slice(0, 160)}`,
          {
            briefPreview: brief.brief.slice(0, 280),
            elapsedMs: brief.elapsedMs,
            round: r + 1,
          }
        );
        return brief;
      })
    );
    briefs.push(...roundBriefs);

    // ---- decide whether to keep iterating ----
    // The final allowed round skips reflection — there's no follow-up round
    // to inform, so the call would only burn budget. We also exit the loop
    // immediately when the lead says coverage is complete.
    const isLastAllowedRound = r + 1 >= session.maxRounds;
    if (isLastAllowedRound) break;

    let reflection = await getStreamScratchpad<ReflectionOutput>(
      streamId,
      reflectionKey(r)
    );
    if (!reflection) {
      await ensureNotStopped(`round ${r + 1} reflection`);
      ensureBudgetFor(REFLECT_ESTIMATE_MS, `round ${r + 1} reflection`);
      stageStart("reflect", { round: r + 1 });
      reflection = await runReflector({
        streamId,
        model,
        runpodEndpointId,
        userQuestion,
        plansByRound,
        briefs,
        roundIdx: r,
        maxRounds: session.maxRounds,
      });
      await setStreamScratchpad(streamId, reflectionKey(r), reflection);
    } else {
      stageStart("reflect", { round: r + 1, cached: true });
    }
    reflectionsByRound.push(reflection);
    stageDone(
      "reflect",
      `coverage=${reflection.coverage} · ${reflection.shouldContinue ? `continuing (${reflection.gaps.length + reflection.conflicts.length} item${reflection.gaps.length + reflection.conflicts.length === 1 ? "" : "s"} to fill)` : "complete — synthesizing"} · ${reflection.rationale}`,
      {
        round: r + 1,
        coverage: reflection.coverage,
        gaps: reflection.gaps,
        conflicts: reflection.conflicts,
        shouldContinue: reflection.shouldContinue,
      }
    );

    if (!reflection.shouldContinue) break;

    // Advance the session pointer so the next worker resumes from the
    // correct round if we hand off before round r+1's plan is cached.
    session = { ...session, currentRound: r + 1 };
    await setStreamScratchpad(streamId, SESSION_KEY, session);
  }

  return {
    plansByRound,
    briefs,
    reflectionsByRound,
    briefsContext: buildBriefsContext(plansByRound, briefs),
  };
}
