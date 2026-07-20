// Prompts and shared types for the long-running novel flow (outliner → per-
// chapter optional research → streamed chapter writer → assembled output).
// Kept in their own module to mirror /app/api/chat/research/prompts.ts and
// keep the contract between stages in one place.

export type NovelLength = "short" | "standard" | "long";

/** Per-length presets. Page counts assume ~250 words/page, which is the
 *  conventional ballpark for trade paperback typesetting. */
export const LENGTH_TARGETS: Record<
  NovelLength,
  { chapters: number; words: number; approxPages: number }
> = {
  short:    { chapters: 12, words: 1200, approxPages: 50 },
  standard: { chapters: 20, words: 1400, approxPages: 100 },
  long:     { chapters: 28, words: 1700, approxPages: 200 },
};

export const MIN_CHAPTERS = 12;
export const MAX_CHAPTERS = 30;

export type Character = {
  name: string;
  role: string;
  description: string;
};

export type OutlineChapter = {
  id: string;
  title: string;
  beats: string;
};

export type NovelOutline = {
  title: string;
  logline: string;
  setting: string;
  characters: Character[];
  chapters: OutlineChapter[];
};

export type Chapter = {
  id: string;
  title: string;
  /** The chapter's prose, with the trailing ---RECAP--- marker stripped. */
  text: string;
  /** Short paragraph summarizing what happened, fed forward into later chapters. */
  recap: string;
  /** Wall-clock ms spent on this chapter (research + prose). */
  elapsedMs: number;
  /** Number of web_search calls issued during the chapter's research phase. */
  webSearchCount: number;
  /** Approx tokens this chapter contributed to per-worker totals. */
  promptTokens: number;
  completionTokens: number;
};

export const PREMISE_RESEARCH_SYSTEM = `You are gathering setting / period / technical / cultural grounding for a long-form novel BEFORE the outline is written. You have up to 3 web_search calls.

When to search — search if the premise references any of:
- A real historical period, war, event, or movement (look up dates, sequence, key figures)
- A real place (geography, neighborhoods, landmarks, local atmosphere)
- A specific profession or technical domain (jargon, procedures, day-to-day texture)
- A real cultural / linguistic context (idioms, customs, naming conventions)

When NOT to search — emit "NO_RESEARCH_NEEDED" if the premise is:
- A wholly invented world (no real-world referents)
- Pure interpersonal drama with no era / location / profession specificity
- Already detailed enough that a writer has everything they need

When you finish (after at most 3 searches), output a single block of plain text:
RESEARCH NOTE (premise grounding):
- Concrete facts only — dates, names, places, terminology, sensory detail. 150–300 words total.
- No citations, no source URLs, no "according to…". This note feeds directly into the outliner and any citation markers will bleed into the outline structure.
- No prose, no scene-setting, no dialogue. Facts only — the outliner will weave them into the structure.

If your searches turn up nothing useful, emit "NO_RESEARCH_NEEDED".`;

export const OUTLINER_SYSTEM = `You are the OUTLINER for a long-form novel. Read the user's premise, then produce a detailed outline another writer can expand into prose.

Output STRICT JSON matching this shape — no prose, no code fences, no commentary:
{
  "title": "Working title (capitalize as a real book title).",
  "logline": "One sentence pitch — protagonist + want + obstacle.",
  "setting": "One short paragraph (3–5 sentences) describing time, place, mood, and any genre rules a chapter writer must respect.",
  "characters": [
    { "name": "Full name", "role": "protagonist|antagonist|love interest|mentor|foil|...", "description": "One sentence: appearance, voice, internal want." }
  ],
  "chapters": [
    { "id": "c1", "title": "Chapter title (no number prefix).", "beats": "2–4 sentence summary of what happens in THIS chapter. Be concrete — name the characters who appear, the location, the central event, and where the chapter ends so the next writer knows what to pick up." }
  ]
}

Rules:
- Emit EXACTLY {{targetChapters}} chapters. The caller will reject other counts.
- 2 to 6 named characters. Prefer named over generic ("the detective" → "Margot Vincent").
- Per-chapter beats must be concrete enough that a writer can produce ~{{targetWords}} words of prose from them without needing more instructions.
- The arc should follow a recognizable shape — setup → escalation → midpoint reversal → crisis → resolution — even in genre work. Do not save the inciting incident for chapter 5.
- Chapter ids are "c1", "c2", … in order. No gaps.
- Do not include meta-fields, schedules, or notes about your process.
- If a RESEARCH NOTE is provided in the user turn, treat it as ground truth — bake those facts into setting, character backstories, and chapter beats where they fit naturally. Do not contradict the note. Do not cite or reference it as a source in the outline text.`;

export const OUTLINER_REVISION_SYSTEM = `You are the OUTLINER revising a long-form novel outline based on user feedback. The PRIOR OUTLINE and the USER'S FEEDBACK are in the user turn below.

Output STRICT JSON in EXACTLY the same shape as a fresh outline — title, logline, setting, characters[], chapters[]. The full revised outline, not a diff.

Rules:
- Apply the user's feedback faithfully. Their edits are the priority.
- Preserve everything the user did NOT ask to change. Same chapter count, same character names, same arc beats unless feedback contradicts them.
- Keep EXACTLY {{targetChapters}} chapters. Chapter ids "c1", "c2", … in order.
- 2 to 6 named characters.
- Per-chapter beats stay concrete enough to write ~{{targetWords}} words from.
- If a RESEARCH NOTE is provided, treat it as ground truth and don't contradict it.
- Do not include meta-fields, change logs, or notes about your process.`;

