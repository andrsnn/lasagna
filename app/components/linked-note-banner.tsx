"use client";

import { ExternalLink, Pin } from "lucide-react";
import type { StoredPinnedNote } from "@/app/db";

// Surfaces the "this designer/app is writing back to a pinned note" contract.
// The actual sync is performed by syncDesignerToSourceNote after every save —
// this banner exists so the user can see the link from the editor and jump
// back to /notes when they want to.
export function LinkedNoteBanner({
  note,
  onOpen,
}: {
  note: StoredPinnedNote;
  onOpen: () => void;
}) {
  const hasLiveShare =
    !!note.shareToken &&
    !!note.shareTokenExpiresAt &&
    note.shareTokenExpiresAt > Date.now();
  return (
    <div className="mx-2 mb-1 flex items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground sm:mx-4 sm:mb-2">
      <Pin className="h-3.5 w-3.5 shrink-0 text-primary/80" />
      <div className="min-w-0 flex-1 leading-snug">
        <span className="font-medium text-foreground">Linked to pinned note</span>
        <span className="ml-1 truncate">
          · changes save back to{" "}
          <span className="font-medium">{note.title ?? "this note"}</span>
        </span>
        {hasLiveShare && (
          <span className="ml-1">· public share link auto-refreshes</span>
        )}
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground transition hover:text-foreground"
      >
        View note
        <ExternalLink className="h-3 w-3" />
      </button>
    </div>
  );
}
