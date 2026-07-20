"use client";

import { useEffect, useState } from "react";

export type DesignerSort = "edited" | "created" | "name";
export type WidgetSort = "manual" | "edited" | "created" | "name";
export type NoteSort = "edited" | "created";
export type ChatSort = "activity" | "created" | "oldest" | "name";

const DESIGNER_KEY = "artifacts.sort.designers";
const WIDGET_KEY = "artifacts.sort.widgets";
const NOTE_KEY = "artifacts.sort.notes";
const CHAT_KEY = "artifacts.sort.chats";

const DESIGNER_VALUES: DesignerSort[] = ["edited", "created", "name"];
const WIDGET_VALUES: WidgetSort[] = ["manual", "edited", "created", "name"];
const NOTE_VALUES: NoteSort[] = ["edited", "created"];
const CHAT_VALUES: ChatSort[] = ["activity", "created", "oldest", "name"];

function readPref<T extends string>(key: string, allowed: T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    if (v && (allowed as string[]).includes(v)) return v as T;
  } catch {
    // ignore
  }
  return fallback;
}

function writePref(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export function useDesignerSort(): [DesignerSort, (v: DesignerSort) => void] {
  const [value, setValue] = useState<DesignerSort>("edited");
  useEffect(() => {
    setValue(readPref(DESIGNER_KEY, DESIGNER_VALUES, "edited"));
  }, []);
  const set = (v: DesignerSort) => {
    setValue(v);
    writePref(DESIGNER_KEY, v);
  };
  return [value, set];
}

export function useNoteSort(): [NoteSort, (v: NoteSort) => void] {
  const [value, setValue] = useState<NoteSort>("edited");
  useEffect(() => {
    setValue(readPref(NOTE_KEY, NOTE_VALUES, "edited"));
  }, []);
  const set = (v: NoteSort) => {
    setValue(v);
    writePref(NOTE_KEY, v);
  };
  return [value, set];
}

export function useChatSort(): [ChatSort, (v: ChatSort) => void] {
  const [value, setValue] = useState<ChatSort>("activity");
  useEffect(() => {
    setValue(readPref(CHAT_KEY, CHAT_VALUES, "activity"));
  }, []);
  const set = (v: ChatSort) => {
    setValue(v);
    writePref(CHAT_KEY, v);
  };
  return [value, set];
}

export function useWidgetSort(): [WidgetSort, (v: WidgetSort) => void] {
  const [value, setValue] = useState<WidgetSort>("manual");
  useEffect(() => {
    setValue(readPref(WIDGET_KEY, WIDGET_VALUES, "manual"));
  }, []);
  const set = (v: WidgetSort) => {
    setValue(v);
    writePref(WIDGET_KEY, v);
  };
  return [value, set];
}
