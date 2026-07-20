// Server-side temp buffer for in-flight chat / query streams.
//
// Why this exists: when a phone goes to sleep or a tab closes, the client's
// `fetch` aborts the SSE stream. Without an out-of-band buffer, the LLM call
// also dies and there's nothing to resume. We mirror every SSE event into
// Upstash Redis here so a separate `/resume/{id}` request can replay them.
//
// IndexedDB on the client is still the canonical store; this is purely a
// 6-hour bridge across disconnects.

import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import type { Message as OllamaMessage } from "ollama";
import type {
  ArtifactFiles,
  AttachedFile,
  BuildIssue,
  CouncilFramingPayload,
  CouncilMember,
  FileChange,
  ResearchColumn,
  ResearchRecord,
  ScheduledTask,
} from "@/app/db";
// Type-only (erased at compile time, so no runtime coupling between this lib
// and the framing route): the research-framing job payload carries the same
// turn shape the framer work function consumes.
import type { ResearchFramerTurn } from "@/app/api/research/framing/work";
import type { McpRuntimeConnector } from "@/app/lib/mcp/shared";

export type SseEvent = { event: string; data: unknown };

export type StreamStatus = "running" | "complete" | "error";

/**
 * Hard cap on chained workers per stream. Each worker runs up to maxDuration
 * (300s on Vercel), so MAX_WORKER_SEQ × 300s = total generation budget.
 * 3 workers ⇒ ~15 minutes.
 */
export const MAX_WORKER_SEQ = 3;

export type StreamMeta = {
  status: StreamStatus;
  chatId?: string;
  messageId?: string;
  /**
   * Wall-clock when the FIRST producer set status="running". Kept for
   * back-compat readers that don't know about workerStartedAt.
   */
  createdAt?: number;
  /**
   * Wall-clock when the CURRENT producer started. Updated on every chained
   * worker handoff so the resume route's stale-detection bounds the live
   * worker's lifetime, not the whole chain.
   */
  workerStartedAt?: number;
  /** 1-indexed sequence of the current worker. 1 for the original POST,
   *  2…MAX_WORKER_SEQ for chained continuations. */
  workerSeq?: number;
  /**
   * Which producer is keeping this stream alive. Set by the route that
   * launches (or hands off) the worker so the resume route can pick the
   * right stale-detection ceiling: Vercel functions die at maxDuration
   * (~305s), the Fly worker's hard kill is ~1h. Optional so legacy meta
   * written before this field defaults to "vercel" — the safer choice
   * since a stuck Fly worker just delays the false-death by minutes,
   * while a stuck Vercel function with the Fly cap would hang the
   * reader for an hour.
   */
  producer?: "vercel" | "fly";
  finishedAt?: number;
  error?: string;
  /**
   * True if any RPUSH into the events list failed and was given up on after
   * retries. The live SSE client may have received those events fine, but a
   * resumed reader replaying from Redis will be missing them — the resume
   * endpoint surfaces this so the user knows the recovered transcript is
   * incomplete and can retry.
   */
  kvLossy?: boolean;
};

/** Serializable VFS state — Sets become arrays for JSON. */
export type VfsCheckpoint = {
  files: ArtifactFiles;
  entry: string;
  readPaths: string[];
  changes: FileChange[];
  lastBuild?:
    | { ok: true; durationMs: number; warnings: BuildIssue[] }
    | { ok: false; durationMs: number; errors: BuildIssue[]; warnings: BuildIssue[] };
  /** Note-canvas only — see `VfsContext.mode` in app/lib/ollama/tools.ts. */
  mode?: "vfs" | "note-canvas";
  /** Note-canvas only — the user-pinned highlight at send time. */
  selection?: {
    text: string;
    startOffset: number;
    endOffset: number;
    occurrenceIndex: number;
  };
};

/** Serializable form of a novel outline. Mirrors `NovelOutline` from
 *  app/api/chat/novel/prompts.ts — kept here as a structural duplicate so
 *  stream-store doesn't need to import from the chat-route tree. */
export type NovelOutlineCheckpoint = {
  title: string;
  logline: string;
  setting: string;
  characters: { name: string; role: string; description: string }[];
  chapters: { id: string; title: string; beats: string }[];
};

export type ResponseFormatLike =
  | "text"
  | "chat"
  | "html-doc"
  | "vfs-edit"
  /**
   * Pinned-note canvas mode: single-file VFS shaped like vfs-edit, but the
   * dispatcher rejects any tool outside the canvas allowlist
   * (Read/Edit/MultiEdit/Write/Finish) and the request must carry a single
   * `files` entry whose path matches `entry`. See
   * `app/lib/note-canvas/tools.ts`.
   */
  | "note-edit"
  /**
   * Chat-mode artifact canvas: iterate on a chat-generated HTML artifact in
   * place using the same restricted toolset as note-edit, but with the
   * ARTIFACT_EDIT_SYSTEM prompt (artifact-runtime aware) and no single-file
   * constraint on `files`. The entry is conventionally `index.html`.
   */
  | "artifact-edit";

/**
 * Snapshot of a chat worker's in-memory state at a tool-round boundary,
 * used to hand work to a fresh worker before Vercel kills the current one
 * at maxDuration. Stored as a single JSON blob in Redis under
 * `${KEY_PREFIX}:${streamId}:checkpoint`.
 */
export type Checkpoint = {
  v: 1;
  conv: OllamaMessage[];
  vfsCtx: VfsCheckpoint | null;
  parser: { mode: "prose" | "artifact" | "post"; buffer: string; artifact: string };
  totals: {
    totalPrompt: number;
    totalCompletion: number;
    totalEvalNs: number;
    totalDurationNs: number;
    lastTps: number;
  };
  flags: {
    producedProse: boolean;
    exitedWithToolsPending: boolean;
    finishedVfs: boolean;
    vfsFinishSummary: string;
    artifactProseHead: string;
    artifactDelivered: boolean;
  };
  cfg: {
    model: string;
    responseFormat: ResponseFormatLike;
    webSearchEnabled: boolean;
    imageSearchEnabled: boolean;
    /** Advanced Web mode — adds browse_page / http_request / run_command.
     *  Persisted so a handoff (Vercel chain) keeps the toolset; in the Fly
     *  path the whole job runs in one worker so there's no handoff anyway. */
    advancedWebEnabled?: boolean;
    /** Code Execution Sandbox mode — adds the run_code tool. Same persistence
     *  rationale as advancedWebEnabled. The user's blob namespace + the files
     *  available to run_code ride alongside so the Fly worker can stage inputs
     *  and store outputs. */
    codeExecEnabled?: boolean;
    codeExecUserHash?: string;
    codeExecFiles?: AttachedFile[];
    /** Custom MCP connectors enabled for this stream (URL + key + discovered
     *  tools). Persisted so a handoff keeps the connector toolset — the worker
     *  re-opens a fresh MCP session per connector on resume. */
    mcpConnectors?: McpRuntimeConnector[];
    publicOrigin: string;
    systemPrompt: string;
    maxRounds: number;
    wireBudget: number;
    runpodEndpointId?: string;
    /** User's configured image describer model + detail level, round-tripped
     *  through handoffs so the describer choice is sticky across the chain. */
    describerModel?: string;
    describeDetail?: "concise" | "standard" | "detailed";
    researchEnabled?: boolean;
    /** Long-running novel mode flag — drives the pre-round-loop outliner →
     *  sequential chapter writer flow. The round loop is skipped entirely
     *  when this is set; the assembled novel becomes the assistant turn. */
    novelModeEnabled?: boolean;
    /** Novel length preset. Drives chapter count and per-chapter word
     *  target. Stored as a string so the checkpoint can round-trip across
     *  workers without re-deriving from a numeric mapping. */
    novelLength?: "short" | "standard" | "long";
    /** User-confirmed outline from the editor flow. Round-tripped through
     *  the checkpoint so a handoff mid-novel still has the approved outline
     *  even if Redis evicted the scratchpad copy. */
    novelOutline?: NovelOutlineCheckpoint;
    /** Per-stream override of MAX_WORKER_SEQ. Undefined ⇒ global default. */
    maxWorkerSeq?: number;
    /** Plan mode: long-coding-task orchestrator (planner → cached
     *  per-step VFS edits). Set by the initial worker via
     *  shouldUsePlanMode() and persisted so successor workers stay in
     *  plan mode regardless of whether the entry-size / prompt-length
     *  heuristic still holds for them. */
    planModeEnabled?: boolean;
    /** Off-Vercel routing: when true, user-triggered continuations
     *  (plan-continue, regular Continue) should enqueue onto the Fly
     *  worker queue instead of running inside `waitUntil` on Vercel.
     *  Set on the initial POST when the client opts in AND the server
     *  has Fly env configured; persisted through the checkpoint so a
     *  later Continue click can re-route correctly even after the
     *  worker dies. */
    flyWorker?: boolean;
  };
  /** Next round index to execute. */
  round: number;
  /** Original VFS snapshot, used by the final vfs_final diff. */
  initialFiles: ArtifactFiles;
  kvLossy: boolean;
};

