import * as React from "react";
import { cn } from "@/lib/utils";

type Tone = "flat" | "raised";

export const PaperCard = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { tone?: Tone }
>(function PaperCard({ className, tone = "flat", ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-lg border border-border/70",
        // Raised surfaces (dialogs, overlays) keep an opaque fill so content
        // behind them doesn't bleed through; flat surfaces dissolve into the
        // page — hairline boundary only, no shadow anywhere.
        tone === "raised" ? "bg-card" : "bg-transparent",
        className
      )}
      {...props}
    />
  );
});
