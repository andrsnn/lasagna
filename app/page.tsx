"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Layers, Plus, Sparkles, Upload } from "lucide-react";
import {
  clearAppQueryCache,
  listApps,
  listDesigners,
  putApp,
  WIDGET_PRESETS,
  type StoredApp,
  type StoredDesigner,
  type WidgetSize,
  type WidgetSizePreset,
} from "@/app/db";
import { detectWidgetEntry } from "@/app/lib/artifact/manifest";
import { subscribeAccountSyncPull } from "@/app/lib/account-sync";
import { WidgetTile } from "@/app/components/widget-tile";
import { NewAppMenu } from "@/app/components/new-app-menu";
import { parseAppZip } from "@/app/lib/app-zip";
import { importSharedApp } from "@/app/lib/import-share";
import { toast } from "@/app/components/toast";
import { useWidgetSort, type WidgetSort } from "@/app/lib/sort-prefs";
import { H1, H2 } from "@/app/components/serif-heading";
import { TitleLogo } from "@/app/components/title-logo";
import { SortMenu, type SortOption } from "@/app/components/sort-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ORDER_STEP = 100;

const WIDGET_SORT_OPTIONS: ReadonlyArray<SortOption<WidgetSort>> = [
  { value: "manual", label: "Manual (drag)" },
  { value: "edited", label: "Last edited" },
  { value: "created", label: "Recently created" },
  { value: "name", label: "Name (A–Z)" },
];

