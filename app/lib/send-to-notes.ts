"use client";

// Pushes content from a chat (whole transcript or single message) into a
// target designer's CLAUDE.md-style notes file. Reuses `/api/notes` — the
// same endpoint the designer's background notes-refresh hits — but passes a
// `mergeHint` so the model knows the source is supplementary research, not
// the app's build chat. The merged notes are saved with `putDesigner` so
// every future chat targeting this designer sees them via `extraSystem`
// (see app/lib/extra-system.ts).

import { getDesigner, putDesigner, type StoredDesigner } from "@/app/db";

export type SendToNotesSource =
  | {
      kind: "chat";
      messages: { role: "user" | "assistant" | "system"; content: string }[];
    }
  | {
      kind: "message";
      role: "user" | "assistant";
      content: string;
    };

export type SendToNotesResult =
  | { ok: true; designer: StoredDesigner }
  | { ok: false; error: string };

const RESEARCH_MERGE_HINT =
  "This content comes from a separate research chat, not the app's build chat — treat it as supplementary research to merge into Architecture or Core Decisions. Do not assume it describes the app's current implementation.";

export async function sendToAppNotes(
  designerId: string,
  source: SendToNotesSource
): Promise<SendToNotesResult> {
  const designer = await getDesigner(designerId);
  if (!designer) {
    return { ok: false, error: "Designer not found." };
  }

  const chatMessages =
    source.kind === "chat"
      ? source.messages.filter((m) => m.role !== "system" && m.content?.trim())
      : [{ role: source.role, content: source.content }];

  if (chatMessages.length === 0) {
    return { ok: false, error: "Nothing to send — empty content." };
  }

  const recentCommits = (designer.history ?? [])
    .slice(-5)
    .reverse()
    .map((h) => ({
      version: h.version,
      commitMessage: h.commitMessage,
      savedAt: h.savedAt,
    }));

  let res: Response;
  try {
    res = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        designerName: designer.name,
        designerDescription: designer.description,
        currentNotes: designer.notes,
        recentCommits,
        chatMessages,
        mergeHint: RESEARCH_MERGE_HINT,
      }),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }

  if (!res.ok) {
    return { ok: false, error: `Notes endpoint returned ${res.status}` };
  }

  let payload: { notes?: string };
  try {
    payload = (await res.json()) as { notes?: string };
  } catch {
    return { ok: false, error: "Invalid response from notes endpoint." };
  }
  if (!payload.notes || !payload.notes.trim()) {
    return { ok: false, error: "Empty notes returned." };
  }

  // Re-read the designer in case it changed between our initial read and the
  // network round-trip (e.g. a concurrent commit from the editor). Last-write
  // wins on the notes field — the merged content from the model is the new
  // canonical state.
  const fresh = (await getDesigner(designerId)) ?? designer;
  const next: StoredDesigner = {
    ...fresh,
    notes: payload.notes.trim(),
    notesUpdatedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await putDesigner(next);
  return { ok: true, designer: next };
}
