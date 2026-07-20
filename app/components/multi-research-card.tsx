"use client";

// Multi Research card — one card owns a whole round of parallel research.
//
// Lifecycle (self-driving, mirrors the structured-research viewer but produces
// prose reports instead of a table):
//   drafting → the model splits the user's ask into N prompts (/api/research/multi/draft)
//   review   → the user edits / revises / adds / removes the prompts
//   running  → "Run" fans out N independent report runs (/api/research/report/run),
//              each with its OWN streamId, polled via /api/query/resume — so they
//              run in parallel and each resumes independently after a reload
//   done     → every report has settled; the full markdown reports render inline
//
// The finished report markdown (with inline Sources) is emitted into the model's
// context by `wireContentFor` in chat.tsx, so follow-up questions can draw on the
// full reports — they are not redacted to a summary.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertCircle,
  Bookmark,
  BookmarkCheck,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  GitBranch,
  Loader2,
  Plus,
  RotateCw,
  Send,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { MultiResearchPayload, MultiResearchReport } from "@/app/db";
import { cn } from "@/lib/utils";

type Props = {
  messageId: string;
  payload: MultiResearchPayload;
  /** Rendered transcript of the chat before this card — grounds drafting/revise. */
  transcript: string;
  /** Default research model for the runs. */
  model: string;
  /** Persist the payload (create + in-place mutation). Debounced-safe. */
  onPersist: (messageId: string, next: MultiResearchPayload) => void;
  /** Save one finished report to Notes; resolves to the created note id. */
  onSaveToNote: (report: MultiResearchReport) => Promise<string | undefined>;
};

const LABELS = "ABCDEFGH";

