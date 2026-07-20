"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, ChevronDown, ChevronRight, Download, Globe, ImageIcon, Loader2, MessageSquare, MoreHorizontal, Plug, Plus, RefreshCw, RotateCcw, Search, Server, Smile, Sparkles, Trash2, Type, Upload, Users, X } from "lucide-react";
import { CharacterAvatar } from "@/app/components/character-avatar";
import {
  FONT_ASPECTS,
  FONT_OPTIONS,
  FONT_OPTION_BY_ID,
  DEFAULT_FONT_PREFS,
  type FontAspect,
} from "@/app/lib/fonts";
import {
  resetFontPrefs,
  setFontPref,
  useFontPrefs,
} from "@/app/lib/use-font-prefs";
import {
  AVATAR_STYLES,
  setAvatarStyle,
  useAvatarStyle,
  type AvatarStyle,
} from "@/app/lib/avatar-style";
import { setShowTitleLogo, useShowTitleLogo } from "@/app/lib/title-logo-pref";
import { CouncilSettingsDialog } from "@/app/components/council-settings-dialog";
import { PasskeysSection } from "@/app/components/passkeys-settings";
import { confirm } from "@/app/components/confirm";
import { toast } from "@/app/components/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_ENABLED_MODELS,
  DEFAULT_MODEL,
  DEFAULT_RESEARCH_MODEL,
  DEFAULT_SCHEDULED_MODEL,
  VISION_DESCRIBER_MODEL,
  defaultModelMeta,
  type CloudModel,
} from "@/app/models";
import {
  DESCRIBE_DETAIL_OPTIONS,
  DEFAULT_DESCRIBE_DETAIL,
} from "@/app/lib/describe-image";
import { useAvailableModels } from "@/app/lib/use-available-models";
import { ResearchModelPicker } from "@/app/components/research-model-picker";
import { DebugPanel } from "@/app/components/debug-panel";
import { listChats, type Settings, type McpConnector, type McpConnectorTool } from "@/app/db";
import {
  bundleRowCount,
  downloadBackup,
  parseBundleFile,
  restoreBackup,
  type BackupBundle,
} from "@/app/lib/backup";
import {
  rebuildChatIndex,
  useChatIndexStatus,
} from "@/app/lib/chat-index-store";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  onChange: (next: Settings) => void;
  /**
   * When the dialog opens with this set, jump straight to the Models tab and
   * scroll/focus the "Add a model" card. Used by the model pickers' "+ Add a
   * model not listed…" shortcut so a user who can't find their model lands
   * exactly where they can add it.
   */
  focusAddModel?: boolean;
  /** When set, open the dialog on this tab (e.g. "connectors" from the chat
   *  ••• sheet's "Manage connectors" shortcut). */
  initialTab?: PrefsTab;
};

type PrefsTab =
  | "models"
  | "tools"
  | "connectors"
  | "appearance"
  | "security"
  | "data"
  | "debug";

/** Borderless <select> styled to read as the "value" line inside a DefaultRow:
 *  it shows just the chosen model (with the native chevron) under a small label,
 *  so the two defaults read as one tidy card instead of two big dropdowns. */
const VALUE_SELECT_CLS =
  "mt-0.5 w-full min-w-0 cursor-pointer truncate bg-transparent text-sm font-medium text-foreground outline-none";

/** A row in the Defaults card: icon tile + label over a value control. */
function DefaultRow({
  icon,
  label,
  hint,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-3" title={hint}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-secondary/60 text-[var(--color-accent-2)]">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-muted-foreground">{label}</span>
        {children}
      </div>
    </div>
  );
}

/** A compact accent-colored badge for the Default / Research markers. */
function AccentBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-[color-mix(in_oklab,var(--color-accent-2)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-accent-2)_12%,transparent)] px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-[var(--color-accent-2)]">
      {children}
    </span>
  );
}

/** Small uppercase section heading with a hairline rule, for visual grouping. */
function SectionLabel({
  children,
  icon,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {icon}
      <span>{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** A read-only state pill showing whether a per-chat tool is currently on. The
 *  actual toggle lives in the composer; this just reflects it so Preferences
 *  doesn't duplicate the control. */
function StateChip({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        on
          ? "border-[color-mix(in_oklab,var(--color-accent-2)_32%,transparent)] bg-[color-mix(in_oklab,var(--color-accent-2)_12%,transparent)] text-[var(--color-accent-2)]"
          : "border-border bg-secondary/50 text-muted-foreground"
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          on ? "bg-[var(--color-accent-2)]" : "bg-muted-foreground/50"
        )}
      />
      {children}
    </span>
  );
}

// People copy the snippet ollama.com / `ollama run` / `ollama pull` prints,
// e.g. "ollama run gpt-oss:120b-cloud" or "$ ollama pull llama3.2:latest".
// Pasting that verbatim made the whole string get stored as the model id and
// every chat fail with "model not found". Strip the shell prompt + ollama
// subcommand and keep the first token, since real ids have no whitespace.
function normalizeModelId(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^[$#>]\s+/, "");
  s = s.replace(/^ollama\s+(run|pull)\s+/i, "");
  return s.split(/\s+/)[0] ?? "";
}

function matches(query: string, m: CloudModel): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    m.id.toLowerCase().includes(q) ||
    m.label.toLowerCase().includes(q) ||
    m.useCase.toLowerCase().includes(q) ||
    m.size.toLowerCase().includes(q)
  );
}

function relativeTime(then: number): string {
  const secs = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}

