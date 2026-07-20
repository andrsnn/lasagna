// Vercel Blob wrapper for the artifacts app.
//
// Why a blob store at all: Upstash Redis SET values cap at ~1 MB and Vercel
// function bodies cap at 4.5 MB. A designer with hundreds of saved versions —
// each one a full VFS snapshot in `history[]` — blows past both. The fix is
// to keep small metadata in Redis (the change-index ZSET, the row "header")
// and move the heavy parts (current VFS, per-commit history snapshots, share
// payloads) to Vercel Blob, where individual blobs can be up to 5 GB and the
// browser PUTs straight to the blob CDN via signed client tokens — bypassing
// the function body cap entirely.
//
// Layout (`{userHash}` keeps email out of blob URLs):
//
//   account/{userHash}/designer/{designerId}/current.json
//     → { files, entry, version } — overwritten on every save
//   account/{userHash}/designer/{designerId}/history/v{version}.json
//     → one DesignerCommit, written once per version, never mutated
//   share/app/{token}.json   → SharedAppPayload
//   share/html/{token}.json  → SharedHtmlPayload
//
// Access model: the store is `access: 'private'`. The browser can't read
// blob URLs directly — it asks `/api/account/blob-read` for a short-lived
// presigned URL and fetches that from the CDN. Server-side reads (share
// resolution, summarization) go through `fetchBlobJson` below, which uses
// the read-write token via @vercel/blob's `get()`.

import { del, get, list, put } from "@vercel/blob";
import type { HandleUploadBody } from "@vercel/blob/client";

const TOKEN_ENV = "BLOB_READ_WRITE_TOKEN";

export function isBlobStoreConfigured(): boolean {
  return !!process.env[TOKEN_ENV];
}

/**
 * 16 hex chars of sha-256(emailLowercased). Stable per user, but doesn't
 * reveal the email in blob URLs.
 */
export async function userHash(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

const DESIGNER_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN_REGEX = /^[A-Za-z0-9_-]{22}$/;
const USERHASH_REGEX = /^[a-f0-9]{16}$/;

export function designerCurrentPath(userHash: string, designerId: string): string {
  if (!USERHASH_REGEX.test(userHash)) throw new Error("Invalid userHash.");
  if (!DESIGNER_ID_REGEX.test(designerId)) throw new Error("Invalid designerId.");
  return `account/${userHash}/designer/${designerId}/current.json`;
}

export function designerCommitPath(
  userHash: string,
  designerId: string,
  version: number
): string {
  if (!USERHASH_REGEX.test(userHash)) throw new Error("Invalid userHash.");
  if (!DESIGNER_ID_REGEX.test(designerId)) throw new Error("Invalid designerId.");
  if (!Number.isFinite(version) || version < 0)
    throw new Error("Invalid version.");
  return `account/${userHash}/designer/${designerId}/history/v${Math.floor(
    version
  )}.json`;
}

// Sandbox upload ids and filenames. The id is a server- or client-minted
// token; the filename is the user's original name (or a produced output name)
// constrained to a safe, slash-free charset so it can't escape the namespace.
const UPLOAD_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
const UPLOAD_FILENAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * Strip a user-supplied filename down to the safe charset the upload path
 * allows: keep the basename only (no directory parts), replace anything
 * outside [A-Za-z0-9._-] with "_", and guard against empty / dot-only names.
 */
export function sanitizeUploadFilename(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? "";
  let cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  // Avoid leading dot (hidden file / "." / "..") so the regex's leading
  // alnum requirement is met.
  cleaned = cleaned.replace(/^[._-]+/, "");
  if (!cleaned) cleaned = "file";
  return cleaned;
}

/**
 * Blob pathname for a code-execution sandbox file (user upload or produced
 * output) under the caller's namespace:
 *   account/{userHash}/uploads/{id}/{filename}
 */
export function userUploadPath(
  userHashValue: string,
  id: string,
  filename: string
): string {
  if (!USERHASH_REGEX.test(userHashValue)) throw new Error("Invalid userHash.");
  if (!UPLOAD_ID_REGEX.test(id)) throw new Error("Invalid upload id.");
  const safe = sanitizeUploadFilename(filename);
  if (!UPLOAD_FILENAME_REGEX.test(safe)) throw new Error("Invalid filename.");
  return `account/${userHashValue}/uploads/${id}/${safe}`;
}

/**
 * Server-side: store sandbox bytes (a produced output, or a worker-side copy)
 * at an uploads path and return the private blob URL. The worker holds
 * BLOB_READ_WRITE_TOKEN so `put` is authorized without a client handshake.
 */
export async function putUserUpload(
  pathname: string,
  bytes: Uint8Array | Buffer,
  contentType: string
): Promise<{ url: string; pathname: string }> {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const res = await put(pathname, body, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: contentType || "application/octet-stream",
  });
  return { url: res.url, pathname: res.pathname };
}

