"use client";

// Tiny hook that wraps `selectionToAnchor` from app/lib/annotations/anchor.ts
// so the canvas preview can capture the user's highlighted span on mouseup /
// touchend. The caller owns the captured anchor (passes it back to <Chat>
// via the `selectionAnchor` prop) and decides when to clear it.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  selectionToAnchor,
  type Anchor,
} from "@/app/lib/annotations/anchor";

export type UseSelectionAnchor = {
  /** ref the consumer attaches to the prose root (markdown or HTML body). */
  rootRef: React.RefObject<HTMLElement | null>;
  /** Latest captured anchor; null when the selection is empty / invalid. */
  anchor: Anchor | null;
  /** Imperatively clear the captured anchor (e.g. after the user sent the message). */
  clear: () => void;
  /** Toast-style error surface when a selection couldn't be anchored
   *  (typically: the highlight crossed markdown syntax so the rendered text
   *  doesn't appear verbatim in `body`). Caller renders it in the UI. */
  error: string | null;
  /** True while a non-collapsed native selection is live inside the prose
   *  root (i.e. the user is actively dragging/holding a selection there).
   *  The caller MUST suppress the amber selection-overlay `<mark>` while this
   *  is true: re-rendering the prose to inject the mark mid-drag detaches the
   *  browser's selection endpoints, so the next `selectionchange` reads a
   *  shifted range and the highlight jumps to the line above. Let the native
   *  selection show during the drag; the overlay takes over once it settles. */
  isSelecting: boolean;
};

/**
 * Capture the user's text selection inside `rootRef` and resolve it against
 * `body`. Re-runs on `selectionchange` (with a debounce) so the chip in the
 * composer reflects the live selection, and clears the moment the user
 * collapses the selection.
 */
export function useSelectionAnchor<T extends HTMLElement>(
  body: string
): UseSelectionAnchor & { rootRef: React.RefObject<T | null> } {
  const rootRef = useRef<T | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);

  const recompute = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || sel.rangeCount === 0) {
      setAnchor(null);
      setError(null);
      setIsSelecting(false);
      return;
    }
    if (sel.isCollapsed) {
      // The selection is no longer live in the prose, so the overlay <mark>
      // is safe to show again.
      setIsSelecting(false);
      // Only treat a collapse as "user dismissed the highlight" when the caret
      // landed inside the prose root. Focus moving to the chat textarea (or
      // any input elsewhere on the page) also collapses the document
      // selection — we must keep the anchor so the user can act on it.
      const node = sel.anchorNode;
      if (node && root.contains(node)) {
        setAnchor(null);
        setError(null);
      }
      return;
    }
    // Only react if the selection is inside our root — selections elsewhere
    // on the page shouldn't pin a passage.
    const range = sel.getRangeAt(0);
    if (
      !root.contains(range.startContainer) ||
      !root.contains(range.endContainer)
    ) {
      setIsSelecting(false);
      return;
    }
    // A non-collapsed selection is live inside the prose: flag it so the
    // caller suppresses the overlay <mark> until the drag settles (injecting
    // it now would detach the selection and make the highlight jump).
    setIsSelecting(true);
    const next = selectionToAnchor(root, body);
    if (!next) {
      // The most common reason: the selection crossed markdown syntax
      // (e.g. through "**bold**") so the rendered text doesn't appear
      // verbatim in the source. We surface a hint; the user can adjust.
      setAnchor(null);
      setError("Highlight a passage that's part of the body text — selections that cross markdown syntax can't be anchored.");
      return;
    }
    setAnchor(next);
    setError(null);
  }, [body]);

  // `selectionchange` is the only event that fires reliably across
  // mouse/touch/keyboard selections. Debounce so a drag-to-select doesn't
  // re-resolve on every micro-step.
  useEffect(() => {
    if (typeof document === "undefined") return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (t) clearTimeout(t);
      t = setTimeout(recompute, 80);
    };
    document.addEventListener("selectionchange", handler);
    return () => {
      document.removeEventListener("selectionchange", handler);
      if (t) clearTimeout(t);
    };
  }, [recompute]);

  const clear = useCallback(() => {
    setAnchor(null);
    setError(null);
    if (typeof window !== "undefined") window.getSelection()?.removeAllRanges();
  }, []);

  return { rootRef, anchor, clear, error, isSelecting };
}
