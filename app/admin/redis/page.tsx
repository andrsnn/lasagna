"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Database,
  Eraser,
  Key as KeyIcon,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { PaperCard } from "@/app/components/paper-card";
import { H1 } from "@/app/components/serif-heading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type RedisKeyType =
  | "string"
  | "list"
  | "set"
  | "zset"
  | "hash"
  | "stream"
  | "json"
  | "none";

type KeyInfo = {
  key: string;
  type: RedisKeyType;
  ttl: number;
  size?: number;
};

type ListResponse = {
  cursor: string;
  done: boolean;
  keys: KeyInfo[];
  total: number;
};

type ValueResponse =
  | { key: string; type: "string"; ttl: number; value: string | null; raw: unknown }
  | {
      key: string;
      type: "list";
      ttl: number;
      length: number;
      entries: unknown[];
      truncated: boolean;
    }
  | {
      key: string;
      type: "set";
      ttl: number;
      size: number;
      members: unknown[];
      truncated: boolean;
    }
  | {
      key: string;
      type: "zset";
      ttl: number;
      size: number;
      entries: { member: unknown; score: number }[];
      truncated: boolean;
    }
  | {
      key: string;
      type: "hash";
      ttl: number;
      size: number;
      fields: Record<string, unknown>;
    }
  | { key: string; type: "stream" | "json" | "none"; ttl: number; note: string };

const TYPE_TONE: Record<RedisKeyType, string> = {
  string: "bg-blue-100 text-blue-700 border-blue-200",
  list: "bg-violet-100 text-violet-700 border-violet-200",
  set: "bg-emerald-100 text-emerald-700 border-emerald-200",
  zset: "bg-amber-100 text-amber-700 border-amber-200",
  hash: "bg-rose-100 text-rose-700 border-rose-200",
  stream: "bg-slate-200 text-slate-700 border-slate-300",
  json: "bg-cyan-100 text-cyan-700 border-cyan-200",
  none: "bg-muted text-muted-foreground border-border",
};

