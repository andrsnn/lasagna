// Shared HTML "page" shell for imported documents.
//
// Importers (docx/pdf → HTML) produce a *fragment*; the canvas editor and every
// export path assume a *full* `<!doctype html>` document (the preview iframe's
// `srcDoc`, the HTML→docx walker, and the print-to-PDF path all parse a complete
// document). `wrapInPageHtml` is the single source of truth for that shell so the
// preview, DOCX export, and PDF print all share one paged, print-friendly layout.
//
// Pure string building — safe to import from client or server modules.

/** Strip a file extension for use as a default note title. */
export function titleFromFilename(name: string): string {
  return name.replace(/\.[^.]+$/, "").trim() || "Imported document";
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Wrap an HTML fragment into a standalone, print-friendly A4 document.
 * `title` (optional) becomes the `<title>` — handy for the print dialog's
 * default filename. The body is centered with page-like margins so the canvas
 * iframe preview and a `window.print()` "Save as PDF" both read as a document.
 */
export function wrapInPageHtml(fragmentHtml: string, title?: string): string {
  const titleTag = title ? `<title>${escapeHtml(title)}</title>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${titleTag}
<style>
  @page { size: A4; margin: 2.5cm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #f3f3f3; }
  body {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 12pt;
    line-height: 1.5;
    color: #111;
  }
  /* The "page": centered, white, with page-sized padding. On print the @page
     margin takes over and this padding/centering collapses to the sheet. */
  .doc-page {
    max-width: 21cm;
    margin: 1.5cm auto;
    padding: 2.5cm;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.2; margin: 1.2em 0 0.4em; }
  h1 { font-size: 1.8em; }
  h2 { font-size: 1.4em; }
  h3 { font-size: 1.15em; }
  p { margin: 0 0 0.8em; }
  ul, ol { margin: 0 0 0.8em 1.4em; padding: 0; }
  li { margin: 0.2em 0; }
  a { color: #1a4fb4; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 0.8em; }
  td, th { border: 1px solid #ccc; padding: 4px 8px; text-align: left; vertical-align: top; }
  @media print {
    html, body { background: #fff; }
    .doc-page { margin: 0; padding: 0; max-width: none; box-shadow: none; }
  }
</style>
</head>
<body>
<div class="doc-page">
${fragmentHtml}
</div>
</body>
</html>`;
}
