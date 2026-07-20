// Public landing page for a shared HTML artifact.
//
// Path: /share/html/[token]. Allowed through the auth proxy (see proxy.ts —
// the `/share/` prefix is public) so a recipient who hasn't signed up to
// this deployment can still see the artifact. The server component fetches
// the payload once for OG metadata (title + description for link previews
// in iMessage / Slack / etc.); the client island re-fetches on mount for
// live data and renders the document full-screen in a sandboxed iframe.

import type { Metadata } from "next";
import {
  HTML_SHARE_TOKEN_REGEX,
  getHtmlShare,
  isHtmlShareStoreConfigured,
  type SharedHtmlPayload,
} from "@/app/lib/html-share-store";
import { requestMetadataBase } from "@/app/lib/metadata-base";
import { ShareHtmlClient } from "./share-html-client";

export const dynamic = "force-dynamic";

async function loadInitial(token: string): Promise<SharedHtmlPayload | null> {
  if (!HTML_SHARE_TOKEN_REGEX.test(token)) return null;
  if (!isHtmlShareStoreConfigured()) return null;
  try {
    return await getHtmlShare(token);
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
    return { metadataBase, title: "Shared artifact expired - Lasagna" };
  }
  const title = payload.title;
  const description = payload.summary;
  return {
    metadataBase,
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default async function ShareHtmlPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const initial = await loadInitial(token);
  return <ShareHtmlClient token={token} initial={initial} />;
}
