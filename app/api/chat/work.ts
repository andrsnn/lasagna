// The chat generation work loop — extracted so it can run from both the
// initial POST /api/chat handler and the chained POST /api/chat/continue/{id}
// handler. Each invocation maps to one Vercel function (capped at maxDuration).
// When wall time crosses CHAT_HANDOFF_THRESHOLD_MS we serialize state, fire a
// fire-and-forget continuation POST, and exit silently — the next worker picks
// up at the next tool round and emits into the same Redis stream.

import type { Message as OllamaMessage, Tool, ToolCall } from "ollama";
import {
  OUTPUT_RESERVE_TOKENS,
  SUMMARIZE_AT,
  KEEP_TAIL_MESSAGES,
  modelContextTokens,
  modelSupportsVision,
} from "@/app/models";
import { TOOL_LOOP_SUMMARIZE_SYSTEM } from "@/app/lib/llm/summarize-prompt";
import {
  chatClientFor,
  contextWindowFor,
  friendlyErrorFor,
  isTransientErrorFor,
  optionsForModel,
  withRetry,
} from "@/app/lib/llm/router";
import { providerFor } from "@/app/lib/llm/provider";
import {
  MAX_FETCH_CHARS,
  MAX_TOOL_ROUNDS,
  MAX_VFS_ROUNDS,
  VFS_TOOLS,
  VFS_TOOL_NAMES,
  IMAGE_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  ADVANCED_WEB_TOOLS,
  CODE_EXEC_TOOLS,
  executeTool,
  executeVfsTool,
  type VfsContext,
} from "@/app/lib/ollama/tools";
import { NOTE_EDIT_TOOLS } from "@/app/lib/note-canvas/tools";
import { McpSession, executeMcpTool } from "@/app/lib/mcp/client";
import {
  mcpWireName,
  isMcpWireName,
  type McpRuntimeConnector,
} from "@/app/lib/mcp/shared";
import { estimateConvTokens, estimateTokens } from "@/app/lib/tokens";
import {
  ArtifactStreamParser,
  type ArtifactStreamParserState,
} from "@/app/lib/artifact/stream-parser";
import { changesFromDiff } from "@/app/lib/artifact/vfs";
import { buildArtifact } from "@/app/lib/artifact/build";
import { sanitizeUploadFilename } from "@/app/lib/blob-store";
import type { InlineInputFile } from "@/app/lib/exec/sandbox";
import type { ArtifactFiles, AttachedFile } from "@/app/db";
import {
  appendEvents,
  appendQueuedMessage,
  appendWorkerTrace,
  captionCacheKey,
  drainQueue,
  getCachedCaption,
  getMeta,
  saveCheckpoint,
  setCachedCaption,
  setMeta,
  MAX_WORKER_SEQ,
  type Checkpoint,
  type QueuedUserMsg,
  type ResponseFormatLike,
  type SseEvent,
  type WorkerTraceEvent,
} from "@/app/lib/stream-store";
import {
  describePromptFor,
  resolveDescriberModel,
  type DescribeDetail,
} from "@/app/lib/describe-image";
import { hmacSign } from "@/app/api/chat/continue/_sig";
import {
  orchestrateResearch,
  ResearchHandoffNeededError,
} from "@/app/api/chat/research/orchestrator";
import {
  NovelHandoffNeededError,
  orchestrateNovel,
} from "@/app/api/chat/novel/orchestrator";
import type { NovelOutline } from "@/app/api/chat/novel/prompts";
import {
  PlanHandoffNeededError,
  PlanPausedNeedsContinueError,
  orchestratePlan,
} from "@/app/api/chat/plan/orchestrator";
import {
  UserStoppedError,
  clearStopRequest,
  isStopRequested,
} from "@/app/api/chat/stop-flag";

export type IncomingImage = {
  id?: string;
  dataUrl: string;
  mime?: string;
  name?: string;
  /** Caption the client cached from a previous turn's describe_image (stored in
   *  IndexedDB on the AttachedImage). When present, the worker reuses it instead
   *  of re-running the vision describer — the primary fix for a text-only model
   *  re-captioning the same re-sent images on every turn. */
  description?: string;
};
export type IncomingPdf = {
  id?: string;
  name: string;
  pageCount: number;
  text: string;
  truncated?: boolean;
};
export type IncomingCsv = {
  id?: string;
  name: string;
  rowCount: number;
  columnCount: number;
  text: string;
  truncated?: boolean;
};
/** Wire descriptor for a code-execution sandbox file attached to a message:
 *  a pointer to bytes stored in Blob (never the bytes themselves). Mirrors the
 *  client's AttachedFile shape. */
export type IncomingFile = {
  id?: string;
  name: string;
  blobKey: string;
  url: string;
  contentType?: string;
  bytes?: number;
  produced?: boolean;
};

export type IncomingMsg = {
  role: "user" | "assistant" | "system";
  content: string;
  images?: IncomingImage[];
  pdfs?: IncomingPdf[];
  csvs?: IncomingCsv[];
  /** Binary files for the sandbox (user uploads + earlier produced outputs). */
  files?: IncomingFile[];
};

// Same dispatch sets as the original route — kept inline so we don't churn
// imports outside this file. Trimmed to terminal / structurally-significant
// events only: everything else rides the time/size batcher so a chatty
// chat doesn't burn through the Upstash free-tier command budget. The live
// SSE client never blocks on the Redis mirror (events are emitted to it
// before/independently of the flush), so coalescing tool events into the
// next batch only affects the resume-buffer replay timing — not the user's
// perceived streaming latency.
const KV_FLUSH_INSTANT = new Set([
  "vfs_final",
  "error",
  "done",
  // The "Compacting context…" indicator must show the moment compaction
  // starts — the summarizer call is multi-second, so sitting in the 1s batch
  // window would land the start event late (or after the done event).
  "compaction",
  // The client renders the queued user bubble + new assistant slot the moment
  // these arrive, so don't sit in the 1s batcher — flush immediately.
  "user_turn",
  "assistant_turn",
]);

// Per-stream cap on how many queued follow-ups one worker will drain before
// emitting `done`. The queue is durable across worker handoffs, so going over
// this just means the next handoff picks up the remainder; the cap is purely
// a defense against a runaway client posting forever into one stream.
const MAX_QUEUED_TURNS_PER_WORKER = Number(
  process.env.CHAT_MAX_QUEUED_TURNS ?? 6
);

// After a turn finishes naturally we briefly poll for last-second queued
// messages before emitting `done`. The grace covers the race where a queue
// POST is in flight at the exact moment the LLM returns its final token.
const QUEUE_GRACE_TICKS = 4;
const QUEUE_GRACE_INTERVAL_MS = 500;
// Coalesce streamed events into larger batches before mirroring to Redis.
// Each appendEvents call costs at least one Upstash command (RPUSH); we
// also lazily refresh the events-list TTL inside stream-store so the EXPIRE
// is amortized across many appends. A 1s window with a 50-event cap drops
// chat-stream Redis traffic by ~5× vs. the previous 200ms / 10-event tuning
// (the prior values were chosen to match perceived latency, but the live
// SSE client doesn't read out of Redis — it gets events directly from the
// chat-work emit path — so the batch window only governs resume-buffer
// freshness for users who actually disconnect mid-stream). Worker crash
// loses at most one batch (~1s or 50 events) of resume-buffer context;
// terminal events (done / error / vfs_final) still bypass via KV_FLUSH_INSTANT.
const KV_BATCH_INTERVAL_MS = Number(
  process.env.CHAT_KV_BATCH_INTERVAL_MS ?? 1000
);
const KV_BATCH_MAX_EVENTS = Number(
  process.env.CHAT_KV_BATCH_MAX_EVENTS ?? 50
);
const KV_MAX_APPEND_ATTEMPTS = 3;
const KV_APPEND_RETRY_BASE_MS = 100;

type CaptionResult = {
  description: string;
  /** True when the caption came from the cache (no describer call ran). */
  cached: boolean;
  error?: string;
  usage?: { prompt: number; completion: number; evalNs: number; durationNs: number };
};

/**
 * Caption one image, reusing a cached caption when the same bytes were already
 * described with this model + detail level. The client re-sends every prior
 * turn's images on each send, so without this cache a text-only main model
 * would re-run the (tens-of-seconds) describer on every image on every turn.
 *
 * On a cache miss, `onMissStart` fires just before the describer call so the
 * caller can surface the running tool step; cache hits stay silent (the caption
 * is reused instantly) so old images don't replay a fake "describing…" spinner
 * each turn.
 */
