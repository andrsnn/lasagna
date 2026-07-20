// Stage 2 of the novel flow: one chapter. Optional non-streamed research
// pass (web_search, capped) → streamed prose pass that pipes deltas to the
// caller as they arrive. The streamed pass deliberately runs without tools
// so the model can't recurse into another search mid-paragraph (which would
// stall the stream and bleed citation markers into the prose).

import type { ChatResponse, Message as OllamaMessage, ToolCall } from "ollama";
import { chatClientFor, isTransientErrorFor, withRetry } from "@/app/lib/llm/router";
import { WEB_SEARCH_TOOL, executeTool } from "@/app/lib/ollama/tools";
import {
  CHAPTER_RESEARCH_SYSTEM,
  CHAPTER_SYSTEM,
  LENGTH_TARGETS,
  buildChapterContext,
  type Chapter,
  type NovelLength,
  type NovelOutline,
} from "./prompts";

export const CHAPTER_MAX_WEB_SEARCHES = 2;
const RECAP_MARKER = "---RECAP---";

export type RunChapterEmit = (event: string, data: unknown) => void;

export type RunChapterOpts = {
  streamId: string;
  model: string;
  runpodEndpointId?: string;
  publicOrigin: string;
  outline: NovelOutline;
  chapterIndex: number;
  length: NovelLength;
  /** Concatenated recaps of all prior chapters, already trimmed by the
   *  orchestrator. May be empty for the opening chapter. */
  priorRecap: string;
  /** Allow the optional research phase. When false, the research phase is
   *  skipped entirely (no LLM call, no tool calls). */
  webSearchEnabled: boolean;
  /** Pipe streamed prose chunks out. Called many times per chapter as the
   *  model emits tokens. The orchestrator wires this to emit("delta", …). */
  onDelta: (text: string) => void;
  /** Emit timeline events for the per-chapter web_search calls so the UI
   *  shows them under the chapter's section. */
  emit: RunChapterEmit;
};

