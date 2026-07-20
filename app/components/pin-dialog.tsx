"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Pencil, Pin } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getPinnedNote,
  putPinnedNote,
  type StoredMessage,
  type StoredPinnedNote,
} from "@/app/db";

type Stage =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export type PinDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Pre-supplied HTML body when the dialog was launched from an artifact card. */
  artifactHtml?: string;
  /** Pre-supplied markdown when the dialog was launched from a message bubble. */
  messageMarkdown?: string;
  /** Source chat id — unlocks "include chat link" and "include chat copy" options. */
  chatId?: string;
  chatTitle?: string;
  /** Source message id — recorded on the pin for traceability. */
  messageId?: string;
  /** Short human-facing summary recorded on the pin. */
  summary?: string;
  /**
   * Lazy loader for the chat transcript — only invoked when the user actually
   * checks "include a copy of the chat" so we don't pay the IDB read otherwise.
   */
  loadMessagesForSnapshot?: () => Promise<StoredMessage[]>;
  /**
   * Set when this chat was spawned from a pinned note (via Notes → Chat &
   * Edit). When the originating pin still exists, the dialog offers an
   * "override the original" save mode that overwrites the existing row in
   * place rather than creating a fresh one.
   */
  sourcePinId?: string;
};

/**
 * Lightweight dialog that lets the user pin an artifact and/or a chat message
 * into the /notes collection. The checkboxes are independent so a single
 * pin can carry any combination of: artifact, message prose, link back to
 * chat, or an embedded chat-transcript copy.
 */
