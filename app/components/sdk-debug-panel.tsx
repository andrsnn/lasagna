"use client";

import { useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  Trash2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { clearSdkEvents, useSdkDebugLog, type SdkEvent } from "@/app/lib/sdk-debug-log";

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 3 });
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function preview(val: unknown): string {
  if (val === undefined) return "undefined";
  if (val === null) return "null";
  if (typeof val === "string") return truncate(val, 120);
  try {
    return truncate(JSON.stringify(val), 120);
  } catch {
    return String(val);
  }
}

function fullDump(val: unknown): string {
  if (val === undefined) return "undefined";
  if (val === null) return "null";
  if (typeof val === "string") return val;
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

const TYPE_COLORS: Record<string, string> = {
  query: "text-blue-400",
  fetch: "text-cyan-400",
  "state.get": "text-purple-400",
  "state.set": "text-purple-400",
  "schedule.define": "text-amber-400",
  "schedule.get": "text-amber-400",
  "schedule.run": "text-amber-400",
  log: "text-muted-foreground",
  ready: "text-emerald-400",
  init: "text-emerald-400",
  refresh: "text-emerald-400",
  download: "text-orange-400",
  "open-url": "text-orange-400",
  "clipboard-write": "text-orange-400",
  "params-changed": "text-emerald-400",
  "config-changed": "text-emerald-400",
  "schedule-updated": "text-amber-400",
  "shared.append": "text-pink-400",
  "shared.list": "text-pink-400",
  "shared.delete": "text-pink-400",
};

function EventRow({ event }: { event: SdkEvent }) {
  const [open, setOpen] = useState(false);
  const isRequest = event.direction === "iframe-to-host";
  const typeColor = TYPE_COLORS[event.type] ?? "text-foreground";

  return (
    <li className="rounded border border-border/50 bg-background/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left"
        aria-expanded={open}
      >
        <ChevronRight
          className={
            "h-3 w-3 shrink-0 text-muted-foreground transition-transform " +
            (open ? "rotate-90" : "")
          }
        />
        {isRequest ? (
          <ArrowUpRight className="h-3 w-3 shrink-0 text-blue-400" />
        ) : (
          <ArrowDownLeft className="h-3 w-3 shrink-0 text-emerald-400" />
        )}
        <span className={`shrink-0 font-mono text-[11px] font-semibold ${typeColor}`}>
          {event.type}
        </span>
        {event.response && (
          event.response.ok ? (
            <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
          ) : (
            <XCircle className="h-3 w-3 shrink-0 text-destructive" />
          )
        )}
        {event.durationMs !== undefined && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {event.durationMs < 1000
              ? `${Math.round(event.durationMs)}ms`
              : `${(event.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
          {preview(event.payload)}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
          {formatTime(event.at)}
        </span>
      </button>
      {open && (
        <div className="border-t border-border/40 px-2 py-1.5 text-[11px]">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            Payload
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 px-1.5 py-1 font-mono text-[10px] leading-relaxed text-foreground">
            {fullDump(event.payload)}
          </pre>
          {event.response && (
            <>
              <div className="mb-1 mt-2 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                Response {event.response.ok ? "(ok)" : "(error)"}
              </div>
              <pre
                className={
                  "max-h-40 overflow-auto whitespace-pre-wrap break-all rounded px-1.5 py-1 font-mono text-[10px] leading-relaxed " +
                  (event.response.ok
                    ? "bg-muted/40 text-foreground"
                    : "border border-destructive/30 bg-destructive/5 text-destructive")
                }
              >
                {event.response.ok
                  ? fullDump(event.response.result)
                  : event.response.error ?? "Unknown error"}
              </pre>
            </>
          )}
        </div>
      )}
    </li>
  );
}

const TYPE_GROUPS = [
  { label: "All", filter: null },
  { label: "Query/Fetch", filter: ["query", "fetch"] },
  { label: "State", filter: ["state.get", "state.set"] },
  { label: "Schedule", filter: ["schedule.define", "schedule.get", "schedule.run", "schedule-updated"] },
  { label: "Shared", filter: ["shared.append", "shared.list", "shared.delete"] },
  { label: "Lifecycle", filter: ["ready", "init", "refresh", "params-changed", "config-changed"] },
  { label: "I/O", filter: ["download", "open-url", "clipboard-write"] },
  { label: "Log", filter: ["log"] },
];

export function SdkDebugPanel({ appId }: { appId: string }) {
  const events = useSdkDebugLog(appId);
  const [activeFilter, setActiveFilter] = useState<string[] | null>(null);
  const [activeLabel, setActiveLabel] = useState("All");

  const filtered = activeFilter
    ? events.filter((e) => activeFilter.includes(e.type))
    : events;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card/50 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="font-medium text-foreground">SDK Debug</span>
          <span className="rounded-full bg-muted px-1.5 py-px font-mono text-[10px] tabular-nums text-muted-foreground">
            {events.length}
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => clearSdkEvents(appId)}
          className="h-6 gap-1 px-1.5 text-[10px] text-muted-foreground"
          disabled={events.length === 0}
        >
          <Trash2 className="h-3 w-3" />
          Clear
        </Button>
      </div>

      <div className="flex flex-wrap gap-1">
        {TYPE_GROUPS.map((g) => (
          <button
            key={g.label}
            type="button"
            onClick={() => {
              setActiveFilter(g.filter);
              setActiveLabel(g.label);
            }}
            className={
              "rounded-full px-2 py-0.5 text-[10px] font-medium transition " +
              (activeLabel === g.label
                ? "bg-primary/15 text-primary"
                : "bg-muted text-muted-foreground hover:text-foreground")
            }
          >
            {g.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/30 px-2 py-3 text-center text-[11px] text-muted-foreground">
          {events.length === 0
            ? "No SDK interactions recorded yet. Use the artifact to generate events."
            : "No events match this filter."}
        </div>
      ) : (
        <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {[...filtered].reverse().map((e) => (
            <EventRow key={e.id} event={e} />
          ))}
        </ul>
      )}
    </div>
  );
}
