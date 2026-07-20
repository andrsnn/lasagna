// Public landing page for a shared app link.
//
// Path: /share/[token]. Allowed through the auth proxy (see proxy.ts) so a
// recipient who hasn't signed up to this deployment can still preview the app
// and import it into their own browser. The server component fetches once for
// page metadata (title + OG description for link previews); the client island
// re-fetches on mount for live data and handles import.

import type { Metadata } from "next";
import { SHARE_TOKEN_REGEX, getShare, isShareStoreConfigured } from "@/app/lib/share-store";
import type { SharedAppPayload } from "@/app/lib/share-store";
import { requestMetadataBase } from "@/app/lib/metadata-base";
import { SharePageClient } from "./share-page-client";

export const dynamic = "force-dynamic";

async function loadInitial(token: string): Promise<SharedAppPayload | null> {
  if (!SHARE_TOKEN_REGEX.test(token)) return null;
  if (!isShareStoreConfigured()) return null;
  try {
    return await getShare(token);
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
    return { metadataBase, title: "Shared app expired - Lasagna" };
  }
  const title = `${payload.designer.name} — shared app`;
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

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const initial = await loadInitial(token);
  return <SharePageClient token={token} initial={initial} />;
}
