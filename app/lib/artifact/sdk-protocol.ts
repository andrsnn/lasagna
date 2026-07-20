// Wire format shared between the host (parent window) and the iframe SDK.
// Keep this small + serialisable.

import type { ScheduledTask, WidgetSize } from "@/app/db";

export type QueryRequestOpts = {
  schema?: unknown;
  model?: string;
  webSearch?: boolean;
  system?: string;
  /** Route this query through the deep multi-agent research engine (planner →
   *  parallel web sub-agents → structured synthesis) instead of a single LLM
   *  call. Long-running; runs durably on the worker. */
  research?: boolean;
  /** Expose the user's configured MCP connectors' tools to this query so the
   *  model can call a connected server to fetch real data. The host attaches
   *  the connectors; the artifact just sets the flag. */
  mcp?: boolean;
};

/** A file handed to / produced by artifact.exec(). Pointer to bytes in Blob,
 *  never the bytes themselves. Mirrors AttachedFile in app/db.ts. */
export type ExecFile = {
  id?: string;
  name: string;
  blobKey?: string;
  url: string;
  contentType?: string;
  bytes?: number;
  produced?: boolean;
};

export type ExecRequestOpts = {
  language?: "python" | "node";
  stdin?: string;
  /** Files to stage into the run workspace (e.g. ones the app collected from
   *  the user, or earlier produced outputs). */
  files?: ExecFile[];
  timeoutMs?: number;
};

/** What artifact.exec() resolves to. */
export type ExecResult = {
  ok: boolean;
  language?: "python" | "node";
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  /** Files the run produced, uploaded to Blob with browser-resolvable URLs. */
  files?: ExecFile[];
  error?: string;
};

/** One terminal run captured for the host's "Recent runs" view. Mirrors
 *  the server type in app/lib/schedule-store.ts. */
export type ScheduleHistoryEntry = {
  runAt: number;
  durationMs: number;
  status: "complete" | "error";
  input:
    | { type: "query"; prompt: string; model?: string; webSearch?: boolean }
    | { type: "fetch"; url: string; method?: string };
  modelUsed?: string;
  result?: unknown;
  error?: string;
};

/** Snapshot of a scheduled task's latest run, returned to the iframe. */
export type ScheduleSnapshot = {
  task: ScheduledTask;
  origin: "manifest" | "sdk";
  registeredAt: number;
  result: unknown;
  runAt: number | null;
  status: "idle" | "running" | "complete" | "error";
  error?: string;
  /** True when the user has explicitly chosen the cron via the host UI. */
  userCronOverride?: boolean;
  /** Last cron seen from manifest / SDK auto-register. Useful for letting
   *  the host UI offer a "reset to default" affordance. */
  defaultCron?: string;
  /** Whether the recurring task may auto-fire. `false` means the user paused
   *  it in the Control Center; the schedule and its result are kept, but the
   *  cron sweep and catch-up skip it until resumed. */
  enabled?: boolean;
  /** Newest-first list of recent terminal runs, capped at HISTORY_MAX_ENTRIES. */
  history?: ScheduleHistoryEntry[];
} | null;

/** One entry in a public-share input collection. Mirrors ShareInputEntry
 *  in app/lib/share-input-store.ts. */
export type SharedInputEntry = {
  id: string;
  value: unknown;
  createdAt: number;
};

/** Snapshot of one declared data entry (manifest.state key), returned by
 *  artifact.entries.get/refresh and delivered to entries.watch callbacks. The
 *  host maintains data + meta in app.state; this is just the read shape. */
export type EntrySnapshot = {
  data: unknown;
  status: "idle" | "refreshing" | "error";
  lastRefreshedAt: number | null;
  error: string | null;
};