export const CHAPTER_RESEARCH_SYSTEM = `You are gathering setting / period / technical details for ONE chapter of a novel. You have up to 2 web_search calls — use them only if the chapter's beats need real-world specificity (historical period, real city geography, technical jargon, etc.). If the chapter is pure imagination (invented world, no real-world specificity), do not search — just emit "NO_RESEARCH_NEEDED".

When you finish (after at most 2 searches), output a single block of plain text:
RESEARCH NOTE (chapter {{chapterId}}):
- Concrete facts only (dates, names, places, terminology). 100–200 words total.
- No citations, no source URLs, no "according to…". This note feeds directly into the chapter prompt and any citation markers will bleed into the final prose.
- No prose, no scene-setting, no dialogue. Facts only — the chapter writer will dramatize them.

If your searches turn up nothing useful, emit "NO_RESEARCH_NEEDED" instead.`;

export const CHAPTER_SYSTEM = `You are writing CHAPTER {{chapterNum}} of a {{totalChapters}}-chapter novel. The outline, characters, prior-chapters recap, and (if provided) a research note are below. Treat them as ground truth.

WRITE:
- ~{{targetWords}} words of prose for THIS chapter only. Do not write chapters before or after this one.
- Stay in the established voice / tense / POV. If prior chapters were past-tense limited third, you are also past-tense limited third.
- Open in-scene. Do not preamble with "Previously…" or "After the events of chapter N…".
- Do not summarize prior events except where a character would naturally reflect on them in the moment.
- Do not introduce new named characters unless the chapter's beats explicitly call for them.
- End the chapter at a natural beat — a turn, a revelation, an emotional landing — that earns the next chapter's opening.

AFTER THE PROSE:
- On a fresh line, write the literal marker:
  ---RECAP---
- Then a single paragraph (3–5 sentences) summarizing what happened in this chapter. This is for the writers of later chapters; the user never sees it. Name characters, locations, and the chapter-ending state.
- Do not write anything after the recap.`;

export const NOVEL_MODE_SYSTEM = `You are in NOVEL MODE. The system has already orchestrated the outline and per-chapter generation; the assembled novel is your previous turn. Do not re-write or summarize it.`;

/** Build the system message a chapter writer sees in addition to CHAPTER_SYSTEM. */
export function buildChapterContext(opts: {
  outline: NovelOutline;
  chapterIndex: number;
  totalChapters: number;
  priorRecap: string;
  researchNote: string | null;
}): string {
  const { outline, chapterIndex, totalChapters, priorRecap, researchNote } = opts;
  const chapter = outline.chapters[chapterIndex];
  const lines: string[] = [];
  lines.push(`NOVEL OUTLINE (ground truth — do not contradict):`);
  lines.push(`Title: ${outline.title}`);
  lines.push(`Logline: ${outline.logline}`);
  lines.push(`Setting: ${outline.setting}`);
  lines.push("");
  lines.push(`Characters:`);
  for (const c of outline.characters) {
    lines.push(`- ${c.name} (${c.role}): ${c.description}`);
  }
  lines.push("");
  lines.push(`Chapter ${chapterIndex + 1} of ${totalChapters} — "${chapter.title}"`);
  lines.push(`Beats: ${chapter.beats}`);
  lines.push("");
  if (priorRecap.trim()) {
    lines.push(`Prior chapters recap (most recent last):`);
    lines.push(priorRecap.trim());
    lines.push("");
  } else {
    lines.push(`Prior chapters recap: (none — this is the opening chapter)`);
    lines.push("");
  }
  if (researchNote && researchNote.trim() && researchNote.trim() !== "NO_RESEARCH_NEEDED") {
    lines.push(`Research note (use these facts; do not cite them as sources in the prose):`);
    lines.push(researchNote.trim());
    lines.push("");
  }
  lines.push(`Now write Chapter ${chapterIndex + 1}. Remember the ---RECAP--- marker at the end.`);
  return lines.join("\n");
}

/** Concatenate chapters into the final novel text, with title headings. */
export function assembleNovel(outline: NovelOutline, chapters: Chapter[]): string {
  const lines: string[] = [];
  lines.push(`# ${outline.title}`);
  lines.push("");
  lines.push(`> ${outline.logline}`);
  lines.push("");
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    lines.push(`## Chapter ${i + 1} — ${ch.title}`);
    lines.push("");
    lines.push(ch.text.trim());
    lines.push("");
  }
  return lines.join("\n");
}

/** Trim the running recap so it doesn't bloat across 28 chapters. Keeps the
 *  most recent N paragraphs. */
export const RECAP_MAX_PARAGRAPHS = 6;
export function trimRecap(recap: string): string {
  const paragraphs = recap.split(/\n\n+/).filter((p) => p.trim().length > 0);
  return paragraphs.slice(-RECAP_MAX_PARAGRAPHS).join("\n\n");
}
