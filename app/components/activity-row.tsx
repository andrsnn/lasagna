"use client";

import { useState } from "react";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolEvent } from "@/app/db";
import { toolPresentation } from "@/app/lib/tool-labels";

/**
 * One row inside an activity card. Shows a friendly past-tense label with an
 * icon and a status dot. The whole row is a button that toggles an inline
 * disclosure of the raw call args + result summary/error — there's no
 * separate "show raw" toggle, expansion is on demand per row.
 */
export function ActivityRow({
  call,
  result,
}: {
  call: Extract<ToolEvent, { kind: "call" }>;
  result?: Extract<ToolEvent, { kind: "result" }>;
}) {
  const [open, setOpen] = useState(false);
  const { past, detail, icon: Icon } = toolPresentation(call.name, call.args ?? {});
  const status: "running" | "ok" | "error" = !result
    ? "running"
    : result.error
      ? "error"
      : "ok";

  return (
    <div className="rounded-lg border border-border bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "tap flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs",
          "transition hover:bg-muted/50"
        )}
        aria-expanded={open}
      >
        <span
          className={cn(
            "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
            "bg-secondary/60 text-foreground/80"
          )}
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={2} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-foreground">{past}</span>
          {detail && (
            <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
          )}
        </span>
        <StatusDot status={status} />
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground transition",
            open && "rotate-180"
          )}
          strokeWidth={2}
        />
      </button>
      {open && (
        <div className="border-t border-border bg-muted/40 px-2.5 py-2">
          <RawBlock label="args" value={formatArgs(call.args)} />
          {result?.summary && <RawBlock label="result" value={result.summary} />}
          {result?.error && <RawBlock label="error" value={result.error} tone="error" />}
          {!result && (
            <div className="text-[11px] text-muted-foreground">Still running…</div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: "running" | "ok" | "error" }) {
  if (status === "running") {
    return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />;
  }
  if (status === "error") {
    return (
      <span
        aria-label="Error"
        className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-700"
      >
        <X className="h-2.5 w-2.5" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      aria-label="Done"
      className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-700"
    >
      <Check className="h-2.5 w-2.5" strokeWidth={3} />
    </span>
  );
}

function RawBlock({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "error";
}) {
  return (
    <div className="mb-1.5 last:mb-0">
      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <pre
        className={cn(
          "max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-card px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/90",
          tone === "error" && "text-destructive"
        )}
      >
        {value}
      </pre>
    </div>
  );
}

function formatArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return "(no arguments)";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
