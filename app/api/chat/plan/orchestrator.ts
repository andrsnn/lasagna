// Plan-mode orchestrator: a long coding edit becomes (planner → per-step
// agentic executor → cached step result) and survives worker handoffs.
//
// Structurally mirrors app/api/chat/novel/orchestrator.ts:
//   - Plan cached under "plan:outline" so a successor worker reuses it
//   - Each completed step cached under "plan:step:{id}" with a full VFS
//     file snapshot; a successor worker replays the snapshot into vfsCtx
//     and skips re-executing the step
//   - Between steps, deadline check: PlanHandoffNeededError on workers
//     with a successor, PlanPausedNeedsContinueError on the final worker
//     (the user-facing "Continue plan" button handles the latter)
//
// Coding-specific divergences from novel mode:
//   - Each "chapter" is an agentic sub-loop, not a single LLM call
//   - Output is a mutating VFS, not appended prose
//   - The final worker bails cleanly with caches intact instead of
//     truncating — the work isn't user-readable mid-edit

import type { Message as OllamaMessage } from "ollama";
import type { ArtifactFiles } from "@/app/db";
import type { VfsContext } from "@/app/lib/ollama/tools";
import { formatLineNumbered } from "@/app/lib/artifact/vfs";
import {
  getStreamScratchpad,
  setStreamScratchpad,
} from "@/app/lib/stream-store";
import { buildVfsSummary, runPlanner } from "./planner";
import { isPauseRequested } from "./pause-flag";
import { isStopRequested, UserStoppedError } from "@/app/api/chat/stop-flag";
import { executeStep } from "./step-executor";
import { verifyRemainingSteps } from "./verifier";
import {
  PRELOAD_FILE_CHAR_CAP,
  planAgentSystem,
  stepKickoffUser,
  type Plan,
  type PreloadedFile,
} from "./prompts";

const PLAN_KEY = "plan:outline";
const PLAN_STATE_KEY = "plan:state";
const stepKey = (id: string) => `plan:step:${id}`;

/** Wall-clock reserve before deadlineAt. The orchestrator refuses to START
 *  a new step inside this window; the throw routes via the catch in work.ts
 *  to either performHandoff (mid-chain) or PlanPausedNeedsContinueError
 *  (final worker). 60s is enough for the step to either run to Finish or
 *  abort gracefully on its own deadline check. */
const HANDOFF_RESERVE_MS = Number(
  process.env.PLAN_HANDOFF_RESERVE_MS ?? 60_000
);

export class PlanHandoffNeededError extends Error {
  constructor(public readonly nextStepId: string, message?: string) {
    super(message ?? `plan orchestrator handing off before step ${nextStepId}`);
    this.name = "PlanHandoffNeededError";
  }
}

export class PlanPausedNeedsContinueError extends Error {
  constructor(
    public readonly nextStepId: string,
    public readonly completedStepIds: string[],
    public readonly totalSteps: number,
    message?: string
  ) {
    super(
      message ??
        `plan paused at step ${nextStepId} (${completedStepIds.length}/${totalSteps} done)`
    );
    this.name = "PlanPausedNeedsContinueError";
  }
}

export type PlanStepCache = {
  id: string;
  summary: string;
  filesChanged: string[];
  /** Full VFS file map AFTER the step completed. The successor worker
   *  replays this into vfsCtx so it picks up exactly where the step left
   *  off without re-running the agentic loop. */
  fileSnapshot: ArtifactFiles;
  rounds: number;
  cached?: boolean;
  completedAt: number;
};

export type PlanState = {
  startedAt: number;
  activeStepId?: string;
  completedStepIds: string[];
};

export type OrchestratePlanOpts = {
  streamId: string;
  model: string;
  runpodEndpointId?: string;
  conv: OllamaMessage[];
  vfsCtx: VfsContext;
  responseFormat: "artifact-edit" | "vfs-edit";
  workerDeadlineAt: number;
  canHandoff: boolean;
  isFinalWorker: boolean;
  /** Per-step rounds cap override. Defaults to MAX_STEP_ROUNDS (15). The
   *  Fly-worker path bumps this much higher since the long-lived worker
   *  has no Vercel-style wall clock to defend against. */
  maxStepRounds?: number;
  emit: (event: string, data: unknown) => void;
  onUsage: (delta: { promptTokens: number; completionTokens: number }) => void;
};

