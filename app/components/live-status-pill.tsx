"use client";

import { useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolEvent } from "@/app/db";
import { toolPresentation } from "@/app/lib/tool-labels";
import { ActivityRow } from "./activity-row";

type LiveProgress = {
  phase: "sending" | "thinking" | "tool" | "streaming";
  toolName?: string;
};

/**
 * Single soft chip that replaces the per-message stack of monospace tool-event
 * pills. While a turn is streaming it shows the current action ("Reading
 * App.tsx…") and rerenders as new events arrive. Once the turn is done it
 * either:
 *  - Calls `onOpenDetails` on tap to jump to a Details tab (designer page), or
 *  - When no `onOpenDetails` is provided (free-form chat), expands inline into
 *    a list of per-call ActivityRows so the user can still inspect args/results.
 */
export function LiveStatusPill({
  events,
  live,
  onOpenDetails,
}: {
  events: ToolEvent[];
  live?: LiveProgress;
  onOpenDetails?: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (live?.toolName) {
    // Only show the in-flight pill when a tool is actually running. The other
    // live phases (sending/thinking/streaming) are already covered by the
    // sticky StreamingBar at the top and, for thinking, by the ThoughtsPanel
    // below — rendering a phase-verb pill here just stacks a third "Thinking…"
    // between them.
    const lastCall = [...events]
      .reverse()
      .find(
        (e): e is Extract<ToolEvent, { kind: "call" }> =>
          e.kind === "call" && e.name === live.toolName
      );
    const args = lastCall?.args ?? {};
    const verb = toolPresentation(live.toolName, args).verb;
    return (
      <div className="inline-flex max-w-full items-center gap-2 self-start overflow-hidden py-1 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        <span className="truncate">{verb}…</span>
      </div>
    );
  }

  const callCount = events.filter((e) => e.kind === "call").length;
  if (callCount === 0) return null;

  const hasError = events.some((e) => e.kind === "result" && !!e.error);
  // Inline expansion only kicks in when the host didn't wire up a Details tab
  // (e.g. free-form chat). In designer mode we keep the existing behavior of
  // routing to the side-panel via onOpenDetails.
  const inlineExpand = !onOpenDetails;
  const onClick = inlineExpand ? () => setOpen((v) => !v) : onOpenDetails;
  const pairs = inlineExpand && open ? pairCallsAndResults(events) : [];

  return (
    <div className="flex max-w-full flex-col gap-1.5 self-start">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "tap inline-flex max-w-full items-center gap-1.5 self-start overflow-hidden",
          "py-1 text-xs text-muted-foreground transition hover:text-foreground"
        )}
        aria-expanded={inlineExpand ? open : undefined}
        aria-label={`View activity details — ${callCount} action${callCount === 1 ? "" : "s"}`}
      >
        {hasError ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
        ) : (
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
        )}
        <span className="shrink-0">
          {callCount === 1 ? "1 action" : `${callCount} actions`}
        </span>
        {inlineExpand ? (
          <ChevronDown
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground transition",
              open && "rotate-180"
            )}
          />
        ) : (
          <>
            <span className="shrink-0 text-muted-foreground">· View details</span>
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          </>
        )}
      </button>
      {inlineExpand && open && pairs.length > 0 && (
        <div className="flex w-full max-w-md flex-col gap-1.5">
          {pairs.map((p, i) => (
            <ActivityRow key={i} call={p.call} result={p.result} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Pair each `kind: "call"` with its nearest matching `kind: "result"` of the
 * same name that follows it in time. Calls without a matching result are kept
 * (rendered as still-running). Mirrors the helper in activity-feed.tsx but
 * scoped to a single message's events.
 */
function pairCallsAndResults(
  events: ToolEvent[]
): Array<{
  call: Extract<ToolEvent, { kind: "call" }>;
  result?: Extract<ToolEvent, { kind: "result" }>;
}> {
  const calls = events.filter(
    (e): e is Extract<ToolEvent, { kind: "call" }> => e.kind === "call"
  );
  const results = events.filter(
    (e): e is Extract<ToolEvent, { kind: "result" }> => e.kind === "result"
  );
  const used = new Set<number>();
  return calls.map((call) => {
    for (let r = 0; r < results.length; r++) {
      if (used.has(r)) continue;
      const res = results[r];
      if (res.name === call.name && res.at >= call.at) {
        used.add(r);
        return { call, result: res };
      }
    }
    return { call };
  });
}
