"use client";

import { useSyncExternalStore } from "react";
import {
  applyFontPrefs,
  DEFAULT_FONT_PREFS,
  FONT_PREFS_STORAGE_KEY,
  normalizeFontPrefs,
  readStoredFontPrefs,
  type FontAspectKey,
  type FontPrefs,
} from "@/app/lib/fonts";

// Live store for the per-device font preferences. localStorage alone isn't
// enough — same-tab writes don't fire the "storage" event — so we publish
// through a subscribe/notify pair, exactly like the avatar-style store, so the
// picker (and anything else reading the prefs) updates the instant a choice
// flips. Each write also re-applies the resolved stacks to <html> so the whole
// UI re-skins immediately.

const listeners = new Set<() => void>();
let cached: FontPrefs | null = null;

function snapshot(): FontPrefs {
  if (!cached) cached = readStoredFontPrefs();
  return cached;
}

function persist(next: FontPrefs): void {
  cached = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(FONT_PREFS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore quota / private-mode failures
    }
  }
  applyFontPrefs(next);
  for (const l of listeners) l();
}

export function setFontPref(aspect: FontAspectKey, optionId: string): void {
  persist(normalizeFontPrefs({ ...snapshot(), [aspect]: optionId }));
}

export function resetFontPrefs(): void {
  persist({ ...DEFAULT_FONT_PREFS });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useFontPrefs(): FontPrefs {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_FONT_PREFS);
}
