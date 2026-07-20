"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Check, CheckCheck, Pencil, X } from "lucide-react";
import {
  deleteDesigner,
  ensureAppForDesigner,
  listApps,
  listDesigners,
  type StoredApp,
  type StoredDesigner,
} from "@/app/db";
import { archiveAppsByIds, restoreAppById } from "@/app/lib/app-archive";
import { subscribeAccountSyncPull } from "@/app/lib/account-sync";
import { gradientCss, relativeTime } from "@/app/lib/visuals";
import { useDesignerSort, type DesignerSort } from "@/app/lib/sort-prefs";
import { PaperCard } from "@/app/components/paper-card";
import { PaperPill } from "@/app/components/paper-pill";
import { H1 } from "@/app/components/serif-heading";
import { TitleLogo } from "@/app/components/title-logo";
import { SortMenu, type SortOption } from "@/app/components/sort-menu";
import { NewAppMenu } from "@/app/components/new-app-menu";
import { ArchivedAppsPanel } from "@/app/components/archived-apps-panel";
import { confirm } from "@/app/components/confirm";
import { toast } from "@/app/components/toast";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DESIGNER_SORT_OPTIONS: ReadonlyArray<SortOption<DesignerSort>> = [
  { value: "edited", label: "Last edited" },
  { value: "created", label: "Recently created" },
  { value: "name", label: "Name (A–Z)" },
];

