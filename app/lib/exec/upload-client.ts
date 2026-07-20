// Client-side uploader for code-execution sandbox attachments.
//
// Binary files the user attaches (audio/video/zip/…) are too big to inline as
// base64 in the message, so we PUT them straight to Vercel Blob via the
// account upload broker (same direct-to-CDN path the designer sync uses) and
// keep only an AttachedFile pointer on the message. The sandbox worker later
// downloads the bytes by URL into the run workspace.
//
// Kept separate from account-blob-uploader.ts (designer JSON) and from
// blob-store.ts (server-only, pulls in the @vercel/blob server SDK) so this
// stays a lean client module.

import { upload } from "@vercel/blob/client";
import type { AttachedFile } from "@/app/db";

// Caps for sandbox attachments. 50 MB matches the blob-upload broker's
// maximumSizeInBytes; the per-message count keeps a single turn's workspace
// bounded.
export const MAX_SANDBOX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_SANDBOX_FILES_PER_MESSAGE = 6;

let cachedUserHash: Promise<string> | null = null;

async function userHashClient(): Promise<string> {
  if (cachedUserHash) return cachedUserHash;
  cachedUserHash = (async () => {
    const res = await fetch("/api/account/user-hash", { cache: "no-store" });
    if (!res.ok) {
      cachedUserHash = null;
      throw new Error(`Couldn't resolve your storage namespace (${res.status}).`);
    }
    const body = (await res.json()) as { userHash?: string };
    if (!body.userHash) {
      cachedUserHash = null;
      throw new Error("Server didn't return a storage namespace.");
    }
    return body.userHash;
  })();
  return cachedUserHash;
}

/** Mirror of blob-store.ts sanitizeUploadFilename, inlined to avoid importing
 *  the server module into the client bundle. */
function sanitizeFilename(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? "";
  let cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  cleaned = cleaned.replace(/^[._-]+/, "");
  return cleaned || "file";
}

/**
 * Upload one File to the caller's uploads namespace and return an AttachedFile
 * pointer. Uses public access so the browser can preview/download the bytes
 * directly; the random upload id keeps the URL unguessable.
 */
export async function uploadSandboxFile(file: File): Promise<AttachedFile> {
  const hash = await userHashClient();
  const id = crypto.randomUUID();
  const name = sanitizeFilename(file.name || "file");
  const pathname = `account/${hash}/uploads/${id}/${name}`;
  const contentType = file.type || "application/octet-stream";
  const blob = await upload(pathname, file, {
    access: "public",
    contentType,
    handleUploadUrl: "/api/account/blob-upload",
  });
  return {
    id,
    name,
    blobKey: pathname,
    url: blob.url,
    contentType,
    bytes: file.size,
  };
}
