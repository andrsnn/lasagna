// Per-run filesystem workspace for the code-execution sandbox.
//
// Each run_code / artifact.exec call gets a fresh directory under the OS temp
// dir. We stage any user-attached input files into it (downloaded from Vercel
// Blob by name), run the interpreter with the directory as CWD, then capture
// the files the run produced or modified, upload them back to Blob, and hand
// the caller AttachedFile pointers it can surface to the user.
//
// Everything here is server/worker-only (node:fs, node:os). It's reached from
// sandbox.ts, which is itself behind a dynamic import in executeTool() so this
// module never lands in the Vercel client/edge bundle.

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AttachedFile } from "@/app/db";
import {
  fetchBlobBytes,
  putUserUpload,
  sanitizeUploadFilename,
  userUploadPath,
} from "@/app/lib/blob-store";

// Total bytes we'll upload back from a single run, and the per-run file count
// cap. Keeps a runaway program (write a million files / a 1 GB blob) from
// hammering Blob or the wire. Inputs don't count against this.
const MAX_OUTPUT_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_FILES = 24;

// When Blob storage isn't available we deliver a produced file inline as a
// data: URL on its AttachedFile instead of a Blob URL. That URL rides the
// `files_produced` SSE event, which is pushed WHOLE (non-splittable) to the
// Redis resume buffer and must stay under MAX_RPUSH_BYTES (700KB, see
// stream-store.ts). base64 is ~1.37x the raw bytes, so cap one inline file and
// the per-run inline total well under that. Files over the cap with no Blob are
// reported as undelivered (not silently dropped, which is what pushed the model
// to hunt for an external file host).
const MAX_INLINE_FILE_BYTES = 400_000;
const MAX_INLINE_TOTAL_BYTES = 450_000;

export type StagedInput = {
  /** Filename the program sees in the workspace, e.g. "clip.mp3". */
  name: string;
  /** Whether the input was actually written into the workspace (false ⇒ neither
   *  a Blob download nor inline bytes were available for this name). */
  staged: boolean;
};

/** A file whose bytes are already in memory (a pasted image carried inline on
 *  the message). Staged without any Blob round-trip. */
export type InlineInputFile = {
  name: string;
  /** base64-encoded contents (no data: prefix). */
  base64: string;
  contentType: string;
};

export type Workspace = {
  /** Absolute path used as the interpreter CWD. */
  dir: string;
  /** Inputs the model named, with staging status. */
  inputs: StagedInput[];
  /** mtime (ms) snapshot keyed by filename, taken right after staging. Used
   *  to detect which files the run produced or modified. */
  baseline: Map<string, number>;
};

/**
 * Create a fresh run directory and stage the requested input files into it.
 * `requested` is the subset of the session's attached files the model asked
 * for via input_files; we match by filename. Program files are written by the
 * caller after this returns, so they're excluded from the baseline.
 */
export async function createWorkspace(opts: {
  sessionId: string;
  available: AttachedFile[];
  /** Bytes we already hold (pasted images). Staged without a Blob round-trip. */
  inlineFiles?: InlineInputFile[];
  requested: string[];
}): Promise<Workspace> {
  const dir = join(tmpdir(), "exec", sanitizeId(opts.sessionId), randomUUID());
  await mkdir(dir, { recursive: true });

  const byName = new Map<string, AttachedFile>();
  for (const f of opts.available) byName.set(f.name, f);

  // Inline files are keyed under both the exact name and its sanitized form so a
  // requested name matches whether or not the model echoed it verbatim.
  const inlineByName = new Map<string, InlineInputFile>();
  for (const f of opts.inlineFiles ?? []) {
    inlineByName.set(f.name, f);
    inlineByName.set(sanitizeUploadFilename(f.name), f);
  }

  const inputs: StagedInput[] = [];
  // Dedupe requested names; ignore anything the session doesn't actually have.
  for (const rawName of Array.from(new Set(opts.requested))) {
    const name = sanitizeUploadFilename(rawName);
    // Prefer a Blob-backed file (persists across turns; may be a large upload
    // or an earlier run's output). Fall back to inline bytes we already hold,
    // so pasted images stage even when Blob is unconfigured or the upstream
    // upload failed - the durable fix for the "please re-upload" dead-end.
    const file = byName.get(rawName) ?? byName.get(name);
    if (file) {
      const bytes = await fetchBlobBytes(file.url);
      if (bytes) {
        await writeFile(join(dir, sanitizeUploadFilename(file.name)), bytes);
        inputs.push({ name: file.name, staged: true });
        continue;
      }
      // Blob fetch failed - fall through to an inline copy if we have one.
    }
    const inline = inlineByName.get(rawName) ?? inlineByName.get(name);
    if (inline) {
      try {
        const bytes = new Uint8Array(Buffer.from(inline.base64, "base64"));
        await writeFile(join(dir, sanitizeUploadFilename(inline.name)), bytes);
        inputs.push({ name: inline.name, staged: true });
        continue;
      } catch {
        // Corrupt base64 - fall through to not-staged.
      }
    }
    inputs.push({ name: file?.name ?? rawName, staged: false });
  }

  const baseline = await snapshot(dir);
  return { dir, inputs, baseline };
}

