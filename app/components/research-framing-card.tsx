"use client";

import { useMemo, useState } from "react";
import { FileText, Image as ImageIcon, Loader2, RotateCw, Search, Send, SkipForward, Sparkles, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { FramerAction, ResearchFramingPayload } from "@/app/db";
import { FramingThinking } from "@/app/components/framing-thinking";
import { cn } from "@/lib/utils";

type Props = {
  /** Stable id of the framing message — used by the parent's update callback
   *  to identify which row to mutate when the user types or submits. */
  messageId: string;
  payload: ResearchFramingPayload;
  /** True when the user has already clicked "Run research" on this card. The
   *  card flips into a read-only summary state in that case. */
  launched: boolean;
  /** True while the framer is still working (handshake → resume not yet
   *  resolved). Card renders a spinner instead of empty action buttons so
   *  the user doesn't think they're staring at a finished-empty result. */
  loading?: boolean;
  /** Persist updated answers (debounced is fine — parent throttles writes). */
  onAnswersChange: (messageId: string, answers: Record<string, string>) => void;
  /** User clicked "Run research". Parent kicks off /api/chat with the
   *  framing payload attached as `researchFraming`. */
  onLaunch: (messageId: string, answers: Record<string, string>) => void;
  /** User clicked "Skip and research as-is". Same as launch but with empty
   *  answers — planner sees the questions without answers. */
  onSkip: (messageId: string) => void;
  /** User picked "Frame first" on the pre-framing choice card. Kicks off the
   *  framer (scoping questions) instead of researching straight away. */
  onFrameFirst?: (messageId: string) => void;
  /** User clicked "Retry framing" after the framer timed out / errored. Re-runs
   *  the framer against the same question. */
  onRetryFraming?: (messageId: string) => void;
  /** User clicked "Stop" while framing is loading. Aborts the in-flight
   *  framer and removes the card. */
  onStop?: (messageId: string) => void;
  /** Live framer reasoning + progress, streamed while `loading`. Rendered so
   *  the user watches the framer work instead of a blank spinner. */
  thinkingText?: string;
};

export function ResearchFramingCard({
  messageId,
  payload,
  launched,
  loading = false,
  onAnswersChange,
  onLaunch,
  onSkip,
  onFrameFirst,
  onRetryFraming,
  onStop,
  thinkingText,
}: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>(
    () => payload.answers ?? {}
  );

  const setAnswer = (id: string, text: string) => {
    if (launched) return;
    const next = { ...answers, [id]: text };
    setAnswers(next);
    onAnswersChange(messageId, next);
  };

  const togglePill = (id: string, choice: string) => {
    if (launched) return;
    const current = answers[id] ?? "";
    const next = current === choice ? "" : choice;
    setAnswer(id, next);
  };

  const filledCount = useMemo(
    () =>
      payload.questions.filter((q) => (answers[q.id] ?? "").trim().length > 0)
        .length,
    [payload.questions, answers]
  );

  // Pre-framing decision: the framer hasn't run yet. Offer the explicit
  // choice rather than paying the framer's latency (and its flaky auto-launch)
  // on every research send.
  if (payload.stage === "choice" && !launched) {
    return (
      <div className="hairline w-full rounded-lg border-[color-mix(in_oklab,var(--color-accent-2)_30%,transparent)] p-4">
        <div className="mb-3 flex items-start gap-2">
          <Search className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent-2)]" />
          <div className="flex flex-col">
            <span className="text-sm font-medium">Run research</span>
            <span className="text-xs text-muted-foreground">
              {payload.rationale ||
                "Frame the question first, or kick off the research right away."}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-end gap-1.5 border-t border-border pt-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onFrameFirst?.(messageId)}
            title="Have the framer read the chat and ask a few scoping questions before researching."
          >
            <Sparkles className="h-3.5 w-3.5" />
            Frame first
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => onSkip(messageId)}
            title="Skip the framer and start the research now."
          >
            <Send className="h-3.5 w-3.5" />
            Research now
          </Button>
        </div>
      </div>
    );
  }

  const hasAttachments =
    (payload.pendingImageCount ?? 0) > 0 || (payload.pendingPdfCount ?? 0) > 0;

  const loadingTitle = hasAttachments
    ? "Describing attachments…"
    : "Framing the question…";

  const loadingSubtitle = hasAttachments
    ? `Reading ${[
        payload.pendingImageCount
          ? `${payload.pendingImageCount} image${payload.pendingImageCount > 1 ? "s" : ""}`
          : null,
        payload.pendingPdfCount
          ? `${payload.pendingPdfCount} PDF${payload.pendingPdfCount > 1 ? "s" : ""}`
          : null,
      ]
        .filter(Boolean)
        .join(" and ")}, then framing scoping questions.`
    : "Reading the chat and checking the load-bearing claims before asking scoping questions.";

  return (
    <div
      className={cn(
        "hairline w-full rounded-lg p-4",
        launched
          ? "border-border/60 opacity-80"
          : "border-[color-mix(in_oklab,var(--color-accent-2)_30%,transparent)]"
      )}
    >
      <div className="mb-3 flex items-start gap-2">
        {loading ? (
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[var(--color-accent-2)]" />
        ) : (
          <Search className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent-2)]" />
        )}
        <div className="flex flex-col">
          <span className="text-sm font-medium">
            {launched
              ? "Research launched"
              : loading
                ? loadingTitle
                : "Research scope"}
          </span>
          <span className="text-xs text-muted-foreground">
            {loading
              ? loadingSubtitle
              : payload.rationale ||
                "A few quick scoping questions before the research sub-agents run."}
          </span>
        </div>
      </div>

      {payload.actions && payload.actions.length > 0 && (
        <FramerActionsList actions={payload.actions} />
      )}

      <ol className="flex flex-col gap-3">
        {payload.questions.map((q, i) => {
          const value = answers[q.id] ?? "";
          return (
            <li key={q.id} className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                {i + 1}. {q.question}
              </span>
              {q.suggestedAnswers && q.suggestedAnswers.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {q.suggestedAnswers.map((s) => {
                    const active = value === s;
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => togglePill(q.id, s)}
                        disabled={launched}
                        aria-pressed={active}
                        className={cn(
                          "tap rounded-full border px-2.5 py-1 text-xs transition",
                          active
                            ? "border-[color-mix(in_oklab,var(--color-accent-2)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-accent-2)_10%,transparent)] text-[var(--color-accent-2)]"
                            : "border-border bg-card text-muted-foreground hover:text-foreground",
                          launched && "cursor-default"
                        )}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              )}
              <Textarea
                value={value}
                onChange={(e) => setAnswer(q.id, e.target.value)}
                placeholder={
                  q.suggestedAnswers && q.suggestedAnswers.length > 0
                    ? "Or type a custom answer…"
                    : "Type your answer…"
                }
                disabled={launched}
                aria-label={`Answer for question ${i + 1}`}
                className="min-h-[64px] text-sm"
              />
            </li>
          );
        })}
      </ol>

      {loading && <FramingThinking text={thinkingText} />}

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
        <span className="text-xs text-muted-foreground">
          {launched
            ? "Already running below."
            : loading
              ? "Working…"
              : payload.framerFailed
                ? "Framing didn't finish — retry or run as-is."
                : payload.questions.length === 0
                  ? "Nothing to answer — proceed when ready."
                  : `${filledCount} of ${payload.questions.length} answered.`}
        </span>
        <div className="flex gap-1.5">
          {loading && onStop ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onStop(messageId)}
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              Stop
            </Button>
          ) : payload.framerFailed ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRetryFraming?.(messageId)}
                disabled={launched || loading}
                title="Run the framer again to draft scoping questions."
              >
                <RotateCw className="h-3.5 w-3.5" />
                Retry framing
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={() => onLaunch(messageId, answers)}
                disabled={launched || loading}
                title="Research the original question without scoping — sub-agents work from it alone."
              >
                <Send className="h-3.5 w-3.5" />
                Run research as-is
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSkip(messageId)}
                disabled={launched || loading}
                title="Run the research without answering — sub-agents will work from your original question alone."
              >
                <SkipForward className="h-3.5 w-3.5" />
                Skip
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={() => onLaunch(messageId, answers)}
                disabled={launched || loading}
              >
                <Send className="h-3.5 w-3.5" />
                Run research
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Renders the pre-framer tool actions (describe_image, attach_pdf) above
 *  the scoping questions. Without this, the user sees the scoping
 *  questions but has no signal that the framer actually read the
 *  attached image — and when describe_image fails, the failure is
 *  invisible. */
