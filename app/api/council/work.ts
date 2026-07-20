// Council orchestrator. Runs entirely inside one Vercel function (no
// hand-offs — debate budget is bounded), and emits SSE events into the same
// Upstash-backed stream that `consumeChatStream` in the client already knows
// how to drain. Members and rounds:
//
//   for round = 1..(1 + debateRounds):
//     in parallel: each member produces a position
//     emit tool_call/tool_result for each member
//     cache positions in the per-stream scratchpad so a re-entry is idempotent
//   stream synthesizer.chat({stream: true}) — tokens emitted as `delta`
//
// `tool_call` / `tool_result` events follow the same SSE shape as the chat
// route's research events; the existing client renders them as `events[]` on
// the assistant message. A dedicated <CouncilEvents> bubble in MessageBubble
// re-groups events whose name starts with `council:member:` into per-member
// disclosure rows.

import type { Message as OllamaMessage } from "ollama";
import {
  chatClientFor,
  friendlyErrorFor,
  isTransientErrorFor,
  withRetry,
} from "@/app/lib/llm/router";
import {
  appendEvents,
  getStreamScratchpad,
  setStreamScratchpad,
  setMeta,
  type SseEvent,
} from "@/app/lib/stream-store";
import {
  buildSynthesizerContext,
  renderChatTranscript,
  SYNTHESIZER_SYSTEM,
  type CouncilFinalPosition,
  type CouncilPeerPosition,
} from "@/app/lib/council/prompts";
import { runCouncilMember, type CouncilMemberResult } from "./member";
import { currentDateSystemLine } from "@/app/lib/system-context";
import { runCouncilVerifier, type VerifierResult } from "./verifier";
import {
  getSituation,
  MAX_COUNCIL_DEBATE_ROUNDS,
  MAX_COUNCIL_MEMBERS,
} from "@/app/lib/council/situations";
import type { CouncilFramingPayload, CouncilMember } from "@/app/db";

export type RunCouncilWorkOpts = {
  streamId: string;
  /** Wire-format messages from the client (same shape the chat route uses). */
  conv: OllamaMessage[];
  members: CouncilMember[];
  situationId: string;
  framing: CouncilFramingPayload | undefined;
  /** 0/1/2. Capped by `MAX_COUNCIL_DEBATE_ROUNDS`. */
  debateRounds: number;
  synthesizerModel: string;
  runpodEndpointId?: string;
  /** Public origin used by the verifier's tools (image_search proxy URLs).
   *  Derived from the X-Forwarded-* headers on the incoming request. */
  publicOrigin: string;
};

/** Wall-clock cap for the verifier. The council orchestrator has 300s total
 *  before members + synth run; we give the verifier up to ~60s of that. */
const VERIFIER_BUDGET_MS = 60_000;
/** Hard tool-call cap on the verifier so a chatty model still terminates. */
const VERIFIER_MAX_TOOL_CALLS = 8;
const VERIFIER_KEY = "council:verify";

// Small SSE batcher. Flushes every 200ms or 32 events, whichever comes first.
// Terminal events (done/error) flush instantly. Council never streams as
// densely as a chat (deltas come only from the synthesizer), so the simple
// batcher here is fine — no need for the full batched-then-handed-off pipeline
// chat/work.ts uses.
const FLUSH_INTERVAL_MS = 200;
const FLUSH_MAX_EVENTS = 32;
const INSTANT_FLUSH_EVENTS = new Set(["done", "error", "stream_id"]);

function makeEmitter(streamId: string) {
  let pending: SseEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) return chain;
    const batch = pending;
    pending = [];
    chain = chain.then(async () => {
      try {
        await appendEvents(streamId, batch);
      } catch (err) {
        console.warn(`[council ${streamId}] appendEvents failed`, err);
      }
    });
    return chain;
  };

  const emit = (event: string, data: unknown): void => {
    pending.push({ event, data });
    if (INSTANT_FLUSH_EVENTS.has(event)) {
      void flush();
    } else if (pending.length >= FLUSH_MAX_EVENTS) {
      void flush();
    } else if (!timer) {
      timer = setTimeout(() => {
        void flush();
      }, FLUSH_INTERVAL_MS);
    }
  };

  return { emit, flush };
}

const memberRoundKey = (memberId: string, round: number): string =>
  `council:member:${memberId}:r${round}`;

