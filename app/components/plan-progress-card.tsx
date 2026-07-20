"use client";

import { ArrowRight, Check, CircleDot, Clock, Loader2, Square, X } from "lucide-react";
import type { StoredMessage } from "@/app/db";
import { cn } from "@/lib/utils";

type Props = {
  plan: NonNullable<StoredMessage["plan"]>;
  /** Set when the message is plan-paused AND the row's parent has a
   *  registered continue handler. Renders the inline "Continue plan" CTA. */
  onContinue?: () => void;
  /** Set while a worker is actively producing events for this message.
   *  Used to disable the Continue button so a rapid double-click doesn't
   *  race the resumer. */
  disabled?: boolean;
  /** Mid-plan worker death: a regular `error` fired on the bubble but steps
   *  remain un-done. Distinguishes from the graceful-pause path (pausedAt)
   *  so the card's label and step-icon treatment can adapt — and so the
   *  Continue CTA appears even though pausedAt was never set. */
  stalled?: boolean;
  /** User-initiated pause. Set while the plan's worker is live and the
   *  parent has a registered stop handler. Posts to /api/chat/plan-pause
   *  to flag the scratchpad; the orchestrator drains to a graceful pause
   *  on its next between-step / between-round check and the Continue CTA
   *  appears via the standard pausedAt path. */
  onStop?: () => void;
  /** Stop click has fired but `plan_paused` hasn't arrived yet — the
   *  parent flipped this to swap the Stop button for a "Stopping…" state
   *  so a rapid double-click doesn't re-POST. */
  stopping?: boolean;
  /** Stream ended cleanly but the plan still has un-done steps — the
   *  worker declared itself done before every step was marked. Backend's
   *  verifier sweep usually closes the gap; this prop covers the rare case
   *  it can't. Drops the running-step spinner, hides the Stop CTA, and
   *  swaps the header to "Plan finished early" so the user isn't left
   *  staring at a frozen spinner. */
  finished?: boolean;
};

/**
 * Inline status card for plan-mode assistant messages. Renders the per-step
 * checklist with status chips and surfaces a "Continue plan" affordance when
 * the assistant turn was paused (graceful chain-exhaust) or stalled (hard
 * worker kill mid-plan).
 *
 * Rendered above the message bubble's prose so the user can see exactly
 * where the work was when the chain hit the wall.
 */
