"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Download, FileText, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { StoredPinnedNote } from "@/app/db";
import {
  buildNoteMarkdown,
  downloadNote,
  type ExportFormat,
} from "@/app/lib/export-note";

type Stage =
  | { kind: "idle" }
  | { kind: "exporting" }
  | { kind: "done" }
  | { kind: "error"; message: string };

export type ExportNoteDialogProps = {
  open: boolean;
  note: StoredPinnedNote | null;
  onClose: () => void;
};

const FORMATS: Array<{ value: ExportFormat; label: string; ext: string }> = [
  { value: "markdown", label: "Markdown", ext: "md" },
  { value: "docx", label: "DOCX", ext: "docx" },
  { value: "pdf", label: "PDF", ext: "pdf" },
];

// Named page-margin presets, in PostScript points (72pt = 1in). Kept here (not
// imported from export-artifact-pdf) so the dialog doesn't eagerly bundle that
// lazy-loaded module; the resolved pt value is passed straight through to it.
const MARGIN_PRESETS: Array<{ key: string; label: string; pt: number }> = [
  { key: "none", label: "None", pt: 0 },
  { key: "narrow", label: "Narrow", pt: 36 },
  { key: "normal", label: "Normal", pt: 54 },
  { key: "wide", label: "Wide", pt: 72 },
];
const DEFAULT_MARGIN_KEY = "normal";

// A4 geometry for the live preview. The PDF renders the artifact at A4_PX wide
// and scales it to fit the content area; the preview mirrors that exactly.
const A4_W_PX = 794;
const A4_H_PX = 1123;
const A4_W_PT = 595.28;
// Fixed preview page width (px). Small enough to fit the dialog on a phone.
const PREVIEW_PAGE_W = 300;

