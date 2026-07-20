"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_RESEARCH_MODEL, DEFAULT_SCHEDULED_MODEL } from "@/app/models";
import {
  ARTIFACT_ENTRY_META_KEY,
  deletePendingQuery,
  getCachedQueriesByApp,
  getCachedQuery,
  getDesigner,
  getPendingQueriesByApp,
  loadSettings,
  mergeAppStateKey,
  putCachedQuery,
  putDesigner,
  putPendingQuery,
  touchAppLastRun,
  type ArtifactEntryMeta,
  type ArtifactFiles,
  type BuildIssue,
  type BuiltArtifact,
  type ScheduledTask,
  type StoredApp,
  type StoredDesigner,
  type WidgetSize,
} from "@/app/db";
import { composeArtifactSrcdoc, composeBuildErrorDoc } from "@/app/lib/artifact/compose";
import { vfsHash } from "@/app/lib/artifact/vfs";
import { hardenEntrySchema, interpolateTemplate, mergeCollection, resolveParamValues } from "@/app/lib/artifact/merge-engine";
import { nextAvailableMessage } from "@/app/lib/visuals";
import {
  FRAME_NAMESPACE,
  type EntrySnapshot,
  type FrameRequest,
  type FrameResponse,
  type HostMessage,
  type QueryRequestOpts,
  type ScheduleSnapshot,
} from "@/app/lib/artifact/sdk-protocol";
import { pushSdkEvent, updateSdkEventResponse } from "@/app/lib/sdk-debug-log";
import { activeConnectors, type McpRuntimeConnector } from "@/app/lib/mcp/shared";

// Default TTL for the artifact.query / artifact.fetch cache when the manifest
// doesn't specify one. Matches the RefreshButton's default cooldown so the UI
// and the cache stay in sync.
const DEFAULT_CACHE_TTL_SECONDS = 30;

// Module-level in-flight map: dedupes concurrent identical requests across
// component mounts so reload + first paint don't fire the same query twice.
const inflight = new Map<string, Promise<unknown>>();

// Per-app rate-limiting windows for query / fetch.
// These are module-level so they survive component remounts.
type RateWindow = { timestamps: number[] };
const rateWindows = new Map<string, RateWindow>();

function isRateLimited(
  appId: string,
  kind: "query" | "exec" | "fetch" | "image-search" | "download" | "open-url" | "clipboard-write",
  maxCalls: number,
  windowMs: number
): boolean {
  const key = `${appId}:${kind}`;
  const record = rateWindows.get(key);
  const now = Date.now();
  const fresh = record ? record.timestamps.filter((ts) => now - ts < windowMs) : [];
  if (fresh.length >= maxCalls) {
    rateWindows.set(key, { timestamps: fresh });
    return true;
  }
  fresh.push(now);
  rateWindows.set(key, { timestamps: fresh });
  return false;
}

// Debounce map for state.set IndexedDB writes.
const stateDebounce = new Map<string, ReturnType<typeof setTimeout>>();

// Module-level BroadcastChannel registry: one channel per appId, shared across
// all mounted ArtifactFrames so the widget on the home board picks up state
// writes the full app makes (and vice versa). Closed when no frame remains.
const stateChannels = new Map<string, { channel: BroadcastChannel; refCount: number }>();

function acquireStateChannel(appId: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const existing = stateChannels.get(appId);
  if (existing) {
    existing.refCount += 1;
    return existing.channel;
  }
  const channel = new BroadcastChannel(`artifact-state:${appId}`);
  stateChannels.set(appId, { channel, refCount: 1 });
  return channel;
}

function releaseStateChannel(appId: string): void {
  const entry = stateChannels.get(appId);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    entry.channel.close();
    stateChannels.delete(appId);
  }
}

// Sibling registry for schedule snapshots. Cron-triggered runs land
// server-side; whoever fetches a fresh snapshot (the params dialog's
// useSchedule, an iframe's pollAndPost, a widget's visibilitychange refetch)
// fans it out here so other mounted frames for the same app push it into
// their iframes without a remount.
export const SCHEDULE_CHANNEL_PREFIX = "artifact-schedule:";
const scheduleChannels = new Map<string, { channel: BroadcastChannel; refCount: number }>();

function acquireScheduleChannel(appId: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const existing = scheduleChannels.get(appId);
  if (existing) {
    existing.refCount += 1;
    return existing.channel;
  }
  const channel = new BroadcastChannel(`${SCHEDULE_CHANNEL_PREFIX}${appId}`);
  scheduleChannels.set(appId, { channel, refCount: 1 });
  return channel;
}

function releaseScheduleChannel(appId: string): void {
  const entry = scheduleChannels.get(appId);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    entry.channel.close();
    scheduleChannels.delete(appId);
  }
}

// Fan-out to sibling frames. Origin lets a frame ignore its own echoes.
function broadcastScheduleSnapshot(
  appId: string,
  snap: ScheduleSnapshot,
  origin: string
): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const ch = new BroadcastChannel(`${SCHEDULE_CHANNEL_PREFIX}${appId}`);
    ch.postMessage({ type: "schedule-updated", payload: snap, origin });
    ch.close();
  } catch {
    // Best-effort. Older browsers / odd contexts: we just stay quiet.
  }
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// Forwards an artifact.shared.* RPC to the public input endpoints. Same
// code path the public viewer uses — keeps semantics identical between
// owner and anonymous viewers.
async function forwardSharedRpc(
  token: string,
  req: FrameRequest & {
    type: "shared.append" | "shared.list" | "shared.delete";
  }
): Promise<unknown> {
  const base = `/api/share/html/${encodeURIComponent(token)}/inputs`;
  if (req.type === "shared.list") {
    const r = await fetchWithTimeout(
      `${base}?collection=${encodeURIComponent(req.collection)}`,
      { method: "GET" },
      10_000
    );
    const body = (await r.json().catch(() => ({}))) as {
      entries?: unknown;
      error?: string;
    };
    if (!r.ok) throw new Error(body.error ?? `shared.list failed (${r.status})`);
    return Array.isArray(body.entries) ? body.entries : [];
  }
  if (req.type === "shared.append") {
    const r = await fetchWithTimeout(
      base,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collection: req.collection, value: req.value }),
      },
      10_000
    );
    const body = (await r.json().catch(() => ({}))) as {
      entry?: unknown;
      error?: string;
    };
    if (!r.ok) throw new Error(body.error ?? `shared.append failed (${r.status})`);
    return body.entry ?? null;
  }
  // delete
  const r = await fetchWithTimeout(
    `${base}/${encodeURIComponent(req.entryId)}?collection=${encodeURIComponent(req.collection)}`,
    { method: "DELETE" },
    10_000
  );
  const body = (await r.json().catch(() => ({}))) as {
    removed?: boolean;
    error?: string;
  };
  if (!r.ok) throw new Error(body.error ?? `shared.delete failed (${r.status})`);
  return body.removed === true;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// djb2 — small synchronous hash, plenty for cache keying.
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function cacheKey(kind: "query" | "fetch" | "image-search", appId: string, payload: unknown): string {
  return `${kind}:${appId}:${hashString(stableStringify(payload))}`;
}

type RecoveredQuery = { prompt: string; opts?: QueryRequestOpts; result: unknown };

// Identity for a delivered query result — matches the (prompt, opts) signature
// the SDK's onQueryResult buffer dedupes on. Used to keep the on-mount
// recovered/replayed buffer free of duplicates when both the durable cache
// replay and the pending-query recovery sweep surface the same query.
function querySig(prompt: string, opts?: QueryRequestOpts): string {
  return `${prompt}::${stableStringify(opts ?? null)}`;
}

// Insert (or replace by signature) into the recovered-query buffer. The latest
// entry for a given query wins — the recovery sweep's freshly-fetched result
// supersedes a cache replay of the same query.
function bufferRecovered(buffer: RecoveredQuery[], entry: RecoveredQuery): void {
  const sig = querySig(entry.prompt, entry.opts);
  const idx = buffer.findIndex((e) => querySig(e.prompt, e.opts) === sig);
  if (idx >= 0) buffer[idx] = entry;
  else buffer.push(entry);
}

const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
const CLIPBOARD_MAX_CHARS = 2 * 1024 * 1024;
const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;

function sanitizeFilename(raw: string): string {
  // Strip path separators / null / control chars, collapse to a single segment,
  // cap length, preserve the trailing extension. Bare ".." after stripping →
  // fall back to "download".
  const oneLine = String(raw ?? "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\\/]+/g, "_")
    .replace(/\.\.+/g, "_")
    .trim();
  if (!oneLine || oneLine === "_") return "download";
  if (oneLine.length <= 200) return oneLine;
  const dot = oneLine.lastIndexOf(".");
  if (dot < 0 || dot < oneLine.length - 16) return oneLine.slice(0, 200);
  const ext = oneLine.slice(dot);
  return oneLine.slice(0, 200 - ext.length) + ext;
}

function isAllowedUrl(raw: string): URL | null {
  try {
    const u = new URL(String(raw));
    return ALLOWED_URL_PROTOCOLS.has(u.protocol) ? u : null;
  } catch {
    return null;
  }
}

function safeMime(raw: string | undefined): string {
  if (!raw) return "application/octet-stream";
  const trimmed = String(raw).trim();
  if (trimmed.length > 100 || !MIME_RE.test(trimmed)) return "application/octet-stream";
  return trimmed;
}

async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fallback for older browsers / contexts where clipboard API is unavailable.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      ta.remove();
    }
  }
}

