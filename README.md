<img src="docs/logo.png" alt="Lasagna" height="120">

> *It's a bit undercooked, but still pretty tasty.*

A personal AI workspace built on [Ollama Cloud](https://ollama.com/cloud) and
deployable to Vercel. Chat with frontier open models, then turn any idea into a
small live app - by describing it in plain language and letting the assistant
build it for you.

![Demo](docs/demo.gif)

## What you get

It is one Next.js (App Router) project with several surfaces:

- **Chats** - streaming chat against curated Ollama Cloud models, with visible
  reasoning, markdown rendering, real per-message token/usage stats, resumable
  streams (close the tab mid-reply and it keeps going), tools (web search, web
  fetch, image search, code execution), and optional voice in/out.
- **Apps** - a chat-first builder. Describe what you want; the assistant picks a
  template and edits real files (`App.tsx`, `Widget.tsx`, `manifest.json`, ...)
  with a live preview, then you publish it. Apps run on a small typed SDK
  (`artifact.query`, `artifact.state`, `artifact.exec`, `artifact.defineSchedule`).
- **Widgets** - live home-screen tiles for the apps you build, resizable and
  rearrangeable.
- **Research** - structured `{ query, columns, records }` tables backed by web
  search, promotable into a saved app.
- **Notes** - a lightweight notes surface you can attach to chats.
- **Schedules** - give an app one background task that runs on a cron schedule
  (at most once per hour), caches its result, and surfaces it back to the app.
- **Sharing** - share a chat, note, app, or rendered HTML via a public link.
- **Accounts** - invite-based sign-up, per-user data, and an admin area for
  issuing invites and managing users.

> Data model: each user's content (chats, apps, notes, research) lives in the
> browser's IndexedDB, namespaced per account, and syncs to Redis/Blob for
> sharing and cross-device continuity. There is no central product database.

## Quickstart (local)

```bash
cp .env.example .env.local
# fill in at least OLLAMA_API_KEY, TEMP_PASS, ADMIN_EMAIL, SESSION_SECRET,
# and a Redis pair (see the table below)
npm install
npm run dev
```

Open http://localhost:3000. Sign in with the `ADMIN_EMAIL` + `TEMP_PASS` you set
- the first sign-in lazily creates (and PBKDF2-hashes) the admin account. From
the admin area you can mint invite links so other people can sign up.

## Environment variables

| Name | What it is | Required |
|---|---|---|
| `OLLAMA_API_KEY` | Ollama Cloud key (https://ollama.com/settings/keys). Powers chat, the builder, web search/fetch, and image description. | Yes |
| `TEMP_PASS` | Bootstrap admin password. First sign-in with `ADMIN_EMAIL` + `TEMP_PASS` creates the admin user. | Yes |
| `ADMIN_EMAIL` | Email of the admin account; also gates `/admin/*`. Defaults to `admin@example.com` when unset. | Recommended |
| `SESSION_SECRET` | HMAC key for session cookies. Falls back to `TEMP_PASS`; set it explicitly so you can rotate passwords without invalidating sessions. | Recommended |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` *or* `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Redis (REST). Required for accounts, sharing, resumable streams, and schedules. Provisioning Upstash or KV from Vercel's Storage tab auto-injects one pair. | Yes for accounts/sharing/schedules |
| `OPENAI_API_KEY` | Enables the high-quality "Speak" (TTS) and voice transcription (STT) backends. Without it, Speak falls back to the browser's `speechSynthesis`. | Optional |
| `BRAVE_SEARCH_API_KEY` | Enables the `image_search` chat tool (https://api.search.brave.com/). | Optional |
| `RUNPOD_API_KEY` + `RUNPOD_ENDPOINT_ID` | Optional second LLM provider. Models with an `id` prefixed `runpod:` route to your RunPod OpenAI-compatible endpoint instead of Ollama Cloud. | Optional |
| `RUNPOD_VISION_DESCRIBER_MODEL` | Override the vision describer when your main chat model is a text-only RunPod model and you upload images. | Optional |
| `CRON_SECRET` | Auto-generated and injected by Vercel when `vercel.json` declares crons; set the same value locally to test the schedule sweep. | Auto on Vercel |
| `FLY_API_TOKEN`, `FLY_APP_NAME`, `FLY_MACHINE_ID` | Point the Code Execution / Advanced Web features at your Fly worker (see below). Without them those features report the sandbox as unavailable. | Optional |

See `.env.example` for the full annotated list.

## Deploy

### App (Vercel)

1. Import this repo on https://vercel.com/new (or run `vercel`).
2. Add the environment variables above for Production, Preview, and Development.
   Provision Upstash for Redis (or Vercel KV) from the project's **Storage** tab
   to auto-inject the Redis pair.
3. Redeploy. `CRON_SECRET` is injected automatically and the 30-minute schedule
   sweep declared in `vercel.json` starts running.

### Worker (Fly, optional)

The **Code Execution** and **Advanced Web** features route to a small Fly worker
that has `python3` (numpy/pillow/requests), `node`, and `ffmpeg` pre-baked.

```bash
fly launch            # creates the app; pick a name and region
fly deploy            # builds worker/Dockerfile
```

Then set `FLY_API_TOKEN`, `FLY_APP_NAME`, and `FLY_MACHINE_ID` in the Vercel
project so the app can wake and reach the worker. Until configured, those two
features load but report that the sandbox is unavailable; everything else works.

## The artifact SDK

Apps you build are sandboxed iframes that talk to the host through a small typed
SDK. The headline primitives:

- `artifact.query({ schema, prompt, webSearch })` - one-shot LLM call returning
  validated structured output (mirrored to Redis so it survives a disconnect).
- `artifact.state` - per-app persisted state.
- `artifact.exec(code, { language, files })` - run python/node on the Fly worker
  and get back `{ ok, stdout, stderr, files }`.
- `artifact.defineSchedule({ cron, type, prompt, ... })` / `artifact.scheduled()`
  - declare and read the app's single background task.
- `artifact.download(...)` - export data/files to the user.

`examples/jobsearch-app/` is a complete reference app built on these primitives.

## Resumable streams

The chat keeps generating server-side even when the tab closes. On reopen, the
in-flight assistant message reattaches to the same stream and finishes. This
needs a buffer that outlives a single serverless invocation, which is what the
Redis REST credentials are for. The buffer holds events for an hour while
running and 15 minutes after completion, then auto-evicts; IndexedDB on the
client remains the canonical store.

## Code execution sandbox

A toggleable **Code Execution** mode hands the model a `run_code` tool: it writes
and runs real python/node in an isolated per-run workspace on the Fly worker.
Attach a binary file (audio/video/zip/...) and the model can read it; anything it
writes back is captured and surfaced as a download. Each run spawns the
interpreter with `shell:false` and a secret-scrubbed environment (no API keys
reach the child), a wall-clock timeout, output caps, and a per-run temp workspace
that is deleted afterward. Saved apps can use the same path via `artifact.exec`.

## Key files

- `app/api/chat/route.ts` - SSE-streaming chat route; mirrors events into Redis
  under a `streamId` so a closed tab can reconnect.
- `app/api/chat/resume/[streamId]/route.ts` - replays buffered events from a cursor.
- `app/api/query/route.ts` - single-shot LLM call used by `artifact.query`.
- `app/lib/stream-store.ts` - Redis wrapper (event log + JSON meta).
- `app/components/chat.tsx` - chat UI; persists `streamId` per message and auto-resumes.
- `app/designer/` - the chat-first app builder (file tree, live preview, publish).
- `app/db.ts` - IndexedDB schema, namespaced per account.
- `app/models.ts` - curated model metadata; the selectable list is discovered at
  runtime from your Ollama Cloud account via `GET /api/models`.
- `worker/` - the Fly worker (code execution + advanced web), `worker/Dockerfile`
  adds `python3`, `ffmpeg`, and the pre-baked libs.

## Pricing

Ollama Cloud is subscription-based - see https://ollama.com/pricing. Because
per-token rates are not published, the app shows the actual per-request token
counts returned by the API rather than estimated dollar costs.
