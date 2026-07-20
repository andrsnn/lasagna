"use client";

import { useCallback, useState } from "react";
import { Bookmark, Check, DatabaseZap, Trash2, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/app/lib/visuals";
import type { DesignerCommit, StoredDesigner } from "@/app/db";

export function BookmarksPanel({
  designer,
  onRevert,
  onSetLabel,
}: {
  designer: StoredDesigner;
  onRevert: (version: number, restoreState?: boolean) => Promise<void>;
  onSetLabel: (version: number, label: string | null) => Promise<void>;
}) {
  const labels = designer.checkpointLabels ?? {};
  const snapshots = designer.stateSnapshots ?? {};
  const history = designer.history ?? [];

  const bookmarked: { version: number; label: string; savedAt: number; commitMessage?: string; hasSnapshot: boolean; isCurrent: boolean }[] = [];

  for (const [vStr, label] of Object.entries(labels)) {
    const v = Number(vStr);
    const isCurrent = v === designer.version;
    const commit = history.find((h) => h.version === v);
    // The current head isn't in `history` (that holds prior commits only), so
    // its description lives on the designer's `headCommitMessage` instead.
    const commitMessage = isCurrent ? designer.headCommitMessage : commit?.commitMessage;
    bookmarked.push({
      version: v,
      label,
      savedAt: isCurrent ? designer.updatedAt : (commit?.savedAt ?? designer.updatedAt),
      commitMessage,
      hasSnapshot: !!snapshots[vStr],
      isCurrent,
    });
  }

  bookmarked.sort((a, b) => b.version - a.version);

  if (bookmarked.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
        <Bookmark className="h-6 w-6 text-muted-foreground/40" />
        <p className="text-xs text-muted-foreground">
          No bookmarks yet. Open version history and tap the{" "}
          <Bookmark className="inline h-3 w-3" /> icon on any version to
          bookmark it.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {bookmarked.map((b) => (
        <BookmarkRow
          key={b.version}
          bookmark={b}
          onRevert={onRevert}
          onSetLabel={onSetLabel}
        />
      ))}
    </div>
  );
}

function BookmarkRow({
  bookmark,
  onRevert,
  onSetLabel,
}: {
  bookmark: {
    version: number;
    label: string;
    savedAt: number;
    commitMessage?: string;
    hasSnapshot: boolean;
    isCurrent: boolean;
  };
  onRevert: (version: number, restoreState?: boolean) => Promise<void>;
  onSetLabel: (version: number, label: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [labelInput, setLabelInput] = useState(bookmark.label);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveLabel = useCallback(async () => {
    const trimmed = labelInput.trim();
    if (trimmed) {
      await onSetLabel(bookmark.version, trimmed);
    }
    setEditing(false);
  }, [labelInput, bookmark.version, onSetLabel]);

  const removeBookmark = useCallback(async () => {
    await onSetLabel(bookmark.version, null);
  }, [bookmark.version, onSetLabel]);

  const doRestore = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      await onRevert(bookmark.version, bookmark.hasSnapshot);
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Restore failed. Try again.");
    } finally {
      setPending(false);
    }
  }, [bookmark.version, bookmark.hasSnapshot, onRevert]);

  return (
    <div className="border-b border-border/60 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Bookmark className="h-3.5 w-3.5 shrink-0 fill-current text-amber-500" />
          <span className="font-mono text-sm text-foreground">v{bookmark.version}</span>
          {bookmark.hasSnapshot && (
            <DatabaseZap className="h-3 w-3 shrink-0 text-sky-500" />
          )}
          {bookmark.isCurrent && (
            <span className="rounded bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
              current
            </span>
          )}
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {relativeTime(bookmark.savedAt)}
        </span>
      </div>

      {editing ? (
        <div className="mt-1.5 flex items-center gap-1 rounded-md border border-border bg-secondary/30 px-2 py-1">
          <input
            autoFocus
            value={labelInput}
            onChange={(e) => setLabelInput(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") void saveLabel();
              if (e.key === "Escape") setEditing(false);
            }}
            placeholder="Rename bookmark…"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
            maxLength={60}
          />
          <button
            type="button"
            onClick={() => void saveLabel()}
            className="rounded p-0.5 text-muted-foreground transition hover:text-foreground"
            title="Save"
          >
            <Check className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded p-0.5 text-muted-foreground transition hover:text-foreground"
            title="Cancel"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <p className="mt-0.5 text-xs font-medium text-amber-500 truncate">{bookmark.label}</p>
      )}

      {bookmark.commitMessage && (
        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{bookmark.commitMessage}</p>
      )}

      {error && (
        <p className="mt-1.5 text-[11px] text-destructive">{error}</p>
      )}

      {confirming ? (
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Restore to v{bookmark.version}?</span>
          <button
            type="button"
            disabled={pending}
            onClick={() => void doRestore()}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-primary bg-primary/10 hover:bg-primary/20 transition disabled:opacity-50"
          >
            <Undo2 className="h-3 w-3" />
            Yes
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground transition"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setLabelInput(bookmark.label);
              setEditing(true);
            }}
            className="text-[11px] text-muted-foreground hover:text-foreground transition"
          >
            Rename
          </button>
          {!bookmark.isCurrent && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground transition"
            >
              <Undo2 className="h-3 w-3" />
              Restore
            </button>
          )}
          <button
            type="button"
            onClick={() => void removeBookmark()}
            className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-destructive transition"
          >
            <Trash2 className="h-3 w-3" />
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
