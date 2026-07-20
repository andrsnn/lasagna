"use client";

import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

// App-store-style update offer, shown on the app page while the app hasn't
// adopted the declared-data runtime (manifest has no "state" block). Plain
// language only - the user needs zero platform knowledge: one primary action,
// one dismiss, and it disappears for good once the update lands (or forever
// if dismissed; the app Settings "Update app" row remains as the quiet path).
export function AppUpdateBanner({
  onUpdate,
  onDismiss,
}: {
  onUpdate: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="mx-2 mb-1 flex items-center gap-3 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 sm:mx-4 sm:mb-2">
      <Sparkles className="h-4 w-4 shrink-0 text-primary/80" />
      <div className="min-w-0 flex-1 leading-snug">
        <div className="text-sm font-medium text-foreground">
          An update is available for this app
        </div>
        <div className="text-[11px] text-muted-foreground">
          Makes refreshing more dependable and keeps the widget and app in
          sync. Your data and settings are kept.
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onDismiss}
          className="tap text-[11px] text-muted-foreground hover:text-foreground"
        >
          Not now
        </button>
        <Button size="sm" onClick={onUpdate}>
          Update
        </Button>
      </div>
    </div>
  );
}
