"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { GripVertical, Settings2 } from "lucide-react";
import {
  WIDGET_PRESETS,
  type StoredApp,
  type StoredDesigner,
  type WidgetSize,
  type WidgetSizePreset,
} from "@/app/db";
import { ArtifactFrame } from "@/app/components/artifact-frame";
import { detectWidgetEntry } from "@/app/lib/artifact/manifest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const PRESET_ORDER: WidgetSizePreset[] = ["S", "M", "L", "W"];
const LONG_PRESS_MS = 500;
// Pixel threshold past which we treat a pointer as moving (cancels long-press).
const LONG_PRESS_MOVE_PX = 8;

type Props = {
  app: StoredApp;
  designer: StoredDesigner;
  size: WidgetSize;
  /**
   * Forwarded to ArtifactFrame so the widget's artifact.onRefresh() fires
   * once the iframe is ready (mirrors the apps page). A bump from the
   * parent re-fires it without remounting.
   */
  refreshSignal?: number;
  /** User picked a new size from the menu. Caller persists + relays the grid. */
  onResize: (preset: WidgetSizePreset) => void;
  /** User chose "Remove from Home" — caller flips widgetEnabled off + persists. */
  onRemoveFromHome: () => void;
  /** A drag landed on this tile — caller swaps positions and persists. */
  onDropAt: (toAppId: string) => void;
  /** Drag started on this tile — caller sets module-level dragRef. */
  onDragStartTile: (appId: string) => void;
};

/**
 * One cell on the widgets dashboard. Holds a sandboxed widget iframe + the
 * resize/drag affordances. Entire tile is a Link to /apps/{id} that doubles
 * as the scroll container — when widget content exceeds the tile, the Link's
 * overflow-y-auto lets the user pan to see the rest. Iframe pointer-events
 * are off so the browser's native tap-vs-pan discrimination routes taps to
 * the Link's onClick (navigate) and pans to its overflow scroll.
 */