export async function runCouncilWork(opts: RunCouncilWorkOpts): Promise<void> {
  const {
    streamId,
    conv,
    members,
    situationId,
    framing,
    debateRounds,
    synthesizerModel,
    runpodEndpointId,
    publicOrigin,
  } = opts;

  const { emit, flush } = makeEmitter(streamId);
  const startedAt = Date.now();

  // Surface the streamId in the SSE body too — the chat consumer treats this
  // as the resume key and falls back to `streamId` from the meta envelope
  // otherwise. Mirroring the chat route's first event keeps consumeChatStream
  // happy without special-casing.
  emit("stream_id", { id: streamId });

  // Cap inputs defensively. The settings dialog enforces these too, but the
  // server is the source of truth — a stale client or a hand-crafted POST
  // shouldn't be able to blow the worker budget.
  const cappedRounds = Math.max(
    0,
    Math.min(MAX_COUNCIL_DEBATE_ROUNDS, Math.floor(debateRounds))
  );
  const cappedMembers = members.slice(0, MAX_COUNCIL_MEMBERS);
  const totalRounds = 1 + cappedRounds;
  const situation = getSituation(situationId);

  try {
    if (cappedMembers.length === 0) {
      throw new Error(
        "Council has no members. Add at least one in Preferences → Council."
      );
    }

    // Persist what was used for this run so the assistant message's events
    // log can render the framing answers above the synthesis.
    emit("council:framing_used", {
      situationId: situation.id,
      situationLabel: situation.label,
      framing: framing
        ? {
            rationale: framing.rationale,
            questions: framing.questions,
            answers: framing.answers ?? {},
          }
        : null,
      memberCount: cappedMembers.length,
      debateRounds: cappedRounds,
      synthesizerModel,
    });

    const chatTranscript = renderChatTranscript(conv);

    // ---- VERIFIER ---------------------------------------------------------
    // Fact-check the user's load-bearing claims before the council debates,
    // using web_search + web_fetch. Findings are injected into every
    // member's context and the synthesizer's context so the debate argues
    // from sourced reality, not from whatever the user happened to assert.
    // Cached so a re-entered worker (Vercel retry) doesn't re-do the work.
    let verifierFindings: string | undefined;
    {
      const cached = await getStreamScratchpad<VerifierResult>(
        streamId,
        VERIFIER_KEY
      );
      if (cached) {
        emit("tool_call", {
          name: VERIFIER_KEY,
          args: { model: synthesizerModel, cached: true },
        });
        emit("tool_result", {
          name: VERIFIER_KEY,
          summary: `cached · ${cached.toolCallCount} tool call${cached.toolCallCount === 1 ? "" : "s"} · ${cached.findings.slice(0, 160)}`,
        });
        verifierFindings = cached.findings;
      } else {
        emit("tool_call", {
          name: VERIFIER_KEY,
          args: { model: synthesizerModel },
        });
        const result = await runCouncilVerifier({
          streamId,
          model: synthesizerModel,
          runpodEndpointId,
          publicOrigin,
          chatTranscript,
          framing,
          budgetMs: VERIFIER_BUDGET_MS,
          maxToolCalls: VERIFIER_MAX_TOOL_CALLS,
          onToolCall: (info) =>
            emit("tool_call", {
              name: `${VERIFIER_KEY}:${info.callIndex}`,
              args: { tool: info.name, ...info.args },
            }),
          onToolResult: (info) =>
            emit("tool_result", {
              name: `${VERIFIER_KEY}:${info.callIndex}`,
              summary: info.summary,
              error: info.error,
            }),
        });
        await setStreamScratchpad(streamId, VERIFIER_KEY, result);
        emit("tool_result", {
          name: VERIFIER_KEY,
          summary: `${result.toolCallCount} tool call${result.toolCallCount === 1 ? "" : "s"} · ${Math.round(result.elapsedMs / 1000)}s · ${result.findings.slice(0, 200)}`,
          error: result.error,
        });
        verifierFindings = result.findings;
      }
    }

    // ---- ROUND LOOP -------------------------------------------------------
    // After each round we have an array of CouncilMemberResult (one per
    // member). The next round's members are seeded with peerPositions from
    // the previous round's results.
    let lastResults: CouncilMemberResult[] = [];
    for (let round = 1; round <= totalRounds; round++) {
      const peerPositions: CouncilPeerPosition[] | null =
        round === 1
          ? null
          : lastResults.map((r) => ({ member: r.member, position: r.position }));

      // Fan out: emit a `tool_call` for each member at round-start so the UI
      // shows the in-flight bubbles. The matching `tool_result` follows when
      // the member's call resolves.
      const inflight = cappedMembers.map(async (member) => {
        const cacheKey = memberRoundKey(member.id, round);
        const cached = await getStreamScratchpad<CouncilMemberResult>(
          streamId,
          cacheKey
        );
        const callName = `council:member:${member.id}:r${round}`;

        if (cached) {
          emit("tool_call", {
            name: callName,
            args: {
              memberId: member.id,
              memberName: member.name,
              memberModel: member.model,
              perspective: member.perspective,
              round,
              cached: true,
            },
          });
          emit("tool_result", {
            name: callName,
            summary: cached.position,
            error: cached.error,
          });
          return cached;
        }

        emit("tool_call", {
          name: callName,
          args: {
            memberId: member.id,
            memberName: member.name,
            memberModel: member.model,
            perspective: member.perspective,
            round,
          },
        });
        const result = await runCouncilMember({
          streamId,
          member,
          situation,
          chatTranscript,
          framing,
          verifierFindings,
          peerPositions,
          roundNum: round,
          totalRounds,
          runpodEndpointId,
        });
        await setStreamScratchpad(streamId, cacheKey, result);
        emit("tool_result", {
          name: callName,
          summary: result.position,
          error: result.error,
        });
        return result;
      });

      lastResults = await Promise.all(inflight);
    }

    // ---- SYNTHESIZE -------------------------------------------------------
    const finalPositions: CouncilFinalPosition[] = lastResults.map((r) => ({
      member: r.member,
      position: r.position,
    }));

    const synthMessages: OllamaMessage[] = [
      { role: "system", content: `${currentDateSystemLine()}\n\n${SYNTHESIZER_SYSTEM}` },
      {
        role: "user",
        content: buildSynthesizerContext({
          chatTranscript,
          framing,
          verifierFindings,
          finalPositions,
        }),
      },
    ];

    emit("tool_call", {
      name: "council:synthesize",
      args: {
        model: synthesizerModel,
        memberCount: cappedMembers.length,
      },
    });

    const synthLlm = chatClientFor(synthesizerModel, { runpodEndpointId });
    let promptTokens = 0;
    let completionTokens = 0;
    let evalNs = 0;
    let totalNs = 0;

    try {
      const stream = (await withRetry(synthesizerModel, () =>
        synthLlm.chat({
          model: synthesizerModel,
          messages: synthMessages,
          stream: true,
          think: false,
        })
      )) as AsyncIterable<{
        message?: { content?: string };
        done?: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
        eval_duration?: number;
        total_duration?: number;
      }>;

      for await (const chunk of stream) {
        const text = chunk.message?.content;
        if (text) emit("delta", { text });
        if (chunk.done) {
          if (typeof chunk.prompt_eval_count === "number")
            promptTokens = chunk.prompt_eval_count;
          if (typeof chunk.eval_count === "number")
            completionTokens = chunk.eval_count;
          if (typeof chunk.eval_duration === "number")
            evalNs = chunk.eval_duration;
          if (typeof chunk.total_duration === "number")
            totalNs = chunk.total_duration;
        }
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const transient = isTransientErrorFor(synthesizerModel, err);
      emit("tool_result", {
        name: "council:synthesize",
        error: transient ? friendlyErrorFor(synthesizerModel, raw) : raw,
      });
      throw err;
    }

    emit("tool_result", {
      name: "council:synthesize",
      summary: `synthesized recommendation from ${cappedMembers.length} member${
        cappedMembers.length === 1 ? "" : "s"
      } across ${totalRounds} round${totalRounds === 1 ? "" : "s"}`,
    });

    const evalMs = Math.round(evalNs / 1_000_000);
    const councilWallMs = Date.now() - startedAt;
    const totalMs = totalNs > 0 ? Math.round(totalNs / 1_000_000) : councilWallMs;
    const denomMs = evalMs > 0 ? evalMs : (totalMs > 0 ? totalMs : councilWallMs);
    const tokensPerSec = denomMs > 0 ? completionTokens / (denomMs / 1000) : 0;
    emit("usage", {
      promptTokens,
      completionTokens,
      evalMs,
      totalMs,
      tokensPerSec,
    });

    emit("done", {});
    await flush();
    await setMeta(streamId, {
      status: "complete",
      finishedAt: Date.now(),
    });
    console.log(
      `[council ${streamId}] complete in ${Date.now() - startedAt}ms — ${cappedMembers.length} members × ${totalRounds} rounds`
    );
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const transient = isTransientErrorFor(synthesizerModel, err);
    const message = transient
      ? friendlyErrorFor(synthesizerModel, raw)
      : raw;
    console.warn(`[council ${streamId}] failed: ${raw}`);
    emit("error", { message, transient });
    await flush();
    try {
      await setMeta(streamId, {
        status: "error",
        error: message,
        finishedAt: Date.now(),
      });
    } catch (metaErr) {
      console.warn(`[council ${streamId}] setMeta(error) failed`, metaErr);
    }
  }
}
