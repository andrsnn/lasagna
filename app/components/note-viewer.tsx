"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { StoredPinnedNote } from "@/app/db";
import { CodeBlock } from "@/app/components/code-block";
import { PaperPill } from "@/app/components/paper-pill";
import { gradientCss, relativeTime } from "@/app/lib/visuals";

/**
 * Full-screen view of a note that mirrors the card's native styling — the
 * same header, pills, and body layout as the Notes list, just un-clamped so
 * the whole note is visible. Distinct from NoteReader, which intentionally
 * re-renders the note in a separate distraction-free typography mode.
 */
export function NoteViewer({
  note,
  onClose,
}: {
  note: StoredPinnedNote;
  onClose: () => void;
}) {
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

  const hasArtifact = !!note.artifactHtml;
  const hasMessage = !!note.messageMarkdown;
  const hasSnapshot = !!note.chatSnapshot;
  const empty = !hasArtifact && !hasMessage && !hasSnapshot;
  // When the note is nothing but an artifact, the viewer should behave like a
  // true fullscreen preview: let the iframe fill the whole frame edge-to-edge
  // rather than boxing it inside a capped, max-width card.
  const artifactOnly = hasArtifact && !hasMessage && !hasSnapshot;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-background text-foreground"
      role="dialog"
      aria-modal="true"
      aria-label="Note"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="flex items-center gap-3 border-b border-border/60 px-3 py-2">
        <div
          className="h-9 w-9 shrink-0 rounded-xl border border-border"
          style={{ background: gradientCss(note.chatId ?? note.id) }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {hasArtifact && <PaperPill tone="neutral">Artifact</PaperPill>}
            {hasMessage && <PaperPill tone="neutral">Message</PaperPill>}
            {hasSnapshot && <PaperPill tone="neutral">Chat copy</PaperPill>}
          </div>
          {note.title ? (
            <div className="mt-0.5 truncate text-sm font-medium text-foreground">
              {note.title}
            </div>
          ) : null}
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {note.chatTitle ? `From “${note.chatTitle}”` : "Pinned note"}
            <span className="font-mono tabular-nums"> · {relativeTime(note.createdAt)}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close (Esc)"
          className="tap inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {artifactOnly ? (
        <iframe
          title="Pinned artifact"
          srcDoc={note.artifactHtml}
          sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups"
          className="block min-h-0 w-full flex-1 border-0 bg-white"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        />
      ) : (
      <div
        className="scroll-area flex-1"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
          {hasArtifact && (
            <div className="overflow-hidden rounded-xl border border-border/60">
              <iframe
                title="Pinned artifact"
                srcDoc={note.artifactHtml}
                sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups"
                className="block h-[min(70svh,640px)] min-h-[320px] w-full border-0 bg-white"
              />
            </div>
          )}

          {hasMessage && (
            <div>
              <div className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {note.chatId ? "Message" : "Note"}
              </div>
              <div className="note-prose prose prose-sm max-w-none break-words">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>
                  {note.messageMarkdown ?? ""}
                </ReactMarkdown>
              </div>
            </div>
          )}

          {hasSnapshot && (
            <div>
              <div className="mb-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Chat copy · {note.chatSnapshot!.messages.length} message
                {note.chatSnapshot!.messages.length === 1 ? "" : "s"}
              </div>
              <div className="flex flex-col gap-3 text-sm">
                {note.chatSnapshot!.messages.map((m, i) => (
                  <div key={i} className="flex flex-col gap-0.5">
                    <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                      {m.role}
                    </div>
                    <div className="whitespace-pre-wrap break-words text-foreground/90">
                      {m.content}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {empty && (
            <p className="text-sm italic text-muted-foreground">
              This note has no body content.
            </p>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
