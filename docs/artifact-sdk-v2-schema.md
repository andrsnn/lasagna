# Artifact SDK v2: a declarative schema for state, queries, schedules, and widgets

Date: 2026-07-07
Status: first cut implemented on this branch (merge engine, full-keyword
validation, manifest.state Build gate, host-run sources, artifact.entries +
useArtifact, schedule bridge, unified lastRefreshed, codegen prompt).
Provenance-checked URLs and the generated-from-one-source .d.ts pipeline
remain follow-ups.
Companion: `docs/app-system-architecture-review.md` (evidence and bug taxonomy)

## The diagnosis this design answers

The storage substrate is not the problem. Local-first IndexedDB with account sync
works and stays. The problem is the **authoring contract**: the LLM writing apps is
asked to hand-wire a distributed data flow across three separate channels
(`artifact.state`, `onScheduleUpdate`, `onQueryResult`) plus a schedule registry,
under ~250 lines of prose rules in the codegen prompt. Every "NON-NEGOTIABLE" block
in `VFS_EDIT_SYSTEM` is a patch over an API footgun the model fell into:

| Prose rule the model must remember today | Bug when it forgets |
| --- | --- |
| "Register `onScheduleUpdate` synchronously, before any awaits" | Handler misses the buffered snapshot; app shows "Searching..." forever (`5dfd13e`) |
| "Handlers must be idempotent; the same snapshot fires on ready, replay, visibility flips, sibling broadcasts" | Duplicated history entries, double-fired side effects |
| "Always persist scheduled `result` into `artifact.state` so the widget picks it up" | Widget shows 20 events, app view shows 0 (the screenshot bug) |
| "Render `s.result` even when `status === 'running'`" | UI hangs on a spinner while holding valid data |
| "Don't also `setData(s.result)` in the IIFE; the handler already did it" | Double-set on first paint |
| "Never call query/fetch on mount; only on explicit user triggers" | Rate-limit blocks, burned tokens |
| "Always check `artifact.state` before querying; always persist results back" | Lost results on reload (`5c4258b`, `c058db2`) |
| "Use `useArtifactTask`, not raw `await query()` in a click handler" | Result lost when user leaves mid-fetch |
| "Always set `model: 'gemma4:31b'` on schedules" | Dead instruction; runtime strips it. Prompt and runtime disagree today |
| "`scheduled()` returns `{ ..., lastRun? }`" | Real field is `runAt`; prompt-documented shape is wrong today |

The pattern: **behavioral rules living in prose instead of in the schema**. The model
is a probabilistic rule-follower; every rule it must remember is a standing source of
regressions. The fix is to move each rule into the type system or the host runtime,
so the wrong program either does not typecheck or cannot be expressed at all.

## Design principles

1. **Declare data, don't wire it.** The app declares WHAT its data is (shape,
   identity, where it comes from, when it refreshes). The host owns HOW: running
   queries, running schedules, validating, merging, persisting, replaying,
   fanning out to widget and sibling frames and other devices.
2. **State is the only channel.** There are no data events to subscribe to. Query
   results, schedule results, sync pulls, and sibling writes all land in the state
   document (by the host), and the app observes state. A value stream is idempotent
   by construction; replays and duplicate deliveries are unobservable.
3. **One source of truth, generated everywhere.** The schema definition below is a
   single TypeScript module. The seeded `.d.ts`, the prompt documentation, the
   runtime validators, and the wire protocol types are generated from it. Prose can
   no longer drift from runtime (`lastRun` vs `runAt`, the dead `model` field).
4. **Keep the substrate.** IndexedDB local-first storage, account sync across
   devices, the sandboxed iframe, the postMessage RPC transport, and esbuild all
   stay exactly as they are. This is a contract redesign, not a storage redesign.

## The schema

**As implemented** (first cut is on this branch): the declaration lives in
`manifest.json` under a `"state"` block rather than a TS config file - it must
be serializable because the scheduled server-side run executes from the same
declaration, and it reuses the existing manifest parse/validate/registration
plumbing. An app declares its entire data model once:

