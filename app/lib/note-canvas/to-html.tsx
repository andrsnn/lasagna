"use client";

// Convert a markdown note body into a standalone HTML document so the canvas
// can flip a note from kind:"markdown" to kind:"html". Markdown has no styling
// controls; once a note is HTML it renders in a sandboxed iframe where CSS (and
// the assistant) can restyle it freely. We render the markdown through the same
// react-markdown + remark-gfm pipeline the preview uses, so the converted body
// matches what the user already saw - then wrap it in an editable document.

import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Lift any raw <style> blocks out of the markdown source. In a markdown note
// these are escaped and shown as literal text (and never applied); in an HTML
// document they belong in <head> where they actually take effect. Pulling them
// up means a font/CSS hack a user (or a model) stuffed into the markdown starts
// working the moment they convert, instead of rendering as a stray code line.
const STYLE_BLOCK = /<style\b[^>]*>[\s\S]*?<\/style>/gi;

const BASE_STYLES = `
  /* Base note styles - edit these freely, or ask the assistant to restyle. */
  :root { color-scheme: light dark; }
  body {
    font-family: Georgia, "Times New Roman", serif;
    line-height: 1.7;
    max-width: 46rem;
    margin: 2.5rem auto;
    padding: 0 1.25rem;
    color: #1a1a1a;
    background: #ffffff;
  }
  h1, h2, h3, h4 { line-height: 1.25; }
  a { color: #0b66c3; }
  img { max-width: 100%; height: auto; }
  blockquote { border-left: 3px solid #ddd; margin: 1em 0; padding-left: 1em; color: #555; }
  pre, code { font-family: ui-monospace, Menlo, Consolas, monospace; }
  code { background: #f0f0f0; padding: .1em .3em; border-radius: 4px; }
  pre { overflow-x: auto; padding: .75rem 1rem; background: #f5f5f5; border-radius: 8px; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #ddd; padding: .4em .6em; }
`.trim();

// ```mermaid fences render as `<pre><code class="language-mermaid">…` here.
// Mermaid's browser runtime instead expects `<pre class="mermaid">…`, reading
// the diagram source from the element's textContent (which decodes the escaped
// entities react produced). Rewrite the fences so a converted/exported HTML
// note keeps rendering its diagrams instead of showing raw source.
const MERMAID_FENCE =
  /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g;

// ESM entry point for mermaid's browser runtime. Loaded only when a converted
// note actually contains a diagram, so diagram-free notes stay dependency-free.
const MERMAID_RUNTIME = `
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  mermaid.initialize({ startOnLoad: true, securityLevel: "strict", theme: dark ? "dark" : "default" });
</script>`.trim();

/**
 * Render a markdown note body to a full, editable HTML document string.
 * Any <style> blocks in the source are hoisted into <head> (after the base
 * styles, so the user's rules win) rather than rendered as escaped text.
 */
export function markdownNoteToHtmlDocument(markdown: string): string {
  const liftedStyles: string[] = [];
  const stripped = markdown.replace(STYLE_BLOCK, (match) => {
    liftedStyles.push(match.trim());
    return "";
  });

  const rendered = renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripped}</ReactMarkdown>
  );
  const inner = rendered.replace(
    MERMAID_FENCE,
    (_m, code) => `<pre class="mermaid">${code}</pre>`
  );
  const hasMermaid = inner !== rendered;

  const extra = liftedStyles.length ? `\n${liftedStyles.join("\n")}` : "";
  const runtime = hasMermaid ? `\n${MERMAID_RUNTIME}` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
${BASE_STYLES}
</style>${extra}
</head>
<body>
${inner}${runtime}
</body>
</html>`;
}