export function PlanProgressCard({
  plan,
  onContinue,
  disabled,
  stalled,
  onStop,
  stopping,
  finished,
}: Props) {
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === "done").length;
  const running = plan.steps.find((s) => s.status === "running");
  const paused = !!plan.pausedAt;
  // Treat the still-"running" step on a stalled plan as the resume point —
  // the worker was hard-killed there but the next continuation will re-run
  // it cleanly (it wasn't cached). The visual marker matches the paused-here
  // amber treatment so the user sees exactly where the chain died.
  const stalledStepId = stalled && running ? running.id : null;
  const showContinueCta = (paused || stalled) && !!onContinue;
  // Stop is offered any time the plan still has un-done work and isn't
  // already paused / stalled / finished (those surfaces show Continue or
  // nothing instead). We do NOT gate on `disabled` (live SSE) because the
  // worst case — the user returning to a stuck plan whose stream hasn't
  // re-attached — is exactly when Stop is most useful. The pause endpoint
  // itself is safe to call against a non-running stream (returns 409,
  // which we treat as benign).
  const showStopCta =
    !!onStop && !paused && !stalled && !finished && done < total;

  return (
    <div className="w-full border-l-2 border-border py-1 pl-3 sm:pl-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {paused
              ? "Plan paused"
              : stalled
                ? "Plan stalled"
                : finished
                  ? "Plan finished early"
                  : running
                    ? "Plan in progress"
                    : done === total && total > 0
                      ? "Plan complete"
                      : "Plan"}
          </span>
          {plan.brief && (
            <span className="truncate text-xs text-foreground" title={plan.brief}>
              {plan.brief}
            </span>
          )}
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {done}/{total}
        </span>
      </div>

      <ol className="mt-2 flex flex-col gap-1">
        {plan.steps.map((step, i) => {
          const isPausedHere =
            (paused && plan.pausedAt === step.id) || stalledStepId === step.id;
          // On a stalled or finished-early plan the "running" step is no
          // longer doing work. Suppress the active-step spinner background
          // so it doesn't look like work is still happening.
          const showActiveBg =
            step.status === "running" && !stalledStepId && !finished;
          return (
            <li
              key={step.id}
              className={cn(
                "flex items-start gap-2 rounded-md px-1.5 py-1 text-[12px]",
                showActiveBg && "bg-muted/50",
                isPausedHere && "bg-amber-100/40 dark:bg-amber-500/10"
              )}
            >
              <StepIcon
                status={step.status}
                pausedHere={isPausedHere}
                frozen={!!finished}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-baseline gap-1.5">
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {i + 1}.
                  </span>
                  <span
                    className={cn(
                      "truncate",
                      step.status === "done" && !step.cached && "text-foreground",
                      step.status === "errored" && "text-destructive",
                      step.cached && "text-muted-foreground"
                    )}
                    title={step.title}
                  >
                    {step.title}
                  </span>
                  {step.cached && (
                    <span className="rounded-sm bg-muted px-1 py-px text-[9px] uppercase tracking-wide text-muted-foreground">
                      cached
                    </span>
                  )}
                </span>
                {step.summary && step.status === "done" && (
                  <span className="text-[11px] text-muted-foreground truncate" title={step.summary}>
                    {step.summary}
                  </span>
                )}
                {step.error && step.status === "errored" && (
                  <span className="text-[11px] text-destructive" title={step.error}>
                    {step.error}
                  </span>
                )}
                {step.filesChanged && step.filesChanged.length > 0 && step.status === "done" && (
                  <span className="text-[10px] text-muted-foreground">
                    {step.filesChanged.length === 1
                      ? step.filesChanged[0]
                      : `${step.filesChanged.length} files`}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {showContinueCta && (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
          <span className="text-[11px] text-muted-foreground">
            {paused
              ? `Chain budget exhausted with ${total - done} step${total - done === 1 ? "" : "s"} remaining. The plan is saved server-side.`
              : `Worker died mid-plan with ${total - done} step${total - done === 1 ? "" : "s"} remaining. Cached steps will be skipped on resume.`}
          </span>
          <button
            type="button"
            onClick={onContinue}
            disabled={disabled}
            title={disabled ? "Wait for the current response to finish" : undefined}
            className={cn(
              "tap inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium transition",
              disabled
                ? "cursor-not-allowed opacity-50"
                : "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            )}
          >
            <ArrowRight className="h-3 w-3" />
            Continue plan
          </button>
        </div>
      )}

      {showStopCta && (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
          <span className="text-[11px] text-muted-foreground">
            {stopping
              ? "Stopping after the current round — cached steps are kept."
              : `Stop after the current round. Continue picks up at step ${(plan.steps.findIndex((s) => s.status !== "done") + 1) || total}.`}
          </span>
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            aria-label={stopping ? "Stopping plan" : "Stop plan"}
            title={
              stopping
                ? "Stopping after the current round…"
                : "Stop the plan. Cached steps are kept and Continue picks up here."
            }
            className={cn(
              "tap inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium transition",
              stopping
                ? "cursor-progress opacity-60"
                : "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            )}
          >
            {stopping ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Square className="h-3 w-3 fill-current" />
            )}
            {stopping ? "Stopping" : "Stop plan"}
          </button>
        </div>
      )}
    </div>
  );
}

function StepIcon({
  status,
  pausedHere,
  frozen,
}: {
  status: "pending" | "running" | "done" | "errored";
  pausedHere: boolean;
  /** Plan-finished-early: the worker stopped without marking everything
   *  done. Render the running marker without the spin so the user doesn't
   *  think work is still happening. */
  frozen?: boolean;
}) {
  if (pausedHere) {
    return <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />;
  }
  if (status === "running") {
    return frozen ? (
      <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
    );
  }
  if (status === "done") {
    return <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />;
  }
  if (status === "errored") {
    return <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />;
  }
  return <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}
