// Public landing page for a shared chat link.
//
// Path: /share/chat/[token]. Allowed through the auth proxy (see proxy.ts —
// matches the `/share/` prefix) so a recipient who hasn't signed up to this
// deployment can still preview the conversation and import it. The server
// component fetches once for page metadata (title + OG description for link
// previews); the client island re-fetches on mount for a fresh expiry check
// and handles the "Add to my chats" import.

import type { Metadata } from "next";
import {
  CHAT_SHARE_TOKEN_REGEX,
  getChatShare,
  isChatShareStoreConfigured,
  type SharedChatPayload,
} from "@/app/lib/chat-share-store";
import { requestMetadataBase } from "@/app/lib/metadata-base";
import { ShareChatPageClient } from "./share-chat-page-client";

export const dynamic = "force-dynamic";

async function loadInitial(token: string): Promise<SharedChatPayload | null> {
  if (!CHAT_SHARE_TOKEN_REGEX.test(token)) return null;
  if (!isChatShareStoreConfigured()) return null;
  try {
    return await getChatShare(token);
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const metadataBase = await requestMetadataBase();
  const payload = await loadInitial(token);
  if (!payload) {
    return { metadataBase, title: "Shared chat expired - Lasagna" };
  }
  const title = `${payload.chat.title} — shared chat`;
  return {
    metadataBase,
    title,
    description: payload.summary,
    openGraph: { title, description: payload.summary, type: "website" },
    twitter: {
      card: "summary_large_image",
      title,
      description: payload.summary,
    },
  };
}

export default async function ShareChatPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const initial = await loadInitial(token);
  return <ShareChatPageClient token={token} initial={initial} />;
}
