"use client";

// Write back a canvas-edit result onto the source pinned note. Called by the
// canvas page's onSaveVfs handler (via Chat's finalization), and only at
// "stream done" — never per-`file_changed` event. Refreshing a live public
// share on every assistant tool round would burn through Redis writes.

import {
  getPinnedNote,
  putPinnedNote,
  type ArtifactFiles,
  type StoredPinnedNote,
} from "@/app/db";
import { republishNoteShare } from "@/app/lib/sync-source-note";
import type { NoteCanvasKind } from "@/app/lib/note-canvas/body";

export type ApplyCanvasResultArgs = {
  /** The note row the chat is editing — the version the user last loaded. */
  note: StoredPinnedNote;
  /** Final VFS from the assistant. Must contain a single key matching `entry`. */
  files: ArtifactFiles;
  /** Synthetic VFS path the body landed at (note.md / note.html / transcript.md). */
  entry: string;
  /** Body kind, used to decide which field on the note we rewrite. */
  kind: NoteCanvasKind;
};

export type ApplyCanvasResultOutcome =
  | { ok: true; note: StoredPinnedNote }
  | { ok: false; reason: "missing" | "noop" | "empty" };

/**
 * Persist a canvas edit. Last write wins: we always rebase onto the freshest
 * copy of the note in IDB and overwrite the body field, so a save can never
 * be blocked by a concurrent edit in another tab. Returns:
 *   - { ok: true, note }      → wrote, callers should refresh local state
 *   - { ok: false, "missing" }→ the note was deleted out from under us
 *   - { ok: false, "noop" }   → no actual content change (the assistant ran
 *                                tools but they were inert); skips the write
 */
export async function applyCanvasResult({
  note,
  files,
  entry,
  kind,
}: ApplyCanvasResultArgs): Promise<ApplyCanvasResultOutcome> {
  const body = files[entry];
  if (typeof body !== "string") return { ok: false, reason: "noop" };

  // Last-write-wins: rebase onto the freshest copy in IDB rather than the
  // (possibly stale) `note` the caller loaded. We deliberately do NOT compare
  // `updatedAt` and refuse on a mismatch - a concurrent edit in another tab
  // must never block this save. Reading `current` here means we still preserve
  // any sibling fields the other tab touched; only the body is overwritten.
  const current = await getPinnedNote(note.id).catch(() => undefined);
  if (!current) return { ok: false, reason: "missing" };

  // Snapshot-kind notes are read-only in v1; refuse to write back so a
  // misrouted call can't clobber the transcript. The canvas page never
  // reaches this branch — its "Fork as markdown" action targets a fresh
  // note instead of writing back — but this is a belt-and-braces guard.
  if (kind === "snapshot") return { ok: false, reason: "noop" };

  // Never blank a note. An empty / whitespace-only body reaching here means the
  // edit went wrong upstream (a truncated stream, a failed artifact parse, or a
  // user clearing the manual editor). Writing it would destroy a working note -
  // exactly the "edit blanked my note" bug. Refuse and keep the existing body.
  const currentBody = kind === "html" ? current.artifactHtml : current.messageMarkdown;
  if (body.trim().length === 0 && (currentBody ?? "").trim().length > 0) {
    return { ok: false, reason: "empty" };
  }

  // No-op short-circuit: the model finished without touching the body.
  if (kind === "markdown" && current.messageMarkdown === body) {
    return { ok: false, reason: "noop" };
  }
  if (kind === "html" && current.artifactHtml === body) {
    return { ok: false, reason: "noop" };
  }

  const now = Date.now();
  // Stash the body we're about to replace so the canvas can offer a one-step
  // Revert (notes had no edit history at all before this).
  const next: StoredPinnedNote = {
    ...current,
    ...(kind === "markdown"
      ? { messageMarkdown: body, prevMessageMarkdown: current.messageMarkdown }
      : {}),
    ...(kind === "html"
      ? { artifactHtml: body, prevArtifactHtml: current.artifactHtml }
      : {}),
    updatedAt: now,
  };
  await putPinnedNote(next);

  // Best-effort share refresh on finalize. Same gate as
  // syncDesignerToSourceNote — only when there's a live, unexpired token.
  if (next.shareToken && next.shareTokenExpiresAt && next.shareTokenExpiresAt > now) {
    void republishNoteShare(next).catch(() => {
      // share refresh failure doesn't fail the canvas write
    });
  }

  return { ok: true, note: next };
}

