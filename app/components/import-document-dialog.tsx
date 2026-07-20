"use client";

// Import a .docx or .pdf into the note canvas. We convert the document to a
// self-contained HTML page (preserving formatting for docx; best-effort text +
// headings for pdf), store it as a note's `artifactHtml`, then drop the user
// straight into the existing canvas editor at /notes/[id]/canvas — where the
// preview iframe, raw-HTML textarea, and AI tools edit it, and the export dialog
// turns it back into docx/pdf/markdown.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, FileText, Loader2, UploadCloud } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { newId, putPinnedNote, type StoredPinnedNote } from "@/app/db";
import { docxToNoteHtml, titleFromFilename } from "@/app/lib/import-doc";
import { pdfToNoteHtml } from "@/app/lib/pdf";

type Stage =
  | { kind: "idle" }
  | { kind: "converting"; name: string }
  | { kind: "error"; message: string };

export type ImportDocumentDialogProps = {
  open: boolean;
  onClose: () => void;
  onCreated?: (note: StoredPinnedNote) => void;
};

const ACCEPT =
  ".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function kindForFile(file: File): "docx" | "pdf" | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx")) return "docx";
  if (name.endsWith(".pdf")) return "pdf";
  if (file.type === "application/pdf") return "pdf";
  if (
    file.type ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return "docx";
  return null;
}

export function ImportDocumentDialog({
  open,
  onClose,
  onCreated,
}: ImportDocumentDialogProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStage({ kind: "idle" });
    setDragOver(false);
  }, [open]);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      const kind = kindForFile(file);
      if (!kind) {
        setStage({
          kind: "error",
          message:
            "Only .docx and .pdf are supported. (Legacy .doc isn't — re-save it as .docx first.)",
        });
        return;
      }
      setStage({ kind: "converting", name: file.name });
      try {
        const html =
          kind === "docx" ? await docxToNoteHtml(file) : await pdfToNoteHtml(file);
        const now = Date.now();
        const note: StoredPinnedNote = {
          id: newId(),
          createdAt: now,
          updatedAt: now,
          title: titleFromFilename(file.name),
          artifactHtml: html,
        };
        await putPinnedNote(note);
        onCreated?.(note);
        router.push(`/notes/${note.id}/canvas`);
      } catch (err) {
        setStage({
          kind: "error",
          message: err instanceof Error ? err.message : "Couldn't import that file.",
        });
      }
    },
    [onCreated, router]
  );

  const busy = stage.kind === "converting";

  return (
    <Dialog open={open} onOpenChange={(v) => (!v && !busy ? onClose() : null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Import document
          </DialogTitle>
          <DialogDescription>
            Import a Word (.docx) or PDF file. It opens in the canvas editor so you
            can edit it with formatting intact, then export back to docx, PDF, or
            markdown.
          </DialogDescription>
        </DialogHeader>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            void handleFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />

        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (!busy) void handleFile(e.dataTransfer.files?.[0]);
          }}
          className={
            "flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center text-sm transition " +
            (dragOver
              ? "border-foreground/40 bg-muted/50"
              : "border-border bg-muted/20 hover:bg-muted/40") +
            (busy ? " opacity-70" : "")
          }
        >
          {busy ? (
            <>
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="text-foreground">Converting {stage.name}…</span>
            </>
          ) : (
            <>
              <UploadCloud className="h-6 w-6 text-muted-foreground" />
              <span className="font-medium text-foreground">
                Drop a .docx or .pdf here, or click to choose
              </span>
              <span className="text-xs text-muted-foreground">
                Word documents keep full formatting.
              </span>
            </>
          )}
        </button>

        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            PDF import extracts text and headings — original fonts, exact layout,
            columns, and images aren&apos;t preserved. For best fidelity, import the
            original .docx.
          </span>
        </p>

        {stage.kind === "error" && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {stage.message}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
