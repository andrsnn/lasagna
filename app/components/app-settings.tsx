"use client";

// Option C app settings: one sheet, three tabs.
//   General  - the shell shared by EVERY app: name, model, auto-refresh.
//   This app - the per-type body: research editor, declared params, or app panel.
//   Data     - housekeeping: export, restore-default-layout, delete, SDK debug.
//
// The model picker is host-owned for every app. It binds to whatever the app
// actually reads - a manifest `model` param (proper or a free-text "model"
// string like the "Gemma" bug), else app.model - and writes a real model id
// back to both, so model selection is consistent and the free-text bug dies.

import { useMemo, useState } from "react";
import { Database, Settings2, SlidersHorizontal } from "lucide-react";
import type { ManifestParam, StoredApp, StoredDesigner } from "@/app/db";
import { DEFAULT_RESEARCH_MODEL, burnNote, type CloudModel } from "@/app/models";
import { ParamForm } from "@/app/components/param-form";
import { ResearchParams, type ResearchParamsValue } from "@/app/components/research-params";
import { ScheduleDetails } from "@/app/components/schedule-panel";
import { SdkDebugPanel } from "@/app/components/sdk-debug-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type AppSettingsSave = {
  name: string;
  /** Chosen model id (or "" for default). */
  model: string;
  /** Full params map to persist (model-ish param already synced to `model`). */
  params: Record<string, unknown>;
  /** Present only for research apps: the edited query/columns/schema. */
  researchState?: ResearchParamsValue;
};

/** A manifest param the host should render as the single Model picker: a proper
 *  `model` param, or a free-text string/enum the app called "model" (the source
 *  of the "Gemma" bug). */
