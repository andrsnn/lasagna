"use client";

// Generic "app bundle" export: download an app as a self-contained JSON file
// (designer files/entry/manifest + app name/params/model/state) so it can be
// backed up, inspected, or hand-edited. Reuses the same serialize plumbing as
// share links.
//
// Platform capability (domain-agnostic): works for ANY app, not a specific
// product. See CLAUDE.md "Platform vs product".

import { serializeForShare } from "@/app/lib/share-payload";
import type { StoredApp, StoredDesigner } from "@/app/db";

const BUNDLE_TYPE = "artifact-app-bundle";

export function buildAppBundle(designer: StoredDesigner, app: StoredApp) {
  const serialized = serializeForShare(designer, app, true);
  return {
    type: BUNDLE_TYPE,
    version: 1,
    exportedAt: Date.now(),
    name: app.name,
    designer: serialized.designer,
    app: serialized.app,
  };
}

/** Trigger a browser download of the app bundle as `<name>.json`. */
export function downloadAppBundle(designer: StoredDesigner, app: StoredApp) {
  const bundle = buildAppBundle(designer, app);
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safe = (app.name || "app").replace(/[^a-z0-9]+/gi, "-").slice(0, 60) || "app";
  a.href = url;
  a.download = `${safe}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