const KEY_PREFIX = "ollchat:stream";
// We keep events for 3 days regardless of stream state — long enough for a
// user to come back to a finished chat or artifact build after a weekend or
// a phone reboot, but bounded so Redis doesn't pile up indefinitely.
const RUNNING_TTL_SECONDS = 3 * 24 * 60 * 60;
const COMPLETED_TTL_SECONDS = 3 * 24 * 60 * 60;

let cached: Redis | null = null;
let cachedError: Error | null = null;

// Vercel injects different env var names depending on how Redis was
// provisioned: `UPSTASH_REDIS_REST_*` for the Upstash-branded Marketplace
// integration, `KV_REST_API_*` for the older Vercel KV / Marketplace KV
// flow. Accept both so users don't have to duplicate the secrets.
function readRedisCreds(): { url?: string; token?: string } {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  };
}

function getRedis(): Redis {
  if (cached) return cached;
  if (cachedError) throw cachedError;
  const { url, token } = readRedisCreds();
  if (!url || !token) {
    cachedError = new Error(
      "Resumable streams need Redis credentials. Provision an Upstash Redis (or Vercel KV) " +
        "database and expose either UPSTASH_REDIS_REST_URL+UPSTASH_REDIS_REST_TOKEN or " +
        "KV_REST_API_URL+KV_REST_API_TOKEN to the project."
    );
    throw cachedError;
  }
  cached = new Redis({ url, token });
  return cached;
}

export function isStreamStoreConfigured(): boolean {
  const { url, token } = readRedisCreds();
  return !!(url && token);
}

// ---- Image caption cache ----------------------------------------------------
// The client re-sends every prior turn's images on every send (so the model
// keeps the full multimodal history). For a text-only main model that means the
// vision describer would otherwise re-caption the SAME images on every turn - a
// slow (tens of seconds) call repeated for the life of the chat. We cache each
// caption keyed by image content + describer model + detail level so a re-seen
// image reuses its caption instantly instead of re-running the describer.
const CAPTION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function captionKey(hash: string): string {
  return `${KEY_PREFIX}:caption:${hash}`;
}

/** Stable cache key for an image caption: image bytes + describer model +
 *  detail level, so a re-seen image reuses its caption only when all three
 *  match. Shared by the chat worker and the framing preprocessor. */
export function captionCacheKey(
  base64: string,
  describerModel: string,
  detail: string | undefined
): string {
  return createHash("sha256")
    .update(`${describerModel} ${detail ?? "standard"} ${base64}`)
    .digest("hex");
}

/** Look up a previously computed caption. Best-effort: returns null when Redis
 *  isn't configured or the read fails, so the caller just describes normally. */
export async function getCachedCaption(hash: string): Promise<string | null> {
  if (!isStreamStoreConfigured()) return null;
  try {
    const redis = getRedis();
    const raw = await redis.get<string>(captionKey(hash));
    return typeof raw === "string" ? raw : null;
  } catch (err) {
    console.warn("[caption-cache] read failed", err);
    return null;
  }
}

/** Persist a caption for re-use on later turns. Best-effort and non-throwing. */
export async function setCachedCaption(hash: string, caption: string): Promise<void> {
  if (!isStreamStoreConfigured() || !caption) return;
  try {
    const redis = getRedis();
    await redis.set(captionKey(hash), caption, { ex: CAPTION_TTL_SECONDS });
  } catch (err) {
    console.warn("[caption-cache] write failed", err);
  }
}

function eventsKey(streamId: string): string {
  return `${KEY_PREFIX}:${streamId}:events`;
}

function metaKey(streamId: string): string {
  return `${KEY_PREFIX}:${streamId}:meta`;
}

function checkpointKey(streamId: string): string {
  return `${KEY_PREFIX}:${streamId}:checkpoint`;
}

function workerLockKey(streamId: string, seq: number): string {
  return `${KEY_PREFIX}:${streamId}:lock:${seq}`;
}

function queueKey(streamId: string): string {
  return `${KEY_PREFIX}:${streamId}:queue`;
}

/**
 * A user message the client posted while a stream was already in flight.
 * The chat worker drains these between turns and processes them as a fresh
 * user turn within the SAME Redis stream — that's how the frontend gets a
 * "fire and forget" send while another response is still being generated.
 */
export type QueuedUserMsg = {
  id: string;
  content: string;
  images?: {
    id?: string;
    dataUrl: string;
    mime?: string;
    name?: string;
    /** Client-cached describer caption (IndexedDB); reused server-side to skip
     *  re-describing the same image. */
    description?: string;
  }[];
  pdfs?: {
    id?: string;
    name: string;
    pageCount: number;
    text: string;
    truncated?: boolean;
  }[];
  csvs?: {
    id?: string;
    name: string;
    rowCount: number;
    columnCount: number;
    text: string;
    truncated?: boolean;
  }[];
  createdAt: number;
};

function tracesKey(streamId: string): string {
  return `${KEY_PREFIX}:${streamId}:traces`;
}

/**
 * Per-stream chain trace. Every chained worker emits these milestones so a
 * post-mortem reader (the resume route's stale-detection branch, the admin
 * error log) can show exactly which worker ran when, whether the handoff
 * actually fired, and how the chain consumed its 15-minute budget.
 *
 * Stored as a Redis list (RPUSH on append, LRANGE on read) keyed separately
 * from `meta` so two workers writing concurrently across a handoff window
 * don't race on a read-modify-write of the meta blob.
 */