function newReportId(): string {
  return `mr_${crypto.randomUUID()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Count distinct source URLs in a report (inline links + the Sources list). */
function countSources(md?: string): number {
  if (!md) return 0;
  const urls = md.match(/https?:\/\/[^\s)\]]+/g) ?? [];
  return new Set(urls.map((u) => u.replace(/[.,;]+$/, ""))).size;
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function MultiResearchCard({
  messageId,
  payload,
  transcript,
  model,
  onPersist,
  onSaveToNote,
}: Props) {
  const [state, setState] = useState<MultiResearchPayload>(payload);
  // Kept in sync synchronously (before setState) so async callbacks fired in the
  // same tick — kicking N runs, patching each report — never read a stale copy.
  const stateRef = useRef(state);
  stateRef.current = state;

  const update = useCallback(
    (next: MultiResearchPayload) => {
      stateRef.current = next;
      setState(next);
      onPersist(messageId, next);
    },
    [messageId, onPersist]
  );

  const patchReport = useCallback(
    (id: string, patch: Partial<MultiResearchReport>) => {
      const cur = stateRef.current;
      update({
        ...cur,
        reports: cur.reports.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      });
    },
    [update]
  );

  const draftKicked = useRef(false);
  const resumeKicked = useRef(false);
  const pollers = useRef<Set<string>>(new Set());

  // --- drafting -----------------------------------------------------------
  const draft = useCallback(async () => {
    const cur = stateRef.current;
    try {
      const res = await fetch("/api/research/multi/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: cur.intent, transcript, model }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        reports?: { title?: string; prompt?: string; depth?: "standard" | "deep" }[];
        rationale?: string;
        model?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `Failed to draft (${res.status})`);
      const reports: MultiResearchReport[] = (data.reports ?? [])
        .filter((r) => (r.prompt ?? "").trim().length > 0)
        .map((r, i) => ({
          id: newReportId(),
          title: (r.title ?? "").trim() || `Report ${i + 1}`,
          prompt: (r.prompt ?? "").trim(),
          depth: r.depth === "deep" ? "deep" : "standard",
          status: "draft" as const,
        }));
      if (reports.length === 0) throw new Error("No prompts came back — try again.");
      update({
        ...stateRef.current,
        stage: "review",
        reports,
        rationale: data.rationale,
        model: data.model ?? model,
        draftError: undefined,
      });
    } catch (err) {
      update({
        ...stateRef.current,
        draftError: err instanceof Error ? err.message : String(err),
      });
    }
  }, [transcript, model, update]);

  // --- running ------------------------------------------------------------
  const maybeFinish = useCallback(() => {
    const cur = stateRef.current;
    if (cur.stage !== "running") return;
    const done = cur.reports.every(
      (r) => r.status === "done" || r.status === "error" || r.status === "stopped"
    );
    if (done) update({ ...cur, stage: "done" });
  }, [update]);

  const poll = useCallback(
    async (reportId: string, streamId: string) => {
      if (pollers.current.has(reportId)) return;
      pollers.current.add(reportId);
      try {
        // The resume endpoint long-polls up to ~5min then 504s while the run is
        // still going; re-issue on 504 until the `result` event lands.
        while (true) {
          let res: Response;
          try {
            res = await fetch(`/api/query/resume/${encodeURIComponent(streamId)}`);
          } catch {
            await sleep(2500); // transient network drop — keep waiting
            continue;
          }
          if (res.status === 504) continue;
          const data = (await res.json().catch(() => ({}))) as {
            text?: string;
            model?: string;
            error?: string;
            stopped?: boolean;
          };
          if (res.ok && typeof data.text === "string" && data.text.trim().length > 0) {
            patchReport(reportId, {
              status: "done",
              report: data.text,
              model: data.model,
              streamId: undefined,
            });
          } else if (res.status === 499 || data.stopped) {
            patchReport(reportId, { status: "stopped", streamId: undefined });
          } else if (res.ok && typeof data.text === "string") {
            // The run "succeeded" but the synthesizer returned no prose. A blank
            // report would settle as a bare "Done" header with no body - the
            // user sees an invisible, unrecoverable card (the "multi research
            // comes back empty" bug). Treat it as a failure so the report shows
            // its error state + a Retry instead of silently swallowing itself.
            patchReport(reportId, {
              status: "error",
              error: "This report came back empty - no findings were produced. Retry to run it again.",
              streamId: undefined,
            });
          } else {
            patchReport(reportId, {
              status: "error",
              error: data.error ?? `Run failed (${res.status})`,
              streamId: undefined,
            });
          }
          break;
        }
      } finally {
        pollers.current.delete(reportId);
        maybeFinish();
      }
    },
    [patchReport, maybeFinish]
  );

  const kickReport = useCallback(
    async (report: MultiResearchReport) => {
      try {
        const res = await fetch("/api/research/report/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: report.prompt,
            title: report.title,
            depth: report.depth,
            model: stateRef.current.model ?? model,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          streamId?: string;
          error?: string;
        };
        if (!res.ok || !data.streamId) {
          throw new Error(data.error ?? `Failed to start (${res.status})`);
        }
        patchReport(report.id, { streamId: data.streamId, startedAt: Date.now() });
        void poll(report.id, data.streamId);
      } catch (err) {
        patchReport(report.id, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        maybeFinish();
      }
    },
    [poll, model, patchReport, maybeFinish]
  );

  const runAll = useCallback(() => {
    const cur = stateRef.current;
    if (cur.reports.length === 0) return;
    if (cur.reports.some((r) => r.prompt.trim().length === 0)) return;
    const running = cur.reports.map((r) => ({
      ...r,
      status: "running" as const,
      startedAt: Date.now(),
      report: undefined,
      error: undefined,
      streamId: undefined,
    }));
    update({ ...cur, stage: "running", reports: running });
    for (const r of running) void kickReport(r);
  }, [update, kickReport]);

  const retryReport = useCallback(
    (id: string) => {
      const cur = stateRef.current;
      const report = cur.reports.find((r) => r.id === id);
      if (!report) return;
      const running = { ...report, status: "running" as const, startedAt: Date.now(), report: undefined, error: undefined, streamId: undefined };
      update({
        ...cur,
        stage: "running",
        reports: cur.reports.map((r) => (r.id === id ? running : r)),
      });
      void kickReport(running);
    },
    [update, kickReport]
  );

  const stopReport = useCallback(
    (id: string) => {
      const cur = stateRef.current;
      const report = cur.reports.find((r) => r.id === id);
      const streamId = report?.streamId;
      pollers.current.delete(id);
      patchReport(id, { status: "stopped", streamId: undefined });
      if (streamId) {
        void fetch(`/api/research/structured/stop/${encodeURIComponent(streamId)}`, {
          method: "POST",
        }).catch(() => {
          /* already stopped client-side; the server flag is a bonus */
        });
      }
      maybeFinish();
    },
    [patchReport, maybeFinish]
  );

  const stopAll = useCallback(() => {
    const cur = stateRef.current;
    for (const r of cur.reports) {
      if (r.status === "running") stopReport(r.id);
    }
  }, [stopReport]);

  // Manual escape hatch: force the round to "done" so the composer unlocks.
  // Covers the case where every report has settled but the stage flag never
  // flipped (a reload/retry race left no live poller to call maybeFinish), and
  // lets the user bail out of a genuinely-hung run without stopping reports
  // that may still be streaming — their results still land and render.
  const forceDone = useCallback(() => {
    const cur = stateRef.current;
    if (cur.stage !== "running") return;
    update({ ...cur, stage: "done" });
  }, [update]);

  // --- review editing -----------------------------------------------------
  const setReportField = useCallback(
    (id: string, patch: Partial<MultiResearchReport>) => patchReport(id, patch),
    [patchReport]
  );

  const addReport = useCallback(() => {
    const cur = stateRef.current;
    if (cur.reports.length >= LABELS.length) return;
    update({
      ...cur,
      reports: [
        ...cur.reports,
        { id: newReportId(), title: "New report", prompt: "", depth: "deep", status: "draft" },
      ],
    });
  }, [update]);

  const removeReport = useCallback(
    (id: string) => {
      const cur = stateRef.current;
      if (cur.reports.length <= 1) return;
      update({ ...cur, reports: cur.reports.filter((r) => r.id !== id) });
    },
    [update]
  );

  // Per-report "Ask AI to revise" — a small inline instruction box.
  const [reviseOpen, setReviseOpen] = useState<string | null>(null);
  const [reviseText, setReviseText] = useState("");
  const [revisingId, setRevisingId] = useState<string | null>(null);

  const revise = useCallback(
    async (id: string, instruction: string) => {
      const cur = stateRef.current;
      const report = cur.reports.find((r) => r.id === id);
      if (!report) return;
      setRevisingId(id);
      try {
        const res = await fetch("/api/research/multi/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: cur.model ?? model,
            revise: { title: report.title, prompt: report.prompt, instruction },
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          title?: string;
          prompt?: string;
          depth?: "standard" | "deep";
          error?: string;
        };
        if (!res.ok || !data.prompt) throw new Error(data.error ?? "Revise failed");
        patchReport(id, {
          title: data.title?.trim() || report.title,
          prompt: data.prompt.trim(),
          depth: data.depth === "deep" ? "deep" : data.depth === "standard" ? "standard" : report.depth,
        });
        setReviseOpen(null);
        setReviseText("");
      } catch {
        /* leave the box open so the user can retry; error surfaced inline below */
      } finally {
        setRevisingId(null);
      }
    },
    [model, patchReport]
  );

  // --- mount: kick drafting, or resume in-flight runs ---------------------
  useEffect(() => {
    const cur = stateRef.current;
    if (cur.stage === "drafting" && cur.reports.length === 0 && !draftKicked.current) {
      draftKicked.current = true;
      void draft();
    }
    if (cur.stage === "running" && !resumeKicked.current) {
      resumeKicked.current = true;
      for (const r of cur.reports) {
        if (r.status !== "running") continue;
        if (r.streamId) void poll(r.id, r.streamId);
        else void kickReport(r); // kick never landed before reload — restart it
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Self-heal: if the round is marked "running" but every report has already
  // settled, flip to "done" so the composer unlocks without user action. This
  // catches the stuck state where a report finished (or was retried) but no
  // live poller remained to fire maybeFinish — e.g. after a reload.
  useEffect(() => {
    maybeFinish();
  }, [state.stage, state.reports, maybeFinish]);

  // --- liveness: elapsed timer + coarse progress while running ------------
  const anyRunning = state.stage === "running" && state.reports.some((r) => r.status === "running");
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const [progressById, setProgressById] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!anyRunning) return;
    let cancelled = false;
    const fetchProgress = async () => {
      const cur = stateRef.current;
      await Promise.all(
        cur.reports
          .filter((r) => r.status === "running" && r.streamId)
          .map(async (r) => {
            try {
              const res = await fetch(
                `/api/research/structured/progress/${encodeURIComponent(r.streamId!)}`
              );
              const d = (await res.json().catch(() => ({}))) as { stage?: string };
              if (!cancelled && typeof d.stage === "string") {
                setProgressById((p) => ({ ...p, [r.id]: d.stage as string }));
              }
            } catch {
              /* progress is best-effort */
            }
          })
      );
    };
    const t1 = setInterval(() => setNowTick(Date.now()), 1000);
    const t2 = setInterval(fetchProgress, 3500);
    void fetchProgress();
    return () => {
      cancelled = true;
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [anyRunning]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const [savingId, setSavingId] = useState<string | null>(null);
  const saveToNote = useCallback(
    async (report: MultiResearchReport) => {
      if (savingId || report.savedNoteId) return;
      setSavingId(report.id);
      try {
        const noteId = await onSaveToNote(report);
        if (noteId) patchReport(report.id, { savedNoteId: noteId });
      } finally {
        setSavingId(null);
      }
    },
    [savingId, onSaveToNote, patchReport]
  );

  const reportCount = state.reports.length;
  const runLabel = reportCount === 2 ? "Run both" : `Run all ${reportCount}`;
  const canRun =
    reportCount > 0 && state.reports.every((r) => r.prompt.trim().length > 0);

  const headerSubtitle = useMemo(() => {
    switch (state.stage) {
      case "drafting":
        return "Drafting a research prompt for each thread…";
      case "review":
        return state.rationale || "Review or tweak each prompt, then run them together.";
      case "running":
        return "Researching in parallel — the chat is locked until every report finishes.";
      case "done":
        return "Full reports (with sources) are in context — ask a follow-up about any of them.";
    }
  }, [state.stage, state.rationale]);

  return (
    <div className="hairline w-full rounded-lg border-[color-mix(in_oklab,var(--color-accent-2)_30%,transparent)] p-4">
      {/* header */}
      <div className="mb-3 flex items-start gap-2">
        {state.stage === "drafting" || anyRunning ? (
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--color-accent-2)]" />
        ) : (
          <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent-2)]" />
        )}
        <div className="flex flex-col">
          <span className="text-sm font-medium">
            Multi Research
            {reportCount > 0 && (
              <span className="text-muted-foreground">
                {" "}
                · {reportCount} parallel report{reportCount > 1 ? "s" : ""}
              </span>
            )}
          </span>
          <span className="text-xs text-muted-foreground">{headerSubtitle}</span>
        </div>
      </div>

      {/* drafting */}
      {state.stage === "drafting" && (
        <div className="flex flex-col gap-2">
          {state.draftError ? (
            <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <span className="flex items-center gap-2 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5" /> {state.draftError}
              </span>
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    update({ ...stateRef.current, draftError: undefined });
                    void draft();
                  }}
                >
                  <RotateCw className="h-3.5 w-3.5" /> Retry drafting
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 text-[var(--color-accent-2)]" />
              Reading the chat and splitting “{state.intent}” into parallel prompts…
            </div>
          )}
        </div>
      )}

      {/* review — editable prompts */}
      {state.stage === "review" && (
        <div className="flex flex-col gap-2.5">
          {state.reports.map((r, i) => (
            <div key={r.id} className="rounded-lg border border-border bg-card p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[color-mix(in_oklab,var(--color-accent-2)_18%,transparent)] text-[11px] font-bold text-[var(--color-accent-2)]">
                  {LABELS[i]}
                </span>
                <input
                  value={r.title}
                  onChange={(e) => setReportField(r.id, { title: e.target.value })}
                  aria-label={`Report ${LABELS[i]} title`}
                  className="min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground"
                  placeholder="Report title"
                />
                <button
                  type="button"
                  onClick={() =>
                    setReportField(r.id, { depth: r.depth === "deep" ? "standard" : "deep" })
                  }
                  className="tap flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground transition hover:text-foreground"
                  title="Toggle research depth"
                >
                  <Clock className="h-3 w-3" />
                  {r.depth === "deep" ? "Deep" : "Standard"}
                </button>
                {state.reports.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeReport(r.id)}
                    aria-label={`Remove report ${LABELS[i]}`}
                    className="tap text-muted-foreground transition hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <Textarea
                value={r.prompt}
                onChange={(e) => setReportField(r.id, { prompt: e.target.value })}
                aria-label={`Prompt for report ${LABELS[i]}`}
                placeholder="Describe what this report should research…"
                className="min-h-[92px] text-sm"
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setReviseText("");
                    setReviseOpen(reviseOpen === r.id ? null : r.id);
                  }}
                  className="tap inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_oklab,var(--color-accent-2)_35%,transparent)] px-2.5 py-1 text-[11px] text-[var(--color-accent-2)] transition hover:bg-[color-mix(in_oklab,var(--color-accent-2)_10%,transparent)]"
                >
                  <Sparkles className="h-3 w-3" /> Ask AI to revise
                </button>
              </div>
              {reviseOpen === r.id && (
                <div className="mt-2 flex flex-col gap-2 rounded-md border border-border/70 bg-muted/20 p-2">
                  <Textarea
                    value={reviseText}
                    onChange={(e) => setReviseText(e.target.value)}
                    placeholder="How should I change this prompt? (e.g. focus on US market, add competitor pricing)"
                    className="min-h-[52px] text-xs"
                    disabled={revisingId === r.id}
                  />
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setReviseOpen(null);
                        setReviseText("");
                      }}
                      disabled={revisingId === r.id}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => void revise(r.id, reviseText.trim())}
                      disabled={revisingId === r.id || reviseText.trim().length === 0}
                    >
                      {revisingId === r.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      Revise
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}

          <div className="mt-1 flex items-center justify-between gap-2 border-t border-border pt-3">
            <button
              type="button"
              onClick={addReport}
              disabled={state.reports.length >= LABELS.length}
              className="tap inline-flex items-center gap-1.5 text-[11px] text-muted-foreground transition hover:text-foreground disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" /> Add report
            </button>
            <Button variant="default" size="sm" onClick={runAll} disabled={!canRun}>
              <Send className="h-3.5 w-3.5" />
              {runLabel}
            </Button>
          </div>
        </div>
      )}

      {/* running / done — report cards */}
      {(state.stage === "running" || state.stage === "done") && (
        <div className="flex flex-col gap-2.5">
          {state.reports.map((r, i) => {
            const sources = countSources(r.report);
            const isExpanded = expanded.has(r.id);
            const elapsed = r.startedAt ? formatElapsed(nowTick - r.startedAt) : null;
            // A finished report whose body is empty/whitespace has no renderable
            // content. Route it to a visible "came back empty" fallback (below)
            // instead of the report body, so it can't settle as an invisible
            // "Done" card - and so already-persisted empty runs stay recoverable.
            const hasReport = !!r.report && r.report.trim().length > 0;
            return (
              <div key={r.id} className="overflow-hidden rounded-lg border border-border bg-card">
                <div className="flex items-center gap-2.5 border-b border-border/60 px-3 py-2.5">
                  <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[color-mix(in_oklab,var(--color-accent-2)_18%,transparent)] text-[11px] font-bold text-[var(--color-accent-2)]">
                    {LABELS[i]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Report · Multi Research
                    </div>
                    <div className="truncate text-sm font-medium text-foreground">{r.title}</div>
                  </div>
                  {r.status === "running" && (
                    <span className="flex items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,var(--color-accent)_12%,transparent)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--color-accent)]">
                      <Loader2 className="h-3 w-3 animate-spin" /> Researching
                    </span>
                  )}
                  {r.status === "done" && (
                    <span className="flex items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,var(--color-accent-2)_14%,transparent)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--color-accent-2)]">
                      <Check className="h-3 w-3" /> Done
                    </span>
                  )}
                  {r.status === "error" && (
                    <span className="flex items-center gap-1.5 rounded-full bg-destructive/10 px-2 py-0.5 text-[10.5px] font-semibold text-destructive">
                      <AlertCircle className="h-3 w-3" /> Failed
                    </span>
                  )}
                  {r.status === "stopped" && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-semibold text-muted-foreground">
                      Stopped
                    </span>
                  )}
                </div>

                {/* body */}
                {r.status === "running" && (
                  <div className="px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        {progressById[r.id] ?? "Planning the research…"}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {elapsed}
                      </span>
                    </div>
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--color-accent)]" />
                    </div>
                    <div className="mt-2 flex justify-end">
                      <Button variant="ghost" size="sm" onClick={() => stopReport(r.id)}>
                        <Square className="h-3 w-3 fill-current" /> Stop
                      </Button>
                    </div>
                  </div>
                )}

                {r.status === "done" && hasReport && (
                  <>
                    <div
                      className={cn(
                        "prose prose-sm relative max-w-none px-3 py-3 dark:prose-invert",
                        !isExpanded && "max-h-52 overflow-hidden"
                      )}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{r.report}</ReactMarkdown>
                      {!isExpanded && (
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" />
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border/60 px-3 py-2.5 text-[11px] text-muted-foreground">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(r.id)}
                        className="tap inline-flex items-center gap-1.5 font-semibold text-[var(--color-accent-2)]"
                      >
                        {isExpanded ? (
                          <>
                            <ChevronUp className="h-3.5 w-3.5" /> Collapse
                          </>
                        ) : (
                          <>
                            <ChevronDown className="h-3.5 w-3.5" /> Expand full report
                          </>
                        )}
                      </button>
                      {sources > 0 && (
                        <span>
                          {sources} source{sources > 1 ? "s" : ""}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => void saveToNote(r)}
                        disabled={!!r.savedNoteId || savingId === r.id}
                        className="tap ml-auto inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 transition hover:text-foreground disabled:opacity-70"
                      >
                        {r.savedNoteId ? (
                          <>
                            <BookmarkCheck className="h-3.5 w-3.5 text-[var(--color-accent-2)]" /> Saved
                          </>
                        ) : savingId === r.id ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
                          </>
                        ) : (
                          <>
                            <Bookmark className="h-3.5 w-3.5" /> Save to Notes
                          </>
                        )}
                      </button>
                    </div>
                  </>
                )}

                {r.status === "done" && !hasReport && (
                  <div className="flex items-center justify-between gap-2 px-3 py-3">
                    <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                      This report came back empty - no findings were produced.
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => retryReport(r.id)}>
                      <RotateCw className="h-3.5 w-3.5" /> Re-run
                    </Button>
                  </div>
                )}

                {r.status === "error" && (
                  <div className="flex items-center justify-between gap-2 px-3 py-3">
                    <span className="min-w-0 flex-1 truncate text-xs text-destructive">
                      {r.error ?? "Research failed."}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => retryReport(r.id)}>
                      <RotateCw className="h-3.5 w-3.5" /> Retry
                    </Button>
                  </div>
                )}

                {r.status === "stopped" && (
                  <div className="flex items-center justify-between gap-2 px-3 py-3">
                    <span className="text-xs text-muted-foreground">Stopped before finishing.</span>
                    <Button variant="ghost" size="sm" onClick={() => retryReport(r.id)}>
                      <RotateCw className="h-3.5 w-3.5" /> Re-run
                    </Button>
                  </div>
                )}
              </div>
            );
          })}

          {state.stage === "running" && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              <span className="text-[11px] text-muted-foreground">
                {anyRunning
                  ? "Reply unlocks when every report finishes."
                  : "Every report has finished."}
              </span>
              <div className="flex items-center gap-1.5">
                {anyRunning && (
                  <Button variant="ghost" size="sm" onClick={stopAll}>
                    <Square className="h-3 w-3 fill-current" /> Stop all
                  </Button>
                )}
                <Button
                  variant={anyRunning ? "ghost" : "default"}
                  size="sm"
                  onClick={forceDone}
                  title="Mark this round done and unlock the chat"
                >
                  <Check className="h-3.5 w-3.5" /> Back to chat
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
