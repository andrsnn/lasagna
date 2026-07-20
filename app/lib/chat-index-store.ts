"use client";

import { useEffect, useState } from "react";
import {
  clearPersistedChatIndex,
  loadAllMessageBodies,
  loadPersistedChatIndex,
  savePersistedChatIndex,
  type StoredChat,
} from "@/app/db";
import {
  buildChatIndex,
  indexFromPersisted,
  indexToPersisted,
  patchChatIndex,
  type ChatIndex,
  type ChatRow,
  type PersistedChatIndex,
} from "@/app/lib/chat-search";

export type ChatIndexStatus =
  | { kind: "idle" }
  | { kind: "loading"; mode: "initial" | "patch" | "rebuild"; chatCount: number }
  | { kind: "ready"; index: ChatIndex }
  | { kind: "error"; message: string };

type Listener = (status: ChatIndexStatus) => void;

// Module-level singleton. The Chats page and Settings dialog both subscribe;
// both see the same index state.
let status: ChatIndexStatus = { kind: "idle" };
const listeners = new Set<Listener>();
let inflight: Promise<void> | null = null;
let initialized = false;

function emit() {
  for (const l of listeners) l(status);
}

function setStatus(next: ChatIndexStatus) {
  status = next;
  emit();
}

function chatRowFor(chat: StoredChat, body: string, indexedAt: number): ChatRow {
  return { id: chat.id, title: chat.title, body, indexedAt };
}

async function fullBuild(currentChats: StoredChat[]): Promise<ChatIndex> {
  setStatus({ kind: "loading", mode: "initial", chatCount: currentChats.length });
  const bodies = await loadAllMessageBodies();
  const now = Date.now();
  const rows: ChatRow[] = currentChats.map((c) =>
    chatRowFor(c, bodies.get(c.id) ?? "", now)
  );
  const index = buildChatIndex(rows);
  await savePersistedChatIndex(indexToPersisted(index));
  return index;
}

async function ensureFreshInner(currentChats: StoredChat[]): Promise<void> {
  // First-ever call this session: try to hydrate from disk.
  if (!initialized) {
    initialized = true;
    setStatus({ kind: "loading", mode: "initial", chatCount: currentChats.length });
    try {
      const persisted = await loadPersistedChatIndex<PersistedChatIndex>();
      if (persisted && persisted.version === 2) {
        const index = indexFromPersisted(persisted);
        setStatus({ kind: "ready", index });
      } else {
        const index = await fullBuild(currentChats);
        setStatus({ kind: "ready", index });
        return;
      }
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  if (status.kind !== "ready") return;
  const index = status.index;

  // Diff: dirty chats (new or updatedAt > indexedAt) and removed chats.
  const currentIds = new Set(currentChats.map((c) => c.id));
  const removeIds: string[] = [];
  for (const id of index.byChat.keys()) {
    if (!currentIds.has(id)) removeIds.push(id);
  }
  const dirty: StoredChat[] = [];
  for (const c of currentChats) {
    const entry = index.byChat.get(c.id);
    if (!entry || c.updatedAt > entry.indexedAt) dirty.push(c);
  }
  if (dirty.length === 0 && removeIds.length === 0) return;

  setStatus({
    kind: "loading",
    mode: "patch",
    chatCount: index.numChats,
  });
  try {
    const bodies =
      dirty.length > 0
        ? await loadAllMessageBodies(dirty.map((c) => c.id))
        : new Map<string, string>();
    const now = Date.now();
    const upserts: ChatRow[] = dirty.map((c) =>
      chatRowFor(c, bodies.get(c.id) ?? "", now)
    );
    const next = patchChatIndex(index, upserts, removeIds);
    await savePersistedChatIndex(indexToPersisted(next));
    setStatus({ kind: "ready", index: next });
  } catch (err) {
    setStatus({
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export function ensureFreshChatIndex(currentChats: StoredChat[]): Promise<void> {
  // Coalesce concurrent calls. The chats page might fire ensureFresh several
  // times in quick succession (hydration + auto-title rewrite); we only ever
  // want one IDB pass in flight.
  if (inflight) return inflight;
  inflight = ensureFreshInner(currentChats).finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function rebuildChatIndex(currentChats: StoredChat[]): Promise<void> {
  // Wait for any in-flight patch so we don't race with ourselves.
  if (inflight) await inflight.catch(() => {});
  inflight = (async () => {
    setStatus({ kind: "loading", mode: "rebuild", chatCount: currentChats.length });
    try {
      await clearPersistedChatIndex();
      initialized = true; // already in the post-init lifecycle
      const index = await fullBuild(currentChats);
      setStatus({ kind: "ready", index });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function subscribeChatIndex(listener: Listener): () => void {
  listeners.add(listener);
  listener(status);
  return () => {
    listeners.delete(listener);
  };
}

export function getChatIndexStatus(): ChatIndexStatus {
  return status;
}

/** React hook wrapper. Returns the current status; re-renders on changes. */
export function useChatIndexStatus(): ChatIndexStatus {
  const [snapshot, setSnapshot] = useState<ChatIndexStatus>(status);
  useEffect(() => subscribeChatIndex(setSnapshot), []);
  return snapshot;
}
