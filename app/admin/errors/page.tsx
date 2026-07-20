"use client";

// /admin/errors — internal Sentry-lite. Surfaces every server error captured
// via app/lib/error-log.ts: schedule failures, query failures, sweep crashes.
// Backed by a single capped Redis ZSET that auto-evicts after 3 days.
//
// Layout: filter chips on top (source + appId), event list on the left, and
// a detail pane on the right that shows the full stack + context for the
// selected event. Mirrors the redis admin's two-pane shape so the UI feels
// at home next to it.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertOctagon,
  ArrowUpRight,
  ChevronDown,
  Eraser,
  Filter,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { PaperCard } from "@/app/components/paper-card";
import { H1 } from "@/app/components/serif-heading";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/app/lib/visuals";

type ErrorSource =
  | "schedule"
  | "query"
  | "sweep"
  | "chat"
  | "proxy"
  | "tool"
  | "other";

type ErrorEvent = {
  id: string;
  ts: number;
  source: ErrorSource;
  message: string;
  stack?: string;
  appId?: string;
  context?: Record<string, unknown>;
};

type Stats = {
  total: number;
  bySource: Record<string, number>;
  byApp: Array<{ appId: string; count: number }>;
  oldestMs: number | null;
  newestMs: number | null;
};

type ListResponse = {
  events: ErrorEvent[];
  total: number;
  hasMore: boolean;
  stats: Stats;
};

const SOURCE_TONE: Record<ErrorSource, string> = {
  schedule: "bg-rose-100 text-rose-700 border-rose-200",
  query: "bg-amber-100 text-amber-700 border-amber-200",
  sweep: "bg-violet-100 text-violet-700 border-violet-200",
  chat: "bg-blue-100 text-blue-700 border-blue-200",
  proxy: "bg-emerald-100 text-emerald-700 border-emerald-200",
  tool: "bg-cyan-100 text-cyan-700 border-cyan-200",
  other: "bg-muted text-muted-foreground border-border",
};

const ALL_SOURCES: ErrorSource[] = [
  "schedule",
  "query",
  "sweep",
  "chat",
  "proxy",
  "tool",
  "other",
];

