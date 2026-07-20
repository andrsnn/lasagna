"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { ArtifactFiles, StoredDesigner, StoredMessage } from "@/app/db";
import { FileTree } from "./file-tree";
import { ActivityFeed } from "./activity-feed";
import { BookmarksPanel } from "./bookmarks-panel";

export type DetailsTab = "activity" | "files" | "bookmarks";

/**
 * The repurposed left/bottom panel: holds Activity (the formerly-inline tool
 * events, now nicely laid out) and Files (the existing FileTree). Sub-tab
 * state is owned by the parent so external triggers — e.g. tapping "View
 * details" on a chat message — can flip into Activity directly.
 */
export function DetailsPanel({
  activeTab,
  onTab,
  messages,
  highlightMessageId,
  files,
  entry,
  selectedPath,
  onSelectFile,
  fileCount,
  designer,
  onRevert,
  onSetLabel,
}: {
  activeTab: DetailsTab;
  onTab: (tab: DetailsTab) => void;
  messages: StoredMessage[];
  highlightMessageId?: string | null;
  files: ArtifactFiles;
  entry: string;
  selectedPath?: string;
  onSelectFile: (path: string) => void;
  fileCount: number;
  designer: StoredDesigner | null;
  onRevert: (version: number, restoreState?: boolean) => Promise<void>;
  onSetLabel: (version: number, label: string | null) => Promise<void>;
}) {
  const activityCount = useMemo(
    () =>
      messages.reduce(
        (sum, m) =>
          sum +
          (m.role === "assistant" && m.events
            ? m.events.filter((e) => e.kind === "call").length
            : 0),
        0
      ),
    [messages]
  );

  const bookmarkCount = useMemo(
    () => Object.keys(designer?.checkpointLabels ?? {}).length,
    [designer?.checkpointLabels]
  );

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <SubTabButton
          active={activeTab === "activity"}
          onClick={() => onTab("activity")}
          label="Activity"
          badge={activityCount}
        />
        <SubTabButton
          active={activeTab === "files"}
          onClick={() => onTab("files")}
          label="Files"
          badge={fileCount}
        />
        <SubTabButton
          active={activeTab === "bookmarks"}
          onClick={() => onTab("bookmarks")}
          label="Bookmarks"
          badge={bookmarkCount}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeTab === "activity" ? (
          <div className="p-2">
            <ActivityFeed messages={messages} highlightMessageId={highlightMessageId} />
          </div>
        ) : activeTab === "bookmarks" ? (
          <div className="p-2">
            {designer && (
              <BookmarksPanel
                designer={designer}
                onRevert={onRevert}
                onSetLabel={onSetLabel}
              />
            )}
          </div>
        ) : (
          <div className="p-2">
            <FileTree
              files={files}
              entry={entry}
              selected={selectedPath}
              onSelect={onSelectFile}
            />
          </div>
        )}
      </div>
    </>
  );
}

function SubTabButton({
  active,
  onClick,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  badge: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "tap inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      <span>{label}</span>
      {badge > 0 && (
        <span
          className={cn(
            "rounded-full px-1.5 py-px font-mono text-[10px] tabular-nums",
            active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