/**
 * Server-side: download the raw bytes of a blob by its stored URL. Mirrors
 * `fetchBlobJson` but returns bytes — used by the sandbox worker to stage a
 * user-uploaded input file into the run workspace.
 */
export async function fetchBlobBytes(url: string): Promise<Uint8Array | null> {
  try {
    const direct = await fetch(url);
    if (direct.ok) {
      const buf = await direct.arrayBuffer();
      return new Uint8Array(buf);
    }
  } catch {
    // fall through to the signed read below
  }
  try {
    const result = await get(url, { access: "private" });
    if (!result || result.statusCode !== 200) return null;
    const buf = await new Response(result.stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

const CHAT_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Blob pathname for a chat's offloaded image bundle:
 *   account/{userHash}/chat/{chatId}/images.json
 * A single JSON `{ [imageId]: dataUrl }` map, overwritten on every push (like
 * designer current.json). Only written when a shared chat's inline images
 * would push its sync bundle past the 4.5 MB function-body cap.
 */
export function chatImagesPath(userHashValue: string, chatId: string): string {
  if (!USERHASH_REGEX.test(userHashValue)) throw new Error("Invalid userHash.");
  if (!CHAT_ID_REGEX.test(chatId)) throw new Error("Invalid chatId.");
  return `account/${userHashValue}/chat/${chatId}/images.json`;
}

export function appShareBlobPath(token: string): string {
  if (!TOKEN_REGEX.test(token)) throw new Error("Invalid share token.");
  return `share/app/${token}.json`;
}

export function htmlShareBlobPath(token: string): string {
  if (!TOKEN_REGEX.test(token)) throw new Error("Invalid share token.");
  return `share/html/${token}.json`;
}

/**
 * Server-side JSON fetch from the (private) Blob CDN. Uses the read-write
 * token via @vercel/blob's `get()`, which signs the request for us; callers
 * pass the full blob URL stored in their Redis row.
 */
export async function fetchBlobJson<T>(url: string): Promise<T | null> {
  try {
    const result = await get(url, { access: "private" });
    if (!result || result.statusCode !== 200) return null;
    return (await new Response(result.stream).json()) as T;
  } catch {
    return null;
  }
}

/**
 * Recognize the shape of an inbound HandleUploadBody well enough to dispatch
 * without importing the heavy `handleUpload` machinery in places that only
 * need to know what kind of request this is. Other modules use the helper
 * from @vercel/blob/client directly.
 */
export type { HandleUploadBody };

/**
 * Delete every blob under `account/{userHash}/designer/{designerId}/`. Called
 * when a user toggles "Sync to account" OFF (or deletes the entity) so we
 * don't keep orphaned current.json + history/v*.json blobs paid for by the
 * account. Safe to run when the prefix is already empty.
 *
 * Paginates through `list()` rather than assuming a single page, since a
 * long-lived designer can accumulate hundreds of history blobs.
 */
export async function deleteDesignerBlobs(
  userHashValue: string,
  designerId: string
): Promise<{ deleted: number }> {
  if (!USERHASH_REGEX.test(userHashValue)) throw new Error("Invalid userHash.");
  if (!DESIGNER_ID_REGEX.test(designerId)) throw new Error("Invalid designerId.");
  if (!isBlobStoreConfigured()) return { deleted: 0 };
  const prefix = `account/${userHashValue}/designer/${designerId}/`;
  return deleteBlobPrefix(prefix);
}

/**
 * Delete every blob under `account/{userHash}/chat/{chatId}/` (the offloaded
 * `images.json`). Called when a user turns "Sync to account" OFF for a chat,
 * so the image bundle doesn't linger paid-for on the account. The full images
 * still live in the sender's IndexedDB, so nothing is lost.
 */
export async function deleteChatBlobs(
  userHashValue: string,
  chatId: string
): Promise<{ deleted: number }> {
  if (!USERHASH_REGEX.test(userHashValue)) throw new Error("Invalid userHash.");
  if (!CHAT_ID_REGEX.test(chatId)) throw new Error("Invalid chatId.");
  if (!isBlobStoreConfigured()) return { deleted: 0 };
  const prefix = `account/${userHashValue}/chat/${chatId}/`;
  return deleteBlobPrefix(prefix);
}

async function deleteBlobPrefix(prefix: string): Promise<{ deleted: number }> {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    const urls = page.blobs.map((b) => b.url);
    if (urls.length > 0) {
      await del(urls);
      deleted += urls.length;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return { deleted };
}

/**
 * Path validators used by the blob-upload routes. Each one ensures that a
 * client-requested pathname is well-formed AND falls under the caller's own
 * namespace (or the share namespace for share uploads). Throwing here causes
 * `handleUpload` to reject the request — the browser never receives a token.
 */
export function assertAccountUploadPath(
  pathname: string,
  expectedUserHash: string
):
  | { kind: "current" | "commit"; designerId: string; version?: number }
  | { kind: "upload"; uploadId: string; filename: string }
  | { kind: "chat-images"; chatId: string } {
  const namespace = `account/${expectedUserHash}/`;
  if (!pathname.startsWith(namespace)) {
    throw new Error("Account upload path must be under the caller's namespace.");
  }
  const chatPrefix = `${namespace}chat/`;
  if (pathname.startsWith(chatPrefix)) {
    const tail = pathname.slice(chatPrefix.length);
    const chatMatch = tail.match(/^([A-Za-z0-9_-]{1,128})\/images\.json$/);
    if (chatMatch) return { kind: "chat-images", chatId: chatMatch[1] };
    throw new Error("Chat upload path doesn't match the allowed shape.");
  }
  const designerPrefix = `${namespace}designer/`;
  if (pathname.startsWith(designerPrefix)) {
    const tail = pathname.slice(designerPrefix.length);
    const currentMatch = tail.match(/^([A-Za-z0-9_-]{1,128})\/current\.json$/);
    if (currentMatch) return { kind: "current", designerId: currentMatch[1] };
    const commitMatch = tail.match(
      /^([A-Za-z0-9_-]{1,128})\/history\/v(\d+)\.json$/
    );
    if (commitMatch) {
      return {
        kind: "commit",
        designerId: commitMatch[1],
        version: Number.parseInt(commitMatch[2], 10),
      };
    }
    throw new Error("Account upload path doesn't match the allowed shape.");
  }
  const uploadPrefix = `${namespace}uploads/`;
  if (pathname.startsWith(uploadPrefix)) {
    const tail = pathname.slice(uploadPrefix.length);
    const uploadMatch = tail.match(
      /^([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9][A-Za-z0-9._-]{0,199})$/
    );
    if (uploadMatch) {
      return { kind: "upload", uploadId: uploadMatch[1], filename: uploadMatch[2] };
    }
    throw new Error("Upload path doesn't match the allowed shape.");
  }
  throw new Error("Account upload path doesn't match the allowed shape.");
}

export function assertShareUploadPath(
  pathname: string
): { kind: "app" | "html"; token: string } {
  const appMatch = pathname.match(/^share\/app\/([A-Za-z0-9_-]{22})\.json$/);
  if (appMatch) return { kind: "app", token: appMatch[1] };
  const htmlMatch = pathname.match(/^share\/html\/([A-Za-z0-9_-]{22})\.json$/);
  if (htmlMatch) return { kind: "html", token: htmlMatch[1] };
  throw new Error("Share upload path doesn't match the allowed shape.");
}
