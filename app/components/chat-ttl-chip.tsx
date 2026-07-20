"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock, InfinityIcon, Pause, Play, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { StoredChat } from "@/app/db";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const TTL_PRESETS: { label: string; ms: number }[] = [
  { label: "1 hour", ms: HOUR_MS },
  { label: "1 day", ms: DAY_MS },
  { label: "7 days", ms: 7 * DAY_MS },
  { label: "30 days", ms: 30 * DAY_MS },
];

export type ChatTtlState =
  | { kind: "off" }
  | { kind: "running"; expiresAt: number; durationMs?: number }
  | { kind: "paused"; remainingMs: number; durationMs?: number };

export function readChatTtl(chat: Pick<StoredChat, "ttlExpiresAt" | "ttlPausedRemainingMs" | "ttlDurationMs">): ChatTtlState {
  if (chat.ttlExpiresAt) {
    return { kind: "running", expiresAt: chat.ttlExpiresAt, durationMs: chat.ttlDurationMs };
  }
  if (chat.ttlPausedRemainingMs && chat.ttlPausedRemainingMs > 0) {
    return { kind: "paused", remainingMs: chat.ttlPausedRemainingMs, durationMs: chat.ttlDurationMs };
  }
  return { kind: "off" };
}

/** Patch fields written to a chat for each user action. */
export function ttlPatch(action:
  | { kind: "off" }
  | { kind: "start"; durationMs: number }
  | { kind: "pause"; remainingMs: number; durationMs?: number }
  | { kind: "resume"; remainingMs: number; durationMs?: number }
): Pick<StoredChat, "ttlExpiresAt" | "ttlPausedRemainingMs" | "ttlDurationMs"> {
  if (action.kind === "off") {
    return { ttlExpiresAt: undefined, ttlPausedRemainingMs: undefined, ttlDurationMs: undefined };
  }
  if (action.kind === "start") {
    return {
      ttlExpiresAt: Date.now() + action.durationMs,
      ttlPausedRemainingMs: undefined,
      ttlDurationMs: action.durationMs,
    };
  }
  if (action.kind === "pause") {
    return {
      ttlExpiresAt: undefined,
      ttlPausedRemainingMs: Math.max(0, action.remainingMs),
      ttlDurationMs: action.durationMs,
    };
  }
  // resume
  return {
    ttlExpiresAt: Date.now() + Math.max(0, action.remainingMs),
    ttlPausedRemainingMs: undefined,
    ttlDurationMs: action.durationMs,
  };
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return "0s";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h`;
  const days = Math.round(hr / 24);
  return `${days}d`;
}

/** Subscribe to "now" with adaptive cadence so the chip stays fresh
 *  without re-rendering every second when the deadline is days away. */
function useNow(state: ChatTtlState): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.kind !== "running") return;
    const remaining = state.expiresAt - Date.now();
    const interval = remaining < 60_000 ? 1000 : remaining < HOUR_MS ? 30_000 : 60_000;
    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [state]);
  return now;
}

export function ChatTtlChip({
  chat,
  onChange,
  compact = false,
}: {
  chat: Pick<StoredChat, "ttlExpiresAt" | "ttlPausedRemainingMs" | "ttlDurationMs">;
  onChange: (patch: Pick<StoredChat, "ttlExpiresAt" | "ttlPausedRemainingMs" | "ttlDurationMs">) => void | Promise<void>;
  compact?: boolean;
}) {
  const state = useMemo(() => readChatTtl(chat), [chat]);
  const now = useNow(state);

  const remainingMs = useMemo(() => {
    if (state.kind === "running") return Math.max(0, state.expiresAt - now);
    if (state.kind === "paused") return state.remainingMs;
    return 0;
  }, [state, now]);

  const label = useMemo(() => {
    if (state.kind === "off") return compact ? null : "No expiry";
    if (state.kind === "paused") return `Paused · ${formatRemaining(remainingMs)}`;
    return formatRemaining(remainingMs);
  }, [state.kind, remainingMs, compact]);

  // In compact mode (list rows) keep the "off" state visually quiet so it
  // doesn't compete with the row's title/preview, but still click-targetable.
  const tone =
    state.kind === "off"
      ? compact
        ? "border-transparent bg-transparent text-muted-foreground/50 hover:bg-secondary/60 hover:text-muted-foreground"
        : "border-border bg-secondary/60 text-muted-foreground"
      : state.kind === "paused"
        ? "border-border bg-secondary text-muted-foreground"
        : remainingMs < HOUR_MS
          ? "border-[#e6b577] bg-[#fbe2c4] text-[#8a4a14] dark:bg-[#3a2410] dark:text-[#fbe2c4] dark:border-[#8a4a14]"
          : "border-border bg-secondary text-foreground";

  const Icon =
    state.kind === "off" ? InfinityIcon : state.kind === "paused" ? Pause : Clock;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={
          state.kind === "off"
            ? "Set expiration"
            : state.kind === "paused"
              ? `Expiration paused with ${formatRemaining(remainingMs)} remaining`
              : `Expires in ${formatRemaining(remainingMs)}`
        }
        title={
          state.kind === "running"
            ? `Expires ${new Date(state.expiresAt).toLocaleString()}`
            : state.kind === "paused"
              ? "Expiration paused — click to adjust"
              : "Click to set an expiration"
        }
        onClick={(e) => {
          // List rows wrap the row in a Link; stop the navigation.
          e.preventDefault();
          e.stopPropagation();
        }}
        className={cn(
          "tap inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium tabular-nums transition hover:brightness-95",
          tone
        )}
      >
        <Icon className="h-3 w-3" />
        {label && <span>{label}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[11px] text-muted-foreground">
            Auto-archive after
          </DropdownMenuLabel>
          {TTL_PRESETS.map((preset) => {
            const active = state.kind !== "off" && state.durationMs === preset.ms;
            return (
              <DropdownMenuItem
                key={preset.label}
                onClick={() => void onChange(ttlPatch({ kind: "start", durationMs: preset.ms }))}
                className={cn("flex items-center justify-between", active && "bg-accent/30")}
              >
                <span className="inline-flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5" />
                  {preset.label}
                </span>
                {active && state.kind === "running" && (
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {formatRemaining(remainingMs)} left
                  </span>
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {state.kind === "running" && (
          <DropdownMenuItem
            onClick={() =>
              void onChange(
                ttlPatch({
                  kind: "pause",
                  remainingMs,
                  durationMs: state.durationMs,
                })
              )
            }
          >
            <Pause className="h-3.5 w-3.5" />
            Pause
          </DropdownMenuItem>
        )}
        {state.kind === "paused" && (
          <DropdownMenuItem
            onClick={() =>
              void onChange(
                ttlPatch({
                  kind: "resume",
                  remainingMs: state.remainingMs,
                  durationMs: state.durationMs,
                })
              )
            }
          >
            <Play className="h-3.5 w-3.5" />
            Resume
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => void onChange(ttlPatch({ kind: "off" }))}
          className={cn(state.kind === "off" && "bg-accent/30")}
        >
          <InfinityIcon className="h-3.5 w-3.5" />
          Never expire
        </DropdownMenuItem>
        {state.kind !== "off" && (
          <DropdownMenuItem
            onClick={() => void onChange(ttlPatch({ kind: "off" }))}
          >
            <X className="h-3.5 w-3.5" />
            Clear timer
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