```json
{
  "name": "Chattanooga Event Feed",
  "description": "Upcoming events in Chattanooga, TN. Refreshes daily at 6 AM.",
  "params": [
    { "key": "city", "type": "string", "label": "City", "default": "Chattanooga, TN" }
  ],
  "state": {
    "events": {
      "kind": "collection",
      "schema": {
        "type": "object",
        "properties": {
          "title":    { "type": "string", "minLength": 1 },
          "date":     { "type": "string", "format": "date" },
          "venue":    { "type": "string", "description": "Venue NAME only, never a street address" },
          "address":  { "type": "string", "description": "Street address, if known" },
          "category": { "enum": ["festivals", "music", "food", "sports", "arts", "comedy", "outdoors", "other"] },
          "url":      { "type": "string", "format": "uri" }
        },
        "required": ["title", "date", "venue", "category"]
      },
      "identity": ["title", "date"],
      "merge": "upsert",
      "retain": { "dateKey": "date" },
      "source": {
        "type": "query",
        "prompt": "Search the web for upcoming events in {params.city} over the next 2 weeks. Real events only, with dates and venues.",
        "webSearch": true,
        "refresh": { "user": true, "schedule": "0 6 * * *" }
      }
    },
    "filter": { "kind": "value", "default": "all" }
  }
}
```

App code (both `App.tsx` and `Widget.tsx`) consumes exactly one primitive:

```tsx
function App() {
  const events = useArtifact("events");
  // events: {
  //   data: EventRecord[]            // typed from the schema, always current
  //   status: "idle" | "refreshing" | "error"
  //   lastRefreshedAt: number | null // host-stamped, one clock for all surfaces
  //   error?: string
  //   refresh(): void               // requests a source run; host rate-limits
  // }
  const [filter, setFilter] = useArtifactValue("filter");
  ...
}
```

Non-React form: `artifact.watch("events", fn)` returning an unsubscribe, plus
`artifact.get("events")` / `artifact.update("filter", v)`.

That is the entire data API an app author (the LLM) touches.

## What the host now owns (and the app can no longer get wrong)

**Sources run host-side, on both triggers, through one code path.** The Refresh
button, `refresh()` calls, and the cron sweep all execute the same source the same
way (the existing `executeQuery`). Results are validated against the declared
schema with FULL JSON Schema keyword support (`pattern`, `format`, `minLength`,
nested `enum`, plus the existing repair loop), scrubbed of filler (generalizing
`scrubCell`), canonicalized, merged by `identity` per the `merge` policy, and
written into the state document. The write lands in the same IndexedDB store the
app and widget observe; the server-run path delivers through the existing schedule
snapshot channel, but the HOST lands it in state. Generated code never bridges
stores again.

**`lastRefreshedAt` is host-stamped per entry.** "Last refreshed never" while a
schedule runs nightly becomes impossible; there is one clock, written by the thing
that did the refreshing.

**Provenance-checked URLs.** A field marked `provenance: "web"` must match a URL
actually returned by the web tools during that run, enforced in code (mirroring
what `braveImageSearchValidated` already does for images), or it is blanked.
Live-link correctness stops being a prompt plea.

**Trigger discipline is structural.** Source-backed entries have no imperative
fetch call to misplace: there is nothing to accidentally invoke in a `useEffect`.
`refresh()` exists, but the host debounces, dedupes, checks the cache, and
rate-limits it; calling it on mount is a no-op against a fresh cache rather than a
burned query. The entire "Data-fetching rules" prompt section disappears.

**Idempotency is free.** `useArtifact` returns current state; the host may deliver
the same snapshot fifty times and the app cannot observe it. The "wrong patterns"
lists for schedules, background queries, and first paint all describe programs that
can no longer be written.

**Params flow into sources declaratively.** `{params.city}` template interpolation
is serializable, so param-dependent prompts and cadences work in manifest-declared
schedules without imperative `defineSchedule` re-registration (which history shows
fighting user cadence edits, `78b214b`).

