// Public landing page for a shared pinned note.
//
// Path: /share/note/[token]. Allowed through the auth proxy (see proxy.ts —
// the `/share/` prefix is public) so a recipient who hasn't signed up to
// this deployment can still see the note. The server component fetches the
// payload once for OG metadata; the client island re-fetches on mount for
// live data and renders the body (html iframe, markdown, or chat snapshot).

import type { Metadata } from "next";
import {
  NOTE_SHARE_TOKEN_REGEX,
  getNoteShare,
  isNoteShareStoreConfigured,
  type SharedNotePayload,
} from "@/app/lib/note-share-store";
import { requestMetadataBase } from "@/app/lib/metadata-base";
import { ShareNoteClient } from "./share-note-client";

export const dynamic = "force-dynamic";

async function loadInitial(token: string): Promise<SharedNotePayload | null> {
  if (!NOTE_SHARE_TOKEN_REGEX.test(token)) return null;
  if (!isNoteShareStoreConfigured()) return null;
  try {
    return await getNoteShare(token);
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
    return { metadataBase, title: "Shared note expired - Lasagna" };
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

export default async function ShareNotePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const initial = await loadInitial(token);
  return <ShareNoteClient token={token} initial={initial} />;
}
