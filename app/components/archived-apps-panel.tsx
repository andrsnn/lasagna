"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Archive, RotateCcw, Trash2, X } from "lucide-react";
import type { StoredApp, StoredDesigner } from "@/app/db";
import { gradientCss, relativeTime } from "@/app/lib/visuals";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Right-side drawer that lists a user's archived apps. Archiving hides an app
 * from every live surface (Apps list, Home widgets, Control Center); this panel
 * is where it lives on, dormant. Each row can be Restored (brought back intact,
 * schedule resumed) or Deleted for good (cascades through deleteDesigner into
 * the graveyard store, so app data is preserved even on a hard delete).
 */
export function ArchivedAppsPanel({
  open,
  onOpenChange,
  archived,
  designerById,
  onRestore,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  archived: StoredApp[];
  designerById: Map<string, StoredDesigner>;
  onRestore: (app: StoredApp) => void;
  onDelete: (app: StoredApp) => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-black/40 duration-150 supports-backdrop-filter:backdrop-blur-sm",
            "data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          )}
        />
        <DialogPrimitive.Popup
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-md flex-col bg-popover text-popover-foreground shadow-xl ring-1 ring-foreground/10 outline-none",
            "duration-200 data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right"
          )}
        >
          <header className="safe-top flex items-start justify-between gap-3 border-b border-border/60 px-4 pt-4 pb-3 sm:px-5">
            <div className="min-w-0">
              <DialogPrimitive.Title className="flex items-center gap-2 font-heading text-base font-medium">
                <Archive className="h-4 w-4 text-muted-foreground" />
                Archived apps
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-xs text-muted-foreground">
                Widgets and scheduled tasks are off while an app is archived.
                Restore to bring it back, or delete it for good.
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}
            >
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </header>

          <div className="scroll-area flex-1 px-4 py-3 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:px-5">
            {archived.length === 0 ? (
              <div className="mt-10 flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
                <Archive className="h-5 w-5 opacity-60" />
                <p>No archived apps.</p>
                <p className="max-w-[16rem] text-xs">
                  Archive an app from the Apps list to tuck it away here without
                  losing anything.
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {archived.map((app) => {
                  const designer = designerById.get(app.id);
                  const name = designer?.name ?? app.name;
                  const archivedAt = app.archivedAt ?? Date.now();
                  return (
                    <li
                      key={app.id}
                      className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3"
                    >
                      <div
                        className="h-9 w-9 shrink-0 rounded-xl border border-border opacity-70"
                        style={{ background: gradientCss(app.id) }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium" title={name}>
                          {name}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          Archived {relativeTime(archivedAt)}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onRestore(app)}
                        className="shrink-0 gap-1.5"
                        aria-label={`Restore ${name}`}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Restore</span>
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => onDelete(app)}
                        className="shrink-0 gap-1.5"
                        aria-label={`Delete ${name} permanently`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span className="sr-only sm:not-sr-only">Delete</span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
