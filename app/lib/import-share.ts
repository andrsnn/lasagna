"use client";

// Client helper that takes a SharedAppPayload (fetched from /api/share/[token])
// and writes a fresh designer + paired app row into the recipient's IndexedDB
// with a new id. Mirrors the create flow in app/lib/create.ts so imported apps
// behave identically to ones the recipient created themselves.

import {
  newId,
  putApp,
  putDesigner,
  type StoredApp,
  type StoredDesigner,
} from "@/app/db";
import type { SharedAppPayload } from "@/app/lib/share-store";

export async function importSharedApp(
  payload: SharedAppPayload
): Promise<{ id: string }> {
  if (typeof indexedDB === "undefined") {
    throw new Error(
      "Local storage is unavailable. Open the link in a regular browser window (not private/incognito) to import this app."
    );
  }

  const id = newId();
  const now = Date.now();

  const designer: StoredDesigner = {
    id,
    name: payload.designer.name,
    description: payload.designer.description,
    files: payload.designer.files,
    entry: payload.designer.entry,
    manifest: payload.designer.manifest,
    status: "draft",
    version: 1,
    history: [],
    createdAt: now,
    updatedAt: now,
  };

  // 1:1 invariant — paired app shares the designer's id.
  const app: StoredApp = {
    id,
    name: payload.app.name,
    params: payload.app.params ?? {},
    model: payload.app.model,
    state: payload.app.state ?? {},
    createdAt: now,
    updatedAt: now,
  };

  await putDesigner(designer);
  await putApp(app);
  return { id };
}
