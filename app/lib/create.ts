"use client";

// Helpers for creating a designer + paired app + chat for the "+ new artifact"
// flow. Designer and app share the same id (1:1 invariant).

import {
  newChatTtl,
  newId,
  putApp,
  putChat,
  putDesigner,
  putMessage,
  type ArtifactFiles,
  type ArtifactManifest,
  type StoredApp,
  type StoredChat,
  type StoredDesigner,
  type StoredMessage,
  type StructuredResearchPayload,
} from "@/app/db";
import { parseManifestFromVfs } from "@/app/lib/artifact/manifest";
import {
  DEFAULT_TEMPLATE_ID,
  isAppTemplateId,
  type AppTemplateId,
} from "@/app/lib/app-templates";

const STARTER_FILES: ArtifactFiles = {
  "index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Untitled artifact</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./main.tsx"></script>
</body>
</html>
`,

  "main.tsx": `import { createRoot } from "react-dom/client";
import { App } from "./App";

await window.artifact.ready();
const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
`,

  "App.tsx": `export function App() {
  return (
    <main className="empty">
      <h1>Untitled artifact</h1>
      <p>Describe what you want - the assistant will replace this stub with a real artifact.</p>
    </main>
  );
}
`,

  "styles.css": `body {
  margin: 0;
  font-family: ui-serif, Georgia, "Times New Roman", serif;
  background: radial-gradient(ellipse at top, #1a0e2e, #08070d 60%);
  color: #ededf2;
  min-height: 100vh;
  display: grid;
  place-items: center;
}

.empty {
  text-align: center;
  padding: 3rem 2rem;
  border-radius: 1.5rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(20px);
  max-width: 28rem;
}

.empty h1 {
  background: linear-gradient(135deg, #a78bfa, #60a5fa);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  margin: 0 0 0.5rem;
  font-size: 1.5rem;
}

.empty p {
  margin: 0;
  color: rgba(255, 255, 255, 0.6);
  font-size: 0.875rem;
}
`,

  "manifest.json": `{
  "name": "Untitled",
  "description": "A blank artifact, ready to be built.",
  "params": []
}
`,

  "artifact-sdk.d.ts": `// Ambient type declarations for the artifact runtime SDK.
// Reference this file if you need exact typings for window.artifact.

declare global {
  interface ArtifactQueryOpts {
    schema?: Record<string, unknown>;
    model?: string;
    webSearch?: boolean;
    system?: string;
    /** Expose the user's connected MCP servers' tools to this call so the
     *  prompt can pull real data from a connected server. The host attaches
     *  the connectors; you just set the flag and describe the fetch. */
    mcp?: boolean;
  }

  interface ArtifactQueryResult {
    text: string;
    json?: unknown;
    model?: string;
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
    isBase64?: boolean;
    truncated?: boolean;
  }

  /** Preset cell sizes a widget can occupy on the home board. */
  type ArtifactWidgetSizePreset = "S" | "M" | "L" | "W";

  /** Concrete widget size pushed into the iframe. w/h are live pixel dims. */
  interface ArtifactWidgetSize {
    preset: ArtifactWidgetSizePreset;
    cols: 1 | 2 | 4;
    rows: 1 | 2;
    w: number;
    h: number;
  }

  /** Snapshot of one declared data entry (manifest.json "state" key). */
  interface ArtifactEntrySnapshot {
    data: unknown;
    status: "idle" | "refreshing" | "error";
    /** Host-stamped clock: when this entry's data last landed. */
    lastRefreshedAt: number | null;
    error: string | null;
  }

  interface ArtifactSDK {
    params: Record<string, unknown>;
    /** Stable id of the current app (paired 1:1 with the designer). */
    appId: string;
    /** @deprecated Use appId. Kept for one release for backwards compatibility. */
    instanceId: string;
    defaultModel?: string;
    /**
     * Present only when the iframe is rendering as a widget on the home
     * board. Read this in Widget.tsx to adapt layout to the chosen preset.
     */
    widgetSize?: ArtifactWidgetSize;
    ready(): Promise<void>;
    onRefresh(fn: (info: { at: number }) => void): void;
    onParamsChanged(fn: (params: Record<string, unknown>) => void): void;
    /** Widget-only: cell pixel size changed (preset stays, w/h refresh). */
    onWidgetResize(fn: (size: ArtifactWidgetSize | undefined) => void): void;
    /**
     * Cross-iframe state sync. Fires when a sibling frame for the SAME app
     * (e.g. the full app, while this is the widget — or vice versa) writes
     * a state key. The local mirror has already been updated.
     */
    onStateMerged(fn: (key: string, value: unknown) => void): void;
    /**
     * Calls the LLM. Pass webSearch:true to force the LLM to search the live web
     * and return real data. Without webSearch, the LLM generates synthetic data
     * from its training knowledge — fine for prose or structure, NOT for facts.
     *
     * Durability: a query runs server-side and survives the user leaving the
     * app mid-flight (tab close / phone sleep). The awaited promise may not
     * resolve if the iframe is torn down first — to reliably render a result
     * after the user returns, render from onQueryResult and persist it with
     * state.set. See onQueryResult.
     */
    query(prompt: string, opts?: ArtifactQueryOpts): Promise<ArtifactQueryResult>;
    /**
     * Fires when a query result becomes available to the host for this app —
     * both a fresh query() completion AND a run RECOVERED from a prior mount
     * that was interrupted before it finished. Register this synchronously in
     * your first useEffect; the SDK replays a recovered result on mount so a
     * query kicked off before the user left re-renders when they return.
     *
     * The handler MAY fire more than once for the same query (fresh + replay),
     * so make it idempotent — setData(result), never append. Persist the
     * result with state.set inside the handler for an instant first paint on
     * the next load.
     */
    onQueryResult(
      fn: (info: { prompt: string; opts?: ArtifactQueryOpts; result: ArtifactQueryResult }) => void
    ): void;
    /** Direct HTTP fetch via server proxy. Use for real external API endpoints. */
    fetch(url: string, init?: ArtifactFetchInit): Promise<ArtifactFetchResult>;
    /**
     * Persistent KV scoped to this app. Survives reloads, code edits, version
     * reverts, and host migrations. By design there is no delete or clear:
     * state is additive and forward-compatible. Read defensively when the
     * shape of a stored value evolves; merge new fields with read-merge-write.
     */
    state: {
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown): Promise<true>;
    };
    /**
     * Declared data (SDK v2) — THE way to handle durable fetched data.
     * Declare each dataset once in manifest.json under "state" (schema,
     * identity keys, merge policy, source prompt + refresh triggers) and the
     * HOST does everything else: runs the query (Refresh button, refresh(),
     * and the declared cron), validates against the schema, dedupes by
     * identity, persists, and syncs every surface (widget, app, devices).
     * Render with useArtifact from "@artifact/ui". Do NOT hand-wire
     * query/schedule/state persistence for a declared entry.
     */
    entries: {
      get(key: string): Promise<ArtifactEntrySnapshot>;
      /** Fires immediately with the current snapshot, then on every change
       *  from ANY frame. Snapshots are values, not events — duplicate
       *  deliveries are unobservable, so no idempotency care is needed. */
      watch(key: string, fn: (snap: ArtifactEntrySnapshot) => void): () => void;
      /** Write a user-owned entry (kind "value", or a collection you curate). */
      update(key: string, value: unknown): Promise<true>;
      /** Run the entry's declared source now. Rate-limited host-side. */
      refresh(key: string): Promise<ArtifactEntrySnapshot>;
    };
    /**
     * Durable query helper — the "kick off a query, leave, come back, still see
     * the result" pattern in one call. Restores the last result from state[key]
     * for instant first paint, repaints from fresh AND recovered completions,
     * persists every result, and stays idempotent. Prefer useArtifactTask from
     * "@artifact/ui" in React.
     */
    task(
      key: string,
      prompt: string,
      opts?: ArtifactQueryOpts
    ): {
      get(): { data: unknown; loading: boolean; error: string | null };
      subscribe(
        cb: (snap: { data: unknown; loading: boolean; error: string | null }) => void
      ): () => void;
      refresh(): void;
    };
  }

  interface Window {
    artifact: ArtifactSDK;
  }
}

// Widget design system — primitives + hooks shared across all artifacts.
// Importing these (instead of hand-rolling inline styles) keeps widgets
// visually + behaviorally consistent. Tokens are also available as CSS vars
// (--w-ink, --w-accent, --w-accent-2, --w-ink-soft, --w-rule, --w-space-*,
// --w-text-*) inside every widget iframe.
declare module "@artifact/ui" {
  import type { ReactNode, CSSProperties } from "react";
  export type WidgetPreset = "S" | "M" | "L" | "W";

  /** Current widget size preset; updates on resize. "M" outside widget mode. */
  export function useWidgetSize(): WidgetPreset;
  /**
   * Observe a declared data entry (manifest.json "state" key) — THE hook for
   * source-backed data. The host fetches, validates, merges, persists, and
   * stamps lastRefreshedAt; this hook only renders. Same data in App.tsx and
   * Widget.tsx with zero wiring.
   */
  export function useArtifact<T = unknown>(key: string): {
    data: T | null;
    status: "idle" | "refreshing" | "error";
    lastRefreshedAt: number | null;
    error: string | null;
    refresh: () => void;
  };
  /** Read/write a declared "value" entry (user-owned UI state), cross-frame synced. */
  export function useArtifactValue<T>(
    key: string,
    initial: T
  ): [T, (next: T | ((prev: T) => T)) => void];
  /** Persistent, cross-frame-synced state with a useState-like API. */
  export function useArtifactState<T>(
    key: string,
    initial: T
  ): [T, (next: T | ((prev: T) => T)) => void];
  /** Durable query as a hook: { data, loading, error, refresh }. */
  export function useArtifactTask<T = unknown>(
    key: string,
    prompt: string,
    opts?: ArtifactQueryOpts
  ): { data: T | undefined; loading: boolean; error: string | null; refresh: () => void };

  /** Root wrapper: applies tokens + shares the preset with children. */
  export function WidgetShell(props: { children?: ReactNode; padded?: boolean; style?: CSSProperties }): JSX.Element;
  /** Big-number + caption — the canonical glanceable unit. Scales with size. */
  export function Stat(props: { value: ReactNode; label?: ReactNode; sub?: ReactNode; accent?: boolean; style?: CSSProperties }): JSX.Element;
  export function Label(props: { children?: ReactNode; style?: CSSProperties }): JSX.Element;
  export function Row(props: { children?: ReactNode; justify?: string; style?: CSSProperties }): JSX.Element;
  export function List(props: { children?: ReactNode; style?: CSSProperties }): JSX.Element;
  export function Pill(props: { children?: ReactNode; tone?: "neutral" | "accent" | "forest"; style?: CSSProperties }): JSX.Element;
}

export {};
`,
};

// ---- "Daily web digest" template -----------------------------------------
// A recurring web-search digest: pick a topic, refresh, get a structured list
// of fresh items. Uses a type:"query" schedule (web_search + schema) rather
// than full deep research, so it's cheaper/faster and works without the Fly
// worker. Like all schedules it registers with the cron sweep once the app is
// account-shared; the in-app "Refresh now" works as soon as it's registered.
const DIGEST_TEMPLATE_FILES: ArtifactFiles = {
  "index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Daily digest</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./main.tsx"></script>
</body>
</html>
`,

  "main.tsx": `import { createRoot } from "react-dom/client";
import { App } from "./App";

await window.artifact.ready();
const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
`,

  "App.tsx": `import { useEffect, useState } from "react";

// The shape every refresh must return. The runtime validates the model output
// against this and repairs mismatches, so the list renders consistently.
const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          summary: { type: "string" },
          source: { type: "string" },
        },
        required: ["title"],
      },
    },
  },
  required: ["items"],
};

const DEFAULT_TOPIC = "the latest in AI and large language models";

function promptFor(topic) {
  return (
    "Search the web for the most relevant, recent items about: " + topic + ". " +
    "Return up to 12 items, newest and most important first, each with a title, " +
    "a direct url, a one-sentence summary, and the source name."
  );
}

export function App() {
  const [topic, setTopic] = useState(DEFAULT_TOPIC);
  const [snap, setSnap] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    window.artifact.onScheduleUpdate((s) => setSnap(s));
    window.artifact.scheduled().then((s) => { if (s) setSnap(s); });
    window.artifact.state.get("topic").then((v) => {
      if (typeof v === "string" && v) setTopic(v);
    });
  }, []);

  const status = snap ? snap.status : null;
  useEffect(() => {
    if (status !== "running") return;
    const t = setInterval(() => {
      window.artifact.scheduled().then((s) => { if (s) setSnap(s); });
    }, 4000);
    return () => clearInterval(t);
  }, [status]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await window.artifact.state.set("topic", topic);
      await window.artifact.defineSchedule({
        type: "query",
        cron: "0 13 * * *",
        prompt: promptFor(topic),
        tools: ["web_search"],
        schema: SCHEMA,
      });
      const s = await window.artifact.runSchedule();
      if (s) setSnap(s);
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const running = busy || status === "running";
  const result = snap && snap.result;
  const items = result && Array.isArray(result.items) ? result.items : [];

  return (
    <main className="wrap">
      <header>
        <h1>Daily digest</h1>
        <p className="sub">
          Pick a topic, refresh, and get a structured list of fresh items. It
          re-runs on a daily schedule on its own.
        </p>
      </header>

      <label className="field">
        <span>Topic</span>
        <input value={topic} onChange={(e) => setTopic(e.target.value)} />
      </label>

      <div className="actions">
        <button onClick={run} disabled={running}>
          {running ? "Searching..." : "Refresh now"}
        </button>
        {snap && snap.runAt ? (
          <span className="meta">Last run: {new Date(snap.runAt).toLocaleString()}</span>
        ) : null}
      </div>

      {error ? <div className="err">{error}</div> : null}
      {status === "error" && snap.error ? <div className="err">{snap.error}</div> : null}

      <ul className="feed">
        {items.map((it, i) => (
          <li className="item" key={i}>
            <h2>
              {it.url ? (
                <a href={it.url} target="_blank" rel="noreferrer">{it.title}</a>
              ) : (
                it.title
              )}
            </h2>
            {it.summary ? <p className="sum">{it.summary}</p> : null}
            {it.source ? <span className="src">{it.source}</span> : null}
          </li>
        ))}
      </ul>

      {!items.length && status === "complete" ? (
        <p className="sub">Nothing came back. Try a different topic.</p>
      ) : null}
    </main>
  );
}
`,

  "styles.css": `:root { color-scheme: dark; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  background: radial-gradient(ellipse at top, #101b18, #07080d 60%);
  color: #e8e9f0;
  min-height: 100vh;
}
.wrap { max-width: 44rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
header h1 {
  margin: 0 0 0.25rem;
  font-size: 1.5rem;
  background: linear-gradient(135deg, #34d399, #60a5fa);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.sub { margin: 0; color: rgba(255,255,255,0.55); font-size: 0.85rem; }
.field { display: block; margin: 1.5rem 0 0.75rem; }
.field span { display: block; font-size: 0.75rem; color: rgba(255,255,255,0.55); margin-bottom: 0.35rem; }
input {
  width: 100%; box-sizing: border-box;
  background: rgba(255,255,255,0.05); color: inherit;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 0.6rem;
  padding: 0.55rem 0.75rem; font: inherit;
}
.actions { display: flex; align-items: center; gap: 0.85rem; flex-wrap: wrap; }
button {
  background: linear-gradient(135deg, #059669, #2563eb); color: white;
  border: 0; border-radius: 0.6rem; padding: 0.55rem 1.1rem;
  font: inherit; font-weight: 600; cursor: pointer;
}
button:disabled { opacity: 0.6; cursor: default; }
.meta { font-size: 0.75rem; color: rgba(255,255,255,0.5); }
.err {
  margin-top: 0.9rem; padding: 0.6rem 0.75rem; border-radius: 0.5rem;
  background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.3);
  color: #fca5a5; font-size: 0.8rem;
}
.feed { list-style: none; margin: 1.25rem 0 0; padding: 0; display: grid; gap: 0.7rem; }
.item {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.09);
  border-radius: 0.8rem; padding: 0.8rem 1rem;
}
.item h2 { margin: 0 0 0.25rem; font-size: 1rem; }
.sum { margin: 0 0 0.4rem; font-size: 0.85rem; color: rgba(255,255,255,0.7); line-height: 1.45; }
.src { font-size: 0.72rem; color: rgba(255,255,255,0.45); }
a { color: #93c5fd; }
`,

  "manifest.json": `{
  "name": "Daily digest",
  "description": "Pick a topic and get a recurring, structured digest of fresh web items.",
  "params": []
}
`,
};

// ---- "Tracker / list" template -------------------------------------------
// A local CRUD list persisted entirely in artifact.state (no network), so it
// always builds and runs. Ships with a Widget.tsx that reads the same state key
// and shows the live open-item count on the home board — the canonical
// app → widget → board experience in one known-good scaffold.
const TRACKER_TEMPLATE_FILES: ArtifactFiles = {
  "index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Tracker</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./main.tsx"></script>
</body>
</html>
`,

  "main.tsx": `import { createRoot } from "react-dom/client";
import { App } from "./App";

await window.artifact.ready();
const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
`,

  "App.tsx": `import { useState } from "react";
import { useArtifactState } from "@artifact/ui";

// One row in the list. Everything is persisted to artifact.state under "items",
// which survives reloads, code edits, and version reverts — and syncs to the
// home widget live. Read defensively (Array.isArray) so an old/empty shape
// never crashes the render.
type Item = { id: string; title: string; status: "todo" | "doing" | "done"; note: string };

const STATUSES: Item["status"][] = ["todo", "doing", "done"];
const STATUS_LABEL: Record<Item["status"], string> = {
  todo: "To do",
  doing: "In progress",
  done: "Done",
};

export function App() {
  const [items, setItems] = useArtifactState<Item[]>("items", []);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");

  const list = Array.isArray(items) ? items : [];
  const open = list.filter((it) => it.status !== "done").length;

  function add() {
    const t = title.trim();
    if (!t) return;
    const item: Item = {
      id: Math.random().toString(36).slice(2),
      title: t,
      status: "todo",
      note: note.trim(),
    };
    setItems((prev) => [item, ...(Array.isArray(prev) ? prev : [])]);
    setTitle("");
    setNote("");
  }

  function cycle(id: string) {
    setItems((prev) =>
      (Array.isArray(prev) ? prev : []).map((it) => {
        if (it.id !== id) return it;
        const next = STATUSES[(STATUSES.indexOf(it.status) + 1) % STATUSES.length];
        return { ...it, status: next };
      })
    );
  }

  function remove(id: string) {
    setItems((prev) => (Array.isArray(prev) ? prev : []).filter((it) => it.id !== id));
  }

  return (
    <main className="wrap">
      <header>
        <h1>Tracker</h1>
        <p className="sub">
          {open} open · {list.length} total. Everything saves automatically.
        </p>
      </header>

      <div className="add">
        <input
          value={title}
          placeholder="Add an item…"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <input
          value={note}
          placeholder="Note (optional)"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button onClick={add}>Add</button>
      </div>

      <ul className="list">
        {list.map((it) => (
          <li className={"item " + it.status} key={it.id}>
            <button className="status" onClick={() => cycle(it.id)} title="Click to change status">
              {STATUS_LABEL[it.status]}
            </button>
            <div className="body">
              <div className="title">{it.title}</div>
              {it.note ? <div className="note">{it.note}</div> : null}
            </div>
            <button className="del" onClick={() => remove(it.id)} aria-label="Delete">
              ×
            </button>
          </li>
        ))}
      </ul>

      {list.length === 0 ? (
        <p className="empty">Nothing yet. Add your first item above.</p>
      ) : null}
    </main>
  );
}
`,

  "Widget.tsx": `import { WidgetShell, Stat, Label, List, useArtifactState, useWidgetSize } from "@artifact/ui";

type Item = { id: string; title: string; status: string; note?: string };

// Widgets only READ state (never fetch). This mirrors the app's "items" key, so
// adding/completing an item in the app updates the count here within ~50ms.
export default function Widget() {
  const [items] = useArtifactState<Item[]>("items", []);
  const size = useWidgetSize();
  const list = Array.isArray(items) ? items : [];
  const open = list.filter((it) => it && it.status !== "done");

  if (open.length === 0) {
    return (
      <WidgetShell>
        <Stat value={0} label="open items" />
        <Label>All clear</Label>
      </WidgetShell>
    );
  }

  return (
    <WidgetShell>
      <Stat value={open.length} label={open.length === 1 ? "open item" : "open items"} />
      {size !== "S" ? (
        <List>
          {open.slice(0, size === "L" ? 6 : 3).map((it) => (
            <li key={it.id}>{it.title}</li>
          ))}
        </List>
      ) : null}
    </WidgetShell>
  );
}
`,

  "styles.css": `:root { color-scheme: dark; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  background: radial-gradient(ellipse at top, #15172b, #07080d 60%);
  color: #e8e9f0;
  min-height: 100vh;
}
.wrap { max-width: 40rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
header h1 {
  margin: 0 0 0.25rem;
  font-size: 1.5rem;
  background: linear-gradient(135deg, #a78bfa, #60a5fa);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.sub { margin: 0; color: rgba(255,255,255,0.55); font-size: 0.85rem; }
.add { display: flex; gap: 0.5rem; margin: 1.5rem 0 1rem; flex-wrap: wrap; }
.add input {
  flex: 1 1 8rem; min-width: 0; box-sizing: border-box;
  background: rgba(255,255,255,0.05); color: inherit;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 0.6rem;
  padding: 0.55rem 0.75rem; font: inherit;
}
button {
  background: linear-gradient(135deg, #7c3aed, #2563eb); color: white;
  border: 0; border-radius: 0.6rem; padding: 0.55rem 1.1rem;
  font: inherit; font-weight: 600; cursor: pointer;
}
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.55rem; }
.item {
  display: flex; align-items: center; gap: 0.75rem;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.09);
  border-radius: 0.8rem; padding: 0.6rem 0.8rem;
}
.item.done .title { text-decoration: line-through; color: rgba(255,255,255,0.45); }
.item .status {
  flex: 0 0 auto; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em;
  background: rgba(255,255,255,0.07); padding: 0.3rem 0.55rem; border-radius: 999px;
  font-weight: 700;
}
.item.doing .status { background: rgba(96,165,250,0.18); color: #93c5fd; }
.item.done .status { background: rgba(52,211,153,0.16); color: #6ee7b7; }
.item .body { flex: 1 1 auto; min-width: 0; }
.item .title { font-size: 0.95rem; }
.item .note { font-size: 0.78rem; color: rgba(255,255,255,0.5); margin-top: 0.1rem; }
.item .del {
  flex: 0 0 auto; background: transparent; color: rgba(255,255,255,0.4);
  border: 0; font-size: 1.2rem; line-height: 1; padding: 0 0.25rem; cursor: pointer;
}
.item .del:hover { color: #fca5a5; }
.empty { margin-top: 2rem; text-align: center; color: rgba(255,255,255,0.4); font-size: 0.85rem; }
`,

  "manifest.json": `{
  "name": "Tracker",
  "description": "Add items, change their status, and see the live open count on a home widget.",
  "params": [],
  "widget": { "entry": "Widget.tsx", "defaultSize": "M", "supportedSizes": ["S", "M", "L", "W"] }
}
`,
};

// ---- "Live dashboard" template --------------------------------------------
// Metric cards from a live web search on a topic. Uses the durable query pattern
// (render from onQueryResult, persist with state.set, idempotent) so a refresh
// survives a tab close. The widget reads the cached result from state — no fetch.
const DASHBOARD_TEMPLATE_FILES: ArtifactFiles = {
  "index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Dashboard</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./main.tsx"></script>
</body>
</html>
`,

  "main.tsx": `import { createRoot } from "react-dom/client";
import { App } from "./App";

await window.artifact.ready();
const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
`,

  "App.tsx": `import { useEffect, useState } from "react";

// The shape every refresh returns. The runtime validates the model's output
// against this and repairs mismatches, so the cards render consistently.
const SCHEMA = {
  type: "object",
  properties: {
    metrics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          value: { type: "string" },
          detail: { type: "string" },
        },
        required: ["label", "value"],
      },
    },
    summary: { type: "string" },
  },
  required: ["metrics"],
};

const DEFAULT_TOPIC = "The US housing market right now";

function promptFor(topic) {
  return (
    "Research the live web and report the current state of: " + topic + ". " +
    "Return 4-6 key metrics, each with a short label, a concrete current value " +
    "(a number, %, price, or date), and a one-line detail with context. Also give " +
    "a one-sentence overall summary. Use the most recent real data you can find."
  );
}

export function App() {
  const [topic, setTopic] = useState(DEFAULT_TOPIC);
  const [snap, setSnap] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Mirror the latest scheduled result into state so the home widget (which
  // only READS state, never fetches) reflects scheduled runs live.
  function persist(s) {
    if (s && s.result) window.artifact.state.set("dashboard", s.result);
  }

  useEffect(() => {
    window.artifact.onScheduleUpdate((s) => { setSnap(s); persist(s); });
    window.artifact.scheduled().then((s) => { if (s) { setSnap(s); persist(s); } });
    window.artifact.state.get("topic").then((v) => {
      if (typeof v === "string" && v) setTopic(v);
    });
  }, []);

  // While a run is in flight, poll the server snapshot so the cards fill in
  // when it completes (the run continues even if you leave and come back).
  const status = snap ? snap.status : null;
  useEffect(() => {
    if (status !== "running") return;
    const t = setInterval(() => {
      window.artifact.scheduled().then((s) => { if (s) { setSnap(s); persist(s); } });
    }, 4000);
    return () => clearInterval(t);
  }, [status]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await window.artifact.state.set("topic", topic);
      // Defining the schedule registers it with the cron sweep AND the Control
      // Center, so it auto-refreshes daily and can be paused/run from Manage.
      await window.artifact.defineSchedule({
        type: "query",
        cron: "0 9 * * *",
        prompt: promptFor(topic),
        tools: ["web_search"],
        schema: SCHEMA,
      });
      const s = await window.artifact.runSchedule();
      if (s) { setSnap(s); persist(s); }
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const running = busy || status === "running";
  const result = snap && snap.result;
  const metrics = result && Array.isArray(result.metrics) ? result.metrics : [];

  return (
    <main className="wrap">
      <header>
        <h1>Dashboard</h1>
        <p className="sub">
          Live metric cards from the web. Refreshes daily on its own - edit the
          topic and refresh anytime.
        </p>
      </header>

      <label className="field">
        <span>Topic</span>
        <input value={topic} onChange={(e) => setTopic(e.target.value)} />
      </label>

      <div className="actions">
        <button onClick={run} disabled={running}>
          {running ? "Researching…" : "Refresh now"}
        </button>
        {snap && snap.runAt ? (
          <span className="meta">Last run: {new Date(snap.runAt).toLocaleString()}</span>
        ) : null}
      </div>

      {error ? <div className="err">{error}</div> : null}
      {status === "error" && snap.error ? <div className="err">{snap.error}</div> : null}
      {result && result.summary ? <p className="summary">{result.summary}</p> : null}

      <div className="cards">
        {metrics.map((m, i) => (
          <div className="card" key={i}>
            <div className="value">{m.value}</div>
            <div className="label">{m.label}</div>
            {m.detail ? <div className="detail">{m.detail}</div> : null}
          </div>
        ))}
      </div>

      {!metrics.length && status === "complete" ? (
        <p className="empty">Nothing came back. Try a different topic.</p>
      ) : !metrics.length && !running ? (
        <p className="empty">No data yet. Set a topic and hit Refresh now.</p>
      ) : null}
    </main>
  );
}
`,

  "Widget.tsx": `import { WidgetShell, Stat, Label, Row, useArtifactState, useWidgetSize } from "@artifact/ui";

type Metric = { label: string; value: string; detail?: string };
type Data = { metrics?: Metric[]; summary?: string };

// Widgets only READ state. The full app persists its query result under
// "dashboard"; this reflects it live and never fetches on its own.
export default function Widget() {
  const [data] = useArtifactState<Data | null>("dashboard", null);
  const size = useWidgetSize();
  const metrics = data && Array.isArray(data.metrics) ? data.metrics : [];

  if (metrics.length === 0) {
    return (
      <WidgetShell>
        <Label>No data yet - open to refresh</Label>
      </WidgetShell>
    );
  }

  const top = metrics[0];
  return (
    <WidgetShell>
      <Stat value={top.value} label={top.label} />
      {size !== "S" ? (
        <div style={{ marginTop: "var(--w-space-3)", display: "grid", gap: "var(--w-space-1)" }}>
          {metrics.slice(1, size === "L" ? 5 : 3).map((m, i) => (
            <Row key={i} justify="space-between">
              <Label>{m.label}</Label>
              <span style={{ color: "var(--w-ink)" }}>{m.value}</span>
            </Row>
          ))}
        </div>
      ) : null}
    </WidgetShell>
  );
}
`,

  "styles.css": `:root { color-scheme: dark; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  background: radial-gradient(ellipse at top, #0f1b22, #07080d 60%);
  color: #e8e9f0;
  min-height: 100vh;
}
.wrap { max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
header h1 {
  margin: 0 0 0.25rem;
  font-size: 1.5rem;
  background: linear-gradient(135deg, #22d3ee, #60a5fa);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.sub { margin: 0; color: rgba(255,255,255,0.55); font-size: 0.85rem; }
.field { display: block; margin: 1.5rem 0 0.75rem; }
.field span { display: block; font-size: 0.75rem; color: rgba(255,255,255,0.55); margin-bottom: 0.35rem; }
input {
  width: 100%; box-sizing: border-box;
  background: rgba(255,255,255,0.05); color: inherit;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 0.6rem;
  padding: 0.55rem 0.75rem; font: inherit;
}
.actions { display: flex; align-items: center; gap: 0.85rem; flex-wrap: wrap; }
button {
  background: linear-gradient(135deg, #0891b2, #2563eb); color: white;
  border: 0; border-radius: 0.6rem; padding: 0.55rem 1.1rem;
  font: inherit; font-weight: 600; cursor: pointer;
}
button:disabled { opacity: 0.6; cursor: default; }
.err {
  margin-top: 0.9rem; padding: 0.6rem 0.75rem; border-radius: 0.5rem;
  background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.3);
  color: #fca5a5; font-size: 0.8rem;
}
.summary { margin: 1.1rem 0 0; font-size: 0.9rem; color: rgba(255,255,255,0.78); line-height: 1.5; }
.cards {
  margin-top: 1.25rem; display: grid; gap: 0.7rem;
  grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
}
.card {
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.09);
  border-radius: 0.9rem; padding: 0.9rem 1rem;
}
.card .value {
  font-size: 1.4rem; font-weight: 700;
  background: linear-gradient(135deg, #67e8f9, #93c5fd);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.card .label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; color: rgba(255,255,255,0.6); margin-top: 0.25rem; }
.card .detail { font-size: 0.8rem; color: rgba(255,255,255,0.55); margin-top: 0.35rem; line-height: 1.4; }
.empty { margin-top: 2rem; text-align: center; color: rgba(255,255,255,0.4); font-size: 0.85rem; }
`,

  "manifest.json": `{
  "name": "Dashboard",
  "description": "Live metric cards from a web search on a topic, with a refreshable home widget.",
  "params": [],
  "widget": { "entry": "Widget.tsx", "defaultSize": "M", "supportedSizes": ["S", "M", "L", "W"] }
}
`,
};

// ---- "Upcoming events" template -------------------------------------------
// A recurring web search for DATED events that ACCUMULATES instead of replacing
// its list. Each daily scan is merged into the saved events by a stable key, so
// the calendar grows over time; past events are pruned so it stays forward-
// looking. This is the rule the digest/dashboard templates lack - they render
// only the latest run's result, so their list resets on every scan. Styled with
// the host's theme-aware --artifact-* tokens (light + dark), not a hardcoded
// palette.
const EVENTS_TEMPLATE_FILES: ArtifactFiles = {
  "index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Upcoming events</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./main.tsx"></script>
</body>
</html>
`,

  "main.tsx": `import { createRoot } from "react-dom/client";
import { App } from "./App";

await window.artifact.ready();
const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
`,

  "App.tsx": `import { useEffect, useRef, useState } from "react";

// The shape every scan must return. The runtime validates the model output
// against this and repairs mismatches, so the calendar renders consistently.
const SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          summary: { type: "string" },
          location: { type: "string" },
          startDate: { type: "string", description: "ISO date the event starts, YYYY-MM-DD" },
          endDate: { type: "string", description: "ISO date the event ends; omit for single-day" },
          category: { type: "string" },
        },
        required: ["title", "startDate"],
      },
    },
  },
  required: ["events"],
};

const DEFAULT_TOPIC = "upcoming community and cultural events near Chattanooga, TN";

function promptFor(topic) {
  return (
    "Find upcoming events matching: " + topic + ". " +
    "Only include events dated today or later - never past events. " +
    "Return up to 20 events, each with a title, a direct url, a one-sentence summary, " +
    "the location, the start date and (if multi-day) the end date as ISO 8601 (YYYY-MM-DD), " +
    "and a short category. Prefer specific, real, dated events over generic 'things to do' pages."
  );
}

// ---------------------------------------------------------------------------
// THE RULE: this template ACCUMULATES. It never replaces its list.
// Every scheduled run is MERGED into the saved events by a stable key, so the
// calendar grows over time instead of resetting. Past events (ended before
// today) are pruned so it stays a forward-looking agenda, and everything is
// kept sorted by start date.
// ---------------------------------------------------------------------------

function keyFor(ev) {
  // A stable identity for one event: prefer its url, else title + start date.
  if (ev && typeof ev.url === "string" && ev.url.trim()) return "u:" + ev.url.trim().toLowerCase();
  return "t:" + String((ev && ev.title) || "").trim().toLowerCase() + "|" + String((ev && ev.startDate) || "");
}

function startMs(ev) {
  var t = Date.parse((ev && ev.startDate) || "");
  return isNaN(t) ? 0 : t;
}

function endMs(ev) {
  var t = Date.parse((ev && (ev.endDate || ev.startDate)) || "");
  return isNaN(t) ? 0 : t;
}

function mergeEvents(prev, incoming) {
  var byKey = new Map();
  for (var i = 0; i < prev.length; i++) byKey.set(keyFor(prev[i]), prev[i]);
  for (var j = 0; j < incoming.length; j++) {
    var ev = incoming[j];
    if (!ev || !ev.title || !ev.startDate) continue;
    var k = keyFor(ev);
    var existing = byKey.get(k);
    // Merge fields on a re-scan but keep the first-seen addedAt stable.
    byKey.set(k, existing
      ? Object.assign({}, existing, ev, { addedAt: existing.addedAt })
      : Object.assign({}, ev, { addedAt: Date.now() }));
  }
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var floor = today.getTime();
  var out = [];
  byKey.forEach(function (ev) {
    if (endMs(ev) === 0 || endMs(ev) >= floor) out.push(ev);
  });
  out.sort(function (a, b) { return startMs(a) - startMs(b); });
  return out;
}

function fmtDay(iso) {
  var t = Date.parse(iso);
  if (isNaN(t)) return "Date TBD";
  return new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function fmtRange(ev) {
  var s = fmtDay(ev.startDate);
  if (ev.endDate && ev.endDate !== ev.startDate) return s + " - " + fmtDay(ev.endDate);
  return s;
}

// Bucket events under a friendly date header for a calendar/agenda feel.
function groupByDay(events) {
  var groups = [];
  var index = {};
  for (var i = 0; i < events.length; i++) {
    var label = fmtDay(events[i].startDate);
    if (index[label] === undefined) { index[label] = groups.length; groups.push({ label: label, items: [] }); }
    groups[index[label]].items.push(events[i]);
  }
  return groups;
}

export function App() {
  const [topic, setTopic] = useState(DEFAULT_TOPIC);
  const [events, setEvents] = useState([]);
  const [snap, setSnap] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Holds the freshest accumulated list so merges from schedule updates and the
  // initial state load compose instead of clobbering each other.
  const eventsRef = useRef([]);

  // Merge a run's events into the saved, accumulated list, then persist.
  function absorb(result) {
    var incoming = result && Array.isArray(result.events) ? result.events : [];
    if (!incoming.length) return;
    var next = mergeEvents(eventsRef.current, incoming);
    eventsRef.current = next;
    setEvents(next);
    window.artifact.state.set("events", next);
  }

  useEffect(() => {
    // Restore the accumulated calendar first, then layer any run results on top.
    window.artifact.state.get("events").then((saved) => {
      if (Array.isArray(saved) && saved.length) {
        eventsRef.current = mergeEvents(eventsRef.current, saved);
        setEvents(eventsRef.current);
      }
    });
    window.artifact.state.get("topic").then((v) => {
      if (typeof v === "string" && v) setTopic(v);
    });
    // A scheduled (cron) run landing while the app is open merges in live.
    window.artifact.onScheduleUpdate((s) => {
      setSnap(s);
      if (s && s.status === "complete" && s.result) absorb(s.result);
    });
    window.artifact.scheduled().then((s) => {
      if (s) { setSnap(s); if (s.status === "complete" && s.result) absorb(s.result); }
    });
  }, []);

  const status = snap ? snap.status : null;
  useEffect(() => {
    if (status !== "running") return;
    const t = setInterval(() => {
      window.artifact.scheduled().then((s) => { if (s) setSnap(s); });
    }, 4000);
    return () => clearInterval(t);
  }, [status]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await window.artifact.state.set("topic", topic);
      await window.artifact.defineSchedule({
        type: "query",
        cron: "0 13 * * *",
        prompt: promptFor(topic),
        tools: ["web_search"],
        schema: SCHEMA,
      });
      const s = await window.artifact.runSchedule();
      if (s) { setSnap(s); if (s.status === "complete" && s.result) absorb(s.result); }
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const running = busy || status === "running";
  const groups = groupByDay(events);

  return (
    <main className="wrap">
      <header>
        <h1>Upcoming events</h1>
        <p className="sub">
          A running calendar of upcoming events on a topic. Each daily scan is
          merged in - new events are added, duplicates ignored, and past events
          drop off. The list never resets.
        </p>
      </header>

      <label className="field">
        <span>What events to track</span>
        <input value={topic} onChange={(e) => setTopic(e.target.value)} />
      </label>

      <div className="actions">
        <button onClick={run} disabled={running}>
          {running ? "Scanning..." : "Scan now"}
        </button>
        {snap && snap.runAt ? (
          <span className="meta">Last scan: {new Date(snap.runAt).toLocaleString()}</span>
        ) : null}
      </div>

      {error ? <div className="err">{error}</div> : null}
      {status === "error" && snap.error ? <div className="err">{snap.error}</div> : null}

      {events.length ? (
        <p className="count">{events.length} upcoming {events.length === 1 ? "event" : "events"}</p>
      ) : null}

      <div className="agenda">
        {groups.map((g, gi) => (
          <section className="group" key={gi}>
            <h2 className="day">{g.label}</h2>
            <ul className="events">
              {g.items.map((ev, i) => (
                <li className="event" key={i}>
                  <div className="event-head">
                    <h3 className="title">
                      {ev.url ? (
                        <a href={ev.url} target="_blank" rel="noreferrer">{ev.title}</a>
                      ) : ev.title}
                    </h3>
                    {ev.category ? <span className="tag">{ev.category}</span> : null}
                  </div>
                  <div className="when">
                    {fmtRange(ev)}{ev.location ? " · " + ev.location : ""}
                  </div>
                  {ev.summary ? <p className="sum">{ev.summary}</p> : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {!events.length && status === "complete" ? (
        <p className="sub">No upcoming events found. Try a broader topic.</p>
      ) : null}
      {!events.length && status !== "complete" ? (
        <p className="empty">Scan to start building your calendar.</p>
      ) : null}
    </main>
  );
}
`,

  "Widget.tsx": `import { WidgetShell, Label, List, useArtifactState, useWidgetSize } from "@artifact/ui";

type EventItem = { title: string; startDate?: string; endDate?: string; location?: string };

function fmtDay(iso?: string) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Widgets only READ state. The full app persists the accumulated calendar under
// "events"; this reflects it live and never fetches on its own.
export default function Widget() {
  const [events] = useArtifactState<EventItem[]>("events", []);
  const size = useWidgetSize();
  const list = Array.isArray(events) ? events : [];

  if (!list.length) {
    return (
      <WidgetShell>
        <Label>No events yet - open to scan</Label>
      </WidgetShell>
    );
  }

  const next = list[0];
  const rest = list.slice(1, size === "L" ? 5 : size === "S" ? 1 : 3);

  return (
    <WidgetShell>
      <Label>Next up</Label>
      <div style={{ fontFamily: "var(--w-font-display)", fontSize: "var(--w-text-lg)", color: "var(--w-ink)", marginTop: "var(--w-space-1)", lineHeight: 1.2 }}>
        {next.title}
      </div>
      <div style={{ fontSize: "var(--w-text-sm)", color: "var(--w-accent)", marginTop: "var(--w-space-1)", fontVariantNumeric: "tabular-nums" }}>
        {fmtDay(next.startDate)}{next.location ? " · " + next.location : ""}
      </div>
      {size !== "S" && rest.length ? (
        <List style={{ marginTop: "var(--w-space-3)" }}>
          {rest.map((ev, i) => (
            <li key={i}>
              <span style={{ color: "var(--w-accent)", fontVariantNumeric: "tabular-nums", minWidth: "3.4em" }}>{fmtDay(ev.startDate)}</span>
              <span style={{ color: "var(--w-ink)" }}>{ev.title}</span>
            </li>
          ))}
        </List>
      ) : null}
      <div style={{ fontSize: "var(--w-text-xs)", color: "var(--w-ink-soft)", marginTop: "var(--w-space-3)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
        {list.length} upcoming
      </div>
    </WidgetShell>
  );
}
`,

  "styles.css": `/* No hardcoded palette: the host injects theme-aware --artifact-* tokens plus a
   Soft Paper baseline (page background, ink text, form controls) that flips with
   light/dark. This template styles FROM those tokens so it looks right in both. */
.wrap { max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
header h1 {
  margin: 0 0 0.35rem;
  font-size: 1.7rem;
  font-family: var(--artifact-font-display);
  color: var(--artifact-ink);
  letter-spacing: -0.01em;
}
.sub { margin: 0; color: var(--artifact-ink-soft); font-size: 0.9rem; line-height: 1.5; }
.field { display: block; margin: 1.5rem 0 0.75rem; }
.field span {
  display: block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em;
  font-weight: 600; color: var(--artifact-ink-soft); margin-bottom: 0.4rem;
}
input {
  width: 100%; box-sizing: border-box;
  background: var(--artifact-surface); color: var(--artifact-ink);
  border: 1px solid var(--artifact-border); border-radius: 0.6rem;
  padding: 0.6rem 0.75rem; font: inherit;
}
input:focus-visible {
  outline: 2px solid color-mix(in oklab, var(--artifact-accent) 55%, transparent);
  outline-offset: 2px; border-color: var(--artifact-accent);
}
.actions { display: flex; align-items: center; gap: 0.85rem; flex-wrap: wrap; }
button {
  background: var(--artifact-accent); color: var(--artifact-surface);
  border: 0; border-radius: 0.6rem; padding: 0.6rem 1.15rem;
  font: inherit; font-weight: 600; cursor: pointer;
}
button:disabled { opacity: 0.55; cursor: default; }
.meta { font-size: 0.78rem; color: var(--artifact-ink-soft); }
.count {
  margin: 1.5rem 0 0.25rem; font-size: 0.72rem; text-transform: uppercase;
  letter-spacing: 0.06em; font-weight: 600; color: var(--artifact-ink-soft);
}
.err {
  margin-top: 0.9rem; padding: 0.6rem 0.75rem; border-radius: 0.5rem;
  background: color-mix(in oklab, var(--artifact-accent) 12%, transparent);
  border: 1px solid color-mix(in oklab, var(--artifact-accent) 35%, transparent);
  color: var(--artifact-accent); font-size: 0.82rem;
}
.agenda { margin-top: 0.5rem; display: grid; gap: 1.5rem; }
.group { display: grid; gap: 0.65rem; }
.day {
  margin: 0; font-size: 0.75rem; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--artifact-accent);
  padding-bottom: 0.35rem; border-bottom: 1px solid var(--artifact-border);
}
.events { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
.event-head { display: flex; align-items: baseline; gap: 0.6rem; justify-content: space-between; }
.title { margin: 0; font-size: 1.02rem; font-weight: 600; line-height: 1.3; }
.title a { color: var(--artifact-accent); text-decoration: none; }
.title a:hover { text-decoration: underline; }
.tag {
  flex: none; font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.05em;
  font-weight: 600; color: var(--artifact-accent-2);
  border: 1px solid color-mix(in oklab, var(--artifact-accent-2) 40%, transparent);
  border-radius: 999px; padding: 0.1rem 0.5rem; white-space: nowrap;
}
.when { margin-top: 0.2rem; font-size: 0.82rem; color: var(--artifact-ink-soft); font-variant-numeric: tabular-nums; }
.sum { margin: 0.35rem 0 0; font-size: 0.88rem; color: var(--artifact-ink); line-height: 1.5; }
.empty { margin-top: 2rem; text-align: center; color: var(--artifact-ink-dim); font-size: 0.88rem; }
`,

  "manifest.json": `{
  "name": "Upcoming events",
  "description": "A recurring web search for dated events that accumulates into a calendar - new events merge in, duplicates are ignored, past events drop off.",
  "params": [],
  "widget": { "entry": "Widget.tsx", "defaultSize": "M", "supportedSizes": ["S", "M", "L", "W"] }
}
`,
};

const BLANK_TEMPLATE_MANIFEST: ArtifactManifest = {
  name: "Untitled",
  description: "A blank artifact, ready to be built.",
  params: [],
};

const TRACKER_TEMPLATE_MANIFEST: ArtifactManifest = {
  name: "Tracker",
  description: "Add items, change their status, and see the live open count on a home widget.",
  params: [],
  widget: { entry: "Widget.tsx", defaultSize: "M", supportedSizes: ["S", "M", "L", "W"] },
};

const DASHBOARD_TEMPLATE_MANIFEST: ArtifactManifest = {
  name: "Dashboard",
  description: "Live metric cards from a web search that refresh daily on a schedule, with a home widget.",
  params: [],
  widget: { entry: "Widget.tsx", defaultSize: "M", supportedSizes: ["S", "M", "L", "W"] },
};

const DIGEST_TEMPLATE_MANIFEST: ArtifactManifest = {
  name: "Daily digest",
  description: "Pick a topic and get a recurring, structured digest of fresh web items.",
  params: [],
};

const EVENTS_TEMPLATE_MANIFEST: ArtifactManifest = {
  name: "Upcoming events",
  description:
    "A recurring web search for dated events that accumulates into a calendar - new events merge in, duplicates are ignored, past events drop off.",
  params: [],
  widget: { entry: "Widget.tsx", defaultSize: "M", supportedSizes: ["S", "M", "L", "W"] },
};

type TemplateScaffold = {
  name: string;
  /** Designer description; left undefined for the blank template. */
  description?: string;
  files: ArtifactFiles;
  manifest: ArtifactManifest;
  entry: string;
  /** Default query model for the paired app. */
  model?: string;
  /** Optional assistant intro seeded into the edit chat so the canvas isn't
   *  blank and the user knows the scaffold is loaded. */
  intro?: string;
};

// Files + metadata for each template id. Add a template by appending here and
// to APP_TEMPLATES in app/lib/app-templates.ts.
const TEMPLATE_SCAFFOLDS: Record<AppTemplateId, TemplateScaffold> = {
  blank: {
    name: "Untitled",
    files: STARTER_FILES,
    manifest: BLANK_TEMPLATE_MANIFEST,
    entry: "main.tsx",
    model: "gemma4:31b",
  },
  digest: {
    name: "Daily digest",
    description: DIGEST_TEMPLATE_MANIFEST.description,
    files: DIGEST_TEMPLATE_FILES,
    manifest: DIGEST_TEMPLATE_MANIFEST,
    entry: "main.tsx",
    intro:
      "Loaded the **Daily digest** template. It runs a recurring web search and " +
      "renders a structured list of fresh items. Tell me the topic and what fields " +
      "you want per item, and I'll adjust the prompt, schema, and UI.",
  },
  tracker: {
    name: "Tracker",
    description: TRACKER_TEMPLATE_MANIFEST.description,
    files: TRACKER_TEMPLATE_FILES,
    manifest: TRACKER_TEMPLATE_MANIFEST,
    entry: "main.tsx",
    intro:
      "Loaded the **Tracker** template - a list you add items to, with statuses and " +
      "a live home widget. Tell me what you're tracking (and any fields you want per " +
      "item) and I'll tailor it.",
  },
  dashboard: {
    name: "Dashboard",
    description: DASHBOARD_TEMPLATE_MANIFEST.description,
    files: DASHBOARD_TEMPLATE_FILES,
    manifest: DASHBOARD_TEMPLATE_MANIFEST,
    entry: "main.tsx",
    intro:
      "Loaded the **Dashboard** template - live metric cards from a web search that " +
      "refresh on a daily schedule, with a home widget. Tell me the topic and which " +
      "metrics matter and I'll tune the query, cadence, and cards.",
  },
  events: {
    name: "Upcoming events",
    description: EVENTS_TEMPLATE_MANIFEST.description,
    files: EVENTS_TEMPLATE_FILES,
    manifest: EVENTS_TEMPLATE_MANIFEST,
    entry: "main.tsx",
    intro:
      "Loaded the **Upcoming events** template - a recurring web search for dated " +
      "events that accumulates into a calendar instead of replacing the list each " +
      "scan (new events merge in, duplicates are ignored, past events drop off), " +
      "with a home widget. Tell me what events to track and where, and I'll tune the " +
      "search, cadence, and layout.",
  },
};

/**
 * Create a designer + paired app + edit chat, seeded from a template scaffold.
 * Defaults to the blank template so existing callers (no argument) are
 * unchanged. The chosen scaffold is just a starting point — the assistant edits
 * it in the chat like any other app.
 */
export async function createDesignerAndChat(
  templateId: AppTemplateId = DEFAULT_TEMPLATE_ID,
  options?: { title?: string }
): Promise<{ designer: StoredDesigner; app: StoredApp; chat: StoredChat }> {
  const tpl = TEMPLATE_SCAFFOLDS[isAppTemplateId(templateId) ? templateId : DEFAULT_TEMPLATE_ID];
  const isBlank = templateId === "blank";
  // An AI-picked title (from the "describe an app" flow) names the app up front
  // so the user isn't staring at "Untitled"/"Tracker" while the assistant works.
  // The scaffold's own manifest.name still drives the built artifact until the
  // assistant rewrites it; this only sets the friendly designer/app/chat label.
  const title = options?.title?.trim();
  const name = title || tpl.name;
  const now = Date.now();
  const id = newId();
  const chatId = newId();
  const designer: StoredDesigner = {
    id,
    name,
    description: tpl.description,
    files: { ...tpl.files },
    entry: tpl.entry,
    manifest: tpl.manifest,
    status: "draft",
    version: 1,
    history: [],
    sourceChatId: chatId,
    createdAt: now,
    updatedAt: now,
  };
  // 1:1 invariant: paired app shares the designer's id.
  const app: StoredApp = {
    id,
    name,
    params: {},
    ...(tpl.model ? { model: tpl.model } : {}),
    state: {},
    createdAt: now,
    updatedAt: now,
  };
  const chat: StoredChat = {
    id: chatId,
    title: title ? `Edit · ${name}` : isBlank ? "New artifact" : `Edit · ${tpl.name}`,
    titleSource: "default",
    target: { kind: "designer", id, mode: "edit" },
    createdAt: now,
    updatedAt: now,
    ...newChatTtl(now),
  };
  await putDesigner(designer);
  await putApp(app);
  await putChat(chat);
  if (tpl.intro) {
    await putMessage({
      id: newId(),
      chatId,
      role: "assistant",
      content: tpl.intro,
      createdAt: now,
    });
  }
  return { designer, app, chat };
}

/**
 * Seed a designer + paired app + edit chat from a single self-contained HTML
 * document. Used by the chat-mode "Convert to App" flow: the assistant produced
 * a visual artifact in a free-form chat, and the user wants to keep iterating
 * on it inside the designer (where the artifact SDK is available).
 *
 * The HTML lands at `index.html` with `entry = "index.html"`, which is the
 * static-HTML shape the build pipeline already supports (see
 * app/chats/[id]/page.tsx onSaveHtml for the existing precedent).
 */
export async function createDesignerAndChatFromHtml(
  html: string,
  summary: string,
  options?: { sourceNoteId?: string; title?: string }
): Promise<{ designer: StoredDesigner; app: StoredApp; chat: StoredChat }> {
  const now = Date.now();
  const id = newId();
  const chatId = newId();
  const files: ArtifactFiles = { "index.html": html };
  const entry = "index.html";
  const parsed = parseManifestFromVfs(files, entry);
  // Chat-mode HTML is told to omit the manifest block (see CHAT_MODE_SYSTEM
  // in app/api/chat/route.ts). Synthesize a minimal manifest using the pinned
  // note's title/summary so the editor doesn't show a bare "Untitled artifact"
  // header for content the user already named.
  const fallbackName =
    options?.title?.trim() ||
    summary.split(/\r?\n/)[0]?.trim().slice(0, 60) ||
    "Untitled artifact";
  const description =
    parsed.manifest?.description ?? (summary.slice(0, 200) || undefined);
  const manifest: ArtifactManifest =
    parsed.manifest ?? { name: fallbackName, description, params: [] };
  const name = manifest.name;
  const designer: StoredDesigner = {
    id,
    name,
    description,
    files,
    entry,
    manifest,
    status: "draft",
    version: 1,
    history: [],
    sourceChatId: chatId,
    sourceNoteId: options?.sourceNoteId,
    createdAt: now,
    updatedAt: now,
  };
  // The artifact already renders on first paint, so stamp lastRunAt now —
  // otherwise the /apps/[id] header reads "Last refreshed never" for a static
  // HTML artifact that has plainly been running since the user opened it.
  const app: StoredApp = {
    id,
    name,
    params: {},
    state: {},
    lastRunAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const chat: StoredChat = {
    id: chatId,
    title: `Edit · ${name}`,
    titleSource: "default",
    target: { kind: "designer", id, mode: "edit" },
    createdAt: now,
    updatedAt: now,
    ...newChatTtl(now),
  };
  await putDesigner(designer);
  await putApp(app);
  await putChat(chat);

  // Seed an intro assistant message so the chat editor doesn't look like a
  // blank "describe a new artifact" canvas. The model receives the artifact
  // body via templateFiles on every turn (vfs-edit mode), so this seed is
  // strictly a UX cue — it tells the user the pin's contents are already
  // loaded and waiting to be edited.
  const intro: StoredMessage = {
    id: newId(),
    chatId,
    role: "assistant",
    content:
      `Loaded **${name}** from your pinned note. Tell me what to change ` +
      `- I'll edit \`index.html\` and the change will save back to the note.`,
    createdAt: now,
  };
  await putMessage(intro);

  return { designer, app, chat };
}

// ---- "Research" app (promote a chat structured-research result) -----------
// A self-contained results table that re-runs the DEEP research engine on
// demand or on a schedule. Unlike the other templates this isn't in the New-app
// picker — it's created by "Save as app" on a chat research result, seeded with
// that result's query/columns/idKeys/schema/records (records flattened to
// { id, ...fields } so the app works in one shape). Refresh routes through
// artifact.query({ research:true }) → the deep engine → merge-by-identity.
const RESEARCH_TEMPLATE_FILES: ArtifactFiles = {
  "index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Research</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./main.tsx"></script>
</body>
</html>
`,

  "main.tsx": `import { createRoot } from "react-dom/client";
import { App } from "./App";

await window.artifact.ready();
const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
`,

  "App.tsx": `import { useEffect, useState } from "react";

// Config + data are seeded into app state when you save a chat research result
// as an app: query, columns, idKeys, schema (records-wrapper), and records
// (flat objects keyed by column, each with an id).

function norm(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 80);
}

function identity(rec, idKeys) {
  const keys = idKeys && idKeys.length ? idKeys : Object.keys(rec || {}).filter((k) => k !== "id");
  return keys.map((k) => norm(rec[k])).filter(Boolean).join("|");
}

function hasContent(rec, columns) {
  return columns.some((c) => {
    const v = rec[c.key];
    return typeof v === "number" || (typeof v === "string" && v.trim().length > 0);
  });
}

// Merge a fresh research run into the existing rows: dedupe by the identity
// columns (filling blanks on a match), drop empty rows, count the new ones.
function mergeRows(existing, incoming, columns, idKeys) {
  const byId = new Map();
  const order = [];
  for (const r of existing) {
    const id = identity(r, idKeys) || r.id;
    if (id && !byId.has(id)) { byId.set(id, r); order.push(id); }
  }
  let added = 0;
  for (const raw of incoming || []) {
    if (!raw || typeof raw !== "object") continue;
    const rec = {};
    for (const c of columns) rec[c.key] = raw[c.key] == null ? "" : raw[c.key];
    if (!hasContent(rec, columns)) continue;
    let id = identity(rec, idKeys);
    if (!id) id = typeof raw.id === "string" && raw.id ? raw.id : "r" + (order.length + 1);
    rec.id = id;
    if (byId.has(id)) {
      const merged = Object.assign({}, byId.get(id));
      for (const c of columns) {
        const v = rec[c.key];
        if (v !== "" && v != null) merged[c.key] = v;
      }
      merged.id = id;
      byId.set(id, merged);
    } else {
      byId.set(id, rec);
      order.push(id);
      added++;
    }
  }
  return { rows: order.map((id) => byId.get(id)), added };
}

const CRONS = { daily: "0 9 * * *", weekly: "0 9 * * 1" };

const RUN_TTL_MS = 60 * 60 * 1000;

function relTime(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

export function App() {
  const [query, setQuery] = useState("");
  const [columns, setColumns] = useState([]);
  const [idKeys, setIdKeys] = useState([]);
  const [schema, setSchema] = useState(null);
  const [rows, setRows] = useState([]);
  const [cadence, setCadence] = useState("manual");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [added, setAdded] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(0);

  // Apply one research result (fresh refresh, RECOVERED query after a reload, or
  // a scheduled run) by read-merge-writing against the persisted records. Going
  // back to state every time avoids the mount race where a recovered result can
  // arrive before the seeded rows/columns finish loading into React state.
  async function applyRecords(incoming) {
    if (!Array.isArray(incoming) || incoming.length === 0) return;
    const a = window.artifact;
    const cols = (await a.state.get("columns")) || [];
    const idk = (await a.state.get("idKeys")) || [];
    const base = (await a.state.get("records")) || [];
    const m = mergeRows(
      Array.isArray(base) ? base : [],
      incoming,
      Array.isArray(cols) ? cols : [],
      Array.isArray(idk) ? idk : []
    );
    const now = Date.now();
    await a.state.set("records", m.rows);
    await a.state.set("recordsUpdatedAt", now);
    await a.state.set("runStartedAt", 0);
    if (Array.isArray(cols) && cols.length) setColumns(cols);
    if (Array.isArray(idk)) setIdKeys(idk);
    setRows(m.rows);
    setAdded(m.added);
    setUpdatedAt(now);
    setRunning(false);
  }

  useEffect(() => {
    const a = window.artifact;
    a.state.get("query").then((v) => { if (typeof v === "string") setQuery(v); });
    a.state.get("columns").then((v) => { if (Array.isArray(v)) setColumns(v); });
    a.state.get("idKeys").then((v) => { if (Array.isArray(v)) setIdKeys(v); });
    a.state.get("schema").then((v) => { if (v) setSchema(v); });
    a.state.get("records").then((v) => { if (Array.isArray(v)) setRows(v); });
    a.state.get("cadence").then((v) => { if (typeof v === "string") setCadence(v); });
    a.state.get("recordsUpdatedAt").then((v) => { if (typeof v === "number") setUpdatedAt(v); });
    // A run kicked before we left is still going on the server — surface it so
    // the user knows their Refresh is in flight even after a reload.
    a.state.get("runStartedAt").then((v) => {
      if (typeof v === "number" && v > 0 && Date.now() - v < RUN_TTL_MS) setRunning(true);
    });
    // Fresh AND recovered query results both land here.
    a.onQueryResult((ev) => {
      const r = ev && ev.result ? ev.result : {};
      const json = r.json;
      const incoming = json && Array.isArray(json.records) ? json.records : null;
      if (!incoming) { setRunning(false); return; }
      void applyRecords(incoming);
    });
    // Scheduled (cadence) runs write to the schedule store, not the query path —
    // fold their records into the same table so the daily scan shows up here.
    if (a.onScheduleUpdate) {
      a.onScheduleUpdate((snap) => {
        if (snap && snap.status === "running") setRunning(true);
        const res = snap && snap.result;
        if (res && Array.isArray(res.records)) void applyRecords(res.records);
      });
    }
    if (a.scheduled) {
      a.scheduled().then((snap) => {
        if (!snap) return;
        if (snap.status === "running") setRunning(true);
        const res = snap.result;
        if (res && Array.isArray(res.records)) void applyRecords(res.records);
      }).catch(() => {});
    }
  }, []);

  async function refresh() {
    if (running || !query) return;
    setRunning(true);
    setError(null);
    setAdded(0);
    try {
      // Stamp the start so a reload mid-run still shows "Researching…".
      await window.artifact.state.set("runStartedAt", Date.now());
      await window.artifact.query(query, { schema: schema || undefined, research: true });
      // Result arrives via onQueryResult (durable — survives a tab close).
    } catch (e) {
      setRunning(false);
      await window.artifact.state.set("runStartedAt", 0);
      setError(e && e.message ? e.message : String(e));
    }
  }

  async function pickCadence(c) {
    setCadence(c);
    await window.artifact.state.set("cadence", c);
    if (c === "manual") return;
    await window.artifact.defineSchedule({
      type: "query",
      research: true,
      cron: CRONS[c],
      prompt: query,
      schema: schema || undefined,
      tools: ["web_search"],
    });
  }

  return (
    <main className="wrap">
      <header>
        <h1>Research</h1>
        <p className="sub">{query}</p>
      </header>

      <div className="bar">
        <button className="primary" onClick={refresh} disabled={running || !query}>
          {running ? "Researching…" : "Refresh"}
        </button>
        <label className="cadence">
          <span>Auto-refresh</span>
          <select value={cadence} onChange={(e) => pickCadence(e.target.value)}>
            <option value="manual">Manual</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>
        <span className="meta">
          {rows.length} result{rows.length === 1 ? "" : "s"}{added > 0 ? " · +" + added + " new" : ""}{updatedAt > 0 ? " · updated " + relTime(updatedAt) : ""}
        </span>
      </div>

      {error ? <div className="err">{error}</div> : null}
      {running ? (
        <div className="note">Deep research runs on the server - safe to close the tab and come back; results land here when it finishes.</div>
      ) : null}

      {columns.length > 0 && rows.length > 0 ? (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((rec) => (
                <tr key={rec.id}>
                  {columns.map((c) => (
                    <td key={c.key}><Cell value={rec[c.key]} type={c.type} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty">{running ? "Researching…" : "No results yet. Hit Refresh."}</p>
      )}
    </main>
  );
}

function Cell({ value, type }) {
  const s = value == null ? "" : String(value);
  if (!s) return <span className="dash">—</span>;
  if (type === "link" && /^https?:\\/\\//i.test(s)) {
    let label = s;
    try { label = new URL(s).hostname.replace(/^www\\./, ""); } catch (e) { /* keep raw */ }
    return <a href={s} target="_blank" rel="noreferrer">{label}</a>;
  }
  return <span>{s}</span>;
}
`,

  "Widget.tsx": `import { WidgetShell, Stat, Label, List, useArtifactState, useWidgetSize } from "@artifact/ui";

// Reads the research rows + columns from state (never fetches). The full app
// owns refresh; this just reflects the current table.
export default function Widget() {
  const [rows] = useArtifactState("records", []);
  const [columns] = useArtifactState("columns", []);
  const size = useWidgetSize();
  const list = Array.isArray(rows) ? rows : [];
  const cols = Array.isArray(columns) ? columns : [];
  const labelKey = cols[0] && cols[0].key ? cols[0].key : null;

  return (
    <WidgetShell>
      <Stat value={list.length} label={list.length === 1 ? "result" : "results"} />
      {size !== "S" && labelKey ? (
        <List>
          {list.slice(0, size === "L" ? 6 : 3).map((r, i) => (
            <li key={r.id || i}>{String(r[labelKey] == null ? "" : r[labelKey])}</li>
          ))}
        </List>
      ) : (
        list.length === 0 ? <Label>No results yet</Label> : null
      )}
    </WidgetShell>
  );
}
`,

  "styles.css": `:root { color-scheme: dark; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  background: radial-gradient(ellipse at top, #1a1530, #07080d 60%);
  color: #e8e9f0;
  min-height: 100vh;
}
.wrap { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
header h1 {
  margin: 0 0 0.25rem;
  font-size: 1.5rem;
  background: linear-gradient(135deg, #c084fc, #60a5fa);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.sub { margin: 0; color: rgba(255,255,255,0.6); font-size: 0.85rem; line-height: 1.4; }
.bar { display: flex; align-items: center; gap: 0.85rem; flex-wrap: wrap; margin: 1.25rem 0 1rem; }
button.primary {
  background: linear-gradient(135deg, #9333ea, #2563eb); color: white;
  border: 0; border-radius: 0.6rem; padding: 0.55rem 1.1rem;
  font: inherit; font-weight: 600; cursor: pointer;
}
button.primary:disabled { opacity: 0.6; cursor: default; }
.cadence { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; color: rgba(255,255,255,0.6); }
.cadence select {
  background: rgba(255,255,255,0.06); color: inherit;
  border: 1px solid rgba(255,255,255,0.14); border-radius: 0.5rem;
  padding: 0.3rem 0.5rem; font: inherit;
}
.meta { font-size: 0.78rem; color: rgba(255,255,255,0.5); margin-left: auto; }
.err {
  margin-bottom: 0.9rem; padding: 0.6rem 0.75rem; border-radius: 0.5rem;
  background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.3);
  color: #fca5a5; font-size: 0.8rem;
}
.note { margin-bottom: 0.9rem; font-size: 0.78rem; color: rgba(255,255,255,0.5); }
.tablewrap { overflow: auto; border: 1px solid rgba(255,255,255,0.1); border-radius: 0.8rem; }
table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
th {
  position: sticky; top: 0; text-align: left; padding: 0.55rem 0.75rem;
  font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em;
  color: rgba(255,255,255,0.55); background: #14101f;
  border-bottom: 1px solid rgba(255,255,255,0.12);
}
td { padding: 0.55rem 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.06); vertical-align: top; }
tr:hover td { background: rgba(255,255,255,0.02); }
a { color: #93c5fd; }
.dash { color: rgba(255,255,255,0.3); }
.empty { margin-top: 2rem; text-align: center; color: rgba(255,255,255,0.4); font-size: 0.85rem; }
`,

  "manifest.json": `{
  "name": "Research",
  "description": "A research results table that re-runs the deep engine on demand or on a schedule.",
  "params": [],
  "widget": { "entry": "Widget.tsx", "defaultSize": "M", "supportedSizes": ["S", "M", "L", "W"] }
}
`,
};

/** The canonical research-app source. Exported so a broken research app (whose
 *  files/manifest got mangled by a chat code edit - the failure that shows
 *  "Build failed" or a blank frame) can be healed back to the known-good
 *  template without losing its data, which lives entirely on app.state. */
export function researchTemplateFiles(): ArtifactFiles {
  return { ...RESEARCH_TEMPLATE_FILES };
}

/** Clean manifest for a research app: no params (the model is owned by the app's
 *  single Model picker, not a manifest param), with the widget entry the
 *  template provides. */
export function researchManifest(name: string): ArtifactManifest {
  return {
    name,
    description:
      "A research results table that re-runs the deep engine on demand or on a schedule.",
    params: [],
    widget: { entry: "Widget.tsx", defaultSize: "M", supportedSizes: ["S", "M", "L", "W"] },
  };
}

function deriveResearchName(query: string): string {
  const words = query.trim().split(/\s+/).slice(0, 6).join(" ");
  const name = words.length > 48 ? words.slice(0, 48).trim() + "…" : words;
  return name || "Research";
}

/**
 * Promote a chat structured-research result into a standalone app: a live
 * results table you can pin as a home widget and re-run (manually or on a
 * schedule) with the same deep engine that produced it. Records are flattened
 * to { id, ...fields } and seeded into app state alongside the query, columns,
 * idKeys, and schema, so the table renders real data on first paint with no
 * rebuild and no extra research call.
 */
export async function createResearchApp(
  payload: StructuredResearchPayload,
  options?: { title?: string }
): Promise<{ designer: StoredDesigner; app: StoredApp; chat: StoredChat }> {
  const now = Date.now();
  const id = newId();
  const chatId = newId();
  const title = options?.title?.trim() || deriveResearchName(payload.query);
  const columns = payload.columns ?? [];
  const idKeys = payload.idKeys ?? [];
  const flatRecords = (payload.records ?? []).map((r) => ({
    id: r.id,
    ...(r.fields ?? {}),
  }));
  const description = `Recurring research: ${payload.query}`.slice(0, 200);
  const manifest: ArtifactManifest = {
    name: title,
    description,
    params: [],
    widget: { entry: "Widget.tsx", defaultSize: "M", supportedSizes: ["S", "M", "L", "W"] },
  };
  const designer: StoredDesigner = {
    id,
    name: title,
    description,
    files: { ...RESEARCH_TEMPLATE_FILES },
    entry: "main.tsx",
    manifest,
    status: "draft",
    version: 1,
    history: [],
    sourceChatId: chatId,
    createdAt: now,
    updatedAt: now,
  };
  const app: StoredApp = {
    id,
    name: title,
    params: {},
    ...(payload.model ? { model: payload.model } : {}),
    state: {
      query: payload.query,
      columns,
      idKeys,
      schema: payload.schema,
      records: flatRecords,
      cadence: "manual",
    },
    lastRunAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const chat: StoredChat = {
    id: chatId,
    title: `Edit · ${title}`,
    titleSource: "default",
    target: { kind: "designer", id, mode: "edit" },
    createdAt: now,
    updatedAt: now,
    ...newChatTtl(now),
  };
  await putDesigner(designer);
  await putApp(app);
  await putChat(chat);
  await putMessage({
    id: newId(),
    chatId,
    role: "assistant",
    content:
      "Saved your research as an app. The table is live; **Refresh** re-runs the " +
      "deep research and appends new rows, and the **Auto-refresh** dropdown can " +
      "run it daily or weekly (manage or pause it anytime from the Control Center). " +
      "Tell me what to change about the columns or the query.",
    createdAt: now,
  });
  return { designer, app, chat };
}
