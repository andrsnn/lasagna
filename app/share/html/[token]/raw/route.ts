// GET /share/html/[token]/raw — serves a shared artifact as a *top-level*
// HTML document (no sandboxed iframe).
//
// Why this exists: iOS Safari's native "Full Page" screenshot only expands the
// top-level document's scroll height, so it can't capture content that scrolls
// inside the embedded iframe the normal viewer (/share/html/[token]) uses. By
// serving the artifact HTML as the page itself, document scroll == artifact
// scroll and iOS Full Page captures the entire artifact. The Share dialog
// surfaces this URL behind a "full-page screenshot" checkbox.
//
// Public: this lives under the `/share/` prefix, which proxy.ts allowlists, so
// an unauthenticated recipient can open it.
//
// Trade-off vs. the iframe viewer: the artifact runs same-origin with no
// sandbox. We only ever serve operator-generated/shared artifact HTML here
// (the same bytes the iframe viewer loads), and a small same-window SDK host
// shim keeps SDK-driven apps rendering — see buildScreenshotDocument.

import {
  HTML_SHARE_TOKEN_REGEX,
  getHtmlShare,
  isHtmlShareStoreConfigured,
} from "@/app/lib/html-share-store";
import { buildScreenshotDocument } from "@/app/lib/artifact/screenshot-host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorPage(status: number, message: string): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shared artifact</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:ui-sans-serif,system-ui,sans-serif;color:#444;background:#faf9f7;padding:2rem;text-align:center;}</style>
</head><body><p>${message}</p></body></html>`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!HTML_SHARE_TOKEN_REGEX.test(token)) {
    return errorPage(404, "This share link doesn't exist.");
  }
  if (!isHtmlShareStoreConfigured()) {
    return errorPage(503, "Sharing isn't configured on this server.");
  }

  let payload;
  try {
    payload = await getHtmlShare(token);
  } catch {
    return errorPage(500, "Failed to load this shared artifact.");
  }
  if (!payload) {
    return errorPage(410, "This share link has expired. Ask the sender for a new one.");
  }

  const doc = buildScreenshotDocument(payload.html, token, payload.params ?? {});
  return new Response(doc, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Don't let a screenshot view get cached past the share's life.
      "Cache-Control": "no-store",
    },
  });
}