function triggerHostDownload(filename: string, mime: string, payload: BlobPart): void {
  const blob = new Blob([payload], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function fetchScheduleSnapshot(
  appId: string,
  post: (msg: HostMessage) => void,
  origin?: string,
  onSnapshot?: (snap: ScheduleSnapshot) => void
): Promise<ScheduleSnapshot> {
  const r = await fetchWithTimeout(
    `/api/schedules/${encodeURIComponent(appId)}`,
    { method: "GET" },
    10_000
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`schedule fetch failed (${r.status})`);
  const snap = (await r.json()) as ScheduleSnapshot;
  // If the server kicked off a catch-up run, poll in the background and
  // post the settled snapshot to the iframe. The artifact's
  // onScheduleUpdate handler picks it up.
  if (snap && snap.status === "running") {
    void pollAndPost(appId, post, origin, onSnapshot);
  }
  return snap;
}

async function pollScheduleUntilSettled(
  appId: string,
  post: (msg: HostMessage) => void,
  origin?: string,
  onSnapshot?: (snap: ScheduleSnapshot) => void
): Promise<ScheduleSnapshot> {
  const final = await pollAndPost(appId, post, origin, onSnapshot);
  return final;
}

async function pollAndPost(
  appId: string,
  post: (msg: HostMessage) => void,
  origin?: string,
  onSnapshot?: (snap: ScheduleSnapshot) => void
): Promise<ScheduleSnapshot> {
  // 60s budget at 3s intervals. This caps the fan-out from a single user
  // click; longer-running tasks complete in the background and the next
  // visit picks them up via the regular GET path.
  for (let i = 0; i < 20; i++) {
    await new Promise((res) => setTimeout(res, 3000));
    const r = await fetch(`/api/schedules/${encodeURIComponent(appId)}`, {
      method: "GET",
    }).catch(() => null);
    if (!r || !r.ok) continue;
    const snap = (await r.json().catch(() => null)) as ScheduleSnapshot;
    if (!snap) continue;
    if (snap.status !== "running") {
      // Bridge BEFORE posting so declared-data entries are already merged into
      // app.state when the iframe hears about the run.
      onSnapshot?.(snap);
      post({ type: "schedule-updated", payload: snap });
      if (origin) broadcastScheduleSnapshot(appId, snap, origin);
      return snap;
    }
  }
  return null;
}

type Props = {
  designer: StoredDesigner;
  app: StoredApp;
  /**
   * In-flight VFS during a chat stream. When set, the frame builds these
   * files instead of the persisted designer, so users see live previews
   * without a save round-trip.
   */
  pendingFiles?: ArtifactFiles | null;
  pendingEntry?: string | null;
  /** Increment to force-remount the iframe (e.g. after a designer VFS save). */
  reloadKey?: number | string;
  /** Increment to send a refresh signal to the artifact (artifact.onRefresh fires). */
  refreshSignal?: number;
  /** Overrides the global user setting as the default model for artifact.query(). */
  defaultModel?: string;
  /** Called when the iframe sends a runtime error/log so the host can display it. */
  onLog?: (level: "log" | "warn" | "error", args: unknown[]) => void;
  /** Called whenever the artifact writes to artifact.state — host can persist. */
  onStateChange?: (state: Record<string, unknown>) => void;
  /** Called when the host stamps the app's "Last refreshed" clock (a declared
   *  source landed data, or a settled schedule run bridged). Lets the parent
   *  page update its in-memory app so the header doesn't say "never" until
   *  the next remount. */
  onAppRefreshed?: (at: number) => void;
  /** Called whenever a build completes (success or failure) so the host can show a status pill. */
  onBuildResult?: (r: { ok: boolean; durationMs?: number; errors?: BuildIssue[]; warnings?: BuildIssue[] }) => void;
  /**
   * When set, build the widget bundle (via /api/build target=widget) instead
   * of the full app, and push `widgetSize` into the iframe at init time. The
   * cell wrapper (e.g. WidgetTile) owns chrome — the iframe stays
   * borderless/transparent.
   */
  widget?: { size: WidgetSize } | null;
  /** Widget-only: called when the iframe body's scrollHeight changes. The
   *  host uses this to size the iframe element so its overflow-y wrapper can
   *  scroll. No-op outside widget mode. */
  onWidgetContentHeight?: (height: number) => void;
  className?: string;
};

type BuildState =
  | { kind: "idle" }
  | { kind: "building" }
  | { kind: "ok"; html: string }
  | { kind: "failed"; errors: BuildIssue[] };

type HostTheme = "light" | "dark";

/** The host theme is the `.dark` class on <html> (see theme-toggle.tsx). */
function readHostTheme(): HostTheme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * Track the host's light/dark theme, re-reading whenever the <html> class flips
 * (the ThemeToggle toggles `.dark` there). The sandboxed artifact iframe can't
 * observe this itself, so ArtifactFrame forwards it in via the SDK bridge.
 */
function useHostTheme(): HostTheme {
  const [theme, setTheme] = useState<HostTheme>(readHostTheme);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const el = document.documentElement;
    const obs = new MutationObserver(() => setTheme(readHostTheme()));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    // Sync once in case the class changed between first render and effect.
    setTheme(readHostTheme());
    return () => obs.disconnect();
  }, []);
  return theme;
}

// Per-process in-flight set so N simultaneously-mounted frames for the same
// designer (e.g. the widgets dashboard mounting 6 tiles for the same app
// across multiple breakpoints) collapse into one IDB write.
const inflightCachePersist = new Set<string>();

/**
 * Write a successful build into `designer.lastBuild` / `lastWidgetBuild` so
 * the next mount paints from cache instead of flashing "Building…". Re-reads
 * the designer to merge with concurrent writes and bails if the persisted
 * source has changed since this build started — keeps a stale build from
 * clobbering a fresh save.
 */
async function persistBuildCache(
  designerId: string,
  target: "app" | "widget",
  built: BuiltArtifact
): Promise<void> {
  const key = `${designerId}:${target}:${built.bundleHash}`;
  if (inflightCachePersist.has(key)) return;
  inflightCachePersist.add(key);
  try {
    const current = await getDesigner(designerId);
    if (!current) return;
    if (vfsHash(current.files, current.entry) !== built.bundleHash) return;
    const existing =
      target === "widget" ? current.lastWidgetBuild : current.lastBuild;
    if (existing && existing.bundleHash === built.bundleHash) return;
    const next: StoredDesigner =
      target === "widget"
        ? { ...current, lastWidgetBuild: built }
        : { ...current, lastBuild: built };
    await putDesigner(next);
  } catch {
    // Cache persistence is best-effort — a failure just means the next
    // mount rebuilds, same as today.
  } finally {
    inflightCachePersist.delete(key);
  }
}

/**
 * Sandboxed iframe that renders a designer's compiled artifact with the SDK
 * injected. Builds the multi-file VFS via /api/build, falls back to the cached
 * `designer.lastBuild` for instant cold loads. Hydrates and persists the
 * paired app's state via the SDK bridge — never strips state keys.
 */