function formatAbsolute(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function stringifyValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export default function ErrorsAdminPage() {
  const [events, setEvents] = useState<ErrorEvent[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [sourceFilter, setSourceFilter] = useState<ErrorSource | null>(null);
  const [appFilter, setAppFilter] = useState<string | null>(null);

  const buildUrl = useCallback(
    (opts: { before?: number }) => {
      const params = new URLSearchParams();
      params.set("limit", "200");
      if (sourceFilter) params.set("source", sourceFilter);
      if (appFilter) params.set("appId", appFilter);
      if (opts.before != null) params.set("before", String(opts.before));
      return `/api/admin/errors/list?${params.toString()}`;
    },
    [sourceFilter, appFilter]
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(buildUrl({}), { cache: "no-store" });
      const body = (await r.json()) as ListResponse | { error: string };
      if (!r.ok || "error" in body) {
        throw new Error(("error" in body && body.error) || `HTTP ${r.status}`);
      }
      setEvents(body.events);
      setStats(body.stats);
      setHasMore(body.hasMore);
      // Auto-select the freshest event so the right pane has something to
      // show on first load — matches the redis admin's UX.
      setSelectedId((prev) => {
        if (prev && body.events.some((e) => e.id === prev)) return prev;
        return body.events[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [buildUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!events.length) return;
    setLoadingMore(true);
    setError(null);
    try {
      const oldest = events[events.length - 1].ts;
      const r = await fetch(buildUrl({ before: oldest }), { cache: "no-store" });
      const body = (await r.json()) as ListResponse | { error: string };
      if (!r.ok || "error" in body) {
        throw new Error(("error" in body && body.error) || `HTTP ${r.status}`);
      }
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return [...prev, ...body.events.filter((e) => !seen.has(e.id))];
      });
      setHasMore(body.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [buildUrl, events]);

  const clearAll = useCallback(async () => {
    if (
      !confirm(
        "Delete every retained error event? This wipes the dashboard for everyone."
      )
    ) {
      return;
    }
    setClearing(true);
    try {
      const r = await fetch("/api/admin/errors/clear", { method: "POST" });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      setEvents([]);
      setSelectedId(null);
      setStats({
        total: 0,
        bySource: {},
        byApp: [],
        oldestMs: null,
        newestMs: null,
      });
      setHasMore(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  }, []);

  const selectedEvent = useMemo(
    () => events.find((e) => e.id === selectedId) ?? null,
    [events, selectedId]
  );

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <H1>Errors</H1>
          <p className="mt-1 text-sm text-muted-foreground">
            Server-side failures captured over the last 3 days. Schedule runs,
            query calls, and cron sweeps all funnel into the same log so a
            failing artifact has one place to debug from.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <AlertOctagon className="h-3.5 w-3.5" />
          <span className="font-mono tabular-nums">
            {stats?.total ?? 0} retained
          </span>
          {stats?.newestMs ? (
            <>
              <span>·</span>
              <span className="font-mono tabular-nums">
                latest {relativeTime(stats.newestMs)}
              </span>
            </>
          ) : null}
        </div>
      </header>

      <PaperCard className="flex flex-col gap-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <Filter className="h-3 w-3" />
            Source
          </span>
          <SourceChip
            label="all"
            count={stats?.total ?? 0}
            active={sourceFilter == null}
            onClick={() => setSourceFilter(null)}
          />
          {ALL_SOURCES.map((s) => {
            const count = stats?.bySource[s] ?? 0;
            if (count === 0 && sourceFilter !== s) return null;
            return (
              <SourceChip
                key={s}
                label={s}
                count={count}
                tone={SOURCE_TONE[s]}
                active={sourceFilter === s}
                onClick={() => setSourceFilter(sourceFilter === s ? null : s)}
              />
            );
          })}
        </div>

        {stats && stats.byApp.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              App
            </span>
            <SourceChip
              label="all"
              count={stats.total}
              active={appFilter == null}
              onClick={() => setAppFilter(null)}
            />
            {stats.byApp.slice(0, 8).map((row) => (
              <SourceChip
                key={row.appId}
                label={row.appId}
                count={row.count}
                active={appFilter === row.appId}
                onClick={() =>
                  setAppFilter(appFilter === row.appId ? null : row.appId)
                }
              />
            ))}
          </div>
        ) : null}

        <div className="flex items-center gap-2 border-t border-border pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void refresh()}
            disabled={loading}
            className="gap-1.5"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            />
            Refresh
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void clearAll()}
            disabled={clearing || (stats?.total ?? 0) === 0}
            className="gap-1.5"
          >
            {clearing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Eraser className="h-3.5 w-3.5" />
            )}
            Clear all
          </Button>
          {(sourceFilter || appFilter) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSourceFilter(null);
                setAppFilter(null);
              }}
              className="gap-1"
            >
              <X className="h-3.5 w-3.5" />
              Clear filters
            </Button>
          )}
          {error ? (
            <span className="ml-auto rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
              {error}
            </span>
          ) : null}
        </div>
      </PaperCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <PaperCard
          tone="raised"
          className="flex max-h-[70vh] flex-col overflow-hidden rounded-2xl"
        >
          <div className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Events
          </div>
          <div className="flex-1 overflow-y-auto">
            {events.length === 0 && !loading ? (
              <div className="flex h-full items-center justify-center px-3 py-6 text-center text-xs text-muted-foreground">
                {(stats?.total ?? 0) === 0
                  ? "No errors captured yet — quiet skies."
                  : "Nothing matches the current filters."}
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {events.map((e) => (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(e.id)}
                      className={cn(
                        "flex w-full flex-col gap-1 px-3 py-2 text-left text-xs transition hover:bg-muted/60",
                        selectedId === e.id && "bg-muted"
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium",
                            SOURCE_TONE[e.source]
                          )}
                        >
                          {e.source}
                        </span>
                        {e.appId ? (
                          <span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground">
                            {e.appId}
                          </span>
                        ) : null}
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                          {relativeTime(e.ts)}
                        </span>
                      </div>
                      <div className="line-clamp-2 break-words font-mono text-[11px] text-foreground">
                        {e.message}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
            <span className="tabular-nums">
              {events.length} loaded · {stats?.total ?? 0} total
            </span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => void loadMore()}
              disabled={!hasMore || loadingMore}
              className="gap-1"
            >
              {loadingMore ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              Load older
            </Button>
          </div>
        </PaperCard>

        <PaperCard
          tone="raised"
          className="flex max-h-[70vh] flex-col overflow-hidden rounded-2xl"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Detail
              </div>
              {selectedEvent ? (
                <div className="mt-0.5 flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      "shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium",
                      SOURCE_TONE[selectedEvent.source]
                    )}
                  >
                    {selectedEvent.source}
                  </span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {formatAbsolute(selectedEvent.ts)}
                  </span>
                  <span className="text-muted-foreground">
                    ({relativeTime(selectedEvent.ts)})
                  </span>
                </div>
              ) : (
                <div className="mt-0.5 text-sm text-muted-foreground">
                  Select an event on the left.
                </div>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-auto p-3">
            {selectedEvent ? (
              <EventDetail event={selectedEvent} />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {events.length === 0
                  ? "Nothing to inspect yet."
                  : "Pick an event."}
              </div>
            )}
          </div>
        </PaperCard>
      </div>
    </div>
  );
}

function SourceChip({
  label,
  count,
  active,
  tone,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  tone?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium transition",
        active
          ? tone ?? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:bg-muted"
      )}
    >
      <span className="font-mono">{label}</span>
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}

function pickString(ctx: Record<string, unknown> | undefined, key: string): string | null {
  if (!ctx) return null;
  const v = ctx[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function EventDetail({ event }: { event: ErrorEvent }) {
  const contextEntries = event.context
    ? Object.entries(event.context).filter(([, v]) => v !== undefined && v !== null)
    : [];
  const chatId = pickString(event.context, "chatId");
  // Schedule/query/sweep errors carry appId. Apps and designers share the
  // same id (1:1 invariant) so we surface both targets — "App" jumps to the
  // running artifact, "Designer" lands where the cron and prompt are edited.
  const links: Array<{ href: string; label: string }> = [];
  if (event.appId) {
    links.push({ href: `/apps/${event.appId}`, label: "Open app" });
    links.push({ href: `/designer/${event.appId}`, label: "Open designer" });
  }
  if (chatId) {
    links.push({ href: `/chats/${chatId}`, label: "Open chat" });
  }
  return (
    <div className="flex flex-col gap-3">
      {links.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-muted"
            >
              {l.label}
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          ))}
        </div>
      ) : null}
      {event.appId ? (
        <Field label="App">
          <code className="font-mono text-xs">{event.appId}</code>
        </Field>
      ) : null}
      <Field label="Message">
        <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-mono text-xs">
          {event.message}
        </pre>
      </Field>
      {contextEntries.length > 0 ? (
        <Field label="Context">
          <table className="w-full table-fixed border-collapse rounded-lg border border-border bg-muted/20 font-mono text-xs">
            <tbody>
              {contextEntries.map(([k, v]) => (
                <tr
                  key={k}
                  className="border-b border-border align-top last:border-0"
                >
                  <td className="w-1/3 break-all px-3 py-1.5 text-muted-foreground">
                    {k}
                  </td>
                  <td className="px-3 py-1.5">
                    <pre className="whitespace-pre-wrap break-words">
                      {stringifyValue(v)}
                    </pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Field>
      ) : null}
      {event.stack ? (
        <Field label="Stack">
          <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
            {event.stack}
          </pre>
        </Field>
      ) : null}
      <Field label="Event id">
        <code className="font-mono text-[11px] text-muted-foreground">
          {event.id}
        </code>
      </Field>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
