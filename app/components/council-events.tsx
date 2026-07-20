"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Users } from "lucide-react";
import type { ToolEvent } from "@/app/db";
import { cn } from "@/lib/utils";

type Props = {
  events: ToolEvent[];
};

type MemberRoundEntry = {
  memberId: string;
  memberName: string;
  memberModel: string;
  perspective: string;
  round: number;
  /** Final position text (from the matching `tool_result.summary`). May be
   *  undefined while the round is still in flight. */
  position?: string;
  error?: string;
  cached?: boolean;
};

type MemberGroup = {
  memberId: string;
  memberName: string;
  memberModel: string;
  perspective: string;
  /** Sorted by round ascending. */
  rounds: MemberRoundEntry[];
};

const COUNCIL_NAME_RE = /^council:member:([^:]+):r(\d+)$/;

/**
 * Parse `tool_call` / `tool_result` events emitted by `runCouncilWork()` into
 * one entry per (member, round). Pair calls with their matching result by
 * exact name match (the orchestrator emits both with `council:member:{id}:r{n}`).
 * Used by `<MessageBubble>` to render a collapsible per-member disclosure
 * above the synthesized recommendation.
 */
function groupCouncilEvents(events: ToolEvent[]): MemberGroup[] {
  const byKey = new Map<string, MemberRoundEntry>();
  for (const e of events) {
    const m = COUNCIL_NAME_RE.exec(e.name);
    if (!m) continue;
    const memberId = m[1];
    const round = Number(m[2]);
    const key = `${memberId}:r${round}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        memberId,
        memberName: memberId,
        memberModel: "",
        perspective: "",
        round,
      };
      byKey.set(key, entry);
    }
    if (e.kind === "call") {
      const args = e.args ?? {};
      if (typeof args.memberName === "string") entry.memberName = args.memberName;
      if (typeof args.memberModel === "string") entry.memberModel = args.memberModel;
      if (typeof args.perspective === "string") entry.perspective = args.perspective;
      if (args.cached === true) entry.cached = true;
    } else {
      if (typeof e.summary === "string") entry.position = e.summary;
      if (typeof e.error === "string") entry.error = e.error;
    }
  }

  const groupsById = new Map<string, MemberGroup>();
  for (const entry of byKey.values()) {
    let g = groupsById.get(entry.memberId);
    if (!g) {
      g = {
        memberId: entry.memberId,
        memberName: entry.memberName,
        memberModel: entry.memberModel,
        perspective: entry.perspective,
        rounds: [],
      };
      groupsById.set(entry.memberId, g);
    }
    // The most recent round usually has the freshest member metadata.
    if (entry.memberName) g.memberName = entry.memberName;
    if (entry.memberModel) g.memberModel = entry.memberModel;
    if (entry.perspective) g.perspective = entry.perspective;
    g.rounds.push(entry);
  }
  for (const g of groupsById.values()) {
    g.rounds.sort((a, b) => a.round - b.round);
  }
  return Array.from(groupsById.values());
}

export function CouncilEvents({ events }: Props) {
  const groups = useMemo(() => groupCouncilEvents(events), [events]);
  const [open, setOpen] = useState(false);
  const [expandedMembers, setExpandedMembers] = useState<Set<string>>(
    new Set()
  );

  if (groups.length === 0) return null;

  const totalRounds = Math.max(...groups.map((g) => g.rounds.length));
  const completedPositions = groups.reduce(
    (acc, g) => acc + g.rounds.filter((r) => r.position).length,
    0
  );
  const inflight = groups.some((g) =>
    g.rounds.some((r) => !r.position && !r.error)
  );

  const toggleMember = (id: string) => {
    setExpandedMembers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="w-full max-w-[680px] rounded-xl border border-border bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="tap flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="flex items-center gap-2">
          <Users className="h-3.5 w-3.5 text-[var(--color-accent-2)]" />
          <span className="text-xs font-medium">Council</span>
          <span className="text-xs text-muted-foreground">
            {groups.length} member{groups.length === 1 ? "" : "s"} ·{" "}
            {totalRounds} round{totalRounds === 1 ? "" : "s"} ·{" "}
            {completedPositions} position{completedPositions === 1 ? "" : "s"}
            {inflight ? " · in flight" : ""}
          </span>
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>

      {open && (
        <ul className="flex flex-col gap-1 border-t border-border px-2 py-2">
          {groups.map((g) => {
            const expanded = expandedMembers.has(g.memberId);
            const lastPos = [...g.rounds].reverse().find((r) => r.position)
              ?.position;
            const hasError = g.rounds.some((r) => r.error);
            return (
              <li
                key={g.memberId}
                className={cn(
                  "rounded-lg border bg-card",
                  hasError ? "border-destructive/30" : "border-border/60"
                )}
              >
                <button
                  type="button"
                  onClick={() => toggleMember(g.memberId)}
                  aria-expanded={expanded}
                  className="tap flex w-full flex-col items-start gap-0.5 px-2.5 py-1.5 text-left"
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="text-sm font-medium">{g.memberName}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {g.memberModel}
                    </span>
                  </div>
                  {!expanded && lastPos && (
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {lastPos}
                    </span>
                  )}
                </button>
                {expanded && (
                  <div className="flex flex-col gap-2 border-t border-border px-2.5 py-2">
                    {g.perspective && (
                      <div className="rounded bg-muted/50 px-2 py-1 text-[11px] italic text-muted-foreground">
                        {g.perspective}
                      </div>
                    )}
                    {g.rounds.map((r) => (
                      <div key={r.round} className="flex flex-col gap-1">
                        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Round {r.round}
                          {r.cached ? " · cached" : ""}
                          {r.error ? " · error" : ""}
                        </span>
                        {r.position ? (
                          <p className="whitespace-pre-wrap text-xs text-foreground">
                            {r.position}
                          </p>
                        ) : r.error ? (
                          <p className="text-xs text-destructive">{r.error}</p>
                        ) : (
                          <p className="text-xs italic text-muted-foreground">
                            …thinking
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function hasCouncilEvents(events: ToolEvent[] | undefined): boolean {
  if (!events) return false;
  for (const e of events) {
    if (COUNCIL_NAME_RE.test(e.name)) return true;
  }
  return false;
}