/**
 * Convert a markdown note into an HTML note. Flips the note's kind by clearing
 * `messageMarkdown` (which `noteToCanvasBody` keys off) and writing the supplied
 * HTML document into `artifactHtml`. The original markdown is preserved in
 * `prevMessageMarkdown` so nothing is lost. The caller renders the document via
 * `markdownNoteToHtmlDocument` (client-only: it uses react-dom/server), so this
 * stays a pure persistence step.
 */
export async function convertNoteToHtml(
  noteId: string,
  htmlDoc: string
): Promise<ApplyCanvasResultOutcome> {
  const current = await getPinnedNote(noteId).catch(() => undefined);
  if (!current) return { ok: false, reason: "missing" };
  // Only markdown notes convert; an html/snapshot note has nothing to flip.
  if (typeof current.messageMarkdown !== "string" || current.messageMarkdown.length === 0) {
    return { ok: false, reason: "noop" };
  }
  if (htmlDoc.trim().length === 0) return { ok: false, reason: "empty" };

  const now = Date.now();
  const next: StoredPinnedNote = {
    ...current,
    artifactHtml: htmlDoc,
    prevArtifactHtml: current.artifactHtml,
    // Clear markdown so noteToCanvasBody() resolves kind:"html"; keep the source
    // in prevMessageMarkdown as a recovery copy.
    messageMarkdown: undefined,
    prevMessageMarkdown: current.messageMarkdown,
    updatedAt: now,
  };
  await putPinnedNote(next);

  if (next.shareToken && next.shareTokenExpiresAt && next.shareTokenExpiresAt > now) {
    void republishNoteShare(next).catch(() => {
      // share refresh failure doesn't fail the conversion
    });
  }

  return { ok: true, note: next };
}

/** Whether a one-step Revert is available for this note's active body kind. */
export function canRevertCanvas(note: StoredPinnedNote, kind: NoteCanvasKind): boolean {
  if (kind === "html") return typeof note.prevArtifactHtml === "string";
  if (kind === "markdown") return typeof note.prevMessageMarkdown === "string";
  return false;
}

/**
 * Undo the most recent canvas edit: swap the stashed previous body back into
 * the live field (and keep the now-undone body as the new prev, so Revert
 * toggles back and forth). Rebases onto the freshest copy in IDB.
 */
export async function revertCanvasNote(
  noteId: string,
  kind: NoteCanvasKind
): Promise<ApplyCanvasResultOutcome> {
  const current = await getPinnedNote(noteId).catch(() => undefined);
  if (!current) return { ok: false, reason: "missing" };
  if (kind === "html") {
    if (typeof current.prevArtifactHtml !== "string") return { ok: false, reason: "noop" };
    const next: StoredPinnedNote = {
      ...current,
      artifactHtml: current.prevArtifactHtml,
      prevArtifactHtml: current.artifactHtml,
      updatedAt: Date.now(),
    };
    await putPinnedNote(next);
    return { ok: true, note: next };
  }
  if (kind === "markdown") {
    if (typeof current.prevMessageMarkdown !== "string") return { ok: false, reason: "noop" };
    const next: StoredPinnedNote = {
      ...current,
      messageMarkdown: current.prevMessageMarkdown,
      prevMessageMarkdown: current.messageMarkdown,
      updatedAt: Date.now(),
    };
    await putPinnedNote(next);
    return { ok: true, note: next };
  }
  return { ok: false, reason: "noop" };
}
