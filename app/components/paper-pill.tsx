import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "accent" | "warn" | "success";

const toneClass: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  accent: "text-[var(--color-accent)]",
  warn: "text-[#8a4a14] dark:text-[#e6b577]",
  success: "text-[var(--color-accent-2)]",
};

export const PaperPill = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }
>(function PaperPill({ className, tone = "neutral", ...props }, ref) {
  return (
    <span
      ref={ref}
      className={cn(
        // Quiet micro-label instead of a filled chip — tone is text color only.
        "inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em]",
        toneClass[tone],
        className
      )}
      {...props}
    />
  );
});
