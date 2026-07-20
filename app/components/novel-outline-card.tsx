"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Check,
  Search as SearchIcon,
  Send,
  Sparkles,
  Plus,
  Trash2,
  TriangleAlert,
  X,
  ChevronDown,
  ChevronUp,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  NovelOutlineData,
  NovelOutlineEditPayload,
  NovelOutlineProgress,
} from "@/app/db";
import { cn } from "@/lib/utils";

type Props = {
  /** Stable id of the outline-edit message — used by the parent's callbacks
   *  to identify which row to mutate. */
  messageId: string;
  payload: NovelOutlineEditPayload;
  /** True after "Generate novel" has been clicked. The card flips to a
   *  read-only summary state and links to the assistant message below. */
  launched: boolean;
  /** Live progress snapshot from the parent's poll of
   *  /api/novel/outline/progress/{streamId}. Only meaningful while
   *  outlining/revising is true; null/undefined when the work is done or
   *  the poll hasn't completed its first round yet. */
  progress?: NovelOutlineProgress;
  /** Persist outline edits as the user types. Parent throttles writes. */
  onChange: (messageId: string, next: NovelOutlineData) => void;
  /** "Generate novel" — kick off the chapter loop with the edited outline. */
  onGenerate: (messageId: string, outline: NovelOutlineData) => void;
  /** "Re-outline with feedback" — post the edited outline + free-text
   *  feedback back to /api/novel/outline; the parent replaces this card's
   *  outline with the revised one when the response arrives. */
  onReoutline: (
    messageId: string,
    outline: NovelOutlineData,
    feedback: string
  ) => void;
  /** Cancel an in-flight outline. Set only while outlining/revising — the
   *  card renders a Cancel/Dismiss control that aborts the resume + progress
   *  polls and drops the placeholder row from state + IndexedDB. Without
   *  this, a stuck server-side waitUntil leaves the user staring at an
   *  un-cancellable "Outlining…" forever. */
  onCancel?: (messageId: string) => void;
};

/** Past N seconds since the last server-side phase event we treat the
 *  producer as a likely zombie (Vercel typically reaps waitUntil past
 *  ~120s; allow generous headroom for slow research). Surfaces a "looks
 *  stuck" warning + suggests cancelling. */
const STALL_WARN_MS = 90_000;

function newChapterId(existing: string[]): string {
  // Find the highest "cN" suffix already in use and pick the next one.
  // Beats already taken by an out-of-pattern id (e.g. a user renamed "c3"
  // to "intro") are skipped — we just want a unique id, not a perfectly
  // sequential one.
  let n = existing.length + 1;
  while (existing.includes(`c${n}`)) n += 1;
  return `c${n}`;
}

