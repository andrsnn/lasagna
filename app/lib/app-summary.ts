"use client";

// Tile tagline resolver.
//
// Resolves cheapest-first:
//   1. designer.manifest?.description / designer.description (sync)
//   2. First sentence of designer.notes, capped at 120 chars (sync)
//   3. Cached app.tagline if not stale relative to designer.updatedAt (sync)
//   4. POST /api/app-summary → gemma4:31b (async, deduped + semaphored)
//
// The async path is deduped per-app and capped at 2 concurrent requests so
// a full grid of empty apps doesn't fan out to Ollama at once.

import { putApp, type StoredApp, type StoredDesigner } from "@/app/db";

export type TaglineSource = "description" | "notes" | "gemma";

export type TaglineResolution =
  | { tagline: string; source: TaglineSource }
  | { tagline: null; source: null };

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

function firstSentence(text: string, maxChars = 120): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(.+?[.!?])(?:\s|$)/);
  let sentence = match ? match[1] : trimmed;
  sentence = sentence.replace(/\s+/g, " ").trim();
  if (sentence.length > maxChars) {
    sentence = sentence.slice(0, maxChars).replace(/[\s,;:.!?-]+$/, "").trim() + "…";
  }
  return sentence;
}

/**
 * Synchronous resolution — checks the cheap sources in order. Returns
 * `{ tagline: null, source: null }` when no synchronous source applies.
 */
export function resolveTaglineSync(
  app: StoredApp,
  designer: StoredDesigner | undefined
): TaglineResolution {
  const description =
    designer?.manifest?.description?.trim() || designer?.description?.trim() || "";
  if (description) {
    return { tagline: firstSentence(description) ?? description, source: "description" };
  }
  const notes = designer?.notes?.trim() || "";
  if (notes) {
    const sentence = firstSentence(notes);
    if (sentence) return { tagline: sentence, source: "notes" };
  }
  if (
    app.tagline &&
    app.taglineSource === "gemma" &&
    app.taglineUpdatedAt &&
    designer &&
    designer.updatedAt <= app.taglineUpdatedAt
  ) {
    return { tagline: app.tagline, source: "gemma" };
  }
  // Stale-but-present gemma cache: still show it while we refresh.
  if (app.tagline && app.taglineSource === "gemma") {
    return { tagline: app.tagline, source: "gemma" };
  }
  return { tagline: null, source: null };
}

/**
 * Returns true when the synchronous resolution either had nothing, or had a
 * stale gemma cache that should be refreshed against the current designer.
 */
export function shouldGenerateTagline(
  app: StoredApp,
  designer: StoredDesigner | undefined
): boolean {
  if (!designer) return false;
  const description =
    designer.manifest?.description?.trim() || designer.description?.trim() || "";
  if (description) return false;
  if (designer.notes && designer.notes.trim()) return false;
  if (
    app.tagline &&
    app.taglineSource === "gemma" &&
    app.taglineUpdatedAt &&
    designer.updatedAt <= app.taglineUpdatedAt
  ) {
    return false;
  }
  return true;
}

async function postSummary(
  app: StoredApp,
  designer: StoredDesigner
): Promise<string | null> {
  const manifestParams = (designer.manifest?.params ?? []).map((p) => ({
    key: p.key,
    label: p.label,
    type: p.type,
  }));
  const res = await fetch("/api/app-summary", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: app.name,
      designerName: designer.name,
      description: designer.description,
      notes: designer.notes,
      manifestParams,
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { tagline?: string; error?: string };
  const tagline = (data.tagline ?? "").trim();
  return tagline || null;
}

/**
 * Generate (or reuse an in-flight) tagline for `app` and persist it. Returns
 * the new tagline or null on failure. Safe to call repeatedly — concurrent
 * calls for the same app coalesce.
 */
export function generateTagline(
  app: StoredApp,
  designer: StoredDesigner
): Promise<string | null> {
  const existing = inflight.get(app.id);
  if (existing) return existing;

  const promise = runQueued(async () => {
    try {
      const tagline = await postSummary(app, designer);
      if (!tagline) return null;
      try {
        await putApp({
          ...app,
          tagline,
          taglineSource: "gemma",
          taglineUpdatedAt: Date.now(),
        });
      } catch {
        // Persistence failure is non-fatal; the tagline still renders this session.
      }
      return tagline;
    } catch {
      return null;
    }
  }).finally(() => {
    inflight.delete(app.id);
  });

  inflight.set(app.id, promise);
  return promise;
}
