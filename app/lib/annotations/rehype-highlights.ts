// Rehype plugin: replace sentinel-bounded text spans in the hast tree with
// `<mark data-ann-id="…">` element nodes. ReactMarkdown then renders those
// via the `components.mark` override in chat.tsx.
//
// The sentinels are injected by `injectSentinels()` (or the canvas selection
// overlay) into the markdown source before it is parsed. `ANN_OPEN{id}ANN_SEP`
// is always contiguous in the source, so the open marker + id + separator land
// in a single hast text node. The matching `ANN_CLOSE`, however, can fall in a
// *later* text node when the highlighted range crosses a block boundary (e.g. a
// canvas selection spanning a paragraph break). We carry the open state across
// nodes so each segment renders as its own `<mark>` instead of leaking raw
// sentinel characters as visible text, and we defensively strip any stray
// sentinel chars so a malformed span never shows up on screen.

import { ANN_OPEN, ANN_CLOSE, ANN_SEP } from "./anchor";

type HastChild = {
  type: "text" | "element" | "comment" | "raw";
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastChild[];
};

type HastRoot = { type: "root"; children: HastChild[] };

type WalkState = { openId: string | null };

function markNode(id: string, text: string): HastChild {
  return {
    type: "element",
    tagName: "mark",
    properties: { dataAnnId: id },
    children: [{ type: "text", value: text }],
  };
}

/** Remove any orphan sentinel characters so they never render verbatim. */
function stripSentinels(text: string): string {
  return text.split(ANN_OPEN).join("").split(ANN_CLOSE).join("").split(ANN_SEP).join("");
}

function plainText(text: string): HastChild[] {
  const cleaned = stripSentinels(text);
  return cleaned ? [{ type: "text", value: cleaned }] : [];
}

function splitTextNode(value: string, state: WalkState): HastChild[] | null {
  // Nothing to do: no open span carried in, and no markers in this node.
  if (state.openId === null && !value.includes(ANN_OPEN) && !value.includes(ANN_CLOSE)) {
    return null;
  }

  const out: HastChild[] = [];
  let i = 0;

  // Continue a span opened in an earlier text node until its ANN_CLOSE (which
  // may or may not be in this node).
  if (state.openId !== null) {
    const close = value.indexOf(ANN_CLOSE);
    if (close === -1) {
      if (value.length) out.push(markNode(state.openId, stripSentinels(value)));
      return out; // still open; consumes the whole node
    }
    if (close > 0) out.push(markNode(state.openId, stripSentinels(value.slice(0, close))));
    state.openId = null;
    i = close + ANN_CLOSE.length;
  }

  while (i < value.length) {
    const open = value.indexOf(ANN_OPEN, i);
    if (open === -1) {
      out.push(...plainText(value.slice(i)));
      break;
    }
    if (open > i) out.push(...plainText(value.slice(i, open)));

    const sep = value.indexOf(ANN_SEP, open + ANN_OPEN.length);
    if (sep === -1) {
      // Malformed (no separator) — drop the marker, keep the rest as text.
      out.push(...plainText(value.slice(open + ANN_OPEN.length)));
      break;
    }
    const annId = value.slice(open + ANN_OPEN.length, sep);
    const close = value.indexOf(ANN_CLOSE, sep + ANN_SEP.length);
    if (close === -1) {
      // The span continues into a later node; mark the rest and carry state.
      const inner = stripSentinels(value.slice(sep + ANN_SEP.length));
      if (inner) out.push(markNode(annId, inner));
      state.openId = annId;
      break;
    }
    out.push(markNode(annId, stripSentinels(value.slice(sep + ANN_SEP.length, close))));
    i = close + ANN_CLOSE.length;
  }

  return out;
}

function walk(node: HastChild | HastRoot, state: WalkState): void {
  if (!("children" in node) || !node.children) return;
  const next: HastChild[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      const split = splitTextNode(child.value ?? "", state);
      if (split) {
        next.push(...split);
        continue;
      }
    } else if (child.type === "element") {
      walk(child, state);
    }
    next.push(child);
  }
  node.children = next;
}

export function rehypeHighlights() {
  return (tree: HastRoot) => {
    walk(tree, { openId: null });
  };
}
