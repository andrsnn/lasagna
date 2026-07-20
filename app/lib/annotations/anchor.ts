// Selection ↔ markdown anchoring for highlight-to-research annotations.
//
// The user's selection lives in the DOM produced by ReactMarkdown, but the
// annotation is stored against the raw markdown string in `msg.content`. We
// keep both: a (startOffset, endOffset) into the markdown plus a fallback
// `occurrenceIndex` (the nth verbatim match of `selectedText` in the content).
//
// When the rendered selection appears verbatim in the markdown source we
// anchor directly to that substring. When it doesn't - because the selection
// crosses inline markdown syntax (e.g. through `**bold**`, `` `code` ``, or a
// `[link](url)`, where the rendered text omits the syntax characters) - we
// fall back to aligning the rendered DOM text against the source so we can
// still resolve a (wider) source range. The source substring for that range
// is stored as `sourceText` and used for re-anchoring; `selectedText` always
// holds the clean rendered text (what the user sees) for display.

export type Anchor = {
  /** Clean rendered text the user highlighted (for display / prompts). */
  selectedText: string;
  startOffset: number;
  endOffset: number;
  occurrenceIndex: number;
  /**
   * Exact source slice `content.slice(startOffset, endOffset)`. Differs from
   * `selectedText` only when the selection crosses inline markdown syntax.
   * Used as the re-anchor key so a comment survives edits even when its
   * rendered text isn't a verbatim substring of the source. Absent on legacy
   * anchors, where `selectedText` doubles as the key.
   */
  sourceText?: string;
};

/**
 * Minimal structural shape the sentinel/re-anchor helpers need. Both
 * `MessageAnnotation` (research highlights) and `MessageHighlight`
 * (therapist-mode reader highlights) satisfy it.
 */
export type HighlightSpan = Anchor & { id: string };

/**
 * Walk text nodes inside `root` and count characters preceding `target`. Used
 * to disambiguate when `selectedText` appears multiple times in the markdown:
 * we pick the occurrence whose preceding character count in the rendered DOM
 * matches the source most closely.
 */
function rangePreTextLength(root: Node, target: Node, offset: number): number {
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (node === target) return count + offset;
    count += node.nodeValue?.length ?? 0;
    node = walker.nextNode();
  }
  return count;
}

/** Concatenate the text-node contents of `root` in document order — the same
 *  traversal `rangePreTextLength` counts against, so offsets line up. */
function renderedTextOf(root: Node): string {
  let out = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    out += node.nodeValue ?? "";
    node = walker.nextNode();
  }
  return out;
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

/**
 * Map each rendered-text index to a source index. Greedy two-pointer walk:
 * where the characters agree we advance both; where they differ we assume the
 * source char is markdown syntax (`*`, `` ` ``, `[`/`]`, a link URL, …) that
 * the renderer stripped, and skip it. Whitespace matches loosely because
 * markdown collapses runs and turns soft newlines into spaces.
 *
 * Returns an array `map` of length `rendered.length + 1` where `map[i]` is the
 * source index at which rendered char `i` begins (and `map[rendered.length]`
 * is one past the last consumed source char), or null if the rendered text
 * can't be aligned to the source.
 */
function alignRenderedToSource(rendered: string, source: string): number[] | null {
  const map = new Array<number>(rendered.length + 1);
  let s = 0;
  for (let r = 0; r < rendered.length; r++) {
    const rc = rendered[r];
    while (
      s < source.length &&
      source[s] !== rc &&
      !(isWhitespace(rc) && isWhitespace(source[s]))
    ) {
      s++;
    }
    if (s >= source.length) return null;
    map[r] = s;
    s++;
  }
  map[rendered.length] = s;
  return map;
}

/** Build an anchor from concrete source offsets, computing the nth-occurrence
 *  fallback from the given re-anchor `key` (the source substring). */
function anchorFromRange(
  content: string,
  selectedText: string,
  sourceText: string,
  start: number,
  end: number
): Anchor | null {
  if (end <= start) return null;
  let occ = 0;
  let occurrenceIndex = -1;
  let cursor = 0;
  while (true) {
    const idx = content.indexOf(sourceText, cursor);
    if (idx === -1) break;
    if (idx === start) {
      occurrenceIndex = occ;
      break;
    }
    occ += 1;
    cursor = idx + 1;
  }
  if (occurrenceIndex === -1) return null;
  return { selectedText, sourceText, startOffset: start, endOffset: end, occurrenceIndex };
}

/**
 * Resolve the current browser selection into a markdown anchor, or return
 * null if the selection is empty, spans outside `proseRoot`, or can't be
 * aligned to the markdown content.
 */
