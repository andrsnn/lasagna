// Client-side blob uploader for designer sync.
//
// Saves used to ship the entire StoredDesigner — including the `history[]`
// array of full per-version VFS snapshots — to /api/account, which then put
// the whole JSON in one Redis value. Past ~v100 the payload blew past Vercel's
// 4.5 MB request cap and/or Upstash's ~1 MB SET-value cap; the push silently
// 4xx/5xx'd and the receiving device never saw new versions. This module
// breaks the heavy fields out to Vercel Blob (5 GB cap, browser PUTs directly
// to the blob CDN through a server-issued client token — no Vercel function
// body involved) so the metadata POST that follows is a few KB regardless of
// designer size.
//
// Idempotency: current.json is overwritten on every save (cheap; one PUT per
// version bump). Commit blobs are content-addressable by version and never
// rewritten — we only upload versions not already in `designer.historyBlobs`.
// If `historyBlobs` is missing or empty (first push after this change ships,
// or a fresh-from-IDB designer), we still only upload the local versions we
// actually have in `history[]`.

import { upload } from "@vercel/blob/client";
import type { DesignerCommit, StoredDesigner } from "@/app/db";
import { vfsHash } from "@/app/lib/artifact/vfs";

type UploadResult = {
  filesBlobUrl: string;
  filesBlobVersion: number;
  historyBlobs: Record<string, string>;
};

/**
 * Uploads the designer's heavy data to Vercel Blob and returns pointers
 * suitable for stamping back onto the local IDB row AND for shipping to
 * `POST /api/account` as the ref payload. Throws on hard failure so the
 * caller can leave `accountShared` true but skip the metadata write —
 * the next save retries.
 */
export async function uploadDesignerBlobs(
  designer: StoredDesigner
): Promise<UploadResult> {
  const designerId = designer.id;
  if (!designerId) throw new Error("designer.id is required");

  // -------- current.json --------
  // Always uploaded: easier than reasoning about "did the version change
  // since the last push?" — and the blob endpoint overwrites cheaply.
  const currentBody = JSON.stringify({
    files: designer.files,
    entry: designer.entry,
    version: designer.version,
  });
  const currentPath = `account/${await userHashClient()}/designer/${designerId}/current.json`;
  const currentBlob = await upload(currentPath, currentBody, {
    access: "private",
    contentType: "application/json",
    handleUploadUrl: "/api/account/blob-upload",
  });

  // -------- new commit blobs --------
  // Upload only versions we don't already have a blob URL for. On the very
  // first push after this change ships, `existingHistoryBlobs` is empty so
  // every locally-known commit gets uploaded once; subsequent saves only
  // upload the one new commit appended by the save.
  const existingHistoryBlobs = designer.historyBlobs ?? {};
  const localHistory = designer.history ?? [];
  const toUpload: DesignerCommit[] = [];
  for (const commit of localHistory) {
    const key = String(commit.version);
    if (existingHistoryBlobs[key]) continue;
    toUpload.push(commit);
  }

  // Parallel uploads — Vercel Blob can absorb the concurrency, and the
  // per-blob payload is small (one VFS snapshot, typically tens to a few
  // hundred KB). Failures here surface as exceptions on Promise.all and
  // propagate to the caller's catch.
  const userHash = await userHashClient();
  const uploaded = await Promise.all(
    toUpload.map(async (commit) => {
      const path = `account/${userHash}/designer/${designerId}/history/v${commit.version}.json`;
      const body = JSON.stringify(commit);
      const blob = await upload(path, body, {
        access: "private",
        contentType: "application/json",
        handleUploadUrl: "/api/account/blob-upload",
      });
      return { version: commit.version, url: blob.url };
    })
  );

  const historyBlobs: Record<string, string> = { ...existingHistoryBlobs };
  for (const u of uploaded) historyBlobs[String(u.version)] = u.url;

  // -------- bookmarked head snapshot --------
  // `history[]` holds *prior* commits only, so the current head's VFS lives
  // solely in current.json — never in `historyBlobs`. That's fine until the
  // head gets bookmarked: the bookmark metadata (checkpointLabels /
  // stateSnapshots) syncs eagerly through the designer payload, but another
  // device that restores that version asks /api/account/designer-history for
  // it by version number. With no `historyBlobs` pointer, the server returns
  // nothing and Restore fails with "snapshot isn't available / hasn't synced
  // yet" — even though the bookmark itself is visibly synced. Close that gap
  // by uploading the head's snapshot as its own commit blob the moment the
  // head is bookmarked, so every bookmarked version is retrievable by number.
  // It's keyed by version, so once the head is later demoted into history the
  // normal commit-upload loop above skips it (already present) — no dupe.
  const headKey = String(designer.version);
  const isHeadBookmarked = !!(designer.checkpointLabels ?? {})[headKey];
  if (isHeadBookmarked && !historyBlobs[headKey]) {
    const headCommit: DesignerCommit = {
      version: designer.version,
      files: designer.files,
      entry: designer.entry,
      savedAt: designer.updatedAt,
      commitMessage: designer.headCommitMessage,
      hash: vfsHash(designer.files, designer.entry),
    };
    const path = `account/${userHash}/designer/${designerId}/history/v${designer.version}.json`;
    const blob = await upload(path, JSON.stringify(headCommit), {
      access: "private",
      contentType: "application/json",
      handleUploadUrl: "/api/account/blob-upload",
    });
    historyBlobs[headKey] = blob.url;
  }

  return {
    filesBlobUrl: currentBlob.url,
    filesBlobVersion: designer.version,
    historyBlobs,
  };
}

