"use client";

// Promise-based confirmation dialog, styled on the app's Dialog primitive.
//
// Replaces native window.confirm() (unstyled, not theme-aware, blocked in some
// PWAs). Like the toast helper it's globally callable from anywhere:
//
//   if (await confirm({ title: "Delete note?", destructive: true })) { … }
//
// A single <ConfirmHost/> mounted in the root layout renders the active
// request; concurrent calls queue and resolve in order.

import { useSyncExternalStore } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type ConfirmOptions = {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type Request = ConfirmOptions & {
  id: number;
  resolve: (ok: boolean) => void;
};

let queue: Request[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  queue = queue.slice();
  listeners.forEach((l) => l());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getSnapshot() {
  return queue;
}
const EMPTY: Request[] = [];
function getServerSnapshot() {
  return EMPTY;
}

/** Show a confirm dialog; resolves true if confirmed, false otherwise. */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue = [...queue, { ...opts, id: nextId++, resolve }];
    emit();
  });
}

function settle(id: number, ok: boolean) {
  const req = queue.find((r) => r.id === id);
  if (!req) return;
  queue = queue.filter((r) => r.id !== id);
  emit();
  req.resolve(ok);
}

export function ConfirmHost() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const current = list[0] ?? null;
  return (
    <Dialog
      open={current !== null}
      onOpenChange={(open) => {
        if (!open && current) settle(current.id, false);
      }}
    >
      {current && (
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{current.title}</DialogTitle>
            {current.body && (
              <DialogDescription>{current.body}</DialogDescription>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => settle(current.id, false)}
            >
              {current.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={current.destructive ? "destructive" : "default"}
              autoFocus
              onClick={() => settle(current.id, true)}
            >
              {current.confirmLabel ?? "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
