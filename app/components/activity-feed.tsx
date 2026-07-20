"use client";

import { useEffect, useMemo, useRef } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StoredMessage, ToolEvent } from "@/app/db";
import { ActivityRow } from "./activity-row";

type AssistantTurn = {
  assistantId: string;
  prompt: string;
  createdAt: number;
  pairs: Array<{
    call: Extract<ToolEvent, { kind: "call" }>;
    result?: Extract<ToolEvent, { kind: "result" }>;
  }>;
};

/**
 * Per-turn cards listing every tool call the assistant made on a given
 * message. Each card is anchored as <section id={"activity-" + msg.id}>; when
 * the parent page sets `highlightMessageId` we scroll the matching anchor
 * into view.
 */
export function ActivityFeed({
  messages,
  highlightMessageId,
}: {
  messages: StoredMessage[];
  highlightMessageId?: string | null;
}) {
  const turns = useMemo(() => buildTurns(messages), [messages]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!highlightMessageId) return;
    const root = containerRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>(
      `[data-activity-id="${cssEscape(highlightMessageId)}"]`
    );
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [highlightMessageId, turns.length]);

  if (turns.length === 0) {
    return <ActivityEmptyState />;
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-3">
      {turns.map((turn) => {
        const isHighlighted = highlightMessageId === turn.assistantId;
        return (
          <section
            key={turn.assistantId}
            id={`activity-${turn.assistantId}`}
            data-activity-id={turn.assistantId}
            className={cn(
              "hairline rounded-lg p-2.5 transition",
              isHighlighted ? "border-primary/40 ring-2 ring-primary/15" : "border-border"
            )}
          >
            <header className="mb-2 flex items-baseline gap-2 px-1 text-[11px] text-muted-foreground">
              <span className="shrink-0 tabular-nums">{relativeTime(turn.createdAt)}</span>
              {turn.prompt && (
                <span className="truncate text-foreground/70">· “{turn.prompt}”</span>
              )}
            </header>
            <div className="flex flex-col gap-1.5">
              {turn.pairs.map((p, i) => (
                <ActivityRow key={`${turn.assistantId}-${i}`} call={p.call} result={p.result} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ActivityEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <div className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-secondary/60">
        <Sparkles className="h-4 w-4 text-primary" strokeWidth={2} />
      </div>
      <div className="text-sm font-medium text-foreground">No activity yet</div>
      <div className="max-w-[26ch] text-xs text-muted-foreground">
        When the assistant reads, edits, or searches things, the steps appear here.
      </div>
    </div>
  );
}

function buildTurns(messages: StoredMessage[]): AssistantTurn[] {
  const turns: AssistantTurn[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.events || m.events.length === 0) continue;
    const prevUser = findPrevUser(messages, i);
    turns.push({
      assistantId: m.id,
      prompt: prevUser ? truncate(prevUser.content, 140) : "",
      createdAt: m.createdAt,
      pairs: pairCallsAndResults(m.events),
    });
  }
  return turns;
}

function findPrevUser(messages: StoredMessage[], assistantIdx: number): StoredMessage | null {
  for (let j = assistantIdx - 1; j >= 0; j--) {
    if (messages[j].role === "user") return messages[j];
  }
  return null;
}

/**
 * Pair each `kind: "call"` with its nearest matching `kind: "result"` of the
 * same name that follows it in time. Calls without a matching result are kept
 * (rendered as still-running).
 */
function pairCallsAndResults(
  events: ToolEvent[]
): Array<{
  call: Extract<ToolEvent, { kind: "call" }>;
  result?: Extract<ToolEvent, { kind: "result" }>;
}> {
  const calls = events.filter((e) => e.kind === "call") as Array<
    Extract<ToolEvent, { kind: "call" }>
  >;
  const results = events.filter((e) => e.kind === "result") as Array<
    Extract<ToolEvent, { kind: "result" }>
  >;
  const used = new Set<number>();
  return calls.map((call) => {
    let matchedIdx = -1;
    for (let r = 0; r < results.length; r++) {
      if (used.has(r)) continue;
      const res = results[r];
      if (res.name === call.name && res.at >= call.at) {
        matchedIdx = r;
        break;
      }
    }
    if (matchedIdx >= 0) {
      used.add(matchedIdx);
      return { call, result: results[matchedIdx] };
    }
    return { call };
  });
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1).trimEnd() + "…";
}

function relativeTime(then: number): string {
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 30) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}
