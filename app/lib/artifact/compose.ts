import { SDK_INLINE_SCRIPT } from "./sdk-inline";
import { ARTIFACT_BASE_CSS_SENTINEL, ARTIFACT_BASE_CSS_TAG } from "./ui-runtime";

/**
 * Take a single HTML document and inject the SDK script + base tag.
 * Used for legacy single-file artifacts and as a fallback when no build
 * step is needed (e.g. an artifact whose entry is index.html with no
 * .ts/.tsx/.jsx imports).
 *
 * - Strips the artifact-manifest <script> block (it's metadata, not runtime code).
 * - Prepends the SDK as a <script> in <head> so window.artifact is defined before
 *   any user code runs.
 * - Adds a small <base target="_top"> so anchor clicks navigate the parent (we
 *   want links to behave naturally, not navigate the sandboxed frame).
 *
 * Multi-file React/TypeScript artifacts go through `buildArtifact()` in
 * `app/lib/artifact/build.ts` instead — that pipeline calls a similar inject
 * step at the end.
 */
export function composeArtifactSrcdoc(html: string): string {
  let out = html;

  // Remove the manifest script block from runtime HTML.
  out = out.replace(
    /<script\b[^>]*type=["']application\/artifact-manifest["'][^>]*>[\s\S]*?<\/script>/gi,
    ""
  );

  // Idempotency: if the HTML already carries the SDK (designer-built
  // artifacts have it injected by build.ts; we re-compose them when
  // creating a share), skip re-injection. The unique-enough sentinel is
  // the protocol namespace string the SDK uses internally.
  if (out.indexOf("__artifact_v1__") !== -1) {
    return out;
  }

  const sdkTag = `<script>${SDK_INLINE_SCRIPT}</script>`;
  const baseTag = `<base target="_top">`;
  // Themed Soft Paper defaults (paper background, ink text, ink-red links,
  // themed form controls) so an otherwise-unstyled single-file artifact inherits
  // the aesthetic instead of raw browser defaults. Injected first so the
  // document's own <style>/<link> win on source order; the rules are
  // 0-specificity (:where) anyway. Skip if a prior pass already added it.
  const baseCss = out.includes(ARTIFACT_BASE_CSS_SENTINEL) ? "" : ARTIFACT_BASE_CSS_TAG;
  const head = `${baseTag}${sdkTag}${baseCss}`;

  // Prefer to inject inside <head>. Fall back to prepending if no head tag.
  if (/<head\b[^>]*>/i.test(out)) {
    out = out.replace(/<head\b[^>]*>/i, (m) => `${m}${head}`);
  } else if (/<html\b[^>]*>/i.test(out)) {
    out = out.replace(
      /<html\b[^>]*>/i,
      (m) => `${m}<head>${head}</head>`
    );
  } else {
    out = `<!doctype html><html><head>${head}</head><body>${out}</body></html>`;
  }

  return out;
}

/**
 * Lightweight error-document shown in the iframe when a build fails.
 * The inner page gets the SDK injected so artifact.fetch / state still work,
 * but visually the user sees a structured error pane.
 */
export function composeBuildErrorDoc(errors: Array<{ file: string; line: number; column: number; message: string; snippet?: string }>): string {
  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const items = errors
    .map((e) => {
      const loc = `${escapeHtml(e.file)}:${e.line}:${e.column}`;
      const snippet = e.snippet ? `<pre>${escapeHtml(e.snippet)}</pre>` : "";
      return `<li><div class="loc">${loc}</div><div class="msg">${escapeHtml(e.message)}</div>${snippet}</li>`;
    })
    .join("");
  const body = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>Build error</title>
<style>
  body { margin:0; font-family: ui-monospace, "SF Mono", Menlo, monospace; background:#1f0f0f; color:#ffe7e0; padding:2rem; min-height:100vh; box-sizing:border-box; }
  h1 { font-family: ui-serif, Georgia, serif; font-weight:600; color:#ff8a73; margin:0 0 1.25rem; font-size:1.1rem; }
  ol { list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:1rem; }
  li { background:#2a1717; border:1px solid #5a2a2a; border-radius:0.5rem; padding:0.75rem 1rem; }
  .loc { color:#ff8a73; font-size:0.8rem; margin-bottom:0.25rem; }
  .msg { color:#ffe7e0; font-size:0.85rem; line-height:1.5; }
  pre { margin: 0.5rem 0 0; padding: 0.5rem 0.75rem; background:#1a0c0c; border-radius:0.25rem; color:#ffd2c5; font-size:0.75rem; overflow-x:auto; }
</style>
</head><body>
<h1>Build failed</h1>
<ol>${items || "<li><div class=\"msg\">No structured error info available.</div></li>"}</ol>
</body></html>`;
  return composeArtifactSrcdoc(body);
}
