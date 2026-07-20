"use client";

// Live preview pane for the pinned-note canvas editor. Switches on note
// kind: markdown → ReactMarkdown w/ <mark> overlay for the active selection;
// HTML → sandboxed iframe srcDoc (the existing ArtifactFrame is overkill
// here — we don't need the artifact SDK, params, or runtime hooks);
// snapshot → read-only transcript with a "Fork as markdown" CTA.

import { forwardRef, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  injectSentinels,
  type Anchor,
  type HighlightSpan,
} from "@/app/lib/annotations/anchor";
import { rehypeHighlights } from "@/app/lib/annotations/rehype-highlights";
import { CANVAS_SELECTION_ID } from "@/app/lib/note-canvas/comments";
import type { NoteCanvasKind } from "@/app/lib/note-canvas/body";
import { CodeBlock } from "@/app/components/code-block";

export type NotePreviewProps = {
  kind: NoteCanvasKind;
  /** The current body to render (may be the pending-edit body while streaming). */
  body: string;
  /** Active selection — drawn as <mark> in the markdown preview. */
  anchor?: Anchor | null;
  /** Persisted review comments — drawn as distinct comment <mark>s. */
  comments?: HighlightSpan[];
  /** Read-only mode (used for snapshot kind in v1). */
  readOnly?: boolean;
};

/**
 * Markdown preview with selection overlay. We inject ANN sentinels at the
 * anchor position and run the existing rehype-highlights plugin so the
 * highlighted span renders as a `<mark>` — same machinery the chat uses
 * for research annotations.
 */
const MarkdownPreview = forwardRef<
  HTMLDivElement,
  { body: string; anchor?: Anchor | null; comments?: HighlightSpan[] }
>(function MarkdownPreview({ body, anchor, comments }, ref) {
  // Overlay the persisted comments plus the live selection. injectSentinels
  // re-anchors each span against the (possibly drifted) body via its
  // occurrence fallback and drops overlaps, so a comment mark survives edits
  // and the active selection never double-wraps a commented span.
  const spans = useMemo<HighlightSpan[]>(() => {
    const out: HighlightSpan[] = comments ? [...comments] : [];
    if (anchor) out.push({ id: CANVAS_SELECTION_ID, ...anchor });
    return out;
  }, [anchor, comments]);

  const source = useMemo(
    () => (spans.length ? injectSentinels(body, spans) : body),
    [body, spans]
  );

  return (
    <div
      ref={ref}
      data-size="md"
      data-width="medium"
      className="note-reader prose mx-auto break-words px-6 py-6 sm:px-10 sm:py-8"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={spans.length ? [rehypeHighlights] : []}
        components={{
          // Route ```mermaid fences to the diagram renderer; other fences keep
          // the copy-button treatment. Selection highlighting is unaffected —
          // sentinels live in prose text, not code blocks.
          pre: CodeBlock,
          mark: ({ node, children }) => {
            // react-markdown surfaces the hast node's attributes under
            // `node.properties`; the sentinel id lands on `dataAnnId`.
            const props = (node as { properties?: Record<string, unknown> } | undefined)
              ?.properties;
            const id = typeof props?.dataAnnId === "string" ? props.dataAnnId : "";
            // The live selection is amber; persisted comments get a distinct
            // dotted underline so they read as annotations, not the cursor.
            const isSelection = id === CANVAS_SELECTION_ID;
            return (
              <mark
                data-ann-id={id}
                className={
                  isSelection
                    ? "rounded-sm bg-amber-200/70 px-0.5 dark:bg-amber-400/30"
                    : "rounded-sm bg-sky-200/50 px-0.5 underline decoration-sky-500/60 decoration-dotted underline-offset-2 dark:bg-sky-400/20"
                }
              >
                {children}
              </mark>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});

/**
 * HTML preview. We render via iframe srcDoc with a hardened sandbox so the
 * page can't navigate the parent. The selection overlay is plain-text only
 * here (the iframe is sandboxed, so we can't post-process its DOM from the
 * parent); the chip in the composer continues to scope the model's edit.
 */
const HtmlPreview = forwardRef<HTMLIFrameElement, { body: string }>(
  function HtmlPreview({ body }, ref) {
    return (
      <iframe
        ref={ref}
        sandbox="allow-scripts"
        srcDoc={body}
        title="Note preview"
        className="h-full w-full border-0 bg-white"
      />
    );
  }
);

/**
 * Read-only transcript preview for chatSnapshot notes. Selection works
 * (the user can highlight a passage) but writes are blocked at
 * applyCanvasResult — the canvas page surfaces a "Fork as markdown" CTA.
 */
const SnapshotPreview = forwardRef<
  HTMLDivElement,
  { body: string; anchor?: Anchor | null; comments?: HighlightSpan[] }
>(function SnapshotPreview(props, ref) {
  // Snapshots are serialized to markdown by `serializeSnapshot` so we get
  // free reuse of the markdown renderer + highlight overlay.
  return (
    <MarkdownPreview
      ref={ref}
      body={props.body}
      anchor={props.anchor}
      comments={props.comments}
    />
  );
});

export function NotePreview({ kind, body, anchor, comments, readOnly: _readOnly }: NotePreviewProps & {
  /** Forwarded to the renderer that captures selections. */
  proseRef?: React.RefObject<HTMLDivElement | null>;
}) {
  if (kind === "markdown") {
    return <MarkdownPreview body={body} anchor={anchor} comments={comments} />;
  }
  if (kind === "html") {
    return <HtmlPreview body={body} />;
  }
  return <SnapshotPreview body={body} anchor={anchor} comments={comments} />;
}

/**
 * Wrapper that wires a ref to the prose root so the parent's
 * `useSelectionAnchor` hook can read selections. The hook captures via
 * `selectionchange` so it doesn't need a click handler here.
 */
export const NotePreviewWithRef = forwardRef<HTMLDivElement, NotePreviewProps>(
  function NotePreviewWithRef({ kind, body, anchor, comments, readOnly }, ref) {
    if (kind === "markdown") {
      return <MarkdownPreview ref={ref} body={body} anchor={anchor} comments={comments} />;
    }
    if (kind === "snapshot") {
      return <SnapshotPreview ref={ref} body={body} anchor={anchor} comments={comments} />;
    }
    // HTML: the iframe forwards its own ref; the wrapping div carries the
    // outer ref so selection capture targets something tangible, even
    // though the iframe's contents are out of reach from the parent.
    return (
      <div ref={ref} className="h-full w-full">
        <HtmlPreview body={body} />
      </div>
    );
  }
);
