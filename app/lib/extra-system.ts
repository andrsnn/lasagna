// Builds the `extraSystem` string injected into the chat's system prompt by
// `Chat` (see app/components/chat.tsx:169) and consumed by the chat API at
// app/api/chat/work.ts:626 via `body.system`.
//
// Two inputs feed it:
//   1. The designer's CLAUDE.md-style project notes (durable; produced by
//      `/api/notes`). Always first so it's the load-bearing context.
//   2. Pinned notes the user attached to the chat for ephemeral context.
//      Wrapped in `<attached_notes>` so the model can distinguish supplementary
//      research from durable project memory.
//
// No caps: when the user attaches a pin they expect the *whole* note in the
// conversation, and silently clipping mid-content (the old 4k/16k caps
// dropped ~73 rows of a 100-row data sheet) is worse than letting the model
// surface an explicit "too long for my context" error if it ever happens.
// Every model wired up in app/models.ts has at least a 128k-token context.

import type { StoredPinnedNote } from "@/app/db";
import { deriveNoteTitle, stripHtmlToText } from "@/app/lib/note-title";

const stripHtml = stripHtmlToText;

function pinBody(pin: StoredPinnedNote): string {
  if (pin.messageMarkdown && pin.messageMarkdown.trim()) {
    return pin.messageMarkdown.trim();
  }
  if (pin.artifactHtml && pin.artifactHtml.trim()) {
    return stripHtml(pin.artifactHtml);
  }
  if (pin.chatSnapshot && pin.chatSnapshot.messages.length) {
    return pin.chatSnapshot.messages
      .map((m) => `[${m.role}] ${m.content}`)
      .join("\n\n");
  }
  return pin.summary?.trim() ?? "";
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildExtraSystem(
  notes: string | undefined,
  pins: StoredPinnedNote[] | undefined,
  sessionMemoryNoteId?: string
): string | undefined {
  const trimmedNotes = notes?.trim();
  const validPins = (pins ?? []).filter((p) => !!p);

  if (!trimmedNotes && validPins.length === 0) return undefined;

  const parts: string[] = [];
  if (trimmedNotes) parts.push(trimmedNotes);

  if (validPins.length > 0) {
    const regularPins: StoredPinnedNote[] = [];
    let memoryPin: StoredPinnedNote | undefined;
    for (const pin of validPins) {
      if (sessionMemoryNoteId && pin.id === sessionMemoryNoteId) {
        memoryPin = pin;
      } else {
        regularPins.push(pin);
      }
    }

    if (regularPins.length > 0) {
      const noteTags: string[] = [];
      for (const pin of regularPins) {
        const body = pinBody(pin);
        if (!body) continue;
        const title = deriveNoteTitle(pin);
        noteTags.push(
          `  <note id="${escapeAttr(pin.id)}" title="${escapeAttr(title)}">\n${body}\n  </note>`
        );
      }
      if (noteTags.length > 0) {
        parts.push(
          `<attached_notes>\n${noteTags.join("\n")}\n</attached_notes>\n\nThe <attached_notes> block above contains research the user attached for this conversation only. Treat it as supplementary reference material, not as durable project state.`
        );
      }
    }

    if (memoryPin) {
      const body = pinBody(memoryPin);
      if (body) {
        const title = memoryPin.title?.trim() || memoryPin.summary?.trim().slice(0, 60) || "Session memory";
        parts.push(
          `<session_memory title="${escapeAttr(title)}">\n${body}\n</session_memory>\n\nThe <session_memory> block above is a running session note the user maintains across this conversation. Reference patterns and observations from it when relevant to the discussion.`
        );
      }
    }
  }

  return parts.join("\n\n");
}
