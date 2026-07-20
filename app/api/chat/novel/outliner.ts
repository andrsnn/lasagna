// Stage 1 of the novel flow: decompose the user's premise into a structured
// outline (title, logline, characters, per-chapter beats). One non-streaming
// LLM call with JSON output, then validate / clamp counts so a wayward model
// can't blow the worker-seq budget by emitting 80 chapters.

import type { ChatResponse, Message as OllamaMessage } from "ollama";
import { chatClientFor, withRetry } from "@/app/lib/llm/router";
import { stripJsonFences } from "@/app/lib/llm/json";
import {
  LENGTH_TARGETS,
  MAX_CHAPTERS,
  MIN_CHAPTERS,
  OUTLINER_REVISION_SYSTEM,
  OUTLINER_SYSTEM,
  type Character,
  type NovelLength,
  type NovelOutline,
  type OutlineChapter,
} from "./prompts";

export type RunOutlinerOpts = {
  streamId: string;
  model: string;
  runpodEndpointId?: string;
  /** Full conversation. The outliner strips the original system prompt and
   *  reads only the user/assistant turns so the chat-mode prompt doesn't skew
   *  a JSON-output planner. */
  conv: OllamaMessage[];
  /** Length preset — determines chapter count and per-chapter word target. */
  length: NovelLength;
  /** Optional plain-text research note from the premise-research stage.
   *  Folded into the system prompt as ground-truth facts the outliner should
   *  weave into setting / characters / beats. Skipped when missing or equal
   *  to "NO_RESEARCH_NEEDED". */
  premiseResearch?: string;
  /** Revision mode: a prior outline + user feedback. When both are set, the
   *  outliner uses OUTLINER_REVISION_SYSTEM and revises rather than generating
   *  from scratch. The user's edits in `priorOutline` are preserved unless the
   *  feedback explicitly asks for changes. */
  priorOutline?: NovelOutline;
  feedback?: string;
};

export type OutlinerResult = {
  outline: NovelOutline;
  promptTokens: number;
  completionTokens: number;
};

export async function runOutliner(opts: RunOutlinerOpts): Promise<OutlinerResult> {
  const { streamId, model, runpodEndpointId, conv, length, premiseResearch, priorOutline, feedback } = opts;
  const llm = chatClientFor(model, { runpodEndpointId });
  const target = LENGTH_TARGETS[length];

  const isRevision =
    !!priorOutline && typeof feedback === "string" && feedback.trim().length > 0;
  const baseSystem = isRevision ? OUTLINER_REVISION_SYSTEM : OUTLINER_SYSTEM;
  const systemPrompt = baseSystem
    .replace(/\{\{targetChapters\}\}/g, String(target.chapters))
    .replace(/\{\{targetWords\}\}/g, String(target.words));

  const userOnly = conv.filter((m) => m.role !== "system");

  // Research note is appended as a trailing user message so it sits closest
  // to the JSON output the model is asked to produce — putting it in the
  // system block leads some models to ignore it as boilerplate.
  const researchBlock =
    premiseResearch && premiseResearch.trim() && premiseResearch.trim() !== "NO_RESEARCH_NEEDED"
      ? `\n\nRESEARCH NOTE (use these facts; do not cite them as sources in the outline):\n${premiseResearch.trim()}`
      : "";

  const revisionBlock = isRevision
    ? `\n\nPRIOR OUTLINE (preserve everything not contradicted by the feedback):\n${JSON.stringify(priorOutline, null, 2)}\n\nUSER FEEDBACK:\n${feedback!.trim()}\n\nProduce the revised outline now. Output STRICT JSON only.`
    : "";

  const messages: OllamaMessage[] = [
    { role: "system", content: systemPrompt },
    ...userOnly,
  ];
  if (researchBlock || revisionBlock) {
    messages.push({
      role: "user",
      content: `${researchBlock}${revisionBlock}`.trim(),
    });
  }

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
          `[novel ${streamId}] outliner transient (attempt ${attempt}): ${
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
      `Outliner returned non-JSON content: ${(err as Error).message} · payload head: ${raw.slice(0, 160)}`
    );
  }

  const outline = validate(parsed, target.chapters);
  return {
    outline,
    promptTokens: resp.prompt_eval_count ?? 0,
    completionTokens: resp.eval_count ?? 0,
  };
}

function validate(raw: unknown, targetChapters: number): NovelOutline {
  if (!raw || typeof raw !== "object") {
    throw new Error("Outline is not an object");
  }
  const obj = raw as Record<string, unknown>;

  const title = typeof obj.title === "string" && obj.title.trim()
    ? obj.title.trim()
    : "Untitled";
  const logline = typeof obj.logline === "string" ? obj.logline.trim() : "";
  const setting = typeof obj.setting === "string" ? obj.setting.trim() : "";

  // Characters: 2..6 valid entries. If the model returned fewer than 2,
  // we fail loudly rather than fake names — a 0-character novel can't be
  // written meaningfully.
  const charsRaw = Array.isArray(obj.characters) ? obj.characters : [];
  const characters: Character[] = [];
  for (const item of charsRaw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const role = typeof rec.role === "string" ? rec.role.trim() : "";
    const description = typeof rec.description === "string" ? rec.description.trim() : "";
    if (!name) continue;
    characters.push({ name, role: role || "supporting", description });
    if (characters.length >= 6) break;
  }
  if (characters.length < 2) {
    throw new Error(
      `Outline must include at least 2 characters; got ${characters.length}`
    );
  }

  // Chapters: clamp to [MIN_CHAPTERS, MAX_CHAPTERS] and prefer the requested
  // target. If the model returned the wrong count we'll just take the first
  // targetChapters (or pad with placeholder beats — but that's bad; throw
  // instead so the caller can decide to retry or fail).
  const chaptersRaw = Array.isArray(obj.chapters) ? obj.chapters : [];
  const chapters: OutlineChapter[] = [];
  for (let i = 0; i < chaptersRaw.length && chapters.length < MAX_CHAPTERS; i++) {
    const item = chaptersRaw[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === "string" && rec.id.trim()
      ? rec.id.trim()
      : `c${i + 1}`;
    const titleVal = typeof rec.title === "string" ? rec.title.trim() : "";
    const beats = typeof rec.beats === "string" ? rec.beats.trim() : "";
    if (!titleVal || !beats) continue;
    chapters.push({ id, title: titleVal, beats });
  }
  if (chapters.length < MIN_CHAPTERS) {
    throw new Error(
      `Outline must include at least ${MIN_CHAPTERS} chapters; got ${chapters.length}`
    );
  }
  // If the model exceeded the target slightly, trim. If well under target,
  // we already failed above. Either way, the final count is bounded.
  const finalChapters = chapters.slice(0, targetChapters);

  return {
    title,
    logline,
    setting,
    characters,
    chapters: finalChapters,
  };
}
