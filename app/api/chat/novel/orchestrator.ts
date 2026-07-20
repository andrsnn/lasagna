// Orchestrates the long-running novel flow: outliner → sequential chapter
// writers → assembled output. Mirrors the research orchestrator's
// scratchpad-cache pattern so a Vercel worker timeout doesn't lose progress.
//
// Resilience design:
// - Outline is cached under `novel:outline`. On any resumed worker, the
//   cached value is reused (idempotent).
// - Each chapter is cached under `novel:chapter:cN` immediately after its
//   prose phase completes. A resumed worker re-runs the orchestrator, finds
//   the cached chapters, and only writes the ones still missing.
// - Between chapters, we check the worker's wall-clock budget. If we're
//   within HANDOFF_RESERVE_MS of the deadline AND a successor worker is
//   available, we throw NovelHandoffNeededError; work.ts catches it and
//   initiates a handoff. The next worker resumes here, sees the cached
//   chapters, and continues from the first uncached one.
// - Cached chapters DO NOT re-emit prose deltas on resume. The events
//   were already flushed to Redis during the worker that wrote them, and
//   the client's resume cursor will replay them naturally. Re-emitting
//   would duplicate the chapter text on a live client.

import type { Message as OllamaMessage } from "ollama";
import {
  getStreamScratchpad,
  setStreamScratchpad,
} from "@/app/lib/stream-store";
import { runOutliner } from "./outliner";
import { runChapter } from "./chapter";
import {
  assembleNovel,
  LENGTH_TARGETS,
  trimRecap,
  type Chapter,
  type NovelLength,
  type NovelOutline,
} from "./prompts";

const OUTLINE_KEY = "novel:outline";
const RECAP_KEY = "novel:recap";
const chapterKey = (id: string) => `novel:chapter:${id}`;

// How close to the worker's wall-clock deadline we stop starting new chapters.
// Sized so a chapter that just started has time to either finish OR be
// abandoned (the model's stream is interrupted by the worker's deadline
// timer regardless; this just keeps us from starting one we can't finish).
const HANDOFF_RESERVE_MS = Number(
  process.env.NOVEL_HANDOFF_RESERVE_MS ?? 60_000
);

export class NovelHandoffNeededError extends Error {
  constructor(message = "novel orchestrator handing off mid-run") {
    super(message);
    this.name = "NovelHandoffNeededError";
  }
}

export type NovelEmit = (event: string, data: unknown) => void;

export type OrchestrateNovelOpts = {
  streamId: string;
  model: string;
  runpodEndpointId?: string;
  publicOrigin: string;
  /** Full conversation as seen pre-orchestration. The outliner reads the
   *  user/assistant turns only — chat-mode system prompts skew JSON output. */
  conv: OllamaMessage[];
  /** Last user message (used for context echo / logging only — the outliner
   *  reads conv directly). */
  userQuestion: string;
  length: NovelLength;
  webSearchEnabled: boolean;
  /** Wall-clock timestamp by which the orchestrator must hand off to a
   *  successor worker. Checked between chapters. */
  workerDeadlineAt: number;
  /** True when a successor worker slot is available. When false (final
   *  worker), the orchestrator runs to completion or fails — there's
   *  nowhere to hand off to anyway. */
  canHandoff: boolean;
  /** When set, the orchestrator skips its own outliner stage and treats this
   *  outline as ground truth — used after the client has displayed the
   *  outline editor and the user clicked "Generate novel". The orchestrator
   *  writes it into the scratchpad cache so handoffs preserve it. */
  presetOutline?: NovelOutline;
  /** SSE event emitter (timeline events). */
  emit: NovelEmit;
  /** Forward streamed chapter prose to the client as `delta` events.
   *  Called many times per chapter. */
  onDelta: (text: string) => void;
  /** Forwards token-usage deltas so work.ts's totals stay accurate. */
  onUsage: (delta: { promptTokens: number; completionTokens: number }) => void;
};

export type NovelResult = {
  outline: NovelOutline;
  chapters: Chapter[];
  novelText: string;
};

