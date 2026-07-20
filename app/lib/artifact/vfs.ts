// Pure VFS helpers — no IO, no IndexedDB, no esbuild. Used both server-side
// (in /api/chat tool dispatcher) and client-side (live preview during streaming).
//
// File paths are forward-slash relative; no leading "/". Directories are
// implicit — there is no "mkdir". Empty directories don't exist.

import type { ArtifactFiles, FileChange } from "@/app/db";

// ---------- read / list ----------

export function readFile(files: ArtifactFiles, path: string): string | null {
  return Object.prototype.hasOwnProperty.call(files, path) ? files[path] : null;
}

export function listPaths(files: ArtifactFiles, dir?: string): string[] {
  const all = Object.keys(files).sort();
  if (!dir) return all;
  const prefix = dir.endsWith("/") ? dir : dir + "/";
  return all.filter((p) => p.startsWith(prefix));
}

/** "ls"-style: returns the first segment under `dir`, deduplicated. Files keep their full name; subdirs end with "/". */
export function listChildren(files: ArtifactFiles, dir = ""): string[] {
  const prefix = dir === "" ? "" : dir.endsWith("/") ? dir : dir + "/";
  const seen = new Set<string>();
  for (const path of Object.keys(files)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === "") continue;
    const slash = rest.indexOf("/");
    seen.add(slash === -1 ? rest : rest.slice(0, slash + 1));
  }
  return [...seen].sort();
}

// ---------- write / delete ----------

export function writeFile(files: ArtifactFiles, path: string, content: string): ArtifactFiles {
  return { ...files, [path]: content };
}

export function deleteFile(files: ArtifactFiles, path: string): ArtifactFiles {
  if (!Object.prototype.hasOwnProperty.call(files, path)) return files;
  const next = { ...files };
  delete next[path];
  return next;
}

// ---------- glob ----------

/** Simple glob: supports `*`, `**`, `?`. Anchored to the full path. */
export function globMatch(files: ArtifactFiles, pattern: string, base?: string): string[] {
  const re = globToRegExp(pattern);
  const candidates = base ? listPaths(files, base) : Object.keys(files);
  return candidates.filter((p) => re.test(p)).sort();
}

function globToRegExp(pattern: string): RegExp {
  // Escape regex metachars, then translate glob tokens.
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches any number of segments
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
        continue;
      }
      // single * matches anything except a path separator
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
      i++;
      continue;
    }
    re += c;
    i++;
  }
  return new RegExp("^" + re + "$");
}

// ---------- grep ----------

export type GrepHit = { path: string; line: number; text: string };

export function grep(
  files: ArtifactFiles,
  pattern: RegExp,
  options?: { include?: string; maxHits?: number }
): GrepHit[] {
  const max = options?.maxHits ?? 200;
  const include = options?.include ? globToRegExp(options.include) : null;
  const hits: GrepHit[] = [];
  const paths = Object.keys(files).sort();
  for (const path of paths) {
    if (include && !include.test(path)) continue;
    const lines = files[path].split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        hits.push({ path, line: i + 1, text: lines[i] });
        if (hits.length >= max) return hits;
      }
    }
  }
  return hits;
}

// ---------- edit / multi-edit ----------

export type EditError = { code: "missing-file" | "no-match" | "ambiguous"; message: string };

export function applyEdit(
  files: ArtifactFiles,
  path: string,
  oldStr: string,
  newStr: string,
  replaceAll = false
): { ok: true; files: ArtifactFiles } | { ok: false; error: EditError } {
  if (!Object.prototype.hasOwnProperty.call(files, path)) {
    return { ok: false, error: { code: "missing-file", message: `File not found: ${path}. Use Write to create it.` } };
  }
  const content = files[path];
  const idx = content.indexOf(oldStr);
  if (idx === -1) {
    return {
      ok: false,
      error: { code: "no-match", message: `old_string not found in ${path}. Read the file again and pass an exact verbatim substring.` },
    };
  }
  const occurrences = countOccurrences(content, oldStr);
  if (occurrences > 1 && !replaceAll) {
    return {
      ok: false,
      error: {
        code: "ambiguous",
        message: `old_string appears ${occurrences} times in ${path}. Pass replace_all=true to replace every occurrence, or include more surrounding context to make it unique.`,
      },
    };
  }
  const next = replaceAll ? content.split(oldStr).join(newStr) : content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
  return { ok: true, files: { ...files, [path]: next } };
}

export function applyMultiEdit(
  files: ArtifactFiles,
  path: string,
  edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>
): { ok: true; files: ArtifactFiles } | { ok: false; error: EditError; index: number } {
  let cur = files;
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    const r = applyEdit(cur, path, e.old_string, e.new_string, e.replace_all ?? false);
    if (!r.ok) return { ok: false, error: r.error, index: i };
    cur = r.files;
  }
  return { ok: true, files: cur };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let i = 0;
  while (i <= haystack.length - needle.length) {
    if (haystack.slice(i, i + needle.length) === needle) {
      count++;
      i += needle.length;
    } else {
      i++;
    }
  }
  return count;
}

