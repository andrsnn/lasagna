// POST /api/share-chat — owner uploads a chat + its messages to Redis with a
// 7-day TTL, gets back a token + URL the recipient can paste into a browser.
//
// The path lives at /api/share-chat (not /api/share/chat) on purpose: the auth
// proxy (proxy.ts) bypasses the prefix `/api/share/` for unauthenticated
// recipients, so a POST nested under that prefix would skip the session check.
// The matching GET route is /api/share/chat/[token] — under the public prefix.

import { chatClientFor } from "@/app/lib/llm/router";
import {
  CHAT_SHARE_TTL_SECONDS,
  MAX_CHAT_SHARE_BYTES,
  isChatShareStoreConfigured,
  newChatShareToken,
  putChatShare,
  serializeChatForShare,
  type SharedChatPayload,
} from "@/app/lib/chat-share-store";
import type { StoredChat, StoredMessage } from "@/app/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUMMARY_MODEL = "gemma4:31b";

// Hard cap on how long we'll wait for the model. The share button stalls
// until this resolves, and a 30s spin makes the dialog feel broken — better
// to ship the link with a title-only summary than make the user stare at a
// spinner. Tuned around p95 of a healthy Gemma response.
const SUMMARY_TIMEOUT_MS = 5_000;

const SUMMARY_SYSTEM = `You write a 2-3 sentence plain-prose description of a chat conversation, so a recipient deciding whether to import it knows what it's about. No preamble. No "this chat" or "this conversation". No emojis. Mention the topic and what was decided or recommended. Avoid implementation details. Aim for under 60 words.`;

type Body = {
  chat?: StoredChat;
  messages?: StoredMessage[];
  includeImages?: boolean;
  targetName?: string;
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { chat, messages, includeImages, targetName } = body;
  if (!chat || !chat.id || typeof chat.title !== "string") {
    return Response.json({ error: "chat is required." }, { status: 400 });
  }
  if (!Array.isArray(messages)) {
    return Response.json({ error: "messages must be an array." }, { status: 400 });
  }
  if (messages.length === 0) {
    return Response.json(
      { error: "Chat has no messages to share yet." },
      { status: 400 }
    );
  }

  if (!isChatShareStoreConfigured()) {
    return Response.json(
      {
        error:
          "Chat sharing isn't configured on this server. Ask the operator to set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      },
      { status: 503 }
    );
  }

  const serialized = serializeChatForShare(chat, messages, {
    includeImages: includeImages === true,
    targetName: typeof targetName === "string" ? targetName : undefined,
  });

  if (serialized.messages.length === 0) {
    return Response.json(
      { error: "Chat has no shareable messages (only system or summary rows)." },
      { status: 400 }
    );
  }

  // Pre-summarize size check so we can reject upfront. The Gemma call comes
  // after — no point spending a model call on something that won't store.
  const sizeProbe = JSON.stringify(serialized);
  if (sizeProbe.length > MAX_CHAT_SHARE_BYTES) {
    return Response.json(
      {
        error: `Chat is too large to share (${Math.round(sizeProbe.length / 1024)} KB; limit ${Math.round(MAX_CHAT_SHARE_BYTES / 1024)} KB). Try sharing without image attachments, or trim the chat first.`,
      },
      { status: 413 }
    );
  }

  const summary = await summarizeWithGemma(serialized.chat.title, serialized.messages);

  const now = Date.now();
  const payload: SharedChatPayload = {
    chat: serialized.chat,
    messages: serialized.messages,
    summary,
    createdAt: now,
    expiresAt: now + CHAT_SHARE_TTL_SECONDS * 1000,
  };

  let token: string;
  try {
    token = newChatShareToken();
    await putChatShare(token, payload);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to write share." },
      { status: 500 }
    );
  }

  return Response.json({
    token,
    url: `/share/chat/${token}`,
    summary,
    expiresAt: payload.expiresAt,
  });
}

async function summarizeWithGemma(
  title: string,
  messages: { role: string; content: string }[]
): Promise<string> {
  const fallback = title.trim() || "Shared chat";

  let llm;
  try {
    llm = chatClientFor(SUMMARY_MODEL);
  } catch {
    return fallback;
  }

  const transcript = messages
    .slice(0, 12)
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 1200)}`)
    .join("\n\n");
  const userPrompt = `Title: ${title}

Transcript (truncated):
${transcript}`;

  try {
    const res = await Promise.race([
      llm.chat({
        model: SUMMARY_MODEL,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM },
          { role: "user", content: userPrompt },
        ],
        stream: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("summary-timeout")), SUMMARY_TIMEOUT_MS)
      ),
    ]);
    const text = (res.message?.content ?? "").trim();
    if (text) return text.slice(0, 600);
    return fallback;
  } catch {
    return fallback;
  }
}
