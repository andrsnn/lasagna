// Helpers for working with markdown ``` fences as react-markdown hands them
// to a custom `pre` renderer (hast node shape). Shared across the chat view
// and the read-only note/share renderers so a single extraction stays in sync.

export function looksLikeHtmlArtifact(
  lang: string | undefined,
  code: string
): boolean {
  const l = (lang || "").toLowerCase();
  if (l === "html" || l === "htm" || l === "xhtml" || l === "svg") return true;
  return /<!doctype html|<html[\s>]|<svg[\s>]/i.test(code.trim());
}

// Pull the language tag and raw source out of a markdown ``` fence.
export function extractFencedCode(
  node: unknown
): { lang: string | undefined; code: string } | null {
  const pre = node as
    | {
        children?: Array<{
          tagName?: string;
          properties?: { className?: unknown };
          children?: Array<{ value?: string }>;
        }>;
      }
    | undefined;
  const codeEl = pre?.children?.find((c) => c?.tagName === "code");
  if (!codeEl) return null;
  const classes = Array.isArray(codeEl.properties?.className)
    ? (codeEl.properties!.className as unknown[]).map(String)
    : [];
  const langClass = classes.find((c) => c.startsWith("language-"));
  const lang = langClass ? langClass.slice("language-".length) : undefined;
  const code = (codeEl.children || []).map((c) => c?.value ?? "").join("");
  return { lang, code };
}
