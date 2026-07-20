"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, Edit, Eye, EyeOff, Loader2, Maximize2, MessageSquare, Settings2, Share2 } from "lucide-react";
import {
  ARTIFACT_ENTRY_META_KEY,
  clearAppQueryCache,
  getApp,
  getDesigner,
  getPinnedNote,
  putApp,
  putDesigner,
  type ArtifactEntryMeta,
  type ResearchColumn,
  type StoredApp,
  type StoredDesigner,
  type StoredPinnedNote,
} from "@/app/db";
import { subscribeAccountSyncPull } from "@/app/lib/account-sync";
import { detectWidgetEntry } from "@/app/lib/artifact/manifest";
import { useAvailableModels } from "@/app/lib/use-available-models";
import { ArtifactFrame } from "@/app/components/artifact-frame";
import { ResearchAppView } from "@/app/components/research-app-view";
import { LinkedNoteBanner } from "@/app/components/linked-note-banner";
import { AppSettings, type AppSettingsSave } from "@/app/components/app-settings";
import { AppUpdateBanner } from "@/app/components/app-update-banner";
import { EntryErrorBanner } from "@/app/components/entry-error-banner";
import { researchManifest, researchTemplateFiles } from "@/app/lib/create";
import { syncResearchSchedule, syncScheduleModel } from "@/app/lib/research-schedule";
import { RefreshButton } from "@/app/components/refresh-button";
import { ShareDialog } from "@/app/components/share-dialog";
import { downloadAppZip } from "@/app/lib/app-zip";
import { PaperCard } from "@/app/components/paper-card";
import { PaperPill } from "@/app/components/paper-pill";
import { gradientCss, relativeTime } from "@/app/lib/visuals";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** Designer names are sometimes polluted with the assistant's prose first line
 *  (e.g. "Here's a fully self-contained interactive HTML presentation..."). Show
 *  a short, clean label in the header pill instead of a paragraph. */