export type WorkerTraceKind =
  | "worker_started"
  | "deadline_armed"
  | "deadline_fired"
  // Heartbeat detected the main flow didn't claim the handoff within the
  // grace window after `deadline_fired` and forced it from out-of-band.
  // Distinct from `deadline_fired` so a post-mortem can tell apart "polite
  // handoff after the for-await woke up on abort" from "main flow was
  // truly wedged and the heartbeat had to take over."
  | "heartbeat_forced_handoff"
  | "handoff_initiated"
  | "handoff_endpoint_ok"
  | "handoff_endpoint_failed"
  | "worker_finished"
  // Plan-mode orchestrator milestones. Surfaced in the chain trace so a
  // post-mortem can tell which workers ran plan-mode vs. the regular round
  // loop, where the orchestrator handed off, and whether the chain
  // exhausted with the user-facing plan-paused state.
  | "plan_mode_entered"
  | "plan_handoff"
  | "plan_paused";

export type WorkerTraceEvent = {
  kind: WorkerTraceKind;
  seq: number;
  ts: number;
  /** Small structured detail. Keep cheap — counters, durations, ids. */
  detail?: Record<string, string | number | boolean>;
};

// 50 ≫ 6 events per worker × 5 workers (research max). Caps storage if
// something pathological starts emitting in a loop.
const MAX_TRACE_EVENTS = 50;

/** Best-effort append. Trace is diagnostic — never throws. */
export async function appendWorkerTrace(
  streamId: string,
  event: WorkerTraceEvent
): Promise<void> {
  try {
    const redis = getRedis();
    const key = tracesKey(streamId);
    await redis.rpush(key, JSON.stringify(event));
    await redis.ltrim(key, -MAX_TRACE_EVENTS, -1);
    // Match the events buffer TTL so traces survive as long as the rest of
    // the resume window. No lazy refresh — trace volume is tiny vs. events.
    await redis.expire(key, RUNNING_TTL_SECONDS);
  } catch (err) {
    console.warn(`[chat ${streamId}] appendWorkerTrace failed`, err);
  }
}

export async function getWorkerTraces(
  streamId: string
): Promise<WorkerTraceEvent[]> {
  try {
    const redis = getRedis();
    const raw = await redis.lrange<string>(tracesKey(streamId), 0, -1);
    const out: WorkerTraceEvent[] = [];
    for (const r of raw ?? []) {
      if (typeof r !== "string") {
        out.push(r as unknown as WorkerTraceEvent);
        continue;
      }
      try {
        out.push(JSON.parse(r) as WorkerTraceEvent);
      } catch {
        // Skip corrupt row.
      }
    }
    return out;
  } catch (err) {
    console.warn(`[chat ${streamId}] getWorkerTraces failed`, err);
    return [];
  }
}

/**
 * Render a per-worker timing summary in two shapes:
 *
 *   .multiline (admin error log + server console):
 *     worker 1: 250s (deadline-fired, handoff-ok, handoff)
 *     worker 2: 250s (deadline-fired, handoff-ok, handoff)
 *     worker 3: 305s (still-running)
 *     total: 805s across 3 worker(s)
 *
 *   .inline   (user-facing chat error — the Chat UI renders the message in a
 *              single inline span where newlines collapse, so we need a one-
 *              liner that still proves the chain ran):
 *     worker 1 250s (deadline-fired, handoff-ok); worker 2 250s
 *     (deadline-fired, handoff-ok); worker 3 305s (still-running); total
 *     805s across 3 workers
 */
export function summarizeWorkerTraces(
  events: WorkerTraceEvent[]
): { multiline: string; inline: string } {
  if (events.length === 0) {
    return { multiline: "(no chain trace recorded)", inline: "no chain trace recorded" };
  }
  type Agg = {
    started?: number;
    finished?: number;
    handoffOk?: boolean;
    handoffFailed?: boolean;
    deadlineFired?: boolean;
    reason?: string;
  };
  const bySeq = new Map<number, Agg>();
  for (const ev of events) {
    let agg = bySeq.get(ev.seq);
    if (!agg) {
      agg = {};
      bySeq.set(ev.seq, agg);
    }
    if (ev.kind === "worker_started") agg.started = ev.ts;
    if (ev.kind === "worker_finished") {
      agg.finished = ev.ts;
      const reason = ev.detail?.reason;
      if (typeof reason === "string") agg.reason = reason;
    }
    if (ev.kind === "deadline_fired") agg.deadlineFired = true;
    if (ev.kind === "handoff_endpoint_ok") agg.handoffOk = true;
    if (ev.kind === "handoff_endpoint_failed") agg.handoffFailed = true;
  }
  const seqs = Array.from(bySeq.keys()).sort((a, b) => a - b);
  const now = Date.now();
  const lines: string[] = [];
  const inlineParts: string[] = [];
  for (const seq of seqs) {
    const agg = bySeq.get(seq)!;
    const startedAt = agg.started;
    if (startedAt == null) {
      lines.push(`  worker ${seq}: (no start record)`);
      inlineParts.push(`worker ${seq} (no start record)`);
      continue;
    }
    const endAt = agg.finished ?? now;
    const dur = Math.max(0, Math.round((endAt - startedAt) / 1000));
    const tags: string[] = [];
    if (agg.deadlineFired) tags.push("deadline-fired");
    if (agg.handoffOk) tags.push("handoff-ok");
    if (agg.handoffFailed) tags.push("handoff-failed");
    if (agg.reason) tags.push(agg.reason);
    if (!agg.finished) tags.push("still-running");
    const tagStr = tags.length ? ` (${tags.join(", ")})` : "";
    lines.push(`  worker ${seq}: ${dur}s${tagStr}`);
    inlineParts.push(`worker ${seq} ${dur}s${tagStr}`);
  }
  const firstStart = events.find((e) => e.kind === "worker_started")?.ts;
  const lastTs = events[events.length - 1]?.ts;
  if (firstStart != null && lastTs != null) {
    const total = Math.max(0, Math.round((lastTs - firstStart) / 1000));
    lines.push(`  total: ${total}s across ${seqs.length} worker(s)`);
    inlineParts.push(`total ${total}s across ${seqs.length} worker${seqs.length === 1 ? "" : "s"}`);
  }
  return { multiline: lines.join("\n"), inline: inlineParts.join("; ") };
}

// Refresh the events-list TTL at most once per minute per stream. The TTL
// itself is 6h; refreshing every 60s leaves several orders of magnitude of
// headroom and turns the "RPUSH + EXPIRE per append" pattern into "RPUSH per
// append + EXPIRE every ~60s of activity". On a minute-long chat with the
// 1s flush window that's 60 RPUSHes + ~1 EXPIRE instead of 60 + 60, halving
// Upstash command usage on the hot streaming path. The per-process Map
// resets when the lambda cold-starts, which just means the next worker
// spends one EXPIRE on its first append — still bounded.
const EXPIRE_REFRESH_INTERVAL_MS = 60_000;
const lastEventsExpireAt = new Map<string, number>();

