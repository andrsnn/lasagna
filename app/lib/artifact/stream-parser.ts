// Streaming state machine that splits an assistant content stream into
// "prose" deltas and "artifact body" deltas based on <artifact>…</artifact>
// sentinel tags. Lives on the SERVER so the wire protocol the client sees is
// already structured — the client never grep's prose itself.
//
// Modeled on Claude's <antArtifact> protocol: the LLM is told to wrap the
// document in tags; the parser detects them as bytes arrive and routes the
// inside to a separate channel. Cross-chunk safety: it preserves a small tail
// of the buffer that might be a partial opening/closing tag.

export const ARTIFACT_OPEN = "<artifact>";
export const ARTIFACT_CLOSE = "</artifact>";

// Models occasionally wrap the artifact tags in a markdown code fence
// (```html\n<artifact>…</artifact>\n```), which previously caused the entire
// fenced block to be treated as prose and never rendered. We strip an
// immediately-adjacent fence opener from the prose tail right before the
// <artifact> tag, and a fence closer from the buffer tail right after the
// </artifact> tag. The patterns are intentionally narrow: only fences that
// directly hug the artifact tag are eaten, so unrelated ``` code blocks in
// prose stay intact.
const FENCE_BEFORE_OPEN = /\n?[ \t]*```[a-zA-Z0-9_-]*[ \t]*\n?$/;
const FENCE_AFTER_CLOSE = /^[ \t]*\n?[ \t]*```[ \t]*\n?/;

type Mode = "prose" | "artifact" | "post";

export type StreamHandlers = {
  /** Plain prose text outside of any artifact tag. */
  onProse: (text: string) => void;
  /** Fired the first time we see <artifact>. */
  onArtifactOpen: () => void;
  /** Each chunk of html that has streamed inside the tags. */
  onArtifactDelta: (text: string) => void;
  /** Fired when </artifact> is seen, with the full assembled html. */
  onArtifactClose: (html: string) => void;
};

/** Snapshot of parser state, safe to JSON-stringify. Used for cross-worker
 *  handoff in chained chat generations. */
export type ArtifactStreamParserState = {
  mode: Mode;
  buffer: string;
  artifact: string;
};

export class ArtifactStreamParser {
  // Field access is package-private (no `private`) so serialize/deserialize
  // can read/write without going through getters.
  mode: Mode = "prose";
  buffer = "";
  artifact = "";
  constructor(private h: StreamHandlers) {}

  serialize(): ArtifactStreamParserState {
    return { mode: this.mode, buffer: this.buffer, artifact: this.artifact };
  }

  static deserialize(
    state: ArtifactStreamParserState,
    h: StreamHandlers
  ): ArtifactStreamParser {
    const p = new ArtifactStreamParser(h);
    p.mode = state.mode;
    p.buffer = state.buffer;
    p.artifact = state.artifact;
    return p;
  }

  /** Feed a chunk of raw assistant content. */
  push(chunk: string): void {
    this.buffer += chunk;
    while (this.step()) {
      // step() returns true when it consumed at least one tag transition.
    }
  }

  /** Call when the upstream stream finishes; flushes residual buffer. */
  end(): void {
    if (this.mode === "prose" && this.buffer) {
      this.h.onProse(this.buffer);
      this.buffer = "";
    } else if (this.mode === "artifact" && this.buffer) {
      // Closing tag never arrived. Flush remainder as artifact body and close.
      this.artifact += this.buffer;
      this.h.onArtifactDelta(this.buffer);
      this.buffer = "";
      this.h.onArtifactClose(this.artifact);
      this.mode = "post";
    } else if (this.mode === "post" && this.buffer) {
      // Trailing chatter after </artifact>: treat as prose so it isn't lost.
      this.h.onProse(this.buffer);
      this.buffer = "";
    }
  }