export function SettingsDialog({ open, onOpenChange, settings, onChange, focusAddModel, initialTab }: Props) {
  const [query, setQuery] = useState("");
  const [customDraft, setCustomDraft] = useState("");
  const [councilOpen, setCouncilOpen] = useState(false);
  const [tab, setTab] = useState<PrefsTab>("models");
  const [runpodOpen, setRunpodOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "on" | "vision" | "custom">("all");
  const [highlightAdd, setHighlightAdd] = useState(false);
  const addCardRef = useRef<HTMLDivElement | null>(null);
  const avatarStyle = useAvatarStyle();
  const showTitleLogo = useShowTitleLogo();
  const { models: discovered, fetchedAt, loading, error, refresh } =
    useAvailableModels(settings.runpodEndpointId);

  const customModels = useMemo(
    () => settings.customModels ?? [],
    [settings.customModels]
  );

  // Merge user-entered ids into the discovered list so they can be enabled,
  // searched, and chosen as the default like any other model. Discovered
  // entries win on collision so curated metadata isn't replaced by stubs.
  const models = useMemo(() => {
    const seen = new Set(discovered.map((m) => m.id));
    const extras: CloudModel[] = [];
    for (const id of customModels) {
      if (seen.has(id)) continue;
      seen.add(id);
      extras.push(defaultModelMeta(id));
    }
    return [...discovered, ...extras];
  }, [discovered, customModels]);

  const customSet = useMemo(() => new Set(customModels), [customModels]);

  // Force a re-render every 30s so the "Last refreshed" tag stays fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open || !fetchedAt) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, [open, fetchedAt]);

  // Auto-refresh on first open so the picker reflects the user's current
  // account without an extra click.
  useEffect(() => {
    if (!open) return;
    if (fetchedAt || loading) return;
    void refresh();
  }, [open, fetchedAt, loading, refresh]);

  // Deep link: a model picker's "+ Add a model not listed…" shortcut opens the
  // dialog with focusAddModel set. Land on the Models tab, open the inline add
  // field, scroll it into view, focus it, and pulse a highlight so it's
  // unmistakable.
  // Deep link: open directly on a requested tab (e.g. Connectors from the chat
  // ••• sheet). Runs before the focusAddModel effect's "models" override, which
  // only fires when focusAddModel is set — the two deep links are never both on.
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);

  useEffect(() => {
    if (!open || !focusAddModel) return;
    setTab("models");
    setAddOpen(true);
    setHighlightAdd(true);
    const raf = window.requestAnimationFrame(() => {
      addCardRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      addCardRef.current?.querySelector("input")?.focus();
    });
    const done = window.setTimeout(() => setHighlightAdd(false), 1800);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(done);
    };
  }, [open, focusAddModel]);

  const enabledSet = useMemo(
    () => new Set(settings.enabledModels ?? DEFAULT_ENABLED_MODELS),
    [settings.enabledModels]
  );

  // The effective default ids (a blank setting means the built-in default), so
  // the matching rows can carry a DEFAULT / RESEARCH badge instead of needing a
  // separate dropdown to tell you which model is which.
  const defaultId = settings.defaultModel || DEFAULT_MODEL;
  const researchId = settings.researchModel || DEFAULT_RESEARCH_MODEL;
  const scheduledId = settings.scheduledModel || DEFAULT_SCHEDULED_MODEL;

  const filtered = useMemo(
    () =>
      models.filter((m) => {
        if (!matches(query, m)) return false;
        if (filter === "on") return enabledSet.has(m.id);
        if (filter === "vision") return !!m.vision;
        if (filter === "custom") return customSet.has(m.id);
        return true;
      }),
    [query, models, filter, enabledSet, customSet]
  );

  const visionCount = useMemo(
    () => models.filter((m) => m.vision).length,
    [models]
  );

  const persistEnabled = useCallback(
    (nextIds: string[]) => {
      onChange({ ...settings, enabledModels: nextIds });
    },
    [onChange, settings]
  );

  const toggle = useCallback(
    (id: string) => {
      const current = new Set(enabledSet);
      if (current.has(id)) current.delete(id);
      else current.add(id);
      persistEnabled(models.filter((m) => current.has(m.id)).map((m) => m.id));
    },
    [enabledSet, persistEnabled, models]
  );

  const enableAll = useCallback(() => {
    onChange({ ...settings, enabledModels: models.map((m) => m.id) });
  }, [onChange, settings, models]);

  const disableAll = useCallback(() => {
    onChange({ ...settings, enabledModels: [] });
  }, [onChange, settings]);

  const resetDefaults = useCallback(() => {
    onChange({ ...settings, enabledModels: undefined });
  }, [onChange, settings]);

  const addCustomModel = useCallback(() => {
    const id = normalizeModelId(customDraft);
    if (!id) return;
    if (models.some((m) => m.id === id)) {
      setCustomDraft("");
      return;
    }
    const nextCustom = [...customModels, id];
    const nextEnabled = [...(settings.enabledModels ?? DEFAULT_ENABLED_MODELS), id];
    onChange({ ...settings, customModels: nextCustom, enabledModels: nextEnabled });
    setCustomDraft("");
  }, [customDraft, customModels, models, onChange, settings]);

  const removeCustomModel = useCallback(
    (id: string) => {
      const nextCustom = customModels.filter((x) => x !== id);
      const enabled = settings.enabledModels;
      const nextEnabled = enabled ? enabled.filter((x) => x !== id) : enabled;
      onChange({
        ...settings,
        customModels: nextCustom.length ? nextCustom : undefined,
        enabledModels: nextEnabled,
      });
    },
    [customModels, onChange, settings]
  );

  const enabledCount = enabledSet.size;

  // ----- Backup & Restore -----
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{
    bundle: BackupBundle;
    filename: string;
  } | null>(null);
  const [restoreMode, setRestoreMode] = useState<"merge" | "replace">("merge");
  const [restoreAck, setRestoreAck] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);

  // ----- Search index admin -----
  const indexStatus = useChatIndexStatus();
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);

  const onRebuildIndex = useCallback(async () => {
    const ok = await confirm({
      title: "Rebuild the search index?",
      body: "This re-reads every chat from the local database. It may take a few seconds.",
      confirmLabel: "Rebuild",
    });
    if (!ok) return;
    setIndexError(null);
    setIndexBusy(true);
    try {
      const chats = await listChats();
      await rebuildChatIndex(chats);
      toast.success("Search index rebuilt");
    } catch (err) {
      setIndexError(err instanceof Error ? err.message : "Rebuild failed.");
      toast.error("Couldn't rebuild the search index.");
    } finally {
      setIndexBusy(false);
    }
  }, []);

  const onClickBackup = useCallback(async () => {
    setBackupError(null);
    setBackupBusy(true);
    try {
      const result = await downloadBackup();
      onChange({
        ...settings,
        lastBackupAt: result.exportedAt,
        lastBackupBytes: result.bytes,
      });
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : "Backup failed.");
    } finally {
      setBackupBusy(false);
    }
  }, [onChange, settings]);

  const onPickFile = useCallback(async (file: File) => {
    setBackupError(null);
    try {
      const bundle = await parseBundleFile(file);
      setPendingRestore({ bundle, filename: file.name });
      setRestoreMode("merge");
      setRestoreAck(false);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : "Could not read backup.");
    }
  }, []);

  const onConfirmRestore = useCallback(async () => {
    if (!pendingRestore) return;
    setRestoreBusy(true);
    setBackupError(null);
    try {
      await restoreBackup(pendingRestore.bundle, restoreMode);
      // Hard reload — the open tab still has React state derived from the
      // pre-restore IDB, and silently reconciling every store is more code
      // than it's worth for a one-shot user action.
      window.location.reload();
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : "Restore failed.");
      setRestoreBusy(false);
    }
  }, [pendingRestore, restoreMode]);

  const cancelRestore = useCallback(() => {
    setPendingRestore(null);
    setRestoreAck(false);
  }, []);

  // Surface the endpoint-id row prominently when the user has any
  // runpod: model in their picker — we want them to discover the endpoint
  // setting rather than fail their first runpod chat with a config error.
  const hasRunpodModel = useMemo(
    () =>
      models.some(
        (m) => enabledSet.has(m.id) && m.id.startsWith("runpod:")
      ) || customModels.some((id) => id.startsWith("runpod:")),
    [models, enabledSet, customModels]
  );

  // Reveal the RunPod section automatically once it actually matters - the user
  // has a runpod: model or has already set an endpoint id. Otherwise it stays
  // collapsed so the Models tab isn't cluttered for the common case.
  useEffect(() => {
    if (hasRunpodModel || settings.runpodEndpointId?.trim()) setRunpodOpen(true);
  }, [hasRunpodModel, settings.runpodEndpointId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        variant="sheet"
        className="max-h-[90svh] overflow-y-auto overscroll-contain sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Preferences</DialogTitle>
          <DialogDescription>
            Set your default models, choose which ones show up in the picker,
            and tune tools, appearance, and your data.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-3">
          {/* Scrollable so the six tabs never overflow a narrow phone sheet;
              on wider viewports they simply fill the row. min-w-0 lets this
              grid item shrink to the dialog width so the tab row's
              overflow-x-auto actually scrolls internally instead of forcing
              the whole dialog to grow (a horizontal scrollbar on every tab). */}
          <div className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-secondary/40 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {([["models","Models"],["tools","Tools"],["connectors","Connectors"],["appearance","Appearance"],["security","Security"],["data","Data"],["debug","Debug"]] as const).map(([id,label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  "tap flex-1 shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium",
                  tab === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "models" && (
            <div className="flex flex-col gap-6">
          {/* ---- Defaults: one compact card, not two big dropdowns --------- */}
          <div className="flex flex-col gap-2">
            <SectionLabel icon={<Sparkles className="h-3.5 w-3.5" />}>
              Defaults
            </SectionLabel>
            <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
              <DefaultRow
                icon={<MessageSquare className="h-[17px] w-[17px]" />}
                label="Chat & apps"
                hint="Used by new chats and apps unless they pick their own."
              >
                <select
                  value={settings.defaultModel ?? ""}
                  onChange={(e) =>
                    onChange({ ...settings, defaultModel: e.target.value || undefined })
                  }
                  className={VALUE_SELECT_CLS}
                  aria-label="Default model for chats and apps"
                >
                  <option value="">
                    Built-in default ·{" "}
                    {models.find((m) => m.id === DEFAULT_MODEL)?.label ?? DEFAULT_MODEL}
                  </option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} · {m.size}
                    </option>
                  ))}
                </select>
              </DefaultRow>
              <DefaultRow
                icon={<Search className="h-[17px] w-[17px]" />}
                label="Deep research"
                hint="Used for Structured research queries in chat. Strong long-context models lead the list."
              >
                <ResearchModelPicker
                  value={settings.researchModel}
                  onChange={(model) =>
                    onChange({ ...settings, researchModel: model })
                  }
                  hint={false}
                  className="min-w-0"
                  selectClassName={VALUE_SELECT_CLS}
                />
              </DefaultRow>
              <DefaultRow
                icon={<CalendarClock className="h-[17px] w-[17px]" />}
                label="Scheduled tasks"
                hint="Used by unattended runs - scheduled tasks, apps and widgets - unless an app sets its own model. Left on the built-in default, deep-research schedules keep using the research model above."
              >
                <select
                  value={settings.scheduledModel ?? ""}
                  onChange={(e) =>
                    onChange({ ...settings, scheduledModel: e.target.value || undefined })
                  }
                  className={VALUE_SELECT_CLS}
                  aria-label="Default model for scheduled tasks"
                >
                  <option value="">
                    Built-in default ·{" "}
                    {models.find((m) => m.id === DEFAULT_SCHEDULED_MODEL)?.label ??
                      DEFAULT_SCHEDULED_MODEL}
                  </option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} · {m.size}
                    </option>
                  ))}
                </select>
              </DefaultRow>
            </div>
          </div>

          {/* ---- Your models: the list is the star ------------------------- */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <SectionLabel>Your models</SectionLabel>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void refresh()}
                disabled={loading}
                className="shrink-0 text-muted-foreground"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                {fetchedAt ? relativeTime(fetchedAt) : "Refresh"}
              </Button>
            </div>

            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                {error}
              </div>
            )}

            {/* toolbar: search + add */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models"
                  className="h-10 rounded-xl pl-9"
                />
              </div>
              <Button
                size="sm"
                variant={addOpen ? "outline" : "default"}
                onClick={() => {
                  setAddOpen((v) => !v);
                  if (addOpen) setCustomDraft("");
                }}
                className="h-10 shrink-0 rounded-xl"
              >
                {addOpen ? (
                  <>
                    <X className="h-4 w-4" />
                    Cancel
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4" />
                    Add model
                  </>
                )}
              </Button>
            </div>

            {/* inline add — also the deep-link landing spot */}
            {addOpen && (
              <div
                ref={addCardRef}
                className={cn(
                  "flex flex-col gap-2 rounded-xl border p-3 transition",
                  highlightAdd
                    ? "border-[var(--color-accent-2)] bg-[color-mix(in_oklab,var(--color-accent-2)_8%,transparent)] ring-2 ring-[color-mix(in_oklab,var(--color-accent-2)_35%,transparent)]"
                    : "border-[color-mix(in_oklab,var(--color-accent-2)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-accent-2)_5%,transparent)]"
                )}
              >
                <div className="flex items-center gap-2">
                  <Input
                    value={customDraft}
                    onChange={(e) => setCustomDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCustomModel();
                      }
                    }}
                    placeholder="e.g. llama3.2:latest"
                    aria-label="Custom model id"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="h-9"
                  />
                  <Button
                    size="sm"
                    onClick={addCustomModel}
                    disabled={!normalizeModelId(customDraft)}
                    className="h-9 shrink-0"
                  >
                    Add &amp; enable
                  </Button>
                </div>
                <span className="text-xs text-muted-foreground">
                  Paste the exact id your account exposes - Ollama Cloud rejects
                  unknown ids. Prefix{" "}
                  <span className="font-mono">runpod:</span> to route to a RunPod
                  endpoint (set it up below).
                </span>
              </div>
            )}

            {/* filter chips */}
            <div className="flex flex-wrap gap-1.5">
              {([
                ["all", `All ${models.length}`],
                ["on", `On ${enabledCount}`],
                ["vision", `Vision ${visionCount}`],
                ["custom", `Custom ${customModels.length}`],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setFilter(id)}
                  aria-pressed={filter === id}
                  className={cn(
                    "tap rounded-full border px-3 py-1 text-xs font-medium transition",
                    filter === id
                      ? "border-[color-mix(in_oklab,var(--color-accent-2)_32%,transparent)] bg-[color-mix(in_oklab,var(--color-accent-2)_12%,transparent)] text-[var(--color-accent-2)]"
                      : "border-border bg-card text-muted-foreground hover:text-foreground"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* airy list — the whole sheet scrolls, no box-in-a-box */}
            <ul className="-mt-0.5 divide-y divide-border">
              {filtered.length === 0 && (
                <li className="py-8 text-center text-xs text-muted-foreground">
                  {models.length === 0
                    ? loading
                      ? "Loading models…"
                      : "No models found on your account."
                    : query
                      ? `No models match “${query}”.`
                      : "Nothing here yet for this filter."}
                </li>
              )}
              {filtered.map((m) => {
                const enabled = enabledSet.has(m.id);
                const isCustom = customSet.has(m.id);
                return (
                  <li key={m.id} className="flex items-center gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{m.label}</span>
                        {m.id === defaultId && <AccentBadge>Default</AccentBadge>}
                        {m.id === researchId && <AccentBadge>Research</AccentBadge>}
                        {m.id === scheduledId && <AccentBadge>Scheduled</AccentBadge>}
                        {m.vision && <Badge variant="secondary">Vision</Badge>}
                        {isCustom && <Badge variant="secondary">Custom</Badge>}
                      </div>
                      <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                        {m.id} · {m.size}
                      </span>
                    </div>
                    {isCustom && (
                      <button
                        type="button"
                        onClick={() => removeCustomModel(m.id)}
                        aria-label={`Remove ${m.label}`}
                        className="tap rounded p-1 text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => toggle(m.id)}
                      aria-pressed={enabled}
                      aria-label={enabled ? `Disable ${m.label}` : `Enable ${m.label}`}
                      className={cn(
                        "tap relative h-6 w-11 shrink-0 rounded-full transition",
                        enabled ? "bg-[var(--color-accent-2)]" : "bg-muted"
                      )}
                    >
                      <span
                        className={cn(
                          "block h-5 w-5 translate-y-0.5 rounded-full bg-white shadow transition",
                          enabled ? "translate-x-[22px]" : "translate-x-0.5"
                        )}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs">
              <button type="button" onClick={enableAll} className="tap text-muted-foreground hover:text-foreground">
                Enable all
              </button>
              <button type="button" onClick={disableAll} className="tap text-muted-foreground hover:text-foreground">
                Disable all
              </button>
              <button type="button" onClick={resetDefaults} className="tap text-muted-foreground hover:text-foreground">
                Reset to defaults
              </button>
            </div>

            {/* RunPod: niche, tucked into its own disclosure at the bottom */}
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setRunpodOpen((v) => !v)}
                className="tap flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                aria-expanded={runpodOpen}
              >
                <Server className="h-3.5 w-3.5" />
                Using a RunPod endpoint?
                <ChevronDown
                  className={cn("h-3.5 w-3.5 transition-transform", runpodOpen && "rotate-180")}
                />
              </button>
              {runpodOpen && (
                <div
                  className={cn(
                    "mt-2 flex flex-col gap-1 rounded-lg border px-2.5 py-2",
                    hasRunpodModel
                      ? "border-[color-mix(in_oklab,var(--color-accent-2)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-accent-2)_6%,transparent)]"
                      : "border-border bg-card"
                  )}
                >
                  <span className="text-xs font-medium">RunPod endpoint id</span>
                  <Input
                    value={settings.runpodEndpointId ?? ""}
                    onChange={(e) =>
                      onChange({
                        ...settings,
                        runpodEndpointId: e.target.value.trim() || undefined,
                      })
                    }
                    placeholder="e.g. fi5f7k8xyrbobj"
                    aria-label="RunPod endpoint id"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Required for any <span className="font-mono">runpod:</span>{" "}
                    model (add one above as{" "}
                    <span className="font-mono">runpod:llama3.2</span>). Find the
                    id in the RunPod console under Serverless → your endpoint.
                    The API key stays on the server (RUNPOD_API_KEY).
                    {settings.runpodEndpointId?.trim() ? (
                      <span className="ml-1">
                        Set - pick{" "}
                        <span className="font-mono">RunPod · {settings.runpodEndpointId.trim()}</span>{" "}
                        in the model picker to send chats to it.
                      </span>
                    ) : null}
                    {hasRunpodModel && !settings.runpodEndpointId?.trim() ? (
                      <span className="ml-1 font-medium text-[var(--color-accent-2)]">
                        You have a runpod: model on - set this to send chats to
                        it.
                      </span>
                    ) : null}
                  </span>
                </div>
              )}
            </div>
          </div>
            </div>
          )}
          {tab === "tools" && (
            <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <SectionLabel icon={<Globe className="h-3.5 w-3.5" />}>
              Tools live in the chat
            </SectionLabel>
            <div className="flex gap-3 rounded-2xl border border-border bg-card p-3.5">
              <span className="mt-0.5 shrink-0 text-[var(--color-accent-2)]">
                <MoreHorizontal className="h-[18px] w-[18px]" />
              </span>
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-sm font-medium">Turn tools on per chat</span>
                <span className="text-xs text-muted-foreground">
                  Web search, image search, code execution and more are toggled
                  from any chat&apos;s ••• → Tools menu. We keep them there so
                  there&apos;s a single place to flip them - no duplicate
                  switches to second-guess.
                </span>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <StateChip on={settings.webSearch}>Web search</StateChip>
                  <StateChip on={settings.imageSearch}>Image search</StateChip>
                  <StateChip on={settings.codeExec === true}>Code exec</StateChip>
                  <StateChip on={settings.appCreation === true}>App creation</StateChip>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <SectionLabel icon={<ImageIcon className="h-3.5 w-3.5" />}>
              Image description
            </SectionLabel>
            <span className="text-xs text-muted-foreground">
              When your chat model can&apos;t see images, a vision model writes a
              text caption of each upload so the chat model can still reason
              about it. Captions are cached, so re-sending the same image in a
              long chat doesn&apos;t describe it again.
            </span>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium">Describer model</span>
              <select
                value={settings.describerModel ?? ""}
                onChange={(e) =>
                  onChange({
                    ...settings,
                    describerModel: e.target.value || undefined,
                  })
                }
                className="rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground outline-none focus:border-foreground/30"
              >
                <option value="">
                  Built-in default ·{" "}
                  {models.find((m) => m.id === VISION_DESCRIBER_MODEL)?.label ??
                    VISION_DESCRIBER_MODEL}
                </option>
                {models
                  .filter((m) => m.vision)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} · {m.size}
                    </option>
                  ))}
              </select>
              <span className="text-xs text-muted-foreground">
                Pick a faster vision model here if describing images feels slow.
                Only vision-capable models are listed.
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium">Detail returned</span>
              <select
                value={settings.describeDetail ?? DEFAULT_DESCRIBE_DETAIL}
                onChange={(e) =>
                  onChange({
                    ...settings,
                    describeDetail:
                      e.target.value === DEFAULT_DESCRIBE_DETAIL
                        ? undefined
                        : (e.target.value as typeof settings.describeDetail),
                  })
                }
                className="rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground outline-none focus:border-foreground/30"
              >
                {DESCRIBE_DETAIL_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted-foreground">
                {DESCRIBE_DETAIL_OPTIONS.find(
                  (o) => o.id === (settings.describeDetail ?? DEFAULT_DESCRIBE_DETAIL)
                )?.hint}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <SectionLabel icon={<Users className="h-3.5 w-3.5" />}>
              Council
            </SectionLabel>
            <span className="text-xs text-muted-foreground">
              Multi-perspective debate. Each member is an LLM with its own
              persona; they argue, then a synthesizer pulls everything into
              one recommendation. Toggle the council on from the composer
              when you want to use it.
            </span>
            <button
              type="button"
              onClick={() => setCouncilOpen(true)}
              aria-label="Open council settings"
              className={cn(
                "tap flex items-center justify-between rounded-xl border border-border bg-card px-3 py-2.5 text-left",
                "hover:bg-muted"
              )}
            >
              <span className="flex items-center gap-2.5">
                <Users className="h-4 w-4" />
                <span className="flex flex-col">
                  <span className="text-sm font-medium">Configure council…</span>
                  <span className="text-xs text-muted-foreground">
                    {(() => {
                      const count = settings.councilMembers?.length ?? 0;
                      const rounds = settings.councilDebateRounds ?? 1;
                      if (count === 0) return "Pick a situation and members";
                      return `${count} member${count === 1 ? "" : "s"} · ${rounds} debate round${rounds === 1 ? "" : "s"}`;
                    })()}
                  </span>
                </span>
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
            </div>
          )}
          {tab === "connectors" && (
            <ConnectorsSection settings={settings} onChange={onChange} />
          )}
          {tab === "appearance" && (
            <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <SectionLabel icon={<Smile className="h-3.5 w-3.5" />}>
              Avatar style
            </SectionLabel>
            <span className="text-xs text-muted-foreground">
              How chats are illustrated in your lists and conversation
              headers. Stored per device.
            </span>

            <ul className="flex flex-col gap-1">
              {AVATAR_STYLES.map((s) => {
                const selected = avatarStyle === s.id;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setAvatarStyle(s.id as AvatarStyle)}
                      aria-pressed={selected}
                      className={cn(
                        "tap flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left",
                        selected
                          ? "border-[color-mix(in_oklab,var(--color-accent-2)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-accent-2)_10%,transparent)] text-[var(--color-accent-2)]"
                          : "border-border bg-card text-foreground"
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span
                          aria-hidden
                          className={cn(
                            "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                            selected
                              ? "border-[var(--color-accent-2)]"
                              : "border-border"
                          )}
                        >
                          {selected && (
                            <span className="h-2 w-2 rounded-full bg-[var(--color-accent-2)]" />
                          )}
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="text-sm font-medium">{s.label}</span>
                          <span className="text-xs text-muted-foreground">
                            {s.hint}
                          </span>
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <CharacterAvatar
                          id="preview-aurora"
                          style={s.id}
                          className="h-8 w-8 rounded-lg border border-border"
                        />
                        <CharacterAvatar
                          id="preview-marigold"
                          style={s.id}
                          className="h-8 w-8 rounded-lg border border-border"
                        />
                        <CharacterAvatar
                          id="preview-comet"
                          style={s.id}
                          className="h-8 w-8 rounded-lg border border-border"
                        />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="flex flex-col gap-2">
            <SectionLabel icon={<ImageIcon className="h-3.5 w-3.5" />}>
              Panel titles
            </SectionLabel>
            <button
              type="button"
              role="switch"
              aria-checked={showTitleLogo}
              onClick={() => setShowTitleLogo(!showTitleLogo)}
              className="tap flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2 text-left"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/logo-mark.png"
                  alt=""
                  aria-hidden
                  draggable={false}
                  className="h-8 w-8 shrink-0 select-none"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium">
                    Show the logo beside titles
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Adds the Lasagna mark next to panel headings like “Chats”
                    and “Widgets”. Stored per device.
                  </span>
                </span>
              </span>
              <span
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
                  showTitleLogo
                    ? "border-[color-mix(in_oklab,var(--color-accent-2)_40%,transparent)] bg-[color-mix(in_oklab,var(--color-accent-2)_35%,transparent)]"
                    : "border-border bg-secondary"
                )}
              >
                <span
                  className={cn(
                    "inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform",
                    showTitleLogo ? "translate-x-[18px]" : "translate-x-[3px]"
                  )}
                />
              </span>
            </button>
          </div>

          <FontsSection />
            </div>
          )}
          {tab === "security" && <PasskeysSection />}
          {tab === "data" && (
            <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <SectionLabel icon={<Download className="h-3.5 w-3.5" />}>
              Backup &amp; restore
            </SectionLabel>
            <span className="text-xs text-muted-foreground">
              Snapshot every chat, designer, app, and setting to a single
              file you can keep on Drive, Dropbox, or a USB stick. Restore on
              any device to bring your data back.
            </span>

            {backupError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                {backupError}
              </div>
            )}

            {!pendingRestore && (
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onClickBackup}
                    disabled={backupBusy}
                  >
                    <Download className={cn("h-3.5 w-3.5", backupBusy && "animate-pulse")} />
                    {backupBusy ? "Preparing…" : "Download backup"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={backupBusy}
                  >
                    <Upload className="h-3.5 w-3.5" />
                    Restore from file…
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".gz,.json,application/gzip,application/x-gzip,application/json"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) void onPickFile(f);
                    }}
                  />
                </div>
                {settings.lastBackupAt ? (
                  <span className="text-xs text-muted-foreground">
                    Last backup {relativeTime(settings.lastBackupAt)}
                    {typeof settings.lastBackupBytes === "number"
                      ? ` · ${formatBytes(settings.lastBackupBytes)}`
                      : ""}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    No backup taken yet on this browser.
                  </span>
                )}
              </div>
            )}

            {pendingRestore && (
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-2.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium">
                    Restore from{" "}
                    <span className="font-mono">{pendingRestore.filename}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Snapshot taken{" "}
                    {relativeTime(pendingRestore.bundle.exportedAt)} · contains{" "}
                    {bundleRowCount(pendingRestore.bundle).toLocaleString()}{" "}
                    rows · schema v{pendingRestore.bundle.dbVersion}.
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {pendingRestore.bundle.stores.messages.length} messages ·{" "}
                    {pendingRestore.bundle.stores.chats.length} chats ·{" "}
                    {pendingRestore.bundle.stores.designers.length} designers ·{" "}
                    {pendingRestore.bundle.stores.apps.length} apps
                    {pendingRestore.bundle.stores.archivedApps.length > 0 ? (
                      <>
                        {" "}·{" "}
                        {pendingRestore.bundle.stores.archivedApps.length}{" "}
                        archived
                      </>
                    ) : null}
                  </span>
                </div>

                <fieldset className="flex flex-col gap-1">
                  <legend className="sr-only">Restore mode</legend>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-card px-2.5 py-2 text-xs">
                    <input
                      type="radio"
                      name="restore-mode"
                      value="merge"
                      checked={restoreMode === "merge"}
                      onChange={() => setRestoreMode("merge")}
                      className="mt-0.5"
                    />
                    <span className="flex flex-col">
                      <span className="font-medium">Merge (safer)</span>
                      <span className="text-muted-foreground">
                        Add or overwrite rows by id. Anything you've created
                        since the backup stays. Settings get overwritten.
                      </span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-card px-2.5 py-2 text-xs">
                    <input
                      type="radio"
                      name="restore-mode"
                      value="replace"
                      checked={restoreMode === "replace"}
                      onChange={() => setRestoreMode("replace")}
                      className="mt-0.5"
                    />
                    <span className="flex flex-col">
                      <span className="font-medium">Replace (destructive)</span>
                      <span className="text-muted-foreground">
                        Wipe every chat, designer, and app first, then load the
                        backup. Anything not in the backup is gone.
                      </span>
                    </span>
                  </label>
                </fieldset>

                <label className="flex cursor-pointer items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={restoreAck}
                    onChange={(e) => setRestoreAck(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    I understand this will modify my local data and the page
                    will reload after restore.
                  </span>
                </label>

                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    onClick={onConfirmRestore}
                    disabled={!restoreAck || restoreBusy}
                  >
                    {restoreBusy
                      ? "Restoring…"
                      : restoreMode === "replace"
                        ? "Wipe & restore"
                        : "Merge restore"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={cancelRestore}
                    disabled={restoreBusy}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <SectionLabel icon={<Search className="h-3.5 w-3.5" />}>
              Search index
            </SectionLabel>
            <span className="text-xs text-muted-foreground">
              Local inverted index for the Chats page search box. Updates
              automatically as chats change; rebuild if results look stale.
            </span>

            {indexError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                {indexError}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void onRebuildIndex()}
                  disabled={indexBusy || indexStatus.kind === "loading"}
                >
                  <Search
                    className={cn(
                      "h-3.5 w-3.5",
                      (indexBusy || indexStatus.kind === "loading") && "animate-pulse"
                    )}
                  />
                  {indexBusy || indexStatus.kind === "loading"
                    ? "Rebuilding…"
                    : "Rebuild index"}
                </Button>
              </div>
              <span className="text-xs text-muted-foreground">
                {indexStatus.kind === "ready"
                  ? `Indexed ${indexStatus.index.numChats} chat${indexStatus.index.numChats === 1 ? "" : "s"} · built ${relativeTime(indexStatus.index.builtAt)}`
                  : indexStatus.kind === "loading"
                    ? `Working on ${indexStatus.chatCount} chat${indexStatus.chatCount === 1 ? "" : "s"}…`
                    : indexStatus.kind === "error"
                      ? "Index unavailable — try rebuilding."
                      : "Not built yet on this browser. Visit the Chats page to build it, or rebuild now."}
              </span>
            </div>
          </div>
            </div>
          )}
          {tab === "debug" && <DebugPanel />}
        </div>
      </DialogContent>
      <CouncilSettingsDialog
        open={councilOpen}
        onOpenChange={setCouncilOpen}
        settings={settings}
        onChange={onChange}
      />
    </Dialog>
  );
}

// Per-aspect font control. Each aspect (Interface, Headings, Reading,
// Monospace) drives one CSS variable the whole app cascades from, so a choice
// here re-skins everything that speaks that aspect. Preferences are per-device
// (localStorage) and applied live via the font store.
function FontsSection() {
  const prefs = useFontPrefs();
  const isDefault = FONT_ASPECTS.every(
    (a) => prefs[a.key] === DEFAULT_FONT_PREFS[a.key]
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex-1">
          <SectionLabel icon={<Type className="h-3.5 w-3.5" />}>Fonts</SectionLabel>
        </div>
        <Button
          variant="ghost"
          size="xs"
          onClick={resetFontPrefs}
          disabled={isDefault}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </Button>
      </div>
      <span className="text-xs text-muted-foreground">
        Pick a typeface for each part of the app. Choices apply instantly and
        are saved on this device. Each font is size-matched to the default so
        the text stays the same apparent size when you switch.
      </span>

      <div className="flex flex-col gap-3">
        {FONT_ASPECTS.map((aspect) => (
          <FontAspectRow key={aspect.key} aspect={aspect} value={prefs[aspect.key]} />
        ))}
      </div>
    </div>
  );
}

function FontAspectRow({ aspect, value }: { aspect: FontAspect; value: string }) {
  const options = useMemo(
    () => FONT_OPTIONS.filter((o) => aspect.categories.includes(o.category)),
    [aspect.categories]
  );
  const selected = FONT_OPTION_BY_ID.get(value);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col">
        <span className="text-sm font-medium">{aspect.label}</span>
        <span className="text-xs text-muted-foreground">{aspect.hint}</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {options.map((opt) => {
          const isSelected = opt.id === value;
          // Preview the optical size factor so the sample reads at the same
          // apparent size the font will render at once chosen.
          const scale = opt.sizeAdjust ?? 1;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => setFontPref(aspect.key, opt.id)}
              aria-pressed={isSelected}
              title={opt.note}
              className={cn(
                "tap flex flex-col gap-0.5 rounded-xl border px-3 py-2 text-left",
                isSelected
                  ? "border-[color-mix(in_oklab,var(--color-accent-2)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-accent-2)_10%,transparent)] text-[var(--color-accent-2)]"
                  : "border-border bg-card text-foreground"
              )}
            >
              <span className="flex items-baseline justify-between gap-1">
                <span
                  className="leading-tight"
                  style={{ fontFamily: opt.stack, fontSize: `calc(1rem * ${scale})` }}
                >
                  {opt.label}
                </span>
                {scale !== 1 ? (
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                    {Math.round(scale * 100)}%
                  </span>
                ) : null}
              </span>
              <span
                className="text-muted-foreground"
                style={{ fontFamily: opt.stack, fontSize: `calc(0.6875rem * ${scale})` }}
              >
                The quick brown fox
              </span>
            </button>
          );
        })}
      </div>
      {selected ? (
        <span className="text-[11px] text-muted-foreground/80">{selected.note}</span>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function connectorHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** POST the discovery endpoint and return the server's tools, throwing a
 *  user-facing message on any failure. Shared by add + re-discover. */
async function discoverConnectorTools(
  url: string,
  apiKey: string | undefined
): Promise<McpConnectorTool[]> {
  const res = await fetch("/api/connectors/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: url.trim(), apiKey: apiKey?.trim() || undefined }),
  });
  let data: { tools?: McpConnectorTool[]; error?: string };
  try {
    data = await res.json();
  } catch {
    throw new Error("The server returned an unexpected response.");
  }
  if (!res.ok || !Array.isArray(data.tools)) {
    throw new Error(data.error || "Couldn't reach the MCP server.");
  }
  return data.tools;
}

/**
 * Preferences → Connectors. A management surface (unlike the read-only Tools
 * tab): add a custom MCP server by URL + API key, run a discovery call to
 * enumerate its tools, and keep/refresh/remove connectors. Enablement per chat
 * is flipped from the composer ••• sheet, but a quick on/off lives here too so
 * a just-added connector is usable in one place. Generic platform capability -
 * nothing about any specific server is baked in.
 */
function ConnectorsSection({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
}) {
  const connectors = useMemo(() => settings.connectors ?? [], [settings.connectors]);
  const enabledIds = useMemo(
    () => new Set(settings.enabledConnectorIds ?? []),
    [settings.enabledConnectorIds]
  );

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const canAdd = url.trim().length > 0 && name.trim().length > 0 && !busy;

  const toggleEnabled = useCallback(
    (id: string) => {
      const next = new Set(enabledIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onChange({ ...settings, enabledConnectorIds: [...next] });
    },
    [enabledIds, onChange, settings]
  );

  const onAdd = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const tools = await discoverConnectorTools(url, apiKey);
      const connector: McpConnector = {
        id: crypto.randomUUID(),
        name: name.trim(),
        url: url.trim(),
        apiKey: apiKey.trim() || undefined,
        tools,
        discoveredAt: Date.now(),
        createdAt: Date.now(),
      };
      onChange({
        ...settings,
        connectors: [...connectors, connector],
        // Enable on add so it's immediately usable without a second trip.
        enabledConnectorIds: [...(settings.enabledConnectorIds ?? []), connector.id],
      });
      setName("");
      setUrl("");
      setApiKey("");
      toast.success(
        `Connected "${connector.name}" · ${tools.length} tool${tools.length === 1 ? "" : "s"}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Discovery failed.");
    } finally {
      setBusy(false);
    }
  }, [apiKey, connectors, name, onChange, settings, url]);

  const onRefresh = useCallback(
    async (c: McpConnector) => {
      setRefreshingId(c.id);
      try {
        const tools = await discoverConnectorTools(c.url, c.apiKey);
        onChange({
          ...settings,
          connectors: connectors.map((x) =>
            x.id === c.id ? { ...x, tools, discoveredAt: Date.now() } : x
          ),
        });
        toast.success(
          `Refreshed "${c.name}" · ${tools.length} tool${tools.length === 1 ? "" : "s"}`
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Refresh failed.");
      } finally {
        setRefreshingId(null);
      }
    },
    [connectors, onChange, settings]
  );

  const onRemove = useCallback(
    async (c: McpConnector) => {
      const ok = await confirm({
        title: `Remove “${c.name}”?`,
        body: "This deletes the connector and its saved API key from this device.",
        confirmLabel: "Remove",
      });
      if (!ok) return;
      onChange({
        ...settings,
        connectors: connectors.filter((x) => x.id !== c.id),
        enabledConnectorIds: (settings.enabledConnectorIds ?? []).filter((id) => id !== c.id),
      });
    },
    [connectors, onChange, settings]
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <SectionLabel icon={<Plug className="h-3.5 w-3.5" />}>
          Custom connectors
        </SectionLabel>
        <span className="text-xs text-muted-foreground">
          Point a chat at a remote MCP server you have an API key for. We make a
          discovery call to list its tools, then any chat can ask questions
          against them - toggle a connector on from a chat&apos;s ••• → Tools.
          The API key is stored on this device only.
        </span>
      </div>

      {/* Add form */}
      <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3.5">
        <span className="text-xs font-medium">Add an MCP server</span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (e.g. My knowledge base)"
          aria-label="Connector name"
        />
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mcp.example.com/mcp"
          aria-label="MCP server URL"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <Input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="API key (optional)"
          aria-label="API key"
          type="password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
            {error}
          </div>
        )}
        <Button onClick={() => void onAdd()} disabled={!canAdd} className="h-10">
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Connecting…
            </>
          ) : (
            <>
              <Plus className="h-4 w-4" />
              Connect &amp; discover tools
            </>
          )}
        </Button>
      </div>

      {/* Configured connectors */}
      {connectors.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No connectors yet. Add one above to expose its tools to your chats.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {connectors.map((c) => {
            const on = enabledIds.has(c.id);
            const expanded = expandedId === c.id;
            return (
              <li
                key={c.id}
                className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3.5"
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 shrink-0 text-[var(--color-accent-2)]">
                    <Plug className="h-[18px] w-[18px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{c.name}</span>
                      <Badge variant="secondary">
                        {c.tools.length} tool{c.tools.length === 1 ? "" : "s"}
                      </Badge>
                    </div>
                    <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                      {connectorHost(c.url)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleEnabled(c.id)}
                    aria-pressed={on}
                    aria-label={on ? `Disable ${c.name}` : `Enable ${c.name}`}
                    className={cn(
                      "tap relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition",
                      on ? "bg-[var(--color-accent-2)]" : "bg-muted"
                    )}
                  >
                    <span
                      className={cn(
                        "block h-5 w-5 translate-y-0.5 rounded-full bg-white shadow transition",
                        on ? "translate-x-[22px]" : "translate-x-0.5"
                      )}
                    />
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : c.id)}
                    className="tap flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    aria-expanded={expanded}
                  >
                    <ChevronDown
                      className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")}
                    />
                    {expanded ? "Hide tools" : "View tools"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void onRefresh(c)}
                    disabled={refreshingId === c.id}
                    className="tap flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  >
                    <RefreshCw
                      className={cn("h-3.5 w-3.5", refreshingId === c.id && "animate-spin")}
                    />
                    Refresh
                  </button>
                  <button
                    type="button"
                    onClick={() => void onRemove(c)}
                    className="tap flex items-center gap-1 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </button>
                </div>

                {expanded && (
                  <ul className="flex flex-col gap-1.5 border-t border-border pt-2">
                    {c.tools.map((t) => (
                      <li key={t.name} className="flex flex-col">
                        <span className="font-mono text-xs text-foreground">{t.name}</span>
                        {t.description && (
                          <span className="text-xs text-muted-foreground">{t.description}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
