// Therapist-mode companion notes. Two pinned notes per therapy chat, both
// created lazily and linked from the chat row:
//
//   1. "Saved passages" (chat.therapyClipsNoteId) — verbatim quotes the user
//      highlighted in the transcript. Append-only from this module; the AI
//      never rewrites it.
//   2. "Session notes" (chat.sessionMemoryNoteId) — an AI-maintained running
//      summary of what's going on with the user, refreshed in the background
//      after each exchange via /api/session-note/update. Reuses the chat-wide
//      sessionMemoryNoteId field (and attachedPinIds) so the regular chat
//      view injects the same memory through buildExtraSystem.
//
// Both are ordinary pinned notes, so they show up on /notes and survive the
// chat's deletion like any other pin.

import {
  getChat,
  getPinnedNote,
  newId,
  putChat,
  putPinnedNote,
  type MessageRole,
  type StoredChat,
  type StoredPinnedNote,
} from "@/app/db";

async function getOrCreateNote(
  chatId: string,
  field: "therapyClipsNoteId" | "sessionMemoryNoteId",
  makeTitle: (chat: StoredChat) => string
): Promise<{ note: StoredPinnedNote; chat: StoredChat } | null> {
  const chat = await getChat(chatId);
  if (!chat) return null;
  const existingId = chat[field];
  if (existingId) {
    const existing = await getPinnedNote(existingId);
    if (existing) return { note: existing, chat };
    // Pointer is stale (note deleted from /notes) — fall through and recreate.
  }
  const now = Date.now();
  const note: StoredPinnedNote = {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    title: makeTitle(chat),
    chatId: chat.id,
    chatTitle: chat.title,
    linkToChat: true,
    messageMarkdown: "",
  };
  await putPinnedNote(note);
  const updatedChat: StoredChat = { ...chat, [field]: note.id, updatedAt: now };
  await putChat(updatedChat);
  return { note, chat: updatedChat };
}

export async function getOrCreateClipsNote(
  chatId: string
): Promise<{ note: StoredPinnedNote; chat: StoredChat } | null> {
  return getOrCreateNote(
    chatId,
    "therapyClipsNoteId",
    (c) => `Saved passages — ${c.title}`
  );
}

export async function getOrCreateSessionNote(
  chatId: string
): Promise<{ note: StoredPinnedNote; chat: StoredChat } | null> {
  const res = await getOrCreateNote(
    chatId,
    "sessionMemoryNoteId",
    (c) => `Session notes — ${c.title}`
  );
  if (!res) return null;
  // The regular chat view only injects session memory when the pin is also
  // attached (buildExtraSystem reads attachedPins), so keep it listed there.
  if (!res.chat.attachedPinIds?.includes(res.note.id)) {
    const chat: StoredChat = {
      ...res.chat,
      attachedPinIds: [...(res.chat.attachedPinIds ?? []), res.note.id],
      updatedAt: Date.now(),
    };
    await putChat(chat);
    return { note: res.note, chat };
  }
  return res;
}

/**
 * Append a highlighted passage to the chat's "Saved passages" note as a
 * dated blockquote. Returns the updated note (or null when the chat row is
 * missing — e.g. it was purged from trash mid-session).
 */
export async function appendClip(
  chatId: string,
  text: string
): Promise<StoredPinnedNote | null> {
  const res = await getOrCreateClipsNote(chatId);
  if (!res) return null;
  const date = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const quoted = text.trim().replace(/\n/g, "\n> ");
  const entry = `> ${quoted}\n>\n> — *${date}*`;
  const prior = res.note.messageMarkdown?.trim();
  const updated: StoredPinnedNote = {
    ...res.note,
    messageMarkdown: prior ? `${prior}\n\n${entry}` : entry,
    updatedAt: Date.now(),
  };
  await putPinnedNote(updated);
  return updated;
}

/**
 * Refresh the AI-maintained session notes from the recent transcript.
 * Network + LLM call — callers should fire-and-forget and swallow failures
 * (the next exchange retries naturally).
 */
export async function syncSessionNote(opts: {
  chatId: string;
  messages: { role: MessageRole; content: string }[];
  model?: string;
  runpodEndpointId?: string;
}): Promise<StoredPinnedNote | null> {
  const res = await getOrCreateSessionNote(opts.chatId);
  if (!res) return null;
  const r = await fetch("/api/session-note/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "therapy",
      messages: opts.messages.slice(-50),
      noteBody: res.note.messageMarkdown ?? "",
      noteTitle: res.note.title,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.runpodEndpointId
        ? { runpodEndpointId: opts.runpodEndpointId }
        : {}),
    }),
  });
  if (!r.ok) throw new Error(`Session note update failed: HTTP ${r.status}`);
  const data = (await r.json()) as { updatedBody: string };
  // Re-read before writing — the row may have synced from another tab while
  // the LLM call was in flight.
  const fresh = (await getPinnedNote(res.note.id)) ?? res.note;
  const updated: StoredPinnedNote = {
    ...fresh,
    messageMarkdown: data.updatedBody,
    updatedAt: Date.now(),
  };
  await putPinnedNote(updated);
  return updated;
}
