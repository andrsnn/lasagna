// GET /share/note/[token]/raw — serves an HTML-bodied shared note as a
// *top-level* HTML document (no sandboxed iframe).
//
// Why this exists: the normal note viewer (/share/note/[token]) renders an
// HTML note inside a sandboxed <iframe srcDoc>. That's the right default, but
// it breaks two things a recipient often wants:
//   - Printing / "Save as PDF": Cmd+P prints the (empty) host page, not the
//     iframe's content, so the PDF comes out blank.
//   - iOS Safari "Full Page" screenshot: it only expands the top-level
//     document's scroll height and can't reach content inside the iframe.
// Serving the note HTML as the page itself makes document scroll == note
// scroll, so print and full-page screenshot both capture the whole thing.
//
// This mirrors /share/html/[token]/raw, but notes are static documents — the
// note viewer has no SDK host bridge — so we serve the HTML directly without
// the screenshot host shim and never expose the SDK to it.
//
// Public: lives under the `/share/` prefix, which proxy.ts allowlists, so an
// unauthenticated recipient can open it.

import {
  NOTE_SHARE_TOKEN_REGEX,
  getNoteShare,
  isNoteShareStoreConfigured,
} from "@/app/lib/note-share-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function htmlPage(title: string, message: string, status: number): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:ui-sans-serif,system-ui,sans-serif;color:#444;background:#faf9f7;padding:2rem;text-align:center;}</style>
</head><body><p>${escapeHtml(message)}</p></body></html>`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Serve the note's HTML as a standalone top-level document. The note body is
// usually a complete `<!doctype html>` document already (it renders that way in
// the iframe srcDoc), so we pass it through as-is and only inject a viewport
// meta (for mobile scale) and a <title> (for the print dialog's default
// filename) when the document doesn't set them.
function topLevelDocument(html: string, title: string): string {
  const inserts: string[] = [];
  if (!/<meta\s+name=["']viewport["']/i.test(html)) {
    inserts.push(
      `<meta name="viewport" content="width=device-width, initial-scale=1">`
    );
  }
  if (title && !/<title[^>]*>/i.test(html)) {
    inserts.push(`<title>${escapeHtml(title)}</title>`);
  }
  const head = inserts.join("");
  if (!head) return html;

  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (m) => `${m}${head}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${html}</body></html>`;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!NOTE_SHARE_TOKEN_REGEX.test(token)) {
    return htmlPage("Shared note", "This share link doesn't exist.", 404);
  }
  if (!isNoteShareStoreConfigured()) {
    return htmlPage("Shared note", "Sharing isn't configured on this server.", 503);
  }

  let payload;
  try {
    payload = await getNoteShare(token);
  } catch {
    return htmlPage("Shared note", "Failed to load this shared note.", 500);
  }
  if (!payload) {
    return htmlPage(
      "Shared note",
      "This share link has expired. Ask the sender for a new one.",
      410
    );
  }
  if (payload.body.kind !== "html") {
    // Only HTML notes have a meaningful full-page rendering. Markdown / snapshot
    // notes are laid out by the React viewer, so point the recipient back there.
    return htmlPage(
      payload.title || "Shared note",
      "The full-page view is only available for HTML notes. Open the share link without the /raw suffix.",
      404
    );
  }

  const doc = topLevelDocument(payload.body.html, payload.title);
  return new Response(doc, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Don't let a full-page view get cached past the share's life.
      "Cache-Control": "no-store",
    },
  });
}
