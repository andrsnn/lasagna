"use client";

// App-wide toast / feedback system.
//
// Deliberately dependency-free and context-free: a module-level store backs a
// global `toast()` helper that can be called from anywhere — event handlers,
// async catch blocks, even non-React code — without threading a provider
// through the tree. A single <Toaster/> mounted in the root layout subscribes
// to the store and renders the stack. Motion is handled by tw-animate-css
// classes, which the global prefers-reduced-motion block already neutralizes.

import { useSyncExternalStore } from "react";
import { Check, Info, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastVariant = "default" | "success" | "error";

export type ToastItem = {
  id: number;
  message: string;
  variant: ToastVariant;
  /** ms before auto-dismiss; 0 means it stays until dismissed. */
  duration: number;
};

type Options = { variant?: ToastVariant; duration?: number };

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  // New array reference so useSyncExternalStore sees a change.
  items = items.slice();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return items;
}

const EMPTY: ToastItem[] = [];
function getServerSnapshot() {
  return EMPTY;
}

function dismiss(id: number) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  const before = items.length;
  items = items.filter((it) => it.id !== id);
  if (items.length !== before) emit();
}

function show(message: string, opts: Options = {}): number {
  const variant = opts.variant ?? "default";
  const duration =
    opts.duration ?? (variant === "error" ? 6000 : 4000);
  const id = nextId++;
  items = [...items, { id, message, variant, duration }];
  emit();
  if (duration > 0) {
    timers.set(
      id,
      setTimeout(() => dismiss(id), duration)
    );
  }
  return id;
}

/**
 * Global toast helper. `toast("Saved")`, `toast.success(...)`,
 * `toast.error(...)`, `toast.dismiss(id)`.
 */
export const toast = Object.assign(
  (message: string, opts?: Options) => show(message, opts),
  {
    success: (message: string, opts?: Options) =>
      show(message, { ...opts, variant: "success" }),
    error: (message: string, opts?: Options) =>
      show(message, { ...opts, variant: "error" }),
    dismiss,
  }
);

const variantStyles: Record<ToastVariant, string> = {
  default: "border-border bg-popover text-popover-foreground",
  success:
    "border-[color-mix(in_oklab,var(--color-accent-2)_35%,transparent)] bg-popover text-popover-foreground",
  error: "border-destructive/30 bg-popover text-popover-foreground",
};

const Icon = {
  default: Info,
  success: Check,
  error: TriangleAlert,
} as const;

const iconColor: Record<ToastVariant, string> = {
  default: "text-muted-foreground",
  success: "text-[var(--color-accent-2)]",
  error: "text-destructive",
};

export function Toaster() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (list.length === 0) return null;
  return (
    <div
      // Sits above dialogs (z-50) and the bottom nav; clicks pass through the
      // container, only the cards capture pointer events.
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 px-3 pb-[calc(env(safe-area-inset-bottom)+5rem)] sm:items-end sm:px-4"
      role="region"
      aria-label="Notifications"
    >
      {list.map((t) => {
        const ToastIcon = Icon[t.variant];
        return (
          <div
            key={t.id}
            role="status"
            aria-live={t.variant === "error" ? "assertive" : "polite"}
            className={cn(
              "pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm shadow-lg ring-1 ring-foreground/5 backdrop-blur",
              "animate-in fade-in-0 slide-in-from-bottom-2 duration-150",
              variantStyles[t.variant]
            )}
          >
            <ToastIcon
              className={cn("mt-0.5 h-4 w-4 shrink-0", iconColor[t.variant])}
            />
            <span className="min-w-0 flex-1 break-words">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
