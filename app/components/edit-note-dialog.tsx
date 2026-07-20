"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Pencil } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { putPinnedNote, type StoredPinnedNote } from "@/app/db";

type Stage =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

type Display = NonNullable<NonNullable<StoredPinnedNote["viewConfig"]>["display"]>;

export type EditNoteDialogProps = {
  open: boolean;
  note: StoredPinnedNote | null;
  onClose: () => void;
  onSaved?: (note: StoredPinnedNote) => void;
};

export function EditNoteDialog({ open, note, onClose, onSaved }: EditNoteDialogProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [display, setDisplay] = useState<Display>("default");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });

  useEffect(() => {
    if (!open || !note) return;
    setTitle(note.title ?? "");
    setBody(note.messageMarkdown ?? "");
    setDisplay(note.viewConfig?.display ?? "default");
    setStage({ kind: "idle" });
  }, [open, note]);

  const trimmedBody = body.trim();
  const canSave = !!note && stage.kind !== "saving";

  const handleSave = useCallback(async () => {
    if (!note || !canSave) return;
    setStage({ kind: "saving" });
    try {
      const updated: StoredPinnedNote = {
        ...note,
        title: title.trim() || undefined,
        messageMarkdown: trimmedBody || undefined,
        viewConfig: { ...(note.viewConfig ?? {}), display },
        updatedAt: Date.now(),
      };
      await putPinnedNote(updated);
      onSaved?.(updated);
      setStage({ kind: "saved" });
      setTimeout(() => onClose(), 600);
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to save note.",
      });
    }
  }, [note, canSave, title, trimmedBody, display, onSaved, onClose]);

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4" />
            Edit note
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-xs">
          <label className="flex flex-col gap-1">
            <span className="font-medium text-foreground">Title (optional)</span>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Shopping list"
              disabled={stage.kind === "saving"}
            />
          </label>

          <fieldset className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 px-3 py-2">
            <legend className="px-1 text-[11px] font-medium text-foreground">
              View
            </legend>
            <RadioRow
              checked={display === "default"}
              disabled={stage.kind === "saving"}
              onChange={() => setDisplay("default")}
              title="Default"
              subtitle="Renders the full body as markdown."
            />
            <RadioRow
              checked={display === "compact"}
              disabled={stage.kind === "saving"}
              onChange={() => setDisplay("compact")}
              title="Compact"
              subtitle="Clamps the body to a short preview."
            />
            <RadioRow
              checked={display === "hidden"}
              disabled={stage.kind === "saving"}
              onChange={() => setDisplay("hidden")}
              title="Hidden"
              subtitle="Only the title row shows; body is revealed on click."
            />
          </fieldset>

          <label className="flex flex-col gap-1">
            <span className="font-medium text-foreground">Body</span>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Free text — markdown supported."
              disabled={stage.kind === "saving"}
              className="min-h-[200px]"
            />
          </label>

          {note?.artifactHtml ? (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
              This note also has an HTML artifact attached. Editing here only
              changes the title and body — the artifact is unchanged.
            </div>
          ) : null}
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
            onClick={() => void handleSave()}
            disabled={!canSave || stage.kind === "saved"}
            className="gap-1.5"
          >
            {stage.kind === "saving" ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : stage.kind === "saved" ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Saved
              </>
            ) : (
              <>
                <Pencil className="h-3.5 w-3.5" />
                Save changes
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
        "flex items-start gap-2 rounded-md bg-background/60 px-2 py-1.5" +
        (disabled ? " opacity-60" : " cursor-pointer hover:bg-background")
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
