"use client";

// Structured editor for a "Research" app's query + columns. Used as the
// per-type body inside the app settings sheet (and standalone). Query and
// columns are first-class data on app.state, so changing the prompt or adding a
// column is a plain state write - it can't mangle the artifact's files (the
// failure mode that switched the model to a random one and broke the build).
// New columns are written into both the display `columns` and the records
// `schema`, so the next Refresh actually populates them.
//
// Controlled-friendly: fires `onChange` with the normalized value on every edit
// so a parent sheet can own a single Save button. `onSubmit` + the built-in Save
// button remain for standalone use; pass `hideSubmit` to suppress the button.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { GripVertical, Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import type { ResearchColumn } from "@/app/db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type ResearchParamsValue = {
  query: string;
  columns: ResearchColumn[];
  idKeys: string[];
  schema: unknown;
};

type ColType = "text" | "link" | "number";

type Draft = {
  uid: string;
  /** Preserved for existing columns so record data keeps mapping; empty for new
   *  columns (a key is minted from the label on save). */
  key: string;
  label: string;
  type: ColType;
  isId: boolean;
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

/** Records-wrapper JSON schema the synthesis must conform to. Mirrors
 *  buildSchema in app/lib/structured-research.ts so an edited column set drives
 *  the next run's output shape. */
function buildSchema(columns: ResearchColumn[]): unknown {
  const props: Record<string, unknown> = { id: { type: "string" } };
  for (const c of columns) {
    props[c.key] = { type: c.type === "number" ? "number" : "string" };
  }
  return {
    type: "object",
    properties: {
      records: {
        type: "array",
        items: { type: "object", properties: props, required: ["id"] },
      },
    },
    required: ["records"],
  };
}

/** Normalize the editable drafts into the persisted value. Mints keys for new
 *  columns; keeps existing keys so record data stays mapped. Returns null when
 *  there are no valid (labeled) columns. */
function normalize(query: string, drafts: Draft[]): ResearchParamsValue | null {
  const seen = new Set<string>();
  const columns: ResearchColumn[] = [];
  const idKeys: string[] = [];
  for (const d of drafts) {
    const label = d.label.trim();
    if (!label) continue;
    let key = d.key || slug(label);
    if (!key) key = `col_${columns.length + 1}`;
    let unique = key;
    let n = 2;
    while (seen.has(unique)) unique = `${key}_${n++}`;
    seen.add(unique);
    columns.push({ key: unique, label, type: d.type });
    if (d.isId) idKeys.push(unique);
  }
  if (columns.length === 0) return null;
  if (idKeys.length === 0) idKeys.push(columns[0].key);
  return { query: query.trim(), columns, idKeys, schema: buildSchema(columns) };
}

let uidCounter = 0;
function nextUid(): string {
  uidCounter += 1;
  return `c${uidCounter}`;
}

export function ResearchParams({
  initialQuery,
  initialColumns,
  initialIdKeys,
  onSubmit,
  onChange,
  disabled,
  hideSubmit,
  footer,
}: {
  initialQuery: string;
  initialColumns: ResearchColumn[];
  initialIdKeys: string[];
  onSubmit?: (value: ResearchParamsValue) => void;
  /** Fires with the normalized value on every edit (for a parent-owned Save). */
  onChange?: (value: ResearchParamsValue) => void;
  disabled?: boolean;
  /** Hide the built-in Save button (parent owns Save). */
  hideSubmit?: boolean;
  /** Optional extra action rendered under the Save button (e.g. a recovery link). */
  footer?: ReactNode;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    (initialColumns.length > 0
      ? initialColumns
      : [{ key: "", label: "", type: "text" as ColType }]
    ).map((c) => ({
      uid: nextUid(),
      key: c.key ?? "",
      label: c.label ?? "",
      type: (c.type ?? "text") as ColType,
      isId: initialIdKeys.includes(c.key),
    }))
  );

  // Push the current value up on every edit so a parent can own Save.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const v = normalize(query, drafts);
    if (v) onChangeRef.current?.(v);
  }, [query, drafts]);

  const setDraft = (uid: string, patch: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d) => (d.uid === uid ? { ...d, ...patch } : d)));

  const addColumn = () =>
    setDrafts((ds) => [...ds, { uid: nextUid(), key: "", label: "", type: "text", isId: false }]);

  const removeColumn = (uid: string) =>
    setDrafts((ds) => (ds.length > 1 ? ds.filter((d) => d.uid !== uid) : ds));

  const move = (uid: string, dir: -1 | 1) =>
    setDrafts((ds) => {
      const i = ds.findIndex((d) => d.uid === uid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ds.length) return ds;
      const next = [...ds];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const submit = () => {
    const v = normalize(query, drafts);
    if (v) onSubmit?.(v);
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-foreground">What to research</span>
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={disabled}
          rows={3}
          placeholder="What should each run look for? e.g. up-and-coming robotics companies founded since 2022"
          className="min-h-[4.5rem] resize-y rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-foreground/30"
        />
        <span className="text-[11px] text-muted-foreground">
          Editing this changes what every Refresh and scheduled run searches for.
        </span>
      </label>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-foreground">Columns</span>
          <span className="text-[11px] text-muted-foreground">
            Check ID to mark a row-identity column (used to dedupe).
          </span>
        </div>

        <div className="flex flex-col gap-2">
          {drafts.map((d, i) => (
            <div
              key={d.uid}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-card/60 px-2 py-1.5"
            >
              <GripVertical className="hidden h-3.5 w-3.5 shrink-0 text-muted-foreground/50 sm:block" />
              <Input
                value={d.label}
                onChange={(e) => setDraft(d.uid, { label: e.target.value })}
                disabled={disabled}
                placeholder="Column name"
                className="h-8 min-w-0 flex-1"
              />
              <select
                value={d.type}
                onChange={(e) => setDraft(d.uid, { type: e.target.value as ColType })}
                disabled={disabled}
                className="h-8 shrink-0 rounded-md border border-border bg-card px-1.5 text-xs text-foreground outline-none focus:border-foreground/30"
                title="Column type"
              >
                <option value="text">Text</option>
                <option value="link">Link</option>
                <option value="number">Number</option>
              </select>
              <label
                className="flex shrink-0 items-center gap-1 px-1 text-[11px] text-muted-foreground"
                title="Use this column to identify a unique row"
              >
                <input
                  type="checkbox"
                  checked={d.isId}
                  onChange={(e) => setDraft(d.uid, { isId: e.target.checked })}
                  disabled={disabled}
                  className="h-3.5 w-3.5"
                  style={{ accentColor: "var(--color-accent)" }}
                />
                <span className="hidden sm:inline">ID</span>
              </label>
              <div className="flex shrink-0 items-center">
                <button
                  type="button"
                  onClick={() => move(d.uid, -1)}
                  disabled={disabled || i === 0}
                  aria-label="Move column up"
                  className="tap rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => move(d.uid, 1)}
                  disabled={disabled || i === drafts.length - 1}
                  aria-label="Move column down"
                  className="tap rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => removeColumn(d.uid)}
                  disabled={disabled || drafts.length <= 1}
                  aria-label="Remove column"
                  className="tap rounded p-1 text-muted-foreground hover:text-destructive disabled:opacity-30"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addColumn}
          disabled={disabled}
          className="mt-0.5 gap-1.5 self-start"
        >
          <Plus className="h-3.5 w-3.5" /> Add column
        </Button>
        <span className="text-[11px] text-muted-foreground">
          New columns fill in on the next Refresh; existing rows keep their data.
        </span>
      </div>

      {!hideSubmit && (
        <Button type="submit" disabled={disabled} className="mt-1">
          Save and refresh
        </Button>
      )}
      {footer}
    </form>
  );
}
