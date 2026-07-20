"use client";

import { useSyncExternalStore } from "react";

// Per-device chat avatar style. Cosmetic and may legitimately differ between
// devices, so this lives in localStorage rather than the Settings table in
// IndexedDB. localStorage alone isn't enough though — same-tab writes don't
// fire the "storage" event — so we publish through a tiny subscribe/notify
// pair that lets the chats list react the moment the toggle flips in the
// Preferences dialog.

export type AvatarStyle = "ink" | "friendly" | "kawaii" | "pixel";

export const AVATAR_STYLES: { id: AvatarStyle; label: string; hint: string }[] = [
  {
    id: "ink",
    label: "Ink",
    hint: "Quiet line-drawn creature on paper, in the reader palette.",
  },
  {
    id: "friendly",
    label: "Friendly",
    hint: "Soft gradient blob with a cute emoji-style face.",
  },
  {
    id: "kawaii",
    label: "Kawaii",
    hint: "Extra-cute big eyes, smile, and blush on every avatar.",
  },
  {
    id: "pixel",
    label: "Pixel",
    hint: "Retro pixel-art alien creatures on a dark screen.",
  },
];

export const DEFAULT_AVATAR_STYLE: AvatarStyle = "ink";

const STORAGE_KEY = "avatar.style";
const listeners = new Set<() => void>();
let cached: AvatarStyle | null = null;

function isAvatarStyle(v: string | null): v is AvatarStyle {
  return v === "ink" || v === "friendly" || v === "kawaii" || v === "pixel";
}

function readAvatarStyle(): AvatarStyle {
  if (cached) return cached;
  if (typeof window === "undefined") return DEFAULT_AVATAR_STYLE;
  const saved = window.localStorage.getItem(STORAGE_KEY);
  cached = isAvatarStyle(saved) ? saved : DEFAULT_AVATAR_STYLE;
  return cached;
}

export function setAvatarStyle(next: AvatarStyle): void {
  cached = next;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, next);
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useAvatarStyle(): AvatarStyle {
  return useSyncExternalStore(subscribe, readAvatarStyle, () => DEFAULT_AVATAR_STYLE);
}
