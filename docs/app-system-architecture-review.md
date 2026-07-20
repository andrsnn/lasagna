# App-builder / widget system: architecture review and rebuild recommendation

Date: 2026-07-07
Trigger: recurring cross-surface inconsistencies. Motivating example (user screenshots):
the "Chattanooga Event Feed" home widget shows "CHATTANOOGA - 20 UPCOMING" with populated
rows, while the full app view of the same app shows "Last refreshed never", "Tracking 0
events", and an empty state. Within the widget itself, the location column mixes venue
names ("Yellow Racket Records") with raw street addresses ("206 W Main Street").

Method: four parallel investigations over the full (unshallowed) 1,126-commit history
(PRs #1-#504) and the current codebase: (1) git-history bug taxonomy, (2) end-to-end
architecture map, (3) trace of the widget-vs-app state divergence, (4) data-layer /
`artifact.query` consistency analysis.

## Verdict

**Do not do a ground-up rebuild. Do a targeted rebuild of two layers - the app data
plane and the generated-code contract - and keep the shell (chat, designer, build
pipeline, iframe runtime, host UI) as is.**

The bug history is bad, but it is not uniformly bad. Roughly half of the ~116 commits
touching the artifact/app/widget subsystem are corrective rather than additive, with
repeated fix-of-a-fix sagas (the "which model runs this query" bug was re-fixed five
times; the blank-iframe handshake took six commits including two reverts). However, the
failure modes cluster overwhelmingly into two architectural gaps, and the rest of the
system - the sandboxed iframe runtime with its typed RPC protocol, the esbuild pipeline,
the designer/versioning flow - is comparatively stable and encodes a lot of hard-won
environmental knowledge (the handshake re-post loop, budget/lock semantics, build-cache
versioning) that a rewrite would have to rediscover the hard way.

## What the evidence shows

### Root cause 1: app state has no single source of truth (11 places, no bridge)

The same logical app state can live in 11 distinct places: IndexedDB `apps.state`,
IndexedDB `query_cache`, `pending_queries`, `designers.lastBuild`/`lastWidgetBuild`,
Redis schedule result/meta/history, the Redis query stream store, per-frame in-memory
mirrors, BroadcastChannel fan-out, and the account-sync server copy.

The screenshot bug is a direct consequence:

- Scheduled refreshes run server-side (`app/lib/run-schedule.ts`) and write results
  **only to Redis** (`app/lib/schedule-store.ts`). The runner has no access to the
  device's IndexedDB and there is no server-side copy of `app.state`.
- The widget's `Widget.tsx` happens to render the Redis snapshot delivered via
  `onScheduleUpdate`, so it shows 20 events.
- The full app's `App.tsx` renders from `artifact.state` (IndexedDB), which the
  scheduled run never wrote. Bridging Redis into `app.state` is the responsibility of
  **generated code** - the prompt tells the model to copy snapshots into state, and if
  the generated app doesn't, the two surfaces diverge forever.
- "Last refreshed never": `app.lastRunAt` (IndexedDB) is only written by client-side
  actions; the cron runner updates a *second* lastRunAt in Redis meta. Two clocks, one
  label.
- The one place a host-side bridge exists - `ResearchAppView`'s 15s poller that merges
  Redis snapshots into `app.state.records` and stamps `lastRunAt` - is siloed in the
  built-in research feature and does not run for custom artifacts.

The git history shows this same shape repeatedly: stale widget query replays
(`346bcd5`), results living only in iframe memory (`5c4258b`, `c058db2`),
`onScheduleUpdate` registered after an await missing the snapshot (`5dfd13e`),
account-sync last-write-wins guards fighting each other until sync silently died
(`52943be` -> `7a718f1` -> `7cb8082`), and cache keys omitting the inputs that changed
so fixes couldn't propagate without manually bumping `BUILD_FORMAT_VERSION`
(`9a89769`, `1d52286`, `a080882`).

### Root cause 2: the model-facing contract is prose, duplicated, and drifting

The SDK the model codes against is specified in at least four places that already
disagree: the codegen prompts in `app/api/chat/route.ts`, the reduced seeded
`artifact-sdk.d.ts` in `app/lib/create.ts` (missing `exec`, `batchQuery`, `scheduled`,
`defineSchedule`, `download`, `shared`, and more), the full
`app/lib/artifact/vendor/artifact-sdk.d.ts` (whose header claims it is bundled into
every build, but `build.ts` never references it), and the README.

Concrete drift found in the current tree:

- Prompts document the schedule snapshot as `{ task, status, lastRun?, result? }`; the
  real protocol uses `runAt`. Generated code that trusts the prompt is wrong.
- Prompts emphatically instruct the model to set `"model": "gemma4:31b"` on query
  schedules; the runtime strips any code-provided model and resolves it host-side. Dead
  instruction, live confusion.
- The research-vs-iframe render fork is an implicit duck-type on `app.state` shape,
  replicated in at least three call sites; a chat edit that changes the state shape
  silently breaks the native view.
- There is no typecheck/lint gate on generated code; validation is esbuild bundling
  plus manifest diagnostics, and the save path tolerantly repairs manifests the build
  path rejected, so the runtime manifest can differ from what was validated.

History shows the team oscillating on this boundary (humanize manifest errors ->
silently repair -> re-fail builds so the LLM fixes them), i.e. prompt-patching a
probabilistic generator instead of enforcing a schema boundary.

### Root cause 3: structured data quality is shape-checked, never semantically enforced

`artifact.query` validation (`app/lib/structured-output.ts`) checks `type`, `required`,
`properties`, `items`, `enum` - and silently drops `pattern`, `format`, `minLength`,
`description`. A `venue: string` field accepts a venue name in one row and a street
address in the next; each row is an independent model emission and nothing downstream
normalizes, dedupes, or reconciles. With `webSearch: true`, native JSON mode is
disabled, making this the common case. "Live-link validation" (commit `192e4eb`) is
prompt instructions plus User-Agent rotation; no code checks emitted URLs against what
the tools actually returned (image search, by contrast, has real code-level dead-URL
filtering).

Meanwhile `app/lib/structured-research.ts` already implements record identity
(`idKeys`), canonicalization (`normalizeIdentity`), filler scrubbing (`scrubCell`),
blank-filling merge, drop-empty-rows, and prior-context threading so re-runs find new
items - all siloed in the research feature, none available to `artifact.query` or
`artifact.task`.

## Why not a full rebuild

1. The failure classes are concentrated. Rebuilding chat, designer, build, versioning,
   share, and the iframe runtime to fix a state-plane and contract problem is paying
   for six rewrites to get two.
2. The corrective commits encode non-obvious environmental knowledge (iframe handshake
   timing, Vercel/Fly/Redis budget and lock semantics, esm.sh importmap constraints,
   account-sync conflict behavior). A rewrite re-derives these through the same
   revert sagas.
3. The one boundary that is properly typed - the iframe RPC protocol
   (`sdk-protocol.ts`) - is also the one with the fewest recurring bugs. That is the
   pattern to replicate, not discard.

## Recommended plan: four workstreams

### W1. One data plane for app state (fixes the widget-vs-app divergence class)

Goal: any write to an app's data becomes visible to every surface (widget, app view,
other devices) without generated code having to bridge stores.