// ---------- diff ----------

export function diffSummary(
  before: ArtifactFiles,
  after: ArtifactFiles
): { added: string[]; removed: string[]; modified: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));
  for (const k of afterKeys) {
    if (!beforeKeys.has(k)) added.push(k);
    else if (before[k] !== after[k]) modified.push(k);
  }
  for (const k of beforeKeys) if (!afterKeys.has(k)) removed.push(k);
  added.sort();
  removed.sort();
  modified.sort();
  return { added, removed, modified };
}

/** Per-file +n -m line counts. Used for the chat UI's diff badges. */
export function lineDelta(beforeContent: string | null, afterContent: string | null): { added: number; removed: number } {
  if (beforeContent === null && afterContent !== null) {
    return { added: countLines(afterContent), removed: 0 };
  }
  if (beforeContent !== null && afterContent === null) {
    return { added: 0, removed: countLines(beforeContent) };
  }
  if (beforeContent === null || afterContent === null) return { added: 0, removed: 0 };
  // Cheap approximation: line-set diff. Over-counts moves, under-counts duplicate lines.
  // Good enough for the visual badge.
  const beforeLines = beforeContent.split("\n");
  const afterLines = afterContent.split("\n");
  const beforeCounts = new Map<string, number>();
  for (const l of beforeLines) beforeCounts.set(l, (beforeCounts.get(l) ?? 0) + 1);
  let added = 0;
  let removed = 0;
  const afterCounts = new Map<string, number>();
  for (const l of afterLines) afterCounts.set(l, (afterCounts.get(l) ?? 0) + 1);
  for (const [line, n] of afterCounts) {
    const wasN = beforeCounts.get(line) ?? 0;
    if (n > wasN) added += n - wasN;
  }
  for (const [line, n] of beforeCounts) {
    const nowN = afterCounts.get(line) ?? 0;
    if (n > nowN) removed += n - nowN;
  }
  return { added, removed };
}

function countLines(s: string): number {
  if (s === "") return 0;
  return s.split("\n").length;
}

// ---------- changes ledger ----------

/** Fold a diff into FileChange[] for the assistant message's `ops` field. */
export function changesFromDiff(before: ArtifactFiles, after: ArtifactFiles): FileChange[] {
  const { added, removed, modified } = diffSummary(before, after);
  const out: FileChange[] = [];
  for (const path of added) {
    const d = lineDelta(null, after[path]);
    out.push({ path, op: "write", addedLines: d.added });
  }
  for (const path of modified) {
    const d = lineDelta(before[path], after[path]);
    out.push({ path, op: "edit", addedLines: d.added, removedLines: d.removed });
  }
  for (const path of removed) {
    const d = lineDelta(before[path], null);
    out.push({ path, op: "delete", removedLines: d.removed });
  }
  return out;
}

// ---------- formatting helpers (used by Read tool result) ----------

/** Format file content like `cat -n`: 1-based line numbers, tab separator. */
export function formatLineNumbered(content: string, offset = 1, limit?: number): string {
  const lines = content.split("\n");
  const start = Math.max(0, offset - 1);
  const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
  const slice = lines.slice(start, end);
  const width = String(start + slice.length).length;
  return slice.map((line, i) => `${String(start + i + 1).padStart(width, " ")}\t${line}`).join("\n");
}

// ---------- hashing (for build cache key) ----------

// Bump when the build OUTPUT changes in a way the VFS files don't capture -
// most importantly the injected SDK (sdk-inline.ts), the importmap, or the
// compose/inject logic. Builds are cached by vfsHash, so without this a fix to
// the SDK would never reach already-built apps (their files are unchanged, so
// the hash - and thus the cache hit - stays the same). "2" force-rebuilt every
// app for the SDK script-parse fix (the `"Script error."` MUTED_HINT bug that
// left window.artifact undefined and every artifact blank). "5" re-applies the
// self-healing ready/init handshake (re-post "ready" until "init") now that the
// root cause is confirmed: on a flaky load the iframe's "ready" or the host's
// "init" reply is dropped, so ready() never resolves, the app never mounts, and
// the frame is blank until a manual Refresh.
// "6" ships the declared-data SDK (artifact.entries + useArtifact in
// "@artifact/ui") and the scheduled() replay-seeding fix - existing apps must
// rebuild to pick up the new inline SDK.
export const BUILD_FORMAT_VERSION = "6";

/** Stable hash of {files, entry} for use as a build cache key. FNV-1a, 32-bit.
 *  Includes BUILD_FORMAT_VERSION so SDK/build-output changes bust the cache. */
export function vfsHash(files: ArtifactFiles, entry: string): string {
  const sortedKeys = Object.keys(files).sort();
  let h = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  mix("bfv:");
  mix(BUILD_FORMAT_VERSION);
  mix("entry:");
  mix(entry);
  for (const k of sortedKeys) {
    mix(" ");
    mix(k);
    mix("");
    mix(files[k]);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
