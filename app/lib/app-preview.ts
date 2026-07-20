"use client";

// Tile preview resolver.
//
// Instead of rendering the artifact's actual build output (which depends on
// the full build pipeline running successfully and being persisted), we ask
// Gemma to draft a small standalone HTML hero card that visually represents
// the app. This is purely decorative and decoupled from /api/build.
//
// Resolution:
//   1. Cached gemma preview if not stale relative to designer.updatedAt.
//   2. POST /api/app-preview → gemma4:31b (async, deduped + queued).

import { putApp, type StoredApp, type StoredDesigner } from "@/app/db";

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

/**
 * Synchronous resolution. Returns the cached gemma preview if we have one and
 * it's not stale relative to the designer; otherwise null.
 */
export function resolvePreviewSync(
  app: StoredApp,
  designer: StoredDesigner | undefined
): string | null {
  if (!app.previewHtml) return null;
  if (app.previewSource !== "gemma") return null;
  if (!designer) return app.previewHtml;
  if (!app.previewUpdatedAt) return app.previewHtml;
  if (designer.updatedAt > app.previewUpdatedAt) {
    // Stale-but-present: still show it while we refresh in the background.
    return app.previewHtml;
  }
  return app.previewHtml;
}

/**
 * Returns true when there's no fresh cached preview for this app/designer pair.
 */
export function shouldGeneratePreview(
  app: StoredApp,
  designer: StoredDesigner | undefined
): boolean {
  if (!designer) return false;
  if (
    app.previewHtml &&
    app.previewSource === "gemma" &&
    app.previewUpdatedAt &&
    designer.updatedAt <= app.previewUpdatedAt
  ) {
    return false;
  }
  return true;
}

function entryExcerpt(designer: StoredDesigner): string {
  const entry = designer.files?.[designer.entry];
  if (!entry) return "";
  return entry.slice(0, 1200);
}

async function postPreview(app: StoredApp, designer: StoredDesigner): Promise<string | null> {
  const manifestParams = (designer.manifest?.params ?? []).map((p) => ({
    key: p.key,
    label: p.label,
    type: p.type,
  }));
  const res = await fetch("/api/app-preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: app.name,
      description: designer.manifest?.description ?? designer.description,
      notes: designer.notes,
      manifestParams,
      codeExcerpt: entryExcerpt(designer),
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { html?: string; error?: string };
  const html = (data.html ?? "").trim();
  return html || null;
}

/**
 * Generate (or reuse an inflight) preview html for `app` and persist it on
 * the StoredApp. Concurrent calls coalesce; failures are silent.
 */
export function generatePreview(
  app: StoredApp,
  designer: StoredDesigner
): Promise<string | null> {
  const existing = inflight.get(app.id);
  if (existing) return existing;

  const promise = runQueued(async () => {
    try {
      const html = await postPreview(app, designer);
      if (!html) return null;
      try {
        await putApp({
          ...app,
          previewHtml: html,
          previewSource: "gemma",
          previewUpdatedAt: Date.now(),
        });
      } catch {
        // best-effort
      }
      return html;
    } catch {
      return null;
    }
  }).finally(() => {
    inflight.delete(app.id);
  });

  inflight.set(app.id, promise);
  return promise;
}
