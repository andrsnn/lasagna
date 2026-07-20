// /api/build — bundles an artifact's VFS into an iframe-ready srcdoc.
// Used by the iframe renderer (to compose live previews) and the chat
// tool dispatcher (when the model calls the Build tool to verify code).

import { buildArtifact, buildArtifactWidgetFromVfs } from "@/app/lib/artifact/build";
import { vfsHash } from "@/app/lib/artifact/vfs";
import type { ArtifactFiles } from "@/app/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tiny in-memory LRU keyed by (target + entry + vfsHash). Survives the
// lifetime of the server process; rebuilds are cheap (~tens of ms) but
// caching prevents the preview from rebundling on every iframe remount
// during a chat stream. The `target` prefix keeps app and widget bundles
// distinct under the same VFS hash.
const CACHE = new Map<string, { html: string; warnings: unknown[]; durationMs: number }>();
const CACHE_MAX = 64;

function cacheKey(target: "app" | "widget", files: ArtifactFiles, entry: string): string {
  return `${target}:${entry}@${vfsHash(files, entry)}`;
}

export async function POST(req: Request) {
  let body: { files?: ArtifactFiles; entry?: string; target?: "app" | "widget" };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, errors: [{ file: "<body>", line: 0, column: 0, message: "Invalid JSON body" }] }, { status: 400 });
  }
  const files = body.files;
  const entry = body.entry;
  const target: "app" | "widget" = body.target === "widget" ? "widget" : "app";
  if (!files || typeof files !== "object" || Array.isArray(files) || !entry || typeof entry !== "string") {
    return Response.json(
      { ok: false, errors: [{ file: "<body>", line: 0, column: 0, message: "files (object) and entry (string) required" }] },
      { status: 400 }
    );
  }

  const key = cacheKey(target, files, entry);
  const cached = CACHE.get(key);
  if (cached) {
    // Touch to refresh LRU position.
    CACHE.delete(key);
    CACHE.set(key, cached);
    return Response.json({ ok: true, ...cached, cached: true, bundleHash: key });
  }

  const result =
    target === "widget"
      ? await buildArtifactWidgetFromVfs(files, entry)
      : await buildArtifact(files, entry);
  if (result.ok) {
    CACHE.set(key, { html: result.html, warnings: result.warnings, durationMs: result.durationMs });
    if (CACHE.size > CACHE_MAX) {
      const oldest = CACHE.keys().next().value;
      if (oldest) CACHE.delete(oldest);
    }
    return Response.json({ ok: true, html: result.html, warnings: result.warnings, durationMs: result.durationMs, bundleHash: key });
  }
  return Response.json(
    { ok: false, errors: result.errors, warnings: result.warnings, durationMs: result.durationMs, bundleHash: key },
    { status: 200 } // Build errors are an expected outcome, not an HTTP failure.
  );
}