**MCP-backed sources.** A source may set `"mcp": true`. The host then exposes the
user's configured MCP (Model Context Protocol) connectors' tools to that source's
query run — the same wire-name + dispatch mechanism the chat tool loop uses
(`app/lib/mcp/*`, `buildMcpToolset`) — so the prompt can instruct the model to call
a connected server (a status API, an analytics endpoint, an internal DB) to fetch
the entry's data. This is a generic platform capability: the host passes the user's
own connectors; connector ids/urls/keys never enter the manifest or app code (the
app just declares the flag and describes what to fetch). It works on the interactive
Refresh / `refresh()` paths always (the client attaches its current connectors), and
on the background schedule from the connectors the user last opened the app with
(the host persists them in a server-only schedule-store key, never in the snapshot
or the app's files). With no connectors configured the run simply has no MCP tools.

## What this deletes from the SDK surface

Removed (their jobs move to the host): `onScheduleUpdate`, `onQueryResult`,
`scheduled()`, `runSchedule()`, `defineSchedule()`, `onRefresh`, `artifact.task`,
`useArtifactTask`, raw `state.get/set` as the primary API, and the `model` field
everywhere (the host always resolves the model; v1 already strips it, v2 stops
pretending otherwise).

Kept as escape hatches, unchanged: `artifact.query` for one-shot generative actions
whose result is NOT durable app data (e.g. "write a toast message"); `exec`,
`fetch`, `imageSearch`, `download`, `openUrl`, `copyToClipboard`, `shared.*`,
`params`, `ready()`. A raw `artifact.kv.get/set` namespace remains for
forward-compatible odds and ends, with the documented read-defensively semantics.

Anything durable the model is tempted to fetch imperatively has a better home as a
declared source, and the generated prompt says exactly that in one line, instead of
ninety lines of forbidden patterns.

## Enforcement pipeline (contract as code)

1. `@artifact/schema` is the single source of truth. From it are GENERATED:
   the ambient `.d.ts` seeded into every app (including per-app `useArtifact`
   return types derived from the declared state schema), the SDK documentation
   block in the codegen prompt, the runtime validators, and the RPC protocol types.
2. `Build()` gains two gates: (a) `artifact.config.ts` must parse and validate
   against the schema (replacing tolerant manifest repair with strict errors the
   model fixes in its tool loop), and (b) a typecheck of app code against the
   generated `.d.ts`, so `snap.lastRun`-class mistakes surface as compile errors
   to the model instead of runtime blanks to the user.
3. The save path stops repairing what the build path rejected: what was validated
   is what runs.
4. Contract tests: round-trip fixtures asserting that a source run (interactive
   and scheduled) produces identical state writes visible to app, widget, and a
   synced second device.

## Widget model

A widget is a pure view: same config, same state document, same `useArtifact`,
different entry and viewport. It cannot have a separate data path because no
separate data path exists. The app-vs-widget divergence class is closed by
construction, and `Widget.tsx` needs zero data-wiring code.

The built-in research view should become the reference implementation: an
`app.kind` field (replacing the state-shape duck-type) selecting a native renderer
over the same declared collection. Its existing identity/merge/scrub machinery
moves down into the platform merge engine described above, where every app gets it.

## Migration

- v2 is opt-in per app via the presence of `artifact.config.ts`. v1 apps keep
  working untouched; the v1 shim stays frozen.
- New apps generate as v2 only; the v2 codegen prompt is a fraction of the current
  one (the design-token and sandbox sections remain, the data-flow rulebook goes).
- `useArtifactTask` is the bridge concept: v2 generalizes what it already does
  (restore, refresh, persist, idempotent repaint) from a helper the model must
  remember to use into the only way data exists.
- Existing apps migrate opportunistically: an "upgrade" chat action prompts the
  model to emit a config from the app's current query/schedule/state usage, with
  the Build gates verifying the result.

## Sequencing

1. **Merge engine + full-keyword validation** (platform-side, benefits v1
   schedules immediately): identity, upsert, scrub, canonicalize, provenance
   check, host-stamped `lastRefreshedAt`.
2. **`@artifact/schema` + generators** (.d.ts, prompt block, validators) and the
   Build gates.
3. **v2 runtime**: config-driven sources wired to the existing query/schedule
   executors; `useArtifact`/`watch` over the existing state store + BroadcastChannel.
4. **Codegen prompt swap** for new apps; research view re-based on the engine;
   opportunistic migration of existing apps.

Each step ships independently; step 1 alone would have prevented both screenshot
bugs.
