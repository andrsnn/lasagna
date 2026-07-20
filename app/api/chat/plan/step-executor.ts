// Per-step agentic sub-loop. Constrained copy of the VFS-only round loop
// in app/api/chat/work.ts, narrowed to what one step needs:
//   - VFS tools only (Read / Edit / MultiEdit / Write / Script / LS / Glob / Grep / Finish)
//   - non-streaming chat calls (the step doesn't emit user-facing prose,
//     just tool-driven edits — streaming would only complicate abort logic)
//   - bounded max-rounds with a deadline check between rounds
//   - no parser, no queue drain, no image preprocessing, no produce_artifact
//
// Claude-Code-style shared conversation: the executor RECEIVES the running
// `conv` from the orchestrator (which holds one conv per worker, populated
// with the plan agent system prompt + a per-step kickoff user message).
// The executor mutates `conv` in place during the round loop — appending
// assistant + tool messages — so the NEXT step's executor inherits the
// tool results (file Reads, prior edits) from this step and the model
// doesn't burn a round Re-reading files it already has in context.
//
// The executor mutates `vfsCtx.files` in place (the same context the outer
// runChatWork holds). `emit` forwards the per-tool SSE events into the
// outer worker's batcher with `stepId` tagged on the args so the client can
// attribute work to the step that produced it.

import type {
  ChatResponse,
  Message as OllamaMessage,
  Tool,
  ToolCall,
} from "ollama";
import { chatClientFor, optionsForModel, withRetry } from "@/app/lib/llm/router";
import {
  VFS_TOOLS,
  VFS_TOOL_NAMES,
  executeVfsTool,
  type VfsContext,
} from "@/app/lib/ollama/tools";
import { isPauseRequested } from "./pause-flag";
import { isStopRequested, UserStoppedError } from "@/app/api/chat/stop-flag";
import {
  MAX_STEP_ROUNDS,
  type PlanStep,
} from "./prompts";

export type StepEmit = (event: string, data: unknown) => void;

export type StepExecOpts = {
  streamId: string;
  step: PlanStep;
  model: string;
  runpodEndpointId?: string;
  /** Mutated in place — the orchestrator passes the same VfsContext that
   *  the outer runChatWork holds. */
  vfsCtx: VfsContext;
  /** Shared running conversation. The orchestrator owns it (one per worker)
   *  and pre-seeds it with the plan-agent system prompt + this step's
   *  kickoff user message. The executor appends assistant + tool messages
   *  to it during the round loop; the next step's executor inherits those
   *  messages so the model retains its tool-result memory across steps. */
  conv: OllamaMessage[];
  /** Wall-clock ms at which this worker must hand off / pause. The executor
   *  checks before each LLM call and bails with reason="deadline" if the
   *  next call would cross it. */
  deadlineAt: number;
  /** Hard cap on rounds. Defaults to MAX_STEP_ROUNDS. */
  maxRounds?: number;
  emit: StepEmit;
  onUsage: (delta: { promptTokens: number; completionTokens: number }) => void;
};

export type StepExecResult =
  | {
      ok: true;
      summary: string;
      filesChanged: string[];
      rounds: number;
    }
  | {
      ok: false;
      reason:
        | "deadline"
        | "max_rounds"
        | "tool_error"
        | "llm_error"
        | "paused_by_user";
      partial: { filesChanged: string[]; rounds: number };
      error?: string;
    };

/** Time we keep in reserve before deadlineAt — a non-streaming chat call
 *  typically returns in 5–60s. Sized so a round that just started has time
 *  to either return or get cancelled by the outer worker's heartbeat. */
const STEP_DEADLINE_RESERVE_MS = 30_000;

