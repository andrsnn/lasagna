"use client";

// Manual file editor for an app's VFS: a mini IDE (file list + editable textarea)
// to create/edit/delete files and set the entry by hand, then Save - which
// rebuilds the app. The deliberate alternative to chat codegen: when you already
// have the code, paste it straight in. Generic platform capability (any app).

import { useMemo, useState } from "react";
import { FileCode, Plus, Save, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ArtifactFiles } from "@/app/db";

export function FileEditor({
  open,
  onClose,
  files,
  entry,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  files: ArtifactFiles;
  entry: string;
  /** Persist the edited VFS (triggers a rebuild upstream). */
  onSave: (files: ArtifactFiles, entry: string) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<ArtifactFiles>(() => ({ ...files }));
  const [entryDraft, setEntryDraft] = useState(entry);
  const paths = useMemo(() => Object.keys(draft).sort(), [draft]);
  const [active, setActive] = useState<string>(() => entry || Object.keys(files).sort()[0] || "");
  const [newPath, setNewPath] = useState("");
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const setContent = (path: string, content: string) =>
    setDraft((d) => ({ ...d, [path]: content }));

  const addFile = () => {
    const p = newPath.trim().replace(/^\/+/, "");
    if (!p || draft[p] != null) return;
    setDraft((d) => ({ ...d, [p]: "" }));
    setActive(p);
    setNewPath("");
  };

  const deleteFile = (path: string) => {
    setDraft((d) => {
      const next = { ...d };
      delete next[path];
      return next;
    });
    setActive((cur) => (cur === path ? Object.keys(draft).filter((p) => p !== path)[0] ?? "" : cur));
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft, entryDraft.trim() || entry);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex flex-col bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <FileCode className="h-4 w-4" /> Edit files
          <span className="text-xs text-muted-foreground">({paths.length})</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            entry
            <select
              value={entryDraft}
              onChange={(e) => setEntryDraft(e.target.value)}
              className="rounded border border-border bg-background px-1.5 py-1 font-mono text-[11px]"
            >
              {paths.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" onClick={() => void save()} disabled={saving} className="gap-1.5">
            <Save className="h-3.5 w-3.5" />
            {saving ? "Saving…" : "Save & rebuild"}
          </Button>
          <Button size="sm" variant="outline" onClick={onClose} disabled={saving} className="gap-1.5">
            <X className="h-3.5 w-3.5" /> Close
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* file list */}
        <div className="flex w-56 shrink-0 flex-col border-r border-border">
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {paths.map((p) => (
              <div
                key={p}
                className={
                  "group flex items-center justify-between gap-1 px-2 py-1 text-xs " +
                  (p === active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50")
                }
              >
                <button
                  type="button"
                  onClick={() => setActive(p)}
                  className="min-w-0 flex-1 truncate text-left font-mono"
                  title={p}
                >
                  {p}
                  {p === entryDraft ? " ●" : ""}
                </button>
                <button
                  type="button"
                  onClick={() => deleteFile(p)}
                  title="Delete file"
                  className="rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-1 border-t border-border p-1.5">
            <Input
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addFile();
                }
              }}
              placeholder="new/file.tsx"
              className="h-7 font-mono text-[11px]"
            />
            <Button size="icon" variant="outline" onClick={addFile} className="h-7 w-7 shrink-0" title="Add file">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* editor */}
        <div className="min-w-0 flex-1">
          {active && draft[active] != null ? (
            <textarea
              key={active}
              value={draft[active]}
              onChange={(e) => setContent(active, e.target.value)}
              spellCheck={false}
              wrap="off"
              className="h-full w-full resize-none border-0 bg-background p-4 font-mono text-xs leading-relaxed text-foreground outline-none"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select or add a file.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