  private step(): boolean {
    if (this.mode === "prose") {
      const idx = this.buffer.indexOf(ARTIFACT_OPEN);
      if (idx !== -1) {
        const before = this.buffer.slice(0, idx).replace(FENCE_BEFORE_OPEN, "");
        if (before) this.h.onProse(before);
        this.buffer = this.buffer.slice(idx + ARTIFACT_OPEN.length);
        this.mode = "artifact";
        this.h.onArtifactOpen();
        return true;
      }
      // No opener yet. Hold back only the trailing bytes that could still
      // grow into `<artifact>` (optionally wrapped in a code fence — see
      // FENCE_BEFORE_OPEN). The previous version unconditionally reserved
      // 25 bytes regardless of what those bytes were, which made the
      // streaming bubble visibly truncate mid-word — e.g. "to make sur" —
      // whenever the upstream token stream paused. For prose tails that
      // contain neither `<` nor backtick (the overwhelmingly common case),
      // emit everything.
      const FENCE_TAIL_RESERVE = 16;
      const reserve = ARTIFACT_OPEN.length - 1 + FENCE_TAIL_RESERVE;
      const buf = this.buffer;
      let safeLen = buf.length;

      // A `<` is only ambiguous if it has fewer than ARTIFACT_OPEN.length
      // characters after it; otherwise the indexOf check above has already
      // proven it isn't the start of `<artifact>`.
      const ltWindowStart = Math.max(0, buf.length - (ARTIFACT_OPEN.length - 1));
      const ltIdx = buf.indexOf("<", ltWindowStart);
      if (ltIdx !== -1) {
        // The `<` might be preceded by an in-progress fence opener
        // (FENCE_BEFORE_OPEN). We can't strip that retroactively once it's
        // emitted as prose, so reserve the fence budget ahead of the `<`.
        safeLen = Math.max(0, ltIdx - FENCE_TAIL_RESERVE);
      } else {
        // A standalone backtick near the end could be the start of a fence
        // opener; reserve from the backtick and walk back past any
        // `\n?[ \t]*` that the fence regex would also consume.
        const btWindowStart = Math.max(0, buf.length - reserve);
        const btIdx = buf.indexOf("`", btWindowStart);
        if (btIdx !== -1) {
          let p = btIdx;
          while (p > 0 && (buf[p - 1] === " " || buf[p - 1] === "\t")) p--;
          if (p > 0 && buf[p - 1] === "\n") p--;
          safeLen = Math.max(0, p);
        } else if (buf.endsWith("\n")) {
          // A trailing newline could be the start of a fence-before-open
          // pattern (\n```lang\n) in the next chunk. The fence regex starts
          // with `\n?`, so any \n at the tail must be held until the next
          // chunk arrives — otherwise the fence's leading newline would
          // already be in the prose stream and we couldn't strip it
          // retroactively when `<artifact>` finally appears.
          safeLen = buf.length - 1;
        }
      }

      if (safeLen > 0) {
        const safe = buf.slice(0, safeLen);
        this.h.onProse(safe);
        this.buffer = buf.slice(safeLen);
      }
      return false;
    }

    if (this.mode === "artifact") {
      const idx = this.buffer.indexOf(ARTIFACT_CLOSE);
      if (idx !== -1) {
        const inside = this.buffer.slice(0, idx);
        if (inside) {
          this.artifact += inside;
          this.h.onArtifactDelta(inside);
        }
        this.buffer = this.buffer
          .slice(idx + ARTIFACT_CLOSE.length)
          .replace(FENCE_AFTER_CLOSE, "");
        const finalHtml = this.artifact.replace(/^\s*\n/, "").replace(/\s+$/, "");
        this.h.onArtifactClose(finalHtml);
        this.mode = "post";
        return true;
      }
      const safeLen = Math.max(0, this.buffer.length - (ARTIFACT_CLOSE.length - 1));
      if (safeLen > 0) {
        const safe = this.buffer.slice(0, safeLen);
        this.artifact += safe;
        this.h.onArtifactDelta(safe);
        this.buffer = this.buffer.slice(safeLen);
      }
      return false;
    }

    // mode === "post": drop or treat as prose.
    if (this.buffer) {
      this.h.onProse(this.buffer);
      this.buffer = "";
    }
    return false;
  }
}