- Make the **host, not generated code**, land scheduled results in `app.state`:
  generalize the research poller into a platform bridge - when a schedule snapshot
  arrives (on mount, visibility, or push), the host merges `result` into a well-known
  state key and stamps the single authoritative `lastRunAt`. Keep `onScheduleUpdate` as
  a notification, not a persistence mechanism.
- Longer term, make `app.state` **server-authoritative with device replicas** (the
  account-sync store is most of the way there): scheduled runs write state directly;
  devices subscribe. This collapses the Redis-result / IndexedDB-state split entirely.
- Unify "last refreshed" to one value with one writer.
- Introduce a single per-app **version stamp** (monotonic revision on every state/code
  write) that all caches key on - query cache, widget build, schedule snapshot -
  replacing ad-hoc TTLs and the manual `BUILD_FORMAT_VERSION` lever, and collapse the
  redundant query-result caches (in-flight map, CachedQuery, pendingQueries, replay
  buffer) onto it.

### W2. Contracts as code, not prose (fixes the drift class)

- One canonical SDK definition (a typed schema/source module) from which the `.d.ts`
  seeded into apps, the vendor `.d.ts`, the prompt documentation blocks, and the RPC
  protocol types are all **generated**. Delete the hand-maintained copies. A drift like
  `lastRun` vs `runAt` becomes impossible rather than latent.
- Gate `Build()` on a real typecheck of generated code against the canonical `.d.ts`
  (tsc in the existing script sandbox), so the model gets type errors in its tool loop
  instead of users getting runtime blanks.
- Keep the dual manifest policy but make it explicit: strict validation surfaces to the
  model at build time; the tolerant repair applies only to display, never silently
  changing runtime behavior.
- Replace the research duck-type with an explicit `app.kind` field written at creation;
  one render-path decision point.

### W3. Data-quality primitives in the platform (fixes the venue/address class)

- Promote the research feature's machinery into generic SDK primitives - e.g. an
  `artifact.collection(key, { schema, identity })` that gives every app server-side
  append/merge with record identity, canonicalization, dedupe, and filler scrubbing.
  (Passes the CLAUDE.md test: a recipes app, a papers app, and an events app all want
  this.)
- Extend `validateAgainstSchema` to honor `pattern`, `format`, `minLength`/`maxLength`,
  and nested `enum`, feeding the existing repair loop, so app schemas can actually
  constrain fields like `venue`.
- Add an optional normalization pass on query results (the generalization of
  `scrubCell`), and code-level URL validation that cross-references emitted links
  against URLs the web tools actually returned in that run (mirroring what
  `braveImageSearchValidated` already does for images).

### W4. Hygiene that keeps it fixed

- Contract tests at each boundary: prompt-doc snapshots generated from the canonical
  SDK source, schedule-runner round-trip tests (write -> both surfaces read), schema
  validation fixtures.
- A rule for future fixes: any bug caused by two code paths computing the same fact
  independently is fixed by creating/using the single resolver, not by patching the
  second path (the pattern that finally ended the model-resolution saga via
  `resolveScheduledModel`).

## Sequencing

1. **W1 host-side schedule bridge + unified lastRunAt** - small, ships alone, and
   eliminates the single most user-visible inconsistency class (the screenshot bug).
2. **W3 schema keywords + normalization + collection primitive** - medium; fixes the
   data-uniformity class for all apps at once.
3. **W2 canonical SDK + typecheck gate** - medium-large; stops the drift class from
   regenerating.
4. **W1 server-authoritative state + version stamp** - the largest piece; do it after
   the bridge proves the merge semantics.

Each step is independently shippable and independently valuable; none requires
regenerating existing apps.
