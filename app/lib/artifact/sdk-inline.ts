// This script is injected verbatim into every artifact iframe.
// It defines window.artifact and bridges to the host via postMessage.
// Keep it dependency-free and self-contained.
//
// DATA DURABILITY (mirrors the host invariant):
//   - state.get(key) / state.set(key, value) are the only state operations.
//   - There is no state.delete or state.clear by design. State is additive
//     and forward-compatible: old artifacts that don't know about a new key
//     simply ignore it; new artifacts that read missing keys must default
//     defensively (e.g. `(await artifact.state.get('x')) ?? defaultX`).
//   - state.set on a single key never affects other keys. The host merges.
//   - Reverting designer code does NOT reset state.
//   - window.artifact.appId is the canonical id (v7+). The deprecated alias
//     `window.artifact.instanceId` mirrors it for one release.

export const SDK_INLINE_SCRIPT = /* javascript */ `
(function () {
  var NS = "__artifact_v1__";
  var pending = Object.create(null);
  var refreshHandler = null;
  var paramsChangedHandler = null;
  var scheduleHandlers = [];
  // Last schedule-updated payload received from the host. Buffered so handlers
  // registered AFTER the host's initial post (very common — many artifacts do
  // \`await artifact.ready()\` plus a few more awaits before wiring
  // onScheduleUpdate) still see the snapshot. Sentinel \`undefined\` means
  // "host hasn't posted yet"; \`null\` is a valid payload meaning "no schedule
  // registered for this app", which we still want to replay so handlers can
  // render an empty state.
  var lastScheduleSnapshot;
  var queryResultHandlers = [];
  // Buffered query results delivered by the host — fresh artifact.query()
  // completions AND runs recovered from a prior mount whose in-flight request
  // was interrupted (tab close / phone sleep). Keyed by (prompt, opts) so the
  // latest result for each distinct query survives until an onQueryResult
  // handler is registered. This is what makes "kick off a query, leave, come
  // back" actually re-render: the host re-delivers the recovered result on
  // mount and the buffer replays it to a handler wired in the first useEffect.
  var queryResultBuffer = [];
  var widgetResizeHandlers = [];
  var stateMergedHandlers = [];
  // Declared-data (entries) watchers: entry key → callbacks. Fired from
  // state-merged (host/sibling writes) and from entries.update (own writes),
  // so a watcher sees every change regardless of which frame made it.
  var entryWatchers = Object.create(null);
  var ENTRY_META_KEY = "__artifact_entry_meta__";
  var currentParams = {};
  var currentState = {};
  var appId = "";
  var defaultModel = undefined;
  var defaultWebSearch = false;
  var currentWidgetSize = undefined;
  // Public-share inputs (artifact.shared.*). shareToken is set on init when
  // the artifact has an active share — public viewer's bridge sets it
  // unconditionally; owner's bridge looks it up by appId. shareMode tells
  // us whether we're in the public viewer (so we can pre-empt RPCs that
  // bridge can't handle).
  var shareToken = null;
  var shareMode = null;
  // collection name → array of registered onChange callbacks. Polling is
  // started lazily on first subscription and keyed by collection so two
  // artifacts can subscribe to different collections without interfering.
  var sharedChangeHandlers = Object.create(null);
  var sharedPollers = Object.create(null);
  var SHARED_POLL_MS = 5000;
  var readyResolve = null;
  var readyPromise = new Promise(function (r) { readyResolve = r; });

  function post(msg) {
    try { window.parent.postMessage({ ns: NS, payload: msg }, "*"); } catch (e) {}
  }

  // Stamp the host's theme onto <html> as data-artifact-theme so the injected
  // token CSS (WIDGET_TOKENS_CSS / ARTIFACT_BASE_CSS) resolves light vs dark.
  // The sandboxed iframe can't read the host's .dark class, so this attribute
  // is how a manual toggle reaches the artifact; without it the CSS falls back
  // to prefers-color-scheme (which already matches the host's OS default).
  function applyArtifactTheme(theme) {
    if (theme !== "light" && theme !== "dark") return;
    try {
      var el = document.documentElement;
      if (el) el.setAttribute("data-artifact-theme", theme);
    } catch (e) {}
  }

  // Self-healing "ready" handshake. The host's message listener mounts
  // asynchronously (React), so a single early "ready" can be posted before the
  // host is listening, OR the host's "init" reply can race the iframe - either
  // way the handshake is lost, ready() never resolves, the app never mounts, and
  // the frame is blank until a manual Refresh. Re-post "ready" until "init"
  // arrives (readyResolve is nulled in the init handler) so mount order can't
  // drop it. This is the fix for the intermittent blank-frame-until-Refresh bug.
  var readyHandshakeStarted = false;
  function ensureReadyHandshake() {
    if (readyHandshakeStarted) return;
    readyHandshakeStarted = true;
    var tries = 0;
    (function tick() {
      if (!readyResolve) return; // init received -> stop pinging
      post({ type: "ready" });
      if (++tries < 60) setTimeout(tick, 250); // ~15s of retries, then give up
    })();
  }

  function call(type, extra) {
    var id = (crypto && crypto.randomUUID && crypto.randomUUID()) ||
             (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      var msg = Object.assign({ id: id, type: type }, extra || {});
      post(msg);
    });
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.ns !== NS) return;
    var payload = data.payload;
    if (!payload) return;

    // Host → iframe lifecycle
    if (payload.type === "init") {
      currentParams = payload.params || {};
      currentState = payload.state || {};
      // v7+ uses appId; tolerate the legacy instanceId field on the wire.
      appId = payload.appId || payload.instanceId || "";
      defaultModel = payload.defaultModel || undefined;
      defaultWebSearch = !!payload.defaultWebSearch;
      currentWidgetSize = payload.widgetSize || undefined;
      shareToken = typeof payload.shareToken === "string" && payload.shareToken
        ? payload.shareToken : null;
      shareMode = payload.shareMode === "public" || payload.shareMode === "owner"
        ? payload.shareMode : null;
      applyArtifactTheme(payload.theme);
      if (window.artifact) {
        window.artifact.params = currentParams;
        window.artifact.appId = appId;
        // Deprecated alias — kept for one release so existing artifact code
        // that reads window.artifact.instanceId keeps working.
        window.artifact.instanceId = appId;
        window.artifact.defaultModel = defaultModel;
        window.artifact.widgetSize = currentWidgetSize;
        window.artifact.shareToken = shareToken;
        window.artifact.shareMode = shareMode;
      }
      if (readyResolve) { readyResolve(); readyResolve = null; }
      return;
    }
    if (payload.type === "share-token-updated") {
      shareToken = typeof payload.shareToken === "string" && payload.shareToken
        ? payload.shareToken : null;
      if (window.artifact) window.artifact.shareToken = shareToken;
      // Existing onChange subscriptions start working as soon as a token
      // arrives. We don't need to restart pollers — they reuse the live
      // shareToken on each tick.
      return;
    }
    if (payload.type === "theme-changed") {
      applyArtifactTheme(payload.theme);
      return;
    }
    if (payload.type === "refresh") {
      if (refreshHandler) {
        try { refreshHandler({ at: payload.at }); }
        catch (e) { console.error(e); }
      }
      return;
    }
    if (payload.type === "params-changed") {
      currentParams = payload.params || {};
      if (window.artifact) window.artifact.params = currentParams;
      if (paramsChangedHandler) {
        try { paramsChangedHandler(currentParams); } catch (e) { console.error(e); }
      }
      return;
    }
    if (payload.type === "config-changed") {
      defaultModel = payload.defaultModel || undefined;
      defaultWebSearch = !!payload.defaultWebSearch;
      if (window.artifact) window.artifact.defaultModel = defaultModel;
      return;
    }
    if (payload.type === "schedule-updated") {
      lastScheduleSnapshot = payload.payload;
      for (var i = 0; i < scheduleHandlers.length; i++) {
        try { scheduleHandlers[i](payload.payload); }
        catch (e) { console.error(e); }
      }
      return;
    }
    if (payload.type === "query-result") {
      var qr = { prompt: payload.prompt, opts: payload.opts, result: payload.result };
      var sig = (payload.prompt || "") + "::" + (function () {
        try { return JSON.stringify(payload.opts || null); } catch (e) { return ""; }
      })();
      var replaced = false;
      for (var qi = 0; qi < queryResultBuffer.length; qi++) {
        if (queryResultBuffer[qi].sig === sig) {
          queryResultBuffer[qi] = { sig: sig, value: qr };
          replaced = true;
          break;
        }
      }
      if (!replaced) queryResultBuffer.push({ sig: sig, value: qr });
      for (var qh = 0; qh < queryResultHandlers.length; qh++) {
        try { queryResultHandlers[qh](qr); } catch (e) { console.error(e); }
      }
      return;
    }
    if (payload.type === "widget-resized") {
      currentWidgetSize = payload.widgetSize || undefined;
      if (window.artifact) window.artifact.widgetSize = currentWidgetSize;
      for (var wi = 0; wi < widgetResizeHandlers.length; wi++) {
        try { widgetResizeHandlers[wi](currentWidgetSize); }
        catch (e) { console.error(e); }
      }
      return;
    }
    if (payload.type === "state-merged") {
      // Update the local mirror so a subsequent state.get returns the fresh
      // value without an RPC round-trip. The host has already persisted it
      // via mergeAppStateKey before broadcasting.
      currentState[payload.key] = payload.value;
      for (var si = 0; si < stateMergedHandlers.length; si++) {
        try { stateMergedHandlers[si](payload.key, payload.value); }
        catch (e) { console.error(e); }
      }
      // Declared-data watchers: a write to the entry's data key fires its
      // watchers directly; a write to the meta bag fires watchers of every
      // entry (meta is small and watchers re-read their own slice).
      if (payload.key === ENTRY_META_KEY) {
        for (var ek in entryWatchers) fireEntryWatchers(ek);
      } else if (entryWatchers[payload.key]) {
        fireEntryWatchers(payload.key);
      }
      return;
    }

    // Iframe → host RPC responses
    if (payload.id && pending[payload.id]) {
      var entry = pending[payload.id];
      delete pending[payload.id];
      if (payload.ok) entry.resolve(payload.result);
      else entry.reject(new Error(payload.error || "Artifact SDK error"));
    }
  });

  function api(type, extra) { return call(type, extra); }

  // ----- declared-data (entries) helpers ------------------------------------
  // Build the read snapshot for one entry from the local state mirror. The
  // mirror is hydrated at init and kept fresh by state-merged, so this is
  // synchronous and cheap; entries.get() double-checks via RPC for callers
  // that need pre-watch authority.
  function entrySnapshot(key) {
    var metaAll = currentState[ENTRY_META_KEY];
    var meta = (metaAll && metaAll[key]) || {};
    var data = currentState[key];
    return {
      data: data === undefined ? null : data,
      status: meta.status || "idle",
      lastRefreshedAt: typeof meta.lastRefreshedAt === "number" ? meta.lastRefreshedAt : null,
      error: typeof meta.error === "string" && meta.error ? meta.error : null
    };
  }

  function fireEntryWatchers(key) {
    var arr = entryWatchers[key];
    if (!arr || !arr.length) return;
    var snap = entrySnapshot(key);
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](snap); } catch (e) { console.error(e); }
    }
  }

  // Shallow-compare two entry arrays by (id, createdAt) — enough to detect
  // appends, deletions, and reorders without paying for a deep value diff.
  // Values themselves are immutable from the artifact's perspective (the
  // server doesn't expose an update path), so id+createdAt is sufficient.
  function sharedEntriesChanged(a, b) {
    if (a === b) return false;
    if (!a || !b) return true;
    if (a.length !== b.length) return true;
    for (var i = 0; i < a.length; i++) {
      if (!a[i] || !b[i]) return true;
      if (a[i].id !== b[i].id) return true;
      if (a[i].createdAt !== b[i].createdAt) return true;
    }
    return false;
  }

  function fireSharedHandlers(collection, entries) {
    var handlers = sharedChangeHandlers[collection] || [];
    for (var i = 0; i < handlers.length; i++) {
      try { handlers[i](entries); } catch (e) { console.error(e); }
    }
  }

  function startSharedPoller(collection) {
    if (sharedPollers[collection]) return;
    var lastEntries = null;
    function tick() {
      // Skip the round-trip when sharing isn't on yet or the tab is hidden.
      if (!shareToken) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      api("shared.list", { collection: collection }).then(function (entries) {
        if (!Array.isArray(entries)) return;
        if (sharedEntriesChanged(lastEntries, entries)) {
          lastEntries = entries;
          fireSharedHandlers(collection, entries);
        }
      }).catch(function () { /* network blip — try again next tick */ });
    }
    // Immediate first poll so a fresh subscriber sees current state without
    // waiting a full interval. Polling itself uses setInterval — simpler
    // than chained setTimeouts and bounded by the interval anyway.
    tick();
    sharedPollers[collection] = setInterval(tick, SHARED_POLL_MS);
  }

  function stopSharedPoller(collection) {
    var id = sharedPollers[collection];
    if (id) {
      clearInterval(id);
      delete sharedPollers[collection];
    }
    delete sharedChangeHandlers[collection];
  }

  var artifact = {
    params: currentParams,
    appId: "",
    // Deprecated alias — kept for one release.
    instanceId: "",
    /** Present only when this iframe is rendering as a widget. Updated on resize. */
    widgetSize: undefined,
    /** Set when the artifact has an active public share. \`artifact.shared.*\`
     *  reads/writes use this token. null when sharing isn't enabled. */
    shareToken: null,
    /** "public" in the unauthenticated viewer at /share/html/[token],
     *  "owner" in the authenticated app/designer view, null otherwise. */
    shareMode: null,
    ready: function () {
      ensureReadyHandshake();
      return readyPromise;
    },
    onRefresh: function (fn) { refreshHandler = fn; },
    onParamsChanged: function (fn) { paramsChangedHandler = fn; },
    query: function (prompt, opts) {
      var merged = Object.assign({}, opts || {});
      // The model is always the user's configured model, resolved by the host.
      // A model passed in code is intentionally ignored — strip it so it never
      // crosses the wire and can't override the user's choice.
      delete merged.model;
      if (merged.webSearch === undefined) merged.webSearch = defaultWebSearch;
      return api("query", { prompt: String(prompt || ""), opts: merged });
    },
    // Run MANY queries in parallel with a concurrency cap (default 4, max 8).
    // items is an array of strings or { prompt, opts } objects; opts holds
    // shared query options plus { concurrency }. Resolves to a same-length,
    // same-order array of { ok:true, value } or { ok:false, error } - one
    // failed item never rejects the batch. Ideal for per-row enrichment of a
    // table (fan-out is far faster than awaiting one at a time).
    batchQuery: function (items, opts) {
      opts = opts || {};
      var concurrency = Math.max(1, Math.min(8, opts.concurrency || 4));
      var self = this;
      var list = (items || []).map(function (it) {
        return typeof it === "string"
          ? { prompt: it, opts: {} }
          : { prompt: String((it && it.prompt) || ""), opts: (it && it.opts) || {} };
      });
      var results = new Array(list.length);
      var idx = 0;
      function worker() {
        if (idx >= list.length) return Promise.resolve();
        var i = idx++;
        var merged = Object.assign({}, opts, list[i].opts);
        delete merged.concurrency;
        return self
          .query(list[i].prompt, merged)
          .then(
            function (r) { results[i] = { ok: true, value: r }; },
            function (e) { results[i] = { ok: false, error: (e && e.message) || String(e) }; }
          )
          .then(worker);
      }
      var workers = [];
      for (var w = 0; w < Math.min(concurrency, list.length); w++) workers.push(worker());
      return Promise.all(workers).then(function () { return results; });
    },
    // Run python/node in the sandbox and get back { ok, exitCode, stdout,
    // stderr, files }. Pass opts.files (each { name, url }) to stage inputs
    // into the run workspace; any file the code writes is returned in
    // result.files with a downloadable url. Heavy + rate-limited — call it on
    // a user action (e.g. "convert"), not in a render loop.
    exec: function (code, opts) {
      return api("exec", { code: String(code || ""), opts: opts || {} });
    },
    fetch: function (url, init) {
      return api("fetch", { url: String(url), init: init || {} });
    },
    // state.get/set are the ONLY supported state operations. By design there
    // is no delete/clear — see DATA DURABILITY note at top of file.
    state: {
      get: function (key) { return api("state.get", { key: String(key) }); },
      set: function (key, value) { return api("state.set", { key: String(key), value: value }); }
    },
    /**
     * Declared data (SDK v2). Entries are declared in manifest.state; the HOST
     * runs their sources (Refresh button, entries.refresh(), the declared
     * cron), validates, merges by identity, and persists - so every surface
     * (widget, full app, other devices) reads the same data with zero wiring.
     *
     *   get(key)       -> Promise<{ data, status, lastRefreshedAt, error }>
     *   watch(key, fn) -> unsubscribe. Fires immediately with the current
     *                     snapshot, then on every change from any frame.
     *                     Idempotent by construction: fn receives state, not
     *                     events - duplicate deliveries are unobservable.
     *   update(key, v) -> write the entry's value (user-owned entries).
     *   refresh(key)   -> ask the host to run the entry's declared source now.
     *                     Rate-limited host-side; resolves with the snapshot.
     */
    entries: {
      get: function (key) {
        var k = String(key);
        return api("state.get", { key: k }).then(function (data) {
          return api("state.get", { key: ENTRY_META_KEY }).then(function (metaAll) {
            currentState[k] = data;
            if (metaAll) currentState[ENTRY_META_KEY] = metaAll;
            return entrySnapshot(k);
          });
        });
      },
      watch: function (key, fn) {
        var k = String(key);
        if (typeof fn !== "function") return function () {};
        if (!entryWatchers[k]) entryWatchers[k] = [];
        entryWatchers[k].push(fn);
        var alive = true;
        // Initial snapshot: authoritative read (covers a watch() wired before
        // init hydration lands), delivered async like every later tick.
        artifact.entries.get(k).then(function (snap) {
          if (!alive) return;
          try { fn(snap); } catch (e) { console.error(e); }
        }).catch(function () {
          if (!alive) return;
          try { fn(entrySnapshot(k)); } catch (e) { console.error(e); }
        });
        return function () {
          alive = false;
          var arr = entryWatchers[k] || [];
          var i = arr.indexOf(fn);
          if (i >= 0) arr.splice(i, 1);
        };
      },
      update: function (key, value) {
        var k = String(key);
        currentState[k] = value;
        fireEntryWatchers(k);
        return api("state.set", { key: k, value: value });
      },
      refresh: function (key) {
        return api("entry-refresh", { key: String(key) });
      }
    },
    // Search the web for images via the host (Brave). Resolves to an array of
    // { url, source, title?, width?, height? } where url is a same-origin
    // proxied URL that loads inside the sandboxed iframe and survives being
    // stored — persist a result with artifact.state.set to keep it across
    // reloads (it lands in the host's IndexedDB).
    imageSearch: function (query, opts) {
      var extra = { query: String(query || "") };
      if (opts && opts.maxResults != null) extra.maxResults = opts.maxResults;
      if (opts && (opts.safesearch === "off" || opts.safesearch === "strict")) {
        extra.safesearch = opts.safesearch;
      }
      return api("image-search", extra);
    },
    // Public-share input collections. Anyone with the share link can
    // append/list/delete; everyone sees everything (anonymous + wiki-mode).
    // Calls fail with "Sharing not enabled" until the owner has created a
    // share — that's intentional so an artifact can call shared.list() on
    // first paint and just see [] before sharing happens.
    //
    // SECURITY: values returned by shared.list come from anonymous viewers.
    // ALWAYS render them with textContent / DOM Text nodes — NEVER innerHTML.
    shared: {
      append: function (collection, value) {
        return api("shared.append", { collection: String(collection || ""), value: value });
      },
      list: function (collection) {
        // No shareToken yet → resolve [] so first-paint code doesn't crash
        // before the artifact has been shared.
        if (!shareToken) return Promise.resolve([]);
        return api("shared.list", { collection: String(collection || "") });
      },
      "delete": function (collection, entryId) {
        return api("shared.delete", {
          collection: String(collection || ""),
          entryId: String(entryId || "")
        });
      },
      // Polling subscription. Fires fn(entries) whenever the list for the
      // given collection changes. Tab-visibility aware: pauses while the
      // document is hidden so background tabs don't burn rate limit.
      // Returns an unsubscribe function — call it to stop polling and
      // release the handler.
      onChange: function (collection, fn) {
        if (typeof fn !== "function") return function () {};
        var key = String(collection || "");
        if (!sharedChangeHandlers[key]) sharedChangeHandlers[key] = [];
        sharedChangeHandlers[key].push(fn);
        startSharedPoller(key);
        return function () {
          var arr = sharedChangeHandlers[key] || [];
          var i = arr.indexOf(fn);
          if (i >= 0) arr.splice(i, 1);
          if (arr.length === 0) stopSharedPoller(key);
        };
      }
    },
    // Scheduled tasks. One per app. The first defineSchedule() call after
    // an artifact loads is what registers the schedule server-side; reading
    // via scheduled() with no prior defineSchedule (or a manifest-declared
    // schedule) returns null. Calling defineSchedule again overwrites the
    // prior task — this is intentional so artifacts whose cron depends on
    // a param can re-register when the param changes.
    defineSchedule: function (task) {
      // A model baked into the task is ignored — the scheduled run always uses
      // the user's configured model (resolved host-side). Strip it here so code
      // can't override the user's choice.
      var t = task;
      if (t && t.model !== undefined) {
        t = Object.assign({}, task);
        delete t.model;
      }
      return api("schedule.define", { task: t });
    },
    scheduled: function () {
      return api("schedule.get", {}).then(function (snap) {
        // Seed the replay buffer when the host's own schedule-updated push
        // hasn't arrived yet (its ready-time refetch can be lost to a network
        // blip). Without this, an app that awaits scheduled(), sees a result,
        // and waits for onScheduleUpdate can sit empty forever even though
        // the snapshot is sitting right here. Handlers are idempotent by
        // contract, so delivering a known snapshot is always safe.
        if (lastScheduleSnapshot === undefined && snap !== undefined) {
          lastScheduleSnapshot = snap;
          for (var i = 0; i < scheduleHandlers.length; i++) {
            try { scheduleHandlers[i](snap); } catch (e) { console.error(e); }
          }
        }
        return snap;
      });
    },
    runSchedule: function () {
      return api("schedule.run", {});
    },
    /**
     * Fires whenever a query result becomes available to the host for this
     * app — both a fresh artifact.query() completion AND a run RECOVERED from
     * a prior mount that was interrupted mid-flight (you left the app / your
     * phone slept before it finished). Each call gets { prompt, opts, result }.
     *
     * This is the durable-query channel: register it synchronously in your
     * first useEffect and the SDK replays any buffered/recovered result on
     * mount, so a query you kicked off before leaving re-renders when you come
     * back. The handler MAY fire more than once for the same query (fresh +
     * replay) — make it idempotent (setData(result), not append).
     */
    onQueryResult: function (fn) {
      if (typeof fn !== "function") return;
      queryResultHandlers.push(fn);
      // Replay buffered results so a handler registered after the host posted
      // (e.g. a recovered in-flight query delivered on mount) still fires.
      // Microtask so synchronous setup finishes first, matching live timing.
      if (queryResultBuffer.length) {
        var snapshot = queryResultBuffer.slice();
        var replayQr = function () {
          for (var i = 0; i < snapshot.length; i++) {
            try { fn(snapshot[i].value); } catch (e) { console.error(e); }
          }
        };
        if (typeof queueMicrotask === "function") queueMicrotask(replayQr);
        else Promise.resolve().then(replayQr);
      }
    },
    onScheduleUpdate: function (fn) {
      if (typeof fn !== "function") return;
      scheduleHandlers.push(fn);
      // If the host has already posted a snapshot before this handler was
      // registered, replay it so the artifact renders the cached result on
      // first paint instead of sitting on a placeholder forever. Microtask
      // so the caller can finish its synchronous setup before the handler
      // fires (matches the timing handlers see for live updates).
      if (lastScheduleSnapshot !== undefined) {
        var snapshot = lastScheduleSnapshot;
        var replay = function () {
          try { fn(snapshot); } catch (e) { console.error(e); }
        };
        if (typeof queueMicrotask === "function") queueMicrotask(replay);
        else Promise.resolve().then(replay);
      }
    },
    /**
     * Widget-only: fires whenever the host re-pushes the cell's pixel size
     * (the user resized the widget, or the viewport reflowed). The preset
     * stays the same; only w/h change. No-op outside widget mode.
     */
    onWidgetResize: function (fn) {
      if (typeof fn === "function") widgetResizeHandlers.push(fn);
    },
    /**
     * Cross-iframe state sync: fires when a sibling frame for the SAME app
     * (e.g. the widget on the home board, while this is the full app — or
     * vice versa) writes a state key. The local mirror has already been
     * updated, so artifact.state.get(key) returns the new value.
     */
    onStateMerged: function (fn) {
      if (typeof fn === "function") stateMergedHandlers.push(fn);
    },
    // The artifact iframe is sandboxed without allow-downloads / allow-same-origin,
    // so blob+a.click() and navigator.clipboard.writeText silently fail. These
    // SDK methods route through the host which has the right origin context.
    download: function (content, filename, mime) {
      var name = String(filename || "download");
      var type = mime ? String(mime) : undefined;
      function send(extra) {
        return api("download", Object.assign({ filename: name, mime: type }, extra));
      }
      if (content == null) return Promise.reject(new Error("artifact.download: content is required"));
      if (typeof content === "string") {
        return send({ text: content });
      }
      if (typeof Blob !== "undefined" && content instanceof Blob) {
        if (!type && content.type) type = content.type;
        return content.arrayBuffer().then(function (buf) {
          return api("download", { filename: name, mime: type, bytes: new Uint8Array(buf) });
        });
      }
      if (content instanceof ArrayBuffer) {
        return send({ bytes: new Uint8Array(content) });
      }
      if (content && typeof content === "object" && content.buffer instanceof ArrayBuffer) {
        // Already a typed array — copy into a Uint8Array view of the same bytes.
        return send({ bytes: new Uint8Array(content.buffer, content.byteOffset || 0, content.byteLength) });
      }
      return Promise.reject(new Error("artifact.download: unsupported content type"));
    },
    openUrl: function (url, opts) {
      var target = opts && opts.target ? opts.target : "_blank";
      return api("open-url", { url: String(url), target: target });
    },
    copyToClipboard: function (text) {
      return api("clipboard-write", { text: String(text == null ? "" : text) });
    },
    /**
     * Durable query helper. Encapsulates the "kick off a query, leave, come
     * back, still see the result" pattern that artifacts otherwise hand-wire
     * (synchronous onQueryResult + state restore + persist + idempotency).
     *
     *   var t = artifact.task("events", prompt, { webSearch: true, schema });
     *   t.subscribe(function (s) { render(s.data, s.loading, s.error); });
     *   // on a user tap: t.refresh();
     *
     * Restores the last result from state[key] for instant first paint,
     * repaints from onQueryResult (fresh completions AND runs recovered from a
     * prior mount), persists every result to state[key], and stays idempotent
     * (replace, never append). The React wrapper useArtifactTask (in
     * "@artifact/ui") adapts this to hook ergonomics.
     */
    task: function (key, prompt, opts) {
      var skey = String(key);
      var sprompt = String(prompt || "");
      var snap = { data: undefined, loading: false, error: null };
      var subs = [];
      function emit() {
        for (var i = 0; i < subs.length; i++) {
          try { subs[i](snap); } catch (e) { console.error(e); }
        }
      }
      function patch(next) { snap = Object.assign({}, snap, next); emit(); }
      // Restore prior result for first paint (only if nothing newer arrived).
      artifact.state.get(skey).then(function (saved) {
        if (saved !== undefined && saved !== null && snap.data === undefined) {
          patch({ data: saved });
        }
      }).catch(function () { /* first run — no saved value */ });
      // Single render path: fresh completions and recovered runs both land here.
      artifact.onQueryResult(function (ev) {
        if (!ev || ev.prompt !== sprompt) return;
        var r = ev.result || {};
        var value = r.json !== undefined ? r.json : r.text;
        patch({ data: value, loading: false, error: null });
        artifact.state.set(skey, value);
      });
      function refresh() {
        patch({ loading: true, error: null });
        artifact.query(sprompt, opts).catch(function (e) {
          patch({ loading: false, error: e && e.message ? e.message : String(e) });
        });
      }
      return {
        get: function () { return snap; },
        subscribe: function (cb) {
          if (typeof cb !== "function") return function () {};
          subs.push(cb);
          cb(snap);
          return function () {
            var i = subs.indexOf(cb);
            if (i >= 0) subs.splice(i, 1);
          };
        },
        refresh: refresh
      };
    }
  };

  // Legacy-API shims. Existing artifacts (and ones the inner LLM may still
  // generate) reach for blob+a.click() and navigator.clipboard.writeText —
  // both no-ops in this sandbox. Reroute them through the bridge so they Just
  // Work without rebuilding.
  function downloadFromAnchor(anchor) {
    var name = anchor.getAttribute("download") || "download";
    var href = anchor.href || "";
    if (!href) return;
    if (href.indexOf("blob:") === 0 || href.indexOf("data:") === 0) {
      fetch(href)
        .then(function (r) { return r.blob(); })
        .then(function (b) { return artifact.download(b, name, b.type || undefined); })
        .catch(function (e) { console.error(e); });
      return;
    }
    // For plain URLs with a download attribute, treat it as opening the URL —
    // the host can't fetch arbitrary cross-origin resources for the user
    // without their explicit consent. The link still navigates to the file.
    artifact.openUrl(href, { target: "_blank" }).catch(function (e) { console.error(e); });
  }

  try {
    var origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.hasAttribute && this.hasAttribute("download")) {
        try { downloadFromAnchor(this); } catch (e) { console.error(e); }
        return;
      }
      return origAnchorClick.apply(this, arguments);
    };
  } catch (e) { /* prototype frozen on some browsers */ }

  // Capture-phase listener catches user clicks AND dispatchEvent(new MouseEvent('click')).
  document.addEventListener("click", function (event) {
    var t = event.target;
    var a = t && t.closest ? t.closest("a[download]") : null;
    if (!a) return;
    event.preventDefault();
    event.stopPropagation();
    try { downloadFromAnchor(a); } catch (e) { console.error(e); }
  }, true);

  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: Object.freeze({
        writeText: function (t) { return artifact.copyToClipboard(t); },
        readText: function () {
          return Promise.reject(new Error("clipboard read disabled in sandboxed artifact"));
        }
      })
    });
  } catch (e) { /* navigator.clipboard non-configurable on some browsers */ }

  // Surface uncaught errors to the host so we can show them in the chrome.
  //
  // The browser mutes the uncaught "error" event to a bare "Script error."
  // (no message, filename, or error object) whenever the throwing frame is a
  // cross-origin script. We load React et al. from esm.sh, so an exception
  // thrown inside those modules surfaces as the useless "Script error." that
  // the host (and the auto-fix agent) can do nothing with.
  //
  // React and most libraries print the real error - message plus component
  // stack - to console.error *before* it bubbles up as the muted event. So we
  // keep a short ring of recent console.error text and use it to enrich the
  // muted event with the actual cause.
  var recentErrors = [];
  function recordErrorText(text) {
    if (!text) return;
    recentErrors.push({ text: text, at: Date.now() });
    if (recentErrors.length > 10) recentErrors.shift();
  }
  function consoleArgsToText(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (a == null) { parts.push(String(a)); continue; }
      if (typeof a === "string") { parts.push(a); continue; }
      if (a instanceof Error) { parts.push(a.stack || (a.name + ": " + a.message)); continue; }
      try { parts.push(JSON.stringify(a)); } catch (jsonErr) { parts.push(String(a)); }
    }
    return parts.join(" ");
  }
  var origConsoleError = (console && console.error) ? console.error.bind(console) : function () {};
  try {
    console.error = function () {
      var args = Array.prototype.slice.call(arguments);
      try { recordErrorText(consoleArgsToText(args)); } catch (capErr) {}
      return origConsoleError.apply(null, args);
    };
  } catch (patchErr) { /* console.error may be non-writable on some engines */ }
  function recentErrorDetail(withinMs) {
    var cutoff = Date.now() - (withinMs || 1500);
    for (var i = recentErrors.length - 1; i >= 0; i--) {
      if (recentErrors[i].at >= cutoff) return recentErrors[i].text;
    }
    return "";
  }
  var MUTED_HINT = "An uncaught error occurred, but the browser hid its details (cross-origin 'Script error.'). This usually means an exception was thrown inside a module loaded from a CDN (e.g. React from esm.sh). Reproduce with the browser console open to see the full stack trace.";

  window.addEventListener("error", function (e) {
    var rawMessage = String((e && e.message) || (e && e.error && e.error.message) || "error");
    var muted = rawMessage === "Script error." && !(e && e.error) && !(e && e.filename);
    var parts;
    if (muted) {
      var detail = recentErrorDetail(1500);
      parts = [detail || MUTED_HINT];
    } else {
      parts = [rawMessage];
      if (e.filename) parts.push("at " + e.filename + (e.lineno ? ":" + e.lineno : "") + (e.colno ? ":" + e.colno : ""));
      if (e.error && e.error.stack) parts.push(e.error.stack);
    }
    post({ type: "log", level: "error", args: parts });
  });
  window.addEventListener("unhandledrejection", function (e) {
    var reason = e && e.reason;
    var parts;
    if (reason && reason.message) {
      parts = [reason.message];
      if (reason.stack) parts.push(reason.stack);
    } else {
      var text = reason == null ? "" : String(reason);
      if (!text || text === "Script error." || text === "[object Object]") {
        var detail = recentErrorDetail(1500);
        parts = [detail || "An unhandled promise rejection occurred without a usable reason. Reproduce with the browser console open for details."];
      } else {
        parts = [text];
      }
    }
    post({ type: "log", level: "error", args: parts });
  });

  Object.defineProperty(window, "artifact", { value: artifact, writable: false, configurable: false });

  // Auto-fire ready on next tick if the artifact forgets to call it. Uses the
  // self-healing handshake so a missed first "ready"/"init" still recovers.
  setTimeout(function () {
    if (readyResolve) ensureReadyHandshake();
  }, 100);
})();
`;
