"use client";

// Generic app ZIP export/import (domain-agnostic platform capability).
//
// Download a .zip of an app so it can be edited locally and re-uploaded:
//   <designer files at their real paths>   e.g. App.tsx, components/Toolbar.tsx, index.html
//   _designer.json   { name, description, entry, manifest, version }
//   _app.json        { name, params, model, state }   <- includes the app's DATA
//
// Round-trips through importSharedApp on upload. Reuses serializeForShare so the
// shape matches share links exactly. See CLAUDE.md "Platform vs product": this
// works for ANY app.

import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { serializeForShare } from "@/app/lib/share-payload";
import type { StoredApp, StoredDesigner } from "@/app/db";
import type { SharedAppPayload } from "@/app/lib/share-payload";

const APP_META = "_app.json";
const DESIGNER_META = "_designer.json";

export function buildAppZip(designer: StoredDesigner, app: StoredApp): Uint8Array {
  const { designer: d, app: a } = serializeForShare(designer, app, true);
  const files: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(d.files)) {
    files[path] = strToU8(content);
  }
  files[DESIGNER_META] = strToU8(
    JSON.stringify(
      { name: d.name, description: d.description, entry: d.entry, manifest: d.manifest, version: d.version },
      null,
      2
    )
  );
  files[APP_META] = strToU8(
    JSON.stringify({ name: a.name, params: a.params, model: a.model, state: a.state ?? {} }, null, 2)
  );
  return zipSync(files, { level: 6 });
}

function safeName(s: string): string {
  return (s || "app").replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "app";
}

export function downloadAppZip(designer: StoredDesigner, app: StoredApp): void {
  const bytes = buildAppZip(designer, app);
  // Copy into a plain ArrayBuffer slice so the Blob doesn't retain fflate's view.
  const blob = new Blob([bytes.slice().buffer], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const el = document.createElement("a");
  el.href = url;
  el.download = `${safeName(app.name || designer.name)}.zip`;
  document.body.appendChild(el);
  el.click();
  el.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Parse an uploaded app .zip into the payload importSharedApp consumes. */
export function parseAppZip(buf: ArrayBuffer): SharedAppPayload {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(buf));
  } catch {
    throw new Error("That file isn't a valid .zip.");
  }
  const designerMetaRaw = entries[DESIGNER_META];
  const appMetaRaw = entries[APP_META];
  if (!designerMetaRaw || !appMetaRaw) {
    throw new Error("Not an app zip (missing _designer.json / _app.json).");
  }
  let dMeta: Record<string, unknown>;
  let aMeta: Record<string, unknown>;
  try {
    dMeta = JSON.parse(strFromU8(designerMetaRaw));
    aMeta = JSON.parse(strFromU8(appMetaRaw));
  } catch {
    throw new Error("App zip metadata is corrupt.");
  }
  const files: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(entries)) {
    if (path === APP_META || path === DESIGNER_META) continue;
    if (path.endsWith("/")) continue; // directory entry
    if (path.startsWith("__MACOSX/") || path.endsWith("/.DS_Store") || path === ".DS_Store") continue;
    files[path] = strFromU8(bytes);
  }
  if (!Object.keys(files).length || typeof dMeta.entry !== "string") {
    throw new Error("App zip has no files or no entry.");
  }
  return {
    designer: {
      name: typeof dMeta.name === "string" ? dMeta.name : "Imported app",
      description: typeof dMeta.description === "string" ? dMeta.description : "",
      files,
      entry: dMeta.entry,
      manifest: (dMeta.manifest as SharedAppPayload["designer"]["manifest"]) ?? null,
      version: typeof dMeta.version === "number" ? dMeta.version : 1,
    },
    app: {
      name: typeof aMeta.name === "string" ? aMeta.name : "Imported app",
      params: (aMeta.params as Record<string, unknown>) ?? {},
      model: typeof aMeta.model === "string" ? aMeta.model : undefined,
      state: (aMeta.state as Record<string, unknown>) ?? {},
    },
    summary: "",
    createdAt: 0,
    expiresAt: 0,
  };
}