export function NovelOutlineCard({
  messageId,
  payload,
  launched,
  progress,
  onChange,
  onGenerate,
  onReoutline,
  onCancel,
}: Props) {
  // Initial outlining state: there's no outline to edit yet, just empty
  // strings. Showing the disabled empty form here is hostile — the user has
  // no idea anything is happening, can't escape, and feels broken. Render a
  // dedicated activity-timeline view instead and only flip to the editable
  // form once the outline lands. (Revisions DO have a prior outline to
  // preserve in-place so we keep the inline-disabled treatment for those.)
  if (!launched && payload.outlining === true) {
    return (
      <OutliningView
        messageId={messageId}
        progress={progress}
        isRevision={false}
        onCancel={onCancel}
      />
    );
  }

  const [outline, setOutline] = useState<NovelOutlineData>(payload.outline);
  const [feedback, setFeedback] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);
  const [showResearch, setShowResearch] = useState(false);

  const disabled =
    launched || payload.revising === true || payload.outlining === true;

  const update = (next: NovelOutlineData) => {
    setOutline(next);
    onChange(messageId, next);
  };

  const setField = <K extends keyof NovelOutlineData>(
    key: K,
    value: NovelOutlineData[K]
  ) => {
    update({ ...outline, [key]: value });
  };

  const setCharacter = (i: number, patch: Partial<NovelOutlineData["characters"][number]>) => {
    const next = outline.characters.map((c, idx) => (idx === i ? { ...c, ...patch } : c));
    update({ ...outline, characters: next });
  };

  const addCharacter = () => {
    if (outline.characters.length >= 6) return;
    update({
      ...outline,
      characters: [
        ...outline.characters,
        { name: "New character", role: "supporting", description: "" },
      ],
    });
  };

  const removeCharacter = (i: number) => {
    if (outline.characters.length <= 2) return;
    update({
      ...outline,
      characters: outline.characters.filter((_, idx) => idx !== i),
    });
  };

  const setChapter = (i: number, patch: Partial<NovelOutlineData["chapters"][number]>) => {
    const next = outline.chapters.map((c, idx) => (idx === i ? { ...c, ...patch } : c));
    update({ ...outline, chapters: next });
  };

  const addChapter = () => {
    const ids = outline.chapters.map((c) => c.id);
    update({
      ...outline,
      chapters: [
        ...outline.chapters,
        { id: newChapterId(ids), title: "New chapter", beats: "" },
      ],
    });
  };

  const removeChapter = (i: number) => {
    if (outline.chapters.length <= 1) return;
    update({
      ...outline,
      chapters: outline.chapters.filter((_, idx) => idx !== i),
    });
  };

  const moveChapter = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= outline.chapters.length) return;
    const next = outline.chapters.slice();
    const tmp = next[i];
    next[i] = next[j];
    next[j] = tmp;
    update({ ...outline, chapters: next });
  };

  const wordTarget = useMemo(() => {
    return payload.length === "short"
      ? 1200
      : payload.length === "long"
        ? 1700
        : 1400;
  }, [payload.length]);

  const approxPages = Math.round(
    (outline.chapters.length * wordTarget) / 250
  );

  return (
    <div
      className={cn(
        "hairline w-full rounded-lg p-4",
        disabled
          ? "border-border/60 opacity-90"
          : "border-[color-mix(in_oklab,var(--color-accent-2)_30%,transparent)]"
      )}
    >
      <div className="mb-3 flex items-start gap-2">
        <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent-2)]" />
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">
            {launched ? "Novel started" : "Edit the outline before writing"}
          </span>
          <span className="text-xs text-muted-foreground">
            {launched
              ? "Generating chapters below with the outline you confirmed."
              : payload.outlining
                ? "Researching the premise and outlining…"
                : payload.revising
                  ? "Revising the outline with your feedback…"
                  : `${outline.chapters.length} chapters · ~${approxPages} pages · ${payload.length}`}
          </span>
        </div>
      </div>

      {(payload.searches.length > 0 || payload.researchNote) && (
        <div className="mb-3 rounded-md border border-border/60 bg-muted/30">
          <button
            type="button"
            onClick={() => setShowResearch((s) => !s)}
            className="flex w-full items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={showResearch}
          >
            <SearchIcon className="h-3.5 w-3.5" />
            <span className="flex-1 text-left">
              Grounded with {payload.searches.length} web search
              {payload.searches.length === 1 ? "" : "es"}
              {payload.researchNote ? " · research note attached" : ""}
            </span>
            {showResearch ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
          {showResearch && (
            <div className="border-t border-border/60 px-2.5 py-2 text-xs">
              {payload.searches.length > 0 && (
                <ul className="mb-2 flex flex-col gap-1">
                  {payload.searches.map((s, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <span className="font-mono text-foreground/80">
                        {s.query}
                      </span>
                      {s.error ? (
                        <span className="text-destructive">— {s.error}</span>
                      ) : s.summary ? (
                        <span className="text-muted-foreground">
                          — {s.summary}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {payload.researchNote && (
                <div className="whitespace-pre-wrap rounded border border-border/40 bg-background p-2 text-foreground/90">
                  {payload.researchNote}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <Field label="Title">
          <Input
            value={outline.title}
            onChange={(e) => setField("title", e.target.value)}
            disabled={disabled}
            className="text-sm"
          />
        </Field>

        <Field label="Logline">
          <Textarea
            value={outline.logline}
            onChange={(e) => setField("logline", e.target.value)}
            disabled={disabled}
            className="min-h-[48px] text-sm"
          />
        </Field>

        <Field label="Setting">
          <Textarea
            value={outline.setting}
            onChange={(e) => setField("setting", e.target.value)}
            disabled={disabled}
            className="min-h-[80px] text-sm"
          />
        </Field>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              Characters ({outline.characters.length})
            </span>
            {!disabled && outline.characters.length < 6 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={addCharacter}
                className="h-7 px-2 text-xs"
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            )}
          </div>
          <ul className="flex flex-col gap-2">
            {outline.characters.map((c, i) => (
              <li
                key={i}
                className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-background/50 p-2"
              >
                <div className="flex gap-1.5">
                  <Input
                    value={c.name}
                    onChange={(e) => setCharacter(i, { name: e.target.value })}
                    disabled={disabled}
                    placeholder="Name"
                    className="h-8 flex-1 text-sm"
                  />
                  <Input
                    value={c.role}
                    onChange={(e) => setCharacter(i, { role: e.target.value })}
                    disabled={disabled}
                    placeholder="Role"
                    className="h-8 w-32 text-sm"
                  />
                  {!disabled && outline.characters.length > 2 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeCharacter(i)}
                      className="h-8 w-8 p-0"
                      aria-label={`Remove ${c.name || "character"}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <Textarea
                  value={c.description}
                  onChange={(e) =>
                    setCharacter(i, { description: e.target.value })
                  }
                  disabled={disabled}
                  placeholder="One sentence: appearance, voice, internal want."
                  className="min-h-[44px] text-sm"
                />
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              Chapters ({outline.chapters.length})
            </span>
            {!disabled && (
              <Button
                variant="ghost"
                size="sm"
                onClick={addChapter}
                className="h-7 px-2 text-xs"
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            )}
          </div>
          <ol className="flex flex-col gap-2">
            {outline.chapters.map((ch, i) => (
              <li
                key={ch.id}
                className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-background/50 p-2"
              >
                <div className="flex items-center gap-1.5">
                  <span className="w-6 shrink-0 text-center text-xs text-muted-foreground">
                    {i + 1}
                  </span>
                  <Input
                    value={ch.title}
                    onChange={(e) => setChapter(i, { title: e.target.value })}
                    disabled={disabled}
                    placeholder="Chapter title"
                    className="h-8 flex-1 text-sm"
                  />
                  {!disabled && (
                    <div className="flex gap-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => moveChapter(i, -1)}
                        disabled={i === 0}
                        className="h-8 w-8 p-0"
                        aria-label="Move chapter up"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => moveChapter(i, 1)}
                        disabled={i === outline.chapters.length - 1}
                        className="h-8 w-8 p-0"
                        aria-label="Move chapter down"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                      {outline.chapters.length > 1 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeChapter(i)}
                          className="h-8 w-8 p-0"
                          aria-label="Remove chapter"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <Textarea
                  value={ch.beats}
                  onChange={(e) => setChapter(i, { beats: e.target.value })}
                  disabled={disabled}
                  placeholder="2–4 sentences: who, where, what happens, where it ends."
                  className="min-h-[60px] text-sm"
                />
              </li>
            ))}
          </ol>
        </div>
      </div>

      {showFeedback && !disabled && (
        <div className="mt-3 flex flex-col gap-1.5 rounded-md border border-border/60 bg-muted/30 p-2.5">
          <span className="text-xs font-medium text-muted-foreground">
            Tell the outliner what to change
          </span>
          <Textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="e.g. Make the protagonist a woman. Move the inciting incident to chapter 2. Set it in Marseille instead of Lyon."
            className="min-h-[72px] text-sm"
          />
          <div className="flex justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowFeedback(false);
                setFeedback("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (!feedback.trim()) return;
                onReoutline(messageId, outline, feedback.trim());
                setFeedback("");
                setShowFeedback(false);
              }}
              disabled={!feedback.trim() || payload.revising}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Apply
            </Button>
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
        <span className="text-xs text-muted-foreground">
          {launched
            ? "Already writing below."
            : payload.outlining
              ? "Outlining…"
              : payload.revising
                ? "Revising…"
                : "Edits save automatically."}
        </span>
        <div className="flex gap-1.5">
          {!disabled && !showFeedback && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowFeedback(true)}
              title="Send the outliner free-text feedback and have it revise."
            >
              <Sparkles className="h-3.5 w-3.5" />
              Re-outline
            </Button>
          )}
          <Button
            variant="default"
            size="sm"
            onClick={() => onGenerate(messageId, outline)}
            disabled={disabled}
          >
            {payload.outlining || payload.revising ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Generate novel
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/** Loading-state view shown while the server-side outliner work is in
 *  flight. Renders a chat-style action timeline driven by `progress.steps`
 *  emitted from `app/api/novel/outline/work.ts`, plus an elapsed timer and
 *  a Cancel control so the user can always escape. When no progress data
 *  has arrived yet we fall back to the placeholder skeleton so the card
 *  doesn't pop in empty for a beat. */
function OutliningView({
  messageId,
  progress,
  isRevision,
  onCancel,
}: {
  messageId: string;
  progress?: NovelOutlineProgress;
  isRevision: boolean;
  onCancel?: (messageId: string) => void;
}) {
  // Re-render every second so the elapsed timer ticks even when no new
  // progress event arrives. Cheap — one setState per tick on a single
  // card — and it's the only signal the user has that we haven't given up.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const startedAt = progress?.startedAt ?? now;
  const elapsedSec = Math.max(0, Math.floor((now - startedAt) / 1000));
  const lastSeenAt = progress?.workerSeenAt ?? progress?.startedAt;
  const stalledMs = lastSeenAt ? now - lastSeenAt : 0;
  const stalled = stalledMs > STALL_WARN_MS && progress?.status === "running";
  const missing = progress?.status === "missing";

  // Collapse running → ok step pairs so each step shows as a single row
  // with its final status. The producer emits `{key, status:"running"}`
  // first then `{key, status:"ok"}` when the step finishes; we want one
  // visible row per key, not two. Order is preserved by the first time we
  // see a given key.
  const rows = useMemo(() => {
    const map = new Map<
      string,
      NonNullable<NovelOutlineProgress["steps"][number]>
    >();
    const order: string[] = [];
    for (const step of progress?.steps ?? []) {
      if (!map.has(step.key)) order.push(step.key);
      const prior = map.get(step.key);
      // Always prefer the later event for label/detail/at; never let a
      // "running" overwrite a terminal "ok"/"error" if events arrive
      // out-of-order from Redis pagination.
      if (!prior || prior.status === "running") {
        map.set(step.key, step);
      } else if (step.status !== "running") {
        map.set(step.key, step);
      }
    }
    return order.map((k) => map.get(k)!);
  }, [progress?.steps]);

  const allDone =
    rows.length > 0 && rows.every((r) => r.status !== "running");
  const headline = isRevision
    ? "Revising your outline"
    : rows.length === 0
      ? "Getting started"
      : allDone
        ? "Wrapping up the outline"
        : "Working on your outline";

  return (
    <div
      className={cn(
        "hairline w-full rounded-lg p-4",
        "border-[color-mix(in_oklab,var(--color-accent-2)_30%,transparent)]"
      )}
    >
      <div className="mb-3 flex items-start gap-2">
        <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent-2)]" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">{headline}</span>
          <span className="text-xs text-muted-foreground">
            {isRevision
              ? "Folding your feedback into the outline…"
              : "Researching the premise, then drafting chapters."}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className="font-mono text-[11px] tabular-nums text-muted-foreground"
            aria-label="elapsed"
          >
            {formatElapsed(elapsedSec)}
          </span>
          {onCancel && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onCancel(messageId)}
              title="Stop and discard this outline"
            >
              <X className="h-3.5 w-3.5" />
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Indeterminate progress bar — animated so the card always feels
          alive even between phase events. Reuses the same `streaming-bar`
          keyframes the chat StreamingBar uses. */}
      <div
        className="relative mb-3 h-0.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-busy="true"
      >
        <span
          className={cn(
            "absolute inset-y-0 left-0 w-1/3 rounded-full",
            stalled || missing ? "bg-amber-500" : "bg-primary"
          )}
          style={{ animation: "streaming-bar 1.4s ease-in-out infinite" }}
        />
      </div>

      <ol className="flex flex-col gap-1.5" aria-live="polite">
        {rows.length === 0 ? (
          <SkeletonStep label="Connecting to the outliner…" />
        ) : (
          rows.map((row) => (
            <StepRow
              key={row.key}
              label={row.label}
              status={row.status}
              detail={row.detail}
            />
          ))
        )}
      </ol>

      {(stalled || missing) && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-900 dark:text-amber-200">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">
              {missing
                ? "Lost track of this outline"
                : "This is taking longer than expected"}
            </p>
            <p className="opacity-90">
              {missing
                ? "The server-side stream expired or never registered. Cancel and try sending the message again."
                : `No update in ${Math.floor(stalledMs / 1000)}s — the worker may have stalled. You can keep waiting or cancel and retry.`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function StepRow({
  label,
  status,
  detail,
}: {
  label: string;
  status: "running" | "ok" | "error";
  detail?: string;
}) {
  return (
    <li className="flex items-start gap-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {status === "running" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        ) : status === "ok" ? (
          <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <X className="h-3.5 w-3.5 text-destructive" />
        )}
      </span>
      <div className="flex min-w-0 flex-col">
        <span
          className={cn(
            "text-xs",
            status === "running" ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {label}
        </span>
        {detail && (
          <span className="line-clamp-2 text-[11px] text-muted-foreground/80">
            {detail}
          </span>
        )}
      </div>
    </li>
  );
}

function SkeletonStep({ label }: { label: string }) {
  return (
    <li className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5">
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
      <span className="text-xs text-muted-foreground">{label}</span>
    </li>
  );
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
