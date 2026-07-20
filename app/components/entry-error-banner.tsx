"use client";

import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";

// Host-owned failure surface for declared-data entries. The entry meta knows
// when a refresh failed, but whether the user ever SEES that depended on the
// generated app rendering the hook's `error` - which generated code routinely
// forgets, producing "the scan does nothing" dead ends. This banner is
// rendered by the HOST above the app frame, so a failed refresh is visible no
// matter what the app's own code does, and "Fix in chat" hands the exact
// error to the edit model instead of making the user describe symptoms.
export function EntryErrorBanner({
  entryKey,
  error,
  onFixInChat,
  onDismiss,
}: {
  entryKey: string;
  error: string;
  onFixInChat: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="mx-2 mb-1 flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 sm:mx-4 sm:mb-2">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 leading-snug">
        <div className="text-sm font-medium text-foreground">
          The last data refresh failed
        </div>
        <div className="break-words text-[11px] text-muted-foreground">
          <span className="font-mono">{entryKey}</span>: {error}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="outline" onClick={onFixInChat}>
          Fix in chat
        </Button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="tap text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