async function maybeRefreshEventsExpire(streamId: string): Promise<void> {
  const now = Date.now();
  const last = lastEventsExpireAt.get(streamId) ?? 0;
  if (now - last < EXPIRE_REFRESH_INTERVAL_MS) return;
  lastEventsExpireAt.set(streamId, now);
  const redis = getRedis();
  try {
    await redis.expire(eventsKey(streamId), RUNNING_TTL_SECONDS);
  } catch (err) {
    // Roll back the timestamp so the next append retries the refresh.
    lastEventsExpireAt.delete(streamId);
    throw err;
  }
}

/**
 * Per-RPUSH payload budget. Upstash's REST API caps a single request body at
 * ~1 MB (same constraint share-store.ts:25 and chat-share-store.ts:21 acknowledge).
 * 700 KB leaves headroom for the JSON command envelope, auth headers, and
 * per-element quoting overhead. Batches that would exceed this get split into
 * multiple RPUSHes; a single text event larger than this gets split into
 * multiple same-kind events whose text the client concatenates transparently.
 *
 * Without this guard, a long `thinking` chunk (some reasoning models emit
 * thousands of characters per stream tick) or a 1-second batch of accumulated
 * deltas would 413 the entire RPUSH; the retry loop in chat/work.ts re-sends
 * the SAME oversized payload three times, all fail, and the worker silently
 * drops the whole batch. The user sees the assistant message cut off mid-word
 * with no error — exactly the bug this ceiling exists to prevent.
 */
const MAX_RPUSH_BYTES = 700_000;

/** Event kinds whose `data.text` can be split across multiple events without
 *  changing client semantics — chat.tsx concatenates these on receipt. */
const SPLITTABLE_TEXT_EVENTS = new Set(["thinking", "delta", "artifact_delta"]);

function isSplittableTextEvent(
  ev: SseEvent
): ev is SseEvent & { data: { text: string } } {
  if (!SPLITTABLE_TEXT_EVENTS.has(ev.event)) return false;
  const data = ev.data as { text?: unknown } | null;
  return !!data && typeof data.text === "string";
}

/** Pre-serialize an event and, if the encoded form exceeds the per-RPUSH
 *  budget AND the event kind is text-splittable, break its text into multiple
 *  events of the same kind so each fits. Non-splittable oversize events are
 *  returned as-is and will fail the RPUSH loudly — better than silent drop. */
function prepareForRpush(ev: SseEvent): string[] {
  const encoded = JSON.stringify(ev);
  if (encoded.length <= MAX_RPUSH_BYTES) return [encoded];
  if (!isSplittableTextEvent(ev)) return [encoded];

  // Split the text into chunks small enough that each re-serialized event
  // fits under the budget. Use half the budget per chunk to leave room for
  // the surrounding JSON wrapper and any other fields on `data`.
  const chunkChars = Math.max(1, Math.floor(MAX_RPUSH_BYTES / 2));
  const text = ev.data.text;
  const out: string[] = [];
  for (let i = 0; i < text.length; i += chunkChars) {
    out.push(
      JSON.stringify({
        event: ev.event,
        data: { ...ev.data, text: text.slice(i, i + chunkChars) },
      })
    );
  }
  return out;
}

/** Append an SSE event to the buffer and (lazily) refresh TTL. */
export async function appendEvent(streamId: string, event: SseEvent): Promise<void> {
  await appendEvents(streamId, [event]);
}

/** Append many events and (lazily) refresh TTL. Splits across multiple RPUSH
 *  calls when the batch would exceed Upstash's per-request payload limit. */
export async function appendEvents(streamId: string, events: SseEvent[]): Promise<void> {
  if (events.length === 0) return;
  const redis = getRedis();
  const ek = eventsKey(streamId);

  const encoded: string[] = [];
  for (const ev of events) {
    for (const piece of prepareForRpush(ev)) encoded.push(piece);
  }

  let chunk: string[] = [];
  let chunkBytes = 0;
  for (const piece of encoded) {
    // +2 for inter-element JSON overhead (comma + quoting headroom).
    const pieceBytes = piece.length + 2;
    if (chunk.length > 0 && chunkBytes + pieceBytes > MAX_RPUSH_BYTES) {
      await redis.rpush(ek, ...chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(piece);
    chunkBytes += pieceBytes;
  }
  if (chunk.length > 0) await redis.rpush(ek, ...chunk);

  await maybeRefreshEventsExpire(streamId);
}

/** Read events from `cursor` to the tail (inclusive). */
export async function getEvents(streamId: string, cursor: number): Promise<SseEvent[]> {
  const redis = getRedis();
  const raw = await redis.lrange<string>(eventsKey(streamId), cursor, -1);
  const out: SseEvent[] = [];
  for (const r of raw) {
    if (typeof r !== "string") {
      // Upstash auto-deserializes JSON in some configs; tolerate both.
      out.push(r as unknown as SseEvent);
      continue;
    }
    try {
      out.push(JSON.parse(r) as SseEvent);
    } catch {
      // Skip corrupt entry — never break the resume loop on one bad row.
    }
  }
  return out;
}

/** Total events recorded so far. */
export async function getEventCount(streamId: string): Promise<number> {
  const redis = getRedis();
  return await redis.llen(eventsKey(streamId));
}

export async function setMeta(streamId: string, meta: StreamMeta): Promise<void> {
  const redis = getRedis();
  const mk = metaKey(streamId);
  const ttl = meta.status === "running" ? RUNNING_TTL_SECONDS : COMPLETED_TTL_SECONDS;
  // Folding the meta-key TTL into SET drops one billed command per call.
  // We deliberately DON'T touch the events list TTL here: appendEvents
  // refreshes it lazily during the streaming path (which is the only time
  // the resume buffer matters), and on streams that never produce events
  // the list never gets created — so the EXPIRE was a billed no-op anyway.
  // RUNNING and COMPLETED TTLs are equal (6h) so no end-of-stream gap to fill.
  await redis.set(mk, JSON.stringify(meta), { ex: ttl });
}

export async function getMeta(streamId: string): Promise<StreamMeta | null> {
  const redis = getRedis();
  const raw = await redis.get<string | StreamMeta>(metaKey(streamId));
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as StreamMeta;
    } catch {
      return null;
    }
  }
  return raw;
}

/** Persist a chat worker checkpoint. Same TTL as the events buffer so the
 *  resume window and the chain-handoff window stay aligned. */
export async function saveCheckpoint(streamId: string, cp: Checkpoint): Promise<void> {
  const redis = getRedis();
  await redis.set(checkpointKey(streamId), JSON.stringify(cp), {
    ex: RUNNING_TTL_SECONDS,
  });
}

export async function loadCheckpoint(streamId: string): Promise<Checkpoint | null> {
  const redis = getRedis();
  const raw = await redis.get<string | Checkpoint>(checkpointKey(streamId));
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Checkpoint;
    } catch {
      return null;
    }
  }
  return raw;
}

/**
 * Atomic "claim" of a continuation slot: if the first worker fires its
 * fire-and-forget continue twice (or a network retry duplicates the POST),
 * only the first acquirer proceeds. The lock TTL outlives a worker's
 * maxDuration so it self-evicts after the chain finishes.
 */
export async function tryAcquireWorkerSlot(
  streamId: string,
  seq: number
): Promise<boolean> {
  const redis = getRedis();
  const ok = await redis.set(workerLockKey(streamId, seq), "1", {
    nx: true,
    ex: 600,
  });
  return ok === "OK";
}