/** What collectOutputs managed to hand back. `files` are ready to surface to
 *  the user - each carries a Blob URL, or (when Blob is unavailable) an inline
 *  data: URL so it renders + downloads with no external dependency.
 *  `undelivered` lists files the run produced that were too large to inline
 *  with no Blob configured, so the caller can tell the model honestly instead
 *  of the file silently vanishing. */
export type CollectedOutputs = {
  files: AttachedFile[];
  undelivered: {
    name: string;
    bytes: number;
    contentType: string;
    reason: string;
  }[];
};

/**
 * After the interpreter exits, find files that are new or modified relative to
 * the post-staging baseline (excluding `programFiles`) and hand each back to the
 * user. Preferred delivery is a Blob upload (durable, cross-turn, tiny on the
 * wire); when no Blob namespace is available we fall back to an inline data:
 * URL so a produced file - e.g. a transparent PNG - still reaches the user with
 * no Blob and no external host. Files too large to inline with no Blob are
 * returned in `undelivered`.
 */
export async function collectOutputs(
  ws: Workspace,
  opts: { userHash?: string; programFiles: string[] }
): Promise<CollectedOutputs> {
  const programSet = new Set(opts.programFiles.map(sanitizeUploadFilename));
  const now = await snapshot(ws.dir);

  const candidates: string[] = [];
  for (const [name, mtime] of now) {
    if (programSet.has(name)) continue;
    const base = ws.baseline.get(name);
    if (base === undefined || mtime > base) candidates.push(name);
  }
  // Stable order, smaller files first so a giant file can't starve the rest
  // out of the byte budget.
  candidates.sort();

  const outputs: AttachedFile[] = [];
  const undelivered: CollectedOutputs["undelivered"] = [];
  let totalBytes = 0;
  let inlineTotal = 0;
  for (const name of candidates) {
    if (outputs.length >= MAX_OUTPUT_FILES) break;
    const abs = join(ws.dir, name);
    let bytes: Uint8Array;
    try {
      const info = await stat(abs);
      if (!info.isFile()) continue;
      if (totalBytes + info.size > MAX_OUTPUT_TOTAL_BYTES) continue;
      bytes = new Uint8Array(await readFile(abs));
    } catch {
      continue;
    }
    totalBytes += bytes.byteLength;
    const uploadId = randomUUID();
    const contentType = guessContentType(name);

    // Prefer Blob when we have a namespace. Fall back to an inline data: URL so
    // the file is delivered even with Blob unconfigured or its upload failing.
    let url: string | null = null;
    let blobKey = "";
    if (opts.userHash) {
      try {
        const pathname = userUploadPath(opts.userHash, uploadId, name);
        const res = await putUserUpload(pathname, bytes, contentType);
        url = res.url;
        blobKey = pathname;
      } catch {
        // Blob configured but the upload failed - fall through to inline.
      }
    }
    if (!url) {
      if (
        bytes.byteLength <= MAX_INLINE_FILE_BYTES &&
        inlineTotal + bytes.byteLength <= MAX_INLINE_TOTAL_BYTES
      ) {
        url = `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
        inlineTotal += bytes.byteLength;
      } else {
        undelivered.push({
          name,
          bytes: bytes.byteLength,
          contentType,
          reason:
            "too large to return inline and durable file storage is not configured",
        });
        continue;
      }
    }
    outputs.push({
      id: uploadId,
      name,
      blobKey,
      url,
      contentType,
      bytes: bytes.byteLength,
      produced: true,
    });
  }
  return { files: outputs, undelivered };
}

/** Remove the run directory. Best-effort; never throws. */
export async function cleanupWorkspace(ws: Workspace): Promise<void> {
  try {
    await rm(ws.dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function snapshot(dir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    try {
      const info = await stat(join(dir, name));
      // Only track top-level files; nested dirs a program creates are ignored
      // for output capture (keeps the surface predictable).
      if (info.isFile()) out.set(name, info.mtimeMs);
    } catch {
      // ignore
    }
  }
  return out;
}

function sanitizeId(id: string): string {
  const cleaned = String(id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
  return cleaned || "session";
}

// Minimal extension → MIME map for the common conversion targets. Falls back
// to octet-stream; the browser still downloads fine, it just won't inline.
const MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  gif: "image/gif",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  json: "application/json",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  zip: "application/zip",
};

function guessContentType(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
