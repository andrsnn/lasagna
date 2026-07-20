"use client";

// Client helper that takes a SharedChatPayload (fetched from
// /api/share/chat/[token]) and writes a fresh chat + message rows into the
// recipient's IndexedDB with new ids. The recipient gets a free-form chat
// row — designer/app targets are intentionally dropped because the recipient
// doesn't have those local rows.

import { newId, putChat, putMessage, type StoredChat, type StoredMessage } from "@/app/db";
import type { SharedChatPayload } from "@/app/lib/chat-share-store";

export async function importSharedChat(
  payload: SharedChatPayload
): Promise<{ id: string }> {
  if (typeof indexedDB === "undefined") {
    throw new Error(
      "Local storage is unavailable. Open the link in a regular browser window (not private/incognito) to import this chat."
    );
  }

  const id = newId();
  const now = Date.now();

  const chat: StoredChat = {
    id,
    title: payload.chat.title || "Shared chat",
    model: payload.chat.model,
    createdAt: now,
    updatedAt: now,
  };

  await putChat(chat);

  // Preserve message ordering by spacing them at 1ms intervals starting from
  // `now`. Original timestamps are stored on the wire but using them here
  // would push the chat down listings; the recipient's IDB cares about
  // order-within-chat, not absolute time.
  let i = 0;
  for (const m of payload.messages) {
    const msg: StoredMessage = {
      id: newId(),
      chatId: id,
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      images: m.images,
      pdfs: m.pdfs?.map((p) => ({ ...p, text: "", textChars: 0 })),
      createdAt: now + i,
      model: m.model,
      usage: m.usage,
      error: m.error,
    };
    await putMessage(msg);
    i += 1;
  }

  return { id };
}