export async function executeStep(
  opts: StepExecOpts
): Promise<StepExecResult> {
  const {
    streamId,
    step,
    model,
    runpodEndpointId,
    vfsCtx,
    conv,
    deadlineAt,
    emit,
    onUsage,
  } = opts;
  const maxRounds = opts.maxRounds ?? MAX_STEP_ROUNDS;

  const llm = chatClientFor(model, { runpodEndpointId });

  const tools: Tool[] = VFS_TOOLS;
  const filesChangedSet = new Set<string>();
  let finishSummary = "";
  // Tracks a no-tool-no-content round so we can nudge once and bail if it
  // happens twice in a row. Without this, an early "soft success" silently
  // swallows a turn where Kimi blew its think-token budget without emitting
  // anything actionable — the orchestrator caches that as success and the
  // next step inherits a confused chat-template (user → user with no
  // assistant in between).
  let sawEmptyTurn = false;

  for (let round = 0; round < maxRounds; round++) {
    if (Date.now() + STEP_DEADLINE_RESERVE_MS > deadlineAt) {
      return {
        ok: false,
        reason: "deadline",
        partial: {
          filesChanged: Array.from(filesChangedSet),
          rounds: round,
        },
      };
    }

    // Composer Stop button — same priority as the deadline / pause checks
    // above. Throws straight to the outer work.ts catch (rather than going
    // through the orchestrator's plan_paused path) so the bubble lands in
    // the standard errored shape instead of looking like a graceful pause.
    if (await isStopRequested(streamId)) {
      throw new UserStoppedError();
    }

    if (await isPauseRequested(streamId)) {
      return {
        ok: false,
        reason: "paused_by_user",
        partial: {
          filesChanged: Array.from(filesChangedSet),
          rounds: round,
        },
      };
    }

    let resp: ChatResponse;
    try {
      resp = (await withRetry(
        model,
        () =>
          llm.chat({
            model,
            messages: conv,
            tools,
            think: true,
            stream: false,
            options: optionsForModel(model),
          }),
        {
          onRetry: (attempt, err) =>
            console.warn(
              `[plan ${streamId}] step ${step.id} round ${round} transient (attempt ${attempt}): ${
                err instanceof Error ? err.message : String(err)
              }`
            ),
        }
      )) as ChatResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        reason: "llm_error",
        partial: {
          filesChanged: Array.from(filesChangedSet),
          rounds: round,
        },
        error: message,
      };
    }

    onUsage({
      promptTokens: resp.prompt_eval_count ?? 0,
      completionTokens: resp.eval_count ?? 0,
    });

    const toolCalls = (resp.message?.tool_calls ?? []) as ToolCall[];
    const content = resp.message?.content ?? "";

    if (toolCalls.length === 0) {
      // Always push the assistant turn (even if empty) so the shared conv
      // stays well-formed for the next step's executor — without this, the
      // next step's user kickoff lands directly after this step's user
      // kickoff with no assistant in between, which Ollama's chat template
      // treats as a malformed conversation and Kimi typically responds to
      // by spiraling through pointless tool calls until max_rounds.
      conv.push({ role: "assistant", content });

      if (content.trim().length > 0) {
        // Model gave a prose-only response — typically "the step is already
        // done" or a refusal to act. Trust it and advance; the orchestrator
        // will cache and move on, and the explanation stays in conv for the
        // next step to read.
        return {
          ok: true,
          summary: content.trim().slice(0, 200),
          filesChanged: Array.from(filesChangedSet),
          rounds: round + 1,
        };
      }

      // Empty content AND no tools. First occurrence: nudge the model and
      // retry. Second occurrence in a row: bail as max_rounds so the user
      // sees a real failure instead of a silent "no tool calls issued"
      // success that hides un-done work.
      if (sawEmptyTurn) {
        return {
          ok: false,
          reason: "max_rounds",
          partial: {
            filesChanged: Array.from(filesChangedSet),
            rounds: round + 1,
          },
          error: `Step ${step.id}: model emitted two consecutive turns with no tool calls and no prose (likely a think-budget blowout). Aborting.`,
        };
      }
      sawEmptyTurn = true;
      conv.push({
        role: "user",
        content:
          "You produced no tool calls and no prose. Either call Finish if the step is genuinely complete, or call Read/Edit/MultiEdit/Script to do the actual work for this step. Do not respond with empty content again.",
      });
      continue;
    }
    sawEmptyTurn = false;

    conv.push({
      role: "assistant",
      content,
      tool_calls: toolCalls,
    });

    let finishedThisRound = false;
    for (const call of toolCalls) {
      const name = call.function.name;
      const args = call.function.arguments as Record<string, unknown>;

      emit("tool_call", { name, args: { ...args, stepId: step.id } });

      if (!VFS_TOOL_NAMES.has(name)) {
        const errMsg = `Tool ${name} is not available in plan-step mode. Use Read/Edit/MultiEdit/Write/Script/LS/Glob/Grep/Finish.`;
        emit("tool_result", { name, error: errMsg, stepId: step.id });
        conv.push({
          role: "tool",
          content: JSON.stringify({ error: errMsg }),
          tool_name: name,
        } as OllamaMessage);
        continue;
      }

      const vr = await executeVfsTool(name, args, vfsCtx);
      if (vr.ok) {
        for (const ev of vr.events ?? []) {
          if (ev.kind === "file_changed") {
            filesChangedSet.add(ev.path);
            emit("file_changed", {
              path: ev.path,
              op: ev.op,
              content: ev.content ?? "",
              stepId: step.id,
            });
          } else if (ev.kind === "build_result") {
            emit("build_result", {
              ok: ev.ok,
              durationMs: ev.durationMs,
              errors: ev.errors,
              warnings: ev.warnings,
              stepId: step.id,
            });
          } else if (ev.kind === "finish") {
            finishSummary = ev.summary;
            finishedThisRound = true;
          }
        }
        emit("tool_result", { name, summary: vr.summary, stepId: step.id });
        conv.push({
          role: "tool",
          content: typeof vr.result === "string" ? vr.result : JSON.stringify(vr.result),
          tool_name: name,
        } as OllamaMessage);
      } else {
        emit("tool_result", { name, error: vr.error, stepId: step.id });
        conv.push({
          role: "tool",
          content: JSON.stringify({ error: vr.error }),
          tool_name: name,
        } as OllamaMessage);
      }

      if (finishedThisRound) break;
    }

    if (finishedThisRound) {
      return {
        ok: true,
        summary: finishSummary || step.title,
        filesChanged: Array.from(filesChangedSet),
        rounds: round + 1,
      };
    }
  }

  // Hit maxRounds without a Finish call. Treat as a soft success — the
  // edits are already applied to vfsCtx; the orchestrator will still cache
  // and advance. Surface the "ran out of rounds" reason for diagnostics.
  return {
    ok: false,
    reason: "max_rounds",
    partial: {
      filesChanged: Array.from(filesChangedSet),
      rounds: maxRounds,
    },
    error: `Step ${step.id} exhausted ${maxRounds} rounds without calling Finish.`,
  };
}
