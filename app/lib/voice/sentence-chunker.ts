// Incremental sentence chunker for streaming text-to-speech. Feed it model
// deltas as they arrive; it emits speakable chunks at sentence boundaries so
// the first audio can start while the model is still generating.
//
// Tuning notes:
// - The first chunk is emitted as early as possible (short min length) to
//   minimize time-to-first-audio; later chunks are larger so the synthesized
//   speech doesn't sound choppy from too-frequent voice restarts.
// - Chunks never split inside an unclosed ``` fence - the voice system
//   prompt discourages code blocks, but if one appears we hold it intact so
//   stripForSpeech can collapse it to "(code block)" in one piece.

export type SentenceChunker = {
  /** Append streamed text; returns any chunks that became complete. */
  push(delta: string): string[];
  /** Flush whatever remains (call once when the stream is done). */
  flush(): string[];
};

type Options = {
  /** Min length before the FIRST chunk may be emitted. Small = fast start. */
  firstChunkMinChars?: number;
  /** Min length for subsequent chunks. */
  minChars?: number;
  /** Force a split (at whitespace) past this length even without punctuation. */
  maxChars?: number;
};

// End-of-sentence punctuation (optionally followed by closing quotes or
// brackets) then whitespace, or a run of newlines. The boundary includes the
// trailing whitespace so the remainder starts clean.
const BOUNDARY_RE = /([.!?…]+["')\]”’]*\s+)|(\n+)/g;

function insideFence(s: string): boolean {
  const m = s.match(/```/g);
  return !!m && m.length % 2 === 1;
}

// First boundary whose END lands at or after `from` and does not cut a
// ``` fence in half, or -1.
function findBoundary(s: string, from: number): number {
  BOUNDARY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BOUNDARY_RE.exec(s)) !== null) {
    const end = m.index + m[0].length;
    if (end < from || m.index === 0) continue;
    if (insideFence(s.slice(0, end))) continue;
    return end;
  }
  return -1;
}

export function createSentenceChunker(opts: Options = {}): SentenceChunker {
  const firstMin = opts.firstChunkMinChars ?? 24;
  const laterMin = opts.minChars ?? 120;
  const max = opts.maxChars ?? 360;

  let buf = "";
  let emittedAny = false;

  function extract(final: boolean): string[] {
    const out: string[] = [];
    while (true) {
      const min = emittedAny ? laterMin : firstMin;
      if (!final && buf.length < min) break;
      if (!final && insideFence(buf)) break;

      let cut = -1;
      const boundary = findBoundary(buf, Math.min(min, buf.length));
      if (boundary !== -1 && (final || boundary < buf.length)) {
        // Only take a boundary that isn't the ragged end of the stream -
        // trailing "some text.\n" mid-stream may still be growing a list
        // item, but the sentence before it is safe to speak.
        cut = boundary;
      } else if (buf.length > max && !insideFence(buf)) {
        const ws = buf.lastIndexOf(" ", max);
        cut = ws > min ? ws : max;
      } else if (final) {
        cut = buf.length;
      }

      if (cut <= 0) break;
      const chunk = buf.slice(0, cut).trim();
      buf = buf.slice(cut);
      if (chunk) {
        out.push(chunk);
        emittedAny = true;
      }
      if (buf.length === 0) break;
    }
    return out;
  }

  return {
    push(delta: string): string[] {
      if (!delta) return [];
      buf += delta;
      return extract(false);
    },
    flush(): string[] {
      const rest = extract(true);
      buf = "";
      return rest;
    },
  };
}
