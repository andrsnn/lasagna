"use client";

// When a designer was promoted from a pinned HTML note (designer.sourceNoteId
// set), every save in the designer/app should propagate the new HTML back to
// the originating note so the /notes preview and any public share link stay
// fresh. This helper is called after each putDesigner that mutates files
// (onSaveHtml, onSaveVfs, onRevertToVersion) in the chat/designer pages.
//
// Two side effects:
//   1. Rewrite the note's `artifactHtml` and bump updatedAt. Account-sync
//      picks this up on the next push tick.
//   2. If the note carries a live `shareToken`, re-PUT the share payload in
//      Redis at the same key so the URL the recipient holds shows the latest
//      build and the TTL refreshes.
//
// The helper bails silently when the designer is multi-file (entry isn't
// "index.html" or files["index.html"] is missing) — the share surface is a
// single self-contained HTML, and a VFS-backed designer can't produce one
// here without running the bundler. That case can be handled later by
// shipping designer.lastBuild.html instead, but the convert-from-note flow
// always seeds entry="index.html" so it's the common path.

import {
  getPinnedNote,
  putPinnedNote,
  type StoredDesigner,
  type StoredPinnedNote,
} from "@/app/db";

export async function syncDesignerToSourceNote(
  designer: StoredDesigner
): Promise<void> {
  const noteId = designer.sourceNoteId;
  if (!noteId) return;
  if (designer.entry !== "index.html") return;
  const html = designer.files["index.html"];
  if (typeof html !== "string" || !html.trim()) return;

  const note = await getPinnedNote(noteId).catch(() => undefined);
  if (!note) return;
  if (note.artifactHtml === html) return;

  const now = Date.now();
  const next: StoredPinnedNote = {
    ...note,
    artifactHtml: html,
    // Best-effort title/summary refresh from the manifest. Don't overwrite
    // user-edited fields if the manifest doesn't supply better values.
    title: designer.manifest?.name ?? note.title,
    summary: designer.manifest?.description ?? note.summary,
    updatedAt: now,
  };
  await putPinnedNote(next);

  if (note.shareToken && note.shareTokenExpiresAt && note.shareTokenExpiresAt > now) {
    await republishNoteShare(next).catch(() => {
      // share refresh is best-effort; the local write already succeeded
    });
  }
}

/**
 * Re-PUT the pinned note's share payload to Redis so a live public URL
 * stays alive and shows the latest body. Exported so the note-canvas
 * persistence path (app/lib/note-canvas/persist.ts) can throttle the call
 * to "on finish only" rather than re-publishing after every assistant
 * tool round.
 */
export async function republishNoteShare(note: StoredPinnedNote): Promise<void> {
  if (!note.shareToken) return;
  // Prefer the HTML artifact when present (legacy designer-promoted notes);
  // fall back to the markdown body for canvas-edited prose notes. The share
  // endpoint discriminates on `body.kind`.
  let body: { kind: "html"; html: string } | { kind: "markdown"; markdown: string };
  if (note.artifactHtml) {
    body = { kind: "html", html: note.artifactHtml };
  } else if (note.messageMarkdown) {
    body = { kind: "markdown", markdown: note.messageMarkdown };
  } else {
    return;
  }
  const res = await fetch("/api/share-note", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reuseToken: note.shareToken,
      title: note.title,
      summary: note.summary,
      body,
    }),
  });
  if (!res.ok) return;
  const data = (await res.json().catch(() => ({}))) as {
    token?: string;
    expiresAt?: number;
  };
  if (data.token && data.expiresAt) {
    // Persist the refreshed token WITHOUT bumping updatedAt. A share-token
    // refresh is metadata bookkeeping, not a content edit, so it must not
    // advance the note's concurrency version. The canvas page's stale-write
    // guard (applyCanvasResult) compares the in-memory note.updatedAt against
    // the value on disk; bumping it here - behind React state's back - made
    // the very next save look like another tab had moved the note ahead,
    // firing a false "This note changed in another tab" banner. Preserving
    // updatedAt (via the spread) keeps disk and React state in sync.
    await putPinnedNote({
      ...note,
      shareToken: data.token,
      shareTokenExpiresAt: data.expiresAt,
    });
  }
}