export function WidgetTile({
  app,
  designer,
  size,
  refreshSignal,
  onResize,
  onRemoveFromHome,
  onDropAt,
  onDragStartTile,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Natural body height reported by the widget shell. null until the iframe
  // posts its first widget-content-height. We size the iframe element to
  // this so the Link's overflow-y-auto can scroll when content > tile.
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  // Reset whenever the widget rebuilds (different app/designer pair).
  useEffect(() => {
    setContentHeight(null);
  }, [app.id, designer.id]);

  const supportedSizes =
    designer.manifest?.widget?.supportedSizes ?? PRESET_ORDER;

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    pressOrigin.current = null;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pressOrigin.current = { x: e.clientX, y: e.clientY };
      longPressTimer.current = setTimeout(() => {
        setMenuOpen(true);
        longPressTimer.current = null;
      }, LONG_PRESS_MS);
    },
    []
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!pressOrigin.current) return;
      const dx = e.clientX - pressOrigin.current.x;
      const dy = e.clientY - pressOrigin.current.y;
      if (dx * dx + dy * dy > LONG_PRESS_MOVE_PX * LONG_PRESS_MOVE_PX) {
        cancelLongPress();
      }
    },
    [cancelLongPress]
  );

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenuOpen(true);
  }, []);

  // Pointer-based reorder via the drag handle. Unlike the tile's HTML5 drag
  // (mouse-only), this works on touch too: the handle has touch-action:none so
  // the gesture reorders instead of scrolling, and it's a separate target so it
  // never competes with tap-to-open / long-press-to-resize / pan-to-scroll.
  const dragPointerId = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const onGripPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      cancelLongPress();
      dragPointerId.current = e.pointerId;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture can throw if the pointer is already gone.
      }
      setDragging(true);
      onDragStartTile(app.id);
    },
    [app.id, cancelLongPress, onDragStartTile]
  );

  const finishGripDrag = useCallback(
    (e: React.PointerEvent, toId: string | null) => {
      dragPointerId.current = null;
      setDragging(false);
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      // onDropAt clears the parent's draggingId even when toId === app.id.
      onDropAt(toId ?? app.id);
    },
    [app.id, onDropAt]
  );

  const onGripPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (dragPointerId.current == null) return;
      const el =
        typeof document !== "undefined"
          ? document.elementFromPoint(e.clientX, e.clientY)
          : null;
      const tile = el?.closest("[data-widget-app-id]") as HTMLElement | null;
      finishGripDrag(e, tile?.getAttribute("data-widget-app-id") ?? null);
    },
    [finishGripDrag]
  );

  const onGripPointerCancel = useCallback(
    (e: React.PointerEvent) => {
      if (dragPointerId.current == null) return;
      finishGripDrag(e, null);
    },
    [finishGripDrag]
  );

  return (
    <div
      data-widget-app-id={app.id}
      className={cn(
        "group/widget relative overflow-hidden rounded-lg border transition",
        dragOver
          ? "border-primary/60 ring-1 ring-primary/30"
          : "border-border/60 hover:border-foreground/25",
        dragging && "scale-[0.97] opacity-60"
      )}
      style={gridSpan(size)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/x-widget-app-id", app.id);
        onDragStartTile(app.id);
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(e) => {
        // preventDefault is required to make this a valid drop target.
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onDropAt(app.id);
      }}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerMove={onPointerMove}
    >
      {/* The Link is both the click-shield AND the scroll container — tapping
          anywhere navigates to the full app, panning scrolls overflowing
          widget content. The iframe inside is pointer-events:none so the
          browser's native tap-vs-scroll discrimination drives the Link:
          a tap fires onClick (navigate), a pan scrolls Link's overflow.
          The iframe element is sized to its body's natural scrollHeight
          (reported via postMessage); when the widget fits the tile, height
          stays at 100% and there's nothing to scroll. */}
      <Link
        href={`/apps/${app.id}`}
        aria-label={`Open ${app.name}`}
        // draggable=false so the anchor's default URL-drag doesn't shadow the
        // tile's HTML5 drag (the outer wrapper handles reorder via onDragStart).
        draggable={false}
        className="absolute inset-0 z-10 flex flex-col overflow-y-auto overflow-x-hidden rounded-[inherit]"
      >
        {/* `my-auto` centers a widget that's shorter than the tile (no empty
            void at larger sizes) while letting a taller widget overflow and
            scroll normally — auto margins collapse to 0 when there's no free
            space, so the top isn't clipped the way justify-center would. */}
        <div
          className="w-full my-auto"
          style={{
            height: contentHeight != null ? `${contentHeight}px` : "100%",
          }}
        >
          <ArtifactFrame
            designer={designer}
            app={app}
            widget={{ size }}
            refreshSignal={refreshSignal}
            // The app's configured model must reach EVERY frame mount: the
            // schedule auto-register effect runs here too, and a mount that
            // doesn't know app.model would register the wrong one (the
            // recurring "scheduled run used kimi" bug).
            defaultModel={app.model ?? undefined}
            onWidgetContentHeight={setContentHeight}
            className="pointer-events-none block h-full w-full bg-transparent"
          />
        </div>
      </Link>

      <button
        type="button"
        aria-label="Drag to reorder"
        title="Drag to reorder"
        onPointerDown={onGripPointerDown}
        onPointerUp={onGripPointerUp}
        onPointerCancel={onGripPointerCancel}
        // Block the tile's HTML5 drag when the gesture starts on the handle so
        // only the pointer-based reorder runs.
        onDragStart={(e) => e.preventDefault()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        className="absolute left-1.5 top-1.5 z-20 cursor-grab touch-none rounded-full bg-background/70 p-1 text-muted-foreground opacity-0 transition hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/widget:opacity-100 active:cursor-grabbing [@media(pointer:coarse)]:opacity-100"
      >
        <GripVertical className="h-3.5 w-3.5" strokeWidth={2.2} />
      </button>

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          aria-label="Resize widget"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          className="absolute right-1.5 top-1.5 z-20 pointer-events-none opacity-0 rounded-full bg-background/70 p-1 text-muted-foreground transition hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/widget:pointer-events-auto group-hover/widget:opacity-100 data-popup-open:pointer-events-auto data-popup-open:opacity-100"
        >
          <Settings2 className="h-3.5 w-3.5" strokeWidth={2.2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="z-30">
          {PRESET_ORDER.filter((p) => supportedSizes.includes(p)).map((p) => {
            const meta = WIDGET_PRESETS[p];
            return (
              <DropdownMenuItem
                key={p}
                onClick={() => {
                  onResize(p);
                  setMenuOpen(false);
                }}
                className={cn(p === size.preset && "font-semibold text-foreground")}
              >
                {meta.label}{" "}
                <span className="ml-1 text-xs text-muted-foreground">
                  {meta.cols}×{meta.rows}
                </span>
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              onRemoveFromHome();
              setMenuOpen(false);
            }}
          >
            Remove from Home
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Helper: clamp `cols` to whatever the grid provides at the current
 *  breakpoint. The CSS var `--widget-cols` is set in globals.css. */
export function effectiveCols(rawCols: 1 | 2 | 4, viewportCols: number): number {
  return Math.min(rawCols, viewportCols);
}

function gridSpan(size: WidgetSize): React.CSSProperties {
  return {
    gridColumn: `span ${size.cols}`,
    gridRow: `span ${size.rows}`,
  };
}

/** Re-export so the landing page can use the same `detectWidgetEntry` predicate. */
export { detectWidgetEntry };
