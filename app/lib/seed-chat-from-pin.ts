"use client";

import {
  newChatTtl,
  newId,
  putChat,
  putMessage,
  type ChatTarget,
  type StoredChat,
  type StoredMessage,
  type StoredPinnedNote,
} from "@/app/db";

export type CreateChatFromPinOpts = {
  /**
   * Override the chat's `target`. The default (no target) yields a free-form
   * chat where the user iterates on the body in prose. Pass a `note-canvas`
   * target to wire the new chat into the Gemini-style canvas editor; the
   * canvas page also sets `canvasForNoteId` on the chat so listChatsForNote
   * finds it.
   */
  target?: ChatTarget;
  /**
   * Whether to seed the captured body as an assistant turn (the default —
   * the user "sees" what's in the note and types a follow-up), or skip the
   * seed entirely (canvas mode — the body is already shown in the preview
   * pane; an assistant intro would be redundant). When set to "none", an
   * empty chat is created.
   */
  seedAs?: "assistant" | "none";
  /**
   * Attach the note to the new chat as a read-only reference
   * (StoredChat.attachedPinIds) instead of copying its body into the
   * conversation. The chat page hydrates attachedPins from these ids and
   * buildExtraSystem injects them under <attached_notes> as supplementary
   * context the model reads but never writes back - so the note stays
   * untouched, the same as attaching a note when starting a chat. Implies
   * no assistant seed (the body lives in the system prompt, not a turn).
   */
  attachAsReference?: boolean;
  /** Override the chat title (canvas mode uses a tighter "Canvas · …"). */
  title?: string;
};

/**
 * Spawns a fresh free-form chat seeded from a pinned note so the user can
 * iterate on the captured content (artifact, message, or transcript) and
 * optionally re-pin it. The new chat carries `sourcePinId = note.id` so the
 * PinDialog can offer "override the original pin" on re-pin.
 */
export async function createChatFromPinnedNote(
  note: StoredPinnedNote,
  opts: CreateChatFromPinOpts = {}
): Promise<{ chatId: string }> {
  const now = Date.now();
  const chatId = newId();

  const titleSeed =
    opts.title?.trim() ||
    note.title?.trim() ||
    note.chatTitle?.trim() ||
    note.summary?.trim().slice(0, 60) ||
    "Chat from pin";

  const chat: StoredChat = {
    id: chatId,
    title: titleSeed,
    titleSource: "default",
    createdAt: now,
    updatedAt: now,
    sourcePinId: note.id,
    ...newChatTtl(now),
    ...(opts.attachAsReference ? { attachedPinIds: [note.id] } : {}),
    ...(opts.target ? { target: opts.target } : {}),
    ...(opts.target?.kind === "note-canvas"
      ? { canvasForNoteId: opts.target.noteId }
      : {}),
  };
  await putChat(chat);

  // Reference mode keeps the note out of the transcript entirely - its body
  // is injected read-only via attachedPinIds/buildExtraSystem, so seeding an
  // assistant copy would both duplicate it and invite the model to "edit" a
  // turn that never syncs back to the note.
  if (opts.attachAsReference) {
    return { chatId };
  }

  // Canvas mode skips the assistant intro — the body is already visible in
  // the preview pane, and an extra assistant bubble would just clutter the
  // chat. Free-form mode keeps the existing behavior so the user can see
  // and react to what got pinned.
  if (opts.seedAs === "none") {
    return { chatId };
  }

  const summary = note.summary ?? "";

  if (note.artifactHtml) {
    const msg: StoredMessage = {
      id: newId(),
      chatId,
      role: "assistant",
      content: summary,
      createdAt: now,
      proposedArtifact: { html: note.artifactHtml, summary },
    };
    await putMessage(msg);
  } else if (note.messageMarkdown) {
    const msg: StoredMessage = {
      id: newId(),
      chatId,
      role: "assistant",
      content: note.messageMarkdown,
      createdAt: now,
    };
    await putMessage(msg);
  } else if (note.chatSnapshot) {
    const snapshot = note.chatSnapshot;
    for (let i = 0; i < snapshot.messages.length; i++) {
      const m = snapshot.messages[i];
      const msg: StoredMessage = {
        id: newId(),
        chatId,
        role: m.role,
        content: m.content,
        createdAt: now + i,
      };
      await putMessage(msg);
    }
  }

  return { chatId };
}