/**
 * Push a user message into the per-stream queue. Drained by the chat worker
 * between turns and emitted as a fresh user_turn / assistant_turn pair into
 * the same SSE stream the client is reading.
 */
export async function appendQueuedMessage(
  streamId: string,
  msg: QueuedUserMsg
): Promise<void> {
  const redis = getRedis();
  await redis.rpush(queueKey(streamId), JSON.stringify(msg));
  await redis.expire(queueKey(streamId), RUNNING_TTL_SECONDS);
}

/**
 * Atomically pull every queued message and clear the slot. Returns [] when
 * the queue is empty / missing. Worker calls this between turns; coalescing
 * (concatenating multiple entries into one user turn) is the worker's job.
 */
export async function drainQueue(streamId: string): Promise<QueuedUserMsg[]> {
  const redis = getRedis();
  const k = queueKey(streamId);
  const raw = await redis.lrange<string>(k, 0, -1);
  if (!raw || raw.length === 0) return [];
  // Best-effort: clear after read. A failure here just means the next drain
  // sees the same entries — the worker's coalesce step is idempotent on the
  // SSE side because each entry has a unique id.
  try {
    await redis.del(k);
  } catch (err) {
    console.warn(`[stream-store ${streamId}] queue del failed`, err);
  }
  const out: QueuedUserMsg[] = [];
  for (const r of raw) {
    if (typeof r !== "string") {
      out.push(r as unknown as QueuedUserMsg);
      continue;
    }
    try {
      out.push(JSON.parse(r) as QueuedUserMsg);
    } catch {
      // Skip a corrupt entry — never break the worker on one bad row.
    }
  }
  return out;
}

/** Drop the queue slot — called by the queue endpoint when the stream has
 *  already terminated, so it can return cleanly without dangling state. */
export async function clearQueue(streamId: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.del(queueKey(streamId));
  } catch (err) {
    console.warn(`[stream-store ${streamId}] queue clear failed`, err);
  }
}

// ---- worker job queue ---------------------------------------------------
// Off-Vercel worker pattern: POST /api/chat saves a JobPayload + LPUSHes
// the streamId onto a single shared queue; the Fly.io worker BRPOPs and
// rehydrates the payload. Distinct from the per-stream `queue` slot above
// (that one carries follow-up user messages within an already-running
// stream — this one carries the initial "start a new stream" request).

const JOBS_KEY = "ollchat:jobs";

/**
 * Pure-JSON shape of the args needed for the initial runChatWork() call.
 * The worker imports the live `VfsContext`/`IncomingMsg` types and
 * reconstructs Set fields on load — only this serializable variant ever
 * touches Redis.
 */
export type JobPayload = {
  v: 1;
  conv: OllamaMessage[];
  /** Null when the response format doesn't use VFS. `readPaths` is an
   *  array here (Set on the live object) so it round-trips through JSON. */
  vfsCtx:
    | (Omit<VfsCheckpoint, "files"> & { files: ArtifactFiles })
    | null;
  initialFiles: ArtifactFiles;
  cfg: Checkpoint["cfg"];
  /** Raw incoming messages with images/PDFs — preprocessing happens inside
   *  runChatWork on `skipPreprocessing: false`. */
  incoming: unknown[];
  /** Plan-continue / chain-resume payload. When present, the worker calls
   *  runChatWork with skipPreprocessing=true and the parser/flags/totals
   *  hydrated from a saved checkpoint instead of starting from scratch.
   *  Lets a user-clicked Continue plan in Fly mode resume on Fly instead
   *  of falling back to a Vercel waitUntil. */
  resume?: {
    parser: Checkpoint["parser"];
    totals: Checkpoint["totals"];
    flags: Checkpoint["flags"];
    kvLossy: boolean;
  };
};

function jobPayloadKey(streamId: string): string {
  return `${KEY_PREFIX}:${streamId}:job`;
}

/** Persist the initial-job payload. Same TTL window as the events buffer
 *  so a stranded job ages out alongside its stream. */
export async function saveJobPayload(
  streamId: string,
  payload: JobPayload
): Promise<void> {
  const redis = getRedis();
  await redis.set(jobPayloadKey(streamId), JSON.stringify(payload), {
    ex: RUNNING_TTL_SECONDS,
  });
}

export async function loadJobPayload(
  streamId: string
): Promise<JobPayload | null> {
  const redis = getRedis();
  const raw = await redis.get<string | JobPayload>(jobPayloadKey(streamId));
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as JobPayload;
    } catch {
      return null;
    }
  }
  return raw;
}

/** Drop the job payload — called by the worker after a successful
 *  rehydrate so a Redis snapshot doesn't pile up. Best-effort. */
export async function deleteJobPayload(streamId: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.del(jobPayloadKey(streamId));
  } catch (err) {
    console.warn(`[stream-store ${streamId}] job-payload del failed`, err);
  }
}

/** LPUSH the streamId onto the shared worker queue. Pair with `wakeWorker()`
 *  in app/lib/fly-wake.ts so a stopped Fly machine boots within ~1-3s. */
export async function enqueueJob(streamId: string): Promise<void> {
  const redis = getRedis();
  await redis.lpush(JOBS_KEY, streamId);
}

/**
 * Worker-side: non-blocking pop of a streamId. Upstash's REST SDK
 * doesn't expose blocking commands (BRPOP holds an HTTP request open
 * server-side, which doesn't fit a stateless REST surface), so the
 * worker polls this in a loop with a short sleep on null returns and
 * drives its idle-exit clock from the same null returns.
 *
 * LPUSH on the enqueue side + RPOP here gives FIFO order, matching the
 * BRPOP/LPUSH idiom used elsewhere in stream-store.
 */
export async function popJob(): Promise<string | null> {
  const redis = getRedis();
  const result = await redis.rpop<string>(JOBS_KEY);
  return typeof result === "string" ? result : null;
}

// ---- council job queue ---------------------------------------------------
// Same enqueue-and-wake pattern as the chat job queue, but for a council run.
// POST /api/council/run saves a CouncilJobPayload, LPUSHes the streamId, and
// wakes the Fly worker; the worker RPOPs and runs runCouncilWork() to
// completion. The council emits the same SSE event shapes the chat consumer
// already drains, so the client reads it via /api/chat/resume/{streamId}
// unchanged. Why off Vercel: a multi-member × multi-round debate plus the
// verifier and synthesizer can blow the route's 300s wall clock — the Fly
// worker has no per-request cap.

const COUNCIL_JOBS_KEY = "ollchat:council-jobs";

/** Pure-JSON args for a single runCouncilWork() call (everything except the
 *  streamId, which travels on the queue). Mirrors RunCouncilWorkOpts — kept
 *  serializable so it round-trips through Redis. */
export type CouncilJobPayload = {
  v: 1;
  conv: OllamaMessage[];
  members: CouncilMember[];
  situationId: string;
  framing: CouncilFramingPayload | undefined;
  debateRounds: number;
  synthesizerModel: string;
  runpodEndpointId?: string;
  publicOrigin: string;
};

function councilJobKey(streamId: string): string {
  return `${KEY_PREFIX}:${streamId}:council-job`;
}

/** Persist the council-job payload. Same TTL window as the events buffer so a
 *  stranded job ages out alongside its stream. */
