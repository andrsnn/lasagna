"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Download, FileText, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { loadMessages, type StoredChat, type StoredMessage } from "@/app/db";
import {
  buildChatDebugJson,
  buildChatMarkdown,
  buildChatText,
  downloadChat,
  type ChatExportFormat,
} from "@/app/lib/export-chat";

type Stage =
  | { kind: "idle" }
  | { kind: "exporting" }
  | { kind: "copying" }
  | { kind: "copied" }
  | { kind: "done" }
  | { kind: "error"; message: string };

const FORMATS: Array<{ value: ChatExportFormat; label: string; ext: string }> = [
  { value: "markdown", label: "Markdown", ext: "md" },
  { value: "text", label: "Plain text", ext: "txt" },
  { value: "json", label: "JSON (debug)", ext: "json" },
];

export function ExportChatDialog({
  open,
  onClose,
  chat,
}: {
  open: boolean;
  onClose: () => void;
  chat: StoredChat | null;
}) {
  const [format, setFormat] = useState<ChatExportFormat>("markdown");
  const [includeThinking, setIncludeThinking] = useState(false);
  const [messages, setMessages] = useState<StoredMessage[] | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });

  useEffect(() => {
    if (!open) return;
    setFormat("markdown");
    setIncludeThinking(false);
    setStage({ kind: "idle" });
  }, [open]);

  useEffect(() => {
    if (!open || !chat) {
      setMessages(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const all = await loadMessages(chat.id);
      if (!cancelled) setMessages(all);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, chat]);

  const preview = useMemo(() => {
    if (!chat || !messages) return "";
    if (format === "json") return buildChatDebugJson(chat, messages);
    const opts = { includeThinking };
    return format === "markdown"
      ? buildChatMarkdown(chat, messages, opts)
      : buildChatText(chat, messages, opts);
  }, [chat, messages, format, includeThinking]);

  const handleDownload = useCallback(() => {
    if (!chat || !messages) return;
    setStage({ kind: "exporting" });
    try {
      downloadChat(chat, messages, format, { includeThinking });
      setStage({ kind: "done" });
      setTimeout(() => onClose(), 600);
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : "Export failed.",
      });
    }
  }, [chat, messages, format, includeThinking, onClose]);

  const handleCopy = useCallback(async () => {
    if (!chat || !messages || !preview) return;
    setStage({ kind: "copying" });
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(preview);
      } else {
        const ta = document.createElement("textarea");
        ta.value = preview;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setStage({ kind: "copied" });
      setTimeout(() => {
        setStage((s) => (s.kind === "copied" ? { kind: "idle" } : s));
      }, 1500);
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : "Copy failed.",
      });
    }
  }, [chat, messages, preview]);

  const activeFormat = FORMATS.find((f) => f.value === format)!;
  const ready = !!chat && !!messages;

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-4 w-4" />
            Export chat
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

          {format === "json" ? (
            <p className="text-[11px] text-muted-foreground">
              Full raw chat data (messages, artifacts, metadata) for debugging or
              moving to another device. Large image/PDF blobs are elided. Nothing
              is rendered, so this works even when opening the chat crashes.
            </p>
          ) : (
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={includeThinking}
                onChange={(e) => setIncludeThinking(e.target.checked)}
                disabled={stage.kind === "exporting"}
              />
              Include assistant reasoning (thinking) when present
            </label>
          )}

          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <FileText className="h-3 w-3" />
            {ready
              ? `${messages?.length ?? 0} messages · all roles included`
              : "Loading messages…"}
          </div>

          <div className="max-h-[60dvh] overflow-y-auto rounded-md border border-border bg-card px-3 py-2">
            {ready ? (
              <pre className="text-[11px] leading-relaxed break-words whitespace-pre-wrap font-mono text-foreground">
                {preview}
              </pre>
            ) : (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading…
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
            disabled={stage.kind === "exporting" || stage.kind === "copying"}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={handleCopy}
            disabled={
              !ready ||
              stage.kind === "exporting" ||
              stage.kind === "copying" ||
              stage.kind === "done"
            }
            className="gap-1.5"
          >
            {stage.kind === "copying" ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Copying…
              </>
            ) : stage.kind === "copied" ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy
              </>
            )}
          </Button>
          <Button
            onClick={handleDownload}
            disabled={
              !ready ||
              stage.kind === "exporting" ||
              stage.kind === "copying" ||
              stage.kind === "done"
            }
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