export type OrchestratePlanResult = {
  plan: Plan;
  completedStepIds: string[];
};

export async function orchestratePlan(
  opts: OrchestratePlanOpts
): Promise<OrchestratePlanResult> {
  const {
    streamId,
    model,
    runpodEndpointId,
    conv,
    vfsCtx,
    responseFormat,
    workerDeadlineAt,
    canHandoff,
    isFinalWorker,
    maxStepRounds,
    emit,
    onUsage,
  } = opts;

  // ---- plan (cached or fresh) ----
  let plan = await getStreamScratchpad<Plan>(streamId, PLAN_KEY);
  let planJustCreated = false;
  if (!plan) {
    emit("tool_call", { name: "plan:outline", args: { entry: vfsCtx.entry } });
    try {
      const summary = buildVfsSummary(vfsCtx.files, vfsCtx.entry);
      const result = await runPlanner({
        streamId,
        model,
        runpodEndpointId,
        conv,
        vfsSummary: summary,
      });
      plan = result.plan;
      onUsage({
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      });
      planJustCreated = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "planner failed";
      emit("tool_result", { name: "plan:outline", error: message });
      throw err;
    }
    await setStreamScratchpad(streamId, PLAN_KEY, plan);
    emit("tool_result", {
      name: "plan:outline",
      summary: `${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"} · ${plan.brief}`,
    });
  } else {
    emit("tool_call", { name: "plan:outline", args: { cached: true } });
    emit("tool_result", {
      name: "plan:outline",
      summary: `cached · ${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"} · ${plan.brief}`,
      cached: true,
    });
  }

  // Emit the structured plan event after the tool_call/tool_result pair so
  // the client renders the plan card with all steps (including the cached
  // ones) before any per-step events arrive.
  emit("plan_outline", {
    brief: plan.brief,
    steps: plan.steps.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      targetFiles: s.targetFiles,
    })),
    cached: !planJustCreated,
  });

  const state =
    (await getStreamScratchpad<PlanState>(streamId, PLAN_STATE_KEY)) ?? {
      startedAt: Date.now(),
      completedStepIds: [],
    };

  const completed: string[] = [...state.completedStepIds];

  // Capture as a non-null local so the verifier-sweep closure below doesn't
  // have to re-narrow `plan`'s union type at each access.
  const resolvedPlan: Plan = plan;

  // Verifier sweep helper. Called on non-user plan-exit paths (chain
  // exhausted, step errored) to ask the model whether remaining steps are
  // already accomplished by the current file state. The executor sometimes
  // does the work for several steps in one Finish (e.g. a "fill records
  // 11–25" kickoff prompts a MultiEdit covering 26–50); without this sweep
  // those follow-on steps strand as pending and the user sees a Continue
  // CTA for work that's already in the VFS.
  //
  // Mutates `completed` in place, caches each confirmed step under its
  // scratchpad key, and emits plan_step_done(cached:true) so the client's
  // existing replay handler picks them up.
  async function runVerifierSweep(): Promise<void> {
    if (completed.length >= resolvedPlan.steps.length) return;
    try {
      const { confirmedStepIds } = await verifyRemainingSteps({
        streamId,
        model,
        runpodEndpointId,
        plan: resolvedPlan,
        completedStepIds: completed,
        vfsCtx,
      });
      for (const stepId of confirmedStepIds) {
        if (completed.includes(stepId)) continue;
        const step = resolvedPlan.steps.find((s) => s.id === stepId);
        if (!step) continue;
        const cache: PlanStepCache = {
          id: step.id,
          summary: "Already complete — verified by post-run sweep.",
          filesChanged: [],
          fileSnapshot: { ...vfsCtx.files },
          rounds: 0,
          cached: true,
          completedAt: Date.now(),
        };
        await setStreamScratchpad(streamId, stepKey(step.id), cache);
        completed.push(step.id);
        emit("plan_step_done", {
          stepId: step.id,
          summary: cache.summary,
          filesChanged: [],
          rounds: 0,
          cached: true,
        });
      }
      if (confirmedStepIds.length > 0) {
        await setStreamScratchpad(streamId, PLAN_STATE_KEY, {
          ...state,
          completedStepIds: completed,
          activeStepId: undefined,
        });
      }
    } catch (err) {
      console.warn(
        `[plan ${streamId}] verifier sweep threw, ignoring: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  // Build the shared per-worker conversation. Claude-Code-style: one system
  // prompt + one growing conv across every non-cached step this worker runs.
  // Files Read in step N stay in context for step N+1 — the model doesn't
  // burn a round Re-reading. The orchestrator owns `stepConv`; executeStep
  // mutates it during the round loop.
  //
  // Pre-load: include every file referenced by any plan step's targetFiles
  // that currently exists in the VFS. Covers (a) files touched by already-
  // cached steps from a prior worker (so the model sees their CURRENT state
  // without a Read), and (b) files this worker will touch. Also marks them
  // in readPaths so the Read-before-Edit guard passes.
  const preloadPaths = new Set<string>();
  for (const s of plan.steps) {
    for (const p of s.targetFiles) preloadPaths.add(p);
  }
  const preloaded: PreloadedFile[] = [];
  for (const path of preloadPaths) {
    const content = vfsCtx.files[path];
    if (typeof content !== "string") continue;
    const totalLines = content.split("\n").length;
    const truncated = content.length > PRELOAD_FILE_CHAR_CAP;
    const sliceForView = truncated
      ? content.slice(0, PRELOAD_FILE_CHAR_CAP)
      : content;
    preloaded.push({
      path,
      view: formatLineNumbered(sliceForView, 1),
      totalLines,
      truncated,
    });
    vfsCtx.readPaths.add(path);
  }
  const stepConv: OllamaMessage[] = [
    {
      role: "system",
      content: planAgentSystem({ plan, responseFormat, preloaded }),
    },
  ];

  for (const step of plan.steps) {
    const cached = await getStreamScratchpad<PlanStepCache>(
      streamId,
      stepKey(step.id)
    );
    if (cached) {
      // Replay the cached snapshot into vfsCtx so the next non-cached step
      // sees the post-step state. Idempotent: subsequent cached steps
      // overwrite with their own (later) snapshot.
      vfsCtx.files = { ...cached.fileSnapshot };
      // Refresh readPaths from the snapshot so a fresh worker's Edits
      // against these files don't trip the "Read before Edit" guard.
      for (const path of Object.keys(cached.fileSnapshot)) {
        vfsCtx.readPaths.add(path);
      }
      emit("plan_step_done", {
        stepId: step.id,
        summary: cached.summary,
        filesChanged: cached.filesChanged,
        rounds: cached.rounds,
        cached: true,
      });
      if (!completed.includes(step.id)) completed.push(step.id);
      continue;
    }

    // Hard stop from the composer button: the /api/chat/stop endpoint wrote
    // its flag. Distinct from pause — the user wants a terminal error, not
    // a graceful Continue-plan affordance. Persist what we have so a future
    // continue still has somewhere to resume from, then throw.
    if (await isStopRequested(streamId)) {
      await setStreamScratchpad(streamId, PLAN_STATE_KEY, {
        ...state,
        completedStepIds: completed,
        activeStepId: step.id,
      });
      throw new UserStoppedError();
    }

    // User-initiated pause: the /api/chat/plan-pause endpoint wrote a flag
    // into the scratchpad. Bail before starting the step via the same path
    // chain-exhaustion uses — sets `activeStepId` so resume picks up here,
    // throws PlanPausedNeedsContinueError so work.ts emits `plan_paused`,
    // saves the checkpoint, and marks meta error=plan_paused. Bypass the
    // canHandoff fork: a user Stop always means "stop", not "hand off to
    // the next worker and keep going".
    if (await isPauseRequested(streamId)) {
      await setStreamScratchpad(streamId, PLAN_STATE_KEY, {
        ...state,
        completedStepIds: completed,
        activeStepId: step.id,
      });
      throw new PlanPausedNeedsContinueError(
        step.id,
        completed,
        plan.steps.length,
        `plan paused at step ${step.id} by user request`
      );
    }

    // Deadline check BEFORE starting the step. We pick handoff vs. pause
    // based on whether a successor worker is available.
    if (Date.now() + HANDOFF_RESERVE_MS > workerDeadlineAt) {
      if (canHandoff) {
        await setStreamScratchpad(streamId, PLAN_STATE_KEY, {
          ...state,
          completedStepIds: completed,
          activeStepId: step.id,
        });
        throw new PlanHandoffNeededError(step.id);
      }
      if (isFinalWorker) {
        await runVerifierSweep();
        if (completed.length >= plan.steps.length) {
          return { plan, completedStepIds: completed };
        }
        await setStreamScratchpad(streamId, PLAN_STATE_KEY, {
          ...state,
          completedStepIds: completed,
          activeStepId: step.id,
        });
        throw new PlanPausedNeedsContinueError(
          step.id,
          completed,
          plan.steps.length
        );
      }
    }

    emit("plan_step_pending", {
      stepId: step.id,
      title: step.title,
      description: step.description,
      targetFiles: step.targetFiles,
    });

    // Persist activeStepId so a worker watchdog has a marker even if it
    // dies mid-step. The orchestrator clears it after the step caches.
    await setStreamScratchpad(streamId, PLAN_STATE_KEY, {
      ...state,
      completedStepIds: completed,
      activeStepId: step.id,
    });

    // Append this step's kickoff to the shared conv. Prior step's assistant
    // + tool messages (Reads, Edits, Finish) remain ahead of it so the model
    // can see what it already accomplished in this worker.
    stepConv.push({ role: "user", content: stepKickoffUser(step) });

    const result = await executeStep({
      streamId,
      step,
      model,
      runpodEndpointId,
      vfsCtx,
      conv: stepConv,
      deadlineAt: workerDeadlineAt,
      maxRounds: maxStepRounds,
      emit,
      onUsage,
    });

    if (!result.ok && result.reason === "deadline") {
      // The step's own internal deadline check fired (it had partial
      // progress but didn't reach Finish). The edits ARE applied to
      // vfsCtx, but we deliberately do NOT cache this step — the
      // successor worker re-runs it cleanly. We DO checkpoint the
      // partial vfsCtx through the regular checkpoint mechanism (the
      // outer work.ts saveCheckpoint captures it on handoff).
      if (canHandoff) {
        throw new PlanHandoffNeededError(step.id, "step hit own deadline");
      }
      if (isFinalWorker) {
        await runVerifierSweep();
        if (completed.length >= plan.steps.length) {
          return { plan, completedStepIds: completed };
        }
        throw new PlanPausedNeedsContinueError(
          step.id,
          completed,
          plan.steps.length
        );
      }
    }

    if (!result.ok && result.reason === "paused_by_user") {
      // Mid-step user pause. Same partial-state treatment as the deadline
      // path (edits live in vfsCtx, step is NOT cached so resume re-runs
      // it cleanly). Always pause regardless of canHandoff — a user Stop
      // means stop, not hand off and keep going.
      throw new PlanPausedNeedsContinueError(
        step.id,
        completed,
        plan.steps.length,
        `plan paused mid-step ${step.id} by user request`
      );
    }

    if (!result.ok) {
      // tool_error / max_rounds / llm_error: surface as a step-level
      // failure and stop the orchestrator. The user sees the failed
      // step in the timeline and can retry via the existing Continue
      // affordance. We DO NOT cache the step so a retry re-runs it.
      //
      // Before throwing, sweep the remaining steps with the verifier —
      // the executor may have done the failing step's work elsewhere (or
      // a follow-on step is already satisfied by earlier edits) and we'd
      // rather surface the partial success than strand the whole tail.
      await runVerifierSweep();
      emit("plan_step_errored", {
        stepId: step.id,
        error: result.error ?? `step failed: ${result.reason}`,
      });
      throw new Error(
        `Plan step ${step.id} failed (${result.reason}): ${result.error ?? "no detail"}`
      );
    }

    const cache: PlanStepCache = {
      id: step.id,
      summary: result.summary,
      filesChanged: result.filesChanged,
      fileSnapshot: { ...vfsCtx.files },
      rounds: result.rounds,
      completedAt: Date.now(),
    };
    await setStreamScratchpad(streamId, stepKey(step.id), cache);

    if (!completed.includes(step.id)) completed.push(step.id);
    await setStreamScratchpad(streamId, PLAN_STATE_KEY, {
      ...state,
      completedStepIds: completed,
      activeStepId: undefined,
    });

    emit("plan_step_done", {
      stepId: step.id,
      summary: result.summary,
      filesChanged: result.filesChanged,
      rounds: result.rounds,
    });
  }

  return { plan, completedStepIds: completed };
}