function isModelParam(p: ManifestParam): boolean {
  if (p.type === "model") return true;
  if ((p.type === "string" || p.type === "enum") && /(^|[_-])model([_-]|$)/i.test(p.key)) return true;
  return false;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      <span>{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export function AppSettings({
  app,
  designer,
  models,
  onSave,
  onRestoreResearch,
  onUpgradeToDeclaredData,
}: {
  app: StoredApp;
  designer: StoredDesigner;
  models: CloudModel[];
  onSave: (patch: AppSettingsSave) => Promise<void> | void;
  onRestoreResearch: () => Promise<void> | void;
  /** Kick off the one-time declared-data migration in the app's edit chat.
   *  The row renders only while the manifest has no "state" block, so a
   *  successful migration retires the affordance by itself. */
  onUpgradeToDeclaredData?: () => void;
}) {
  const manifest = designer.manifest;
  const researchState = app.state ?? {};
  const isResearch =
    Array.isArray(researchState.columns) &&
    typeof researchState.query === "string" &&
    Array.isArray(researchState.records);

  const modelParam = manifest?.params.find(isModelParam);
  const nonModelParams = manifest?.params.filter((p) => !isModelParam(p)) ?? [];

  // --- drafts ---------------------------------------------------------------
  const [name, setName] = useState(app.name);
  const initialModel =
    app.model ??
    (modelParam && typeof app.params?.[modelParam.key] === "string"
      ? (app.params[modelParam.key] as string)
      : "");
  const [model, setModelState] = useState(initialModel);
  const [params, setParams] = useState<Record<string, unknown>>({ ...(app.params ?? {}) });
  const [research, setResearch] = useState<ResearchParamsValue | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"general" | "app" | "data">("general");

  const modelKnown = useMemo(() => models.some((m) => m.id === model), [models, model]);
  // Spell out what "(default)" actually resolves to. Research apps fall back to
  // the deep-research model server-side; other apps use the global model from
  // Preferences.
  const defaultModelOptionLabel = isResearch
    ? `Default · ${models.find((m) => m.id === DEFAULT_RESEARCH_MODEL)?.label ?? "MiniMax M3"} (deep research)`
    : "Default (your global model · set in Preferences)";
  // A model-ish param holding a value that isn't a real id (e.g. "Gemma").
  const strayModelText =
    modelParam && typeof app.params?.[modelParam.key] === "string"
      ? (app.params[modelParam.key] as string)
      : "";
  const showStrayNote = !!strayModelText && !models.some((m) => m.id === strayModelText);

  const genericManifest = manifest ? { ...manifest, params: nonModelParams } : undefined;

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const nextParams = { ...params };
      if (modelParam) nextParams[modelParam.key] = model || undefined;
      await onSave({
        name: name.trim() || "Untitled",
        model,
        params: nextParams,
        researchState: isResearch && research ? research : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const exportCsv = () => {
    const cols = Array.isArray(researchState.columns)
      ? (researchState.columns as { key: string; label: string }[])
      : [];
    const rows = Array.isArray(researchState.records)
      ? (researchState.records as Record<string, unknown>[])
      : [];
    if (cols.length === 0) return;
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      cols.map((c) => esc(c.label)).join(","),
      ...rows.map((r) => cols.map((c) => esc(r[c.key])).join(",")),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(app.name || "research").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const tabs: { id: typeof tab; label: string; icon: React.ReactNode }[] = [
    { id: "general", label: "General", icon: <SlidersHorizontal className="h-3.5 w-3.5" /> },
    { id: "app", label: "This app", icon: <Settings2 className="h-3.5 w-3.5" /> },
    { id: "data", label: "Data", icon: <Database className="h-3.5 w-3.5" /> },
  ];

  // The declared-data upgrade is offered once: only for iframe artifacts
  // (research apps are native and don't need it) that haven't migrated yet.
  const showV2Upgrade = !isResearch && !manifest?.state && !!onUpgradeToDeclaredData;

  const recordCount = Array.isArray(researchState.records) ? researchState.records.length : 0;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* tab bar */}
      <div className="flex gap-1 rounded-xl border border-border bg-secondary/40 p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "tap flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium",
              tab === t.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* GENERAL ------------------------------------------------------------- */}
      {tab === "general" && (
        <div className="flex flex-col gap-3">
          <SectionLabel>Same for every app</SectionLabel>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Untitled" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">Model</span>
            <select
              value={modelKnown ? model : ""}
              onChange={(e) => setModelState(e.target.value)}
              className="rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground outline-none focus:border-foreground/30"
            >
              <option value="">{defaultModelOptionLabel}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · {m.size}
                  {burnNote(m.id) ? ` · ${burnNote(m.id)}` : ""}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-muted-foreground">
              “~Nx” is roughly how fast a model drains your Ollama Cloud plan vs
              the lightest model (GPT-OSS 20B = ~1x). Ollama bills GPU-time, so
              bigger models and longer replies use it up faster.
            </span>
            {showStrayNote && (
              <span className="rounded-md border border-[var(--color-accent-2)]/40 bg-[var(--color-accent-2)]/10 px-2 py-1.5 text-[11px] text-[var(--color-accent-2)]">
                This app stored the model as plain text “{strayModelText}”. Pick a real model above to fix it.
              </span>
            )}
          </label>
          <div className="pt-1">
            <ScheduleDetails appId={app.id} reloadKey={0} />
          </div>
        </div>
      )}

      {/* THIS APP ------------------------------------------------------------ */}
      {tab === "app" && (
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--color-accent-2)]/30 bg-[var(--color-accent-2)]/5 p-3">
          <SectionLabel>{isResearch ? "Research" : "This app"}</SectionLabel>
          {isResearch ? (
            <ResearchParams
              initialQuery={typeof researchState.query === "string" ? researchState.query : ""}
              initialColumns={(Array.isArray(researchState.columns) ? researchState.columns : []) as ResearchParamsValue["columns"]}
              initialIdKeys={Array.isArray(researchState.idKeys) ? (researchState.idKeys as string[]) : []}
              onChange={setResearch}
              hideSubmit
            />
          ) : nonModelParams.length > 0 && genericManifest ? (
            <ParamForm manifest={genericManifest} values={params} onChange={setParams} />
          ) : (
            <p className="text-sm text-muted-foreground">
              This app has no extra settings. Use “Edit in chat” to change what it does.
            </p>
          )}
        </div>
      )}

      {/* DATA ---------------------------------------------------------------- */}
      {tab === "data" && (
        <div className="flex flex-col gap-2">
          {isResearch && (
            <>
              <DataRow
                title="Export results"
                hint={`${recordCount} row${recordCount === 1 ? "" : "s"} as CSV`}
                action={
                  <Button variant="outline" size="sm" onClick={exportCsv} disabled={recordCount === 0}>
                    Export CSV
                  </Button>
                }
              />
              <DataRow
                title="Restore default layout"
                hint="If the view looks broken. Keeps your data and columns."
                action={
                  <Button variant="outline" size="sm" onClick={() => void onRestoreResearch()}>
                    Restore
                  </Button>
                }
              />
            </>
          )}
          {showV2Upgrade && (
            <>
              <SectionLabel>Updates</SectionLabel>
              <DataRow
                title="Update app"
                hint="Applies the latest platform improvements to how this app refreshes and syncs. Your data and settings are kept."
                action={
                  <Button variant="outline" size="sm" onClick={onUpgradeToDeclaredData}>
                    Update
                  </Button>
                }
              />
            </>
          )}
          <details className="rounded-lg border border-border bg-secondary/30 px-3 py-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">Developer · SDK debug</summary>
            <div className="mt-2">
              <SdkDebugPanel appId={app.id} />
            </div>
          </details>
        </div>
      )}

      {/* sticky save */}
      <Button onClick={() => void save()} disabled={saving} className="mt-1">
        {isResearch ? "Save and refresh" : "Save and refresh"}
      </Button>
    </div>
  );
}

function DataRow({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-b-0">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{title}</div>
        <div className="text-[11px] text-muted-foreground">{hint}</div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
