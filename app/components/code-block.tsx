"use client";

// A drop-in `pre` renderer for react-markdown that overlays a copy button on
// fenced code blocks. The button lifts the raw fence source (not the rendered
// DOM text) so whitespace and prompts copy back verbatim. Falls back to a
// plain <pre> when the node isn't a recognizable code fence.

import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import { extractFencedCode } from "@/app/lib/fenced-code";
import { MermaidDiagram } from "@/app/components/mermaid-diagram";

type PreProps = React.HTMLAttributes<HTMLPreElement> & {
  node?: unknown;
  children?: React.ReactNode;
};

export function CodeBlock({ node, children, ...props }: PreProps) {
  const fenced = extractFencedCode(node);
  const code = fenced?.code ?? "";
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [code]);

  // A ```mermaid fence is a diagram, not code — render it to inline SVG. This
  // is what gives every markdown note (and share/reader view) the ability to
  // draw small, accurate diagrams from plain-text source.
  //
  // IMPORTANT: this branch (and the empty-code one below) must come AFTER every
  // hook above. While a message streams, the same fence flips between mermaid
  // and plain-code as its language/content fill in; returning before a hook
  // would change the hook count between renders and throw React error #300,
  // crashing the whole tree. Keep all hooks unconditional, branch last.
  if (fenced && fenced.lang?.toLowerCase() === "mermaid" && code.trim()) {
    return <MermaidDiagram code={code} />;
  }

  if (!code) {
    return <pre {...props}>{children}</pre>;
  }

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => void handleCopy()}
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
        className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-border bg-card/90 px-2 py-1 text-[11px] font-medium text-foreground no-underline shadow-sm backdrop-blur transition hover:bg-muted"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-500" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre {...props}>{children}</pre>
    </div>
  );
}