export function ArtifactFrame({
  designer,
  app,
  pendingFiles,
  pendingEntry,
  reloadKey,
  refreshSignal,
  defaultModel: defaultModelProp,
  onLog,
  onStateChange,
  onAppRefreshed,
  onBuildResult,
  widget,
  onWidgetContentHeight,
  className,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Per-mount instance id used to ignore self-echoes on the BroadcastChannel.
  const frameInstanceIdRef = useRef<string>("");
  if (!frameInstanceIdRef.current) {
    frameInstanceIdRef.current =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const isWidget = !!widget;
  // Host light/dark theme, forwarded into the iframe so its token CSS resolves
  // to the right palette. Held in a ref too so the init handshake (inside the
  // message-listener effect) can read the latest value without re-subscribing.
  const hostTheme = useHostTheme();
  const hostThemeRef = useRef<HostTheme>(hostTheme);
  useEffect(() => {
    hostThemeRef.current = hostTheme;
  }, [hostTheme]);
  // Latest size pushed via init / widget-resized. Held in a ref so the
  // ResizeObserver can post the freshest pixel dims without re-subscribing.
  const widgetSizeRef = useRef<WidgetSize | null>(widget?.size ?? null);
  useEffect(() => {
    widgetSizeRef.current = widget?.size ?? null;
  }, [widget?.size]);

  const activeFiles = pendingFiles ?? designer.files;
  const activeEntry = pendingEntry ?? designer.entry;
  const activeHash = useMemo(() => vfsHash(activeFiles, activeEntry), [activeFiles, activeEntry]);
  const persistedHash = useMemo(
    () => vfsHash(designer.files, designer.entry),
    [designer.files, designer.entry]
  );
  // Pick the cache slot that matches the current target — widget builds are
  // cached separately on the designer to avoid clobbering the app's cache.
  const cachedBuild = isWidget ? designer.lastWidgetBuild : designer.lastBuild;
  const useCached =
    !pendingFiles &&
    !!cachedBuild &&
    cachedBuild.bundleHash === persistedHash;

  const [build, setBuild] = useState<BuildState>(() =>
    useCached && cachedBuild
      ? { kind: "ok", html: cachedBuild.html }
      : { kind: "idle" }
  );

  const [ready, setReady] = useState(false);
  // Live mirror of `ready` for use inside long-lived async callbacks (the
  // pending-query recovery sweep) without re-subscribing them on every flip.
  const readyRef = useRef(false);
  // Query results recovered on mount (in-flight when a prior mount unloaded).
  // Buffered here and re-posted to the iframe on the `ready` handshake so a
  // freshly-built frame's onQueryResult handler receives them. Survives across
  // rebuilds so the artifact can re-render the recovered result each time.
  const recoveredQueriesRef = useRef<RecoveredQuery[]>([]);
  const [userPrefs, setUserPrefs] = useState<{
    defaultModel?: string;
    /** Global default for unattended scheduled runs; see scheduledModelFor. */
    scheduledModel?: string;
    defaultWebSearch: boolean;
  }>({
    defaultWebSearch: false,
  });
  // Whether loadSettings() has resolved. Schedule registration must not run
  // before it does: scheduledModelFor resolves to a CONCRETE id, and a register
  // is an attested write (modelResolved: true) that overwrites the stored
  // model — so registering pre-load would clobber the user's configured
  // scheduled model with the built-in default.
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  // ONE source of truth for every attested schedule write. The gate flag and
  // the value it guards live in the same object and are replaced in a single
  // assignment, so it is impossible to observe "loaded" alongside a stale
  // model — a split flag/value pair races, because the flag is set from a
  // promise callback while a state mirror only updates on the next render.
  //
  // `promise` is the awaitable form of the same gate, for the schedule.define
  // RPC: that path is driven by artifact code, not our effects, so it can fire
  // before loadSettings() resolves. It awaits rather than checking a flag, so
  // an early defineSchedule() is delayed instead of dropped. Always resolved
  // in the loader's finally, so it can't hang.
  // `loaded` means "stop waiting", `resolvedOk` means "we actually know the
  // user's preference". They differ when loadSettings() REJECTS (blocked IDB
  // upgrade, Safari private browsing, storage eviction): we must open the gate
  // so schedules still register, but we must NOT claim a value we never read.
  const schedulePrefsRef = useRef<{
    loaded: boolean;
    resolvedOk: boolean;
    scheduledModel?: string;
    promise: Promise<void>;
    resolve: () => void;
  } | null>(null);
  if (!schedulePrefsRef.current) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    schedulePrefsRef.current = { loaded: false, resolvedOk: false, promise, resolve };
  }
  // Per-app model inputs, mirrored each render so the resolver below can stay
  // identity-stable. Writing props to a ref during render is safe: the value
  // is derived purely from this render's props.
  const scheduleModelInputsRef = useRef<{ paramModel?: string; appModel?: string }>({});

  // The user's configured MCP connectors (runtime shape), read at request time
  // for sources/queries that opted into mcp. A ref (not state) because it only
  // feeds outbound requests — it never affects what renders — so refreshing it
  // shouldn't churn the frame or re-run the RPC callbacks' deps.
  const mcpConnectorsRef = useRef<McpRuntimeConnector[]>([]);

  // Effective params for prompt interpolation AND the iframe's artifact.params:
  // the app's stored values with declared manifest defaults filled in. Apps
  // are created with params:{}, so without this a "{params.city}" prompt for a
  // param that has a manifest default (but no stored value) never resolves -
  // the literal placeholder gets stored and searched for, returning nothing.
  const effectiveParams = useMemo(
    () => resolveParamValues(designer.manifest?.params, app.params),
    [designer.manifest, app.params]
  );

  // If the manifest defines a model param, use the app's value for it as
  // the default model for artifact.query() calls.
  const paramModel = useMemo(() => {
    const modelParam = designer.manifest?.params.find((p) => p.type === "model");
    if (!modelParam) return undefined;
    const val = effectiveParams[modelParam.key];
    return typeof val === "string" ? val : undefined;
  }, [designer.manifest, effectiveParams]);

  // The one model every artifact.query() / schedule uses, resolved host-side:
  //   per-app model param -> app.model -> the user's global default (Preferences).
  // This is the ONLY source of truth for model selection. A model passed in
  // artifact code (artifact.query({ model }) / defineSchedule({ model })) or
  // baked into a manifest schedule is deliberately ignored — the user's
  // configured model always wins. (undefined here → server DEFAULT_MODEL.)
  const effectiveDefaultModel = paramModel ?? defaultModelProp ?? userPrefs.defaultModel;
  // The same resolution for UNATTENDED scheduled runs, which get their own
  // global default (Preferences → Defaults → Scheduled tasks) instead of the
  // interactive chat default: a cron job fires on its own and can quietly burn
  // a plan, so the fallback tier is deliberately separate. Explicit per-app
  // choices (model param, app.model) still win exactly as above; only the
  // final "user didn't pick anything" tier differs.
  //
  // Resolves to a CONCRETE id rather than leaving the built-in tier undefined,
  // because undefined can't clear anything: schedule-store deliberately
  // preserves the last known model when a register arrives with none (so a
  // frame that doesn't know app.model can't downgrade a schedule). If "Built-in
  // default" sent undefined, a schedule that already had a model stored could
  // never be moved back onto the built-in — the old value would be preserved
  // forever.
  //
  // The built-in tier is per-branch: a research schedule falls back to
  // DEFAULT_RESEARCH_MODEL, not the fast general model, so leaving the pref
  // alone doesn't silently downgrade deep research. An EXPLICIT pref applies to
  // every scheduled run including research — it's a global "scheduled tasks"
  // setting and quietly exempting research would be the surprising behavior.
  //
  // Reads every input through a ref and takes NO deps, so its identity never
  // changes and it cannot go stale. That matters because two callers are async
  // or long-lived closures: the schedule.define RPC handler suspends on the
  // gate and resumes with its ORIGINAL closure, and the schedule-snapshot
  // effect pins its dep array. A value captured before Preferences loaded
  // would write the built-in default over the user's configured model.
  scheduleModelInputsRef.current = { paramModel, appModel: defaultModelProp };
  const scheduledModelFor = useCallback((research?: boolean): string | undefined => {
    const { paramModel: pm, appModel } = scheduleModelInputsRef.current;
    // Explicit per-app choices are props — known even if settings failed.
    if (pm) return pm;
    if (appModel) return appModel;
    // Settings never loaded: we don't know the preference, so resolve to
    // undefined rather than guessing. An attested register carrying undefined
    // hits schedule-store's preservation rule and leaves the stored model
    // alone — the difference between "use the built-in" and "we have no idea",
    // which a concrete fallback here would silently collapse into a clobber.
    const prefs = schedulePrefsRef.current;
    if (!prefs?.resolvedOk) return undefined;
    return (
      prefs.scheduledModel ?? (research ? DEFAULT_RESEARCH_MODEL : DEFAULT_SCHEDULED_MODEL)
    );
  }, []);
  const stateRef = useRef<Record<string, unknown>>({ ...(app.state ?? {}) });
  // BroadcastChannel handle. Acquired in an effect (so SSR + tests don't
  // crash); the state.set RPC reads it through this ref to broadcast writes.
  const channelRef = useRef<BroadcastChannel | null>(null);
  // Active public-share token for this app, if any. Looked up at mount via
  // /api/share-html/by-app/[appId]; pushed into the iframe on init so
  // artifact.shared.* can route to the right share. null until the lookup
  // completes (or when the artifact has never been shared).
  const shareTokenRef = useRef<string | null>(null);

  // Look up the active public share token for this app (if any). We
  // store it on a ref so the init message + later RPCs can read it
  // without waiting. The same artifact can be shared multiple times,
  // so we always refresh on app.id change.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/share-html/by-app/${encodeURIComponent(app.id)}`,
          { method: "GET" }
        );
        if (cancelled) return;
        if (!r.ok) {
          shareTokenRef.current = null;
          return;
        }
        const body = (await r.json().catch(() => ({}))) as { token?: string | null };
        shareTokenRef.current =
          typeof body.token === "string" && body.token ? body.token : null;
        // If the artifact is already running, push the freshly-discovered
        // token in so shared.* starts working without a remount.
        if (shareTokenRef.current) {
          iframeRef.current?.contentWindow?.postMessage(
            {
              ns: FRAME_NAMESPACE,
              payload: {
                type: "share-token-updated",
                shareToken: shareTokenRef.current,
              } satisfies HostMessage,
            },
            "*"
          );
        }
      } catch {
        // Network/Redis blip — sharing just won't work this session. Will
        // recover on next mount.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [app.id]);

  // Pull the user's last-selected model + web-search preference so artifacts
  // inherit them as defaults for artifact.query() calls.
  useEffect(() => {
    let cancelled = false;
    loadSettings()
      .then((s) => {
        // Publish the scheduled-model value BEFORE anything can observe the
        // gate as open (the gate flips in .finally below). Deliberately not
        // behind the `cancelled` check: the ref feeds outbound writes, not
        // render, and a stale value here is exactly the clobber this guards.
        const prefs = schedulePrefsRef.current;
        if (prefs) {
          prefs.scheduledModel = s.scheduledModel;
          prefs.resolvedOk = true;
        }
        if (cancelled) return;
        setUserPrefs({
          defaultModel: s.defaultModel,
          scheduledModel: s.scheduledModel,
          defaultWebSearch: !!s.webSearch,
        });
        // Expose ALL configured connectors to mcp-flagged sources: a source
        // declaring mcp:true is itself the opt-in, and connector ids aren't
        // knowable at authoring time, so an app can't pick specific ones. The
        // model targets the right tool by name from the source prompt.
        mcpConnectorsRef.current = activeConnectors(
          s.connectors,
          s.connectors?.map((c) => c.id)
        );
      })
      .catch(() => {
        // best-effort — fall back to server defaults
      })
      .finally(() => {
        // Opened on BOTH paths. Schedule registration is gated on this:
        // registering before settings resolve would write the built-in
        // scheduled model over the user's configured one. On a load failure we
        // still open it — a schedule that never registers is worse than one
        // registered on the built-in default. Opened even when cancelled, so
        // an in-flight schedule.define on an unmounting frame can't hang.
        //
        // Ordering is load-bearing: scheduledModel above is already published,
        // so no reader can see loaded === true with a stale model.
        const prefs = schedulePrefsRef.current;
        if (prefs) {
          prefs.loaded = true;
          prefs.resolve();
        }
        if (cancelled) return;
        setPrefsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build whenever the active VFS changes (and we're not using a cached build).
  useEffect(() => {
    let cancelled = false;
    if (useCached && cachedBuild) {
      setBuild({ kind: "ok", html: cachedBuild.html });
      onBuildResult?.({ ok: true });
      return;
    }
    setBuild({ kind: "building" });
    setReady(false);
    readyRef.current = false;
    // Capture build identity so the post-success persist can verify the
    // designer's persisted state hasn't changed mid-flight (a chat-edit save
    // could land while we were bundling).
    const builtForTarget: "app" | "widget" = isWidget ? "widget" : "app";
    const builtForHash = activeHash;
    const builtForDesignerId = designer.id;
    const builtAgainstPending = !!pendingFiles;
    fetch("/api/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: activeFiles,
        entry: activeEntry,
        target: builtForTarget,
      }),
    })
      .then(async (r) => {
        const data = (await r.json()) as
          | { ok: true; html: string; durationMs?: number; warnings?: BuildIssue[] }
          | { ok: false; errors: BuildIssue[]; warnings?: BuildIssue[]; durationMs?: number };
        if (cancelled) return;
        if (data.ok) {
          setBuild({ kind: "ok", html: data.html });
          onBuildResult?.({ ok: true, durationMs: data.durationMs, warnings: data.warnings });
          // Persist into IDB so the next mount paints from cache — but
          // only when the build reflects the persisted source. Skipping
          // pending-edit builds keeps the cache aligned with the saved
          // version, which is what dashboard tiles render against.
          if (!builtAgainstPending) {
            void persistBuildCache(builtForDesignerId, builtForTarget, {
              html: data.html,
              bundleHash: builtForHash,
              builtAt: Date.now(),
              warnings: data.warnings,
            });
          }
        } else {
          setBuild({ kind: "failed", errors: data.errors });
          onBuildResult?.({ ok: false, errors: data.errors, warnings: data.warnings, durationMs: data.durationMs });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Build failed";
        const issue: BuildIssue = { file: "<network>", line: 0, column: 0, message };
        setBuild({ kind: "failed", errors: [issue] });
        onBuildResult?.({ ok: false, errors: [issue] });
      });
    return () => {
      cancelled = true;
    };
    // We deliberately omit onBuildResult & designer.lastBuild from deps:
    // - onBuildResult is a callback parents commonly recreate per render;
    // - lastBuild only matters when we decided to use it (handled by useCached).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHash, useCached, reloadKey, isWidget]);

  // When build flips, reset the ready handshake so we re-init the frame.
  // Re-hydrate from the prop UNDER the in-memory mirror: the prop is a
  // snapshot from when the parent loaded the app, while the mirror carries
  // every write made since mount (iframe state.set, host-run sources, the
  // recovery sweep, the schedule bridge). Replacing instead of merging let a
  // slow build clobber a source result that landed while esbuild was running.
  useEffect(() => {
    if (build.kind === "ok") {
      setReady(false);
      readyRef.current = false;
      stateRef.current = { ...(app.state ?? {}), ...stateRef.current };
    }
  }, [build, app.state]);

  const post = useCallback((msg: HostMessage) => {
    iframeRef.current?.contentWindow?.postMessage({ ns: FRAME_NAMESPACE, payload: msg }, "*");
    // Log the background schedule completion delivery so a COMPLETED run (with
    // its data) is visible in the debug log, not just the call that started it.
    // We do NOT log query-result here: the artifact.query result is already
    // recorded as the iframe→host "query" RPC response, so logging the push too
    // would double the (often large) payload. init/params/config/refresh have
    // their own call sites.
    if (msg.type === "schedule-updated") {
      pushSdkEvent(app.id, {
        id: `schedule-updated-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        at: Date.now(),
        direction: "host-to-iframe",
        type: "schedule-updated",
        payload: msg.payload,
      });
    }
  }, [app.id]);

  const reply = useCallback((res: FrameResponse) => {
    iframeRef.current?.contentWindow?.postMessage({ ns: FRAME_NAMESPACE, payload: res }, "*");
  }, []);

  // ----- Declared data (SDK v2): host-owned entry writes ---------------------
  //
  // Every write a declared source produces goes through hostWriteStateKey so
  // ALL surfaces converge on the same value: this frame's SDK (post), sibling
  // frames (BroadcastChannel), the durable store (mergeAppStateKey), and other
  // devices (account-sync via the store hook). Generated code never bridges.

  const hostWriteStateKey = useCallback(
    async (key: string, value: unknown) => {
      stateRef.current = { ...stateRef.current, [key]: value };
      onStateChange?.(stateRef.current);
      channelRef.current?.postMessage({
        type: "state-merged",
        key,
        value,
        origin: frameInstanceIdRef.current,
      });
      post({ type: "state-merged", key, value });
      await mergeAppStateKey(app.id, key, value).catch(() => {});
    },
    [app.id, onStateChange, post]
  );

  const patchEntryMeta = useCallback(
    async (
      key: string,
      patch: {
        status: ArtifactEntryMeta["status"];
        lastRefreshedAt?: number;
        scheduleRunAt?: number;
        attemptAt?: number;
        /** string sets, null clears, undefined keeps. */
        error?: string | null;
      }
    ): Promise<ArtifactEntryMeta> => {
      const all = {
        ...((stateRef.current[ARTIFACT_ENTRY_META_KEY] as
          | Record<string, ArtifactEntryMeta>
          | undefined) ?? {}),
      };
      const prev = all[key] ?? { status: "idle" as const };
      const next: ArtifactEntryMeta = { status: patch.status };
      const lastRefreshedAt = patch.lastRefreshedAt ?? prev.lastRefreshedAt;
      if (typeof lastRefreshedAt === "number") next.lastRefreshedAt = lastRefreshedAt;
      const scheduleRunAt = patch.scheduleRunAt ?? prev.scheduleRunAt;
      if (typeof scheduleRunAt === "number") next.scheduleRunAt = scheduleRunAt;
      const attemptAt = patch.attemptAt ?? prev.attemptAt;
      if (typeof attemptAt === "number") next.attemptAt = attemptAt;
      if (typeof patch.error === "string") next.error = patch.error;
      else if (patch.error === undefined && typeof prev.error === "string") next.error = prev.error;
      all[key] = next;
      await hostWriteStateKey(ARTIFACT_ENTRY_META_KEY, all);
      return next;
    },
    [hostWriteStateKey]
  );

  // In-flight source runs, per entry key, so a double-tap or a Refresh that
  // races an entries.refresh() joins the same run instead of double-querying.
  const entryRunsRef = useRef(new Map<string, Promise<EntrySnapshot>>());
  // One-shot guard for the schedule-model fossil healer (see refetchAndPost).
  const healedScheduleModelRef = useRef(false);

  /** Fire-and-forget: record an in-app entry run into the schedule ledger so
   *  the Settings panel's "Last scan" and Recent runs reflect EVERY scan. The
   *  panel reading a ledger that in-app scans never touched is how "Last
   *  scan: never" coexisted with the app header saying "refreshed 14s ago". */
  const recordEntryRun = useCallback(
    (info: {
      status: "complete" | "error";
      runAt: number;
      durationMs: number;
      prompt?: string;
      webSearch?: boolean;
      result?: unknown;
      error?: string;
    }) => {
      void fetch(`/api/schedules/${encodeURIComponent(app.id)}/record-entry-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...info, model: effectiveDefaultModel }),
      }).catch(() => {});
    },
    [app.id, effectiveDefaultModel]
  );

  /** Land a source result in a declared entry: merge by identity into the
   *  current records, persist, stamp the entry meta and the app clock. Shared
   *  by live runs (runEntrySource) and the mount-time recovery sweep, so a
   *  refresh the user walked away from lands identically when they return. */
  const landEntryResult = useCallback(
    async (key: string, json: unknown, at: number): Promise<EntrySnapshot> => {
      const cfg = designer.manifest?.state?.[key];
      if (!cfg || cfg.kind !== "collection") {
        throw new Error(`Entry "${key}" is not a declared collection.`);
      }
      const incoming = Array.isArray(json) ? json : json != null ? [json] : [];
      const merged = mergeCollection(stateRef.current[key], incoming, cfg);
      // A scan that returns items but lands NONE of them is a failure, not an
      // empty success - it almost always means the data's field names don't
      // match the declared schema/identity, and reporting "refreshed" with
      // zero records sends users (and the edit model) chasing render bugs.
      if (incoming.length > 0 && merged.dropped === incoming.length) {
        const identity = cfg.identity?.join(", ") ?? "";
        const message =
          `The scan returned ${incoming.length} item(s), but none carried the declared identity fields` +
          (identity ? ` (${identity})` : "") +
          ` - nothing was saved. The data's field names don't match manifest.state.${key}.schema; update the app so they line up.`;
        await patchEntryMeta(key, { status: "error", error: message }).catch(() => {});
        throw new Error(message);
      }
      await hostWriteStateKey(key, merged.records);
      await patchEntryMeta(key, { status: "idle", lastRefreshedAt: at, error: null });
      void touchAppLastRun(app.id, at);
      onAppRefreshed?.(at);
      return { data: merged.records, status: "idle", lastRefreshedAt: at, error: null };
    },
    [app.id, designer.manifest, hostWriteStateKey, patchEntryMeta, onAppRefreshed]
  );

  /** Run one declared entry source now: interpolate the prompt, execute the
   *  query server-side (validated against the entry schema by the executor's
   *  repair loop), merge by identity, persist, stamp the clocks. */
  const runEntrySource = useCallback(
    async (key: string): Promise<EntrySnapshot> => {
      const cfg = designer.manifest?.state?.[key];
      if (!cfg) {
        throw new Error(`No entry "${key}" is declared in manifest.state.`);
      }
      if (cfg.kind !== "collection" || !cfg.source) {
        throw new Error(
          `Entry "${key}" has no declared source, so it cannot be refreshed. Add manifest.state.${key}.source or write it with artifact.entries.update().`
        );
      }
      const inflightRun = entryRunsRef.current.get(key);
      if (inflightRun) return inflightRun;
      const src = cfg.source;
      const run = (async (): Promise<EntrySnapshot> => {
        if (isRateLimited(app.id, "query", 5, 60_000)) {
          throw new Error("Too many refreshes. Wait a minute and try again.");
        }
        const startedAt = Date.now();
        await patchEntryMeta(key, { status: "refreshing", attemptAt: startedAt, error: null });
        let prompt: string | undefined;
        try {
          prompt = interpolateTemplate(src.prompt, { params: effectiveParams });
          // Identity fields are hardened to required, non-empty strings so the
          // executor's repair loop fixes mis-named/blank identity fields
          // server-side instead of the merge dropping every row client-side.
          const schema = cfg.schema
            ? { type: "array", items: hardenEntrySchema(cfg.schema, cfg.identity) }
            : undefined;
          const handshakeRes = await fetchWithTimeout(
            "/api/query",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                prompt,
                schema,
                model: effectiveDefaultModel,
                webSearch: src.webSearch === true,
                system: src.system,
                research: src.research,
                // mcp-flagged sources get the user's configured connectors so
                // the host-run query can call the connected server's tools.
                connectors: src.mcp ? mcpConnectorsRef.current : undefined,
                appId: app.id,
              }),
            },
            30_000
          );
          if (!handshakeRes.ok) {
            const errBody = (await handshakeRes.json().catch(() => ({}))) as { error?: string };
            throw new Error(errBody.error ?? `refresh failed (${handshakeRes.status})`);
          }
          const handshake = (await handshakeRes.json()) as { streamId?: string };
          if (!handshake.streamId) throw new Error("refresh did not return a streamId");
          // Breadcrumb BEFORE awaiting the result: the run continues server-side
          // if the user leaves (phone lock, navigation), and the next mount's
          // recovery sweep lands it in the entry — same durability the raw
          // query path has. Keyed per entry so a re-tap replaces, not stacks.
          const breadcrumbKey = `entry:${app.id}:${key}`;
          await putPendingQuery({
            key: breadcrumbKey,
            appId: app.id,
            streamId: handshake.streamId,
            startedAt,
            prompt,
            entryKey: key,
          }).catch(() => {});
          let result: { json?: unknown; text?: string };
          try {
            const r = await fetchWithTimeout(
              `/api/query/resume/${encodeURIComponent(handshake.streamId)}`,
              { method: "GET" },
              300_000
            );
            if (!r.ok) throw new Error(`refresh failed (${r.status})`);
            result = (await r.json()) as { json?: unknown; text?: string };
          } finally {
            await deletePendingQuery(breadcrumbKey).catch(() => {});
          }
          const finishedAt = Date.now();
          const landed = await landEntryResult(key, result?.json, finishedAt);
          recordEntryRun({
            status: "complete",
            runAt: finishedAt,
            durationMs: finishedAt - startedAt,
            prompt,
            webSearch: src.webSearch === true,
            result: result?.json,
          });
          return landed;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await patchEntryMeta(key, { status: "error", error: message }).catch(() => {});
          recordEntryRun({
            status: "error",
            runAt: Date.now(),
            durationMs: Date.now() - startedAt,
            prompt,
            webSearch: src.webSearch === true,
            error: message,
          });
          throw err;
        }
      })();
      entryRunsRef.current.set(key, run);
      try {
        return await run;
      } finally {
        entryRunsRef.current.delete(key);
      }
    },
    [app.id, effectiveParams, designer.manifest, effectiveDefaultModel, landEntryResult, patchEntryMeta, recordEntryRun]
  );

  // The one declared entry (if any) fed by the background schedule.
  const scheduledEntry = useMemo(() => {
    const st = designer.manifest?.state;
    if (!st) return null;
    for (const [key, cfg] of Object.entries(st)) {
      if (cfg.kind === "collection" && cfg.source?.refresh?.schedule) return { key, cfg };
    }
    return null;
  }, [designer.manifest]);

  /**
   * Land a settled schedule snapshot in app.state - the HOST-owned bridge that
   * replaces "the prompt tells generated code to copy snapshots into state".
   * Also stamps app.lastRunAt for EVERY app (v1 included), so "Last refreshed
   * never" can no longer coexist with a widget full of data. Idempotent: the
   * per-entry scheduleRunAt guard skips snapshots already merged, and the
   * merge itself is an identity upsert, so concurrent frames are harmless.
   */
  const bridgeScheduleSnapshot = useCallback(
    (snap: ScheduleSnapshot) => {
      if (!snap || typeof snap.runAt !== "number") return;
      if (snap.status === "complete") {
        void touchAppLastRun(app.id, snap.runAt);
        onAppRefreshed?.(snap.runAt);
      }
      if (!scheduledEntry) return;
      if (snap.status !== "complete" || snap.result == null) return;
      const metaAll = (stateRef.current[ARTIFACT_ENTRY_META_KEY] ?? {}) as Record<
        string,
        ArtifactEntryMeta
      >;
      if (metaAll[scheduledEntry.key]?.scheduleRunAt === snap.runAt) return;
      const cfg = scheduledEntry.cfg;
      if (cfg.kind !== "collection") return;
      // Plain query+schema results are the array itself; the research engine
      // wraps rows as { records: [...] }. Tolerate both.
      const rawResult = snap.result as { records?: unknown } | unknown[];
      const incoming = Array.isArray(rawResult)
        ? rawResult
        : Array.isArray((rawResult as { records?: unknown })?.records)
          ? ((rawResult as { records: unknown[] }).records)
          : [snap.result];
      const merged = mergeCollection(stateRef.current[scheduledEntry.key], incoming, cfg);
      const runAt = snap.runAt;
      void (async () => {
        await hostWriteStateKey(scheduledEntry.key, merged.records);
        await patchEntryMeta(scheduledEntry.key, {
          status: "idle",
          lastRefreshedAt: runAt,
          scheduleRunAt: runAt,
          error: null,
        });
      })();
    },
    [app.id, scheduledEntry, hostWriteStateKey, patchEntryMeta, onAppRefreshed]
  );

  // A frame that unloads mid-refresh strands its entry in "refreshing". On
  // mount, reset stale flags (no run in this frame is older than the mount).
  useEffect(() => {
    const st = designer.manifest?.state;
    if (!st) return;
    const metaAll = stateRef.current[ARTIFACT_ENTRY_META_KEY] as
      | Record<string, ArtifactEntryMeta>
      | undefined;
    if (!metaAll) return;
    const STALE_MS = 10 * 60 * 1000;
    for (const [key, meta] of Object.entries(metaAll)) {
      if (meta?.status !== "refreshing") continue;
      if (entryRunsRef.current.has(key)) continue;
      if (typeof meta.attemptAt === "number" && Date.now() - meta.attemptAt < STALE_MS) continue;
      void patchEntryMeta(key, { status: "idle" });
    }
  }, [app.id, designer.manifest, patchEntryMeta]);

  // Listen for SDK requests from the iframe.
  useEffect(() => {
    const ttlMs =
      (designer.manifest?.refresh?.minIntervalSeconds ?? DEFAULT_CACHE_TTL_SECONDS) * 1000;

    // Cache + dedupe wrapper. Returns cached value if fresh; otherwise either
    // joins an in-flight request with the same key or fires a new one. The
    // result is persisted to IndexedDB on success. `run` receives the cache
    // key so the query path can persist a pendingQuery breadcrumb under it.
    async function cachedRun(
      kind: "query" | "fetch" | "image-search",
      payload: unknown,
      run: (key: string) => Promise<unknown>
    ): Promise<unknown> {
      const key = cacheKey(kind, app.id, payload);
      const cached = await getCachedQuery(key);
      if (cached && Date.now() - cached.storedAt < ttlMs) {
        return cached.result;
      }
      const existing = inflight.get(key);
      if (existing) return existing;
      // For query rows, stash the originating prompt/opts alongside the result
      // so a later mount can replay it to onQueryResult (which is keyed by
      // prompt+opts) without re-running the query.
      const queryMeta =
        kind === "query" && payload && typeof payload === "object"
          ? {
              prompt: (payload as { prompt?: string }).prompt,
              opts: (payload as { opts?: unknown }).opts,
            }
          : {};
      const p = (async () => {
        try {
          const result = await run(key);
          await putCachedQuery({
            key,
            appId: app.id,
            kind,
            result,
            storedAt: Date.now(),
            ...queryMeta,
          });
          return result;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
      return p;
    }

    async function handleRpc(req: FrameRequest): Promise<unknown> {
      switch (req.type) {
        case "query": {
          if (isRateLimited(app.id, "query", 5, 60_000)) {
            throw new Error(
              "Too many artifact.query() calls. Wait a minute or click the Refresh button."
            );
          }
          const queryResult = await cachedRun(
            "query",
            { prompt: req.prompt, opts: req.opts },
            async (key) => {
              // POST is now a quick handshake that returns {streamId} only —
              // the actual generation runs server-side into Redis. We persist
              // the streamId (plus the original prompt/opts) so a tab close
              // mid-fetch can be recovered on next mount via the pendingQueries
              // sweep below — which re-delivers the result to onQueryResult.
              const handshakeRes = await fetchWithTimeout(
                "/api/query",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    prompt: req.prompt,
                    schema: req.opts?.schema,
                    // Always the user's configured model — a model passed in
                    // artifact code is intentionally ignored.
                    model: effectiveDefaultModel,
                    webSearch: req.opts?.webSearch,
                    system: req.opts?.system,
                    research: req.opts?.research,
                    // Opt-in per call: artifact.query(prompt, { mcp: true }).
                    connectors: req.opts?.mcp ? mcpConnectorsRef.current : undefined,
                    appId: app.id,
                  }),
                },
                30_000
              );
              if (!handshakeRes.ok) {
                const errBody = await handshakeRes.json().catch(() => ({}));
                throw new Error(
                  `query failed (${handshakeRes.status}${(errBody as { error?: string }).error ? `: ${(errBody as { error: string }).error}` : ""})`
                );
              }
              const handshake = (await handshakeRes.json()) as { streamId?: string };
              if (!handshake.streamId) throw new Error("query did not return streamId");
              const streamId = handshake.streamId;

              await putPendingQuery({
                key,
                appId: app.id,
                streamId,
                startedAt: Date.now(),
                prompt: req.prompt,
                opts: req.opts,
              }).catch(() => {});

              try {
                const r = await fetchWithTimeout(
                  `/api/query/resume/${encodeURIComponent(streamId)}`,
                  { method: "GET" },
                  300_000
                );
                if (!r.ok) throw new Error(`query failed (${r.status})`);
                return await r.json();
              } finally {
                await deletePendingQuery(key).catch(() => {});
              }
            }
          );
          // Mirror the resolved result onto the onQueryResult channel so an
          // artifact that renders from that handler (rather than the awaited
          // return) shows the result — same path a recovered query takes.
          post({ type: "query-result", prompt: req.prompt, opts: req.opts, result: queryResult });
          return queryResult;
        }
        case "entry-refresh": {
          // Declared data: the host runs the entry's source, merges, persists,
          // and stamps the clocks - see runEntrySource above. EVERY failure -
          // including "no such entry declared" (a key mismatch between the
          // app's code and manifest.state) and rate limiting - is written to
          // the entry meta so useArtifact/watch renders it. A refresh that
          // fails invisibly reads as "the button does nothing" and sends the
          // edit model chasing phantom render bugs.
          try {
            return await runEntrySource(req.key);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await patchEntryMeta(req.key, { status: "error", error: message }).catch(() => {});
            throw err;
          }
        }
        case "exec": {
          if (isRateLimited(app.id, "exec", 4, 60_000)) {
            throw new Error(
              "Too many artifact.exec() calls. Wait a minute or click Refresh."
            );
          }
          // Same handshake shape as query: POST returns {streamId}, then we
          // poll /api/exec/resume/{streamId} for the result. Not cached — a
          // code run has side effects (produces files) and shouldn't be
          // deduped the way a pure query read is.
          const handshakeRes = await fetchWithTimeout(
            "/api/exec",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                language: req.opts?.language ?? "python",
                code: req.code,
                stdin: req.opts?.stdin,
                files: req.opts?.files,
                timeoutMs: req.opts?.timeoutMs,
                appId: app.id,
              }),
            },
            30_000
          );
          if (!handshakeRes.ok) {
            const errBody = await handshakeRes.json().catch(() => ({}));
            throw new Error(
              `exec failed (${handshakeRes.status}${(errBody as { error?: string }).error ? `: ${(errBody as { error: string }).error}` : ""})`
            );
          }
          const handshake = (await handshakeRes.json()) as { streamId?: string };
          if (!handshake.streamId) throw new Error("exec did not return streamId");
          const r = await fetchWithTimeout(
            `/api/exec/resume/${encodeURIComponent(handshake.streamId)}`,
            { method: "GET" },
            300_000
          );
          if (!r.ok) throw new Error(`exec failed (${r.status})`);
          return await r.json();
        }
        case "fetch": {
          if (isRateLimited(app.id, "fetch", 20, 60_000)) {
            throw new Error("Too many artifact.fetch() calls. Wait a minute.");
          }
          return cachedRun(
            "fetch",
            { url: req.url, init: req.init },
            async () => {
              const r = await fetchWithTimeout(
                "/api/proxy",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    url: req.url,
                    method: req.init?.method,
                    headers: req.init?.headers,
                    body: req.init?.body,
                  }),
                },
                20_000
              );
              if (!r.ok) throw new Error(`fetch failed (${r.status})`);
              return r.json();
            }
          );
        }
        case "schedule.define": {
          // The scheduled run always uses the user's configured model
          // (scheduledModelFor — the app's model, else the global
          // Scheduled tasks default). Any model the artifact passed to
          // defineSchedule({ model }) is stripped — code cannot override the
          // user's choice.
          // {params.key} placeholders are interpolated NOW: the server runs
          // the stored prompt verbatim and has no params, so a raw template
          // would make the model search for the literal "{params.city}".
          //
          // Wait for Preferences first: this register is attested
          // (modelResolved: true) and so overwrites the stored model, and an
          // artifact can call defineSchedule() before settings have loaded.
          await schedulePrefsRef.current?.promise;
          const taskToRegister =
            req.task.type === "query"
              ? {
                  ...req.task,
                  prompt: interpolateTemplate(req.task.prompt, { params: effectiveParams }),
                  model: scheduledModelFor(req.task.research),
                }
              : req.task;
          const r = await fetchWithTimeout(
            "/api/schedules/register",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                appId: app.id,
                schedule: taskToRegister,
                origin: "sdk",
                // This frame resolved the model app-first (param -> app.model
                // -> user default), so it may update the stored model.
                modelResolved: true,
              }),
            },
            10_000
          );
          if (!r.ok) {
            const errBody = (await r.json().catch(() => ({}))) as { error?: string };
            throw new Error(errBody.error ?? `defineSchedule failed (${r.status})`);
          }
          // After defining, fetch and return the current snapshot so the
          // artifact can render whatever is cached without a second call.
          return fetchScheduleSnapshot(app.id, post, frameInstanceIdRef.current, bridgeScheduleSnapshot);
        }
        case "schedule.get": {
          return fetchScheduleSnapshot(app.id, post, frameInstanceIdRef.current, bridgeScheduleSnapshot);
        }
        case "schedule.run": {
          const r = await fetchWithTimeout(
            `/api/schedules/${encodeURIComponent(app.id)}/run`,
            { method: "POST" },
            10_000
          );
          if (r.status === 429) {
            const body = (await r.json().catch(() => ({}))) as {
              error?: string;
              retryAfterMs?: number;
            };
            throw new Error(nextAvailableMessage(body.retryAfterMs));
          }
          if (!r.ok) {
            const body = (await r.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error ?? `runSchedule failed (${r.status})`);
          }
          // Kicked off in the background. Poll until status flips.
          return pollScheduleUntilSettled(app.id, post, frameInstanceIdRef.current, bridgeScheduleSnapshot);
        }
        case "state.get": {
          return stateRef.current[req.key] ?? null;
        }
        case "state.set": {
          // Update the in-memory snapshot immediately so subsequent state.get
          // calls see the new value without waiting for the debounced flush.
          stateRef.current = { ...stateRef.current, [req.key]: req.value };
          // Debounce IndexedDB write so rapid state.set loops don't spam disk.
          // mergeAppStateKey is the single durability gate: it reads-fresh
          // from IDB, sets the one key, and writes back — never strips other
          // keys, even if we somehow raced a concurrent writer.
          const debounceKey = `${app.id}:${req.key}`;
          const existing = stateDebounce.get(debounceKey);
          if (existing) clearTimeout(existing);
          const valueAtScheduleTime = req.value;
          const timer = setTimeout(async () => {
            await mergeAppStateKey(app.id, req.key, valueAtScheduleTime).catch(() => {});
            stateDebounce.delete(debounceKey);
          }, 300);
          stateDebounce.set(debounceKey, timer);
          // Fan out to sibling frames for the same appId. Self-echoes are
          // filtered by `origin` in the receiver below. Broadcast happens
          // synchronously so widgets reflect changes within a render tick.
          channelRef.current?.postMessage({
            type: "state-merged",
            key: req.key,
            value: req.value,
            origin: frameInstanceIdRef.current,
          });
          onStateChange?.(stateRef.current);
          return true;
        }
        case "image-search": {
          if (isRateLimited(app.id, "image-search", 10, 60_000)) {
            throw new Error("Too many artifact.imageSearch() calls. Wait a minute.");
          }
          return cachedRun(
            "image-search",
            { query: req.query, maxResults: req.maxResults, safesearch: req.safesearch },
            async () => {
              const r = await fetchWithTimeout(
                "/api/image-search",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    query: req.query,
                    maxResults: req.maxResults,
                    safesearch: req.safesearch,
                    appId: app.id,
                  }),
                },
                20_000
              );
              if (!r.ok) {
                const errBody = (await r.json().catch(() => ({}))) as { error?: string };
                throw new Error(errBody.error ?? `imageSearch failed (${r.status})`);
              }
              const data = (await r.json()) as { results?: unknown };
              return data.results ?? [];
            }
          );
        }
        case "download": {
          if (isRateLimited(app.id, "download", 30, 60_000)) {
            throw new Error("Too many artifact.download() calls. Wait a minute.");
          }
          const filename = sanitizeFilename(req.filename);
          const mime = safeMime(req.mime);
          let payload: BlobPart;
          let size: number;
          if (req.bytes instanceof Uint8Array) {
            size = req.bytes.byteLength;
            // Copy into a fresh ArrayBuffer — postMessage may have given us a
            // SharedArrayBuffer-backed view, which doesn't satisfy BlobPart.
            const buf = new ArrayBuffer(size);
            new Uint8Array(buf).set(req.bytes);
            payload = buf;
          } else if (typeof req.text === "string") {
            size = req.text.length;
            payload = req.text;
          } else {
            throw new Error("artifact.download: missing content");
          }
          if (size > DOWNLOAD_MAX_BYTES) {
            throw new Error(
              `artifact.download: payload too large (${size} bytes, max ${DOWNLOAD_MAX_BYTES})`
            );
          }
          triggerHostDownload(filename, mime, payload);
          return true;
        }
        case "open-url": {
          if (isRateLimited(app.id, "open-url", 30, 60_000)) {
            throw new Error("Too many artifact.openUrl() calls. Wait a minute.");
          }
          const u = isAllowedUrl(req.url);
          if (!u) throw new Error("artifact.openUrl: blocked URL protocol");
          const target = req.target === "_top" ? "_top" : "_blank";
          window.open(u.toString(), target, "noopener,noreferrer");
          return true;
        }
        case "clipboard-write": {
          if (isRateLimited(app.id, "clipboard-write", 30, 60_000)) {
            throw new Error("Too many artifact.copyToClipboard() calls. Wait a minute.");
          }
          const text = String(req.text ?? "");
          if (text.length > CLIPBOARD_MAX_CHARS) {
            throw new Error("artifact.copyToClipboard: text too large");
          }
          await copyTextToClipboard(text);
          return true;
        }
        // artifact.shared.* — public-share input collections. The host
        // proxies to the public /api/share/html/[token]/inputs endpoints
        // so the owner reads/writes the exact same Redis pool that
        // anonymous viewers do. shareTokenRef is set by the by-app lookup
        // effect (see useEffect below); if it's null the owner just
        // hasn't shared yet and we reject with a clear message.
        case "shared.append":
        case "shared.list":
        case "shared.delete": {
          const token = shareTokenRef.current;
          if (!token) {
            throw new Error(
              "Sharing not enabled. Click Share to create a public link, then artifact.shared.* will work."
            );
          }
          return forwardSharedRpc(token, req);
        }
      }
    }

    function handle(event: MessageEvent) {
      if (!iframeRef.current) return;
      if (event.source !== iframeRef.current.contentWindow) return;
      const data = event.data as { ns?: string; payload?: FrameRequest } | null;
      if (!data || data.ns !== FRAME_NAMESPACE || !data.payload) return;
      const req = data.payload;

      const { type: _t, id: _i, ...reqPayload } = req as Record<string, unknown>;

      if (req.type === "ready") {
        pushSdkEvent(app.id, {
          id: `ready-${Date.now()}`,
          at: Date.now(),
          direction: "iframe-to-host",
          type: "ready",
          payload: null,
        });
        setReady(true);
        readyRef.current = true;
        const initMsg: HostMessage = {
          type: "init",
          params: effectiveParams,
          appId: app.id,
          state: stateRef.current,
          defaultModel: effectiveDefaultModel,
          defaultWebSearch: userPrefs.defaultWebSearch,
          widgetSize: widgetSizeRef.current ?? undefined,
          shareToken: shareTokenRef.current ?? undefined,
          shareMode: "owner",
          theme: hostThemeRef.current,
        };
        post(initMsg);
        pushSdkEvent(app.id, {
          id: `init-${Date.now()}`,
          at: Date.now(),
          direction: "host-to-iframe",
          type: "init",
          payload: { params: initMsg.params, defaultModel: initMsg.defaultModel, defaultWebSearch: initMsg.defaultWebSearch },
        });
        // Re-deliver any query results recovered while the frame was being
        // (re)built — the iframe wasn't listening when the sweep posted them.
        // onQueryResult's buffer + idempotency make a duplicate deliver safe.
        for (const qr of recoveredQueriesRef.current) {
          post({ type: "query-result", prompt: qr.prompt, opts: qr.opts, result: qr.result });
        }
        return;
      }

      if (req.type === "log") {
        pushSdkEvent(app.id, {
          id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          at: Date.now(),
          direction: "iframe-to-host",
          type: "log",
          payload: { level: req.level, args: req.args },
        });
        onLog?.(req.level, req.args);
        return;
      }

      if (req.type === "widget-content-height") {
        if (typeof req.height === "number" && req.height >= 0) {
          onWidgetContentHeight?.(req.height);
        }
        return;
      }

      const debugEventId = req.id;
      const rpcStart = Date.now();
      pushSdkEvent(app.id, {
        id: debugEventId,
        at: rpcStart,
        direction: "iframe-to-host",
        type: req.type,
        payload: reqPayload,
      });

      void handleRpc(req).then(
        (result) => {
          reply({ id: req.id, ok: true, result });
          updateSdkEventResponse(app.id, debugEventId, { ok: true, result }, Date.now() - rpcStart);
        },
        (err: unknown) => {
          const errorMsg = err instanceof Error ? err.message : String(err);
          reply({ id: req.id, ok: false, error: errorMsg });
          updateSdkEventResponse(app.id, debugEventId, { ok: false, error: errorMsg }, Date.now() - rpcStart);
        }
      );
    }

    window.addEventListener("message", handle);
    return () => window.removeEventListener("message", handle);
  }, [
    app.id,
    effectiveParams,
    designer.manifest,
    defaultModelProp,
    userPrefs.defaultModel,
    userPrefs.defaultWebSearch,
    post,
    reply,
    onLog,
    onStateChange,
    onWidgetContentHeight,
    effectiveDefaultModel,
    scheduledModelFor,
    runEntrySource,
    bridgeScheduleSnapshot,
  ]);

  // Recover pending artifact.query() calls that were in-flight when a previous
  // mount unloaded (tab close, iframe rebuild, navigation away). For each
  // breadcrumb under this app: poll /api/query/resume/{streamId}, drop the
  // result into the persistent query cache so the next call is a hit, AND
  // re-deliver it to the iframe's onQueryResult handler so an artifact that
  // kicked off a query before the user left re-renders the result on return —
  // without the user having to tap the button again.
  useEffect(() => {
    let cancelled = false;
    // The server-side stream (and its result) lives in Redis for 3 days
    // (stream-store RUNNING_TTL_SECONDS). Keep the breadcrumb alive for that
    // whole window — plus an hour of slack — so a query interrupted mid-flight
    // is still recoverable hours or days later, not just for 7h. Beyond the
    // Redis TTL the streamId resolves to a 404 and we drop the breadcrumb then.
    const PENDING_MAX_AGE_MS = (3 * 24 + 1) * 60 * 60 * 1000;
    (async () => {
      const pending = await getPendingQueriesByApp(app.id).catch(() => []);
      for (const row of pending) {
        if (cancelled) return;
        if (Date.now() - row.startedAt > PENDING_MAX_AGE_MS) {
          await deletePendingQuery(row.key).catch(() => {});
          continue;
        }
        try {
          const r = await fetch(
            `/api/query/resume/${encodeURIComponent(row.streamId)}`,
            { method: "GET" }
          );
          if (cancelled) return;
          if (r.ok) {
            const result = await r.json();
            if (typeof row.entryKey === "string" && row.entryKey) {
              // Declared-data refresh the user walked away from: land it in
              // the entry (merge + meta + clocks) — every surface then reads
              // it from state. No query-result event; entries have no event
              // channel to miss. Recovered runs go into the schedule ledger
              // too, so the Settings panel's run history stays complete.
              const recoveredAt = Date.now();
              const recoveredJson = (result as { json?: unknown })?.json;
              try {
                await landEntryResult(row.entryKey, recoveredJson, recoveredAt);
                recordEntryRun({
                  status: "complete",
                  runAt: recoveredAt,
                  durationMs: Math.max(0, recoveredAt - row.startedAt),
                  prompt: row.prompt,
                  result: recoveredJson,
                });
              } catch (err) {
                recordEntryRun({
                  status: "error",
                  runAt: recoveredAt,
                  durationMs: Math.max(0, recoveredAt - row.startedAt),
                  prompt: row.prompt,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
              await deletePendingQuery(row.key).catch(() => {});
              continue;
            }
            await putCachedQuery({
              key: row.key,
              appId: row.appId,
              kind: "query",
              result,
              storedAt: Date.now(),
              prompt: row.prompt,
              opts: row.opts,
            }).catch(() => {});
            // Buffer for the `ready` flush (the frame may still be building),
            // and deliver immediately if it's already listening.
            const recovered: RecoveredQuery = {
              prompt: row.prompt ?? "",
              opts: row.opts as QueryRequestOpts | undefined,
              result,
            };
            bufferRecovered(recoveredQueriesRef.current, recovered);
            if (readyRef.current) {
              post({
                type: "query-result",
                prompt: recovered.prompt,
                opts: recovered.opts,
                result: recovered.result,
              });
            }
            // Resolved — the result is now durably in the query cache and will
            // be replayed on future mounts. Drop the breadcrumb.
            await deletePendingQuery(row.key).catch(() => {});
          } else if (r.status === 504) {
            // Resume long-poll timed out: the upstream query is still running.
            // Keep the breadcrumb so a later mount picks up the result once it
            // lands, instead of stranding an in-flight query forever.
            continue;
          } else {
            // Terminal: 404 (stream expired) or a query error. Retrying won't
            // help — drop the breadcrumb so the sweep doesn't spin on it.
            await deletePendingQuery(row.key).catch(() => {});
          }
        } catch {
          // Network error during sweep — leave the breadcrumb so the next
          // mount can try again. Don't surface to the user.
          continue;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [app.id, post, landEntryResult, recordEntryRun]);

  // Replay the durable query cache on mount. Every artifact.query() result is
  // persisted to IndexedDB (keyed by app + prompt/opts) and never expires until
  // a manual refresh clears it. Re-delivering the latest result of each query
  // to onQueryResult here is what makes a button-driven query still show its
  // data when the user returns much later — long after the server-side stream
  // and any pending-query breadcrumb have aged out. The SDK's onQueryResult
  // buffer is keyed by prompt+opts and idempotent, so a fresh completion or a
  // recovery-sweep delivery for the same query cleanly supersedes this replay.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await getCachedQueriesByApp(app.id).catch(() => []);
      if (cancelled) return;
      // Deliver oldest → newest so a handler that does setData(result) without
      // keying on the prompt (the common case) ends on the most recent query's
      // result. getCachedQueriesByApp returns newest-first, so reverse it.
      for (const row of [...rows].reverse()) {
        // Only rows written under the self-describing format carry the prompt.
        // Older rows (pre-upgrade) lack it; skip them rather than deliver an
        // empty-signature event that can't match the live query's signature.
        if (typeof row.prompt !== "string") continue;
        const replay: RecoveredQuery = {
          prompt: row.prompt,
          opts: row.opts as QueryRequestOpts | undefined,
          result: row.result,
        };
        bufferRecovered(recoveredQueriesRef.current, replay);
        if (readyRef.current) {
          post({
            type: "query-result",
            prompt: replay.prompt,
            opts: replay.opts,
            result: replay.result,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [app.id, post]);

  // Push param updates after init.
  useEffect(() => {
    if (!ready) return;
    post({ type: "params-changed", params: effectiveParams });
    pushSdkEvent(app.id, {
      id: `params-changed-${Date.now()}`,
      at: Date.now(),
      direction: "host-to-iframe",
      type: "params-changed",
      payload: effectiveParams,
    });
  }, [ready, effectiveParams, post]);

  // Cross-iframe state sync: subscribe to the BroadcastChannel for this
  // app, ignore self-echoes (matched by frameInstanceIdRef), and forward
  // foreign writes into the iframe so artifact.onStateMerged fires.
  useEffect(() => {
    const channel = acquireStateChannel(app.id);
    channelRef.current = channel;
    if (!channel) return () => releaseStateChannel(app.id);
    function onMessage(ev: MessageEvent) {
      const data = ev.data as
        | { type?: string; key?: string; value?: unknown; origin?: string }
        | null;
      if (!data || data.type !== "state-merged") return;
      if (data.origin === frameInstanceIdRef.current) return;
      if (typeof data.key !== "string") return;
      // Update local mirror so a state.get from this frame returns the
      // freshest value without an IDB round-trip.
      stateRef.current = { ...stateRef.current, [data.key]: data.value };
      onStateChange?.(stateRef.current);
      // Forward into the iframe; the SDK fires onStateMerged handlers.
      post({ type: "state-merged", key: data.key, value: data.value });
    }
    channel.addEventListener("message", onMessage);
    return () => {
      channel.removeEventListener("message", onMessage);
      channelRef.current = null;
      releaseStateChannel(app.id);
    };
  }, [app.id, post, onStateChange]);

  // Cross-frame schedule sync + visibility-driven refetch.
  //
  // Cron-triggered runs settle server-side with no client signal. Without
  // this, a widget on the home dashboard sits on the snapshot it pulled at
  // iframe init forever — the user has to navigate away and back to remount
  // the iframe and see fresh data. We close that gap two ways:
  //
  //   1. Listen on the schedule BroadcastChannel for snapshots fanned out
  //      by sibling frames (the params dialog's useSchedule, another
  //      iframe's pollAndPost). Forward into the iframe so onScheduleUpdate
  //      fires without a remount.
  //   2. Refetch when the document becomes visible (tab focus, returning
  //      from another route). Cheap GET; if the cron landed while we were
  //      gone, the artifact picks it up right away.
  useEffect(() => {
    if (!ready) return;
    const channel = acquireScheduleChannel(app.id);

    function onMessage(ev: MessageEvent) {
      const data = ev.data as
        | { type?: string; payload?: ScheduleSnapshot; origin?: string }
        | null;
      if (!data || data.type !== "schedule-updated") return;
      if (data.origin === frameInstanceIdRef.current) return;
      // Bridge before forwarding so declared-data entries are merged into
      // app.state by the time the iframe re-renders from the snapshot.
      bridgeScheduleSnapshot(data.payload ?? null);
      post({ type: "schedule-updated", payload: data.payload ?? null });
    }
    channel?.addEventListener("message", onMessage);

    let cancelled = false;
    async function refetchAndPost() {
      try {
        const snap = await fetchScheduleSnapshot(
          app.id,
          post,
          frameInstanceIdRef.current,
          bridgeScheduleSnapshot
        );
        if (cancelled) return;
        // No registered schedule yet (404 / null) — don't fire an event for
        // it. onScheduleUpdate is meant for "a run landed", not lifecycle.
        if (!snap) return;
        healScheduleModel(snap);
        bridgeScheduleSnapshot(snap);
        post({ type: "schedule-updated", payload: snap });
        broadcastScheduleSnapshot(app.id, snap, frameInstanceIdRef.current);
      } catch {
        // Network blip — next visibility flip retries.
      }
    }

    // Fossil healer. Registrations written before model attestation and
    // prompt interpolation existed (or by stale clients) can carry a wrong
    // model or a literal "{params.city}" prompt forever: attested writers fix
    // them, but unattested re-registers PRESERVE the model - by design. So
    // any frame that sees a snapshot whose stored model differs from this
    // app's resolved model, or whose prompt still holds placeholders,
    // re-registers it corrected and attested. One shot per mount; the fixed
    // snapshot ends the mismatch, so this converges instead of looping.
    function healScheduleModel(snap: NonNullable<ScheduleSnapshot>) {
      if (healedScheduleModelRef.current) return;
      // Same gate as the register effect — healing pre-load would "correct"
      // the schedule onto the built-in default. Not arming the one-shot ref
      // here, so the heal still runs once prefs land and this effect re-runs.
      if (!schedulePrefsRef.current?.loaded) return;
      if (snap.task.type !== "query") return;
      const healedPrompt = interpolateTemplate(snap.task.prompt, { params: effectiveParams });
      // Normally a concrete id, so this also heals a schedule back ONTO the
      // built-in default after the user clears the pref — the register-time
      // preservation rule would otherwise pin the old model forever. undefined
      // means settings failed to load: never "stale" against a model we don't
      // know, or a failed read would overwrite the user's choice.
      const healedModel = scheduledModelFor(snap.task.research);
      const modelStale = healedModel !== undefined && snap.task.model !== healedModel;
      const promptStale = healedPrompt !== snap.task.prompt;
      if (!modelStale && !promptStale) return;
      healedScheduleModelRef.current = true;
      void fetch("/api/schedules/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: app.id,
          schedule: {
            ...snap.task,
            prompt: healedPrompt,
            // Falls back to the stored model when we don't know the pref, so a
            // prompt-only heal can't quietly change which model runs.
            model: healedModel ?? snap.task.model,
          },
          origin: snap.origin,
          modelResolved: true,
        }),
      }).catch(() => {
        // Best-effort; the next mount retries.
      });
    }

    // Pull once on ready so the artifact's onScheduleUpdate handler gets a
    // snapshot at startup even if it never called artifact.scheduled().
    void refetchAndPost();

    function onVisibilityChange() {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      void refetchAndPost();
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      cancelled = true;
      channel?.removeEventListener("message", onMessage);
      releaseScheduleChannel(app.id);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
    // scheduledModelFor is read by healScheduleModel but deliberately not a
    // dep: the heal is one-shot-per-mount (healedScheduleModelRef) and a
    // transient value change must not re-arm it. It IS read through
    // a ref-backed, identity-stable resolver so the closure can't go stale — a heal that fired
    // with a pre-load closure would "correct" the schedule onto the built-in
    // default and clobber the user's configured model.
    //
    // prefsLoaded IS a dep: it flips false→true exactly once per mount, and
    // re-running here is what re-invokes the heal after settings land. Without
    // it, a snapshot that arrived pre-load is simply dropped and SDK-defined
    // schedules keep a stale model for the rest of the mount (manifest/entry
    // ones are covered by the register effect below). The one-shot ref keeps
    // this from healing twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id, ready, post, bridgeScheduleSnapshot, prefsLoaded]);

  // Manifest-declared schedules auto-register server-side. Idempotent — fine
  // to fire on every mount. SDK-defined schedules register lazily via the
  // schedule.define RPC. A declared-data entry with source.refresh.schedule
  // (SDK v2) derives the task instead - same registration path, but the
  // prompt/schema come from the entry config with params interpolated, so the
  // scheduled server run executes the identical query an interactive refresh
  // does.
  const manifestSchedule = designer.manifest?.schedule;
  useEffect(() => {
    // Wait for Preferences: registering now would attest the built-in
    // scheduled model over whatever the user actually configured.
    if (!prefsLoaded) return;
    let scheduleToRegister: ScheduledTask | null = null;
    // Set when the schedule comes from a declared entry whose source opted into
    // MCP - the register call then persists the user's connectors server-side
    // so the unattended cron run can call the same connected tools an
    // interactive refresh would.
    let scheduleWantsMcp = false;
    if (manifestSchedule) {
      // The scheduled run always uses the user's configured model
      // (scheduledModelFor) — the manifest's hardcoded schedule.model is
      // stripped, matching interactive artifact.query() calls.
      scheduleToRegister =
        manifestSchedule.type === "query"
          ? {
              ...manifestSchedule,
              // Interpolate here too: the server runs the stored prompt
              // verbatim and has no params, so a top-level schedule prompt
              // with {params.city} would otherwise be stored and searched
              // for literally (the empty-results bug). This path was the hole
              // - only the declared-entry path below interpolated - and it
              // fought the fossil healer by re-storing the raw prompt on
              // every mount.
              prompt: interpolateTemplate(manifestSchedule.prompt, { params: effectiveParams }),
              model: scheduledModelFor(manifestSchedule.research),
            }
          : manifestSchedule;
    } else if (scheduledEntry && scheduledEntry.cfg.kind === "collection") {
      const src = scheduledEntry.cfg.source;
      const cron = src?.refresh?.schedule;
      if (src && cron) {
        scheduleToRegister = {
          cron,
          type: "query",
          prompt: interpolateTemplate(src.prompt, { params: effectiveParams }),
          schema: scheduledEntry.cfg.schema
            ? {
                type: "array",
                items: hardenEntrySchema(scheduledEntry.cfg.schema, scheduledEntry.cfg.identity),
              }
            : undefined,
          tools: src.webSearch === true ? ["web_search", "web_fetch"] : undefined,
          research: src.research,
          model: scheduledModelFor(src.research),
        };
        scheduleWantsMcp = src.mcp === true;
      }
    }
    if (!scheduleToRegister) return;
    void fetch("/api/schedules/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: app.id,
        schedule: scheduleToRegister,
        origin: "manifest",
        // This frame resolved the model app-first (param -> app.model -> user
        // default; every ArtifactFrame mount passes app.model), so it may
        // update the stored model. Unattested writers can't.
        modelResolved: true,
        // Persist the user's connectors for the unattended run (server-side
        // only, never in the manifest). Send [] to CLEAR when the source is not
        // mcp-flagged, so toggling mcp off doesn't leave stale keys stored.
        connectors: scheduleWantsMcp ? mcpConnectorsRef.current : [],
      }),
    }).catch(() => {
      // Best-effort. The Schedules panel will surface registration failures.
    });
    // scheduledModelFor is identity-stable (it reads refs), so it can't drive
    // re-runs — its INPUTS are the deps instead, so a changed app model or
    // model param re-registers the schedule. userPrefs.scheduledModel is
    // listed for correctness but only ever transitions once per mount: the
    // Preferences dialog writes to IndexedDB without notifying live frames, so
    // a pref change reaches existing schedules on their next mount (via the
    // healer), not immediately.
  }, [
    app.id,
    effectiveParams,
    manifestSchedule,
    scheduledEntry,
    scheduledModelFor,
    prefsLoaded,
    paramModel,
    defaultModelProp,
    userPrefs.scheduledModel,
  ]);

  // Push model / web-search config updates after init so the runtime SDK stays
  // in sync without requiring a full iframe remount.
  useEffect(() => {
    if (!ready) return;
    post({
      type: "config-changed",
      defaultModel: effectiveDefaultModel,
      defaultWebSearch: userPrefs.defaultWebSearch,
    });
    pushSdkEvent(app.id, {
      id: `config-changed-${Date.now()}`,
      at: Date.now(),
      direction: "host-to-iframe",
      type: "config-changed",
      payload: { defaultModel: effectiveDefaultModel, defaultWebSearch: userPrefs.defaultWebSearch },
    });
  }, [ready, effectiveDefaultModel, userPrefs.defaultWebSearch, post]);

  // Push theme flips into the running iframe so its token CSS restyles without
  // a remount. Init already carries the initial theme; this handles a later
  // toggle. No pushSdkEvent — theme is cosmetic and would just be log noise.
  useEffect(() => {
    if (!ready) return;
    post({ type: "theme-changed", theme: hostTheme });
  }, [ready, hostTheme, post]);

  // Send refresh signal when the parent bumps it. Declared-data entries with a
  // user-refreshable source are run HOST-SIDE here - the Refresh button works
  // even when the generated code never wired onRefresh (the v1 footgun).
  //
  // The effect also fires once at mount (ready flips true with the parent's
  // initial signal value). That mount fire keeps the legacy behavior of
  // posting a refresh event, but must NOT run sources: opening an app is not
  // a user trigger, and auto-running would double with the recovery sweep
  // (and burn rate limit). Only an actual signal CHANGE runs entries.
  const seenRefreshSignalRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!ready || refreshSignal === undefined) return;
    const at = Date.now();
    post({ type: "refresh", at });
    pushSdkEvent(app.id, {
      id: `refresh-${at}`,
      at,
      direction: "host-to-iframe",
      type: "refresh",
      payload: null,
    });
    const prev = seenRefreshSignalRef.current;
    seenRefreshSignalRef.current = refreshSignal;
    if (prev === undefined || refreshSignal === prev) return; // mount fire
    const st = designer.manifest?.state;
    if (st) {
      for (const [key, cfg] of Object.entries(st)) {
        if (cfg.kind === "collection" && cfg.source && cfg.source.refresh?.user !== false) {
          void runEntrySource(key).catch(() => {
            // Error already recorded in the entry meta; watchers render it.
          });
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal, ready, post]);

  // Widget mode: observe the iframe's pixel size and push widget-resized
  // whenever it changes. Re-fires on viewport reflow without a remount.
  useEffect(() => {
    if (!isWidget || !ready) return;
    const el = iframeRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = { w: -1, h: -1 };
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      const w = Math.round(e.contentRect.width);
      const h = Math.round(e.contentRect.height);
      if (w === last.w && h === last.h) return;
      last = { w, h };
      const base = widgetSizeRef.current;
      if (!base) return;
      const next: WidgetSize = { ...base, w, h };
      widgetSizeRef.current = next;
      post({ type: "widget-resized", widgetSize: next });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isWidget, ready, post]);

  // Push preset changes (parent picked a different size) without a remount.
  useEffect(() => {
    if (!isWidget || !ready) return;
    const next = widget?.size;
    if (!next) return;
    post({ type: "widget-resized", widgetSize: next });
  }, [isWidget, ready, widget?.size, post]);

  const baseClass =
    className ??
    (isWidget
      ? "h-full w-full bg-transparent"
      : "h-full w-full rounded-2xl border border-border bg-card");

  if (build.kind === "building" || build.kind === "idle") {
    return (
      <div className={`${baseClass} grid place-items-center text-sm text-muted-foreground`}>
        Building…
      </div>
    );
  }

  const srcdoc =
    build.kind === "failed"
      ? composeBuildErrorDoc(build.errors)
      : build.kind === "ok"
        ? // The build pipeline has already injected the SDK; for legacy one-file
          // artifacts the static path also injects it. So we pass the html through.
          build.html.includes("__artifact_v1__")
          ? build.html
          : composeArtifactSrcdoc(build.html)
        : "";

  return (
    <iframe
      ref={iframeRef}
      title={designer.name}
      // allow-popups + allow-popups-to-escape-sandbox lets window.open and
      // <a target="_blank"> open real top-level tabs (no DOM access to the
      // host). Downloads and clipboard still go through the postMessage
      // bridge in handleRpc — relaxing further would require allow-same-origin
      // which would expose host storage to artifact code.
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcdoc}
      className={baseClass}
    />
  );
}