export default function DesignersIndex() {
  const router = useRouter();
  const [designers, setDesigners] = useState<StoredDesigner[]>([]);
  const [apps, setApps] = useState<StoredApp[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [sort, setSort] = useDesignerSort();
  const [panelOpen, setPanelOpen] = useState(false);
  // Multi-select ("archive one or many"): off by default. When on, tapping a
  // card toggles its selection instead of opening it, and a bulk action bar
  // appears.
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [ds, as] = await Promise.all([listDesigners(), listApps()]);
        if (cancelled) return;
        setDesigners(ds);
        setApps(as);
      } finally {
        if (!cancelled) setHydrated(true);
      }
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

  const designerById = useMemo(
    () => new Map(designers.map((d) => [d.id, d])),
    [designers]
  );
  const appById = useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps]);

  // Live apps = designers whose paired app isn't archived. Archiving flags the
  // app row; the designer stays put so a restore brings everything back intact.
  const visibleDesigners = useMemo(() => {
    const arr = designers.filter((d) => !appById.get(d.id)?.archivedAt);
    if (sort === "name") {
      arr.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      );
    } else if (sort === "created") {
      arr.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      arr.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return arr;
  }, [designers, appById, sort]);

  // Archived apps, newest-archived first, for the side panel.
  const archivedApps = useMemo(
    () =>
      apps
        .filter((a) => a.archivedAt)
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    [apps]
  );

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelecting() {
    setSelecting(false);
    setSelectedIds(new Set());
  }

  // Archive one or many: ensure each designer has a paired app row (the flag
  // lives there), then flag + pause its schedule. Optimistically stamp the
  // local app rows so the tiles vanish immediately.
  async function archiveIds(ids: string[]) {
    if (ids.length === 0) return;
    const now = Date.now();
    setApps((prev) => {
      const map = new Map(prev.map((a) => [a.id, a]));
      for (const id of ids) {
        const existing = map.get(id);
        if (existing) {
          map.set(id, { ...existing, archivedAt: now });
        } else {
          const d = designerById.get(id);
          map.set(id, {
            id,
            name: d?.name ?? "App",
            params: {},
            archivedAt: now,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
      return [...map.values()];
    });
    try {
      // Guarantee the app row exists before flagging it (app-less designers
      // would otherwise leave nothing to persist the archive onto).
      await Promise.all(
        ids.map((id) =>
          ensureAppForDesigner(id, designerById.get(id)?.name ?? "App")
        )
      );
      await archiveAppsByIds(ids);
      toast.success(
        ids.length === 1 ? "App archived" : `${ids.length} apps archived`
      );
    } catch {
      toast.error("Couldn't archive. Refreshing…");
      const fresh = await listApps().catch(() => null);
      if (fresh) setApps(fresh);
    }
  }

  async function onArchiveOne(id: string) {
    await archiveIds([id]);
  }

  async function onArchiveSelected() {
    const ids = [...selectedIds];
    exitSelecting();
    await archiveIds(ids);
  }

  async function onRestore(app: StoredApp) {
    setPanelOpen((open) => open && archivedApps.length > 1);
    setApps((prev) =>
      prev.map((a) => {
        if (a.id !== app.id) return a;
        const { archivedAt: _drop, ...rest } = a;
        void _drop;
        return { ...rest, updatedAt: Date.now() };
      })
    );
    try {
      await restoreAppById(app.id);
      toast.success("App restored");
    } catch {
      toast.error("Couldn't restore. Refreshing…");
      const fresh = await listApps().catch(() => null);
      if (fresh) setApps(fresh);
    }
  }

  async function onDelete(app: StoredApp) {
    const name = designerById.get(app.id)?.name ?? app.name;
    const ok = await confirm({
      title: "Delete app?",
      body: `"${name}" and its designer will be removed. Its data is kept in the archive store, but the app disappears from everywhere. This can't be undone from here.`,
      confirmLabel: "Delete forever",
      destructive: true,
    });
    if (!ok) return;
    setApps((prev) => prev.filter((a) => a.id !== app.id));
    setDesigners((prev) => prev.filter((d) => d.id !== app.id));
    try {
      // deleteDesigner cascades the app into the graveyard store and drops the
      // designer + edit chat. Also unregister the server schedule so no cron
      // lingers for a deleted app.
      await deleteDesigner(app.id);
      void fetch(`/api/schedules/${encodeURIComponent(app.id)}`, {
        method: "DELETE",
      }).catch(() => {});
      toast.success("App deleted");
    } catch {
      toast.error("Couldn't delete. Refreshing…");
      const [ds, as] = await Promise.all([
        listDesigners().catch(() => null),
        listApps().catch(() => null),
      ]);
      if (ds) setDesigners(ds);
      if (as) setApps(as);
    }
  }

  const selectedCount = selectedIds.size;

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top safe-x sticky top-0 z-10 border-b border-border/60 bg-background/85 pt-3 pb-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <H1><TitleLogo />Apps</H1>
          <div className="flex items-center gap-2 sm:gap-3">
            {selecting ? (
              <button
                type="button"
                onClick={exitSelecting}
                className="tap reader-label inline-flex items-center gap-1 hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
                Cancel
              </button>
            ) : (
              <>
                <SortMenu
                  value={sort}
                  options={DESIGNER_SORT_OPTIONS}
                  onChange={setSort}
                />
                {visibleDesigners.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelecting(true)}
                    className="tap reader-label inline-flex items-center gap-1 hover:text-foreground"
                  >
                    <CheckCheck className="h-3.5 w-3.5" />
                    Select
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setPanelOpen(true)}
                  className="tap reader-label inline-flex items-center gap-1 hover:text-foreground"
                >
                  <Archive className="h-3.5 w-3.5" />
                  Archived
                  {archivedApps.length > 0 && (
                    <span className="ml-0.5 rounded-full bg-secondary px-1.5 text-[11px] tabular-nums text-secondary-foreground">
                      {archivedApps.length}
                    </span>
                  )}
                </button>
                <NewAppMenu />
              </>
            )}
          </div>
        </div>
      </header>

      <div className="scroll-area safe-x min-h-0 flex-1 pb-24">
        <div className="mx-auto w-full max-w-7xl px-3 pt-3 sm:px-6 sm:pt-6">
          {hydrated && designers.length === 0 ? (
            <PaperCard className="mt-6 flex flex-col items-center gap-4 rounded-3xl p-10 text-center text-sm text-muted-foreground">
              <p>
                No apps yet - a designer is your workspace for building one app. Describe what you want and the assistant picks a template, or start from one yourself.
              </p>
              <NewAppMenu
                label="New artifact"
                triggerClassName="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
              />
            </PaperCard>
          ) : hydrated && visibleDesigners.length === 0 ? (
            <PaperCard className="mt-6 flex flex-col items-center gap-3 rounded-3xl p-10 text-center text-sm text-muted-foreground">
              <Archive className="h-5 w-5 opacity-60" />
              <p>All your apps are archived.</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPanelOpen(true)}
                className="gap-1.5"
              >
                <Archive className="h-3.5 w-3.5" />
                Open archive ({archivedApps.length})
              </Button>
            </PaperCard>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visibleDesigners.map((d) => (
                <AppCard
                  key={d.id}
                  designer={d}
                  selecting={selecting}
                  selected={selectedIds.has(d.id)}
                  onToggleSelect={() => toggleSelected(d.id)}
                  onEdit={() => router.push(`/designer/${d.id}`)}
                  onArchive={() => void onArchiveOne(d.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Bulk action bar for multi-select archive. */}
      {selecting && selectedCount > 0 && (
        <div className="safe-x pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] z-20 flex justify-center px-3">
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-popover px-4 py-2 shadow-lg ring-1 ring-foreground/10">
            <span className="text-sm tabular-nums">
              {selectedCount} selected
            </span>
            <Button
              size="sm"
              onClick={() => void onArchiveSelected()}
              className="gap-1.5 rounded-full"
            >
              <Archive className="h-3.5 w-3.5" />
              Archive
            </Button>
          </div>
        </div>
      )}

      <ArchivedAppsPanel
        open={panelOpen}
        onOpenChange={setPanelOpen}
        archived={archivedApps}
        designerById={designerById}
        onRestore={onRestore}
        onDelete={onDelete}
      />
    </div>
  );
}

function AppCard({
  designer: d,
  selecting,
  selected,
  onToggleSelect,
  onEdit,
  onArchive,
}: {
  designer: StoredDesigner;
  selecting: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const grad = gradientCss(d.id);

  const inner = (
    <PaperCard
      tone="raised"
      className={cn(
        "group/tpl flex flex-col gap-3 p-3 transition active:bg-secondary/40 hover:border-foreground/15 sm:p-4",
        selecting && "cursor-pointer",
        selected && "border-primary ring-1 ring-primary"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="relative shrink-0">
          <div
            className="h-10 w-10 rounded-xl border border-border"
            style={{ background: grad }}
          />
          {selecting && (
            <span
              className={cn(
                "absolute -top-1.5 -left-1.5 flex h-5 w-5 items-center justify-center rounded-full border",
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-transparent"
              )}
            >
              <Check className="h-3 w-3" />
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div title={d.name} className="truncate text-[15px] font-semibold">{d.name}</div>
            {d.status === "published" ? (
              <PaperPill tone="success">{d.status}</PaperPill>
            ) : (
              <PaperPill tone="neutral">{d.status}</PaperPill>
            )}
          </div>
          <div className="line-clamp-2 text-xs text-muted-foreground">
            {d.description ?? "No description"}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>v{d.version}</span>
        <span className="font-mono tabular-nums">{relativeTime(d.updatedAt)}</span>
        {!selecting && (
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              aria-label="Archive app"
              title="Archive app"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onArchive();
              }}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/40 px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-secondary/70 hover:text-foreground"
            >
              <Archive className="h-3 w-3" />
              Archive
            </button>
            <button
              type="button"
              aria-label="Edit in designer"
              title="Edit in designer"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onEdit();
              }}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/40 px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-secondary/70 hover:text-foreground"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </button>
          </div>
        )}
      </div>
    </PaperCard>
  );

  if (selecting) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={onToggleSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleSelect();
          }
        }}
        className="tap block text-left"
      >
        {inner}
      </div>
    );
  }

  return (
    <Link href={`/apps/${d.id}`} className="tap block">
      {inner}
    </Link>
  );
}
