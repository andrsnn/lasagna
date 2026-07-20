// Novel-outline work: the upfront premise-research + outliner pipeline the
// POST handshake hands off to via waitUntil. Lives in its own module so the
// route handler stays tiny and the worker survives client disconnects —
// same shape /api/query and /api/{research,council}/framing use for
// long-running single-shot LLM calls that need to recover across a mobile
// network drop or a backgrounded tab.
//
// Returns `{status, payload}` so the resume route can return the same HTTP
// status the old synchronous endpoint did and the client doesn't need a
// separate code path for handshake errors vs LLM errors.
//
// We also emit `progress` events to the same Redis stream while the work
// runs (phase markers + per-search updates) so the client's progress poll
// can show a live action timeline instead of a static "Outlining…" string
// — see `app/api/novel/outline/progress/[streamId]/route.ts`.

import type { Message as OllamaMessage } from "ollama";
import {
  isTransientErrorFor,
  friendlyErrorFor,
} from "@/app/lib/llm/router";
import { runOutliner } from "@/app/api/chat/novel/outliner";
import {
  runPremiseResearch,
  type PremiseSearch,
} from "@/app/api/chat/novel/premise-research";
import { appendEvent } from "@/app/lib/stream-store";
import type {
  NovelLength,
  NovelOutline,
} from "@/app/api/chat/novel/prompts";

export type NovelOutlineWorkInput = {
  streamId: string;
  conv: OllamaMessage[];
  model: string;
  length: NovelLength;
  runpodEndpointId?: string;
  publicOrigin: string;
  /** Revision mode: the outline the user is iterating on. */
  priorOutline?: NovelOutline;
  /** Revision mode: free-text feedback to apply. */
  feedback?: string;
};

export type NovelOutlineSuccessPayload = {
  outline: NovelOutline;
  researchNote: string | null;
  searches: PremiseSearch[];
  usage: { promptTokens: number; completionTokens: number };
};

export type NovelOutlineErrorPayload = {
  error: string;
};

export type NovelOutlineWorkOutcome =
  | { status: 200; payload: NovelOutlineSuccessPayload }
  | { status: 500; payload: NovelOutlineErrorPayload };

/** Single shape for every progress event the client renders. `key` lets the
 *  client de-dup repeated states for the same step (running → ok). */
export type NovelOutlineProgressStep = {
  key: string;
  label: string;
  status: "running" | "ok" | "error";
  at: number;
  /** Free-form extra detail surfaced in the row (search summary, error text). */
  detail?: string;
};

export async function runNovelOutlineWork(
  input: NovelOutlineWorkInput
): Promise<NovelOutlineWorkOutcome> {
  const {
    streamId,
    conv,
    model,
    length,
    runpodEndpointId,
    publicOrigin,
    priorOutline,
    feedback,
  } = input;

  const isRevision =
    !!priorOutline &&
    typeof feedback === "string" &&
    feedback.trim().length > 0;

  // Fire-and-forget progress emit: errors here MUST never bubble up — the
  // outline work is the source of truth, the timeline is decoration. Sequenced
  // through a chained promise so events are appended in emit order even when
  // Upstash latency varies.
  let progressTail: Promise<void> = Promise.resolve();
  const emitStep = (step: NovelOutlineProgressStep) => {
    progressTail = progressTail
      .then(() => appendEvent(streamId, { event: "progress", data: step }))
      .catch((err) => {
        console.warn(
          `[novel-outline ${streamId}] progress emit failed`,
          err
        );
      });
  };

  // Adapt premise-research's existing tool_call / tool_result events into the
  // same `progress` shape the client renders. Sequential search keys so the
  // running → ok pair lines up on a single row.
  let searchSeq = 0;
  const pendingSearchKey: { current: string | null } = { current: null };
  const premiseEmit = (event: string, data: unknown) => {
    if (event === "tool_call") {
      searchSeq += 1;
      const key = `search_${searchSeq}`;
      pendingSearchKey.current = key;
      const args = (data as { args?: Record<string, unknown> })?.args ?? {};
      const query =
        typeof args.query === "string" && args.query.trim()
          ? args.query.trim()
          : "web search";
      emitStep({
        key,
        label: `Searching “${query}”`,
        status: "running",
        at: Date.now(),
      });
    } else if (event === "tool_result") {
      const key = pendingSearchKey.current ?? `search_${searchSeq}`;
      pendingSearchKey.current = null;
      const payload = data as { summary?: string; error?: string };
      if (payload.error) {
        emitStep({
          key,
          label: "Search failed",
          status: "error",
          at: Date.now(),
          detail: payload.error,
        });
      } else {
        emitStep({
          key,
          label: "Search complete",
          status: "ok",
          at: Date.now(),
          detail: payload.summary,
        });
      }
    }
  };

  let researchNote = "NO_RESEARCH_NEEDED";
  let searches: PremiseSearch[] = [];
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    if (isRevision) {
      emitStep({
        key: "revise",
        label: "Revising outline with your feedback",
        status: "running",
        at: Date.now(),
      });
    } else {
      emitStep({
        key: "research",
        label: "Researching the premise",
        status: "running",
        at: Date.now(),
      });
      const research = await runPremiseResearch({
        streamId,
        model,
        runpodEndpointId,
        publicOrigin,
        conv,
        emit: premiseEmit,
      });
      researchNote = research.note;
      searches = research.searches;
      promptTokens += research.promptTokens;
      completionTokens += research.completionTokens;
      emitStep({
        key: "research",
        label:
          searches.length === 0
            ? "Premise didn't need outside research"
            : `Researched premise · ${searches.length} search${searches.length === 1 ? "" : "es"}`,
        status: "ok",
        at: Date.now(),
      });
    }

    emitStep({
      key: "outline",
      label: isRevision ? "Rewriting the outline" : "Drafting the outline",
      status: "running",
      at: Date.now(),
    });
    const outlineResult = await runOutliner({
      streamId,
      model,
      runpodEndpointId,
      conv,
      length,
      premiseResearch: researchNote,
      priorOutline,
      feedback,
    });
    promptTokens += outlineResult.promptTokens;
    completionTokens += outlineResult.completionTokens;
    emitStep({
      key: "outline",
      label: `Outline ready · ${outlineResult.outline.chapters.length} chapters`,
      status: "ok",
      at: Date.now(),
    });

    if (isRevision) {
      emitStep({
        key: "revise",
        label: "Revision complete",
        status: "ok",
        at: Date.now(),
      });
    }

    // Make sure the last progress event lands in Redis before the caller
    // appends the terminal `result` event — the client's progress poll uses
    // event ordering to decide when to stop showing the live timeline.
    await progressTail;

    return {
      status: 200,
      payload: {
        outline: outlineResult.outline,
        researchNote:
          researchNote === "NO_RESEARCH_NEEDED" ? null : researchNote,
        searches,
        usage: { promptTokens, completionTokens },
      },
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = isTransientErrorFor(model, err)
      ? friendlyErrorFor(model, raw)
      : raw;
    emitStep({
      key: "error",
      label: "Outline failed",
      status: "error",
      at: Date.now(),
      detail: message,
    });
    await progressTail;
    return { status: 500, payload: { error: message } };
  }
}
