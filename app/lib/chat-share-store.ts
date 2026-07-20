// Server-side store for chat share links.
//
// Mirrors share-store.ts (apps), but persists a chat + its messages instead of
// a designer + app. The owner POSTs the chat and message rows to
// `/api/share-chat`; we strip implementation noise (streaming cursors, tool
// events, proposed artifacts), call Gemma for a short summary, and write the
// payload into Upstash Redis under `artifacts:share-chat:{token}` with a 7-day
// TTL. The recipient's browser fetches by token and writes a fresh chat +
// messages into their IndexedDB.
//
// Redis is purely the courier — IndexedDB on each device remains canonical.
//
// Credential discovery is shared with share-store.ts via a single readRedisCreds
// import to keep one canonical env-var contract.

import { Redis } from "@upstash/redis";
import type { AttachedImage, AttachedPdf, MessageRole, StoredChat, StoredMessage, StoredUsage } from "@/app/db";

export const CHAT_SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Upstash REST has a ~1 MB request limit; leave headroom for auth + Redis overhead. */
export const MAX_CHAT_SHARE_BYTES = 500_000;

/** 22 URL-safe base64 chars from 16 random bytes. */
export const CHAT_SHARE_TOKEN_REGEX = /^[A-Za-z0-9_-]{22}$/;

const KEY_PREFIX = "artifacts:share-chat";

/**
 * Allow-listed message fields that travel over the wire. We deliberately drop
 * tool events, streaming cursors, proposed VFS edits and compaction bookkeeping
 * — they're meaningless to a recipient viewing the conversation read-only.
 */
/**
 * Shared chats render PDF pills read-only, so we drop the bulky `text` /
 * `textChars` fields when serializing — they'd blow MAX_CHAT_SHARE_BYTES on
 * a long extract and are useless without the model regenerating a reply.
 */
export type SharedChatPdf = Omit<AttachedPdf, "text" | "textChars">;

export type SharedChatMessage = {
  role: MessageRole;
  content: string;
  thinking?: string;
  images?: AttachedImage[];
  pdfs?: SharedChatPdf[];
  createdAt: number;
  model?: string;
  usage?: StoredUsage;
  error?: string;
};

export type SharedChat = {
  title: string;
  /** "free-form" | "designer-edit" | "app-setup" — surfaced in the viewer header. */
  kind: "free-form" | "designer-edit" | "app-setup";
  /** Snapshot of the original target name so the recipient sees what it was about. */
  targetName?: string;
  model?: string;
  createdAt: number;
};

export type SharedChatPayload = {
  chat: SharedChat;
  messages: SharedChatMessage[];
  summary: string;
  createdAt: number;
  expiresAt: number;
};

export function serializeChatForShare(
  chat: StoredChat,
  messages: StoredMessage[],
  opts: { includeImages: boolean; targetName?: string }
): { chat: SharedChat; messages: SharedChatMessage[] } {
  const kind: SharedChat["kind"] = !chat.target
    ? "free-form"
    : chat.target.kind === "designer"
    ? "designer-edit"
    : "app-setup";

  const visible = messages
    .filter((m) => m.kind !== "summary" && !m.summarizedInto && m.role !== "system")
    .sort((a, b) => a.createdAt - b.createdAt);

  return {
    chat: {
      title: chat.title,
      kind,
      targetName: opts.targetName,
      model: chat.model,
      createdAt: chat.createdAt,
    },
    messages: visible.map((m) => ({
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      images: opts.includeImages ? m.images : undefined,
      pdfs: m.pdfs?.map(({ text: _text, textChars: _textChars, ...rest }) => rest),
      createdAt: m.createdAt,
      model: m.model,
      usage: m.usage,
      error: m.error,
    })),
  };
}

let cached: Redis | null = null;
let cachedError: Error | null = null;

function readRedisCreds(): { url?: string; token?: string } {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  };
}

function getRedis(): Redis {
  if (cached) return cached;
  if (cachedError) throw cachedError;
  const { url, token } = readRedisCreds();
  if (!url || !token) {
    cachedError = new Error(
      "Chat sharing needs Redis credentials. Provision an Upstash Redis (or Vercel KV) " +
        "database and expose either UPSTASH_REDIS_REST_URL+UPSTASH_REDIS_REST_TOKEN or " +
        "KV_REST_API_URL+KV_REST_API_TOKEN to the project."
    );
    throw cachedError;
  }
  cached = new Redis({ url, token });
  return cached;
}

export function isChatShareStoreConfigured(): boolean {
  const { url, token } = readRedisCreds();
  return !!(url && token);
}

function shareKey(token: string): string {
  return `${KEY_PREFIX}:${token}`;
}

export async function putChatShare(
  token: string,
  payload: SharedChatPayload
): Promise<void> {
  const redis = getRedis();
  await redis.set(shareKey(token), JSON.stringify(payload), {
    ex: CHAT_SHARE_TTL_SECONDS,
  });
}

/** Revoke a shared-chat link: delete the Redis row so the public read 410s. */
export async function delChatShare(token: string): Promise<void> {
  const redis = getRedis();
  await redis.del(shareKey(token));
}

export async function getChatShare(
  token: string
): Promise<SharedChatPayload | null> {
  const redis = getRedis();
  const raw = await redis.get<string | SharedChatPayload>(shareKey(token));
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as SharedChatPayload;
    } catch {
      return null;
    }
  }
  return raw;
}

function base64urlFromBytes(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 22 URL-safe base64 chars (~128 bits of entropy from 16 random bytes). */
export function newChatShareToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64urlFromBytes(bytes);
}