export function ExportNoteDialog({ open, note, onClose }: ExportNoteDialogProps) {
  const [format, setFormat] = useState<ExportFormat>("markdown");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [smartPageBreaks, setSmartPageBreaks] = useState(true);
  const [marginKey, setMarginKey] = useState(DEFAULT_MARGIN_KEY);

  useEffect(() => {
    if (!open) return;
    setFormat("markdown");
    setStage({ kind: "idle" });
    setSmartPageBreaks(true);
    setMarginKey(DEFAULT_MARGIN_KEY);
  }, [open]);

  const marginPt =
    MARGIN_PRESETS.find((m) => m.key === marginKey)?.pt ?? 54;

  // Live preview geometry. Mirrors the exporter: the artifact is rendered at
  // A4_W_PX wide and scaled to fit the content area (sheet minus a uniform
  // margin), so the framed page below matches the produced PDF's page 1.
  const previewPad = (marginPt / A4_W_PT) * PREVIEW_PAGE_W;
  const previewPageH = PREVIEW_PAGE_W * (A4_H_PX / A4_W_PX);
  const previewContentW = PREVIEW_PAGE_W - previewPad * 2;
  const previewContentH = previewPageH - previewPad * 2;
  const previewScale = previewContentW / A4_W_PX;

  const markdown = useMemo(
    () => (note ? buildNoteMarkdown(note) : ""),
    [note]
  );

  const handleDownload = useCallback(async () => {
    if (!note) return;
    setStage({ kind: "exporting" });
    try {
      await downloadNote(note, format, { smartPageBreaks, marginPt });
      setStage({ kind: "done" });
      setTimeout(() => onClose(), 600);
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : "Export failed.",
      });
    }
  }, [note, format, onClose, smartPageBreaks, marginPt]);

  const activeFormat = FORMATS.find((f) => f.value === format)!;
  const hasHtml = !!note?.artifactHtml;

  const helpText = hasHtml
    ? format === "markdown"
      ? "Exports the document as plain text — formatting is dropped. Use DOCX or PDF to keep it."
      : format === "docx"
        ? "Exports the formatted document to Word (headings, lists, tables, and images)."
        : "Downloads a PDF that matches the on-screen formatting."
    : format === "markdown"
      ? "Preview shows raw markdown (the literal file contents)."
      : format === "docx"
        ? "Preview shows rendered markdown. DOCX uses simple heading/bullet/paragraph styling."
        : "Preview is approximate; final PDF lays text out on A4 pages.";

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-4 w-4" />
            Export note
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-xs">
          <fieldset className="flex flex-wrap gap-1.5">
            <legend className="sr-only">Format</legend>
            {FORMATS.map((f) => {
              const active = f.value === format;
              return (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFormat(f.value)}
                  disabled={stage.kind === "exporting"}
                  className={
                    "rounded-md border px-2.5 py-1 text-[11px] font-medium transition " +
                    (active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground hover:text-foreground")
                  }
                  aria-pressed={active}
                >
                  {f.label}
                </button>
              );
            })}
          </fieldset>

          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <FileText className="h-3 w-3" />
            {helpText}
          </div>

          {format === "pdf" && hasHtml ? (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="mr-0.5 font-medium text-foreground">Margins</span>
              {MARGIN_PRESETS.map((m) => {
                const active = m.key === marginKey;
                return (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => setMarginKey(m.key)}
                    disabled={stage.kind === "exporting"}
                    className={
                      "rounded-md border px-2 py-0.5 text-[11px] font-medium transition " +
                      (active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-card text-muted-foreground hover:text-foreground")
                    }
                    aria-pressed={active}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          ) : null}

          {format === "pdf" && hasHtml ? (
            <label className="flex items-start gap-2 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={smartPageBreaks}
                onChange={(e) => setSmartPageBreaks(e.target.checked)}
                disabled={stage.kind === "exporting"}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
              />
              <span>
                <span className="font-medium text-foreground">
                  Avoid splitting lines across pages
                </span>
                {" — "}
                {smartPageBreaks
                  ? "page breaks snap to blank space so no line is cut in half."
                  : "pages are cut at exact A4 height (a line may be split mid-text)."}
              </span>
            </label>
          ) : null}

          <div className="max-h-[60dvh] overflow-y-auto rounded-md border border-border bg-card px-3 py-2">
            {format === "markdown" ? (
              <pre className="text-[11px] leading-relaxed break-words whitespace-pre-wrap font-mono text-foreground">
                {markdown}
              </pre>
            ) : hasHtml && format === "pdf" ? (
              // Print-preview page: an A4 sheet with the chosen margins. The
              // artifact is rendered at A4 width and scaled into the content area,
              // so this matches page 1 of the downloaded PDF.
              <div className="flex justify-center rounded bg-muted/40 py-3">
                <div
                  className="shrink-0 overflow-hidden bg-white shadow-md ring-1 ring-black/10"
                  style={{
                    width: PREVIEW_PAGE_W,
                    height: previewPageH,
                    padding: previewPad,
                    boxSizing: "border-box",
                  }}
                >
                  <div
                    className="relative overflow-hidden bg-white"
                    style={{ width: previewContentW, height: previewContentH }}
                  >
                    <iframe
                      title="PDF preview"
                      srcDoc={note?.artifactHtml}
                      sandbox="allow-scripts"
                      style={{
                        width: A4_W_PX,
                        height: previewContentH / previewScale,
                        border: 0,
                        background: "#fff",
                        transform: `scale(${previewScale})`,
                        transformOrigin: "top left",
                        pointerEvents: "none",
                      }}
                    />
                  </div>
                </div>
              </div>
            ) : hasHtml ? (
              <iframe
                title="Document preview"
                srcDoc={note?.artifactHtml}
                sandbox="allow-scripts"
                className="h-[60dvh] w-full border-0 bg-white"
              />
            ) : (
              <div className="note-prose prose prose-sm max-w-none break-words">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {note?.messageMarkdown ?? ""}
                </ReactMarkdown>
              </div>
            )}
          </div>
        </div>

        {stage.kind === "error" ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {stage.message}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={stage.kind === "exporting"}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleDownload()}
            disabled={!note || stage.kind === "exporting" || stage.kind === "done"}
            className="gap-1.5"
          >
            {stage.kind === "exporting" ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Exporting…
              </>
            ) : stage.kind === "done" ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Downloaded
              </>
            ) : (
              <>
                <Download className="h-3.5 w-3.5" />
                Download .{activeFormat.ext}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