export async function saveCouncilJob(
  streamId: string,
  payload: CouncilJobPayload
): Promise<void> {
  const redis = getRedis();
  await redis.set(councilJobKey(streamId), JSON.stringify(payload), {
    ex: RUNNING_TTL_SECONDS,
  });
}

export async function loadCouncilJob(
  streamId: string
): Promise<CouncilJobPayload | null> {
  const redis = getRedis();
  const raw = await redis.get<string | CouncilJobPayload>(
    councilJobKey(streamId)
  );
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as CouncilJobPayload;
    } catch {
      return null;
    }
  }
  return raw;
}

/** Drop the council-job payload — called by the worker after a successful
 *  load so a Redis snapshot doesn't pile up. Best-effort. */
export async function deleteCouncilJob(streamId: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.del(councilJobKey(streamId));
  } catch (err) {
    console.warn(`[stream-store ${streamId}] council-job del failed`, err);
  }
}

/** LPUSH the streamId onto the shared council-job queue. Pair with
 *  `wakeWorker()` so a stopped Fly machine boots within ~1-3s. */
export async function enqueueCouncilJob(streamId: string): Promise<void> {
  const redis = getRedis();
  await redis.lpush(COUNCIL_JOBS_KEY, streamId);
}

/** Worker-side non-blocking pop, mirroring popJob(). LPUSH + RPOP ⇒ FIFO. */
export async function popCouncilJob(): Promise<string | null> {
  const redis = getRedis();
  const result = await redis.rpop<string>(COUNCIL_JOBS_KEY);
  return typeof result === "string" ? result : null;
}

// ---- artifact.query() job queue ------------------------------------------
// Same enqueue-and-wake pattern as the chat job queue above, but for the
// single-shot data fetches `artifact.query()` issues. POST /api/query saves a
// QueryJobPayload, LPUSHes the streamId, and wakes the Fly worker; the worker
// RPOPs, runs executeQuery() to completion, and writes the JSON back as the
// same `result` event + meta the in-process waitUntil path used to write. The
// iframe reads it via GET /api/query/resume/{streamId} exactly as before.
//
// Why move the producer off Vercel: the waitUntil path is bounded by the
// route's maxDuration (~300s) and dies with the serverless function when the
// phone sleeps mid-flight. The Fly worker has no per-request wall clock, so a
// query started before the user backgrounds the app still lands in Redis for
// them to pick up on return. Reuses the per-stream events/meta keys (so the
// resume route and the pendingQuery recovery sweep need no changes) — only the
// job payload + queue live under their own keys.

const QUERY_JOBS_KEY = "ollchat:query-jobs";

/** Pure-JSON args for a single executeQuery() call. Mirrors QueryInput in
 *  app/lib/executors.ts plus the appId used for rate-limit / error-log
 *  attribution. */
export type QueryJobPayload = {
  v: 1;
  prompt: string;
  schema?: unknown;
  model?: string;
  webSearch?: boolean;
  system?: string;
  /** Route to the deep multi-agent research engine instead of executeQuery. */
  research?: boolean;
  /** MCP connectors to expose to the run (URL + key + discovered tools). Carried
   *  through Redis so the Fly worker runs a source's mcp:true query with the
   *  same connectors the interactive path would. Same transient trust model as
   *  the chat stream's mcpConnectors. */
  connectors?: McpRuntimeConnector[];
  appId?: string;
};

function queryJobKey(streamId: string): string {
  return `${KEY_PREFIX}:${streamId}:query-job`;
}

/** Persist the query-job payload. Same TTL window as the events buffer so a
 *  stranded job ages out alongside its stream. */
export async function saveQueryJob(
  streamId: string,
  payload: QueryJobPayload
): Promise<void> {
  const redis = getRedis();
  await redis.set(queryJobKey(streamId), JSON.stringify(payload), {
    ex: RUNNING_TTL_SECONDS,
  });
}

export async function loadQueryJob(
  streamId: string
): Promise<QueryJobPayload | null> {
  const redis = getRedis();
  const raw = await redis.get<string | QueryJobPayload>(queryJobKey(streamId));
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as QueryJobPayload;
    } catch {
      return null;
    }
  }
  return raw;
}

/** Drop the query-job payload — called by the worker after a successful
 *  load so a Redis snapshot doesn't pile up. Best-effort. */
export async function deleteQueryJob(streamId: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.del(queryJobKey(streamId));
  } catch (err) {
    console.warn(`[stream-store ${streamId}] query-job del failed`, err);
  }
}

/** LPUSH the streamId onto the shared query-job queue. Pair with
 *  `wakeWorker()` so a stopped Fly machine boots within ~1-3s. */
export async function enqueueQueryJob(streamId: string): Promise<void> {
  const redis = getRedis();
  await redis.lpush(QUERY_JOBS_KEY, streamId);
}

/** Worker-side non-blocking pop, mirroring popJob(). LPUSH + RPOP ⇒ FIFO. */
export async function popQueryJob(): Promise<string | null> {
  const redis = getRedis();
  const result = await redis.rpop<string>(QUERY_JOBS_KEY);
  return typeof result === "string" ? result : null;
}

// ---- scheduled research-run queue ----------------------------------------
// Research-enabled schedules (artifact apps that re-run the deep engine on a
// cadence — and their manual "Run now") hand off to the Fly worker instead of
// running inline in the cron sweep / Run-now route, which are bounded by
// maxDuration and would time out on a multi-minute research run. The job is
// keyed by appId; the worker runs runScheduledTask(appId, task, { onWorker:true })
// to completion and writes the result into the schedule store (same path the
// inline runner uses), so the artifact's onScheduleUpdate / scheduled() picks
// it up. Re-keying by appId means a second dispatch overwrites rather than
// piling up payloads.
const SCHEDULE_JOBS_KEY = "ollchat:schedule-jobs";

export type ScheduleJobPayload = { v: 1; appId: string; task: ScheduledTask };

function scheduleJobKey(appId: string): string {
  return `${KEY_PREFIX}:schedule-job:${appId}`;
}

export async function saveScheduleJob(appId: string, task: ScheduledTask): Promise<void> {
  const redis = getRedis();
  const payload: ScheduleJobPayload = { v: 1, appId, task };
  await redis.set(scheduleJobKey(appId), JSON.stringify(payload), {
    ex: RUNNING_TTL_SECONDS,
  });
}

export async function loadScheduleJob(appId: string): Promise<ScheduleJobPayload | null> {
  const redis = getRedis();
  const raw = await redis.get<string | ScheduleJobPayload>(scheduleJobKey(appId));
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ScheduleJobPayload;
    } catch {
      return null;
    }
  }
  return raw;
}

export async function deleteScheduleJob(appId: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.del(scheduleJobKey(appId));
  } catch (err) {
    console.warn(`[stream-store ${appId}] schedule-job del failed`, err);
  }
}

export async function enqueueScheduleJob(appId: string): Promise<void> {
  const redis = getRedis();
  await redis.lpush(SCHEDULE_JOBS_KEY, appId);
}

export async function popScheduleJob(): Promise<string | null> {
  const redis = getRedis();
  const result = await redis.rpop<string>(SCHEDULE_JOBS_KEY);
  return typeof result === "string" ? result : null;
}