function shortLabel(name: string): string {
  const clean = (name || "").trim().replace(/^["'`]+|["'`]+$/g, "");
  const firstClause = clean.split(/[.:!?\n]/)[0].trim() || clean;
  const words = firstClause.split(/\s+/).slice(0, 6).join(" ");
  return words.length > 40 ? words.slice(0, 40).trimEnd() + "…" : words;
}

export default function AppPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();

  const [app, setApp] = useState<StoredApp | null>(null);
  const [designer, setDesigner] = useState<StoredDesigner | null>(null);
  const [sourceNote, setSourceNote] = useState<StoredPinnedNote | null>(null);
  const [hydrated, setHydrated] = useState(false);
  /** Set when reload() fails (e.g. openDB() blocked by another open tab) so the
   * page shows an actionable error instead of an endless loading spinner. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [refreshSignal, setRefreshSignal] = useState(0);
  /** Entry errors the user dismissed this visit (key:error). A successful
   *  refresh clears the meta error, so dismissal only needs to be local. */
  const [dismissedEntryErrors, setDismissedEntryErrors] = useState<Set<string>>(
    () => new Set()
  );
  const [reloadKey] = useState(0);
  // Bumped to force-remount the artifact iframe so it re-reads app.state — used
  // after a structured params save (e.g. an edited research query/columns) that
  // changes seeded state the iframe only reads on mount.
  const [frameKey, setFrameKey] = useState(0);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [logs, setLogs] = useState<{ level: string; text: string; at: number }[]>([]);
  const { models: availableModels } = useAvailableModels();

  useEffect(() => {
    let cancelled = false;
    // Re-read this app + its designer from IDB. Used on mount and again
    // every time the account-sync pull merges a remote update for this id,
    // so a change made on another device shows up without a manual reload.
    const reload = async () => {
      try {
        // 1:1 invariant: app and designer share the same id.
        const a = await getApp(id);
        if (cancelled) return;
        if (!a) {
          setHydrated(true);
          return;
        }
        const d = await getDesigner(id);
        if (cancelled) return;
        setApp(a);
        setDesigner(d ?? null);
        if (d?.sourceNoteId) {
          const note = await getPinnedNote(d.sourceNoteId).catch(() => undefined);
          if (cancelled) return;
          setSourceNote(note ?? null);
        } else {
          setSourceNote(null);
        }
        setLoadError(null);
      } catch (err) {
        // A rejected DB op (commonly openDB() blocked by another open tab still
        // holding the prior schema version) must not wedge the page on its
        // spinner. Surface the message and offer a Retry below.
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Failed to load this app.");
        }
      } finally {
        if (!cancelled) setHydrated(true);
      }
    };
    void reload();
    const unsubscribe = subscribeAccountSyncPull((ev) => {
      if (ev.apps.includes(id) || ev.designers.includes(id)) {
        void reload();
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [id, reloadTick]);

  // Self-heal an existing research schedule once per app load: re-sync it to the
  // app's current query/columns/idKeys/model. This fixes schedules left on a
  // stale model (e.g. gemma) or with no columns, without the user re-saving.
  const researchSyncedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!app) return;
    const st = app.state ?? {};
    const isR =
      Array.isArray(st.columns) && typeof st.query === "string" && Array.isArray(st.records);
    if (!isR || researchSyncedRef.current === app.id) return;
    researchSyncedRef.current = app.id;
    void syncResearchSchedule(app.id, {
      query: st.query as string,
      columns: st.columns as ResearchColumn[],
      idKeys: Array.isArray(st.idKeys) ? (st.idKeys as string[]) : [],
      schema: st.schema,
      model: app.model || undefined,
    });
  }, [app]);

  const minInterval =
    designer?.manifest?.refresh?.minIntervalSeconds ?? 30;

  const handleRefresh = useCallback(async () => {
    if (!app) return;
    // Manual refresh always bypasses the cached query/fetch results — drop
    // this app's transient cache before signalling the iframe so the next
    // artifact.query hits the network. Note: app.state is NOT touched.
    await clearAppQueryCache(app.id);
    const next = { ...app, lastRunAt: Date.now(), updatedAt: Date.now() };
    await putApp(next);
    setApp(next);
    setRefreshSignal((n) => n + 1);
  }, [app]);

  const toggleWidget = useCallback(async () => {
    if (!app) return;
    // widgetEnabled is opt-out: undefined/true = on the home board, false = off.
    const next = {
      ...app,
      widgetEnabled: app.widgetEnabled === false,
      updatedAt: Date.now(),
    };
    await putApp(next);
    setApp(next);
  }, [app]);

  // Unified settings save (Option C). Persists the shell (name, model) + the
  // per-type body (declared params, or a research query/columns edit) in one
  // write, then force-remounts the iframe so it re-reads any seeded state.
  // Writing query/columns/schema onto app.state (not the artifact's files) is
  // what makes research edits robust - they can't break the build.
  const onSettingsSave = useCallback(
    async (patch: AppSettingsSave) => {
      if (!app) return;
      let next: StoredApp = {
        ...app,
        name: patch.name.trim() || "Untitled",
        model: patch.model || undefined,
        params: patch.params,
        updatedAt: Date.now(),
      };
      if (patch.researchState) {
        next = {
          ...next,
          state: {
            ...(app.state ?? {}),
            query: patch.researchState.query,
            columns: patch.researchState.columns,
            idKeys: patch.researchState.idKeys,
            schema: patch.researchState.schema,
          },
          lastRunAt: Date.now(),
        };
      }
      await putApp(next);
      setApp(next);
      setFrameKey((k) => k + 1);
      setParamsOpen(false);
      // Keep any existing scheduled refresh in lockstep with the app: same
      // query/columns/idKeys and the app's model. Derive from the SAVED state
      // (not the editor draft) so this fires on every save - including a
      // model-only change from the General tab - otherwise the schedule keeps a
      // stale model (e.g. gemma) and records with keys that don't match.
      const st2 = next.state ?? {};
      if (
        Array.isArray(st2.columns) &&
        typeof st2.query === "string" &&
        Array.isArray(st2.records)
      ) {
        void syncResearchSchedule(app.id, {
          query: st2.query,
          columns: st2.columns as ResearchColumn[],
          idKeys: Array.isArray(st2.idKeys) ? (st2.idKeys as string[]) : [],
          schema: st2.schema,
          model: patch.model || undefined,
        });
      } else {
        // Non-research apps: push the freshly-saved model onto any registered
        // schedule so server-side runs use it even when the account-store
        // app.model lookup can't (local-first apps aren't always synced).
        void syncScheduleModel(app.id, patch.model || undefined);
      }
    },
    [app]
  );

  // Heal a research app whose files/manifest were mangled by a chat code edit
  // (the cause of "Build failed" / a blank frame). Resets the designer back to
  // the canonical research template; the data is on app.state, so nothing is
  // lost. Also migrates any stray manifest model-param value onto app.model and
  // drops the param, so the single Model picker stays authoritative afterward.
  const restoreResearchLayout = useCallback(async () => {
    if (!app || !designer) return;
    const name = app.name.trim() || "Research";
    const strayModelParam = designer.manifest?.params.find((p) => p.type === "model");
    const carriedModel =
      strayModelParam && typeof app.params?.[strayModelParam.key] === "string"
        ? (app.params[strayModelParam.key] as string)
        : undefined;

    const nextDesigner: StoredDesigner = {
      ...designer,
      name,
      files: researchTemplateFiles(),
      entry: "main.tsx",
      manifest: researchManifest(name),
      version: designer.version + 1,
      updatedAt: Date.now(),
    };
    await putDesigner(nextDesigner);
    setDesigner(nextDesigner);

    if (carriedModel || strayModelParam) {
      const nextParams = { ...app.params };
      if (strayModelParam) delete nextParams[strayModelParam.key];
      const nextApp = {
        ...app,
        params: nextParams,
        model: app.model ?? carriedModel,
        updatedAt: Date.now(),
      };
      await putApp(nextApp);
      setApp(nextApp);
    }
    setFrameKey((k) => k + 1);
    setParamsOpen(false);
  }, [app, designer]);

  const handleLog = useCallback(
    (level: "log" | "warn" | "error", args: unknown[]) => {
      setLogs((prev) =>
        [
          ...prev,
          {
            level,
            text: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
            at: Date.now(),
          },
        ].slice(-20)
      );
    },
    []
  );

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="safe-top flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-muted-foreground">{loadError}</p>
        <div className="flex gap-2">
          <Button
            onClick={() => {
              setHydrated(false);
              setLoadError(null);
              setReloadTick((n) => n + 1);
            }}
          >
            Retry
          </Button>
          <Button variant="outline" onClick={() => router.push("/")}>
            Back to widgets
          </Button>
        </div>
      </div>
    );
  }

  if (!app || !designer) {
    return (
      <div className="safe-top flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-muted-foreground">App not found.</p>
        <Button variant="outline" onClick={() => router.push("/")}>
          Back to widgets
        </Button>
      </div>
    );
  }

  const st = app.state ?? {};
  const isResearch =
    Array.isArray(st.columns) && typeof st.query === "string" && Array.isArray(st.records);

  // Host-owned failure surface: a declared entry in error state is shown by
  // the HOST, independent of whether the generated app renders the hook's
  // `error`. Kept fresh via onStateChange (the frame mirrors meta writes up).
  const metaAll = (st[ARTIFACT_ENTRY_META_KEY] ?? {}) as Record<string, ArtifactEntryMeta>;
  const entryError =
    Object.entries(metaAll)
      .filter(
        ([k, m]) =>
          m?.status === "error" &&
          typeof m.error === "string" &&
          m.error &&
          !dismissedEntryErrors.has(`${k}:${m.error}`)
      )
      .map(([k, m]) => ({ key: k, error: m.error as string }))[0] ?? null;

  return (
    <div className="flex h-full flex-col">
      {/* Research apps render natively in the host (data lives on app.state),
          not in the sandboxed iframe - so the table can't render blank. */}
      {/* eslint-disable-next-line @typescript-eslint/no-unused-expressions */}
      <header
        className={
          fullscreen
            ? "hidden"
            : "safe-top sticky top-0 z-10 flex flex-col gap-2 border-b border-border/60 bg-background/85 px-2 pt-2 pb-2 backdrop-blur sm:flex-row sm:items-center sm:gap-3 sm:px-3"
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Button
            size="icon-touch"
            variant="ghost"
            onClick={() => router.push("/")}
            aria-label="Back"
            className="tap shrink-0"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div
            className="h-9 w-9 shrink-0 rounded-xl border border-border"
            style={{ background: gradientCss(app.id) }}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setRenameOpen(true)}
                title={`${app.name} — click to rename`}
                className="tap truncate text-base font-semibold hover:underline sm:text-lg"
              >
                {app.name}
              </button>
              <PaperPill tone="neutral" className="hidden max-w-[12rem] truncate sm:inline-block">
                {shortLabel(designer.name)}
              </PaperPill>
              <span className="hidden font-mono text-xs text-muted-foreground sm:inline">v{designer.version}</span>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Last refreshed {relativeTime(app.lastRunAt)}
            </div>
          </div>
        </div>

        <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
          {detectWidgetEntry(designer.files, designer.manifest) !== null && (
            <Button
              variant={app.widgetEnabled === false ? "outline" : "default"}
              size="sm"
              onClick={() => void toggleWidget()}
              aria-pressed={app.widgetEnabled !== false}
              title={
                app.widgetEnabled === false
                  ? "Hidden from the Home board — click to show it"
                  : "Showing on the Home board — click to hide it"
              }
              className="gap-1.5 px-2 sm:px-3"
            >
              {app.widgetEnabled === false ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
              <span>{app.widgetEnabled === false ? "Off Home" : "On Home"}</span>
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => router.push(`/designer/${designer.id}`)}
            className="gap-1.5 px-2 sm:px-3"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span>Edit in chat</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setParamsOpen(true)} className="gap-1.5 px-2 sm:px-3">
            <Settings2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Params</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShareOpen(true)} className="gap-1.5 px-2 sm:px-3">
            <Share2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Share</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadAppZip(designer, app)}
            aria-label="Export app as a .zip"
            title="Download this app as a .zip (editable files + data) you can edit locally and re-upload"
            className="gap-1.5 px-2 sm:px-3"
          >
            <Download className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Export .zip</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFullscreen(true)}
            aria-label="Open fullscreen"
            className="gap-1.5 px-2 sm:px-3"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Fullscreen</span>
          </Button>
          <RefreshButton
            lastRunAt={app.lastRunAt}
            minIntervalSeconds={minInterval}
            onRefresh={() => void handleRefresh()}
            className="px-2 sm:px-3"
          />
        </div>
      </header>

      {sourceNote && !fullscreen && (
        <LinkedNoteBanner note={sourceNote} onOpen={() => router.push("/notes")} />
      )}

      {/* Offer the one-time platform update in plain language, right where the
          user already is. Self-retiring: gone once the manifest carries the
          "state" block (the update landed) or the user says Not now. */}
      {!fullscreen &&
        !isResearch &&
        !!designer.manifest &&
        !designer.manifest.state &&
        !app.updateOfferDismissedAt && (
          <AppUpdateBanner
            onUpdate={() => router.push(`/designer/${designer.id}?upgrade=1`)}
            onDismiss={() => {
              const next = { ...app, updateOfferDismissedAt: Date.now(), updatedAt: Date.now() };
              void putApp(next);
              setApp(next);
            }}
          />
        )}

      {!fullscreen && entryError && (
        <EntryErrorBanner
          entryKey={entryError.key}
          error={entryError.error}
          onFixInChat={() =>
            router.push(
              `/designer/${designer.id}?prefill=${encodeURIComponent(
                `The app's data refresh for the "${entryError.key}" entry failed with this error:\n\n${entryError.error}\n\nFix the app so the refresh succeeds, and make sure the UI renders the entry's status and error so failures are visible. Run Build and fix every reported error before finishing.`
              )}`
            )
          }
          onDismiss={() =>
            setDismissedEntryErrors(
              (prev) => new Set([...prev, `${entryError.key}:${entryError.error}`])
            )
          }
        />
      )}

      <PaperCard
        className={
          fullscreen
            ? "fixed inset-0 z-[100] flex min-h-0 flex-col overflow-hidden rounded-none border-0"
            : "mx-2 mt-1 mb-2 flex min-h-0 flex-1 flex-col overflow-hidden sm:mx-4 sm:mt-2 sm:mb-4"
        }
      >
        {!fullscreen && (
          <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-muted-foreground">
            <span className="font-mono">{app.name}</span>
            {logs.length > 0 && (
              <span className="font-mono text-[10px] text-[#8a4a14] dark:text-amber-300">
                {logs.filter((l) => l.level === "error").length || logs.length} log line(s)
              </span>
            )}
          </div>
        )}
        <div
          className={
            fullscreen
              ? "flex-1 overflow-hidden border-0 bg-muted/30"
              : "flex-1 overflow-hidden rounded-xl border border-border/50 bg-muted/30 shadow-inner sm:rounded-2xl"
          }
        >
          {isResearch ? (
            <ResearchAppView
              app={app}
              refreshSignal={refreshSignal}
              onPersistRecords={(records) => {
                const next = {
                  ...app,
                  state: { ...(app.state ?? {}), records, recordsUpdatedAt: Date.now() },
                  lastRunAt: Date.now(),
                  updatedAt: Date.now(),
                };
                void putApp(next);
                setApp(next);
              }}
              onPersistPending={(streamId) => {
                const next = {
                  ...app,
                  state: {
                    ...(app.state ?? {}),
                    pendingRunStreamId: streamId ?? undefined,
                    pendingRunAt: streamId ? Date.now() : undefined,
                  },
                  updatedAt: Date.now(),
                };
                void putApp(next);
                setApp(next);
              }}
            />
          ) : (
            <ArtifactFrame
              key={frameKey}
              designer={designer}
              app={app}
              reloadKey={reloadKey}
              refreshSignal={refreshSignal}
              defaultModel={app.model ?? undefined}
              onLog={handleLog}
              onStateChange={(state) =>
                setApp((prev) => (prev ? { ...prev, state } : prev))
              }
              onAppRefreshed={(at) =>
                setApp((prev) =>
                  prev && (prev.lastRunAt ?? 0) < at ? { ...prev, lastRunAt: at } : prev
                )
              }
              className={
                fullscreen
                  ? "h-full w-full border-0"
                  : "h-full w-full rounded-2xl border-0"
              }
            />
          )}
        </div>
        {fullscreen && (
          <Button
            size="icon-touch"
            variant="outline"
            onClick={() => setFullscreen(false)}
            aria-label="Exit fullscreen"
            className="safe-top tap fixed left-3 top-3 z-[101] rounded-full bg-background/85 shadow-md backdrop-blur"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
        )}
        {logs.length > 0 && !fullscreen && (
          <details className="border-t border-border bg-muted px-4 py-2 text-[11px]">
            <summary className="cursor-pointer text-muted-foreground">
              Runtime logs ({logs.length})
            </summary>
            <div className="mt-2 max-h-32 overflow-y-auto font-mono">
              {logs.map((l, i) => (
                <div
                  key={i}
                  className={
                    "py-0.5" +
                    (l.level === "error" ? " text-destructive" : "") +
                    (l.level === "warn" ? " text-[#8a4a14] dark:text-amber-300" : "")
                  }
                >
                  [{l.level}] {l.text}
                </div>
              ))}
            </div>
          </details>
        )}
      </PaperCard>

      {paramsOpen && (
        <Dialog open={paramsOpen} onOpenChange={setParamsOpen}>
          <DialogContent variant="sheet" className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Settings</DialogTitle>
            </DialogHeader>
            <AppSettings
              app={app}
              designer={designer}
              models={availableModels}
              onSave={onSettingsSave}
              onRestoreResearch={restoreResearchLayout}
              onUpgradeToDeclaredData={() =>
                router.push(`/designer/${designer.id}?upgrade=1`)
              }
            />
          </DialogContent>
        </Dialog>
      )}

      <RenameDialog
        open={renameOpen}
        initial={app.name}
        onClose={() => setRenameOpen(false)}
        onSave={async (name) => {
          const next = { ...app, name, updatedAt: Date.now() };
          await putApp(next);
          setApp(next);
          setRenameOpen(false);
        }}
      />

      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        onSyncChange={async () => {
          const a = await getApp(id);
          if (a) setApp(a);
          const d = await getDesigner(id);
          if (d) setDesigner(d);
        }}
        app={app}
        designer={designer}
      />
    </div>
  );
}

function RenameDialog({
  open,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [val, setVal] = useState(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setVal(initial);
  }, [initial]);
  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(val.trim() || initial);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => (!v && !saving ? onClose() : null)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename app</DialogTitle>
        </DialogHeader>
        <Input
          value={val}
          autoFocus
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
          disabled={saving}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Edit className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

