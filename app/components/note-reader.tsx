"use client";

import { useCallback, useEffect, useState } from "react";
import { AArrowDown, AArrowUp, BookOpen, Sun, Type, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { StoredPinnedNote } from "@/app/db";
import { CodeBlock } from "@/app/components/code-block";

const PREFS_KEY = "artifacts:reader-prefs";

type Size = "sm" | "md" | "lg" | "xl";
type Family = "serif" | "sans";
type Width = "narrow" | "medium" | "wide";

type ReaderPrefs = {
  size: Size;
  family: Family;
  width: Width;
  sepia: boolean;
};

const DEFAULT_PREFS: ReaderPrefs = {
  size: "md",
  family: "serif",
  width: "medium",
  sepia: false,
};

const SIZE_ORDER: Size[] = ["sm", "md", "lg", "xl"];
const WIDTH_ORDER: Width[] = ["narrow", "medium", "wide"];

function readPrefs(): ReaderPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<ReaderPrefs>;
    return {
      size: SIZE_ORDER.includes(parsed.size as Size) ? (parsed.size as Size) : DEFAULT_PREFS.size,
      family: parsed.family === "sans" ? "sans" : "serif",
      width: WIDTH_ORDER.includes(parsed.width as Width)
        ? (parsed.width as Width)
        : DEFAULT_PREFS.width,
      sepia: !!parsed.sepia,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writePrefs(prefs: ReaderPrefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore quota / private-mode failures
  }
}

function useReaderPrefs() {
  const [prefs, setPrefs] = useState<ReaderPrefs>(DEFAULT_PREFS);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setPrefs(readPrefs());
    setMounted(true);
  }, []);

  const update = useCallback((patch: Partial<ReaderPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      writePrefs(next);
      return next;
    });
  }, []);

  return { prefs, update, mounted };
}

function bumpSize(size: Size, delta: 1 | -1): Size {
  const idx = SIZE_ORDER.indexOf(size);
  const next = Math.min(SIZE_ORDER.length - 1, Math.max(0, idx + delta));
  return SIZE_ORDER[next];
}

function cycleWidth(width: Width): Width {
  const idx = WIDTH_ORDER.indexOf(width);
  return WIDTH_ORDER[(idx + 1) % WIDTH_ORDER.length];
}

function widthLabel(width: Width): string {
  return width === "narrow" ? "Narrow" : width === "wide" ? "Wide" : "Medium";
}

export function NoteReader({
  note,
  onClose,
}: {
  note: StoredPinnedNote;
  onClose: () => void;
}) {
  const { prefs, update, mounted } = useReaderPrefs();

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const heading = note.title || note.chatTitle || "Reader";
  const canShrink = prefs.size !== SIZE_ORDER[0];
  const canGrow = prefs.size !== SIZE_ORDER[SIZE_ORDER.length - 1];

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="Note reader"
      data-sepia={prefs.sepia ? "true" : "false"}
      style={{
        paddingTop: "env(safe-area-inset-top)",
        background: "var(--reader-bg, var(--background))",
        color: "var(--reader-fg, var(--foreground))",
      }}
      suppressHydrationWarning
    >
      <div className="flex items-center gap-1 border-b border-border/60 px-2 py-2 text-[11px] backdrop-blur sm:px-3">
        <BookOpen className="ml-1 hidden h-3.5 w-3.5 text-muted-foreground sm:block" />
        <span className="ml-1 hidden truncate text-foreground/80 sm:block sm:max-w-[28ch]">
          {heading}
        </span>

        <div className="ml-0 flex flex-1 flex-wrap items-center justify-end gap-1 sm:ml-3">
          <ReaderIconButton
            label="Decrease text size"
            onClick={() => update({ size: bumpSize(prefs.size, -1) })}
            disabled={!mounted || !canShrink}
          >
            <AArrowDown className="h-4 w-4" />
          </ReaderIconButton>
          <ReaderIconButton
            label="Increase text size"
            onClick={() => update({ size: bumpSize(prefs.size, 1) })}
            disabled={!mounted || !canGrow}
          >
            <AArrowUp className="h-4 w-4" />
          </ReaderIconButton>

          <ReaderTextButton
            label={
              prefs.family === "serif"
                ? "Switch to sans-serif"
                : "Switch to serif"
            }
            onClick={() =>
              update({ family: prefs.family === "serif" ? "sans" : "serif" })
            }
            disabled={!mounted}
          >
            <Type className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">
              {prefs.family === "serif" ? "Serif" : "Sans"}
            </span>
          </ReaderTextButton>

          <ReaderTextButton
            label={`Width: ${widthLabel(prefs.width)} — tap to cycle`}
            onClick={() => update({ width: cycleWidth(prefs.width) })}
            disabled={!mounted}
          >
            <span className="font-mono text-[10px]">
              {prefs.width === "narrow"
                ? "[ • ]"
                : prefs.width === "wide"
                ? "[   ]"
                : "[ — ]"}
            </span>
            <span className="hidden sm:inline">{widthLabel(prefs.width)}</span>
          </ReaderTextButton>

          <ReaderIconButton
            label={prefs.sepia ? "Disable sepia" : "Enable sepia"}
            onClick={() => update({ sepia: !prefs.sepia })}
            disabled={!mounted}
            pressed={prefs.sepia}
          >
            <Sun className="h-4 w-4" />
          </ReaderIconButton>

          <button
            type="button"
            onClick={onClose}
            className="tap ml-1 inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition hover:text-foreground"
            aria-label="Close reader"
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        className="scroll-area flex-1"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <article
          className="note-reader prose mx-auto break-words px-5 py-10 sm:px-8 sm:py-14"
          data-size={prefs.size}
          data-family={prefs.family}
          data-width={prefs.width}
        >
          {note.title ? <h1>{note.title}</h1> : null}
          {note.chatTitle && note.chatTitle !== note.title ? (
            <p className="note-reader-byline">From “{note.chatTitle}”</p>
          ) : null}

          <ReaderBody note={note} />
        </article>
      </div>
    </div>
  );
}

function ReaderBody({ note }: { note: StoredPinnedNote }) {
  if (note.messageMarkdown && note.messageMarkdown.trim()) {
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>
        {note.messageMarkdown}
      </ReactMarkdown>
    );
  }
  if (note.chatSnapshot && note.chatSnapshot.messages.length) {
    return (
      <div className="flex flex-col gap-6">
        {note.chatSnapshot.messages.map((m, i) => (
          <section key={i} className="flex flex-col gap-1">
            <div className="note-reader-role">{m.role}</div>
            <div className="whitespace-pre-wrap">{m.content}</div>
          </section>
        ))}
      </div>
    );
  }
  return (
    <p className="text-muted-foreground italic">
      This note has no readable body. Open the source chat or artifact instead.
    </p>
  );
}

function ReaderIconButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={
        "tap inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition hover:text-foreground disabled:opacity-40" +
        (pressed ? " text-primary" : "")
      }
    >
      {children}
    </button>
  );
}

function ReaderTextButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="tap inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-muted-foreground transition hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  );
}
