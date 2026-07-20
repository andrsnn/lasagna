"use client";

// Client helper that copies an existing chat into a new chat with fresh ids.
// Sibling to import-share-chat.ts, but the source is local IDB instead of a
// fetched SharedChatPayload. The new chat preserves model, target, and full
// message history so the user can continue the conversation in a branch
// without touching the original.

import {
  getChat,
  loadMessages,
  newChatTtl,
  newId,
  putChat,
  putMessage,
  type StoredChat,
  type StoredMessage,
} from "@/app/db";

const FORK_TITLE_MAX = 120;

export async function forkChat(
  sourceChatId: string
): Promise<{ id: string }> {
  if (typeof indexedDB === "undefined") {
    throw new Error(
      "Local storage is unavailable. Open the app in a regular browser window (not private/incognito) to fork this chat."
    );
  }

  const source = await getChat(sourceChatId);
  if (!source) {
    throw new Error("Source chat not found.");
  }

  const messages = await loadMessages(sourceChatId);

  // Skip messages mid-stream (their streamId would resume against the wrong
  // chat) and any compaction-summary rows along with the originals they
  // subsumed — the fork starts from a clean replayable history.
  const subsumedByThisFork = new Set<string>();
  for (const m of messages) {
    if (m.kind === "summary" && m.subsumedIds) {
      for (const sid of m.subsumedIds) subsumedByThisFork.add(sid);
    }
  }
  const keep = messages.filter(
    (m) => !m.streamId && m.kind !== "summary" && !subsumedByThisFork.has(m.id)
  );

  const id = newId();
  const now = Date.now();
  const baseTitle = `Fork of ${source.title || "Untitled chat"}`;
  const title =
    baseTitle.length > FORK_TITLE_MAX
      ? `${baseTitle.slice(0, FORK_TITLE_MAX - 1)}…`
      : baseTitle;

  const chat: StoredChat = {
    id,
    title,
    titleSource: "user",
    titleUpdatedAt: now,
    model: source.model,
    target: source.target,
    forkedFromChatId: source.id,
    createdAt: now,
    updatedAt: now,
    ...newChatTtl(now),
  };

  await putChat(chat);

  let i = 0;
  for (const m of keep) {
    const cloned: StoredMessage = {
      ...m,
      id: newId(),
      chatId: id,
      createdAt: now + i,
    };
    delete cloned.streamId;
    delete cloned.streamCursor;
    delete cloned.queued;
    delete cloned.summarizedInto;
    delete cloned.subsumedIds;
    await putMessage(cloned);
    i += 1;
  }

  return { id };
}