export async function orchestrateNovel(
  opts: OrchestrateNovelOpts
): Promise<NovelResult> {
  const {
    streamId,
    model,
    runpodEndpointId,
    publicOrigin,
    conv,
    length,
    webSearchEnabled,
    workerDeadlineAt,
    canHandoff,
    presetOutline,
    emit,
    onDelta,
    onUsage,
  } = opts;

  const target = LENGTH_TARGETS[length];

  const stageStart = (name: string, args: Record<string, unknown>) =>
    emit("tool_call", { name: `novel:${name}`, args });
  const stageDone = (name: string, summary: string, extra?: Record<string, unknown>) =>
    emit("tool_result", { name: `novel:${name}`, summary, ...(extra ?? {}) });

  // ---- outline ----
  // Order of preference: cached (from a prior worker in this stream) →
  // preset (from the /api/novel/outline editor → /api/chat hand-off) →
  // generate fresh. The preset path is the dominant one once the
  // editor flow ships; we keep the in-process outliner as a fallback
  // for callers that don't go through the editor.
  let outline = await getStreamScratchpad<NovelOutline>(streamId, OUTLINE_KEY);
  if (!outline && presetOutline) {
    outline = presetOutline;
    // Persist immediately so a handoff mid-chapter doesn't lose it. The
    // preset wasn't generated in this stream and won't reappear from
    // anywhere else.
    await setStreamScratchpad(streamId, OUTLINE_KEY, outline);
    stageStart("outline", { length, preset: true });
    stageDone(
      "outline",
      `using user-confirmed outline · ${outline.chapters.length} chapters · "${outline.title}"`,
      {
        title: outline.title,
        logline: outline.logline,
        chapterCount: outline.chapters.length,
        characterCount: outline.characters.length,
        preset: true,
      }
    );
  } else if (!outline) {
    stageStart("outline", { length, targetChapters: target.chapters });
    const result = await runOutliner({
      streamId,
      model,
      runpodEndpointId,
      conv,
      length,
    });
    outline = result.outline;
    onUsage({
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    });
    await setStreamScratchpad(streamId, OUTLINE_KEY, outline);
    stageDone(
      "outline",
      `${outline.chapters.length} chapters · ${outline.characters.length} characters · "${outline.title}"`,
      {
        title: outline.title,
        logline: outline.logline,
        chapterCount: outline.chapters.length,
        characterCount: outline.characters.length,
      }
    );
  } else {
    stageStart("outline", { length, cached: true });
    stageDone(
      "outline",
      `cached · ${outline.chapters.length} chapters · "${outline.title}"`,
      { title: outline.title, cached: true }
    );
  }

  // ---- chapters (sequential, cached individually) ----
  const chapters: Chapter[] = [];
  let runningRecap = (await getStreamScratchpad<string>(streamId, RECAP_KEY)) ?? "";

  for (let i = 0; i < outline.chapters.length; i++) {
    const ch = outline.chapters[i];
    const cached = await getStreamScratchpad<Chapter>(streamId, chapterKey(ch.id));
    if (cached) {
      // DO NOT re-emit cached prose via onDelta. The events were flushed
      // to Redis during the worker that wrote them, and the resume cursor
      // replays them naturally. Re-emitting would duplicate text on a
      // live client. We still emit a timeline marker so the user sees
      // the cached step in the timeline.
      stageStart(`chapter:${ch.id}`, {
        chapter: i + 1,
        title: ch.title,
        cached: true,
      });
      stageDone(
        `chapter:${ch.id}`,
        `cached · chapter ${i + 1} "${ch.title}" · ${cached.text.length.toLocaleString()} chars`,
        {
          chapter: i + 1,
          title: ch.title,
          words: estimateWords(cached.text),
          cached: true,
        }
      );
      chapters.push(cached);
      continue;
    }

    // Pre-flight deadline check: skip starting a chapter we can't finish.
    // Without this, we'd start a 60s chapter with 10s of worker time left
    // and lose the partial work to the Vercel kill.
    if (canHandoff && Date.now() + HANDOFF_RESERVE_MS > workerDeadlineAt) {
      throw new NovelHandoffNeededError(
        `paused before chapter ${i + 1}/${outline.chapters.length}; deadline in ${workerDeadlineAt - Date.now()}ms`
      );
    }

    stageStart(`chapter:${ch.id}`, {
      chapter: i + 1,
      total: outline.chapters.length,
      title: ch.title,
    });
    const chapter = await runChapter({
      streamId,
      model,
      runpodEndpointId,
      publicOrigin,
      outline,
      chapterIndex: i,
      length,
      priorRecap: runningRecap,
      webSearchEnabled,
      onDelta,
      emit,
    });
    onUsage({
      promptTokens: chapter.promptTokens,
      completionTokens: chapter.completionTokens,
    });
    await setStreamScratchpad(streamId, chapterKey(ch.id), chapter);

    // Append the new chapter's recap to the running recap and persist it
    // so the next worker (post-handoff) has the same continuity context
    // this chapter writer saw.
    runningRecap = trimRecap(
      runningRecap
        ? `${runningRecap}\n\nChapter ${i + 1} — ${chapter.title}: ${chapter.recap}`
        : `Chapter ${i + 1} — ${chapter.title}: ${chapter.recap}`
    );
    await setStreamScratchpad(streamId, RECAP_KEY, runningRecap);

    chapters.push(chapter);
    stageDone(
      `chapter:${ch.id}`,
      `chapter ${i + 1} "${ch.title}" · ${estimateWords(chapter.text).toLocaleString()} words · ${Math.round(chapter.elapsedMs / 1000)}s${
        chapter.webSearchCount > 0 ? ` · ${chapter.webSearchCount} search${chapter.webSearchCount === 1 ? "" : "es"}` : ""
      }`,
      {
        chapter: i + 1,
        title: chapter.title,
        words: estimateWords(chapter.text),
        elapsedMs: chapter.elapsedMs,
        webSearchCount: chapter.webSearchCount,
      }
    );
  }

  // ---- assembly ----
  stageStart("assemble", { chapterCount: chapters.length });
  const novelText = assembleNovel(outline, chapters);
  const totalWords = estimateWords(novelText);
  stageDone(
    "assemble",
    `assembled · ${chapters.length} chapters · ~${totalWords.toLocaleString()} words · ~${Math.round(totalWords / 250)} pages`,
    {
      chapterCount: chapters.length,
      totalWords,
      approxPages: Math.round(totalWords / 250),
    }
  );

  return { outline, chapters, novelText };
}

function estimateWords(text: string): number {
  if (!text) return 0;
  // Whitespace-split is rough but fine for "approx pages" — we'd need a
  // real tokenizer for cost reporting, but the user-facing number is just
  // a sanity check.
  return text.trim().split(/\s+/).length;
}
