"use client";

import { useSyncExternalStore } from "react";

// Whether to show the Lasagna "L" mark next to panel titles ("🅛 Chats",
// "🅛 Widgets", …). Cosmetic and per-device, so it lives in localStorage
// rather than the Settings table in IndexedDB. localStorage alone isn't
// enough though — same-tab writes don't fire the "storage" event — so we
// publish through a tiny subscribe/notify pair so every panel header reacts
// the moment the toggle flips in the Preferences dialog.

export const DEFAULT_SHOW_TITLE_LOGO = true;

const STORAGE_KEY = "titleLogo.show";
const listeners = new Set<() => void>();
let cached: boolean | null = null;

function readShowTitleLogo(): boolean {
  if (cached !== null) return cached;
  if (typeof window === "undefined") return DEFAULT_SHOW_TITLE_LOGO;
  const saved = window.localStorage.getItem(STORAGE_KEY);
  cached = saved === null ? DEFAULT_SHOW_TITLE_LOGO : saved === "1";
  return cached;
}

export function setShowTitleLogo(next: boolean): void {
  cached = next;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useShowTitleLogo(): boolean {
  return useSyncExternalStore(subscribe, readShowTitleLogo, () => DEFAULT_SHOW_TITLE_LOGO);
}