export function selectionToAnchor(
  proseRoot: HTMLElement,
  content: string
): Anchor | null {
  if (typeof window === "undefined") return null;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!proseRoot.contains(range.startContainer) || !proseRoot.contains(range.endContainer)) {
    return null;
  }
  const selectedText = sel.toString();
  const trimmed = selectedText.trim();
  if (trimmed.length < 2) return null;

  const renderedPre = rangePreTextLength(proseRoot, range.startContainer, range.startOffset);

  // Fast path: the rendered selection is a verbatim substring of the source
  // (no inline syntax crossed). Pick the occurrence whose pre-text length in
  // `content` is closest to `renderedPre` — the source offset is ≥ renderedPre
  // because the source carries extra syntax tokens.
  if (content.includes(selectedText)) {
    let bestStart = -1;
    let bestOccurrence = 0;
    let bestDiff = Infinity;
    let cursor = 0;
    let occ = 0;
    while (true) {
      const idx = content.indexOf(selectedText, cursor);
      if (idx === -1) break;
      const diff = Math.abs(idx - renderedPre);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestStart = idx;
        bestOccurrence = occ;
      }
      occ += 1;
      cursor = idx + 1;
    }
    if (bestStart !== -1) {
      return {
        selectedText,
        sourceText: selectedText,
        startOffset: bestStart,
        endOffset: bestStart + selectedText.length,
        occurrenceIndex: bestOccurrence,
      };
    }
  }

  // Fallback: the selection crosses inline markdown syntax, so the rendered
  // text doesn't appear verbatim in the source. Align the rendered DOM text
  // to the source and read off the wider source range for the selection.
  const rendered = renderedTextOf(proseRoot);
  const renderedEnd = rangePreTextLength(proseRoot, range.endContainer, range.endOffset);
  if (renderedEnd <= renderedPre || renderedEnd > rendered.length) return null;
  const map = alignRenderedToSource(rendered, content);
  if (!map) return null;
  // Source range spans from where the first selected char begins to one past
  // where the last selected char ends — this trims trailing syntax (e.g. a
  // closing `**`) that would otherwise sit just before the next rendered char.
  const start = map[renderedPre];
  const end = map[renderedEnd - 1] + 1;
  const sourceText = content.slice(start, end);
  if (!sourceText) return null;
  // `selectedText` from `sel.toString()` can differ from the aligned rendered
  // slice (block boundaries insert newlines); use the aligned slice so display
  // matches what we anchored.
  const displayText = rendered.slice(renderedPre, renderedEnd);
  return anchorFromRange(content, displayText, sourceText, start, end);
}

// Private-use sentinels used to mark annotated ranges inside the markdown
// string before it goes through ReactMarkdown. A small rehype plugin
// (rehype-highlights.ts) replaces sentinel pairs with `<mark>` elements.
export const ANN_OPEN = "\uE000";
export const ANN_CLOSE = "\uE001";
export const ANN_SEP = "\uE002";

/** Find the live offset of `ann` in (possibly mutated) `content`. The
 *  re-anchor key is the source substring (`sourceText`) when present -
 *  it appears verbatim in the source even for selections that crossed inline
 *  markdown syntax - falling back to `selectedText` for legacy anchors. */
function reanchor(content: string, ann: HighlightSpan): { start: number; end: number } | null {
  const key = ann.sourceText ?? ann.selectedText;
  // Fast path: the original offsets still point at the key.
  if (content.slice(ann.startOffset, ann.endOffset) === key) {
    return { start: ann.startOffset, end: ann.endOffset };
  }
  // Fallback: nth-occurrence search.
  let cursor = 0;
  let occ = 0;
  while (true) {
    const idx = content.indexOf(key, cursor);
    if (idx === -1) return null;
    if (occ === ann.occurrenceIndex) {
      return { start: idx, end: idx + key.length };
    }
    occ += 1;
    cursor = idx + 1;
  }
}

/**
 * Wrap each annotated range in sentinels: `{ANN_OPEN}{annId}{ANN_SEP}{text}{ANN_CLOSE}`.
 * Non-overlapping. If two annotations overlap, the later one wins for the
 * overlap region (we drop overlapping anchors silently — the chat doesn't
 * currently let the user create overlaps anyway).
 */
export function injectSentinels(
  content: string,
  annotations: ReadonlyArray<HighlightSpan>
): string {
  if (!annotations.length) return content;
  type Range = { start: number; end: number; ann: HighlightSpan };
  const ranges: Range[] = [];
  for (const ann of annotations) {
    const r = reanchor(content, ann);
    if (!r) continue;
    ranges.push({ ...r, ann });
  }
  if (!ranges.length) return content;
  ranges.sort((a, b) => a.start - b.start);

  // Drop overlaps: keep the first, skip any later range whose start lies
  // inside the previous range's end.
  const kept: Range[] = [];
  let lastEnd = -1;
  for (const r of ranges) {
    if (r.start < lastEnd) continue;
    kept.push(r);
    lastEnd = r.end;
  }

  let out = "";
  let cursor = 0;
  for (const r of kept) {
    out += content.slice(cursor, r.start);
    out += ANN_OPEN + r.ann.id + ANN_SEP + content.slice(r.start, r.end) + ANN_CLOSE;
    cursor = r.end;
  }
  out += content.slice(cursor);
  return out;
}

/**
 * Resolve spans to concrete non-overlapping `[start, end)` ranges in
 * `content`, sorted ascending. For rendering paths that don't go through
 * markdown/rehype (e.g. user messages shown as plain text), where the caller
 * slices `content` and wraps each range in a `<mark>` itself. Same overlap
 * policy as injectSentinels: first range wins.
 */
export function resolveHighlightRanges(
  content: string,
  spans: ReadonlyArray<HighlightSpan>
): { id: string; start: number; end: number }[] {
  const ranges: { id: string; start: number; end: number }[] = [];
  for (const span of spans) {
    const r = reanchor(content, span);
    if (r) ranges.push({ id: span.id, ...r });
  }
  ranges.sort((a, b) => a.start - b.start);
  const kept: typeof ranges = [];
  let lastEnd = -1;
  for (const r of ranges) {
    if (r.start < lastEnd) continue;
    kept.push(r);
    lastEnd = r.end;
  }
  return kept;
}