export function PinDialog({
  open,
  onClose,
  artifactHtml,
  messageMarkdown,
  chatId,
  chatTitle,
  messageId,
  summary,
  loadMessagesForSnapshot,
  sourcePinId,
}: PinDialogProps) {
  const router = useRouter();
  const hasArtifact = !!artifactHtml;
  const hasMessage = !!messageMarkdown;
  const hasChat = !!chatId;

  // Defaults: artifact-on by default when present; otherwise message-on.
  const [title, setTitle] = useState("");
  const [includeArtifact, setIncludeArtifact] = useState(hasArtifact);
  const [includeMessage, setIncludeMessage] = useState(!hasArtifact && hasMessage);
  const [includeLink, setIncludeLink] = useState(hasChat);
  const [includeChatCopy, setIncludeChatCopy] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [originalPin, setOriginalPin] = useState<StoredPinnedNote | null>(null);
  const [saveMode, setSaveMode] = useState<"override" | "new">("override");

  // Reset whenever the dialog reopens for a fresh target so the checkboxes
  // don't carry leftover state across different pin sources.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setIncludeArtifact(hasArtifact);
    setIncludeMessage(!hasArtifact && hasMessage);
    setIncludeLink(hasChat);
    setIncludeChatCopy(false);
    setStage({ kind: "idle" });
    setSaveMode("override");
  }, [open, hasArtifact, hasMessage, hasChat]);

  // Look up the originating pin (if any) so we can offer "override original"
  // as a save mode. If it was deleted between flows we fall back to save-as-new.
  useEffect(() => {
    if (!open || !sourcePinId) {
      setOriginalPin(null);
      return;
    }
    let cancelled = false;
    void getPinnedNote(sourcePinId).then((p) => {
      if (cancelled) return;
      setOriginalPin(p ?? null);
      if (p?.title) setTitle(p.title);
    });
    return () => {
      cancelled = true;
    };
  }, [open, sourcePinId]);

  const canSave = useMemo(
    () =>
      (includeArtifact && hasArtifact) ||
      (includeMessage && hasMessage) ||
      includeChatCopy ||
      includeLink,
    [includeArtifact, includeMessage, includeChatCopy, includeLink, hasArtifact, hasMessage]
  );

  const persistPin = useCallback(async (): Promise<string> => {
    let chatSnapshot: StoredPinnedNote["chatSnapshot"];
    if (includeChatCopy && loadMessagesForSnapshot) {
      const msgs = await loadMessagesForSnapshot();
      chatSnapshot = {
        title: chatTitle ?? "Chat",
        messages: msgs
          .filter(
            (m) =>
              m.kind !== "summary" &&
              !m.summarizedInto &&
              (m.role === "user" || m.role === "assistant" || m.role === "system")
          )
          .map((m) => ({
            role: m.role,
            content: m.content,
            createdAt: m.createdAt,
          })),
      };
    }

    const overriding = saveMode === "override" && !!originalPin;
    const note: StoredPinnedNote = {
      id: overriding
        ? originalPin!.id
        : typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `pin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      title: title.trim() || (overriding ? originalPin!.title : undefined),
      chatId: includeLink || includeChatCopy ? chatId : undefined,
      chatTitle: includeLink || includeChatCopy ? chatTitle : undefined,
      messageId,
      artifactHtml: includeArtifact && hasArtifact ? artifactHtml : undefined,
      messageMarkdown: includeMessage && hasMessage ? messageMarkdown : undefined,
      chatSnapshot,
      linkToChat: includeLink && hasChat ? true : undefined,
      summary,
    };

    await putPinnedNote(note);
    return note.id;
  }, [
    title,
    includeArtifact,
    includeMessage,
    includeLink,
    includeChatCopy,
    artifactHtml,
    messageMarkdown,
    hasArtifact,
    hasMessage,
    hasChat,
    chatId,
    chatTitle,
    messageId,
    summary,
    loadMessagesForSnapshot,
    saveMode,
    originalPin,
  ]);

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setStage({ kind: "saving" });
    try {
      await persistPin();
      setStage({ kind: "saved" });
      // Auto-dismiss the success flash so it doesn't sit forever if the user
      // walks away. The close also lets them pin again immediately.
      setTimeout(() => onClose(), 900);
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to save pin.",
      });
    }
  }, [canSave, persistPin, onClose]);

  const handleSaveAndCanvas = useCallback(async () => {
    if (!canSave) return;
    setStage({ kind: "saving" });
    try {
      const id = await persistPin();
      // Skip the "Pinned" success flash here — we're navigating away
      // immediately and a flash would just flicker before the route change.
      onClose();
      router.push(`/notes/${id}/canvas`);
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to save pin.",
      });
    }
  }, [canSave, persistPin, onClose, router]);

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pin to notes</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col text-xs">
          <p className="reader-byline pb-1">
            Choose what to capture. Pins live in the Notes tab and survive even
            if the source chat is deleted.
          </p>

          <label className="mb-1 flex flex-col gap-1 px-1 pt-1">
            <span className="font-medium text-foreground">Title (optional)</span>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Name this note so it's easy to find later"
              disabled={stage.kind === "saving"}
              className="h-8 text-sm"
            />
            <span className="text-muted-foreground">
              Leave blank to auto-title from the note's contents.
            </span>
          </label>

          {originalPin ? (
            <div className="my-2 flex flex-col gap-1.5 border-l-2 border-primary/50 py-1 pl-3">
              <span className="font-medium text-foreground">
                Re-pin from{originalPin.title ? ` “${originalPin.title}”` : " the original note"}?
              </span>
              <RadioRow
                checked={saveMode === "override"}
                disabled={stage.kind === "saving"}
                onChange={() => setSaveMode("override")}
                title="Override the original"
                subtitle="Replaces the existing pinned note in place and points it at this chat."
              />
              <RadioRow
                checked={saveMode === "new"}
                disabled={stage.kind === "saving"}
                onChange={() => setSaveMode("new")}
                title="Save as new"
                subtitle="Keeps the original and adds a fresh pinned note."
              />
            </div>
          ) : null}

          <CheckboxRow
            checked={includeArtifact}
            disabled={!hasArtifact || stage.kind === "saving"}
            onChange={setIncludeArtifact}
            title="Include the artifact"
            subtitle={
              hasArtifact
                ? "Saves the rendered HTML."
                : "No artifact attached to this message."
            }
          />
          <CheckboxRow
            checked={includeMessage}
            disabled={!hasMessage || stage.kind === "saving"}
            onChange={setIncludeMessage}
            title="Include the message"
            subtitle={
              hasMessage
                ? "Saves the assistant's markdown reply."
                : "No prose to capture for this pin."
            }
          />
          <CheckboxRow
            checked={includeLink}
            disabled={!hasChat || stage.kind === "saving"}
            onChange={setIncludeLink}
            title="Link to the chat"
            subtitle={
              hasChat
                ? "Adds a link back to the source chat in your library."
                : "No source chat available."
            }
          />
          <CheckboxRow
            checked={includeChatCopy}
            disabled={!hasChat || !loadMessagesForSnapshot || stage.kind === "saving"}
            onChange={setIncludeChatCopy}
            title="Include a copy of the chat"
            subtitle="Snapshots the transcript so the note is self-contained."
          />
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
            disabled={stage.kind === "saving"}
          >
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={() => void handleSaveAndCanvas()}
            disabled={!canSave || stage.kind === "saving" || stage.kind === "saved"}
            className="gap-1.5"
          >
            <Pencil className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Pin &amp; open canvas</span>
            <span className="sm:hidden">Canvas</span>
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={!canSave || stage.kind === "saving" || stage.kind === "saved"}
            className="gap-1.5"
          >
            {stage.kind === "saving" ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Pinning…
              </>
            ) : stage.kind === "saved" ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Pinned
              </>
            ) : (
              <>
                <Pin className="h-3.5 w-3.5" />
                Pin
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CheckboxRow({
  checked,
  disabled,
  onChange,
  title,
  subtitle,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  title: string;
  subtitle: string;
}) {
  return (
    <label
      className={
        "flex items-start gap-2.5 border-b border-border/50 px-1 py-2.5 last:border-0" +
        (disabled ? " opacity-60" : " cursor-pointer")
      }
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className="block font-medium text-foreground">{title}</span>
        <span className="block text-muted-foreground">{subtitle}</span>
      </span>
    </label>
  );
}

function RadioRow({
  checked,
  disabled,
  onChange,
  title,
  subtitle,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <label
      className={
        "flex items-start gap-2.5 py-1" +
        (disabled ? " opacity-60" : " cursor-pointer")
      }
    >
      <input
        type="radio"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="mt-0.5"
      />
      <span>
        <span className="block font-medium text-foreground">{title}</span>
        <span className="block text-muted-foreground">{subtitle}</span>
      </span>
    </label>
  );
}
