"use client";

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";

// Live framer reasoning, rendered while a framing card is loading. The framer
// streams its thinking (and coarse progress milestones like "Searching the
// web…") through the resume endpoint; this shows it verbatim so the user can
// watch the framer work instead of staring at a blank spinner wondering if
// it's stuck. Before any text arrives it shows a minimal "Thinking…" line so
// the gap between handshake and first token still reads as alive.

const MAX_HEIGHT_PX = 160;

export function FramingThinking({ text }: { text?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const trimmed = (text ?? "").trim();

  // Keep the latest reasoning in view as it streams (only when already near the
  // bottom, so a user who scrolls up to read isn't yanked back down).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [trimmed]);

  if (!trimmed) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Thinking…</span>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="my-2 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground"
      style={{ maxHeight: MAX_HEIGHT_PX }}
      aria-live="polite"
      aria-label="Framer reasoning"
    >
      {trimmed}
    </div>
  );
}
