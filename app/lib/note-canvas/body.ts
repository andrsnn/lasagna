// Pure, client-safe helpers for the pinned-note canvas. Kept separate from
// `tools.ts` (which re-exports server-only Tool definitions) so the canvas
// page can import `noteToCanvasBody` etc. without pulling the ollama SDK
// and esbuild's node:* imports into the client bundle.

import type { StoredPinnedNote } from "@/app/db";

export type NoteCanvasKind = "markdown" | "html" | "snapshot";

export type NoteCanvasBody = {
  kind: NoteCanvasKind;
  /** VFS filename used in the chat API. Tool calls must target this exactly. */
  entry: string;
  /** Current body text the model edits. */
  body: string;
};

/**
 * Map a pinned note to its canvas-editable body and the synthetic filename
 * we expose to the model. `chatSnapshot` returns a "snapshot" view because
 * v1 surfaces transcripts as read-only (the canvas page renders a
 * "Fork as markdown" action instead of writing back).
 */
export function noteToCanvasBody(note: StoredPinnedNote): NoteCanvasBody | null {
  if (typeof note.messageMarkdown === "string" && note.messageMarkdown.length > 0) {
    return { kind: "markdown", entry: "note.md", body: note.messageMarkdown };
  }
  if (typeof note.artifactHtml === "string" && note.artifactHtml.length > 0) {
    return { kind: "html", entry: "note.html", body: note.artifactHtml };
  }
  if (note.chatSnapshot) {
    return {
      kind: "snapshot",
      entry: "transcript.md",
      body: serializeSnapshot(note.chatSnapshot),
    };
  }
  return null;
}

export function serializeSnapshot(
  snapshot: NonNullable<StoredPinnedNote["chatSnapshot"]>
): string {
  return snapshot.messages
    .map((m) => `**${m.role.toUpperCase()}**\n\n${m.content}`)
    .join("\n\n---\n\n");
}
