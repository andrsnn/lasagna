"use client";

import type { ReactNode } from "react";
import type { ArtifactManifest, ManifestParam } from "@/app/db";
import { useAvailableModels } from "@/app/lib/use-available-models";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function ParamForm({
  manifest,
  values,
  onChange,
  onSubmit,
  submitLabel = "Save",
  className,
  disabled,
}: {
  manifest: ArtifactManifest;
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  onSubmit?: () => void;
  submitLabel?: string;
  className?: string;
  disabled?: boolean;
}) {
  if (manifest.params.length === 0) {
    return (
      <div className={cn("rounded-xl border border-border bg-secondary/40 p-4 text-sm text-muted-foreground", className)}>
        This artifact takes no parameters.
        {onSubmit && (
          <Button onClick={onSubmit} className="mt-3 w-full" disabled={disabled}>
            {submitLabel}
          </Button>
        )}
      </div>
    );
  }

  return (
    <form
      className={cn("flex flex-col gap-3", className)}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      {manifest.params.map((p) => (
        <ParamField
          key={p.key}
          param={p}
          value={values[p.key]}
          onChange={(v) => onChange({ ...values, [p.key]: v })}
          disabled={disabled}
        />
      ))}
      {onSubmit && (
        <Button type="submit" disabled={disabled} className="mt-1">
          {submitLabel}
        </Button>
      )}
    </form>
  );
}

function ParamField({
  param,
  value,
  onChange,
  disabled,
}: {
  param: ManifestParam;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  const label = (
    <div className="flex items-center justify-between text-xs">
      <span className="font-medium text-foreground">{param.label}</span>
      {"required" in param && param.required && (
        <span className="font-mono text-[10px] text-destructive">required</span>
      )}
    </div>
  );

  switch (param.type) {
    case "string":
      return (
        <label className="flex flex-col gap-1.5">
          {label}
          <Input
            value={typeof value === "string" ? value : ""}
            placeholder={param.placeholder ?? param.default}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
          />
        </label>
      );
    case "number":
      return (
        <label className="flex flex-col gap-1.5">
          {label}
          <Input
            type="number"
            value={typeof value === "number" ? value : (value as string) ?? ""}
            min={param.min}
            max={param.max}
            onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
            disabled={disabled}
          />
        </label>
      );
    case "boolean":
      return (
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-xs">
          <span className="font-medium text-foreground">{param.label}</span>
          <input
            type="checkbox"
            checked={Boolean(value ?? param.default)}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
            className="h-4 w-4"
            style={{ accentColor: "var(--color-accent)" }}
          />
        </label>
      );
    case "enum":
      return (
        <label className="flex flex-col gap-1.5">
          {label}
          <select
            value={typeof value === "string" ? value : param.default ?? ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground outline-none focus:border-foreground/30"
          >
            {!param.required && <option value="">(none)</option>}
            {param.options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </label>
      );
    case "model":
      return <ModelField param={param} value={value} onChange={onChange} disabled={disabled} label={label} />;
  }
}

function ModelField({
  param,
  value,
  onChange,
  disabled,
  label,
}: {
  param: Extract<ManifestParam, { type: "model" }>;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  label: ReactNode;
}) {
  const { models } = useAvailableModels();
  return (
    <label className="flex flex-col gap-1.5">
      {label}
      <select
        value={typeof value === "string" ? value : param.default ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground outline-none focus:border-foreground/30"
      >
        {!param.required && <option value="">(none)</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} · {m.size}
          </option>
        ))}
      </select>
    </label>
  );
}