export async function runChapter(opts: RunChapterOpts): Promise<Chapter> {
  const {
    streamId,
    model,
    runpodEndpointId,
    publicOrigin,
    outline,
    chapterIndex,
    length,
    priorRecap,
    webSearchEnabled,
    onDelta,
    emit,
  } = opts;

  const target = LENGTH_TARGETS[length];
  const ch = outline.chapters[chapterIndex];
  const startedAt = Date.now();
  const llm = chatClientFor(model, { runpodEndpointId });

  let webSearchCount = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let researchNote: string | null = null;

  // ---- Phase 1: optional research ----
  if (webSearchEnabled) {
    const researchSystem = CHAPTER_RESEARCH_SYSTEM.replace(/\{\{chapterId\}\}/g, ch.id);
    const researchConv: OllamaMessage[] = [
      { role: "system", content: researchSystem },
      {
        role: "user",
        content: [
          `Novel premise: ${outline.title} — ${outline.logline}`,
          `Setting: ${outline.setting}`,
          ``,
          `Chapter ${chapterIndex + 1} beats: ${ch.beats}`,
          ``,
          `Gather research relevant to THIS chapter only. Up to ${CHAPTER_MAX_WEB_SEARCHES} web_search calls. If unnecessary, emit "NO_RESEARCH_NEEDED".`,
        ].join("\n"),
      },
    ];

    for (let round = 0; round <= CHAPTER_MAX_WEB_SEARCHES + 1; round++) {
      const mustFinalize = webSearchCount >= CHAPTER_MAX_WEB_SEARCHES;
      if (mustFinalize) {
        researchConv.push({
          role: "system",
          content:
            "You have used your research budget. Emit the RESEARCH NOTE now using only what you've already gathered, or 'NO_RESEARCH_NEEDED'. Do not call any more tools.",
        });
      }
      let resp: ChatResponse;
      try {
        resp = (await withRetry(
          model,
          () =>
            llm.chat({
              model,
              messages: researchConv,
              tools: mustFinalize ? undefined : [WEB_SEARCH_TOOL],
              stream: false,
              think: false,
            }),
          {
            onRetry: (attempt, err) =>
              console.warn(
                `[novel ${streamId}] chapter ${ch.id} research transient (attempt ${attempt}): ${
                  err instanceof Error ? err.message : String(err)
                }`
              ),
          }
        )) as ChatResponse;
      } catch (err) {
        if (!isTransientErrorFor(model, err)) {
          // Non-transient: skip research entirely and write the chapter
          // without it. The chapter prose phase is the load-bearing path.
          console.warn(
            `[novel ${streamId}] chapter ${ch.id} research failed; writing without research: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          researchNote = null;
          break;
        }
        throw err;
      }

      promptTokens += resp.prompt_eval_count ?? 0;
      completionTokens += resp.eval_count ?? 0;

      const content = (resp.message?.content ?? "").trim();
      const calls = (resp.message?.tool_calls ?? []) as ToolCall[];

      if (mustFinalize || calls.length === 0) {
        researchNote = content;
        break;
      }

      researchConv.push({
        role: "assistant",
        content,
        tool_calls: calls,
      });

      for (const call of calls) {
        if (webSearchCount >= CHAPTER_MAX_WEB_SEARCHES) break;
        const name = call.function.name;
        const args = call.function.arguments as Record<string, unknown>;
        // Surface as a nested timeline event tied to this chapter so the UI
        // groups it under the chapter's section.
        const evName = `novel:chapter:${ch.id}:web_search`;
        emit("tool_call", { name: evName, args });
        const r = await executeTool(name, args, 2000, { publicOrigin });
        webSearchCount += 1;
        if (r.ok) {
          emit("tool_result", { name: evName, summary: r.summary });
          researchConv.push({
            role: "tool",
            content: JSON.stringify(r.result),
            tool_name: name,
          } as OllamaMessage);
        } else {
          emit("tool_result", { name: evName, error: r.error });
          researchConv.push({
            role: "tool",
            content: JSON.stringify({ error: r.error }),
            tool_name: name,
          } as OllamaMessage);
        }
      }
    }
  }

  // ---- Phase 2: streamed prose ----
  const chapterSystem = CHAPTER_SYSTEM
    .replace(/\{\{chapterNum\}\}/g, String(chapterIndex + 1))
    .replace(/\{\{totalChapters\}\}/g, String(outline.chapters.length))
    .replace(/\{\{targetWords\}\}/g, String(target.words));
  const userContext = buildChapterContext({
    outline,
    chapterIndex,
    totalChapters: outline.chapters.length,
    priorRecap,
    researchNote,
  });
  const proseConv: OllamaMessage[] = [
    { role: "system", content: chapterSystem },
    { role: "user", content: userContext },
  ];

  // Stream prose. We hold a buffer so we can detect and strip the
  // ---RECAP--- marker — once seen, every subsequent token is recap text,
  // not user-visible prose, so it MUST NOT be forwarded to onDelta.
  let fullText = "";
  let proseBuffer = "";
  let recapStarted = false;
  let proseEmittedLen = 0;
  // Marker can arrive split across deltas — keep this many trailing chars
  // back from emitting so a partial "---REC" doesn't sneak out before we
  // detect the full marker.
  const HOLDBACK = RECAP_MARKER.length;

  const iter = await withRetry(
    model,
    () =>
      llm.chat({
        model,
        messages: proseConv,
        stream: true,
        think: false,
      }),
    {
      onRetry: (attempt, err) =>
        console.warn(
          `[novel ${streamId}] chapter ${ch.id} prose handshake transient (attempt ${attempt}): ${
            err instanceof Error ? err.message : String(err)
          }`
        ),
    }
  );

  for await (const part of iter) {
    const content = part.message?.content;
    if (content) {
      fullText += content;
      if (!recapStarted) {
        proseBuffer += content;
        const markerIdx = proseBuffer.indexOf(RECAP_MARKER);
        if (markerIdx >= 0) {
          // Emit everything before the marker (minus what we've already
          // emitted), then stop forwarding deltas.
          const safeEmit = proseBuffer.slice(proseEmittedLen, markerIdx);
          if (safeEmit) onDelta(safeEmit);
          proseEmittedLen = markerIdx;
          recapStarted = true;
        } else {
          // Emit everything except the holdback tail so we can still
          // catch a marker that spans the next chunk.
          const safeEnd = Math.max(proseEmittedLen, proseBuffer.length - HOLDBACK);
          if (safeEnd > proseEmittedLen) {
            const chunk = proseBuffer.slice(proseEmittedLen, safeEnd);
            onDelta(chunk);
            proseEmittedLen = safeEnd;
          }
        }
      }
    }
    if (part.done) {
      promptTokens += part.prompt_eval_count ?? 0;
      completionTokens += part.eval_count ?? 0;
    }
  }

  // Flush any held-back tail that turned out to be ordinary prose (no
  // marker arrived). Without this the last few characters of a chapter
  // could be missing from the user-visible stream.
  if (!recapStarted && proseEmittedLen < proseBuffer.length) {
    onDelta(proseBuffer.slice(proseEmittedLen));
    proseEmittedLen = proseBuffer.length;
  }

  // Split prose vs recap from the full text. If the model didn't emit a
  // marker, the whole thing is prose and we synthesize a short recap from
  // the tail so later chapters still get some continuity hint.
  let chapterProse: string;
  let recap: string;
  const markerIdx = fullText.indexOf(RECAP_MARKER);
  if (markerIdx >= 0) {
    chapterProse = fullText.slice(0, markerIdx).trim();
    recap = fullText.slice(markerIdx + RECAP_MARKER.length).trim();
  } else {
    chapterProse = fullText.trim();
    // Cheap fallback: take the chapter's last ~600 chars as a recap stub.
    // Not great prose, but it keeps the running recap from being empty.
    const tail = chapterProse.slice(-600).replace(/\s+/g, " ").trim();
    recap = `Chapter ${chapterIndex + 1}: ${tail}`;
  }

  // Emit a trailing newline so the next chapter's heading doesn't butt
  // against this chapter's final paragraph in the assistant message.
  onDelta("\n\n");

  return {
    id: ch.id,
    title: ch.title,
    text: chapterProse,
    recap,
    elapsedMs: Date.now() - startedAt,
    webSearchCount,
    promptTokens,
    completionTokens,
  };
}
