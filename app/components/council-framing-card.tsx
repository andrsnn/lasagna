"use client";

import { useMemo, useState } from "react";
import { Loader2, Send, SkipForward, Square, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { CouncilFramingPayload } from "@/app/db";
import { FramerActionsList } from "@/app/components/research-framing-card";
import { FramingThinking } from "@/app/components/framing-thinking";
import { cn } from "@/lib/utils";

type Props = {
  /** Stable id of the framing message — used by the parent's update callback
   *  to identify which row to mutate when the user types or submits. */
  messageId: string;
  payload: CouncilFramingPayload;
  /** True when the user has already clicked "Run council" on this card. The
   *  card flips into a read-only summary state in that case. */
  launched: boolean;
  /** True while the framer is still working (handshake → resume not yet
   *  resolved). Card renders a spinner instead of empty action buttons so
   *  the user doesn't think they're staring at a finished-empty result. */
  loading?: boolean;
  /** Persist updated answers (debounced is fine — parent throttles writes). */
  onAnswersChange: (messageId: string, answers: Record<string, string>) => void;
  /** User clicked "Run council". Parent kicks off /api/council/run with
   *  whatever answers are currently in the payload. */
  onLaunch: (messageId: string, answers: Record<string, string>) => void;
  /** User clicked "Skip framing". Same as launch but with empty answers. */
  onSkip: (messageId: string) => void;
  /** User clicked "Stop" while framing is loading. Aborts the in-flight
   *  framer and removes the card. */
  onStop?: (messageId: string) => void;
  /** Live framer reasoning + web-search progress, streamed while `loading`. */
  thinkingText?: string;
};

export function CouncilFramingCard({
  messageId,
  payload,
  launched,
  loading = false,
  onAnswersChange,
  onLaunch,
  onSkip,
  onStop,
  thinkingText,
}: Props) {
  // Local mirror of answers — keystrokes feel jankless and we sync up to
  // IndexedDB on each change. Initial state seeds from whatever was persisted.
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
    // If the user clicks the same pill again, treat it as "clear back to
    // empty" so they can pick a different one without erasing typed text.
    const next = current === choice ? "" : choice;
    setAnswer(id, next);
  };

  const filledCount = useMemo(
    () =>
      payload.questions.filter((q) => (answers[q.id] ?? "").trim().length > 0)
        .length,
    [payload.questions, answers]
  );

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
        .join(" and ")}, then framing grounding questions.`
    : "Reading the chat and checking the load-bearing claims before asking grounding questions.";

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
          <Users className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent-2)]" />
        )}
        <div className="flex flex-col">
          <span className="text-sm font-medium">
            {launched
              ? "Council launched"
              : loading
                ? loadingTitle
                : "Council needs grounding"}
          </span>
          <span className="text-xs text-muted-foreground">
            {loading
              ? loadingSubtitle
              : payload.rationale ||
                "A few quick clarifying questions before the council debates."}
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
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSkip(messageId)}
                disabled={launched || loading}
                title="Run the council without answering — it will work from chat alone."
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
                Run council
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
