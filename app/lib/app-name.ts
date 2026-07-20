"use client";

// Tile name resolver.
//
// The artifact's `name` comes from manifest.json. New artifacts ship with the
// placeholder "Untitled" / "Untitled artifact" and the assistant frequently
// doesn't update it during edits. This helper lazily fills in a real name via
// Gemma once we have enough designer context to summarize.
//
// Source ordering:
//   1. Anything other than the placeholders → keep as-is (manifest source).
//   2. Cached gemma name not stale relative to designer.updatedAt.
//   3. POST /api/app-name → gemma4:31b (async, deduped + queued).

import { putApp, putDesigner, type StoredApp, type StoredDesigner } from "@/app/db";

export type NameSource = "manifest" | "gemma";

const PLACEHOLDER_RE = /^\s*(untitled|untitled artifact)\s*$/i;

const MAX_INFLIGHT = 2;
const inflight = new Map<string, Promise<string | null>>();
const queue: Array<() => void> = [];
let active = 0;

function runQueued<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      active += 1;
      fn().then(
        (value) => {
          active -= 1;
          drain();
          resolve(value);
        },
        (err) => {
          active -= 1;
          drain();
          reject(err);
        }
      );
    };
    if (active < MAX_INFLIGHT) start();
    else queue.push(start);
  });
}

function drain() {
  while (active < MAX_INFLIGHT && queue.length > 0) {
    const next = queue.shift();
    if (next) next();
  }
}

export function isPlaceholderName(name: string | undefined | null): boolean {
  if (!name) return true;
  return PLACEHOLDER_RE.test(name);
}

const FALLBACK_MAX_CHARS = 28;

/**
 * Last-resort client-side name when /api/app-name is unreachable. Take the
 * first 1-3 words of the description (or notes), title-case them. Anything is
 * better than leaving "Untitled" forever.
 */
function fallbackName(designer: StoredDesigner): string | null {
  const source =
    designer.manifest?.description?.trim() ||
    designer.description?.trim() ||
    designer.notes?.trim() ||
    "";
  if (!source) return null;
  const cleaned = source.replace(/\s+/g, " ").trim();
  const sentence = cleaned.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? cleaned;
  const words = sentence
    .split(" ")
    .map((w) => w.replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter(Boolean)
    .slice(0, 3);
  if (words.length === 0) return null;
  let name = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
  if (name.length > FALLBACK_MAX_CHARS) {
    name = name.slice(0, FALLBACK_MAX_CHARS).replace(/[\s,;:.!?-]+$/, "").trim();
  }
  return isPlaceholderName(name) ? null : name;
}

/**
 * Returns true when the artifact's name is the placeholder AND we don't have a
 * fresh cached gemma rename for it.
 */
export function shouldGenerateName(
  app: StoredApp,
  designer: StoredDesigner | undefined
): boolean {
  if (!designer) return false;
  if (!isPlaceholderName(app.name)) return false;
  if (
    app.nameSource === "gemma" &&
    app.nameUpdatedAt &&
    designer.updatedAt <= app.nameUpdatedAt
  ) {
    return false;
  }
  // Need *something* to feed the model. A bare designer with no description,
  // no notes, no manifest params, and an unedited starter VFS isn't worth a call.
  const description =
    designer.manifest?.description?.trim() || designer.description?.trim() || "";
  const notes = designer.notes?.trim() || "";
  const params = designer.manifest?.params ?? [];
  const entryFile = designer.files?.[designer.entry] ?? "";
  const hasContent = !!(description || notes || params.length > 0 || entryFile.length > 200);
  return hasContent;
}

function entryExcerpt(designer: StoredDesigner): string {
  const entry = designer.files?.[designer.entry];
  if (!entry) return "";
  return entry.slice(0, 1200);
}

async function postName(app: StoredApp, designer: StoredDesigner): Promise<string | null> {
  const manifestParams = (designer.manifest?.params ?? []).map((p) => ({
    key: p.key,
    label: p.label,
    type: p.type,
  }));
  const res = await fetch("/api/app-name", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      description: designer.manifest?.description ?? designer.description,
      notes: designer.notes,
      manifestParams,
      codeExcerpt: entryExcerpt(designer),
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { name?: string; error?: string };
  const name = (data.name ?? "").trim();
  return name || null;
}

/**
 * Generate (or reuse an inflight) name for `app` and persist it to both the
 * paired app (the visible tile field) and the designer's name + manifest. The
 * 1:1 invariant means both rows must stay in sync.
 *
 * Concurrent calls for the same app coalesce; failures are silent.
 */
export function generateName(
  app: StoredApp,
  designer: StoredDesigner
): Promise<string | null> {
  const existing = inflight.get(app.id);
  if (existing) return existing;

  const promise = runQueued(async () => {
    let name: string | null = null;
    try {
      name = await postName(app, designer);
    } catch {
      name = null;
    }
    if (!name || isPlaceholderName(name)) name = fallbackName(designer);
    if (!name || isPlaceholderName(name)) return null;
    const now = Date.now();
    try {
      await putApp({
        ...app,
        name,
        nameSource: "gemma",
        nameUpdatedAt: now,
      });
    } catch {
      // best-effort
    }
    try {
      await putDesigner({
        ...designer,
        name,
        manifest: designer.manifest
          ? { ...designer.manifest, name }
          : designer.manifest,
      });
    } catch {
      // best-effort
    }
    return name;
  }).finally(() => {
    inflight.delete(app.id);
  });

  inflight.set(app.id, promise);
  return promise;
}
