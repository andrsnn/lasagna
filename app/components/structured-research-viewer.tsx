"use client";

// In-chat structured-research artifact. Self-driving: on first mount it kicks
// the research run, polls the resumable result endpoint (so a tab close mid-run
// is recovered on return), and renders the merged records as a table.
//
// A run folds in one of two ways (ResearchRun.mode):
//   - "append" - "Re-run" / "Run & append": keep the existing columns and merge
//     new rows by id (find more / refresh).
//   - "fresh" - "Run fresh" after editing the prompt: re-derive the columns from
//     the corrected query and REPLACE the rows, so a fixed prompt isn't stacked
//     on top of stale results from the old one.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Plus, AlertTriangle, Square, LayoutGrid, Check } from "lucide-react";
import type {
  ResearchColumn,
  ResearchRecord,
  StructuredResearchPayload,
} from "@/app/db";
import { createResearchApp } from "@/app/lib/create";

type RunResultPayload = {
  columns?: ResearchColumn[];
  idKeys?: string[];
  schema?: unknown;
  records?: ResearchRecord[];
  error?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mergeRecords(
  existing: ResearchRecord[],
  incoming: ResearchRecord[]
): { merged: ResearchRecord[]; addedIds: string[] } {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const addedIds: string[] = [];
  for (const rec of incoming) {
    if (!rec || typeof rec.id !== "string") continue;
    if (byId.has(rec.id)) {
      // Refresh fields on an existing row (keep prior values for blanks).
      const prev = byId.get(rec.id)!;
      const fields = { ...prev.fields };
      for (const [k, v] of Object.entries(rec.fields ?? {})) {
        if (v !== "" && v != null) fields[k] = v;
      }
      byId.set(rec.id, { id: rec.id, fields });
    } else {
      byId.set(rec.id, rec);
      addedIds.push(rec.id);
    }
  }
  return { merged: Array.from(byId.values()), addedIds };
}

export function StructuredResearchViewer({
  payload,
  onPersist,
}: {
  payload: StructuredResearchPayload;
  onPersist: (next: StructuredResearchPayload) => void;
}) {
  // Local state is authoritative once mounted (initialized from the persisted
  // payload). We deliberately do NOT re-sync from `payload` on every change:
  // every local update already flows through onPersist, so the prop only ever
  // mirrors our own writes — re-applying it would clobber records merged
  // between the persist call and the parent's re-render. On a fresh mount
  // (e.g. after reload) useState(payload) picks up the persisted snapshot and
  // the mount effect resumes any in-flight run.
  const [state, setState] = useState<StructuredResearchPayload>(payload);
  const stateRef = useRef(state);
  stateRef.current = state;

  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draftQuery, setDraftQuery] = useState(payload.query);
  // "Save as app" promotes this result into a recurring app + home widget.
  const [saving, setSaving] = useState(false);
  const [savedAppId, setSavedAppId] = useState<string | null>(null);
  const kickedRef = useRef(false);
  const pollingRef = useRef<string | null>(null);
  // Serializes runs: only one kick may be in flight at a time. Prevents a
  // double-click (or mount-kick racing a manual re-run) from appending two
  // runs whose async resolutions write streamIds onto each other's entries.
  const inFlightRef = useRef(false);

  const update = useCallback(
    (next: StructuredResearchPayload) => {
      stateRef.current = next;
      setState(next);
      onPersist(next);
    },
    [onPersist]
  );

  // Poll the resumable result endpoint until terminal. Re-issues on 504
  // (resume long-poll timed out but the run is still going).
  const poll = useCallback(
    async (streamId: string, query: string) => {
      if (pollingRef.current === streamId) return;
      pollingRef.current = streamId;
      try {
        while (pollingRef.current === streamId) {
          let res: Response;
          try {
            res = await fetch(`/api/query/resume/${encodeURIComponent(streamId)}`);
          } catch {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          if (res.status === 504) {
            // Still running. The resume endpoint normally long-polls before a
            // 504, but a proxy/edge 504 can return fast — back off so we don't
            // hot-loop the endpoint for the whole multi-minute run.
            await sleep(2000);
            continue;
          }
          const data = (await res.json().catch(() => ({}))) as RunResultPayload & {
            error?: string;
          };
          const cur = stateRef.current;
          const runs = [...cur.runs];
          const idx = runs.findIndex((r) => r.streamId === streamId);
          if (!res.ok || data.error) {
            if (idx >= 0) runs[idx] = { ...runs[idx], status: "error", error: data.error, streamId: undefined };
            update({ ...cur, runs, status: "error", error: data.error ?? `Run failed (${res.status})` });
            return;
          }
          const incoming = Array.isArray(data.records) ? data.records : [];
          const fresh = (idx >= 0 ? runs[idx]?.mode : undefined) === "fresh";
          // "fresh": adopt the re-derived shape and replace the rows (a corrected
          // prompt discards the old table). "append": keep the existing shape and
          // merge by id.
          let records: ResearchRecord[];
          let addedIds: string[];
          let columns: ResearchColumn[];
          let idKeys: string[] | undefined;
          if (fresh) {
            records = incoming;
            addedIds = []; // a full replace - nothing is "newly added" to highlight
            columns = Array.isArray(data.columns) ? data.columns : cur.columns;
            idKeys = Array.isArray(data.idKeys) ? data.idKeys : cur.idKeys;
          } else {
            const m = mergeRecords(cur.records, incoming);
            records = m.merged;
            addedIds = m.addedIds;
            columns =
              cur.columns.length > 0
                ? cur.columns
                : Array.isArray(data.columns)
                  ? data.columns
                  : [];
            idKeys =
              cur.idKeys && cur.idKeys.length > 0
                ? cur.idKeys
                : Array.isArray(data.idKeys)
                  ? data.idKeys
                  : cur.idKeys;
          }
          if (idx >= 0) {
            runs[idx] = { ...runs[idx], status: "complete", addedIds, streamId: undefined };
          }
          update({
            ...cur,
            columns,
            idKeys,
            schema: fresh ? data.schema ?? cur.schema : cur.schema ?? data.schema,
            records,
            runs,
            status: "complete",
            error: undefined,
          });
          return;
        }
      } finally {
        if (pollingRef.current === streamId) pollingRef.current = null;
        inFlightRef.current = false;
      }
    },
    [update]
  );

  // Start a run: POST the query (+ prior records for append), store the run +
  // streamId, then poll.
  const kick = useCallback(
    async (query: string, mode: "append" | "fresh" = "append") => {
      if (inFlightRef.current) return; // a run is already in flight
      inFlightRef.current = true;
      const cur = stateRef.current;
      const run = { at: Date.now(), query, status: "running" as const, mode };
      const optimistic: StructuredResearchPayload = {
        ...cur,
        query,
        status: "running",
        error: undefined,
        runs: [...cur.runs, run],
      };
      update(optimistic);
      // "fresh" re-derives the table shape and replaces rows, so it sends neither
      // the frozen columns/idKeys nor the prior rows - the engine starts clean
      // from the corrected query. "append" reuses the shape and threads prior
      // rows so the run finds NEW items.
      const freshRun = mode === "fresh";
      let streamId: string;
      try {
        const res = await fetch("/api/research/structured/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            columns: !freshRun && cur.columns.length > 0 ? cur.columns : undefined,
            idKeys:
              !freshRun && cur.idKeys && cur.idKeys.length > 0 ? cur.idKeys : undefined,
            priorRecords:
              !freshRun && cur.records.length > 0 ? cur.records : undefined,
            model: cur.model,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { streamId?: string; error?: string };
        if (!res.ok || !data.streamId) throw new Error(data.error ?? `Failed to start (${res.status})`);
        streamId = data.streamId;
      } catch (err) {
        const c = stateRef.current;
        const runs = [...c.runs];
        runs[runs.length - 1] = { ...runs[runs.length - 1], status: "error", error: err instanceof Error ? err.message : String(err) };
        update({ ...c, runs, status: "error", error: err instanceof Error ? err.message : String(err) });
        inFlightRef.current = false;
        return;
      }
      const c = stateRef.current;
      const runs = [...c.runs];
      runs[runs.length - 1] = { ...runs[runs.length - 1], streamId };
      update({ ...c, runs });
      void poll(streamId, query);
    },
    [poll, update]
  );

  // Stop the in-flight run. Two halves: (1) halt locally right away — kill the
  // poll loop, release the in-flight lock, and mark the run "stopped" so the UI
  // hands control back instantly and a later reload doesn't auto-resume it;
  // (2) best-effort tell the server to bail at its next safe boundary so it
  // stops burning compute. Any records already merged are kept.
  const stop = useCallback(() => {
    const cur = stateRef.current;
    if (cur.status !== "running") return;
    const last = cur.runs[cur.runs.length - 1];
    const streamId = last?.streamId;
    pollingRef.current = null;
    inFlightRef.current = false;
    const runs = [...cur.runs];
    if (runs.length > 0) {
      runs[runs.length - 1] = { ...runs[runs.length - 1], status: "stopped", streamId: undefined };
    }
    update({ ...cur, runs, status: "stopped", error: undefined });
    if (streamId) {
      void fetch(`/api/research/structured/stop/${encodeURIComponent(streamId)}`, {
        method: "POST",
      }).catch(() => {
        /* the run is already stopped client-side; the server flag is a bonus */
      });
    }
  }, [update]);

  // Promote this research result into a standalone app: seeds the current
  // table (query + columns + schema + rows) into a Research app you can pin as
  // a home widget and re-run/auto-refresh with the same deep engine.
  const saveAsApp = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const { app } = await createResearchApp(stateRef.current);
      setSavedAppId(app.id);
      router.push(`/apps/${app.id}`);
    } catch {
      setSaving(false);
    }
  }, [saving, router]);

  // First mount: kick the initial run; or resume an in-flight run after reload.
  useEffect(() => {
    if (kickedRef.current) return;
    kickedRef.current = true;
    const cur = stateRef.current;
    if (cur.runs.length === 0) {
      void kick(cur.query);
      return;
    }
    const last = cur.runs[cur.runs.length - 1];
    if (cur.status === "running" && last?.streamId) {
      void poll(last.streamId, last.query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const running = state.status === "running";
  const columns = state.columns;
  const lastAdded =
    state.runs.length > 1 ? state.runs[state.runs.length - 1]?.addedIds?.length ?? 0 : 0;

  // --- liveness: ticking elapsed timer + coarse stage progress ---
  const runningRun = running ? state.runs[state.runs.length - 1] : undefined;
  const runningStreamId = runningRun?.streamId;
  const startedAt = runningRun?.at;
  const [progress, setProgress] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    if (!running) {
      setProgress(null);
      return;
    }
    if (!runningStreamId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(
          `/api/research/structured/progress/${encodeURIComponent(runningStreamId)}`
        );
        if (!r.ok || cancelled) return;
        const d = (await r.json()) as { stage?: string | null };
        if (!cancelled && typeof d.stage === "string" && d.stage) setProgress(d.stage);
      } catch {
        /* ignore — liveness is best-effort */
      }
    };
    void tick();
    const t = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [running, runningStreamId]);

  const elapsed = running && startedAt ? Math.max(0, nowTick - startedAt) : 0;
  const elapsedLabel = `${Math.floor(elapsed / 60000)}:${String(
    Math.floor((elapsed % 60000) / 1000)
  ).padStart(2, "0")}`;
  const stageLabel = progress ?? "Researching…";

  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-border/70 bg-card/40">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-b border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">Research · {state.query}</div>
          <div className="text-[11px] text-muted-foreground">
            {running
              ? `${stageLabel} · ${elapsedLabel} · runs in the background, you can close the tab and come back`
              : `${state.status === "stopped" ? "Stopped · " : ""}${state.records.length} result${state.records.length === 1 ? "" : "s"}${
                  lastAdded > 0 ? ` · +${lastAdded} new last run` : ""
                }${state.runs.length > 1 ? ` · ${state.runs.length} runs` : ""}`}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 [&_button]:whitespace-nowrap">
          {running ? (
            <>
              <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-accent-2)] tabular-nums">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> {elapsedLabel}
              </span>
              <button
                type="button"
                onClick={stop}
                className="tap inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Stop this research run"
              >
                <Square className="h-3 w-3 fill-current" /> Stop
              </button>
            </>
          ) : (
            <>
              {state.records.length > 0 && (
                <button
                  type="button"
                  onClick={() => void saveAsApp()}
                  disabled={saving}
                  className="tap inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-60"
                  title="Save this table as an app you can pin as a widget and auto-refresh on a schedule"
                >
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : savedAppId ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <LayoutGrid className="h-3.5 w-3.5" />
                  )}
                  {savedAppId ? "Saved" : "Save as app"}
                </button>
              )}
              <button
                type="button"
                onClick={() => setEditing((v) => !v)}
                className="tap rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Edit query
              </button>
              <button
                type="button"
                onClick={() => void kick(state.query)}
                className="tap inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Re-run
              </button>
            </>
          )}
        </div>
      </div>

      {editing && !running && (
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <input
            value={draftQuery}
            onChange={(e) => setDraftQuery(e.target.value)}
            className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
            placeholder="Refine the research query"
          />
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              void kick(draftQuery.trim() || state.query, "fresh");
            }}
            className="tap inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground"
            title="Re-derive the columns and replace the rows from the edited prompt"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Run fresh
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              void kick(draftQuery.trim() || state.query, "append");
            }}
            className="tap inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-accent"
            title="Keep the existing table and merge in new rows"
          >
            <Plus className="h-3.5 w-3.5" /> Run &amp; append
          </button>
        </div>
      )}

      {state.status === "error" && state.error && (
        <div className="flex items-start gap-2 border-b border-border/60 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{state.error}</span>
        </div>
      )}

      {state.records.length > 0 ? (
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-card/95 backdrop-blur">
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className="border-b border-border/60 px-3 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.records.map((rec) => {
                const isNew = state.runs[state.runs.length - 1]?.addedIds?.includes(rec.id);
                return (
                  <tr key={rec.id} className={isNew ? "bg-[var(--color-accent-2)]/5" : undefined}>
                    {columns.map((c) => (
                      <td key={c.key} className="border-b border-border/40 px-3 py-1.5 align-top">
                        <CellValue value={rec.fields?.[c.key]} type={c.type} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : running ? (
        <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--color-accent-2)]" />
          <div className="text-sm font-medium">{stageLabel}</div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {elapsedLabel} elapsed · deep research usually takes 1-2 minutes
          </div>
          <div className="text-[11px] text-muted-foreground">
            Runs in the background — you can close the tab and come back.
          </div>
        </div>
      ) : state.status === "stopped" ? (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          Stopped before any results. Re-run to try again.
        </div>
      ) : (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          No results yet.
        </div>
      )}
    </div>
  );
}

function CellValue({ value, type }: { value: unknown; type?: ResearchColumn["type"] }) {
  const s = value == null ? "" : String(value);
  if (!s) return <span className="text-muted-foreground/50">—</span>;
  if (type === "link" && /^https?:\/\//i.test(s)) {
    let label = s;
    try {
      label = new URL(s).hostname.replace(/^www\./, "");
    } catch {
      /* keep raw */
    }
    return (
      <a href={s} target="_blank" rel="noreferrer" className="text-[var(--color-accent-2)] underline">
        {label}
      </a>
    );
  }
  return <span className="whitespace-pre-wrap break-words">{s}</span>;
}