export function FramerActionsList({ actions }: { actions: FramerAction[] }) {
  if (actions.length === 0) return null;
  return (
    <ul
      className="mb-3 flex flex-col gap-1 rounded-md border border-border/60 bg-muted/30 px-2.5 py-2"
      aria-label="Pre-framing actions"
    >
      {actions.map((a, i) => {
        const isImage = a.kind === "describe_image";
        const Icon = isImage ? ImageIcon : FileText;
        const failed = isImage && !!a.error;
        return (
          <li
            key={i}
            className={cn(
              "flex items-start gap-2 text-xs",
              failed ? "text-destructive" : "text-muted-foreground"
            )}
          >
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="font-mono">
                {a.kind === "describe_image" ? "describe_image" : "attach_pdf"}
              </span>
              {a.kind === "describe_image" ? (
                <>
                  {" "}
                  <span className="text-foreground/80">
                    image {a.index}
                    {a.name ? ` — ${a.name}` : ""}
                  </span>{" "}
                  via <span className="font-mono">{a.describer}</span>
                  {failed ? (
                    <span className="ml-1 text-destructive">
                      · failed: {a.error}
                    </span>
                  ) : a.summary ? (
                    <span className="ml-1 italic text-foreground/70">
                      · {a.summary}
                    </span>
                  ) : null}
                </>
              ) : (
                <>
                  {" "}
                  <span className="text-foreground/80">
                    pdf {a.index} — {a.name}
                  </span>{" "}
                  ({a.pageCount === 1 ? "1 page" : `${a.pageCount} pages`}
                  {a.truncated ? ", truncated" : ""})
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