export type FrameRequest =
  | { id: string; type: "ready" }
  | { id: string; type: "query"; prompt: string; opts?: QueryRequestOpts }
  // Declared-data refresh (SDK v2): the HOST looks up the entry's source in
  // manifest.state, runs the query, validates + merges by identity, persists
  // to app.state, and resolves with the fresh EntrySnapshot.
  | { id: string; type: "entry-refresh"; key: string }
  | { id: string; type: "exec"; code: string; opts?: ExecRequestOpts }
  | {
      id: string;
      type: "fetch";
      url: string;
      init?: { method?: string; headers?: Record<string, string>; body?: string };
    }
  | { id: string; type: "state.get"; key: string }
  | { id: string; type: "state.set"; key: string; value: unknown }
  // Image search routed through the host → /api/image-search (Brave). Results
  // carry same-origin proxied URLs that load inside the sandboxed iframe and
  // are durable enough to persist via state.set.
  | { id: string; type: "image-search"; query: string; maxResults?: number; safesearch?: "off" | "strict" }
  | { id: string; type: "schedule.define"; task: ScheduledTask }
  | { id: string; type: "schedule.get" }
  | { id: string; type: "schedule.run" }
  // Public-share input collections — appendable, listable, deletable by
  // anyone who has the share link. See app/lib/share-input-store.ts for
  // server-side semantics + caps. Calls fail with a clear error when the
  // artifact hasn't been shared yet (no shareToken in init).
  | { id: string; type: "shared.append"; collection: string; value: unknown }
  | { id: string; type: "shared.list"; collection: string }
  | { id: string; type: "shared.delete"; collection: string; entryId: string }
  | { id: string; type: "log"; level: "log" | "warn" | "error"; args: unknown[] }
  // Iframe sandbox doesn't grant allow-downloads / allow-same-origin, so the
  // host runs the actual download / clipboard write on its own origin. The
  // iframe sends bytes (Uint8Array survives structured clone) or text, plus a
  // filename and optional mime; the host validates, sanitizes, and triggers it.
  | {
      id: string;
      type: "download";
      filename: string;
      mime?: string;
      bytes?: Uint8Array;
      text?: string;
    }
  | { id: string; type: "open-url"; url: string; target?: "_blank" | "_top" }
  | { id: string; type: "clipboard-write"; text: string }
  // Widget-only, fire-and-forget. Posted from the widget shell whenever the
  // body's scrollHeight changes so the host can size the iframe element to
  // match and let its own overflow-y drive scrolling.
  | { type: "widget-content-height"; height: number };

export type FrameResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

export type HostMessage =
  | {
      type: "init";
      params: Record<string, unknown>;
      /** v7+: id of the paired app (designer.id === app.id). */
      appId: string;
      state: Record<string, unknown>;
      /** User's currently-selected model — applied as the default for artifact.query when caller omits it. */
      defaultModel?: string;
      /** User's web-search preference — applied as the default for artifact.query. */
      defaultWebSearch?: boolean;
      /** Set when the iframe is rendering as a widget. Absent → full app context. */
      widgetSize?: WidgetSize;
      /** Host's active theme. The SDK stamps it on <html> as
       *  data-artifact-theme so the injected token CSS (WIDGET_TOKENS_CSS /
       *  ARTIFACT_BASE_CSS) resolves light vs dark. Absent → the iframe falls
       *  back to prefers-color-scheme. */
      theme?: "light" | "dark";
      /** Active public-share token for this artifact, when one exists.
       *  Enables artifact.shared.* writes; absent → calls reject with
       *  "Sharing not enabled". Set on the public viewer (the token
       *  identifies the share) and on the owner's frame when an active
       *  share is on file (see GET /api/share-html/by-app/[appId]). */
      shareToken?: string;
      /** "public" when the frame is the unauthenticated viewer at
       *  /share/html/[token]; "owner" otherwise. The SDK uses this to
       *  short-circuit RPCs that aren't supported in the public bridge
       *  (query, fetch, state.set, schedule.*). */
      shareMode?: "owner" | "public";
    }
  | { type: "refresh"; at: number }
  | { type: "params-changed"; params: Record<string, unknown> }
  | {
      /** Host theme flipped (user toggled light/dark) after init. The SDK
       *  re-stamps data-artifact-theme so the running iframe restyles without a
       *  reload. */
      type: "theme-changed";
      theme: "light" | "dark";
    }
  | {
      type: "config-changed";
      /** Updated default model for artifact.query when caller omits it. */
      defaultModel?: string;
      /** Updated web-search preference for artifact.query. */
      defaultWebSearch?: boolean;
    }
  | { type: "schedule-updated"; payload: ScheduleSnapshot }
  | {
      /**
       * A query result became available to the host for this app — either a
       * fresh artifact.query() completion or one RECOVERED from a prior mount
       * whose in-flight request was interrupted (tab close / phone sleep).
       * Delivered to artifact.onQueryResult handlers; the SDK buffers the
       * latest per (prompt, opts) so a handler registered on mount still sees
       * a recovered result on first paint. Handlers must be idempotent.
       */
      type: "query-result";
      prompt: string;
      opts?: QueryRequestOpts;
      result: unknown;
    }
  | {
      /** Widget-only: pushed when the cell's pixel size changes (ResizeObserver). */
      type: "widget-resized";
      widgetSize: WidgetSize;
    }
  | {
      /**
       * Cross-iframe state sync: a sibling frame (same appId, different mount —
       * typically the widget on the home board hearing about a write the full
       * app made, or vice versa) merged a key. The host fans these out via
       * BroadcastChannel; see app/components/artifact-frame.tsx.
       */
      type: "state-merged";
      key: string;
      value: unknown;
    }
  | {
      /** Owner frame heard about a fresh share (or revocation) — push the
       *  new token so artifact.shared.* in the running iframe picks it up
       *  without a reload. */
      type: "share-token-updated";
      shareToken: string | null;
    };

export const FRAME_NAMESPACE = "__artifact_v1__";
