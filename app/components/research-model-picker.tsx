"use client";

// Research-aware model picker. Unlike the generic per-app model <select>, this
// floats the strong long-context reasoning models into a "Recommended for
// research" group, annotates the default, and shows a one-line gloss of the
// selected model's strengths + context window — so a structured-research app
// isn't silently running its Refresh / scheduled scans on a small fast chat
// model that returns a thin table.

import { useMemo } from "react";
import {
  DEFAULT_RESEARCH_MODEL,
  catalogEntry,
  defaultModelMeta,
  partitionResearchModels,
  type CloudModel,
} from "@/app/models";
import { useAvailableModels } from "@/app/lib/use-available-models";

export function ResearchModelPicker({
  value,
  onChange,
  disabled,
  className,
  selectClassName,
  hint = true,
}: {
  /** Currently-selected model id. Falls back to the research default when empty. */
  value: string | undefined;
  onChange: (model: string) => void;
  disabled?: boolean;
  className?: string;
  selectClassName?: string;
  /** Show the one-line use-case + context gloss under the select. */
  hint?: boolean;
}) {
  const { models } = useAvailableModels();
  const selectedId = value || DEFAULT_RESEARCH_MODEL;

  // Keep the selected + default models present even if the live list hasn't
  // loaded yet, or the account no longer lists them — so the <select> never
  // silently snaps to a different model than what's actually configured.
  const list = useMemo<CloudModel[]>(() => {
    const out = [...models];
    const have = new Set(out.map((m) => m.id));
    for (const id of [selectedId, DEFAULT_RESEARCH_MODEL]) {
      if (id && !have.has(id)) {
        out.push(catalogEntry(id) ?? defaultModelMeta(id));
        have.add(id);
      }
    }
    return out;
  }, [models, selectedId]);

  const { recommended, others } = useMemo(
    () => partitionResearchModels(list),
    [list]
  );

  const meta = catalogEntry(selectedId) ?? defaultModelMeta(selectedId);
  const ctxLabel = `${Math.round(meta.contextTokens / 1000)}k context`;

  return (
    <div className={className}>
      <select
        value={selectedId}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={
          selectClassName ??
          "w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground outline-none focus:border-foreground/30 disabled:opacity-60"
        }
      >
        <optgroup label="Recommended for research">
          {recommended.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.id === DEFAULT_RESEARCH_MODEL ? " (default)" : ""} · {m.size}
            </option>
          ))}
        </optgroup>
        {others.length > 0 && (
          <optgroup label="Other models">
            {others.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} · {m.size}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {hint && (
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          {meta.useCase} · {ctxLabel}
        </p>
      )}
    </div>
  );
}