export default function DesktopPage() {
  const router = useRouter();
  const [apps, setApps] = useState<StoredApp[]>([]);
  const [designers, setDesigners] = useState<StoredDesigner[]>([]);
  const [hydrated, setHydrated] = useState(false);
  // Module-style ref kept inside component for SSR safety; tracks the appId
  // currently being dragged. Set on dragStart, cleared on drop/dragend.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [sort, setSort] = useWidgetSort();
  const uploadRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Upload a previously-exported app .zip (editable files + data) as a new app.
  const onUploadZip = async (file: File) => {
    setUploading(true);
    try {
      const payload = parseAppZip(await file.arrayBuffer());
      const { id } = await importSharedApp(payload);
      router.push(`/apps/${id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't read that app .zip.");
      setUploading(false);
    }
  };

  // Load apps/designers from IDB and warm the query cache for widgets that
  // will mount. Also re-run whenever account-sync pulls new rows so a fresh
  // or just-synced device populates the board without a manual refresh.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      let as: StoredApp[];
      let ds: StoredDesigner[];
      try {
        [as, ds] = await Promise.all([listApps(), listDesigners()]);
      } catch {
        if (!cancelled) setHydrated(true);
        return;
      }
      if (cancelled) return;
      // Drop the per-app query cache for every widget on the board before the
      // iframes mount, so the artifact's init-time artifact.query() calls hit
      // the network instead of replaying last visit's cached result within
      // the manifest TTL window. Without this the dashboard sits on stale
      // data until the user taps into the full app to trigger a refresh.
      const designerById = new Map(ds.map((d) => [d.id, d]));
      const widgetedIds = as
        .filter((a) => {
          const d = designerById.get(a.id);
          return d != null && detectWidgetEntry(d.files, d.manifest) !== null;
        })
        .map((a) => a.id);
      await Promise.all(
        widgetedIds.map((id) => clearAppQueryCache(id).catch(() => {}))
      );
      if (cancelled) return;
      setApps(as);
      setDesigners(ds);
      setHydrated(true);
    }
    void load();
    const unsubscribe = subscribeAccountSyncPull(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // 1:1 invariant: app.id === designer.id, so a single-id lookup suffices.
  const designerById = useMemo(
    () => new Map(designers.map((d) => [d.id, d])),
    [designers]
  );

  // Only render apps whose paired designer has a widget. Apps without one
  // are reachable via the Designers tab; the home board stays focused.
  const widgetedApps = useMemo(() => {
    const filtered = apps.filter((a) => {
      // An archived app is put away: never show its widget on the board.
      if (a.archivedAt) return false;
      // A disabled app is dormant: hide its tile no matter the widget flag.
      if (a.appEnabled === false) return false;
      if (a.widgetEnabled === false) return false;
      const d = designerById.get(a.id);
      if (!d) return false;
      return detectWidgetEntry(d.files, d.manifest) !== null;
    });
    if (sort === "name") {
      return filtered.sort((a, b) => {
        const an = designerById.get(a.id)?.name ?? "";
        const bn = designerById.get(b.id)?.name ?? "";
        return an.localeCompare(bn, undefined, { sensitivity: "base" });
      });
    }
    if (sort === "created") {
      return filtered.sort((a, b) => b.createdAt - a.createdAt);
    }
    if (sort === "edited") {
      // Use the paired designer's updatedAt, which only bumps on real edits.
      // app.updatedAt is bumped on every run and would reshuffle tiles.
      return filtered.sort((a, b) => {
        const at = designerById.get(a.id)?.updatedAt ?? a.createdAt;
        const bt = designerById.get(b.id)?.updatedAt ?? b.createdAt;
        return bt - at;
      });
    }
    // Manual: explicit drag order first, then stable createdAt fallback so
    // never-dragged widgets don't reshuffle on every run.
    return filtered.sort((a, b) => {
      const ao = a.widgetOrder ?? Number.POSITIVE_INFINITY;
      const bo = b.widgetOrder ?? Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      return b.createdAt - a.createdAt;
    });
  }, [apps, designerById, sort]);

  const totalDesigners = designers.length;
  const widgetlessCount = apps.length - widgetedApps.length;

  function startNewArtifact() {
    // Chat-first creation: open the launcher where the user describes the app
    // and the AI seeds the closest template, rather than dropping straight into
    // a blank scaffold.
    setLauncherOpen(true);
  }

  function sizeFor(app: StoredApp, designer: StoredDesigner | undefined): WidgetSize {
    const preset: WidgetSizePreset =
      app.widgetSize ?? designer?.manifest?.widget?.defaultSize ?? "M";
    const meta = WIDGET_PRESETS[preset];
    return { preset, cols: meta.cols, rows: meta.rows, w: 0, h: 0 };
  }

  async function setSize(appId: string, preset: WidgetSizePreset) {
    const a = apps.find((x) => x.id === appId);
    if (!a) return;
    const now = Date.now();
    const next: StoredApp = {
      ...a,
      widgetSize: preset,
      widgetUpdatedAt: now,
      updatedAt: now,
    };
    setApps((prev) => prev.map((x) => (x.id === appId ? next : x)));
    await putApp(next).catch(() => {});
  }

  async function removeFromHome(appId: string) {
    const a = apps.find((x) => x.id === appId);
    if (!a) return;
    const now = Date.now();
    const next: StoredApp = { ...a, widgetEnabled: false, updatedAt: now };
    // Drop it from the board immediately; the paired designer's widget entry
    // is untouched, so it can be re-pinned from the app page later.
    setApps((prev) => prev.map((x) => (x.id === appId ? next : x)));
    await putApp(next).catch(() => {});
  }

  async function reorder(fromAppId: string, toAppId: string) {
    if (fromAppId === toAppId) return;
    const fromIdx = widgetedApps.findIndex((a) => a.id === fromAppId);
    const toIdx = widgetedApps.findIndex((a) => a.id === toAppId);
    if (fromIdx < 0 || toIdx < 0) return;
    // Dragging is the user expressing manual intent; flip the sort so the
    // new order persists instead of being immediately re-sorted away.
    if (sort !== "manual") setSort("manual");
    const reordered = [...widgetedApps];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    // Stamp every widgeted app with stride-100 positions so future
    // single-tile inserts don't require a full renumber.
    const now = Date.now();
    const updated: StoredApp[] = reordered.map((a, i) => ({
      ...a,
      widgetOrder: (i + 1) * ORDER_STEP,
      widgetUpdatedAt: now,
      updatedAt: now,
    }));
    // Optimistic UI: rebuild the apps list from the canonical apps array,
    // overlaying the new orders for the rows we touched.
    const updatedById = new Map(updated.map((a) => [a.id, a]));
    setApps((prev) => prev.map((a) => updatedById.get(a.id) ?? a));
    await Promise.all(updated.map((a) => putApp(a).catch(() => {})));
  }

  return (
    <div className="flex h-full flex-col">
      {/* Controlled, triggerless launcher opened by the header, empty state, and
          the "+" tile — all routes to the same chat-first creation flow. */}
      <NewAppMenu open={launcherOpen} onOpenChange={setLauncherOpen} hideTrigger />
      <header className="safe-top safe-x sticky top-0 z-10 border-b border-border/60 bg-background/85 pt-3 pb-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <H1><TitleLogo />Widgets</H1>
          <div className="flex items-center gap-3">
            <SortMenu
              value={sort}
              options={WIDGET_SORT_OPTIONS}
              onChange={setSort}
            />
            <button
              type="button"
              onClick={() => router.push("/designer")}
              className="tap reader-label inline-flex items-center gap-1 hover:text-foreground"
            >
              <Layers className="h-3.5 w-3.5" />
              Apps ({totalDesigners})
            </button>
            <button
              type="button"
              onClick={() => uploadRef.current?.click()}
              disabled={uploading}
              title="Upload an app .zip (exported files + data)"
              className="tap reader-label inline-flex items-center gap-1 hover:text-foreground disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" />
              {uploading ? "Uploading…" : "Upload .zip"}
            </button>
            <input
              ref={uploadRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void onUploadZip(f);
              }}
            />
            <button
              type="button"
              onClick={() => void startNewArtifact()}
              className="tap reader-label inline-flex items-center gap-1 hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              New artifact
            </button>
          </div>
        </div>
      </header>

      <div className="scroll-area safe-x min-h-0 flex-1 pb-16">
        <section className="mx-auto w-full max-w-7xl px-3 pt-3 sm:px-6 sm:pt-6">
          {hydrated && widgetedApps.length === 0 ? (
            <EmptyDashboard
              hasArtifacts={apps.length > 0}
              widgetlessCount={widgetlessCount}
              onCreate={() => void startNewArtifact()}
            />
          ) : (
            <div
              className={cn(
                "grid auto-rows-[160px] gap-3 sm:auto-rows-[180px]",
                "[grid-template-columns:repeat(var(--widget-cols),minmax(0,1fr))]"
              )}
              style={{ ["--widget-cols" as string]: "var(--widget-cols-default, 4)" }}
              onDragEnd={() => setDraggingId(null)}
            >
              {widgetedApps.map((app) => {
                const designer = designerById.get(app.id);
                if (!designer) return null;
                return (
                  <WidgetTile
                    key={app.id}
                    app={app}
                    designer={designer}
                    size={sizeFor(app, designer)}
                    refreshSignal={0}
                    onResize={(p) => void setSize(app.id, p)}
                    onRemoveFromHome={() => void removeFromHome(app.id)}
                    onDropAt={(toId) => {
                      if (draggingId) void reorder(draggingId, toId);
                      setDraggingId(null);
                    }}
                    onDragStartTile={(id) => setDraggingId(id)}
                  />
                );
              })}
              <NewWidgetTile onClick={() => void startNewArtifact()} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function EmptyDashboard({
  hasArtifacts,
  widgetlessCount,
  onCreate,
}: {
  hasArtifacts: boolean;
  widgetlessCount: number;
  onCreate: () => void;
}) {
  return (
    <div className="mx-auto mt-12 max-w-2xl p-10 text-center">
      <H2>No widgets yet</H2>
      <p className="reader-serif mx-auto mt-3 max-w-md text-muted-foreground italic">
        {hasArtifacts
          ? `You have ${widgetlessCount} app${widgetlessCount === 1 ? "" : "s"} without a widget. Open one in the Apps tab and ask the assistant to “add a widget” to pin it here as a live tile.`
          : "Widgets are live tiles for the apps you build. Create your first app, then ask the assistant to add a widget — it'll show up here, ready to resize and rearrange."}
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <Button onClick={onCreate} className="gap-1.5 rounded-full">
          <Sparkles className="h-3.5 w-3.5" />
          New artifact
        </Button>
        {hasArtifacts && (
          <a
            href="/designer"
            className="tap reader-label inline-flex h-8 items-center justify-center hover:text-foreground"
          >
            Browse apps
          </a>
        )}
      </div>
    </div>
  );
}

function NewWidgetTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group/new relative flex flex-col items-center justify-center gap-2 overflow-hidden rounded-lg",
        "border border-dashed border-border/80 text-muted-foreground transition",
        "hover:border-foreground/20 hover:text-foreground"
      )}
      style={{ gridColumn: "span 1", gridRow: "span 1" }}
    >
      <Plus className="h-4 w-4" />
      <span className="reader-label">New artifact</span>
    </button>
  );
}
