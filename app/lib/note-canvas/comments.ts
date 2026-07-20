// Pure, client-safe helpers for note-canvas review comments. Kept out of the
// page component so the prompt-building logic can be unit-reasoned about and
// reused. A NoteComment satisfies the `HighlightSpan` shape (Anchor + id), so
// the existing sentinel/re-anchor machinery in annotations/anchor.ts renders
// and re-locates comment marks for free.

import type { NoteComment } from "@/app/db";
import type { HighlightSpan } from "@/app/lib/annotations/anchor";

/** Sentinel id used for the live (in-progress) selection mark in the preview,
 *  so it can be styled distinctly from persisted comment marks. */
export const CANVAS_SELECTION_ID = "canvas-selection";

/** Narrow a comment to the anchor shape the highlight machinery expects. */
export function commentToSpan(c: NoteComment): HighlightSpan {
  return {
    id: c.id,
    selectedText: c.selectedText,
    sourceText: c.sourceText,
    startOffset: c.startOffset,
    endOffset: c.endOffset,
    occurrenceIndex: c.occurrenceIndex,
  };
}

/**
 * Build the single instruction message that asks the assistant to action every
 * outstanding comment in one edit pass. Each comment quotes its passage so the
 * model can locate the exact span to change, then states what to do. We keep
 * this document-agnostic on purpose — it works for prose, lists, HTML, etc.,
 * so the same flow serves any note kind.
 */
export function buildCommentsPrompt(comments: NoteComment[]): string {
  const blocks = comments.map((c, i) => {
    // Quote the source slice when the selection crossed inline markdown syntax
    // (`sourceText` includes the `**`/`` ` ``/link tokens) so the "appears
    // verbatim" promise below holds against the note body the model edits.
    const passage = (c.sourceText ?? c.selectedText).replace(/\n/g, " ").trim();
    return [
      `Comment ${i + 1}`,
      `Passage: "${passage}"`,
      `Instruction: ${c.body.trim()}`,
    ].join("\n");
  });
  return [
    `I left ${comments.length} comment${comments.length === 1 ? "" : "s"} on this note. ` +
      `Apply each one as an edit to the note, changing only what the comment asks for and leaving the rest untouched. ` +
      `Locate each passage in the note (the quoted text appears verbatim), then make the requested change.`,
    "",
    blocks.join("\n\n"),
    "",
    "When you're done, briefly summarize what you changed for each comment.",
  ].join("\n");
}