// ---- artifact.exec() / run_code job queue --------------------------------
// Same enqueue-and-wake pattern as the query queue, for the code-execution
// sandbox runs `artifact.exec()` issues from a saved app. POST /api/exec saves
// an ExecJobPayload, LPUSHes the streamId, and wakes the Fly worker (where the
// interpreters + ffmpeg live); the worker RPOPs, runs executeCode() to
// completion, and writes the result back as the same `result` event + meta the
// iframe reads via GET /api/exec/resume/{streamId}. Unlike query there's no
// in-process fallback — the interpreters don't exist on Vercel — so /api/exec
// requires Fly to be configured.

const EXEC_JOBS_KEY = "ollchat:exec-jobs";

/** Pure-JSON args for one executeCode() call. Mirrors CodeInput in
 *  app/lib/executors.ts plus appId for rate-limit / error-log attribution. */
export type ExecJobPayload = {
  v: 1;
  language: "python" | "node";
  code: string;
  stdin?: string;
  /** Files the app passed in: name + a blob URL the worker downloads into the
   *  run workspace. */
  inputFiles?: AttachedFile[];
  /** Blob namespace where produced outputs are stored. */
  userHash: string;
  timeoutMs?: number;
  appId?: string;
};

function execJobKey(streamId: string): string {
  return `${KEY_PREFIX}:${streamId}:exec-job`;
}

export async function saveExecJob(
  streamId: string,
  payload: ExecJobPayload
): Promise<void> {
  const redis = getRedis();
  await redis.set(execJobKey(streamId), JSON.stringify(payload), {
    ex: RUNNING_TTL_SECONDS,
  });
}

export async function loadExecJob(
  streamId: string
): Promise<ExecJobPayload | null> {
  const redis = getRedis();
  const raw = await redis.get<string | ExecJobPayload>(execJobKey(streamId));
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ExecJobPayload;
    } catch {
      return null;
    }
  }
  return raw;
}

export async function deleteExecJob(streamId: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.del(execJobKey(streamId));
  } catch (err) {
    console.warn(`[stream-store ${streamId}] exec-job del failed`, err);
  }
}

export async function enqueueExecJob(streamId: string): Promise<void> {
  const redis = getRedis();
  await redis.lpush(EXEC_JOBS_KEY, streamId);
}

/** Worker-side non-blocking pop, mirroring popQueryJob(). */
export async function popExecJob(): Promise<string | null> {
  const redis = getRedis();
  const result = await redis.rpop<string>(EXEC_JOBS_KEY);
  return typeof result === "string" ? result : null;
}

// ---- structured-research run queue ---------------------------------------
// Chat "Structured research" runs the deep-research engine, which can take
// minutes — too long for a Vercel function. POST /api/research/structured/run
// saves a job, LPUSHes the streamId, and wakes the Fly worker; the worker runs
// runStructuredResearch() and writes the {columns, schema, records} payload back
// as the same `result` event /api/query/resume reads, so the in-chat viewer
// polls it with the exact same resume path as artifact.query. Per-stream keyed.

const RESEARCH_RUN_JOBS_KEY = "ollchat:research-run-jobs";

export type ResearchRunJobPayload = {
  v: 1;
  /** Which engine the worker should run. Absent ⇒ "structured" (back-compat
   *  with jobs enqueued before Multi Research existed). "report" runs the
   *  deep-research engine with NO schema → a full markdown report, for a Multi
   *  Research report card. */
  kind?: "structured" | "report";
  /** Structured query, OR — for a "report" job — the research prompt. */
  query: string;
  /** Reused on re-runs so the table shape stays stable; derived on first run. */
  columns?: ResearchColumn[];
  /** Identity columns, reused on re-runs alongside columns. */
  idKeys?: string[];
  /** Existing rows so a re-run finds NEW items. */
  priorRecords?: ResearchRecord[];
  model?: string;
  /** "report" jobs only: short label + research depth (for logging/parity). */
  title?: string;
  depth?: "standard" | "deep";
};

function researchRunJobKey(streamId: string): string {
  return `${KEY_PREFIX}:${streamId}:research-run-job`;
}

export async function saveResearchRunJob(
  streamId: string,
  payload: ResearchRunJobPayload
): Promise<void> {
  const redis = getRedis();
  await redis.set(researchRunJobKey(streamId), JSON.stringify(payload), {
    ex: RUNNING_TTL_SECONDS,
  });
}

export async function loadResearchRunJob(
  streamId: string
): Promise<ResearchRunJobPayload | null> {
  const redis = getRedis();
  const raw = await redis.get<string | ResearchRunJobPayload>(researchRunJobKey(streamId));
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ResearchRunJobPayload;
    } catch {
      return null;
    }
  }
  return raw;
}

export async function deleteResearchRunJob(streamId: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.del(researchRunJobKey(streamId));
  } catch (err) {
    console.warn(`[stream-store ${streamId}] research-run-job del failed`, err);
  }
}

export async function enqueueResearchRunJob(streamId: string): Promise<void> {
  const redis = getRedis();
  await redis.lpush(RESEARCH_RUN_JOBS_KEY, streamId);
}

export async function popResearchRunJob(): Promise<string | null> {
  const redis = getRedis();
  const result = await redis.rpop<string>(RESEARCH_RUN_JOBS_KEY);
  return typeof result === "string" ? result : null;
}

// ---- research-framing job queue ------------------------------------------
// Research framing runs a short LLM tool-loop that drafts scoping questions.
// It's meant to be quick (the framer's own budget is ~40s), but a wedged
// provider / web_fetch call with no timeout can blow past the Vercel
// function's 120s wall clock, leaving the function killed mid-flight and the
// stream stranded at status="running" forever. When the Fly worker is
// configured we run framing there instead — no per-request wall clock, and
// the worker's kill timer is a real backstop. POST /api/research/framing saves
// a job, LPUSHes the streamId, and wakes the worker; the worker runs
// runResearchFraming() and writes the {status, payload} envelope back as the
// single `result` event /api/research/framing/resume reads, so the client's
// resume path is identical no matter which producer ran the job.

const RESEARCH_FRAMING_JOBS_KEY = "ollchat:research-framing-jobs";

export type ResearchFramingJobPayload = {
  v: 1;
  turns: ResearchFramerTurn[];
  framerModel: string;
  runpodEndpointId?: string;
  publicOrigin: string;
};

function researchFramingJobKey(streamId: string): string {
  return `${KEY_PREFIX}:${streamId}:research-framing-job`;
}

export async function saveResearchFramingJob(
  streamId: string,
  payload: ResearchFramingJobPayload
): Promise<void> {
  const redis = getRedis();
  await redis.set(researchFramingJobKey(streamId), JSON.stringify(payload), {
    ex: RUNNING_TTL_SECONDS,
  });
}

export async function loadResearchFramingJob(
  streamId: string
): Promise<ResearchFramingJobPayload | null> {
  const redis = getRedis();
  const raw = await redis.get<string | ResearchFramingJobPayload>(
    researchFramingJobKey(streamId)
  );
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ResearchFramingJobPayload;
    } catch {
      return null;
    }
  }
  return raw;
}

export async function deleteResearchFramingJob(streamId: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.del(researchFramingJobKey(streamId));
  } catch (err) {
    console.warn(`[stream-store ${streamId}] research-framing-job del failed`, err);
  }
}

