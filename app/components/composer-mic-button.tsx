"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useOpenAISTT } from "@/app/lib/openai-stt/use-openai-stt";

interface ComposerMicButtonProps {
  disabled?: boolean;
  // Called as partial transcripts stream in; the text is the in-progress
  // utterance only (not previously committed text).
  onPartial: (utteranceText: string) => void;
  // Called when an utterance is finalized (silence or stop). Append.
  onCommit: (utteranceText: string) => void;
}

export function ComposerMicButton({
  disabled,
  onPartial,
  onCommit,
}: ComposerMicButtonProps) {
  const [hoverError, setHoverError] = useState<string | null>(null);
  const {
    isRecording,
    audioLevel,
    error,
    start,
    stop,
  } = useOpenAISTT({
    onPartial,
    onCommit,
    onError: (m) => setHoverError(m),
  });

  // Forget transient errors after a few seconds so the button re-enables.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setHoverError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  const onToggle = () => {
    if (disabled) return;
    if (isRecording) {
      stop();
    } else {
      void start();
    }
  };

  const tip = hoverError
    ? hoverError
    : isRecording
      ? "Listening — your words will appear as you speak. Click to stop."
      : "Dictate";
  // Clamp the level used for visuals to keep the halo from getting silly loud.
  const levelClamped = Math.min(1, Math.max(0, audioLevel));

  const recordingRef = useRef(isRecording);
  recordingRef.current = isRecording;

  return (
    <div className="relative inline-flex shrink-0 items-center">
      <Tooltip>
        <TooltipTrigger
          type="button"
          onClick={onToggle}
          disabled={disabled}
          aria-label={isRecording ? "Stop dictation" : "Start dictation"}
          aria-pressed={isRecording}
          className={cn(
            "tap relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground transition sm:mb-0.5 sm:h-8 sm:w-8 sm:rounded-md",
            "hover:bg-muted hover:text-foreground",
            "disabled:pointer-events-none disabled:opacity-50",
            isRecording &&
              "border-destructive/60 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
            hoverError && "border-destructive/40 text-destructive"
          )}
        >
          {hoverError ? (
            <MicOff className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          ) : (
            <Mic
              className={cn(
                "h-4 w-4 sm:h-3.5 sm:w-3.5",
                isRecording && "animate-pulse"
              )}
            />
          )}
          {isRecording && (
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-destructive shadow-[0_0_0_2px_var(--background)]" />
          )}
          {isRecording && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-[-3px] rounded-[14px] border-2 border-destructive/60 sm:inset-[-2px] sm:rounded-md"
              style={{
                transform: `scale(${1 + levelClamped * 0.35})`,
                opacity: 0.35 + 0.5 * levelClamped,
                transition: "transform 80ms linear, opacity 80ms linear",
              }}
            />
          )}
        </TooltipTrigger>
        <TooltipContent>{tip}</TooltipContent>
      </Tooltip>
    </div>
  );
}
