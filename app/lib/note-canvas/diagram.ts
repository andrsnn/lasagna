// Prompt builder for the "highlight → Diagram" canvas action. The user
// highlights a passage and asks for a picture of it; we hand the assistant a
// one-shot instruction to insert a diagram next to that passage. Kept
// document-agnostic (works for prose, lists, HTML) and separate from the page
// component so the wording stays easy to reason about.

/**
 * Build the message that asks the assistant to add a diagram illustrating the
 * highlighted passage. We quote the passage (verbatim) so the model can locate
 * where to insert, and steer it to ADD a diagram after it rather than rewrite
 * the text. The renderer supports Mermaid in markdown notes and inline SVG in
 * HTML notes; NOTE_EDIT_SYSTEM already tells the model which to use per note
 * kind, so this stays format-neutral.
 */
export function buildDiagramPrompt(selectedText: string): string {
  const passage = selectedText.replace(/\s+/g, " ").trim();
  return [
    `Draw a small, accurate diagram that illustrates this passage, and insert it in the note right after the passage (add it — don't rewrite or remove the text):`,
    "",
    `"${passage}"`,
    "",
    `Pick the diagram type that fits what the passage describes (flow, sequence, architecture, states, relationships, timeline). Keep it tight and legible. When you're done, say in one line what the diagram shows.`,
  ].join("\n");
}
