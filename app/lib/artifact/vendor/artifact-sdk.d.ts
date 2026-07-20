// Ambient type declarations for the artifact runtime SDK.
// Reference copy for repo-side tooling. The copy artifacts actually see is the
// `artifact-sdk.d.ts` seeded into each app's VFS (app/lib/create.ts) - keep
// the two aligned when the SDK surface changes.
//
// Source of truth for behavior: app/lib/artifact/sdk-inline.ts.

declare global {
  interface ArtifactQueryOpts {
    /** Optional JSON schema; when present, the runtime returns `{ text, json }` and json is parsed/validated. */
    schema?: Record<string, unknown>;
    /**
     * @deprecated Ignored. The query always runs on the user's configured
     * model (chosen in the app's Model setting / Preferences). A model passed
     * here is stripped by the runtime and has no effect.
     */
    model?: string;
    /** Enable web_search/web_fetch tools for this query. */
    webSearch?: boolean;
    /** Optional system prompt prepended to the user prompt. */
    system?: string;
    /** Run the deep multi-agent research engine (planner → parallel web
     *  sub-agents → structured synthesis) instead of one LLM call. Slower but
     *  far more thorough; runs durably so a tab close mid-run is recovered. */
    research?: boolean;
    /** Expose the user's connected MCP servers' tools to this query so the
     *  prompt can pull real data from a connected server. The host attaches the
     *  user's configured connectors; you only set the flag and describe the
     *  fetch. Never hardcode a server URL / key / connector id. */
    mcp?: boolean;
  }

  interface ArtifactQueryResult {
    text: string;
    json?: unknown;
    model?: string;
  }

  /** A file passed into / produced by `artifact.exec()`. A pointer to bytes in
   *  storage, not the bytes themselves. */
  interface ArtifactExecFile {
    /** Filename the sandbox exposes to the code / the user downloads. */
    name: string;
    /** Browser-resolvable URL (download / preview). */
    url: string;
    contentType?: string;
    bytes?: number;
    /** True for files the run produced (vs. inputs you passed in). */
    produced?: boolean;
  }

  interface ArtifactExecOpts {
    /** Interpreter to run the code with. Defaults to "python". */
    language?: "python" | "node";
    /** Text piped to the program's stdin. */
    stdin?: string;
    /** Input files to stage into the run's working directory. The code reads
     *  them by `name`; produced files come back in the result. */
    files?: ArtifactExecFile[];
    /** Wall-clock limit in ms (default 60000, max 120000). */
    timeoutMs?: number;
  }

  interface ArtifactExecResult {
    ok: boolean;
    language?: "python" | "node";
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    /** Files the run wrote to its working directory, ready to download. */
    files?: ArtifactExecFile[];
    error?: string;
  }

  interface ArtifactFetchInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }

  interface ArtifactFetchResult {
    status: number;
    ok: boolean;
    url: string;
    contentType?: string;
    headers?: Record<string, string>;
    body: string;
    /** True when `body` is base64-encoded (binary response). */
    isBase64?: boolean;
    truncated?: boolean;
  }

  /**
   * A single scheduled task: a server-side LLM call (`query`) or an HTTP
   * request (`fetch`). One per app. Cron is a standard 5-field expression;
   * effective minimum granularity is hourly because the sweep caps each app at
   * 1 run/hour and 24 runs/day.
   */
  type ArtifactScheduledTask =
    | {
        cron: string;
        type: "query";
        prompt: string;
        /** Optional JSON schema; when present the runtime returns parsed JSON in `result`. */
        schema?: unknown;
        tools?: ("web_search" | "web_fetch")[];
        /**
         * @deprecated Ignored. Scheduled runs always use the user's configured
         * model (the app's Model setting / Preferences). A model set here is
         * stripped by the runtime and has no effect.
         */
        model?: string;
        /** Run the deep research engine on each scheduled refresh. */
        research?: boolean;
      }
    | {
        cron: string;
        type: "fetch";
        url: string;
        init?: { method?: string; headers?: Record<string, string>; body?: string };
      };

  /**
   * Snapshot of the registered schedule plus the most recent server-run
   * result. Returned by `artifact.scheduled()`, `artifact.defineSchedule()`
   * and `artifact.runSchedule()`, and pushed via `artifact.onScheduleUpdate()`.
   * `null` means no schedule is registered.
   */
  interface ArtifactScheduleSnapshot {
    task: ArtifactScheduledTask;
    origin: "manifest" | "sdk";
    registeredAt: number;
    /** Parsed JSON for query+schema, raw text for query, or { status, body, headers, isBase64 } for fetch. */
    result: unknown;
    runAt: number | null;
    status: "idle" | "running" | "complete" | "error";
    error?: string;
  }

  /** One entry in a public-share input collection. */
  interface ArtifactSharedEntry {
    id: string;
    value: unknown;
    createdAt: number;
  }

  /** Snapshot of one declared data entry (manifest.json "state" key). */
  interface ArtifactEntrySnapshot {
    data: unknown;
    status: "idle" | "refreshing" | "error";
    /** Host-stamped clock: when this entry's data last landed. */
    lastRefreshedAt: number | null;
    error: string | null;
  }

  interface ArtifactImageSearchOpts {
    /** How many results to return. 1–20; defaults to 6. */
    maxResults?: number;
    /** Brave safe-search level. Defaults to "strict". */
    safesearch?: "off" | "strict";
  }

  /**
   * One image hit. `url` is a same-origin proxied URL (routed through the
   * host's image proxy) that loads inside the sandboxed iframe — use it
   * directly as an `<img src>`. It's stable and long-cached, so a result is
   * safe to persist with `artifact.state.set`.
   */
  interface ArtifactImage {
    url: string;
    /** Page that hosts the image. */
    source: string;
    title?: string;
    width?: number;
    height?: number;
  }

  interface ArtifactSDK {
    /** Snapshot of the current app's params. Updated in place when params change. */
    params: Record<string, unknown>;
    /** Stable id of the current app, or "" before init. */
    appId: string;
    /** @deprecated Use appId. Kept for one release for backwards compatibility. */
    instanceId: string;
    /** Default model the host suggests. */
    defaultModel?: string;
    /** Active public-share token, or null if the artifact hasn't been shared. */
    shareToken: string | null;
    /** "public" in the anonymous viewer, "owner" in the authenticated app, null otherwise. */
    shareMode: "owner" | "public" | null;
    /** Call once at startup; resolves when the host has hydrated state and params. */
    ready(): Promise<void>;
    /** Fires whenever the user clicks Refresh in the host chrome. */
    onRefresh(fn: (info: { at: number }) => void): void;
    /** Fires whenever the host pushes new params (e.g. user edits a param). */
    onParamsChanged(fn: (params: Record<string, unknown>) => void): void;
    /** Single-shot LLM call routed through the host. */
    query(prompt: string, opts?: ArtifactQueryOpts): Promise<ArtifactQueryResult>;
    /**
     * Run many queries in parallel with a concurrency cap (default 4, max 8).
     * Resolves to a same-length, same-order array of per-item outcomes; a single
     * failure never rejects the batch. Use for per-row enrichment of a table -
     * far faster than awaiting one query at a time.
     */
    batchQuery(
      items: Array<string | { prompt: string; opts?: ArtifactQueryOpts }>,
      opts?: ArtifactQueryOpts & { concurrency?: number }
    ): Promise<
      Array<{ ok: true; value: ArtifactQueryResult } | { ok: false; error: string }>
    >;
    /**
     * Run python/node in an isolated server-side sandbox (ffmpeg + common libs
     * available, network on). Stage inputs via `opts.files`; any file the code
     * writes to its working directory comes back in `result.files` with a
     * downloadable url. Heavy and rate-limited — invoke on a user action (e.g.
     * a "Convert" button), not in a render loop.
     */
    exec(code: string, opts?: ArtifactExecOpts): Promise<ArtifactExecResult>;
    /** CORS-bypassing proxy fetch routed through the host. */
    fetch(url: string, init?: ArtifactFetchInit): Promise<ArtifactFetchResult>;
    /**
     * Persistent KV scoped to this app — backed by IndexedDB, survives reloads,
     * code edits, version reverts, and host migrations. By design there is no
     * delete or clear: state is additive and forward-compatible. When the
     * shape of a stored value evolves, READ DEFENSIVELY and read-merge-write:
     *   const current = (await artifact.state.get('foo')) ?? {};
     *   await artifact.state.set('foo', { ...current, newField });
     * Setting one key never affects other keys (the host merges).
     */
    state: {
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown): Promise<true>;
    };
    /**
     * Declared data (SDK v2). Entries are declared in manifest.json "state";
     * the HOST runs their sources (Refresh button, refresh(), the declared
     * cron), validates against the entry schema, merges by identity, persists,
     * and syncs every surface. Render with useArtifact from "@artifact/ui";
     * never hand-wire query/schedule/state persistence for a declared entry.
     */
    entries: {
      get(key: string): Promise<ArtifactEntrySnapshot>;
      /** Fires immediately with the current snapshot, then on every change
       *  from ANY frame. Value semantics — duplicates are unobservable. */
      watch(key: string, fn: (snap: ArtifactEntrySnapshot) => void): () => void;
      update(key: string, value: unknown): Promise<true>;
      refresh(key: string): Promise<ArtifactEntrySnapshot>;
    };
    /**
     * Search the web for images via the host (Brave Search). Resolves to an
     * array of {@link ArtifactImage} whose `url` is a same-origin proxied URL
     * that loads inside the sandboxed iframe — drop it straight into an
     * `<img src>`. Dead URLs are filtered server-side, so results render
     * reliably. To "save" an image, persist the result object with
     * `artifact.state.set` — the proxied URL is durable and the value lands in
     * the host's IndexedDB, surviving reloads and version reverts.
     */
    imageSearch(query: string, opts?: ArtifactImageSearchOpts): Promise<ArtifactImage[]>;
    /**
     * Read the registered schedule + most recent server-run result. Returns
     * `null` when no schedule is registered (neither manifest-declared nor
     * defined via `defineSchedule`).
     */
    scheduled(): Promise<ArtifactScheduleSnapshot | null>;
    /**
     * Fires whenever a server-side schedule run completes. Use this to
     * re-render with the fresh result without polling. Multiple handlers
     * may be registered.
     */
    onScheduleUpdate(fn: (snapshot: ArtifactScheduleSnapshot) => void): void;
    /**
     * Manually trigger the registered schedule now. Still rate-limited
     * (≤1 run/hour, ≤24/day per app); rejects with a 429-ish error when
     * the budget is exhausted. Resolves with the settled snapshot.
     */
    runSchedule(): Promise<ArtifactScheduleSnapshot | null>;
    /**
     * Register or replace the schedule at runtime — the alternative to
     * declaring it in the manifest. Use this when cron depends on a
     * param (e.g. user picks "every 6 hours"). Calling again overwrites
     * the prior task. Resolves with the current snapshot.
     */
    defineSchedule(task: ArtifactScheduledTask): Promise<ArtifactScheduleSnapshot | null>;
    /**
     * Trigger a real browser download from the host. The artifact iframe is
     * sandboxed without `allow-downloads`, so the bare `Blob + a.click()`
     * pattern silently fails — call this instead. Accepts string for text
     * payloads, or Uint8Array / ArrayBuffer / Blob for binary. The host
     * sanitizes the filename and caps payload size at 25 MB.
     */
    download(
      content: string | ArrayBuffer | Uint8Array | Blob,
      filename: string,
      mime?: string
    ): Promise<true>;
    /**
     * Open a URL in a new top-level browser tab via the host. `window.open`
     * and `<a target="_blank">` also work natively because the iframe has
     * `allow-popups`; this is the explicit form. Only http(s)/mailto/tel
     * protocols are accepted.
     */
    openUrl(url: string, opts?: { target?: "_blank" | "_top" }): Promise<true>;
    /**
     * Write text to the system clipboard via the host. The sandbox blocks
     * direct `navigator.clipboard.writeText` calls; the SDK shims them to
     * route here automatically, but calling this explicitly is clearer.
     * Capped at 2 MB.
     */
    copyToClipboard(text: string): Promise<true>;
    /**
     * Public-share input collections. Server-backed, scoped to the active
     * share, 7-day TTL. Anyone with the share link can append, list, and
     * delete (wiki-mode); everyone sees everything. Values come from
     * anonymous viewers and must be rendered as text — never as HTML.
     *
     * Caps: collection name /^[a-z0-9_-]{1,32}$/; value JSON-serializable
     * and ≤2 KB; 200 entries / collection; 10 collections / share.
     *
     * Before the user has shared the artifact: list() resolves to [],
     * append() rejects with "Sharing not enabled", delete() rejects
     * likewise. onChange's first tick fires once a share is created.
     */
    shared: {
      append(collection: string, value: unknown): Promise<ArtifactSharedEntry>;
      list(collection: string): Promise<ArtifactSharedEntry[]>;
      delete(collection: string, entryId: string): Promise<boolean>;
      /** Polling subscription. Returns an unsubscribe function. */
      onChange(
        collection: string,
        fn: (entries: ArtifactSharedEntry[]) => void
      ): () => void;
    };
  }

  interface Window {
    artifact: ArtifactSDK;
  }
}

export {};