export async function enqueueResearchFramingJob(streamId: string): Promise<void> {
  const redis = getRedis();
  await redis.lpush(RESEARCH_FRAMING_JOBS_KEY, streamId);
}

export async function popResearchFramingJob(): Promise<string | null> {
  const redis = getRedis();
  const result = await redis.rpop<string>(RESEARCH_FRAMING_JOBS_KEY);
  return typeof result === "string" ? result : null;
}

// ---- artifact image render queue ----------------------------------------
// Same enqueue-and-wake pattern as the chat job queue above, but for
// server-side PNG rendering of artifacts. POST /api/artifact-image saves a
// RenderJob, LPUSHes the jobId, and wakes the Fly worker; the worker RPOPs,
// launches headless Chromium (worker-only — see app/lib/artifact/render-image.ts),
// screenshots the artifact full-page, and writes the PNG back as base64 chunks
// in Redis. The route polls the result key and streams the bytes to the client.
//
// Why Redis chunks instead of Blob: the queue store is already required for
// this feature, the result is consumed within seconds, and chunking keeps each
// write under Upstash's ~1 MB request cap without adding a Blob dependency or
// presigned-URL round trip.

const RENDER_JOBS_KEY = "ollchat:render-jobs";
const RENDER_PREFIX = "ollchat:render";
// Render artifacts age out fast — they're a transient request/response, not a
// resumable stream. 10 minutes is ample for enqueue → render → download.
const RENDER_TTL_SECONDS = 10 * 60;

export type RenderJobPayload = {
  v: 1;
  html: string;
  width: number;
  scale: number;
};

export type RenderResult =
  | { status: "ok"; width: number; height: number }
  | { status: "error"; error: string };

function renderJobKey(jobId: string): string {
  return `${RENDER_PREFIX}:${jobId}:job`;
}
function renderResultKey(jobId: string): string {
  return `${RENDER_PREFIX}:${jobId}:result`;
}
function renderPngKey(jobId: string): string {
  return `${RENDER_PREFIX}:${jobId}:png`;
}

export async function saveRenderJob(
  jobId: string,
  payload: RenderJobPayload
): Promise<void> {
  const redis = getRedis();
  await redis.set(renderJobKey(jobId), JSON.stringify(payload), {
    ex: RENDER_TTL_SECONDS,
  });
}

export async function loadRenderJob(
  jobId: string
): Promise<RenderJobPayload | null> {
  const redis = getRedis();
  const raw = await redis.get<string | RenderJobPayload>(renderJobKey(jobId));
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as RenderJobPayload;
    } catch {
      return null;
    }
  }
  return raw;
}

export async function enqueueRenderJob(jobId: string): Promise<void> {
  const redis = getRedis();
  await redis.lpush(RENDER_JOBS_KEY, jobId);
}

/** Worker-side non-blocking pop, mirroring popJob(). */
export async function popRenderJob(): Promise<string | null> {
  const redis = getRedis();
  const result = await redis.rpop<string>(RENDER_JOBS_KEY);
  return typeof result === "string" ? result : null;
}

/**
 * Worker stores the finished PNG as a single base64 string + a result header.
 *
 * IMPORTANT: the base64 is wrapped with JSON.stringify before SET and parsed
 * back after GET. The shared Upstash client has automatic deserialization ON,
 * and a long *raw* base64 string round-trips CORRUPTED through it — GET returns
 * a truncated/garbled value (verified: a 751 KB base64 string came back as 654
 * chars). JSON-wrapping makes the SET/GET symmetric so the SDK reproduces the
 * string byte-for-byte. (Chunking via RPUSH/LRANGE hit the same corruption.)
 *
 * A 1 MB PNG is ~1.37 MB of base64, under Upstash's request cap, and the route
 * enforces a 2 MB HTML input ceiling so the rendered PNG stays bounded.
 */
export async function setRenderResult(
  jobId: string,
  png: Buffer,
  dims: { width: number; height: number }
): Promise<void> {
  const redis = getRedis();
  await redis.set(renderPngKey(jobId), JSON.stringify(png.toString("base64")), {
    ex: RENDER_TTL_SECONDS,
  });
  const result: RenderResult = {
    status: "ok",
    width: dims.width,
    height: dims.height,
  };
  await redis.set(renderResultKey(jobId), JSON.stringify(result), {
    ex: RENDER_TTL_SECONDS,
  });
}

export async function setRenderError(
  jobId: string,
  error: string
): Promise<void> {
  const redis = getRedis();
  const result: RenderResult = { status: "error", error };
  await redis.set(renderResultKey(jobId), JSON.stringify(result), {
    ex: RENDER_TTL_SECONDS,
  });
}

export async function getRenderResult(
  jobId: string
): Promise<RenderResult | null> {
  const redis = getRedis();
  const raw = await redis.get<string | RenderResult>(renderResultKey(jobId));
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as RenderResult;
    } catch {
      return null;
    }
  }
  return raw;
}

/** Read the PNG bytes for a completed render. */
export async function readRenderPng(jobId: string): Promise<Buffer | null> {
  const redis = getRedis();
  // Stored JSON-wrapped (see setRenderResult). With auto-deserialization the
  // SDK already JSON.parses it back to the raw base64 string; if it ever comes
  // back as the literal JSON ("\"...\"") we unwrap it ourselves.
  const stored = await redis.get<string>(renderPngKey(jobId));
  if (typeof stored !== "string" || stored.length === 0) return null;
  let b64 = stored;
  if (b64.startsWith('"')) {
    try {
      b64 = JSON.parse(b64) as string;
    } catch {
      /* not double-encoded — use as-is */
    }
  }
  try {
    return Buffer.from(b64, "base64");
  } catch {
    return null;
  }
}

/** Best-effort cleanup once the route has streamed the PNG to the client. */
export async function deleteRenderArtifacts(jobId: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.del(renderJobKey(jobId), renderResultKey(jobId), renderPngKey(jobId));
  } catch (err) {
    console.warn(`[stream-store ${jobId}] render cleanup failed`, err);
  }
}

// ---- per-stream scratchpad ----------------------------------------------
// Generic JSON-blob storage scoped to a stream — used by the research
// flow to cache the plan and per-sub-agent briefs across worker handoffs.
// If a 250s deadline fires mid-sub-agent, the next worker reads the cached
// briefs back and only re-issues the ones whose keys are missing.
// Each blob shares the events-list TTL so it ages out with the rest of the
// resume window. `name` should be a small, well-known suffix (e.g.
// "research:round:0:plan" or "novel:outline").

function scratchpadKey(streamId: string, name: string): string {
  return `${KEY_PREFIX}:${streamId}:scratch:${name}`;
}

export async function setStreamScratchpad(
  streamId: string,
  name: string,
  value: unknown
): Promise<void> {
  const redis = getRedis();
  await redis.set(scratchpadKey(streamId, name), JSON.stringify(value), {
    ex: RUNNING_TTL_SECONDS,
  });
}

export async function getStreamScratchpad<T>(
  streamId: string,
  name: string
): Promise<T | null> {
  const redis = getRedis();
  const raw = await redis.get(scratchpadKey(streamId, name));
  if (raw == null) return null;
  if (typeof raw !== "string") return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function clearStreamScratchpad(
  streamId: string,
  name: string
): Promise<void> {
  const redis = getRedis();
  await redis.del(scratchpadKey(streamId, name));
}