function formatTtl(ttl: number): string {
  if (ttl === -1) return "no expiry";
  if (ttl === -2) return "expired";
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.round(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.round(ttl / 3600)}h`;
  return `${Math.round(ttl / 86400)}d`;
}

function stringifyValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export default function RedisAdminPage() {
  const [match, setMatch] = useState("*");
  const [pendingMatch, setPendingMatch] = useState("*");
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [cursor, setCursor] = useState("0");
  const [done, setDone] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [value, setValue] = useState<ValueResponse | null>(null);
  const [loadingValue, setLoadingValue] = useState(false);
  const [valueError, setValueError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [clearing, setClearing] = useState(false);

  const fetchPage = useCallback(
    async (opts: { reset: boolean; pattern?: string }) => {
      const pattern = opts.pattern ?? match;
      const startCursor = opts.reset ? "0" : cursor;
      setLoadingKeys(true);
      setKeysError(null);
      try {
        const res = await fetch(
          `/api/admin/redis/keys?cursor=${encodeURIComponent(startCursor)}&match=${encodeURIComponent(pattern)}&count=200`
        );
        const body = (await res.json()) as ListResponse | { error: string };
        if (!res.ok || "error" in body) {
          throw new Error(("error" in body && body.error) || `HTTP ${res.status}`);
        }
        setCursor(body.cursor);
        setDone(body.done);
        setTotal(body.total);
        setKeys((prev) => {
          if (opts.reset) return body.keys;
          // SCAN may return duplicates across iterations — dedupe by key.
          const seen = new Set(prev.map((k) => k.key));
          return [...prev, ...body.keys.filter((k) => !seen.has(k.key))];
        });
      } catch (err) {
        setKeysError(err instanceof Error ? err.message : "Failed to load keys.");
      } finally {
        setLoadingKeys(false);
      }
    },
    [match, cursor]
  );

  // Initial load
  useEffect(() => {
    void fetchPage({ reset: true, pattern: "*" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadValue = useCallback(async (key: string) => {
    setSelected(key);
    setLoadingValue(true);
    setValueError(null);
    setValue(null);
    try {
      const res = await fetch(`/api/admin/redis/value?key=${encodeURIComponent(key)}`);
      const body = (await res.json()) as ValueResponse | { error: string };
      if (!res.ok || "error" in body) {
        throw new Error(("error" in body && body.error) || `HTTP ${res.status}`);
      }
      setValue(body);
    } catch (err) {
      setValueError(err instanceof Error ? err.message : "Failed to read value.");
    } finally {
      setLoadingValue(false);
    }
  }, []);

  async function deleteSelected() {
    if (!selected) return;
    if (!confirm(`Delete key "${selected}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/redis/value?key=${encodeURIComponent(selected)}`, {
        method: "DELETE",
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
      setKeys((prev) => prev.filter((k) => k.key !== selected));
      setSelected(null);
      setValue(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setDeleting(false);
    }
  }

  function applyFilter(e: React.FormEvent) {
    e.preventDefault();
    setMatch(pendingMatch || "*");
    void fetchPage({ reset: true, pattern: pendingMatch || "*" });
  }

  async function clearMatching() {
    const pattern = pendingMatch.trim() || match || "*";
    const isAll = pattern === "*";
    const first = isAll
      ? "Permanently delete ALL keys in Redis (FLUSHDB)? This cannot be undone."
      : `Permanently delete every key matching "${pattern}"? This cannot be undone.`;
    if (!confirm(first)) return;
    if (isAll && !confirm('Last chance — type-confirm by clicking OK to FLUSHDB the entire database.')) {
      return;
    }
    setClearing(true);
    try {
      const res = await fetch("/api/admin/redis/clear", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern }),
      });
      const body = (await res.json()) as
        | { ok: true; mode: "flushdb" }
        | { ok: true; mode: "scan"; deleted: number; scanned: number; done: boolean }
        | { error: string };
      if (!res.ok || "error" in body) {
        throw new Error(("error" in body && body.error) || `HTTP ${res.status}`);
      }
      setSelected(null);
      setValue(null);
      if (body.mode === "flushdb") {
        alert("Redis flushed.");
      } else {
        alert(
          `Deleted ${body.deleted} key${body.deleted === 1 ? "" : "s"}` +
            (body.done ? "." : " — more remain, run Clear again to continue.")
        );
      }
      await fetchPage({ reset: true, pattern });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Clear failed.");
    } finally {
      setClearing(false);
    }
  }

  const showingCount = useMemo(() => keys.length, [keys]);

  return (
    <div className="pt-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <H1>Redis admin</H1>
          <p className="mt-1 text-sm text-muted-foreground">
            Browse every key in the connected Upstash Redis. Glob patterns work
            (e.g. <code className="font-mono">ollchat:stream:*</code>).
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Database className="h-3.5 w-3.5" />
          <span className="font-mono tabular-nums">
            {total != null && total >= 0 ? `${total} keys total` : "—"}
          </span>
          <span>·</span>
          <span className="font-mono tabular-nums">{showingCount} loaded</span>
        </div>
      </header>

      <form onSubmit={applyFilter} className="mt-5 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={pendingMatch}
            onChange={(e) => setPendingMatch(e.target.value)}
            placeholder="Glob pattern, e.g. ollchat:stream:* or *"
            className="h-9 pl-8 font-mono text-sm"
          />
        </div>
        <Button type="submit" variant="default" className="gap-1.5">
          <Search className="h-3.5 w-3.5" />
          Filter
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void fetchPage({ reset: true })}
          className="gap-1.5"
          disabled={loadingKeys}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loadingKeys && "animate-spin")} />
          Refresh
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={() => void clearMatching()}
          className="gap-1.5"
          disabled={clearing}
          title={
            (pendingMatch.trim() || match || "*") === "*"
              ? "FLUSHDB — delete every key in Redis"
              : `Delete every key matching "${pendingMatch.trim() || match}"`
          }
        >
          {clearing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Eraser className="h-3.5 w-3.5" />
          )}
          Clear
        </Button>
      </form>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <PaperCard tone="raised" className="flex max-h-[70vh] flex-col overflow-hidden rounded-2xl">
          <div className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Keys
          </div>
          {keysError ? (
            <div className="m-3 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              {keysError}
            </div>
          ) : null}
          <div className="flex-1 overflow-y-auto">
            {keys.length === 0 && !loadingKeys ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                No keys match.
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {keys.map((k) => (
                  <li key={k.key}>
                    <button
                      type="button"
                      onClick={() => void loadValue(k.key)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-muted/60",
                        selected === k.key && "bg-muted"
                      )}
                    >
                      <KeyIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate font-mono">{k.key}</span>
                      <span
                        className={cn(
                          "shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium",
                          TYPE_TONE[k.type]
                        )}
                      >
                        {k.type}
                      </span>
                      {k.size != null ? (
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                          {k.size}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
            <span>{done ? "End of scan" : "More available"}</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => void fetchPage({ reset: false })}
              disabled={done || loadingKeys}
            >
              {loadingKeys ? <Loader2 className="h-3 w-3 animate-spin" /> : "Load more"}
            </Button>
          </div>
        </PaperCard>

        <PaperCard tone="raised" className="flex max-h-[70vh] flex-col overflow-hidden rounded-2xl">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Value
              </div>
              {selected ? (
                <div className="mt-0.5 truncate font-mono text-sm">{selected}</div>
              ) : (
                <div className="mt-0.5 text-sm text-muted-foreground">
                  Select a key on the left.
                </div>
              )}
            </div>
            {selected ? (
              <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                {value ? (
                  <>
                    <span className={cn("rounded-full border px-1.5 py-px text-[10px] font-medium", TYPE_TONE[value.type])}>
                      {value.type}
                    </span>
                    <span className="font-mono tabular-nums">TTL: {formatTtl(value.ttl)}</span>
                  </>
                ) : null}
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => void loadValue(selected)}
                  disabled={loadingValue}
                  className="gap-1"
                >
                  <RefreshCw className={cn("h-3 w-3", loadingValue && "animate-spin")} />
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="destructive"
                  onClick={() => void deleteSelected()}
                  disabled={deleting}
                  className="gap-1"
                >
                  {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                  Delete
                </Button>
              </div>
            ) : null}
          </div>
          <div className="flex-1 overflow-auto p-3">
            {valueError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                {valueError}
              </div>
            ) : loadingValue ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : value ? (
              <ValueViewer value={value} />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                No key selected.
              </div>
            )}
          </div>
        </PaperCard>
      </div>
    </div>
  );
}

function ValueViewer({ value }: { value: ValueResponse }) {
  if (value.type === "none") {
    return <p className="text-sm text-muted-foreground">{value.note}</p>;
  }

  if (value.type === "stream" || value.type === "json") {
    return <p className="text-sm text-muted-foreground">{value.note}</p>;
  }

  if (value.type === "string") {
    return (
      <div>
        <pre className="max-h-[60vh] whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-mono text-xs">
          {value.value ?? "(nil)"}
        </pre>
      </div>
    );
  }

  if (value.type === "list") {
    return (
      <div>
        <Caption>
          {value.length} item{value.length === 1 ? "" : "s"}
          {value.truncated ? ` · showing first ${value.entries.length}` : ""}
        </Caption>
        <ol className="mt-2 divide-y divide-border rounded-lg border border-border bg-muted/20 font-mono text-xs">
          {value.entries.map((entry, i) => (
            <li key={i} className="flex gap-3 px-3 py-1.5">
              <span className="w-10 shrink-0 text-right text-muted-foreground tabular-nums">{i}</span>
              <pre className="flex-1 whitespace-pre-wrap break-words">{stringifyValue(entry)}</pre>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  if (value.type === "set") {
    return (
      <div>
        <Caption>
          {value.size} member{value.size === 1 ? "" : "s"}
          {value.truncated ? ` · showing first ${value.members.length}` : ""}
        </Caption>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {value.members.map((m, i) => (
            <li
              key={i}
              className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-xs"
            >
              {stringifyValue(m)}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (value.type === "zset") {
    return (
      <div>
        <Caption>
          {value.size} entr{value.size === 1 ? "y" : "ies"}
          {value.truncated ? ` · showing first ${value.entries.length}` : ""}
        </Caption>
        <ol className="mt-2 divide-y divide-border rounded-lg border border-border bg-muted/20 font-mono text-xs">
          {value.entries.map((e, i) => (
            <li key={i} className="flex gap-3 px-3 py-1.5">
              <span className="w-20 shrink-0 truncate text-right text-muted-foreground tabular-nums">
                {e.score}
              </span>
              <pre className="flex-1 whitespace-pre-wrap break-words">{stringifyValue(e.member)}</pre>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  if (value.type === "hash") {
    const entries = Object.entries(value.fields);
    return (
      <div>
        <Caption>
          {value.size} field{value.size === 1 ? "" : "s"}
        </Caption>
        <table className="mt-2 w-full table-fixed border-collapse rounded-lg border border-border bg-muted/20 font-mono text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-muted-foreground">
              <th className="w-1/3 px-3 py-1.5 font-medium">field</th>
              <th className="px-3 py-1.5 font-medium">value</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([f, v]) => (
              <tr key={f} className="border-b border-border last:border-0 align-top">
                <td className="break-all px-3 py-1.5">{f}</td>
                <td className="px-3 py-1.5">
                  <pre className="whitespace-pre-wrap break-words">{stringifyValue(v)}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return null;
}

function Caption({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] text-muted-foreground">{children}</div>;
}
