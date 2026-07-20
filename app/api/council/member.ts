// Single-council-member runner. One non-streaming chat call per member per
// round. Modelled on the research sub-agent (`runSubAgent`) but
// stripped of the tool-loop — council members argue from what's already in
// the chat + framing answers + verifier findings + (in debate rounds) peer
// positions. They do NOT call web_search / web_fetch directly; the framer
// and the verifier handle web access for the council.
//
// Wrapped in `withRetry` from the shared LLM router so transient upstream
// blips (Ollama gateway 5xx, RunPod cold start) don't poison a debate.

import type { ChatResponse, Message as OllamaMessage } from "ollama";
import { chatClientFor, withRetry } from "@/app/lib/llm/router";
import {
  buildMemberContext,
  councilMemberSystem,
  type CouncilPeerPosition,
} from "@/app/lib/council/prompts";
import type { CouncilFramingPayload, CouncilMember } from "@/app/db";
import type { CouncilSituation } from "@/app/lib/council/situations";
import { currentDateSystemLine } from "@/app/lib/system-context";

/** How many times we'll try to get a real position out of a member before
 *  degrading to a placeholder. Each attempt is itself wrapped in `withRetry`
 *  (which only retries transient provider blips); this OUTER loop additionally
 *  retries the cases withRetry gives up on — empty responses and hard
 *  (non-transient) failures — so one flaky turn doesn't drop a member's voice
 *  from the whole debate. */
const MEMBER_MAX_ATTEMPTS = 3;
/** Base backoff between outer attempts; grows linearly (0.8s, 1.6s). Short —
 *  the council is on a wall clock and the user is waiting. */
const MEMBER_RETRY_BASE_MS = 800;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export type RunCouncilMemberOpts = {
  streamId: string;
  member: CouncilMember;
  situation: CouncilSituation;
  /** Whole chat as a flat transcript — see `renderChatTranscript`. */
  chatTranscript: string;
  framing: CouncilFramingPayload | undefined;
  /** Verifier's sourced fact-check brief. Members defer to this over user
   *  claims when the two conflict. Undefined when verifier was skipped or
   *  failed; the prompt renders a neutral note in that case. */
  verifierFindings: string | undefined;
  /** Null for round 1, peers' previous-round positions for rounds 2..N. */
  peerPositions: CouncilPeerPosition[] | null;
  /** 1-indexed: 1 = initial position, 2.. = debate rounds. */
  roundNum: number;
  /** Total rounds the orchestrator plans to run (for the system prompt). */
  totalRounds: number;
  runpodEndpointId?: string;
};

export type CouncilMemberResult = {
  member: CouncilMember;
  roundNum: number;
  /** Position text. May start with "TENTATIVE:" / "INSUFFICIENT EVIDENCE:" if
   *  the model genuinely couldn't form a position from what was provided. */
  position: string;
  elapsedMs: number;
  /** Set when the call failed AND we have no usable position to fall back on. */
  error?: string;
};

export async function runCouncilMember(
  opts: RunCouncilMemberOpts
): Promise<CouncilMemberResult> {
  const {
    streamId,
    member,
    situation,
    chatTranscript,
    framing,
    verifierFindings,
    peerPositions,
    roundNum,
    totalRounds,
    runpodEndpointId,
  } = opts;

  const startedAt = Date.now();
  const llm = chatClientFor(member.model, { runpodEndpointId });

  const messages: OllamaMessage[] = [
    {
      role: "system",
      content: `${currentDateSystemLine()}\n\n${councilMemberSystem(member, situation, roundNum, totalRounds)}`,
    },
    {
      role: "user",
      content: buildMemberContext({
        chatTranscript,
        framing,
        verifierFindings,
        peerPositions,
        member,
      }),
    },
  ];

  // Outer attempt loop. A "failure" worth retrying is either a thrown error
  // (whatever withRetry surfaced) or a successful call that came back empty.
  // We only degrade to a placeholder once every attempt is spent.
  let lastError = "";
  for (let attempt = 1; attempt <= MEMBER_MAX_ATTEMPTS; attempt++) {
    try {
      const resp = (await withRetry(
        member.model,
        () =>
          llm.chat({
            model: member.model,
            messages,
            stream: false,
            think: false,
          }),
        {
          onRetry: (a, err) =>
            console.warn(
              `[council ${streamId}] member ${member.id} round ${roundNum} transient (attempt ${attempt}.${a}): ${
                err instanceof Error ? err.message : String(err)
              }`
            ),
        }
      )) as ChatResponse;

      const text = (resp.message?.content ?? "").trim();
      if (text) {
        return {
          member,
          roundNum,
          position: text,
          elapsedMs: Date.now() - startedAt,
        };
      }
      // Empty body: retryable. Note it and fall through to the backoff below.
      lastError = "empty response";
      console.warn(
        `[council ${streamId}] member ${member.id} round ${roundNum} empty response (attempt ${attempt}/${MEMBER_MAX_ATTEMPTS})`
      );
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[council ${streamId}] member ${member.id} round ${roundNum} failed (attempt ${attempt}/${MEMBER_MAX_ATTEMPTS}): ${lastError}`
      );
    }

    if (attempt < MEMBER_MAX_ATTEMPTS) {
      await sleep(MEMBER_RETRY_BASE_MS * attempt);
    }
  }

  // Every attempt spent. Degrade soft so one bad model doesn't kill the whole
  // council — the synthesizer will see the placeholder and route around it.
  return {
    member,
    roundNum,
    position:
      lastError === "empty response"
        ? `TENTATIVE: ${member.name} produced an empty response after ${MEMBER_MAX_ATTEMPTS} attempts. Their perspective is missing from this round.`
        : `INSUFFICIENT EVIDENCE: ${member.name} failed to respond after ${MEMBER_MAX_ATTEMPTS} attempts (${lastError}).`,
    elapsedMs: Date.now() - startedAt,
    error: lastError || "no response",
  };
}