async function describeImageCached(args: {
  describer: ReturnType<typeof chatClientFor>;
  describerModel: string;
  describePrompt: string;
  detail: DescribeDetail | undefined;
  base64: string;
  streamId: string;
  onMissStart?: () => void;
}): Promise<CaptionResult> {
  const { describer, describerModel, describePrompt, detail, base64, streamId } = args;
  const key = captionCacheKey(base64, describerModel, detail);
  const hit = await getCachedCaption(key);
  if (hit != null) return { description: hit, cached: true };
  args.onMissStart?.();
  try {
    const resp = await withRetry(
      describerModel,
      () =>
        describer.chat({
          model: describerModel,
          stream: false,
          think: false,
          messages: [
            { role: "user", content: describePrompt, images: [base64] },
          ],
        }),
      {
        onRetry: (attempt, err) =>
          console.warn(
            `[chat ${streamId}] describer transient error (attempt ${attempt}): ${
              err instanceof Error ? err.message : String(err)
            }`
          ),
      }
    );
    const description = (resp.message?.content ?? "").trim();
    if (description) void setCachedCaption(key, description);
    return {
      description,
      cached: false,
      usage: {
        prompt: resp.prompt_eval_count ?? 0,
        completion: resp.eval_count ?? 0,
        evalNs: resp.eval_duration ?? 0,
        durationNs: resp.total_duration ?? 0,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "describer call failed";
    return { description: "", cached: false, error: message };
  }
}

/** Hand off to the next worker once the current one has been alive this long.
 *  Vercel kills the function at maxDuration=300s; leaving ~50s to abort the
 *  in-flight LLM stream / tool, flush the checkpoint, and let `/continue`
 *  cold-start before the wall avoids the producer dying mid-write. The
 *  threshold is also armed as a wall-clock setTimeout so a model that hangs
 *  or streams continuously without yielding gets pre-empted — not just one
 *  that happens to reach a round boundary. */
const HANDOFF_THRESHOLD_MS = Number(
  process.env.CHAT_HANDOFF_THRESHOLD_MS ?? 250_000
);

function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/**
 * Build the message array for an LLM call where the model should continue
 * an in-progress assistant turn rather than start a fresh response.
 *
 * Ollama's chat template closes the assistant turn the moment a non-assistant
 * role follows it — so the natural "append a system message saying 'continue'"
 * pattern actually makes the model restart. We instead fold the directive
 * into the system prompt at the head of the conv and put the partial
 * assistant content as the literal last message; that leaves the assistant
 * turn open for prefill-style continuation.
 *
 * `reason` describes what cut the prior turn short (network error,
 * mid-stream handoff, etc.) so the directive can be specific.
 */
function withContinuationPrefill(
  conv: OllamaMessage[],
  partial: string,
  toolCalls: ToolCall[],
  reason: string,
): OllamaMessage[] {
  const directive = `CONTINUATION MODE: ${reason} The next tokens you produce must seamlessly extend that final assistant message — do not repeat or re-introduce any text already shown to the user, do not acknowledge the interruption, and do not start a new sentence if the last one was unfinished.`;
  const hasSystem = conv.length > 0 && conv[0].role === "system";
  const head: OllamaMessage = hasSystem
    ? { ...conv[0], content: `${conv[0].content}\n\n${directive}` }
    : { role: "system", content: directive };
  const tail: OllamaMessage = {
    role: "assistant",
    content: partial,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  } as OllamaMessage;
  return [head, ...conv.slice(hasSystem ? 1 : 0), tail];
}

export type RunChatWorkCfg = {
  model: string;
  responseFormat: ResponseFormatLike;
  webSearchEnabled: boolean;
  imageSearchEnabled: boolean;
  /** Advanced Web mode — adds the powerful browse_page / http_request /
   *  run_command tools (headless Chromium, raw HTTP, sandboxed shell). The
   *  chat route forces Fly-worker routing when this is on, since that's where
   *  Chromium + the shell binaries live. Persisted through the checkpoint so a
   *  handoff keeps the toolset. Off by default. */
  advancedWebEnabled?: boolean;
  /** Code Execution Sandbox mode — adds the run_code tool (python/node in an
   *  isolated Fly-worker workspace with file I/O + ffmpeg). Like Advanced Web
   *  it forces Fly routing. Persisted through the checkpoint so a handoff keeps
   *  the toolset. Off by default. */
  codeExecEnabled?: boolean;
  /** The user's blob namespace hash — where run_code stages inputs and stores
   *  produced outputs. Only set when codeExecEnabled. */
  codeExecUserHash?: string;
  /** Files available to run_code this session (user uploads + earlier sandbox
   *  outputs), gathered from the conversation by the route. */
  codeExecFiles?: AttachedFile[];
  /** Custom MCP connectors enabled for this stream. Each connector's tools are
   *  exposed to the model under a namespaced wire-name; a call routes to a
   *  per-connector MCP session opened in this worker. Persisted through the
   *  checkpoint so a handoff keeps the toolset (the successor worker re-opens
   *  fresh sessions). */
  mcpConnectors?: McpRuntimeConnector[];
  publicOrigin: string;
  systemPrompt: string;
  maxRounds: number;
  wireBudget: number;
  /** RunPod endpoint id (from user Settings, threaded through every handoff
   *  via the checkpoint). Only used when the resolved provider is RunPod. */
  runpodEndpointId?: string;
  /** Vision model that captions images for a text-only main model (from user
   *  Settings). Empty/undefined ⇒ the built-in default / RunPod env override.
   *  See resolveDescriberModel. Threaded through the checkpoint so handoffs
   *  keep the user's choice. */
  describerModel?: string;
  /** Detail level for the describer prompt ("concise" | "standard" |
   *  "detailed"). Undefined ⇒ "standard". */
  describeDetail?: DescribeDetail;
  /** Research mode flag — drives the pre-round-loop planner →
   *  parallel sub-agents → synthesizer flow. Persisted through the checkpoint
   *  so a handoff mid-research keeps the orchestration path active (the
   *  Redis scratchpad has the partial state). Also informs maxWorkerSeq and
   *  the system prompt selection upstream. */
  researchEnabled?: boolean;
  /** User-answered scoping questions from the /api/research/framing pre-
   *  pass. Threaded into the planner's input so its sub-question
   *  decomposition reflects the confirmed scope. Sub-agents and synthesizer
   *  never see this — they work from the refined sub-questions only. */
  researchFraming?: {
    rationale: string;
    questions: { id: string; question: string }[];
    answers: Record<string, string>;
  };
  /** Long-running novel mode — outliner → sequential chapter writer flow.
   *  The round loop is bypassed for this mode; the orchestrator pipes
   *  chapter prose directly into the SSE stream and the assembled novel
   *  is pushed into `conv` as the assistant turn. Persisted through the
   *  checkpoint so a handoff mid-novel resumes the orchestrator (the
   *  per-chapter state lives in the Redis scratchpad). */
  novelModeEnabled?: boolean;
  /** Length preset for novel mode. */
  novelLength?: "short" | "standard" | "long";
  /** Pre-confirmed outline from the editor flow. When present, the
   *  orchestrator skips its outliner stage. Persisted through the
   *  checkpoint so a handoff mid-novel still has the user-approved
   *  outline available even if the Redis scratchpad got evicted. */
  novelOutline?: NovelOutline;
  /** Per-stream override of MAX_WORKER_SEQ; undefined ⇒ global default. */
  maxWorkerSeq?: number;
  /** Plan mode: decompose long coding edits into bounded steps cached
   *  individually so handoffs/continues preserve progress. `undefined`
   *  on the initial worker ⇒ auto-detect via shouldUsePlanMode(); set
   *  to a concrete boolean on subsequent workers (rehydrated from the
   *  checkpoint) so the decision is sticky across the chain. */
  planModeEnabled?: boolean;
  /** Off-Vercel routing: sticky flag mirroring `Checkpoint['cfg'].flyWorker`.
   *  Set on the initial POST when the client opted in AND the server has
   *  Fly configured; used downstream to relax the per-step rounds cap and
   *  to re-route user-triggered continuations through the Fly job queue
   *  instead of falling back to Vercel waitUntil. */
  flyWorker?: boolean;
};

/** Plan-mode auto-trigger. Run only on the initial worker (startRound === 0,
 *  !skipPreprocessing). The decision is then persisted into cfg.planModeEnabled
 *  through the checkpoint so handoff workers stay in plan mode without
 *  re-evaluating. We only auto-enable for VFS-mutation response formats with
 *  a substantial entry file and a non-trivial user prompt — short tweaks
 *  shouldn't pay the planner roundtrip. */
const PLAN_MODE_MIN_ENTRY_CHARS = Number(
  process.env.CHAT_PLAN_MODE_MIN_ENTRY_CHARS ?? 12_000
);
const PLAN_MODE_MIN_PROMPT_CHARS = Number(
  process.env.CHAT_PLAN_MODE_MIN_PROMPT_CHARS ?? 60
);

function shouldUsePlanMode(args: {
  streamId: string;
  responseFormat: ResponseFormatLike;
  vfsCtx: VfsContext | null;
  conv: OllamaMessage[];
  cfg: RunChatWorkCfg;
}): boolean {
  const { streamId, responseFormat, vfsCtx, conv, cfg } = args;
  const reject = (reason: string): boolean => {
    console.log(
      `[chat ${streamId}] plan mode auto-trigger rejected: ${reason}`
    );
    return false;
  };
  if (cfg.novelModeEnabled) return reject("novel mode on");
  if (cfg.researchEnabled) return reject("research on");
  if (responseFormat !== "artifact-edit" && responseFormat !== "vfs-edit") {
    return reject(`responseFormat=${responseFormat}`);
  }
  if (!vfsCtx) return reject("no vfs context");
  const entryContent = vfsCtx.files[vfsCtx.entry];
  if (typeof entryContent !== "string") return reject("entry file missing");
  if (entryContent.length < PLAN_MODE_MIN_ENTRY_CHARS) {
    return reject(
      `entry ${entryContent.length} < ${PLAN_MODE_MIN_ENTRY_CHARS}`
    );
  }
  const lastUser = [...conv].reverse().find((m) => m.role === "user");
  const lastUserText =
    typeof lastUser?.content === "string" ? lastUser.content : "";
  if (lastUserText.trim().length < PLAN_MODE_MIN_PROMPT_CHARS) {
    return reject(
      `prompt ${lastUserText.trim().length} < ${PLAN_MODE_MIN_PROMPT_CHARS}`
    );
  }
  console.log(
    `[chat ${streamId}] plan mode auto-trigger accepted: entry=${entryContent.length} prompt=${lastUserText.trim().length}`
  );
  return true;
}

export type RunChatWorkOpts = {
  streamId: string;
  workerSeq: number;
  /** Conversation array. On the initial worker this is system+user only.
   *  On a resumed worker it includes prior assistant turns + tool messages
   *  plus any inlined image captions / PDF text. */
  conv: OllamaMessage[];
  /** vfs-edit only. */
  vfsCtx: VfsContext | null;
  /** Original VFS snapshot for the final diff. */
  initialFiles: ArtifactFiles;
  cfg: RunChatWorkCfg;

  // The fields below are only set when resuming from a checkpoint.
  parserState?: ArtifactStreamParserState;
  totals?: {
    totalPrompt: number;
    totalCompletion: number;
    totalEvalNs: number;
    totalDurationNs: number;
    lastTps: number;
  };
  flags?: {
    producedProse: boolean;
    exitedWithToolsPending: boolean;
    finishedVfs: boolean;
    vfsFinishSummary: string;
    artifactProseHead: string;
    artifactDelivered: boolean;
  };
  /** Round index to start at (0 on the original worker, ≥0 on resume). */
  startRound: number;
  /** True on a resumed worker: image/PDF preprocessing already inlined into conv. */
  skipPreprocessing: boolean;
  /** Carry the lossy flag forward across handoffs. */
  kvLossy: boolean;
  /** First-worker-only: the raw incoming messages (with images / pdfs) so we
   *  can run image preprocessing and PDF inlining before the loop starts.
   *  Ignored when skipPreprocessing is true. */
  incoming?: IncomingMsg[];
};

export async function runChatWork(opts: RunChatWorkOpts): Promise<void> {
  const {
    streamId,
    workerSeq,
    conv,
    vfsCtx,
    initialFiles,
    cfg,
    skipPreprocessing,
    incoming,
  } = opts;
  const {
    model,
    responseFormat,
    webSearchEnabled,
    imageSearchEnabled,
    advancedWebEnabled,
    codeExecEnabled,
    codeExecUserHash,
    codeExecFiles,
    mcpConnectors,
    publicOrigin,
    systemPrompt,
    maxRounds,
    wireBudget,
    runpodEndpointId,
    maxWorkerSeq: cfgMaxWorkerSeq,
  } = cfg;

  // Effective per-stream worker cap. Research streams pass a higher value
  // through cfg; everything else falls back to the global MAX_WORKER_SEQ.
  const maxWorkerSeq = cfgMaxWorkerSeq ?? MAX_WORKER_SEQ;

  const workerStartedAt = Date.now();

  // Emit a chain-trace milestone. Best-effort: never blocks the worker on a
  // Redis hiccup. We fire-and-forget on the async append so the streaming
  // loop's pacing is unchanged. The trace is read back by the resume route's
  // stale-detection branch (and by the admin error log) to prove a long chain
  // actually consumed its budget instead of dying somewhere silently.
  const trace = (
    kind: WorkerTraceEvent["kind"],
    detail?: Record<string, string | number | boolean>
  ): void => {
    void appendWorkerTrace(streamId, {
      kind,
      seq: workerSeq,
      ts: Date.now(),
      detail: {
        ...(detail ?? {}),
        workerElapsedMs: Date.now() - workerStartedAt,
      },
    });
  };

  console.log(
    `[chat ${streamId}] worker seq=${workerSeq} started startRound=${opts.startRound} maxWorkerSeq=${cfgMaxWorkerSeq ?? MAX_WORKER_SEQ} model=${model}`
  );
  trace("worker_started", {
    startRound: opts.startRound,
    maxWorkerSeq: cfgMaxWorkerSeq ?? MAX_WORKER_SEQ,
    model,
    skipPreprocessing,
  });

  const llm = chatClientFor(model, { runpodEndpointId });
  // Vision describer model resolution (see resolveDescriberModel): the user's
  // Preferences choice wins; otherwise a RunPod-only deployment can override via
  // RUNPOD_VISION_DESCRIBER_MODEL when the main model routes to RunPod; otherwise
  // the built-in default. The client itself is constructed lazily inside the
  // describe branch so a mixed deployment without images doesn't fail the chat
  // just because the describer's provider creds are missing.
  const describerModel = resolveDescriberModel({
    configured: cfg.describerModel,
    runpodOverride:
      providerFor(model) === "runpod"
        ? process.env.RUNPOD_VISION_DESCRIBER_MODEL
        : undefined,
  });
  // Describer prompt for the user's chosen detail level (defaults to standard).
  const describePrompt = describePromptFor(cfg.describeDetail);

  // ---- KV batcher (per-worker) ----
  let pendingKvBatch: SseEvent[] = [];
  let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushChain: Promise<void> = Promise.resolve();
  let kvLossy = opts.kvLossy;
  // Persist the first lossy transition into meta immediately (instead of
  // waiting for the worker's finally block). The resume route polls meta on
  // every cycle and surfaces `kvLossy` as a user-visible "resume buffer lost
  // some events" warning — without an in-flight write, a still-streaming
  // chat shows truncated text with no error until the worker terminates.
  let kvLossyPersisted = opts.kvLossy;

  const flushKvBatch = (): Promise<void> => {
    if (pendingFlushTimer) {
      clearTimeout(pendingFlushTimer);
      pendingFlushTimer = null;
    }
    if (pendingKvBatch.length === 0) return flushChain;
    const batch = pendingKvBatch;
    pendingKvBatch = [];
    flushChain = flushChain.then(async () => {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < KV_MAX_APPEND_ATTEMPTS; attempt++) {
        try {
          await appendEvents(streamId, batch);
          return;
        } catch (err) {
          lastErr = err;
          if (attempt < KV_MAX_APPEND_ATTEMPTS - 1) {
            const backoff = KV_APPEND_RETRY_BASE_MS * 2 ** attempt;
            await new Promise((r) => setTimeout(r, backoff));
          }
        }
      }
      kvLossy = true;
      console.warn(
        `[chat ${streamId}] KV append failed after ${KV_MAX_APPEND_ATTEMPTS} attempts; resume buffer is now lossy`,
        lastErr
      );
      if (!kvLossyPersisted) {
        kvLossyPersisted = true;
        try {
          const current = await getMeta(streamId);
          if (current && !current.kvLossy) {
            await setMeta(streamId, { ...current, kvLossy: true });
          }
        } catch (metaErr) {
          // Roll back so a later flush failure retries the persist.
          kvLossyPersisted = false;
          console.warn(
            `[chat ${streamId}] failed to persist kvLossy=true mid-stream`,
            metaErr
          );
        }
      }
    });
    return flushChain;
  };

  const emit = (event: string, data: unknown): void => {
    // Once the worker has handed off, the next worker owns the stream — drop
    // any late events the wedged main flow happens to fire on its way to the
    // function-kill (or eventual GC). Without this, a hung `reader.read()`
    // that unblocks AFTER the heartbeat already POSTed /continue would mirror
    // its trailing chunks into Redis alongside worker N+1's fresh deltas,
    // producing duplicated / scrambled text on the client.
    if (handoffComplete) return;
    pendingKvBatch.push({ event, data });
    if (KV_FLUSH_INSTANT.has(event)) {
      void flushKvBatch();
    } else if (pendingKvBatch.length >= KV_BATCH_MAX_EVENTS) {
      void flushKvBatch();
    } else if (!pendingFlushTimer) {
      pendingFlushTimer = setTimeout(() => {
        void flushKvBatch();
      }, KV_BATCH_INTERVAL_MS);
    }
  };

  // ---- worker-local state (rehydrated from checkpoint when resuming) ----
  let totalPrompt = opts.totals?.totalPrompt ?? 0;
  let totalCompletion = opts.totals?.totalCompletion ?? 0;
  let totalEvalNs = opts.totals?.totalEvalNs ?? 0;
  let totalDurationNs = opts.totals?.totalDurationNs ?? 0;
  let lastTps = opts.totals?.lastTps ?? 0;

  // Caption one attached image for a text-only main model. Resolution order:
  //   1. Client-cached caption riding on the wire (img.description) — stored in
  //      IndexedDB on a prior turn. Reused silently; no describer call, no Redis.
  //      This is what stops the describer re-running on every send.
  //   2. Server cache + describer (describeImageCached): a same-bytes caption in
  //      Redis, else the actual vision call. Used for the first sight of an
  //      image and for paths without client storage (queued sends).
  // On a fresh describe we emit the result tagged with the image's stable `id`
  // so the client can persist the caption back onto that AttachedImage.
  const captionImage = async (
    img: { id?: string; dataUrl: string; name?: string; description?: string },
    k: number,
    messageIndex: number,
    describerClient: ReturnType<typeof chatClientFor>,
    ensureImageMode: () => void
  ): Promise<string> => {
    const nameLabel = img.name ? ` — ${img.name}` : "";
    const wireCaption = img.description?.trim();
    if (wireCaption) {
      return `[Image ${k + 1}${nameLabel}, described by ${describerModel}]: ${wireCaption}`;
    }
    const base64 = dataUrlToBase64(img.dataUrl);
    const label = img.name ? `image ${k + 1} (${img.name})` : `image ${k + 1}`;
    const result = await describeImageCached({
      describer: describerClient,
      describerModel,
      describePrompt,
      detail: cfg.describeDetail,
      base64,
      streamId,
      onMissStart: () => {
        ensureImageMode();
        emit("tool_call", {
          name: "describe_image",
          args: { describer: describerModel, image: label },
        });
      },
    });
    if (result.usage) {
      totalPrompt += result.usage.prompt;
      totalCompletion += result.usage.completion;
      totalEvalNs += result.usage.evalNs;
      totalDurationNs += result.usage.durationNs;
    }
    if (result.error) {
      emit("tool_result", {
        name: "describe_image",
        error: result.error,
        imageIndex: k,
        messageIndex,
        imageId: img.id,
      });
      return `[Image ${k + 1}${nameLabel}: failed to describe — ${result.error}]`;
    }
    // Cache hits reuse the caption silently (no tool row). Fresh describes emit
    // the caption + image id so the client can cache it in IndexedDB.
    if (!result.cached) {
      emit("tool_result", {
        name: "describe_image",
        summary: result.description
          ? result.description.slice(0, 200) +
            (result.description.length > 200 ? "…" : "")
          : "empty caption",
        description: result.description,
        imageIndex: k,
        messageIndex,
        imageId: img.id,
      });
    }
    return `[Image ${k + 1}${nameLabel}, described by ${describerModel}]: ${
      result.description || "(describer returned an empty caption)"
    }`;
  };
  // Provider-reported stop reason of the most recent main-model response.
  // "length" means the model hit its output-token ceiling and the reply was
  // cut off mid-thought — we surface this to the client so it can offer a
  // "Continue" affordance. Only updated on the user-facing round loop and the
  // forced-finalize pass; the describer / tool-arg sub-calls don't count.
  let lastDoneReason: string | undefined;

  let artifactProseHead = opts.flags?.artifactProseHead ?? "";
  let artifactDelivered = opts.flags?.artifactDelivered ?? false;
  let producedProse = opts.flags?.producedProse ?? false;
  let exitedWithToolsPending = opts.flags?.exitedWithToolsPending ?? false;
  let finishedVfs = opts.flags?.finishedVfs ?? false;
  let vfsFinishSummary = opts.flags?.vfsFinishSummary ?? "";

  const handlers = {
    onProse: (text: string) => emit("delta", { text }),
    onArtifactOpen: () => emit("artifact_open", {}),
    onArtifactDelta: (text: string) => emit("artifact_delta", { text }),
    onArtifactClose: (html: string) => {
      artifactDelivered = true;
      emit("artifact_close", {
        html,
        summary: artifactProseHead.trim().slice(0, 240),
      });
    },
  };
  // `let` rather than `const` so we can rebuild a fresh parser per turn when
  // the queue-drain path restarts the round loop for a follow-up message.
  let parser = opts.parserState
    ? ArtifactStreamParser.deserialize(opts.parserState, handlers)
    : new ArtifactStreamParser(handlers);

  // Last assistant text from the prior round / forced-finalize, captured so
  // we can push it into `conv` as the previous assistant turn before
  // appending a queued user message. Without this, the LLM's next turn
  // would re-answer the original prompt instead of seeing its own reply.
  let lastAssistantText = "";

  // How many queued follow-ups the current worker has processed. Bounded by
  // MAX_QUEUED_TURNS_PER_WORKER above.
  let queuedTurnsHandled = 0;

  // Vision-native check + the conv-array offset that skips the system prompt
  // — used both by the initial preprocessing pass and by the queued-turn
  // attachment helper below.
  const visionNative = modelSupportsVision(model);
  const convOffset = systemPrompt ? 1 : 0;

  // Build tools list from cfg (same logic as before).
  const toolList: Tool[] = [];
  if (responseFormat === "vfs-edit") toolList.push(...VFS_TOOLS);
  else if (responseFormat === "note-edit" || responseFormat === "artifact-edit")
    toolList.push(...NOTE_EDIT_TOOLS);
  if (webSearchEnabled) toolList.push(WEB_SEARCH_TOOL, WEB_FETCH_TOOL);
  if (imageSearchEnabled) toolList.push(IMAGE_SEARCH_TOOL);
  if (advancedWebEnabled) toolList.push(...ADVANCED_WEB_TOOLS);
  if (codeExecEnabled) toolList.push(...CODE_EXEC_TOOLS);

  // Custom MCP connectors: expose each enabled connector's discovered tools to
  // the model under a namespaced wire-name, and build a dispatch map so the
  // tool loop can route a call back to the right connector + original tool
  // name. Sessions are opened lazily (one per connector) and reused across
  // calls this turn. See the dispatch branch in the round loop below.
  const mcpDispatch = new Map<
    string,
    { connector: McpRuntimeConnector; toolName: string }
  >();
  const mcpSessions = new Map<string, McpSession>();
  for (const connector of mcpConnectors ?? []) {
    for (const tool of connector.tools) {
      const wireName = mcpWireName(connector.id, tool.name);
      if (mcpDispatch.has(wireName)) continue; // first tool wins on a rare collision
      mcpDispatch.set(wireName, { connector, toolName: tool.name });
      const params =
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? (tool.inputSchema as Tool["function"]["parameters"])
          : { type: "object", properties: {} };
      toolList.push({
        type: "function",
        function: {
          name: wireName,
          description:
            (tool.description ? `${tool.description}\n\n` : "") +
            `(Provided by the "${connector.name}" connector.)`,
          parameters: params,
        },
      });
    }
  }
  const getMcpSession = (connector: McpRuntimeConnector): McpSession => {
    let s = mcpSessions.get(connector.id);
    if (!s) {
      s = new McpSession({ url: connector.url, apiKey: connector.apiKey });
      mcpSessions.set(connector.id, s);
    }
    return s;
  };

  const toolsArg: Tool[] | undefined = toolList.length ? toolList : undefined;

  // Mutable view of the files available to run_code: starts with what the
  // route gathered from the conversation, and grows as runs produce outputs so
  // a later run_code in the same turn can reference an earlier run's output.
  const codeExecAvailable: AttachedFile[] = codeExecEnabled
    ? [...(codeExecFiles ?? [])]
    : [];

  // Images the user pasted/dragged THIS turn, decoded straight from the base64
  // the client sends inline on the message. We stage run_code inputs from these
  // bytes directly - no Blob round-trip, no dependency on route.ts having
  // uploaded them (which needs Blob + a resolved user, and silently no-ops
  // otherwise). This is what guarantees a pasted image is openable in the
  // sandbox and, crucially, that its filename gets announced below. Names match
  // route.ts's Blob-staged names (same sanitize + `image-<id>` fallback) so the
  // two paths never disagree on what the model should pass to input_files.
  type TurnImageFile = {
    messageIndex: number;
    name: string;
    base64: string;
    contentType: string;
    bytes: number;
  };
  const turnImageFiles: TurnImageFile[] = [];
  if (codeExecEnabled && incoming) {
    for (let i = 0; i < incoming.length; i++) {
      const imgs = incoming[i].images;
      if (!Array.isArray(imgs)) continue;
      for (let k = 0; k < imgs.length; k++) {
        const img = imgs[k];
        if (!img || typeof img.dataUrl !== "string") continue;
        const comma = img.dataUrl.indexOf(",");
        if (comma < 0) continue;
        const semi = img.dataUrl.indexOf(";");
        const mime =
          img.mime ||
          (img.dataUrl.startsWith("data:") && semi > 5
            ? img.dataUrl.slice(5, semi)
            : "") ||
          "image/png";
        const ext = mime.split("/")[1]?.split("+")[0] || "png";
        const name = sanitizeUploadFilename(
          img.name && img.name.trim()
            ? img.name.trim()
            : `image-${img.id ?? `${i}-${k}`}.${ext}`
        );
        const base64 = img.dataUrl.slice(comma + 1);
        // base64 -> bytes: 3 bytes per 4 chars, minus '=' padding.
        const pad = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
        const bytes = Math.max(0, Math.floor((base64.length * 3) / 4) - pad);
        turnImageFiles.push({ messageIndex: i, name, base64, contentType: mime, bytes });
      }
    }
  }
  // Dedupe by name (a re-sent history can carry the same image on multiple
  // turns) and strip to the sandbox's InlineInputFile shape.
  const codeExecInlineFiles: InlineInputFile[] = [];
  {
    const seen = new Set<string>();
    for (const f of turnImageFiles) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      codeExecInlineFiles.push({ name: f.name, base64: f.base64, contentType: f.contentType });
    }
  }

  // Per-handoff: when the handoff branch fires we exit early; the finally
  // block must skip setMeta(complete) so the next worker can continue.
  let handedOff = false;
  // Single-flight guard claimed synchronously at the entry of performHandoff
  // — prevents the heartbeat and the main flow from racing through the body
  // concurrently. `handoffComplete` flips at the end of performHandoff and
  // gates `emit()` so late events from a wedged main flow are dropped
  // instead of leaking into the next worker's stream.
  let handoffStarted = false;
  let handoffComplete = false;
  // Captured in the catch to drive the worker_finished trace's reason field.
  let workerErrorMessage: string | null = null;

  // ---- wall-clock deadline & active-iterator tracker ----
  // The original handoff was driven only by checkpoints between rounds, which
  // doesn't fire for a model that streams (or hangs) continuously past 250s.
  // The replacement is a setInterval heartbeat: it ticks every couple of
  // seconds and, as long as the event loop is processing timers, guarantees
  // we'll abort + handoff regardless of whether the main flow's for-await
  // is blocked on a hung `reader.read()` (a known undici failure mode where
  // calling AbortController.abort() doesn't unstick the pending read when
  // the upstream socket is dead). When the heartbeat fires the abort, the
  // main flow's catch handler does the polite mid-stream handoff with
  // partial state preserved. If the main flow hasn't claimed the handoff
  // after a brief grace, the heartbeat forces it from out-of-band so the
  // chain advances no matter what.
  let deadlineHit = false;
  let deadlineFiredAt: number | null = null;
  let activeIter: { abort: () => void } | null = null;
  // Only arm the heartbeat when we actually have a successor slot. On the
  // final worker (workerSeq === MAX_WORKER_SEQ) there's nowhere to hand off
  // to — aborting at 250s would just truncate the user's reply without
  // recourse; letting Vercel run us to the 300s wall gives the model 50 more
  // seconds to finish naturally, and if it doesn't the resume route's
  // watchdog emits the standard error.
  const HEARTBEAT_INTERVAL_MS = 2_000;
  // Grace window after first detecting the deadline. The polite path is the
  // main flow's catch branch: iter.abort() unblocks the for-await, the catch
  // sees `deadlineHit`, pushes the partial assistant turn into conv (so the
  // next worker continues seamlessly instead of re-running the round), and
  // calls performHandoff. This grace lets that path run; if it hasn't
  // started a handoff by the time the grace elapses, the main flow is wedged
  // and the heartbeat takes over.
  const HEARTBEAT_FORCE_HANDOFF_AFTER_MS = 8_000;
  const heartbeat: ReturnType<typeof setInterval> | null =
    workerSeq < maxWorkerSeq
      ? setInterval(() => {
          if (handoffStarted) {
            if (heartbeat) clearInterval(heartbeat);
            return;
          }
          const elapsed = Date.now() - workerStartedAt;
          if (elapsed < HANDOFF_THRESHOLD_MS) return;

          // First tick past the threshold: trace and abort the active iter
          // so the main flow can handle the deadline cleanly. Same shape as
          // the old setTimeout path — `deadlineHit` is what every existing
          // mid-stream / round-boundary check reads.
          if (!deadlineHit) {
            deadlineHit = true;
            deadlineFiredAt = Date.now();
            console.log(
              `[chat ${streamId}] deadline fired seq=${workerSeq} elapsedMs=${elapsed}`
            );
            trace("deadline_fired", { elapsedMs: elapsed });
            if (activeIter) {
              try {
                activeIter.abort();
              } catch {
                // Iterator may already be torn down; the for-await will exit
                // either way and the catch branch routes to performHandoff.
              }
            }
            return;
          }

          // Grace window expired and the main flow still hasn't claimed the
          // handoff (`handoffStarted` is set synchronously at the start of
          // performHandoff, before any await — so if it's still false here,
          // the main flow truly hasn't reached its catch / round-boundary
          // check). Force the handoff from out-of-band; performHandoff's
          // own guard makes this idempotent if the main flow happens to wake
          // up at the same moment.
          if (
            deadlineFiredAt != null &&
            Date.now() - deadlineFiredAt >= HEARTBEAT_FORCE_HANDOFF_AFTER_MS
          ) {
            console.warn(
              `[chat ${streamId}] main flow stuck after deadline+${HEARTBEAT_FORCE_HANDOFF_AFTER_MS}ms — forcing handoff from heartbeat`
            );
            trace("heartbeat_forced_handoff", {
              elapsedSinceDeadlineMs: Date.now() - deadlineFiredAt,
            });
            if (heartbeat) clearInterval(heartbeat);
            void performHandoff().catch((err) => {
              console.warn(
                `[chat ${streamId}] heartbeat-forced handoff threw`,
                err
              );
            });
          }
        }, HEARTBEAT_INTERVAL_MS)
      : null;
  if (heartbeat) {
    console.log(
      `[chat ${streamId}] deadline armed seq=${workerSeq} thresholdMs=${HANDOFF_THRESHOLD_MS} heartbeatMs=${HEARTBEAT_INTERVAL_MS}`
    );
    trace("deadline_armed", { thresholdMs: HANDOFF_THRESHOLD_MS });
  }

  // Tracks the in-flight handoff so a late caller (the main flow's
  // mid-stream-handoff path, after the heartbeat already started one) can
  // *await* completion instead of racing past it. Without this, the main
  // flow's `return;` would resolve `runChatWork` while the heartbeat is
  // still in the middle of `await fetch(/continue, …)` — waitUntil drops
  // the function once runChatWork settles, and Vercel kills the in-flight
  // fetch before /continue acquires its slot. Net effect: the chain
  // silently stalls and the user sees the resume watchdog error 25s later.
  let handoffPromise: Promise<void> | null = null;

  // ---- handoff helper ----
  // Serialize current state to Redis and POST /api/chat/continue with HMAC.
  // Callers must update `conv` (and any partial assistant turn) BEFORE
  // calling — this just snapshots whatever's there. Sets `handedOff = true`
  // synchronously on entry so the finally block leaves meta.status="running"
  // for the successor even if a concurrent main-flow exit gets there first;
  // sets meta.status="error" on failure so the resume route surfaces it
  // immediately rather than waiting out the watchdog.
  //
  // Idempotent: claims `handoffStarted` before any await, so the heartbeat
  // and the main flow's mid-stream-handoff path can both call this without
  // racing through the body twice. Whichever path arrives first runs the
  // body; later callers await the cached promise and return.
  const performHandoff = async (): Promise<void> => {
    if (workerSeq >= maxWorkerSeq) {
      // No chain budget left — fall through to whatever caller does next
      // (typically: emit the upstream error and exit).
      return;
    }
    if (handoffStarted) {
      // Heartbeat already started one (or the main flow did, depending on
      // which raced ahead). Don't run the body twice — that would double-
      // POST /continue and double-write the checkpoint. Await the in-flight
      // promise so the caller's `return;` doesn't fire runChatWork's finally
      // while the first handoff is mid-fetch.
      if (handoffPromise) await handoffPromise;
      return;
    }
    handoffStarted = true;
    // Commit early so a concurrent main-flow `return;` whose finally beats
    // our final `handoffComplete = true` doesn't write setMeta(complete)
    // and clobber the in-progress chain advance.
    handedOff = true;

    // Capture the body's completion as a Promise concurrent callers can
    // await. Resolved in the finally below so a thrown body still unblocks
    // anyone parked on the gate (the existing body handles its own errors
    // and never throws, but defensive against future changes).
    let resolveBody: () => void = () => {};
    handoffPromise = new Promise<void>((resolve) => {
      resolveBody = resolve;
    });

    try {
    const handoffStartedAt = Date.now();
    const elapsedAtHandoff = handoffStartedAt - workerStartedAt;
    console.log(
      `[chat ${streamId}] handoff initiated seq=${workerSeq}→${workerSeq + 1} round=${handoffRound} workerElapsedMs=${elapsedAtHandoff} promptTokens=${totalPrompt} completionTokens=${totalCompletion}`
    );
    trace("handoff_initiated", {
      nextSeq: workerSeq + 1,
      round: handoffRound,
      promptTokens: totalPrompt,
      completionTokens: totalCompletion,
      deadlineHit,
    });
    await flushKvBatch();
    const cp: Checkpoint = {
      v: 1,
      conv,
      vfsCtx: vfsCtx
        ? {
            files: vfsCtx.files,
            entry: vfsCtx.entry,
            readPaths: Array.from(vfsCtx.readPaths),
            changes: vfsCtx.changes,
            lastBuild: vfsCtx.lastBuild,
            mode: vfsCtx.mode,
            selection: vfsCtx.selection,
          }
        : null,
      parser: parser.serialize(),
      totals: {
        totalPrompt,
        totalCompletion,
        totalEvalNs,
        totalDurationNs,
        lastTps,
      },
      flags: {
        producedProse,
        exitedWithToolsPending,
        finishedVfs,
        vfsFinishSummary,
        artifactProseHead,
        artifactDelivered,
      },
      cfg,
      round: handoffRound,
      initialFiles,
      kvLossy,
    };
    await saveCheckpoint(streamId, cp);

    const nextSeq = workerSeq + 1;
    const sig = hmacSign(`${streamId}|${nextSeq}`);
    // AWAIT the handoff: we run inside the route's waitUntil, and the
    // moment runChatWork returns, the platform is free to shut us down.
    // A bare `void fetch(...)` can be cut off before the request actually
    // reaches the continuation endpoint — meta stays pinned to this
    // worker's start time, the next worker never runs, and the resume
    // route's stale-detection surfaces the "5-minute limit" error ~25s
    // later. Awaiting keeps us alive until /continue has acquired the
    // slot, written the new workerStartedAt, and queued the next worker
    // (returns 202 — typically <1s).
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 15_000);
    let handoffErr: unknown = null;
    try {
      const resp = await fetch(`${publicOrigin}/api/chat/continue/${streamId}`, {
        method: "POST",
        headers: {
          "x-continue-seq": String(nextSeq),
          "x-continue-sig": sig,
        },
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        // Capture the body so a future failure is diagnosable on sight:
        // a 401 with `{"error":"Unauthorized"}` is the middleware
        // (proxy.ts) blocking us; a 403 with `{"error":"Invalid
        // signature."}` is the route's own HMAC check; 410 / 409 are
        // checkpoint / idempotency failures inside the route. Without
        // the body we'd just see a status code and have to guess.
        const body = await resp.text().catch(() => "");
        handoffErr = new Error(
          `handoff endpoint returned ${resp.status}: ${body.slice(0, 200)}`
        );
      }
    } catch (err) {
      handoffErr = err;
    } finally {
      clearTimeout(timeoutId);
    }

    if (handoffErr) {
      // Surface the failure now rather than letting the resume route's
      // stale-detection fire ~25s later. Mirror that route's convention
      // (transient: true) so the client auto-retries the user's message.
      const fetchLatencyMs = Date.now() - handoffStartedAt;
      console.warn(
        `[chat ${streamId}] handoff endpoint failed seq=${workerSeq}→${nextSeq} fetchLatencyMs=${fetchLatencyMs}: ${
          handoffErr instanceof Error ? handoffErr.message : String(handoffErr)
        }`
      );
      trace("handoff_endpoint_failed", {
        nextSeq,
        fetchLatencyMs,
        error: (handoffErr instanceof Error ? handoffErr.message : String(handoffErr)).slice(0, 200),
      });
      const message =
        "Generation stopped responding — couldn't hand off to a fresh worker. Try sending again.";
      // Bypass the emit() gate (which trips on `handoffComplete`) by writing
      // straight into the KV batch — handoffComplete hasn't been set yet, so
      // emit() would let this through anyway, but writing direct also keeps
      // the failure reportable if we ever tighten the gate later.
      pendingKvBatch.push({ event: "error", data: { message, transient: true } });
      await flushKvBatch();
      try {
        await setMeta(streamId, {
          status: "error",
          error: message,
          finishedAt: Date.now(),
          kvLossy: kvLossy || undefined,
        });
      } catch {}
      // Skip the finally's setMeta(complete) — meta is already terminal.
      // Also drive the worker_finished trace's reason to "error" via
      // workerErrorMessage; without this we'd report reason=handoff for a
      // worker whose handoff actually failed, hiding the failure in the
      // post-mortem summary.
      workerErrorMessage = message;
      return;
    }

    const fetchLatencyMs = Date.now() - handoffStartedAt;
    console.log(
      `[chat ${streamId}] handoff endpoint accepted seq=${workerSeq}→${nextSeq} fetchLatencyMs=${fetchLatencyMs}`
    );
    trace("handoff_endpoint_ok", {
      nextSeq,
      fetchLatencyMs,
    });
    } finally {
      // Flip the emit gate + unblock concurrent callers parked on the
      // handoffStarted branch above. Goes through whether the body returned
      // normally, hit the error early-return, or threw.
      handoffComplete = true;
      resolveBody();
    }
  };

  // Tracks which round index the next worker should resume at. The deadline
  // timer can fire mid-round; in that case we stash the partial turn into
  // `conv` and ask the successor to start a fresh round at this same index.
  let handoffRound = opts.startRound;

  // Inline a queued turn's attachments into the user message at `convIdx`.
  // Mirrors the initial-turn preprocessing — vision-capable models get raw
  // base64 frames, text-only models get described captions, PDFs get their
  // extracted text appended. Stats accumulators (totalPrompt etc.) are
  // updated by the describer path so usage reporting stays accurate.
  const processQueuedAttachments = async (
    convIdx: number,
    images: QueuedUserMsg["images"],
    pdfs: QueuedUserMsg["pdfs"],
    csvs?: QueuedUserMsg["csvs"]
  ): Promise<void> => {
    const target = conv[convIdx];
    if (!target) return;

    const validImages = (images ?? []).filter(
      (img): img is NonNullable<typeof img> & { dataUrl: string } =>
        !!img && typeof img.dataUrl === "string" && img.dataUrl.length > 0
    );

    if (validImages.length > 0) {
      if (visionNative) {
        emit("image_mode", { mode: "native", model, count: validImages.length });
        target.images = validImages.map((img) => dataUrlToBase64(img.dataUrl));
      } else {
        const describer = chatClientFor(describerModel, { runpodEndpointId });
        const captions: string[] = [];
        // Emit the "described" mode row lazily on the first cache miss so a
        // turn whose images are all cached doesn't show a misleading
        // "describing images…" row for work that didn't run.
        let emittedImageMode = false;
        const ensureImageMode = () => {
          if (emittedImageMode) return;
          emittedImageMode = true;
          emit("image_mode", {
            mode: "described",
            describer: describerModel,
            mainModel: model,
            count: validImages.length,
          });
        };
        for (let k = 0; k < validImages.length; k++) {
          const img = validImages[k];
          captions.push(
            await captionImage(img, k, convIdx - convOffset, describer, ensureImageMode)
          );
        }
        if (captions.length > 0) {
          const head = target.content?.trim() ?? "";
          target.content = head
            ? `${head}\n\n${captions.join("\n\n")}`
            : captions.join("\n\n");
        }
      }
    }

    const validPdfs = (pdfs ?? []).filter(
      (p): p is NonNullable<typeof p> =>
        !!p && typeof p.text === "string" && p.text.length > 0
    );
    if (validPdfs.length > 0) {
      emit("pdf_mode", { mode: "inlined", count: validPdfs.length });
      const blocks: string[] = [];
      for (let k = 0; k < validPdfs.length; k++) {
        const pdf = validPdfs[k];
        const pages = pdf.pageCount === 1 ? "1 page" : `${pdf.pageCount} pages`;
        const header = `[PDF ${k + 1} — ${pdf.name}, ${pages}${pdf.truncated ? ", truncated" : ""}]`;
        blocks.push(`${header}\n${pdf.text}`);
        emit("tool_call", {
          name: "attach_pdf",
          args: { name: pdf.name, pages: pdf.pageCount },
        });
        emit("tool_result", {
          name: "attach_pdf",
          summary: `${pages} · ${pdf.text.length.toLocaleString()} chars${pdf.truncated ? " (truncated)" : ""}`,
          pdfIndex: k,
          messageIndex: convIdx - convOffset,
        });
      }
      const head = target.content?.trim() ?? "";
      target.content = head
        ? `${head}\n\n${blocks.join("\n\n")}`
        : blocks.join("\n\n");
    }

    const validCsvs = (csvs ?? []).filter(
      (c): c is NonNullable<typeof c> =>
        !!c && typeof c.text === "string" && c.text.length > 0
    );
    if (validCsvs.length > 0) {
      emit("csv_mode", { mode: "inlined", count: validCsvs.length });
      const blocks: string[] = [];
      for (let k = 0; k < validCsvs.length; k++) {
        const csv = validCsvs[k];
        const rows = csv.rowCount === 1 ? "1 row" : `${csv.rowCount} rows`;
        const cols = csv.columnCount === 1 ? "1 column" : `${csv.columnCount} columns`;
        const header = `[CSV ${k + 1} — ${csv.name}, ${rows}, ${cols}${csv.truncated ? ", truncated" : ""}]`;
        blocks.push(`${header}\n${csv.text}`);
        emit("tool_call", {
          name: "attach_csv",
          args: { name: csv.name, rows: csv.rowCount, columns: csv.columnCount },
        });
        emit("tool_result", {
          name: "attach_csv",
          summary: `${rows}, ${cols} · ${csv.text.length.toLocaleString()} chars${csv.truncated ? " (truncated)" : ""}`,
          csvIndex: k,
          messageIndex: convIdx - convOffset,
        });
      }
      const head = target.content?.trim() ?? "";
      target.content = head
        ? `${head}\n\n${blocks.join("\n\n")}`
        : blocks.join("\n\n");
    }
  };

  // Drain the per-stream queue with a short grace window. Returns the
  // coalesced batch (or [] if nothing arrived). The grace covers the race
  // where a queue POST is in flight at the moment the LLM finishes its
  // last token — without it those messages would 410 and round-trip back
  // through the client's normal POST path.
  const drainQueueWithGrace = async (): Promise<QueuedUserMsg[]> => {
    let queued = await drainQueue(streamId);
    for (let g = 0; g < QUEUE_GRACE_TICKS && queued.length === 0; g++) {
      await new Promise((r) => setTimeout(r, QUEUE_GRACE_INTERVAL_MS));
      queued = await drainQueue(streamId);
    }
    return queued;
  };

  // Reset per-turn flags + parser so a queued follow-up turn starts clean.
  // VFS state (vfsCtx, finishedVfs, vfsFinishSummary) deliberately persists
  // across queued turns: the model's prior file edits are still live, and
  // the next turn either continues editing or wraps up.
  const resetPerTurnState = (): void => {
    artifactProseHead = "";
    artifactDelivered = false;
    producedProse = false;
    exitedWithToolsPending = false;
    parser = new ArtifactStreamParser(handlers);
  };

  // ---- in-loop context compaction --------------------------------------
  // The agentic round loop appends an assistant turn (content + thinking +
  // tool_calls) plus one `role:"tool"` message per call EVERY round, and
  // re-sends the whole `conv` each round. On a long web-search / research
  // turn that crosses the model's context window mid-answer — the "prompt is
  // too long" failure. When conv nears the window we summarize the OLDER tool
  // rounds into one recap message and splice it in place of them, keeping the
  // system prompt, the original user turn, and the most-recent rounds
  // verbatim. Runs at the round boundary only (never mid-stream), the same
  // safe point as handoff/checkpoint — so `conv` never has a dangling tool
  // group when we mutate it, and the in-place splice keeps the array
  // reference the Checkpoint holds valid (survives handoffs for free).

  // Readable marker prefixing a recap message. The head pinned by segmentConv
  // is only [system, original user], so a prior recap always falls into the
  // foldable middle and gets re-summarized into the next recap — recaps never
  // stack. The sentinel just labels the message for logs / human inspection.
  const COMPACTION_SENTINEL = "​[context-recap]";
  // Fire well before the hard wall: wireBudget already subtracts the output
  // reserve, and SUMMARIZE_AT (0.75) leaves another 25% headroom on top.
  const compactionTrigger = Math.floor(wireBudget * SUMMARIZE_AT);

  // ---- adaptive token-estimate calibration ----
  // estimateTokens() is a flat ~3.6 chars/token heuristic. It's ~right for
  // prose, but it badly UNDERCOUNTS token-dense payloads — web_search / browse
  // JSON, raw HTML page text, URLs, and markdown tables tokenize closer to
  // ~2.2–2.8 chars/token. That matters because every budget gate below
  // (compaction trigger, the enforceHardLimit backstop, and the num_ctx sizing)
  // compares this estimate to `wireBudget`. On an agentic web turn the estimate
  // reads far under the real prompt, so NONE of the guards fire and the request
  // sails past the model's context window — the "prompt is too long: N, model
  // maximum context length: M" failure, mid-answer, after a few searches.
  //
  // Fix: every main-model response reports `prompt_eval_count` — the REAL prompt
  // token count for the exact payload we just estimated. We learn the ratio
  // real/estimate and scale later estimates by it, so the guards gate against
  // reality instead of the undercount. It ratchets up fast (safety) and eases
  // down slowly, clamped to a sane band, and is seeded slightly conservative so
  // the first tool round already carries margin. The gradual-growth shape of the
  // failure (conv balloons over many rounds) means we've always calibrated from
  // several real samples well before the conversation gets anywhere near large.
  let tokenScale = 1.1;
  const TOKEN_SCALE_MIN = 1;
  const TOKEN_SCALE_MAX = 3;
  // A 40-token prompt yields a noisy ratio; don't let it move the scale that has
  // to protect a 200k-token conversation. Only learn from calls big enough to
  // matter.
  const TOKEN_SCALE_MIN_SAMPLE = 2_000;
  const observeTokenCalibration = (
    estimatedTokens: number,
    realPromptTokens: number
  ): void => {
    if (estimatedTokens < TOKEN_SCALE_MIN_SAMPLE || realPromptTokens <= 0) return;
    const ratio = realPromptTokens / estimatedTokens;
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    const prev = tokenScale;
    // Ratchet up immediately on a denser-than-expected sample; ease down slowly
    // so one prose-heavy round doesn't drop protection built from dense tool
    // output earlier in the same turn.
    const next = ratio > tokenScale ? ratio : tokenScale * 0.8 + ratio * 0.2;
    tokenScale = Math.min(TOKEN_SCALE_MAX, Math.max(TOKEN_SCALE_MIN, next));
    if (Math.abs(tokenScale - prev) >= 0.05) {
      console.log(
        `[chat ${streamId}] token-scale ${prev.toFixed(2)}→${tokenScale.toFixed(
          2
        )} (real ${realPromptTokens} / est ${estimatedTokens} = ${ratio.toFixed(2)})`
      );
    }
  };
  // The budget-facing view of conv size: the raw heuristic scaled by what we've
  // learned. Every comparison against `wireBudget` / `compactionTrigger` uses
  // THIS, not the bare estimate. estimateConvTokens stays the raw heuristic
  // (used to form the calibration sample and for display).
  const budgetedConvTokens = (
    msgs: Parameters<typeof estimateConvTokens>[0]
  ): number => Math.ceil(estimateConvTokens(msgs) * tokenScale);

  // Flatten a conv message into plain summarizer input: strip tool_calls and
  // images (tool/user → user), fold the reasoning trace in, and cap each part
  // so the summarizer call itself can't overflow.
  const toSummarizerInput = (
    m: OllamaMessage
  ): { role: "user" | "assistant" | "system"; content: string } => {
    const segs: string[] = [];
    if (typeof m.thinking === "string" && m.thinking.trim()) {
      segs.push(`[reasoning] ${m.thinking.trim().slice(0, 2000)}`);
    }
    const content = typeof m.content === "string" ? m.content : "";
    if (content) segs.push(content.slice(0, 4000));
    const role: "user" | "assistant" | "system" =
      m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
    return { role, content: segs.join("\n\n") };
  };

  // Split conv into [pinned head | foldable middle | verbatim tail].
  //   head  = system prompt + the original user turn (with its image)
  //   tail  = the last KEEP_TAIL_MESSAGES, snapped FORWARD past any leading
  //           `role:"tool"` so the tail always begins at a group boundary and
  //           a tool result is never separated from the assistant that owns it
  //   middle = everything between (complete assistant+tool groups + any prior
  //            recap), which gets summarized into a single recap.
  const segmentConv = (): { headEnd: number; tailStart: number } => {
    // Pin the system prompt (if any) + the original user question.
    const headEnd = Math.min(conv.length, convOffset + 1);
    let tailStart = Math.max(headEnd, conv.length - KEEP_TAIL_MESSAGES);
    while (tailStart < conv.length && conv[tailStart].role === "tool") {
      tailStart++;
    }
    return { headEnd, tailStart };
  };

  // Hard backstop: guarantee we never send an over-limit prompt even if the
  // recap didn't fit (huge tail / one giant tool result). Trims the largest
  // tool-message bodies in place, then drops tool-message images, then — last
  // resort — the pinned user image. Never touches system / user text / recap
  // / assistant tool_calls; trimming a tool RESULT is safe (the group
  // invariant is about presence + order, not content length).
  // Returns true if it had to trim. Silent except for a server log — it's the
  // internal safety net, surfaced to the client via the `hardTrimmed` flag on
  // the `done` event rather than its own phase.
  const enforceHardLimit = (round: number): boolean => {
    let tokens = budgetedConvTokens(conv);
    if (tokens <= wireBudget) return false;
    const toolMsgs = conv
      .filter((m) => m.role === "tool" && typeof m.content === "string")
      .sort(
        (a, b) => (b.content as string).length - (a.content as string).length
      );
    for (const m of toolMsgs) {
      if (tokens <= wireBudget) break;
      const cur = m.content as string;
      const overBy = tokens - wireBudget;
      // overBy is in budgeted (scaled) tokens; convert back to characters via
      // the calibrated ratio (overBy / tokenScale = raw tokens, × 3.6 = chars)
      // so we drop enough on the first pass instead of nibbling.
      const dropChars = Math.min(
        cur.length - 256,
        Math.ceil((overBy / tokenScale) * 3.6) + 512
      );
      if (dropChars <= 0) continue;
      m.content = cur.slice(0, cur.length - dropChars) + "…[truncated to fit context]";
      tokens = budgetedConvTokens(conv);
    }
    const dropImages = (predicate: (m: OllamaMessage) => boolean): void => {
      for (const m of conv) {
        if (tokens <= wireBudget) break;
        const withImg = m as { images?: unknown[] };
        if (predicate(m) && Array.isArray(withImg.images)) {
          delete withImg.images;
          tokens = budgetedConvTokens(conv);
        }
      }
    };
    dropImages((m) => m.role === "tool");
    dropImages((m) => m.role === "user");
    console.warn(
      `[chat ${streamId}] hard-trimmed conv round=${round} to ${tokens} tokens (recap didn't fit)`
    );
    return true;
  };

  // Returns true when conv was compacted (shrunk). Self-gating on the trigger
  // so the caller can invoke it unconditionally at each round boundary.
  const maybeCompactConv = async (round: number): Promise<boolean> => {
    const tokensBefore = budgetedConvTokens(conv);
    if (tokensBefore <= compactionTrigger) return false;

    const { headEnd, tailStart } = segmentConv();
    if (tailStart <= headEnd) {
      // Nothing foldable (everything is pinned head or one big tail). The
      // backstop still guarantees we stay under the wall — silent, no card.
      enforceHardLimit(round);
      return false;
    }

    const middle = conv.slice(headEnd, tailStart);
    const messagesFolded = middle.length;
    // start + done are a guaranteed pair the client uses to show "Compacting
    // context…" and then persist the recap card.
    emit("compaction", { phase: "start", round, tokensBefore, messagesFolded });

    let recapText = "";
    try {
      const res = await withRetry(model, () =>
        llm.chat({
          model,
          messages: [
            { role: "system", content: TOOL_LOOP_SUMMARIZE_SYSTEM },
            ...middle.map(toSummarizerInput),
            {
              role: "user",
              content:
                "Summarize the tool rounds above into the recap described. Output only the summary.",
            },
          ],
          stream: false,
          think: false,
          options: optionsForModel(model),
        })
      );
      recapText = (res.message?.content ?? "").trim();
    } catch (err) {
      console.warn(
        `[chat ${streamId}] compaction summarize failed`,
        err instanceof Error ? err.message : String(err)
      );
    }

    let foldedCount = messagesFolded;
    if (recapText) {
      const recap = {
        role: "user",
        content: `${COMPACTION_SENTINEL}\n[Earlier in this turn, ${messagesFolded} message(s) of tool results were condensed to save context. The recent rounds below are kept in full; rely on this recap for anything not shown there.]\n\n${recapText}`,
      } as OllamaMessage;
      // In-place splice so the same `conv` reference the Checkpoint captured
      // (and the forced-finalize pass closes over) keeps pointing at the
      // compacted array — no extra handoff wiring needed.
      const head = conv.slice(0, headEnd);
      const tail = conv.slice(tailStart);
      conv.splice(0, conv.length, ...head, recap, ...tail);
    } else {
      // Empty summary: don't splice an empty recap (that would silently delete
      // tool context). Leave conv as-is; the backstop below still bounds it.
      foldedCount = 0;
    }

    const hardTrimmed = enforceHardLimit(round);
    const tokensAfter = budgetedConvTokens(conv);
    emit("compaction", {
      phase: "done",
      round,
      tokensBefore,
      tokensAfter,
      messagesFolded: foldedCount,
      summary: recapText,
      hardTrimmed,
    });
    console.log(
      `[chat ${streamId}] compacted conv round=${round} folded=${foldedCount} hardTrimmed=${hardTrimmed} tokens=${tokensBefore}→${tokensAfter}`
    );
    return foldedCount > 0;
  };

  try {
    // ---- image preprocessing ----
    // First-worker only. Skipped on continuation since `conv` already carries
    // the inlined captions / pdf text.
    const incomingForPreprocess: IncomingMsg[] | undefined = incoming;
    const totalImages = incomingForPreprocess
      ? incomingForPreprocess.reduce(
          (n, m) => n + (Array.isArray(m.images) ? m.images.length : 0),
          0
        )
      : 0;
    const totalPdfs = incomingForPreprocess
      ? incomingForPreprocess.reduce(
          (n, m) => n + (Array.isArray(m.pdfs) ? m.pdfs.length : 0),
          0
        )
      : 0;

    if (!skipPreprocessing && incomingForPreprocess && totalImages > 0) {
      if (visionNative) {
        emit("image_mode", {
          mode: "native",
          model,
          count: totalImages,
        });
        for (let i = 0; i < incomingForPreprocess.length; i++) {
          const src = incomingForPreprocess[i];
          if (!Array.isArray(src.images) || src.images.length === 0) continue;
          const target = conv[convOffset + i];
          if (!target) continue;
          const valid = src.images.filter(
            (img): img is IncomingImage =>
              !!img && typeof img.dataUrl === "string" && img.dataUrl.length > 0
          );
          if (valid.length === 0) continue;
          target.images = valid.map((img) => dataUrlToBase64(img.dataUrl));
        }
      } else {
        // Construct the describer client lazily — the describer model may
        // belong to a different provider than `model`, and we don't want to
        // fail the whole chat for a missing API key when the user didn't
        // even attach images requiring the describer.
        const describer = chatClientFor(describerModel, { runpodEndpointId });

        // Emit the "described" mode row lazily on the first cache miss so a
        // turn whose images were all described on a prior turn (the common
        // case — the client re-sends history every send) doesn't replay a
        // "describing images…" row for work that didn't actually run.
        let emittedImageMode = false;
        const ensureImageMode = () => {
          if (emittedImageMode) return;
          emittedImageMode = true;
          emit("image_mode", {
            mode: "described",
            describer: describerModel,
            mainModel: model,
            count: totalImages,
          });
        };

        for (let i = 0; i < incomingForPreprocess.length; i++) {
          const src = incomingForPreprocess[i];
          if (!Array.isArray(src.images) || src.images.length === 0) continue;
          const target = conv[convOffset + i];
          if (!target) continue;
          const captions: string[] = [];
          for (let k = 0; k < src.images.length; k++) {
            const img = src.images[k];
            if (!img || typeof img.dataUrl !== "string" || !img.dataUrl) continue;
            captions.push(await captionImage(img, k, i, describer, ensureImageMode));
          }
          if (captions.length > 0) {
            const head = target.content?.trim() ?? "";
            target.content = head
              ? `${head}\n\n${captions.join("\n\n")}`
              : captions.join("\n\n");
          }
        }
      }
    }

    if (!skipPreprocessing && incomingForPreprocess && totalPdfs > 0) {
      emit("pdf_mode", { mode: "inlined", count: totalPdfs });
      for (let i = 0; i < incomingForPreprocess.length; i++) {
        const src = incomingForPreprocess[i];
        if (!Array.isArray(src.pdfs) || src.pdfs.length === 0) continue;
        const target = conv[convOffset + i];
        if (!target) continue;
        const blocks: string[] = [];
        for (let k = 0; k < src.pdfs.length; k++) {
          const pdf = src.pdfs[k];
          if (!pdf || typeof pdf.text !== "string" || pdf.text.length === 0) continue;
          const pages = pdf.pageCount === 1 ? "1 page" : `${pdf.pageCount} pages`;
          const header = `[PDF ${k + 1} — ${pdf.name}, ${pages}${pdf.truncated ? ", truncated" : ""}]`;
          blocks.push(`${header}\n${pdf.text}`);
          emit("tool_call", {
            name: "attach_pdf",
            args: { name: pdf.name, pages: pdf.pageCount },
          });
          emit("tool_result", {
            name: "attach_pdf",
            summary: `${pages} · ${pdf.text.length.toLocaleString()} chars${pdf.truncated ? " (truncated)" : ""}`,
            pdfIndex: k,
            messageIndex: i,
          });
        }
        if (blocks.length > 0) {
          const head = target.content?.trim() ?? "";
          target.content = head
            ? `${head}\n\n${blocks.join("\n\n")}`
            : blocks.join("\n\n");
        }
      }
    }

    const totalCsvs = incomingForPreprocess
      ? incomingForPreprocess.reduce(
          (n, m) => n + (Array.isArray(m.csvs) ? m.csvs.length : 0),
          0
        )
      : 0;
    if (!skipPreprocessing && incomingForPreprocess && totalCsvs > 0) {
      emit("csv_mode", { mode: "inlined", count: totalCsvs });
      for (let i = 0; i < incomingForPreprocess.length; i++) {
        const src = incomingForPreprocess[i];
        if (!Array.isArray(src.csvs) || src.csvs.length === 0) continue;
        const target = conv[convOffset + i];
        if (!target) continue;
        const blocks: string[] = [];
        for (let k = 0; k < src.csvs.length; k++) {
          const csv = src.csvs[k];
          if (!csv || typeof csv.text !== "string" || csv.text.length === 0) continue;
          const rows = csv.rowCount === 1 ? "1 row" : `${csv.rowCount} rows`;
          const cols = csv.columnCount === 1 ? "1 column" : `${csv.columnCount} columns`;
          const header = `[CSV ${k + 1} — ${csv.name}, ${rows}, ${cols}${csv.truncated ? ", truncated" : ""}]`;
          blocks.push(`${header}\n${csv.text}`);
          emit("tool_call", {
            name: "attach_csv",
            args: { name: csv.name, rows: csv.rowCount, columns: csv.columnCount },
          });
          emit("tool_result", {
            name: "attach_csv",
            summary: `${rows}, ${cols} · ${csv.text.length.toLocaleString()} chars${csv.truncated ? " (truncated)" : ""}`,
            csvIndex: k,
            messageIndex: i,
          });
        }
        if (blocks.length > 0) {
          const head = target.content?.trim() ?? "";
          target.content = head
            ? `${head}\n\n${blocks.join("\n\n")}`
            : blocks.join("\n\n");
        }
      }
    }

    // ---- code-exec input files ----
    // Sandbox files (uploads + earlier produced outputs, including images
    // staged server-side in route.ts) are never inlined as content the way
    // images/pdfs/csvs are - they're pointers, not bytes. Without a name
    // listing in the conversation the model has no way to know what to pass
    // in run_code's input_files, so it never even tries. Surface each
    // attached message's file names/sizes/types here, mirroring the PDF/CSV
    // header pattern, so run_code's "use the exact names shown in the
    // conversation" instruction has something to point at.
    //
    // Two sources feed run_code's `available` set:
    //   1. m.files       - explicit sandbox uploads + earlier produced outputs
    //                      (Blob-backed pointers).
    //   2. turnImageFiles - images the user pasted/dragged this turn, decoded
    //                      from the inline base64 above. Announced and staged
    //                      from those bytes directly, so the model can open the
    //                      SAME image it sees inline and edit its pixels (e.g.
    //                      make a transparent background) with NO dependency on
    //                      Blob/auth. Announcing #1 but not #2 was the gap that
    //                      left the model dead-ending with "please upload the
    //                      image as a file" - it had the picture but no filename.
    const imagesByMessage = new Map<number, TurnImageFile[]>();
    for (const f of turnImageFiles) {
      const arr = imagesByMessage.get(f.messageIndex);
      if (arr) arr.push(f);
      else imagesByMessage.set(f.messageIndex, [f]);
    }
    const totalFiles = incomingForPreprocess
      ? incomingForPreprocess.reduce(
          (n, m, i) =>
            n +
            (Array.isArray(m.files) ? m.files.length : 0) +
            (imagesByMessage.get(i)?.length ?? 0),
          0
        )
      : 0;
    if (!skipPreprocessing && incomingForPreprocess && codeExecEnabled && totalFiles > 0) {
      for (let i = 0; i < incomingForPreprocess.length; i++) {
        const src = incomingForPreprocess[i];
        const target = conv[convOffset + i];
        if (!target) continue;
        const blocks: string[] = [];
        // Explicit sandbox files (uploads + earlier run_code outputs). Keep the
        // attach_file UI events keyed by the file's index within src.files so
        // the client's chip mapping stays intact.
        const files = Array.isArray(src.files) ? src.files : [];
        for (let k = 0; k < files.length; k++) {
          const f = files[k];
          if (!f || typeof f.name !== "string") continue;
          const size =
            typeof f.bytes === "number" && f.bytes > 0
              ? `${(f.bytes / 1024).toFixed(1)} KB`
              : "unknown size";
          const kind = f.contentType || "application/octet-stream";
          blocks.push(
            `[File ${blocks.length + 1} - ${f.name}, ${size}, ${kind}${
              f.produced ? ", produced by an earlier run_code call" : ""
            }]`
          );
          emit("tool_call", {
            name: "attach_file",
            args: { name: f.name, contentType: f.contentType, bytes: f.bytes },
          });
          emit("tool_result", {
            name: "attach_file",
            summary: `${f.name} · ${size}`,
            fileIndex: k,
            messageIndex: i,
          });
        }
        // Pasted/dragged images we decoded this turn. Announce the filename (text
        // only - the user already sees the image thumbnail, so we skip the
        // attach_file chip to avoid a duplicate/mismapped UI row) and explicitly
        // tie it to the inline image so the model opens the right one via
        // input_files instead of asking for a re-upload.
        for (const f of imagesByMessage.get(i) ?? []) {
          const size = f.bytes > 0 ? `${(f.bytes / 1024).toFixed(1)} KB` : "unknown size";
          blocks.push(
            `[File ${blocks.length + 1} - ${f.name}, ${size}, ${f.contentType}, same as the image shown above; pass "${f.name}" in run_code's input_files to read or edit its actual pixels]`
          );
        }
        if (blocks.length > 0) {
          const head = target.content?.trim() ?? "";
          target.content = head
            ? `${head}\n\n${blocks.join("\n")}`
            : blocks.join("\n");
        }
      }
    }

    // ---- novel mode pre-pass ----
    // When the user toggled "novel mode" on, run the outliner → sequential
    // chapter writer flow and EXIT after emitting `done`. The round loop is
    // skipped entirely — the assembled chapters ARE the answer, so a second
    // synthesizer pass over 25k+ words of prose would only truncate it.
    //
    // Resilience: the orchestrator is idempotent — cached outline + per-chapter
    // entries in the Redis scratchpad mean a resumed worker only writes the
    // chapters still missing. We run this branch unconditionally (no
    // startRound check) so the resumed worker also picks it up; preprocessing
    // skip is honored by the regular flow above.
    if (cfg.novelModeEnabled) {
      const lastUser = [...conv].reverse().find((m) => m.role === "user");
      const userQuestion =
        typeof lastUser?.content === "string" ? lastUser.content : "";
      try {
        const result = await orchestrateNovel({
          streamId,
          model,
          runpodEndpointId,
          publicOrigin,
          conv,
          userQuestion,
          length: cfg.novelLength ?? "standard",
          webSearchEnabled,
          workerDeadlineAt: workerStartedAt + HANDOFF_THRESHOLD_MS,
          canHandoff: workerSeq < maxWorkerSeq,
          presetOutline: cfg.novelOutline,
          emit: (event, data) => emit(event, data),
          onDelta: (text) => emit("delta", { text }),
          onUsage: (delta) => {
            totalPrompt += delta.promptTokens ?? 0;
            totalCompletion += delta.completionTokens ?? 0;
          },
        });
        // Push the assembled novel into conv so a checkpoint reflects what
        // the user sees. Not load-bearing in v1 (we emit done and return),
        // but defensive against future code that re-reads conv post-novel.
        conv.push({ role: "assistant", content: result.novelText });

        const novelWallMs = Date.now() - workerStartedAt;
        const novelTotalMs = totalDurationNs > 0 ? Math.round(totalDurationNs / 1e6) : novelWallMs;
        emit("usage", {
          promptTokens: totalPrompt,
          completionTokens: totalCompletion,
          evalMs: Math.round(totalEvalNs / 1e6),
          totalMs: novelTotalMs,
          tokensPerSec: lastTps || computeTokensPerSec(totalCompletion, totalEvalNs, totalDurationNs, novelWallMs),
        });
        emit("done", {});
        // Skip the round loop entirely. The finally block runs:
        // clearInterval(heartbeat), flushKvBatch, worker_finished trace,
        // setMeta(complete) — all of which we want.
        return;
      } catch (err) {
        if (err instanceof NovelHandoffNeededError) {
          // Orchestrator paused before starting a chapter it couldn't
          // finish. Hand off; the next worker reads the cached chapters
          // out of the scratchpad and resumes from the first missing one.
          console.log(
            `[chat ${streamId}] novel handoff: ${err.message}`
          );
          handoffRound = 0;
          await performHandoff();
          return;
        }
        console.warn(
          `[chat ${streamId}] novel orchestration failed`,
          err
        );
        emit("tool_result", {
          name: "novel:error",
          error:
            err instanceof Error
              ? err.message
              : "novel orchestration failed",
        });
        // Re-throw so the outer catch surfaces a user-facing error +
        // setMeta(error). Falling through to a regular round loop here
        // would confuse the user — the chat history has no usable state.
        throw err;
      }
    }

    // ---- plan mode pre-pass ----
    // Long coding tasks (large entry file + non-trivial user prompt) get
    // decomposed into bounded steps. Each step is its own constrained
    // agentic sub-call against the VFS tools, and the per-step result is
    // cached in the Redis scratchpad so worker handoffs and the user's
    // "Continue plan" button resume from the first uncached step rather
    // than restarting the whole edit.
    //
    // Trigger: cfg.planModeEnabled === true (explicit), OR undefined on
    // the initial worker and shouldUsePlanMode() returns true. The
    // decision is persisted back into cfg before saveCheckpoint so
    // successor workers stay in plan mode regardless of whether the
    // entry-size / prompt-length heuristic still holds for them (e.g. a
    // mid-chain worker reads a smaller post-step snapshot).
    const planModeActive =
      cfg.planModeEnabled === true ||
      (cfg.planModeEnabled === undefined &&
        opts.startRound === 0 &&
        !skipPreprocessing &&
        shouldUsePlanMode({ streamId, responseFormat, vfsCtx, conv, cfg }));

    if (planModeActive && vfsCtx) {
      // Sticky: write the decision into cfg so the checkpoint reflects it
      // and successor workers don't re-evaluate the heuristic.
      cfg.planModeEnabled = true;
      console.log(`[chat ${streamId}] plan mode active seq=${workerSeq}`);
      trace("plan_mode_entered", { seq: workerSeq });
      try {
        const result = await orchestratePlan({
          streamId,
          model,
          runpodEndpointId,
          conv,
          vfsCtx,
          responseFormat: responseFormat as "artifact-edit" | "vfs-edit",
          workerDeadlineAt: workerStartedAt + HANDOFF_THRESHOLD_MS,
          canHandoff: workerSeq < maxWorkerSeq,
          isFinalWorker: workerSeq >= maxWorkerSeq,
          // On Fly the worker has no per-request wall clock, so the 15-round
          // step cap (sized for Vercel's maxDuration) becomes a footgun on
          // legitimately data-heavy steps — the user sees "Step exhausted 15
          // rounds without calling Finish" even though we have all the time
          // in the world. Bump it well above any realistic step length and
          // let the model's own progress (or a manual Stop) end the loop.
          maxStepRounds: cfg.flyWorker === true ? 60 : undefined,
          emit: (event, data) => emit(event, data),
          onUsage: (delta) => {
            totalPrompt += delta.promptTokens ?? 0;
            totalCompletion += delta.completionTokens ?? 0;
          },
        });
        finishedVfs = true;
        vfsFinishSummary = `Plan complete · ${result.completedStepIds.length} step${
          result.completedStepIds.length === 1 ? "" : "s"
        }`;

        // Final delivery: emit vfs_final (the existing client renderer
        // picks it up and updates proposedArtifact/proposedVfs), usage,
        // done. Mirrors the post-loop block at the bottom of the round
        // loop — kept inline to skip queue drain / forced-finalize that
        // don't apply to a plan-mode turn.
        if (
          responseFormat === "vfs-edit" ||
          responseFormat === "artifact-edit"
        ) {
          const ops = changesFromDiff(initialFiles, vfsCtx.files);
          // Plan-mode steps don't get the Build tool, so run it here once at
          // the end so the client can auto-save (which gates on build.ok).
          // Skip if no files actually changed.
          let planBuild:
            | { ok: true; durationMs: number; warnings: unknown[] }
            | { ok: false; durationMs: number; errors: unknown[]; warnings: unknown[] }
            | undefined;
          if (ops.length > 0) {
            try {
              const built = await buildArtifact(vfsCtx.files, vfsCtx.entry);
              if (built.ok) {
                planBuild = {
                  ok: true,
                  durationMs: built.durationMs,
                  warnings: built.warnings,
                };
              } else {
                planBuild = {
                  ok: false,
                  durationMs: built.durationMs,
                  errors: built.errors,
                  warnings: built.warnings,
                };
              }
              emit("build_result", planBuild);
            } catch (err) {
              console.warn(
                `[chat ${streamId}] plan-mode build failed: ${
                  err instanceof Error ? err.message : String(err)
                }`
              );
            }
          }
          emit("vfs_final", {
            files: vfsCtx.files,
            entry: vfsCtx.entry,
            summary: vfsFinishSummary,
            ops,
            build: planBuild,
            finished: true,
          });
        }
        const planWallMs = Date.now() - workerStartedAt;
        const planTotalMs = totalDurationNs > 0 ? Math.round(totalDurationNs / 1e6) : planWallMs;
        emit("usage", {
          promptTokens: totalPrompt,
          completionTokens: totalCompletion,
          evalMs: Math.round(totalEvalNs / 1e6),
          totalMs: planTotalMs,
          tokensPerSec: lastTps || computeTokensPerSec(totalCompletion, totalEvalNs, totalDurationNs, planWallMs),
        });
        emit("done", {});
        return;
      } catch (err) {
        if (err instanceof PlanHandoffNeededError) {
          console.log(
            `[chat ${streamId}] plan handoff: ${err.message}`
          );
          trace("plan_handoff", { nextStepId: err.nextStepId });
          handoffRound = 0;
          await performHandoff();
          return;
        }
        if (err instanceof PlanPausedNeedsContinueError) {
          console.log(
            `[chat ${streamId}] plan paused (chain exhausted): ${err.message}`
          );
          trace("plan_paused", {
            nextStepId: err.nextStepId,
            completedCount: err.completedStepIds.length,
            totalSteps: err.totalSteps,
          });
          emit("plan_paused", {
            completedStepIds: err.completedStepIds,
            nextStepId: err.nextStepId,
            totalSteps: err.totalSteps,
            reason: "chain_exhausted",
          });
          // Persist checkpoint so /api/chat/plan-continue can rehydrate.
          // Status is marked "error" with a distinguishing message so the
          // resume route stops polling — the only way out is the
          // plan-continue button (which resets workerSeq and re-enters).
          try {
            await flushKvBatch();
            const cp: Checkpoint = {
              v: 1,
              conv,
              vfsCtx: vfsCtx
                ? {
                    files: vfsCtx.files,
                    entry: vfsCtx.entry,
                    readPaths: Array.from(vfsCtx.readPaths),
                    changes: vfsCtx.changes,
                    lastBuild: vfsCtx.lastBuild,
                    mode: vfsCtx.mode,
                    selection: vfsCtx.selection,
                  }
                : null,
              parser: parser.serialize(),
              totals: {
                totalPrompt,
                totalCompletion,
                totalEvalNs,
                totalDurationNs,
                lastTps,
              },
              flags: {
                producedProse,
                exitedWithToolsPending,
                finishedVfs,
                vfsFinishSummary,
                artifactProseHead,
                artifactDelivered,
              },
              cfg,
              round: 0,
              initialFiles,
              kvLossy,
            };
            await saveCheckpoint(streamId, cp);
            await setMeta(streamId, {
              status: "error",
              error: "plan_paused",
              finishedAt: Date.now(),
              kvLossy: kvLossy || undefined,
            });
          } catch (persistErr) {
            console.warn(
              `[chat ${streamId}] failed to persist plan-paused checkpoint`,
              persistErr
            );
          }
          // Skip the finally's setMeta(complete) — meta is already terminal.
          workerErrorMessage = "plan_paused";
          return;
        }
        // Planner JSON-parse / executor non-deadline failure: surface and
        // re-throw so the outer catch writes setMeta(error). We don't fall
        // back to the regular round loop — the partial VFS state from
        // failed steps could mislead the user.
        console.warn(
          `[chat ${streamId}] plan orchestration failed`,
          err
        );
        emit("tool_result", {
          name: "plan:error",
          error:
            err instanceof Error ? err.message : "plan orchestration failed",
        });
        throw err;
      }
    }

    // ---- research pre-pass ----
    // When the user toggled "research" on, run the iterative planner →
    // parallel sub-agents → lead reflection → optional follow-up rounds flow
    // BEFORE the round loop. The cumulative briefs are injected into `conv`
    // as a user message, and the round loop's existing machinery
    // then drives the synthesizer (whose system prompt was layered in by
    // route.ts). State persists across worker handoffs via the per-stream
    // scratchpad — re-issued workers reuse cached rounds instead of redoing
    // the search.
    //
    // Resilience: the orchestrator is idempotent — cached plan / briefs /
    // reflection entries in the Redis scratchpad mean a resumed worker only
    // runs the stage that was killed mid-flight. We run this branch on
    // EVERY worker entry (no startRound gate) so a handoff mid-orchestration
    // resumes correctly; the orchestrator's hydration loop short-circuits
    // when everything is already cached.
    //
    // Skip when:
    //   - skipPreprocessing is false on a resumed worker (preprocessing
    //     already done on the original; the orchestrator's idempotent
    //     resume picks up from the cached round state).
    //   - briefsContext has already been pushed into conv (queued turns
    //     after the first; the synthesizer can answer follow-ups from the
    //     existing brief corpus rather than re-researching).
    //
    // Soft failure: if the orchestrator throws (non-handoff), log + emit a
    // warning and fall back to the plain round loop with the synthesizer
    // prompt still in place — the model just won't have pre-computed briefs.
    const briefsAlreadyInConv =
      cfg.researchEnabled &&
      conv.some(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.startsWith("RESEARCH BRIEFS")
      );
    if (cfg.researchEnabled && !briefsAlreadyInConv) {
      // Last user-role message (after preprocessing has inlined captions /
      // PDF text) is the original question. Used as context for sub-agents
      // that only see their own sub-question.
      const lastUser = [...conv].reverse().find((m) => m.role === "user");
      const userQuestion =
        typeof lastUser?.content === "string" ? lastUser.content : "";
      try {
        const result = await orchestrateResearch({
          streamId,
          model,
          runpodEndpointId,
          publicOrigin,
          conv,
          userQuestion,
          framing: cfg.researchFraming,
          workerDeadlineAt: workerStartedAt + HANDOFF_THRESHOLD_MS,
          canHandoff: workerSeq < maxWorkerSeq,
          advancedWebEnabled,
          emit: (event, data) => emit(event, data),
        });
        // Inject the briefs into the conversation so the synthesizer (next
        // round loop iteration) reads them. User role keeps the model
        // unambiguous about whose turn it is to answer — many models treat
        // a post-user system message as out-of-band and skip the implicit
        // "now answer" cue, producing empty output.
        conv.push({
          role: "user",
          content: result.briefsContext,
        });
        // Pair a tool_call+tool_result so the timeline gets a "synthesis
        // starting" line without leaving the UI's phase indicator stuck on
        // "tool" (it flips back to "thinking" on the matching result).
        const totalBriefs = result.briefs.length;
        const totalRounds = result.plansByRound.length;
        emit("tool_call", {
          name: "research:synthesize",
          args: { subAgentCount: totalBriefs, rounds: totalRounds },
        });
        emit("tool_result", {
          name: "research:synthesize",
          summary:
            totalRounds > 1
              ? `synthesizing answer from ${totalBriefs} brief${totalBriefs === 1 ? "" : "s"} across ${totalRounds} research rounds`
              : `synthesizing answer from ${totalBriefs} brief${totalBriefs === 1 ? "" : "s"}`,
        });
        // Treat the synthesis pre-pass as "tools pending" so the forced-
        // finalize pass below fires if the synthesizer round terminates
        // silently (no prose, no tool calls). Without this, an empty
        // synthesizer reply breaks the round loop with no recovery.
        exitedWithToolsPending = true;
      } catch (err) {
        if (err instanceof ResearchHandoffNeededError) {
          // Orchestrator paused before starting a stage it couldn't finish.
          // Hand off; the next worker re-enters the orchestrator, reads the
          // cached plan / briefs / reflection out of the scratchpad, and
          // resumes from the first uncached stage.
          console.log(`[chat ${streamId}] research handoff: ${err.message}`);
          handoffRound = 0;
          await performHandoff();
          return;
        }
        console.warn(
          `[chat ${streamId}] research orchestration failed; falling back to single-loop`,
          err
        );
        emit("tool_result", {
          name: "research:error",
          error:
            err instanceof Error
              ? err.message
              : "research orchestration failed",
        });
      }
    }

    // ---- outer turn loop ----
    // Each iteration is one user→assistant turn. The first iteration handles
    // the user's original message (already in `conv`); subsequent iterations
    // process whatever queued follow-up messages the client posted via
    // /api/chat/queue/{streamId} while the previous turn was streaming.
    // Loop terminates when the queue is empty (with grace) or the per-worker
    // cap fires; the worker handoff at HANDOFF_THRESHOLD_MS keeps the chain
    // alive past one worker's wall budget if many queued turns accumulate.
    turnLoop: while (true) {
    // ---- main round loop ----
    // Reset round to 0 on queued turns; the initial turn honors startRound
    // (which the resumed-from-checkpoint path uses to skip already-done rounds).
    let round = queuedTurnsHandled === 0 ? opts.startRound : 0;
    // Edit-mode safety net: how many times this turn we've re-prompted a
    // model that answered an edit request in prose instead of calling a
    // tool. Bounded so a model that simply refuses to use tools still
    // terminates instead of burning every round. Reset per turn.
    let editNudges = 0;
    const MAX_EDIT_NUDGES = 2;
    for (; round < maxRounds; round++) {
      // Round-boundary stop check. The /api/chat/stop endpoint sets the
      // flag when the user clicks the composer Stop button; honoring it
      // here means the Fly worker (which has no per-request wall clock)
      // actually halts at the next safe boundary instead of running the
      // whole job to completion in the background.
      if (await isStopRequested(streamId)) {
        throw new UserStoppedError();
      }

      // Round-boundary fast path: if the wall-clock deadline has already
      // fired (or we've otherwise crossed the threshold), don't start
      // another round we can't finish. The deadline timer is the load-
      // bearing trigger now — this branch just avoids a wasted LLM call
      // when control happened to be between rounds when it fired (e.g.
      // mid-tool-execution). The mid-round abort path also drops in here
      // after stashing the partial assistant turn into `conv`.
      if (
        (deadlineHit || Date.now() - workerStartedAt > HANDOFF_THRESHOLD_MS) &&
        workerSeq < maxWorkerSeq
      ) {
        handoffRound = round;
        await performHandoff();
        return;
      }

      // Keep `conv` under the model's window before we re-send it. On a long
      // tool turn this folds older rounds into a recap (compaction); on a
      // pathological single-giant-result turn the backstop inside hard-trims.
      // Self-gates on the trigger, so calling unconditionally is cheap.
      await maybeCompactConv(round);

      let assistantContent = "";
      // Accumulate the model's reasoning for this round so we can feed it back
      // in the assistant turn (preserve_thinking). Interleaved-thinking models
      // (e.g. kimi-k2.7-code, thinking-only) need their prior reasoning kept in
      // the conversation across tool rounds, or the think->tool-call->think
      // chain breaks and they stop emitting tool calls.
      let assistantThinking = "";
      const toolCalls: ToolCall[] = [];
      // Set when the streaming loop notices the worker has crossed the
      // handoff threshold mid-response — either because the deadline timer
      // aborted the iterator, or because a per-chunk wall-clock check
      // tripped first. Without this, a model that thinks / streams
      // continuously past the threshold never reaches the round-boundary
      // check and Vercel kills the worker before the chain can advance —
      // surfacing the misleading "5-minute function limit" error despite
      // the chain having a 15-minute (3-worker) budget. We treat the
      // partial response as a completed turn, record it in conv with a
      // continuation directive, and fall through to the round-boundary
      // handoff (which the timer has already armed via deadlineHit).
      let midStreamHandoff = false;

      // Throttle for the mid-stream stop-flag poll below. The round-boundary
      // check (top of the loop) only fires between rounds — a single-round
      // answer streams to completion before it's ever consulted, so a Stop
      // click mid-answer did nothing until the whole reply finished. Polling
      // here (at most every STOP_POLL_INTERVAL_MS) lets the worker bail
      // mid-token: it aborts the upstream iterator and throws UserStoppedError,
      // which lands in the terminal "Stopped by user." meta so a reload doesn't
      // auto-resume a stream the user already killed.
      const STOP_POLL_INTERVAL_MS = 1500;
      let lastStopCheckAt = Date.now();

      const MAX_INSTREAM_CONTINUATIONS = 2;
      for (let cont = 0; cont <= MAX_INSTREAM_CONTINUATIONS; cont++) {
        const messagesForCall: OllamaMessage[] =
          cont > 0 && (assistantContent.length > 0 || toolCalls.length > 0)
            ? withContinuationPrefill(
                conv,
                assistantContent,
                toolCalls,
                "Your previous reply was cut off by a network error."
              )
            : conv;

        // Size the server-side context window to the actual payload so Ollama
        // Cloud doesn't clip the conversation to its small default num_ctx.
        // estimateConvTokens (not estimateMessageTokens) so the preserved
        // thinking traces + images already in `messagesForCall` are counted —
        // undercounting here is what let the prompt sail past the window. The
        // scaled view feeds num_ctx (contextWindowFor clamps to the model max,
        // so scaling up can only push toward the true ceiling, never past it);
        // the raw estimate is kept to form the calibration sample below.
        const estForCall = estimateConvTokens(messagesForCall);
        const numCtx = contextWindowFor(
          model,
          Math.ceil(estForCall * tokenScale)
        );

        try {
          // Keep think on: thinking-only models (kimi-k2.7-code) can't disable
          // it, and the agentic flow relies on interleaved thinking + tool
          // calls. We now preserve each round's `thinking` back into the
          // conversation (above) so the think->tool-call->think chain holds.
          const iter = await withRetry(
            model,
            () =>
              llm.chat({
                model,
                messages: messagesForCall,
                tools: toolsArg,
                think: true,
                stream: true,
                options: optionsForModel(model, numCtx),
              }),
            {
              onRetry: (attempt, err) =>
                console.warn(
                  `[chat ${streamId}] round ${round} handshake transient (attempt ${attempt}): ${
                    err instanceof Error ? err.message : String(err)
                  }`
                ),
            }
          );

          // Hand the iterator to the deadline timer so it can pre-empt the
          // stream if the worker runs long. The Ollama SDK returns an
          // AbortableAsyncIterator with an `.abort()` method; the LlmClient
          // type erases that, so we narrow defensively.
          const maybeAbortable = iter as unknown as { abort?: () => void };
          if (typeof maybeAbortable.abort === "function") {
            activeIter = { abort: () => maybeAbortable.abort!() };
          }

          for await (const part of iter) {
            // Mid-stream stop check. Polled (throttled) on every chunk so a
            // Stop click halts the reply as it streams rather than after the
            // round completes. Abort the upstream iterator first so token
            // generation actually ceases, then throw — the outer catch turns
            // UserStoppedError into the terminal "Stopped by user." state.
            if (Date.now() - lastStopCheckAt > STOP_POLL_INTERVAL_MS) {
              lastStopCheckAt = Date.now();
              if (await isStopRequested(streamId)) {
                activeIter?.abort();
                activeIter = null;
                throw new UserStoppedError();
              }
            }
            const thinking = part.message?.thinking;
            if (thinking) {
              assistantThinking += thinking;
              emit("thinking", { text: thinking });
            }
            const content = part.message?.content;
            if (content) {
              assistantContent += content;
              producedProse = true;
              if (responseFormat === "html-doc" || responseFormat === "chat") {
                if (!assistantContent.includes("<artifact>")) {
                  artifactProseHead = assistantContent;
                }
                parser.push(content);
              } else {
                emit("delta", { text: content });
              }
            }
            const calls = part.message?.tool_calls;
            if (calls && calls.length) {
              toolCalls.push(...calls);
            }
            if (part.done) {
              totalPrompt += part.prompt_eval_count ?? 0;
              totalCompletion += part.eval_count ?? 0;
              totalEvalNs += part.eval_duration ?? 0;
              totalDurationNs += part.total_duration ?? 0;
              lastDoneReason = part.done_reason;
              lastTps = computeTokensPerSec(
                totalCompletion,
                totalEvalNs,
                totalDurationNs,
              );
              // Learn how far our estimate undershot the model's real prompt
              // tokenization on the exact payload we just sent, so the next
              // round's budget guards gate against reality.
              observeTokenCalibration(estForCall, part.prompt_eval_count ?? 0);
            }

            // Mid-stream handoff fast path: if a chunk happens to arrive
            // right after we crossed the threshold (deadline timer fires
            // asynchronously), break out without waiting for the abort to
            // propagate. The deadline timer covers the harder case where
            // no chunks are arriving at all.
            if (
              workerSeq < maxWorkerSeq &&
              (deadlineHit ||
                Date.now() - workerStartedAt > HANDOFF_THRESHOLD_MS) &&
              (assistantContent.length > 0 || toolCalls.length > 0)
            ) {
              midStreamHandoff = true;
              break;
            }
          }
          activeIter = null;
          break;
        } catch (err) {
          activeIter = null;
          // Deadline timer aborted the iterator — treat as a clean cut,
          // not an upstream error. Fall through to the midStreamHandoff
          // branch below which stashes whatever we have and hands off.
          if (deadlineHit && workerSeq < maxWorkerSeq) {
            midStreamHandoff = true;
            break;
          }
          if (
            midStreamHandoff ||
            !isTransientErrorFor(model, err) ||
            cont >= MAX_INSTREAM_CONTINUATIONS
          ) {
            // If we already decided to hand off, treat any error from the
            // iterator's tear-down as expected and bail out of the retry
            // loop — the next worker will retry from the partial state.
            if (midStreamHandoff) break;
            throw err;
          }
          const backoff = 600 * 2 ** cont;
          console.warn(
            `[chat ${streamId}] round ${round} mid-stream transient — continuing with partial state (cont ${cont + 1}/${MAX_INSTREAM_CONTINUATIONS}) in ${backoff}ms: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          emit("tool_call", {
            name: "upstream_reconnect",
            args: { round, attempt: cont + 1 },
          });
          emit("tool_result", {
            name: "upstream_reconnect",
            summary: `Upstream blip — resuming from partial state (attempt ${cont + 1})`,
          });
          await new Promise((r) => setTimeout(r, backoff));
        }
      }

      if (midStreamHandoff) {
        // Stash whatever we've accumulated so the next worker continues
        // seamlessly. The user's bubble is already showing `assistantContent`
        // (we emitted it as deltas); the next worker's deltas will append to
        // the same bubble because we never emit `done` until the final
        // worker. The "continue exactly where it stopped" directive is a
        // system message in `conv` only — never sent to SSE — so the user
        // sees uninterrupted text, not a cut-off banner.
        //
        // Skip pushing an empty turn: if the deadline fired before any
        // content arrived (slow first-token / hung handshake), pushing an
        // empty assistant message would confuse the next model and produce
        // a worse continuation than just re-running the round fresh.
        if (assistantContent.length > 0 || toolCalls.length > 0) {
          conv.push({
            role: "assistant",
            content: assistantContent,
            ...(assistantThinking ? { thinking: assistantThinking } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          } as OllamaMessage);
          conv.push({
            role: "system",
            content:
              "Your previous reply was cut off mid-stream. Continue exactly where it stopped — do not repeat or re-introduce any text the user has already seen, do not acknowledge the interruption, and do not start a new sentence if the previous one was unfinished.",
          });
        }
        // The next worker should resume by starting a fresh round at this
        // index (the partial turn is now in conv as the prior assistant
        // turn). Hand off directly rather than looping back through the
        // round-boundary check — saves an iteration and avoids any chance
        // of starting another LLM call after the deadline has fired.
        handoffRound = round + 1;
        await performHandoff();
        return;
      }

      if (toolCalls.length === 0) {
        // Edit-mode safety net. Some tool-capable models (notably "Code"
        // variants like kimi-k2.7-code) occasionally answer an edit request
        // in *prose* - describing the change, or dumping the full rewrite
        // inside an <artifact> block - instead of calling Edit/Write. In an
        // edit canvas, prose is never applied to the file, so the user just
        // sees "No edits applied". Before giving up, push the prose turn into
        // conv (so the model sees its own reply) and re-prompt it to call a
        // tool. Only fires in edit modes, only when nothing has been edited
        // yet this turn (exitedWithToolsPending stays false until a round
        // actually calls a tool), and only up to MAX_EDIT_NUDGES times so a
        // model that flatly won't use tools still terminates into the
        // existing "No edits applied" path.
        //
        // Gated on the prose *looking like* an unapplied edit: an <artifact>
        // dump (the canonical misfire) or a long block of text (a rewrite
        // pasted as prose). Short prose is left alone so the legitimate
        // "I can't edit outside your <selection> - widen it" reply (and
        // other brief clarifications) aren't force-nudged into a bad edit.
        const isEditMode =
          responseFormat === "note-edit" ||
          responseFormat === "artifact-edit" ||
          responseFormat === "vfs-edit";
        const looksLikeUnappliedEdit =
          assistantContent.includes("<artifact>") ||
          assistantContent.trim().length > 240;
        if (
          isEditMode &&
          !exitedWithToolsPending &&
          !finishedVfs &&
          looksLikeUnappliedEdit &&
          editNudges < MAX_EDIT_NUDGES
        ) {
          editNudges++;
          console.warn(
            `[chat ${streamId}] edit-mode prose with no tool call; nudging (${editNudges}/${MAX_EDIT_NUDGES})`
          );
          conv.push({
            role: "assistant",
            content: assistantContent,
            ...(assistantThinking ? { thinking: assistantThinking } : {}),
          } as OllamaMessage);
          conv.push({
            role: "system",
            content:
              "Your reply was NOT applied - in this canvas the file only changes when you call a tool, and prose is ignored. Do not describe the change or paste the rewritten text in your reply, and never wrap content in <artifact> tags. Call Edit / MultiEdit / Write / Script now with the actual change to the file, then call Finish. If no change is genuinely needed, call Finish with a one-line reason.",
          } as OllamaMessage);
          emit("tool_result", {
            name: "edit:nudge",
            summary:
              "No edit applied - the model replied in prose. Asking it to make the change with a tool.",
          });
          continue;
        }
        // This is the terminal round — the model produced its final reply
        // with no further tool calls. Capture the text so a queued follow-up
        // can prepend it into `conv` as the prior assistant turn (without
        // this, the LLM would re-answer the original prompt instead of
        // building on its own response).
        if (assistantContent) lastAssistantText = assistantContent;
        if (cfg.researchEnabled && !assistantContent.trim()) {
          console.warn(
            `[chat ${streamId}] synthesizer round produced no prose; forced-finalize will fire`
          );
        }
        break;
      }
      // Sticky: once any round has executed tool calls, keep this true so the
      // forced-finalize pass below still fires if a later round terminates
      // silently (no tool calls and no prose) — otherwise the user sees the
      // tool actions in the timeline but no answer.
      exitedWithToolsPending = true;

      conv.push({
        role: "assistant",
        content: assistantContent,
        ...(assistantThinking ? { thinking: assistantThinking } : {}),
        tool_calls: toolCalls,
      } as OllamaMessage);

      for (const call of toolCalls) {
        const name = call.function.name;
        const args = call.function.arguments as Record<string, unknown>;
        // Resolve MCP connector tools up front: the wire-name (mcp_<id>_<tool>)
        // is what the protocol needs, but the activity timeline should show a
        // readable "Connector · tool" label. For everything else the two match.
        const mcpTarget = isMcpWireName(name) ? mcpDispatch.get(name) : undefined;
        const emitName = mcpTarget
          ? `${mcpTarget.connector.name} · ${mcpTarget.toolName}`
          : name;
        emit("tool_call", { name: emitName, args });

        if (vfsCtx && VFS_TOOL_NAMES.has(name)) {
          const vr = await executeVfsTool(name, args, vfsCtx);
          if (vr.ok) {
            for (const ev of vr.events ?? []) {
              if (ev.kind === "file_changed") {
                emit("file_changed", { path: ev.path, op: ev.op, content: ev.content ?? "" });
              } else if (ev.kind === "build_result") {
                emit("build_result", {
                  ok: ev.ok,
                  durationMs: ev.durationMs,
                  errors: ev.errors,
                  warnings: ev.warnings,
                });
              } else if (ev.kind === "finish") {
                finishedVfs = true;
                vfsFinishSummary = ev.summary;
              }
            }
            emit("tool_result", { name, summary: vr.summary });
            conv.push({
              role: "tool",
              content: typeof vr.result === "string" ? vr.result : JSON.stringify(vr.result),
              tool_name: name,
            } as OllamaMessage);
          } else {
            emit("tool_result", { name, error: vr.error });
            conv.push({
              role: "tool",
              content: JSON.stringify({ error: vr.error }),
              tool_name: name,
            } as OllamaMessage);
          }
          if (finishedVfs) break;
          continue;
        }

        // Honest headroom for this result: budgeted (calibrated) tokens vs the
        // window. Using the raw estimate here over-reports headroom on a
        // token-dense turn, so results pile up and the next round-boundary
        // compaction has to fold whole rounds; the scaled view trims each
        // oversized result at insertion instead. `remaining` is in budgeted
        // tokens, so convert back to characters via the calibrated ratio
        // (remaining / tokenScale = raw tokens, × 3.6 = chars).
        const used = budgetedConvTokens(conv);
        const remaining = wireBudget - used;
        const remainingChars = (remaining / tokenScale) * 3.6;
        const charBudget = Math.max(
          512,
          Math.min(MAX_FETCH_CHARS, Math.floor(remainingChars * 0.4))
        );

        // Route custom MCP connector tools to their session; everything else
        // goes to the built-in executor. Both return the same ToolExecResult
        // shape, so the result-handling below is shared. (mcpTarget/emitName
        // were resolved at the top of the loop.)
        const r = mcpTarget
          ? await executeMcpTool(
              getMcpSession(mcpTarget.connector),
              mcpTarget.connector,
              mcpTarget.toolName,
              args
            )
          : await executeTool(name, args, charBudget, {
          publicOrigin,
          vision: visionNative,
          // Pass the sandbox context whenever Code Execution is on - NOT gated
          // on codeExecUserHash. A pasted image stages from inline bytes with no
          // Blob namespace, so it must work even when Blob/auth didn't resolve a
          // userHash. userHash is still forwarded (undefined when absent) so
          // Blob-backed inputs + produced-output uploads work when it is present.
          ...(codeExecEnabled
            ? {
                codeExec: {
                  available: codeExecAvailable,
                  inlineFiles: codeExecInlineFiles,
                  userHash: codeExecUserHash,
                  sessionId: streamId,
                },
              }
            : {}),
        });
        if (r.ok) {
          // Sandbox runs may have produced downloadable files. Surface them to
          // the client (so the assistant message renders + persists download
          // chips) and add them to the in-turn available set so a follow-up
          // run_code can read them by name.
          if (r.files && r.files.length) {
            codeExecAvailable.push(...r.files);
            emit("files_produced", { files: r.files });
          }
          emit("tool_result", {
            name: emitName,
            summary: r.truncated ? `${r.summary} · trimmed to fit context` : r.summary,
          });
          // Attach any tool-produced images (e.g. a browse_page screenshot) to
          // the tool message so vision-capable models can see them. Only kept
          // when the active model is vision-native — otherwise they're inert
          // bytes on the wire.
          const toolImages =
            visionNative && r.images && r.images.length ? r.images : undefined;
          const resultJson = JSON.stringify(r.result);
          // Scale to budgeted tokens so the comparison against `remaining`
          // (also budgeted) is apples-to-apples.
          const resultTokenCost = Math.ceil(estimateTokens(resultJson) * tokenScale);
          if (resultTokenCost > remaining * 0.6) {
            const hardCap = Math.max(256, Math.floor(remainingChars * 0.3));
            const trimmed = resultJson.slice(0, hardCap) + "…[truncated]";
            conv.push({
              role: "tool",
              content: trimmed,
              tool_name: name,
              ...(toolImages ? { images: toolImages } : {}),
            } as OllamaMessage);
            emit("tool_result", { name: emitName, summary: "trimmed further to fit context" });
          } else {
            conv.push({
              role: "tool",
              content: resultJson,
              tool_name: name,
              ...(toolImages ? { images: toolImages } : {}),
            } as OllamaMessage);
          }
        } else {
          emit("tool_result", { name: emitName, error: r.error });
          conv.push({
            role: "tool",
            content: JSON.stringify({ error: r.error }),
            tool_name: name,
          } as OllamaMessage);
        }
      }

      if (finishedVfs) break;
    }

    // Forced-finalize pass — see comment on the original handler. Skipped
    // for both VFS modes (vfs-edit and note-edit) because the assistant's
    // "answer" in those modes is the file mutation, not prose.
    if (
      exitedWithToolsPending &&
      !producedProse &&
      responseFormat !== "vfs-edit" &&
      responseFormat !== "note-edit" &&
      responseFormat !== "artifact-edit" &&
      !finishedVfs
    ) {
      // This pass sends `conv` directly — it does NOT go through the round-
      // boundary maybeCompactConv, and the last round appended its tool results
      // AFTER that round's compaction check. So conv may be over the window
      // here; fold/trim it first (same guard the round loop applies) or this
      // call is exactly where a long tool turn overflows.
      await maybeCompactConv(round);
      const finalEst = estimateConvTokens(conv);
      const finalNumCtx = contextWindowFor(
        model,
        Math.ceil(finalEst * tokenScale)
      );
      const finalIter = await withRetry(
        model,
        () =>
          llm.chat({
            model,
            messages: conv,
            think: true,
            stream: true,
            options: optionsForModel(model, finalNumCtx),
          }),
        {
          onRetry: (attempt, err) =>
            console.warn(
              `[chat ${streamId}] forced-finalize transient error (attempt ${attempt}): ${
                err instanceof Error ? err.message : String(err)
              }`
            ),
        }
      );
      for await (const part of finalIter) {
        const thinking = part.message?.thinking;
        if (thinking) {
          emit("thinking", { text: thinking });
        }
        const content = part.message?.content;
        if (content) {
          producedProse = true;
          // Accumulate the forced-finalize text so a queued follow-up can
          // see what the assistant actually replied (the regular round loop
          // captures `assistantContent`; this branch streams via parser.push
          // / emit("delta") and would otherwise leave lastAssistantText empty).
          lastAssistantText += content;
          if (responseFormat === "html-doc" || responseFormat === "chat") {
            if (!artifactProseHead.includes("<artifact>")) {
              artifactProseHead += content;
            }
            parser.push(content);
          } else {
            emit("delta", { text: content });
          }
        }
        if (part.done) {
          totalPrompt += part.prompt_eval_count ?? 0;
          totalCompletion += part.eval_count ?? 0;
          totalEvalNs += part.eval_duration ?? 0;
          totalDurationNs += part.total_duration ?? 0;
          lastDoneReason = part.done_reason;
          lastTps = computeTokensPerSec(
            totalCompletion,
            totalEvalNs,
            totalDurationNs,
          );
          observeTokenCalibration(finalEst, part.prompt_eval_count ?? 0);
        }
      }
    }

    if (responseFormat === "html-doc" || responseFormat === "chat") {
      parser.end();
      if (responseFormat === "html-doc" && !artifactDelivered) {
        emit("error", {
          message:
            "The model finished without producing an <artifact>…</artifact> block. Try again, or pick a more capable model.",
        });
      }
    }

    if (
      (responseFormat === "vfs-edit" ||
        responseFormat === "note-edit" ||
        responseFormat === "artifact-edit") &&
      vfsCtx
    ) {
      const ops = changesFromDiff(initialFiles, vfsCtx.files);
      const lastBuild = vfsCtx.lastBuild;
      emit("vfs_final", {
        files: vfsCtx.files,
        entry: vfsCtx.entry,
        summary:
          vfsFinishSummary ||
          (ops.length
            ? `Updated ${ops.length} file${ops.length === 1 ? "" : "s"}.`
            : producedProse
              ? "No edits applied - the model described changes but made no tool calls. Some models can't do agentic editing; pick a tool-capable model or use “Edit files”."
              : "No changes."),
        ops,
        build: lastBuild
          ? lastBuild.ok
            ? { ok: true, durationMs: lastBuild.durationMs, warnings: lastBuild.warnings }
            : {
                ok: false,
                durationMs: lastBuild.durationMs,
                errors: lastBuild.errors,
                warnings: lastBuild.warnings,
              }
          : undefined,
        finished: finishedVfs,
      });
    }

    const wallMs = Date.now() - workerStartedAt;
    const finalTotalMs = totalDurationNs > 0 ? Math.round(totalDurationNs / 1e6) : wallMs;
    emit("usage", {
      promptTokens: totalPrompt,
      completionTokens: totalCompletion,
      evalMs: Math.round(totalEvalNs / 1e6),
      totalMs: finalTotalMs,
      tokensPerSec: computeTokensPerSec(
        totalCompletion,
        totalEvalNs,
        totalDurationNs,
        wallMs,
      ),
      // Reply hit the model's output-token ceiling and was cut off; the client
      // surfaces a "Continue" button so the user can extend it in place.
      truncated: lastDoneReason === "length",
    });

    // ---- queue drain ----
    // Pull any messages the client posted while this turn was streaming and
    // process them as a coalesced follow-up turn. Empty queue ⇒ fall through
    // to `emit("done", {})` below.
    const queued = await drainQueueWithGrace();
    if (queued.length === 0) break turnLoop;
    if (queuedTurnsHandled >= MAX_QUEUED_TURNS_PER_WORKER) {
      console.warn(
        `[chat ${streamId}] queued turn cap (${MAX_QUEUED_TURNS_PER_WORKER}) reached; remaining ${queued.length} queued message(s) will be dropped`
      );
      emit("error", {
        message:
          "Queued message limit reached for this stream — send the rest as a new message.",
        transient: false,
      });
      break turnLoop;
    }
    // If the deadline has fired, push the queued message back to Redis so
    // the next worker drains it after the handoff. We can't safely start a
    // new LLM call this close to the wall.
    if (
      (deadlineHit || Date.now() - workerStartedAt > HANDOFF_THRESHOLD_MS) &&
      workerSeq < MAX_WORKER_SEQ
    ) {
      // Re-enqueue (preserve order) so the successor picks them up.
      for (const q of queued) {
        try {
          await appendQueuedMessage(streamId, q);
        } catch (err) {
          console.warn(
            `[chat ${streamId}] failed to re-enqueue during handoff`,
            err
          );
        }
      }
      handoffRound = round;
      await performHandoff();
      return;
    }
    queuedTurnsHandled++;

    // Push the prior assistant's final reply into conv so the next LLM call
    // sees it as the previous turn. Skip when empty (e.g. the prior turn
    // errored before producing prose) — the model can still respond to the
    // queued user message standalone.
    if (lastAssistantText.trim()) {
      conv.push({
        role: "assistant",
        content: lastAssistantText,
      });
    }
    lastAssistantText = "";

    // Coalesce the queued batch into a single user turn. Multi-paragraph
    // join: the user typed these as separate sends, so preserve the gap.
    const coalescedContent = queued
      .map((q) => (typeof q.content === "string" ? q.content.trim() : ""))
      .filter((s) => s.length > 0)
      .join("\n\n");
    const allImages = queued.flatMap((q) => q.images ?? []);
    const allPdfs = queued.flatMap((q) => q.pdfs ?? []);
    const allCsvs = queued.flatMap((q) => q.csvs ?? []);
    const userTurnId = queued[0].id;
    const userCreatedAt = Date.now();
    const mergedIds = queued.map((q) => q.id);

    // Append the new user message to conv (we'll inline attachments next).
    const newUserConvIdx = conv.length;
    conv.push({ role: "user", content: coalescedContent });

    // Inline images / pdfs / csvs into the just-pushed user message before
    // the LLM sees it.
    await processQueuedAttachments(newUserConvIdx, allImages, allPdfs, allCsvs);

    // Echo the queued message into the SSE stream so the client can
    // reconcile its optimistic copy (or insert a fresh one on a reload).
    emit("user_turn", {
      id: userTurnId,
      content: coalescedContent,
      images: allImages,
      pdfs: allPdfs,
      csvs: allCsvs,
      createdAt: userCreatedAt,
      mergedIds,
    });
    // Tell the client to open a fresh assistant slot — subsequent deltas /
    // tool / vfs events on this stream attribute to this id.
    emit("assistant_turn", {
      id: crypto.randomUUID(),
      createdAt: userCreatedAt + 1,
      model,
    });

    // Reset per-turn state and loop back to a fresh round 0.
    resetPerTurnState();
    continue turnLoop;
    } // end turnLoop

    // Set meta to "complete" before emitting "done" to shrink the race
    // window where a queue POST sees status="running" after the drain.
    try {
      await setMeta(streamId, {
        status: "complete",
        finishedAt: Date.now(),
        kvLossy: kvLossy || undefined,
      });
    } catch {}
    emit("done", {});
  } catch (err) {
    // User-initiated stop is its own non-retryable terminal state. Surface
    // a fixed prose error so the client lands in the standard errored shape
    // (Continue / Retry on the bubble); never treated as transient even if
    // the underlying message happened to match a transient pattern. Clear
    // the flag so a retry on the same streamId isn't auto-stopped.
    if (err instanceof UserStoppedError) {
      workerErrorMessage = err.message;
      emit("error", { message: err.message, transient: false });
      try {
        await clearStopRequest(streamId);
      } catch {}
      try {
        await setMeta(streamId, {
          status: "error",
          error: err.message,
          finishedAt: Date.now(),
          kvLossy: kvLossy || undefined,
        });
      } catch (metaErr) {
        console.warn(`[chat ${streamId}] KV setMeta(error) failed`, metaErr);
      }
      return;
    }
    const raw = err instanceof Error ? err.message : "Unknown error";
    const transient = isTransientErrorFor(model, err);
    const message = transient ? friendlyErrorFor(model, raw) : raw;
    if (transient) {
      console.warn(`[chat ${streamId}] upstream transient error: ${raw}`);
    }
    workerErrorMessage = message;
    emit("error", { message, transient });
    try {
      await setMeta(streamId, {
        status: "error",
        error: message,
        finishedAt: Date.now(),
        kvLossy: kvLossy || undefined,
      });
    } catch (metaErr) {
      console.warn(`[chat ${streamId}] KV setMeta(error) failed`, metaErr);
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try {
      await flushKvBatch();
    } catch {}
    const finalElapsedMs = Date.now() - workerStartedAt;
    // Error wins over handoff — the handoff-failed branch sets BOTH handedOff
    // (to skip the finally's setMeta) and workerErrorMessage (to drive this
    // reason). Reporting "handoff" there would lie about what happened.
    const finishReason: "handoff" | "complete" | "error" = workerErrorMessage
      ? "error"
      : handedOff
      ? "handoff"
      : "complete";
    console.log(
      `[chat ${streamId}] worker seq=${workerSeq} finished reason=${finishReason} elapsedMs=${finalElapsedMs} promptTokens=${totalPrompt} completionTokens=${totalCompletion}`
    );
    // Await the trace append in finally — waitUntil keeps us alive until the
    // returned promise resolves, so we DO want this on the path. Without it,
    // a fast-finishing worker can return before Redis ever sees the trace.
    try {
      await appendWorkerTrace(streamId, {
        kind: "worker_finished",
        seq: workerSeq,
        ts: Date.now(),
        detail: {
          reason: finishReason,
          workerElapsedMs: finalElapsedMs,
          promptTokens: totalPrompt,
          completionTokens: totalCompletion,
          ...(workerErrorMessage
            ? { error: workerErrorMessage.slice(0, 200) }
            : {}),
        },
      });
    } catch {
      // Trace is best-effort; appendWorkerTrace already swallows.
    }
    if (handedOff) {
      // Next worker takes over — leave meta status="running" untouched so
      // the resume route keeps polling. workerSeq + workerStartedAt are
      // updated by the continuation endpoint when it begins.
      return;
    }
    try {
      const current = await getMeta(streamId);
      if (!current || current.status === "running") {
        await setMeta(streamId, {
          ...(current ?? { status: "running" }),
          status: "complete",
          finishedAt: Date.now(),
          kvLossy: kvLossy || undefined,
        });
      } else if (kvLossy && !current.kvLossy) {
        await setMeta(streamId, { ...current, kvLossy: true });
      }
    } catch (metaErr) {
      console.warn(`[chat ${streamId}] KV setMeta(complete) failed`, metaErr);
    }
  }
}

// Tokens-per-second from accumulated totals. Per-chunk math overwrote stats
// every round and zeroed out whenever a final chunk reported eval_count=0 or
// eval_duration=0 (common on the OpenAI-translation path when reasoning content
// arrives in the same tick as `[DONE]`). Falling back to total_duration keeps
// the denominator non-zero for upstreams that only report wall-clock time.
function computeTokensPerSec(
  completionTokens: number,
  evalNs: number,
  totalNs: number,
  wallMs?: number,
): number {
  if (completionTokens <= 0) return 0;
  const denomNs = evalNs > 0 ? evalNs : totalNs;
  if (denomNs > 0) return Math.round(completionTokens / (denomNs / 1e9));
  if (wallMs && wallMs > 0) return Math.round(completionTokens / (wallMs / 1000));
  return 0;
}