/**
 * Same 16-hex-char hash the server computes from the email. We don't know
 * the email on the client (it's a server-only header), so we ask the
 * server for it once per session via /api/account/user-hash and cache.
 * Falls back to throwing — without a hash, the path is unguessable and
 * the upload route would reject anyway.
 */
let cachedUserHash: Promise<string> | null = null;
async function userHashClient(): Promise<string> {
  if (cachedUserHash) return cachedUserHash;
  cachedUserHash = (async () => {
    const res = await fetch("/api/account/user-hash", { cache: "no-store" });
    if (!res.ok) {
      cachedUserHash = null;
      throw new Error(`Couldn't fetch user hash (${res.status}).`);
    }
    const body = (await res.json()) as { userHash?: string };
    if (!body.userHash) {
      cachedUserHash = null;
      throw new Error("Server didn't return a userHash.");
    }
    return body.userHash;
  })();
  return cachedUserHash;
}

/**
 * Fetches the JSON contents of an account designer blob. The store is
 * private, so the browser can't `fetch(blobUrl)` directly — we ask the
 * server for a 60s-scoped presigned URL and fetch that from the blob CDN.
 *
 * Returns null on any error so callers can fall back to the inline copy
 * of the row (legacy designers may not have a blob yet).
 */
async function presignAccountBlobRead(url: string): Promise<string | null> {
  try {
    const res = await fetch("/api/account/blob-read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { url?: string };
    return body.url ?? null;
  } catch {
    return null;
  }
}

export async function fetchDesignerCurrentBlob(
  url: string
): Promise<{ files: StoredDesigner["files"]; entry: string; version: number } | null> {
  const signed = await presignAccountBlobRead(url);
  if (!signed) return null;
  try {
    const res = await fetch(signed, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as {
      files: StoredDesigner["files"];
      entry: string;
      version: number;
    };
  } catch {
    return null;
  }
}

export async function fetchDesignerCommitBlob(
  url: string
): Promise<DesignerCommit | null> {
  const signed = await presignAccountBlobRead(url);
  if (!signed) return null;
  try {
    const res = await fetch(signed, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as DesignerCommit;
  } catch {
    return null;
  }
}

// ---------- chat image offload ----------
//
// A shared chat's inline base64 images can push its sync bundle past Vercel's
// 4.5 MB POST cap, so the push silently fails and the chat never reaches other
// devices. When that happens the sender uploads every image's dataUrl to ONE
// blob (`images.json`, a `{ imageId: dataUrl }` map) via the same client-token
// broker designers use — the browser PUTs straight to the blob CDN, no
// function body involved — and strips the bytes from the wire payload. The
// receiving device fetches the map and rehydrates each image's dataUrl.

/**
 * Upload the chat's image map to Blob and return the blob URL. Overwrites the
 * chat's single images.json on every call (cheap; one PUT). Throws on failure
 * so the caller can leave the push inline / retry.
 */
export async function uploadChatImagesBlob(
  chatId: string,
  imageMap: Record<string, string>
): Promise<string> {
  const path = `account/${await userHashClient()}/chat/${chatId}/images.json`;
  const blob = await upload(path, JSON.stringify(imageMap), {
    access: "private",
    contentType: "application/json",
    handleUploadUrl: "/api/account/blob-upload",
  });
  return blob.url;
}

/**
 * Fetch a chat's offloaded image map. The store is private, so we presign a
 * short-lived read URL first (same path designers use). Returns null on any
 * error so the caller can fall back to whatever inline dataUrls survived.
 */
export async function fetchChatImagesBlob(
  url: string
): Promise<Record<string, string> | null> {
  const signed = await presignAccountBlobRead(url);
  if (!signed) return null;
  try {
    const res = await fetch(signed, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, string>;
  } catch {
    return null;
  }
}
