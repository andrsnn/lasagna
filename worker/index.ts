// Fly.io chat worker.
//
// Long-lived Node process that consumes the shared `ollchat:jobs` queue
// (LPUSH'd by POST /api/chat) and runs `runChatWork` to completion. This
// is the off-Vercel home for the LLM streaming loop — no per-request
// wall clock, so a single worker can stream a 30-minute novel without
// any chained handoff.
//
// Scale-to-zero pattern:
//   1. /api/chat enqueues + calls Fly Machines API to start this machine.
//   2. Worker boots, opens BRPOP on the queue.
//   3. As streamIds arrive, worker spawns up to MAX_CONCURRENT fan-outs.
//   4. When the queue is empty for IDLE_EXIT_MS and no work is in flight,
//      the process exits 0. Fly's restart_policy = "no" keeps it stopped
//      until the next wake.
//
// The worker reuses the existing in-repo modules unchanged (runChatWork,
// stream-store, parsers, orchestrators). Set CHAT_HANDOFF_THRESHOLD_MS to
// a value larger than any realistic job duration so the legacy handoff
// path in work.ts never fires.

import {
  appendEvent,
  appendEvents,
  deleteExecJob,
  deleteJobPayload,
  deleteQueryJob,
  getMeta,
  deleteResearchRunJob,
  deleteResearchFramingJob,
  loadExecJob,
  loadJobPayload,
  loadQueryJob,
  loadRenderJob,
  loadResearchRunJob,
  loadResearchFramingJob,
  popExecJob,
  popJob,
  popCouncilJob,
  loadCouncilJob,
  deleteCouncilJob,
  popQueryJob,
  popRenderJob,
  popResearchRunJob,
  popResearchFramingJob,
  popScheduleJob,
  loadScheduleJob,
  deleteScheduleJob,
  setMeta,
  setRenderError,
  setRenderResult,
  type JobPayload,
} from "../app/lib/stream-store";
import { runScheduledTask } from "../app/lib/run-schedule";
import {
  acquireLock,
  releaseBudget,
  releaseLock,
  setResult as setScheduleResult,
} from "../app/lib/schedule-store";
import { runChatWork, type IncomingMsg } from "../app/api/chat/work";
import { runCouncilWork } from "../app/api/council/work";
import { runResearchFraming } from "../app/api/research/framing/work";
import type { FramerWorkOutcome } from "../app/lib/framing/work-output";
import { executeCode, executeQuery, executeResearch } from "../app/lib/executors";
import { runStructuredResearch } from "../app/lib/structured-research";
import { renderArtifactToPng } from "../app/lib/artifact/render-image";
import { captureError, captureException } from "../app/lib/error-log";
import { isStopRequested, UserStoppedError } from "../app/api/chat/stop-flag";
import type { VfsContext } from "../app/lib/ollama/tools";

const MAX_CONCURRENT = Number(process.env.WORKER_CONCURRENCY ?? 5);
const IDLE_EXIT_MS = Number(process.env.WORKER_IDLE_EXIT_MS ?? 30_000);
// Poll cadence when the queue is empty. Upstash REST doesn't expose
// BRPOP so we poll RPOP. 500 ms balances perceived latency (a job
// enqueued just after a poll waits at most half a second) against
// Upstash command volume (~2/s × 30 s idle = 60 RPOPs per cold-start
// cycle). Cheap enough that the always-on cost stays in the cents.
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 500);
// Hard kill timer per job. runChatWork has no AbortSignal hook, so we
// can't actually cancel it — instead we report the stream as errored
// and release the concurrency slot so other work proceeds. The runaway
// keeps running in the background and is terminated when the process
// exits during the next idle-exit window. Default 1 hour; the SSE
// stream is dead long before then for almost every legitimate job, so
// this is purely a backstop against a wedged provider call.
const KILL_AFTER_MS = Number(process.env.WORKER_KILL_AFTER_MS ?? 60 * 60 * 1000);
// Headless Chromium is memory-heavy (~300-400 MB peak per render). Capped at 1
// concurrent so a burst of exports can't OOM the VM; bump alongside the VM's
// memory_mb in fly.toml if you raise this.
const MAX_RENDERS = Number(process.env.WORKER_MAX_RENDERS ?? 1);
// artifact.query() jobs are single-shot Ollama calls — I/O-bound and short
// next to a full chat stream, so they get their own (more generous) budget
// independent of the chat concurrency cap. Defaults to MAX_CONCURRENT.
const MAX_QUERIES = Number(process.env.WORKER_MAX_QUERIES ?? MAX_CONCURRENT);
// Code-execution sandbox runs (artifact.exec). CPU + memory heavy (python /
// ffmpeg), so a tight cap independent of the chat/query budgets. Mirrors the
// EXEC_MAX_CONCURRENCY gate inside app/lib/exec/sandbox.ts.
const MAX_EXECS = Number(process.env.WORKER_MAX_EXECS ?? 2);
// Chat Structured-research runs. Each runs the full planner -> sub-agents ->
// reflection -> synthesis loop and can take minutes, so a tight cap bounds
// concurrent Ollama spend.
const MAX_RESEARCH_RUNS = Number(process.env.WORKER_MAX_RESEARCH_RUNS ?? 2);
// Hard ceiling for a single research run. Without it a wedged provider call
// (web_fetch has no AbortSignal) would pin one of the few slots forever, block
// idle-exit (activeResearchRuns stays > 0), and leave the in-chat viewer
// polling a result that never lands.
const RESEARCH_RUN_KILL_AFTER_MS = Number(
  process.env.WORKER_RESEARCH_RUN_KILL_AFTER_MS ?? 50 * 60 * 1000
);
// Research-framing jobs (the scoping-question pre-step). The framer's own
// budget is ~40s, so these are short; they get a generous concurrency budget
// next to the long research runs.
const MAX_RESEARCH_FRAMINGS = Number(
  process.env.WORKER_MAX_RESEARCH_FRAMINGS ?? MAX_CONCURRENT
);
// Hard ceiling for a single framing job. The framer self-terminates well
// under this; the timer is a backstop for a wedged provider / web_fetch call
// (no AbortSignal) so it can't pin a slot or block idle-exit. Stays in sync
// with the resume route's Fly stale-ceiling (6min) — set below it so the
// worker writes a terminal result before the resume route declares it dead.
const RESEARCH_FRAMING_KILL_AFTER_MS = Number(
  process.env.WORKER_RESEARCH_FRAMING_KILL_AFTER_MS ?? 5 * 60 * 1000
);
// Scheduled research runs (a research artifact's cadence / Run-now, handed off
// from the cron sweep so a multi-minute deep run doesn't time out inline).
// Shares the deep-research budget shape with the chat research runs.
const MAX_SCHEDULE_RUNS = Number(
  process.env.WORKER_MAX_SCHEDULE_RUNS ?? MAX_RESEARCH_RUNS
);
// Council runs (multi-member × multi-round debate + verifier + synthesizer).
// Long-running like a research run, so it gets the same budget shape — its own
// cap so a debate can't starve the chat/query/exec slots and vice versa.
const MAX_COUNCILS = Number(
  process.env.WORKER_MAX_COUNCILS ?? MAX_RESEARCH_RUNS
);
// Hard ceiling for a single council run. The orchestrator self-bounds (verifier
// ~60s, members/synth on provider calls with their own retries), but a wedged
// provider call has no AbortSignal — this backstop reports the stream errored
// and frees the slot so the machine can idle-exit.
const COUNCIL_KILL_AFTER_MS = Number(
  process.env.WORKER_COUNCIL_KILL_AFTER_MS ?? 20 * 60 * 1000
);

let active = 0;
let activeRenders = 0;
let activeQueries = 0;
let activeExecs = 0;
let activeResearchRuns = 0;
let activeResearchFramings = 0;
let activeScheduleRuns = 0;
let activeCouncils = 0;
let lastWorkAt = Date.now();
let shuttingDown = false;

function log(msg: string, extra?: Record<string, unknown>): void {
  const line = extra
    ? `[worker] ${msg} ${JSON.stringify(extra)}`
    : `[worker] ${msg}`;
  console.log(line);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Rehydrate the JSON-shape JobPayload back into the live VfsContext +
 *  IncomingMsg shapes that runChatWork expects. Set fields are
 *  reconstructed here. */
function rehydrate(payload: JobPayload): {
  conv: JobPayload["conv"];
  vfsCtx: VfsContext | null;
  initialFiles: JobPayload["initialFiles"];
  cfg: JobPayload["cfg"];
  incoming: IncomingMsg[];
  resume: JobPayload["resume"];
} {
  const vfsCtx: VfsContext | null = payload.vfsCtx
    ? {
        files: payload.vfsCtx.files,
        entry: payload.vfsCtx.entry,
        readPaths: new Set<string>(payload.vfsCtx.readPaths ?? []),
        changes: payload.vfsCtx.changes ?? [],
        lastBuild: payload.vfsCtx.lastBuild,
        mode: payload.vfsCtx.mode,
        selection: payload.vfsCtx.selection,
      }
    : null;

  return {
    conv: payload.conv,
    vfsCtx,
    initialFiles: payload.initialFiles,
    cfg: payload.cfg,
    incoming: (payload.incoming as IncomingMsg[]) ?? [],
    resume: payload.resume,
  };
}

async function runOne(streamId: string): Promise<void> {
  active++;
  lastWorkAt = Date.now();
  log("job started", { streamId, active });

  // Hard kill timer. On fire: emit a terminal error event for SSE
  // consumers, mark meta=error, log, and release the concurrency slot.
  // We can't actually abort runChatWork (no AbortSignal), so the slot
  // is released *here* and the `slotReleased` flag prevents the finally
  // block from decrementing `active` a second time when the runaway
  // promise eventually settles. The orphaned promise gets reaped on
  // the next process exit (idle-exit window or SIGTERM).
  let slotReleased = false;
  const releaseSlot = (): void => {
    if (slotReleased) return;
    slotReleased = true;
    active--;
    lastWorkAt = Date.now();
  };

  const killTimer = setTimeout(() => {
    log("kill timer fired — marking stream as errored", {
      streamId,
      afterMs: KILL_AFTER_MS,
    });
    void (async () => {
      try {
        await appendEvents(streamId, [
          {
            event: "error",
            data: {
              message: `Job exceeded the worker's ${Math.round(
                KILL_AFTER_MS / 60_000
              )}-minute wall clock and was terminated.`,
              recoverable: false,
            },
          },
          { event: "done", data: {} },
        ]);
        await setMeta(streamId, {
          status: "error",
          finishedAt: Date.now(),
          error: `worker kill timer (${KILL_AFTER_MS}ms)`,
        });
        await deleteJobPayload(streamId);
      } catch (err) {
        log("kill-timer error reporting failed", {
          streamId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        releaseSlot();
      }
    })();
  }, KILL_AFTER_MS);

  try {
    const payload = await loadJobPayload(streamId);
    if (!payload) {
      log("job payload missing — stream may have expired", { streamId });
      return;
    }

    // Status was set to "running" by the route on enqueue; refresh
    // workerStartedAt so the resume route's stale-detection uses the
    // actual producer-start time rather than the enqueue time. Reassert
    // producer="fly" — the route already set it but this rewrite would
    // otherwise drop the tag and the resume route would fall back to the
    // Vercel ceiling.
    const meta = await getMeta(streamId);
    await setMeta(streamId, {
      status: "running",
      createdAt: meta?.createdAt ?? Date.now(),
      workerStartedAt: Date.now(),
      workerSeq: 1,
      producer: "fly",
      chatId: meta?.chatId,
      messageId: meta?.messageId,
    });

    const { conv, vfsCtx, initialFiles, cfg, incoming, resume } =
      rehydrate(payload);

    if (resume) {
      // Plan-continue (or other user-triggered resume) path: the conv +
      // vfsCtx already reflect the prior chain's checkpoint, so skip
      // preprocessing and feed parser / totals / flags / kvLossy through
      // unchanged. This is the Fly-side mirror of the
      // /api/chat/plan-continue waitUntil branch in route.ts.
      await runChatWork({
        streamId,
        workerSeq: 1,
        conv,
        vfsCtx,
        initialFiles,
        cfg,
        parserState: resume.parser,
        totals: resume.totals,
        flags: resume.flags,
        startRound: 0,
        skipPreprocessing: true,
        kvLossy: resume.kvLossy,
      });
    } else {
      await runChatWork({
        streamId,
        workerSeq: 1,
        conv,
        vfsCtx,
        initialFiles,
        cfg,
        startRound: 0,
        skipPreprocessing: false,
        kvLossy: false,
        incoming,
      });
    }

    // If the kill timer already fired, the stream was reported errored
    // and the slot released. Anything runChatWork did past that point
    // is silently dropped (the SSE consumer has already seen `done`).
    if (slotReleased) {
      log("job finished after kill — discarding", { streamId });
      return;
    }

    // Best-effort cleanup of the one-shot job payload. The events list,
    // meta blob, and any checkpoint runChatWork wrote remain in Redis
    // for resume — only the initial-job snapshot is no longer useful.
    await deleteJobPayload(streamId);
    log("job finished", { streamId });
  } catch (err) {
    if (slotReleased) {
      // Kill timer already reported an error and released the slot;
      // suppress the follow-up exception that would otherwise overwrite
      // the kill-timer's meta entry.
      log("job threw after kill — discarding", {
        streamId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log("job threw", { streamId, error: msg });
    try {
      await appendEvents(streamId, [
        {
          event: "error",
          data: { message: `Worker error: ${msg}`, recoverable: false },
        },
        { event: "done", data: {} },
      ]);
      await setMeta(streamId, {
        status: "error",
        finishedAt: Date.now(),
        error: msg,
      });
    } catch (innerErr) {
      log("error reporting failed", {
        streamId,
        error: innerErr instanceof Error ? innerErr.message : String(innerErr),
      });
    }
  } finally {
    clearTimeout(killTimer);
    releaseSlot();
  }
}

/** Render one artifact → PNG and write the result back to Redis for the
 *  /api/artifact-image route to stream. Mirrors runOne's slot bookkeeping. */
async function runRender(jobId: string): Promise<void> {
  activeRenders++;
  lastWorkAt = Date.now();
  log("render started", { jobId, activeRenders });
  try {
    const job = await loadRenderJob(jobId);
    if (!job) {
      log("render job payload missing — may have expired", { jobId });
      return;
    }
    const png = await renderArtifactToPng(job.html, {
      width: job.width,
      scale: job.scale,
    });
    // PNG IHDR carries width/height at bytes 16-23 — cheap to read back for
    // the result header without re-measuring.
    const width = png.length >= 24 ? png.readUInt32BE(16) : job.width;
    const height = png.length >= 24 ? png.readUInt32BE(20) : 0;
    await setRenderResult(jobId, png, { width, height });
    log("render finished", { jobId, width, height, bytes: png.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("render threw", { jobId, error: msg });
    try {
      await setRenderError(jobId, msg);
    } catch (innerErr) {
      log("render error reporting failed", {
        jobId,
        error: innerErr instanceof Error ? innerErr.message : String(innerErr),
      });
    }
  } finally {
    activeRenders--;
    lastWorkAt = Date.now();
  }
}

/** Run one artifact.query() to completion and write the JSON result back to
 *  Redis as the `result` event + meta the resume route reads. This is the
 *  Fly-side mirror of the waitUntil block in app/api/query/route.ts — same
 *  event shape, same meta transitions, same error-log capture — so the
 *  iframe's /api/query/resume/{streamId} poll and pendingQuery recovery
 *  sweep work identically no matter which producer ran the job. */
async function runQuery(streamId: string): Promise<void> {
  activeQueries++;
  lastWorkAt = Date.now();
  log("query started", { streamId, activeQueries });
  try {
    const payload = await loadQueryJob(streamId);
    if (!payload) {
      log("query payload missing — stream may have expired", { streamId });
      return;
    }
    // One-shot snapshot; drop it early so a Redis blob doesn't linger past
    // the run. The events/meta keys carry the actual result.
    await deleteQueryJob(streamId);

    const appId = payload.appId;
    try {
      // Research apps set `research` to re-run the deep engine on refresh; the
      // worker has no per-request wall clock, so this is its proper home.
      const outcome = payload.research
        ? await executeResearch({
            prompt: payload.prompt,
            schema: payload.schema,
            model: payload.model,
          })
        : await executeQuery({
            prompt: payload.prompt,
            schema: payload.schema,
            model: payload.model,
            webSearch: payload.webSearch,
            system: payload.system,
            connectors: payload.connectors,
          });
      await appendEvent(streamId, {
        event: "result",
        data: { status: outcome.status, payload: outcome.payload },
      });
      const ok = outcome.status >= 200 && outcome.status < 300;
      await setMeta(streamId, {
        status: ok ? "complete" : "error",
        finishedAt: Date.now(),
        error: ok ? undefined : (outcome.payload as { error?: string }).error,
      });
      if (!ok) {
        const errPayload = outcome.payload as { error?: string; model?: string };
        await captureError({
          source: "query",
          message: errPayload.error ?? `Query failed (${outcome.status})`,
          appId,
          context: {
            status: outcome.status,
            model: errPayload.model ?? payload.model,
            webSearch: !!payload.webSearch,
            prompt: payload.prompt.slice(0, 300),
            streamId,
          },
        });
      }
      log("query finished", { streamId, status: outcome.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("query threw", { streamId, error: msg });
      // Surface the failure to the resume route so the iframe stops polling
      // and the artifact can show an error instead of hanging.
      try {
        await appendEvent(streamId, {
          event: "result",
          data: {
            status: 500,
            payload: { error: `Worker error: ${msg}`, model: payload.model ?? "" },
          },
        });
        await setMeta(streamId, {
          status: "error",
          finishedAt: Date.now(),
          error: msg,
        });
      } catch (innerErr) {
        log("query error reporting failed", {
          streamId,
          error: innerErr instanceof Error ? innerErr.message : String(innerErr),
        });
      }
      await captureException(err, {
        source: "query",
        appId,
        context: {
          streamId,
          model: payload.model,
          prompt: payload.prompt.slice(0, 300),
        },
      });
    }
  } finally {
    activeQueries--;
    lastWorkAt = Date.now();
  }
}

/** Run one artifact.exec() code-execution job to completion and write the
 *  result back as the `result` event + meta the /api/exec/resume route reads.
 *  Mirrors runQuery — same event shape, same meta transitions. */
async function runExec(streamId: string): Promise<void> {
  activeExecs++;
  lastWorkAt = Date.now();
  log("exec started", { streamId, activeExecs });
  try {
    const payload = await loadExecJob(streamId);
    if (!payload) {
      log("exec payload missing — stream may have expired", { streamId });
      return;
    }
    await deleteExecJob(streamId);

    const appId = payload.appId;
    try {
      const outcome = await executeCode({
        language: payload.language,
        code: payload.code,
        stdin: payload.stdin,
        inputFiles: payload.inputFiles,
        userHash: payload.userHash,
        timeoutMs: payload.timeoutMs,
        appId,
      });
      await appendEvent(streamId, {
        event: "result",
        data: { status: outcome.status, payload: outcome.payload },
      });
      const ok = outcome.status >= 200 && outcome.status < 300;
      await setMeta(streamId, {
        status: ok ? "complete" : "error",
        finishedAt: Date.now(),
        error: ok ? undefined : outcome.payload.error,
      });
      if (!ok) {
        await captureError({
          source: "query",
          message: outcome.payload.error ?? `Exec failed (${outcome.status})`,
          appId,
          context: { kind: "exec", language: payload.language, streamId },
        });
      }
      log("exec finished", { streamId, status: outcome.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("exec threw", { streamId, error: msg });
      try {
        await appendEvent(streamId, {
          event: "result",
          data: { status: 500, payload: { ok: false, error: `Worker error: ${msg}` } },
        });
        await setMeta(streamId, { status: "error", finishedAt: Date.now(), error: msg });
      } catch (innerErr) {
        log("exec error reporting failed", {
          streamId,
          error: innerErr instanceof Error ? innerErr.message : String(innerErr),
        });
      }
      await captureException(err, {
        source: "query",
        appId,
        context: { streamId, kind: "exec", language: payload.language },
      });
    }
  } finally {
    activeExecs--;
    lastWorkAt = Date.now();
  }
}

/** Run one chat Structured-research job to completion and write the
 *  {columns, schema, records} payload back as the same `result` event +
 *  meta that /api/query/resume reads — so the in-chat viewer polls it with the
 *  identical resume path as artifact.query. Mirrors runQuery. */
async function runResearchRun(streamId: string): Promise<void> {
  activeResearchRuns++;
  lastWorkAt = Date.now();
  log("research-run started", { streamId, activeResearchRuns });

  // Kill timer: on fire, report the stream errored and release the slot so the
  // viewer stops polling and the machine can idle-exit. The orphaned run keeps
  // going until the next process exit (we can't abort it), but it no longer
  // blocks anything. `slotReleased` stops the finally from double-decrementing.
  let slotReleased = false;
  const releaseSlot = (): void => {
    if (slotReleased) return;
    slotReleased = true;
    activeResearchRuns--;
    lastWorkAt = Date.now();
  };
  const killTimer = setTimeout(() => {
    log("research-run kill timer fired", { streamId, afterMs: RESEARCH_RUN_KILL_AFTER_MS });
    void (async () => {
      try {
        await appendEvent(streamId, {
          event: "result",
          data: {
            status: 504,
            payload: {
              error: `Research exceeded the ${Math.round(
                RESEARCH_RUN_KILL_AFTER_MS / 60_000
              )}-minute worker budget and was terminated.`,
            },
          },
        });
        await setMeta(streamId, {
          status: "error",
          finishedAt: Date.now(),
          error: `research-run kill timer (${RESEARCH_RUN_KILL_AFTER_MS}ms)`,
        });
      } catch (err) {
        log("research-run kill-timer reporting failed", {
          streamId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        releaseSlot();
      }
    })();
  }, RESEARCH_RUN_KILL_AFTER_MS);

  try {
    const payload = await loadResearchRunJob(streamId);
    if (!payload) {
      log("research-run payload missing — stream may have expired", { streamId });
      return;
    }
    await deleteResearchRunJob(streamId);
    try {
      if (payload.kind === "report") {
        // Multi Research report: run the deep-research engine with NO schema so
        // it synthesizes a full markdown report, and write the same `result`
        // event + meta shape /api/query/resume reads. Durable here on the
        // worker (1-hour budget + kill timer) instead of a bounded Vercel
        // waitUntil — so the user can close the tab and come back to the result.
        const outcome = await executeResearch({
          prompt: payload.query,
          model: payload.model,
          depth: payload.depth,
          onProgress: (stage) => {
            void appendEvent(streamId, { event: "progress", data: { stage, at: Date.now() } });
          },
          shouldStop: () => isStopRequested(streamId),
        });
        await appendEvent(streamId, {
          event: "result",
          data: { status: outcome.status, payload: outcome.payload },
        });
        await setMeta(streamId, {
          status: outcome.status >= 400 ? "error" : "complete",
          finishedAt: Date.now(),
          ...(outcome.status >= 400 && "error" in outcome.payload
            ? { error: outcome.payload.error }
            : {}),
        });
        log("report-run finished", { streamId, status: outcome.status });
      } else {
        const result = await runStructuredResearch({
          query: payload.query,
          columns: payload.columns,
          idKeys: payload.idKeys,
          priorRecords: payload.priorRecords,
          model: payload.model,
          onProgress: (stage) => {
            // Fire-and-forget liveness markers the viewer polls. Best-effort.
            void appendEvent(streamId, { event: "progress", data: { stage, at: Date.now() } });
          },
          shouldStop: () => isStopRequested(streamId),
        });
        await appendEvent(streamId, {
          event: "result",
          data: { status: 200, payload: result },
        });
        await setMeta(streamId, { status: "complete", finishedAt: Date.now() });
        log("research-run finished", { streamId, records: result.records.length });
      }
    } catch (err) {
      // User Stop: terminal, but expected — release cleanly without logging it
      // as an exception. The viewer already marked the run stopped client-side.
      if (err instanceof UserStoppedError) {
        log("research-run stopped by user", { streamId });
        try {
          await appendEvent(streamId, {
            event: "result",
            data: { status: 499, payload: { error: "Stopped by user.", stopped: true } },
          });
          await setMeta(streamId, { status: "error", finishedAt: Date.now(), error: "Stopped by user." });
        } catch {
          /* best-effort terminal write */
        }
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      log("research-run threw", { streamId, error: msg });
      try {
        await appendEvent(streamId, {
          event: "result",
          data: { status: 500, payload: { error: `Worker error: ${msg}` } },
        });
        await setMeta(streamId, { status: "error", finishedAt: Date.now(), error: msg });
      } catch (innerErr) {
        log("research-run error reporting failed", {
          streamId,
          error: innerErr instanceof Error ? innerErr.message : String(innerErr),
        });
      }
      await captureException(err, { source: "query", context: { streamId, kind: "research-run" } });
    }
  } finally {
    clearTimeout(killTimer);
    releaseSlot();
  }
}

/** Run one research-framing job to completion and write the framer's
 *  {status, payload} envelope back as the same `result` event +
 *  meta that /api/research/framing/resume reads — so the framing card resumes
 *  with the identical path no matter which producer ran the job. Mirrors
 *  runResearchRun's slot bookkeeping; this is the Fly-side mirror of the
 *  waitUntil block in app/api/research/framing/route.ts. */
async function runResearchFramingJob(streamId: string): Promise<void> {
  activeResearchFramings++;
  lastWorkAt = Date.now();
  log("research-framing started", { streamId, activeResearchFramings });

  // Refresh workerStartedAt + reassert producer="fly" so the resume route's
  // stale-detection bounds the actual worker run, not the enqueue time. The
  // route already set producer="fly"; this rewrite would otherwise drop it.
  const meta = await getMeta(streamId);
  await setMeta(streamId, {
    status: "running",
    createdAt: meta?.createdAt ?? Date.now(),
    workerStartedAt: Date.now(),
    workerSeq: 1,
    producer: "fly",
    chatId: meta?.chatId,
    messageId: meta?.messageId,
  });

  let slotReleased = false;
  const releaseSlot = (): void => {
    if (slotReleased) return;
    slotReleased = true;
    activeResearchFramings--;
    lastWorkAt = Date.now();
  };
  const killTimer = setTimeout(() => {
    log("research-framing kill timer fired", {
      streamId,
      afterMs: RESEARCH_FRAMING_KILL_AFTER_MS,
    });
    void (async () => {
      try {
        // Status 500 (not 504): the single-result resume helper returns the
        // result event's status verbatim, and the client treats 504 as
        // "still running, retry" — which would loop forever. 500 is terminal,
        // so the framing card falls back to "run as-is".
        await appendEvent(streamId, {
          event: "result",
          data: {
            status: 500,
            payload: {
              error: `Framing exceeded the ${Math.round(
                RESEARCH_FRAMING_KILL_AFTER_MS / 60_000
              )}-minute worker budget and was terminated.`,
            },
          },
        });
        await setMeta(streamId, {
          status: "error",
          finishedAt: Date.now(),
          error: `research-framing kill timer (${RESEARCH_FRAMING_KILL_AFTER_MS}ms)`,
        });
      } catch (err) {
        log("research-framing kill-timer reporting failed", {
          streamId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        releaseSlot();
      }
    })();
  }, RESEARCH_FRAMING_KILL_AFTER_MS);

  try {
    const payload = await loadResearchFramingJob(streamId);
    if (!payload) {
      log("research-framing payload missing — stream may have expired", { streamId });
      return;
    }
    await deleteResearchFramingJob(streamId);

    let outcome: FramerWorkOutcome;
    try {
      outcome = await runResearchFraming({
        turns: payload.turns,
        framerModel: payload.framerModel,
        runpodEndpointId: payload.runpodEndpointId,
        publicOrigin: payload.publicOrigin,
        // Mirror live reasoning / progress into the events list so the resume
        // endpoint streams it to the framing card. Best-effort — a Redis hiccup
        // on a progress append must never fail the framer job.
        onEvent: async (ev) => {
          try {
            await appendEvent(streamId, ev);
          } catch {
            /* progress is diagnostic — drop on failure */
          }
        },
      });
    } catch (err) {
      outcome = {
        status: 500,
        payload: {
          error: err instanceof Error ? err.message : "Framer failed",
        },
      };
    }
    if (slotReleased) {
      log("research-framing finished after kill — discarding", { streamId });
      return;
    }
    await appendEvent(streamId, { event: "result", data: outcome });
    const ok = outcome.status >= 200 && outcome.status < 300;
    await setMeta(streamId, {
      status: ok ? "complete" : "error",
      finishedAt: Date.now(),
      error: ok ? undefined : (outcome.payload as { error?: string }).error,
    });
    log("research-framing finished", { streamId, status: outcome.status });
  } catch (err) {
    if (slotReleased) {
      log("research-framing threw after kill — discarding", {
        streamId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log("research-framing threw", { streamId, error: msg });
    try {
      await appendEvent(streamId, {
        event: "result",
        data: { status: 500, payload: { error: `Worker error: ${msg}` } },
      });
      await setMeta(streamId, { status: "error", finishedAt: Date.now(), error: msg });
    } catch (innerErr) {
      log("research-framing error reporting failed", {
        streamId,
        error: innerErr instanceof Error ? innerErr.message : String(innerErr),
      });
    }
    await captureException(err, {
      source: "query",
      context: { streamId, kind: "research-framing" },
    });
  } finally {
    clearTimeout(killTimer);
    releaseSlot();
  }
}

/** Run one handed-off scheduled research task to completion. Reuses the shared
 *  runScheduledTask (with onWorker:true so it executes inline instead of
 *  re-dispatching), which writes the result into the schedule store via the
 *  same bookkeeping the inline runner uses — so the artifact's
 *  onScheduleUpdate / scheduled() picks it up. Lock-serialized against any
 *  concurrent run for the same app; the Vercel dispatcher released its lock
 *  the instant it enqueued, so acquiring it here normally succeeds. */
async function runScheduleJob(appId: string): Promise<void> {
  activeScheduleRuns++;
  lastWorkAt = Date.now();
  log("schedule-run started", { appId, activeScheduleRuns });

  let slotReleased = false;
  const releaseSlot = (): void => {
    if (slotReleased) return;
    slotReleased = true;
    activeScheduleRuns--;
    lastWorkAt = Date.now();
  };
  let locked = false;
  const killTimer = setTimeout(() => {
    log("schedule-run kill timer fired", { appId, afterMs: RESEARCH_RUN_KILL_AFTER_MS });
    void (async () => {
      try {
        await setScheduleResult(appId, {
          result: null,
          runAt: Date.now(),
          status: "error",
          error: `Research exceeded the ${Math.round(
            RESEARCH_RUN_KILL_AFTER_MS / 60_000
          )}-minute worker budget and was terminated.`,
        });
        await releaseBudget(appId).catch(() => {});
      } catch (err) {
        log("schedule-run kill-timer reporting failed", {
          appId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (locked) {
          try {
            await releaseLock(appId);
          } catch {
            /* best-effort */
          }
          locked = false;
        }
        releaseSlot();
      }
    })();
  }, RESEARCH_RUN_KILL_AFTER_MS);

  try {
    const payload = await loadScheduleJob(appId);
    if (!payload) {
      log("schedule-run payload missing — may have expired", { appId });
      return;
    }
    await deleteScheduleJob(appId);
    locked = await acquireLock(appId);
    if (!locked) {
      log("schedule-run skipped — lock held by another run", { appId });
      return;
    }
    try {
      await runScheduledTask(appId, payload.task, { onWorker: true });
      log("schedule-run finished", { appId });
    } finally {
      if (locked) {
        try {
          await releaseLock(appId);
        } catch {
          /* best-effort */
        }
        locked = false;
      }
    }
  } catch (err) {
    // runScheduledTask writes its own error result on failure; this is a
    // backstop for an unexpected throw outside that path.
    log("schedule-run threw", { appId, error: err instanceof Error ? err.message : String(err) });
    await captureException(err, { source: "schedule", context: { appId, kind: "schedule-run" } });
  } finally {
    clearTimeout(killTimer);
    releaseSlot();
  }
}

/** Run one council debate to completion. runCouncilWork manages its own SSE
 *  events + meta transitions (it emits `done` and sets meta complete/error
 *  itself), so this wrapper only does slot bookkeeping, a producer="fly" meta
 *  refresh (so the chat resume route's stale-detection uses the Fly ceiling,
 *  not the Vercel one), and a kill-timer backstop. Mirrors runResearchRun. */
async function runCouncil(streamId: string): Promise<void> {
  activeCouncils++;
  lastWorkAt = Date.now();
  log("council started", { streamId, activeCouncils });

  // Refresh workerStartedAt + reassert producer="fly" so the resume route
  // bounds the actual worker run, not the enqueue time.
  const meta = await getMeta(streamId);
  await setMeta(streamId, {
    status: "running",
    createdAt: meta?.createdAt ?? Date.now(),
    workerStartedAt: Date.now(),
    workerSeq: 1,
    producer: "fly",
    chatId: meta?.chatId,
    messageId: meta?.messageId,
  });

  let slotReleased = false;
  const releaseSlot = (): void => {
    if (slotReleased) return;
    slotReleased = true;
    activeCouncils--;
    lastWorkAt = Date.now();
  };
  const killTimer = setTimeout(() => {
    log("council kill timer fired", { streamId, afterMs: COUNCIL_KILL_AFTER_MS });
    void (async () => {
      try {
        await appendEvents(streamId, [
          {
            event: "error",
            data: {
              message: `Council exceeded the ${Math.round(
                COUNCIL_KILL_AFTER_MS / 60_000
              )}-minute worker budget and was terminated.`,
              recoverable: false,
            },
          },
          { event: "done", data: {} },
        ]);
        await setMeta(streamId, {
          status: "error",
          finishedAt: Date.now(),
          error: `council kill timer (${COUNCIL_KILL_AFTER_MS}ms)`,
        });
        await deleteCouncilJob(streamId);
      } catch (err) {
        log("council kill-timer reporting failed", {
          streamId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        releaseSlot();
      }
    })();
  }, COUNCIL_KILL_AFTER_MS);

  try {
    const payload = await loadCouncilJob(streamId);
    if (!payload) {
      log("council payload missing — stream may have expired", { streamId });
      return;
    }
    await deleteCouncilJob(streamId);

    await runCouncilWork({
      streamId,
      conv: payload.conv,
      members: payload.members,
      situationId: payload.situationId,
      framing: payload.framing,
      debateRounds: payload.debateRounds,
      synthesizerModel: payload.synthesizerModel,
      runpodEndpointId: payload.runpodEndpointId,
      publicOrigin: payload.publicOrigin,
    });

    if (slotReleased) {
      log("council finished after kill — discarding", { streamId });
      return;
    }
    log("council finished", { streamId });
  } catch (err) {
    if (slotReleased) {
      log("council threw after kill — discarding", {
        streamId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // runCouncilWork sets its own error meta on a handled failure; this is a
    // backstop for an unexpected throw outside that path.
    const msg = err instanceof Error ? err.message : String(err);
    log("council threw", { streamId, error: msg });
    try {
      await appendEvents(streamId, [
        { event: "error", data: { message: `Worker error: ${msg}`, recoverable: false } },
        { event: "done", data: {} },
      ]);
      await setMeta(streamId, { status: "error", finishedAt: Date.now(), error: msg });
    } catch (innerErr) {
      log("council error reporting failed", {
        streamId,
        error: innerErr instanceof Error ? innerErr.message : String(innerErr),
      });
    }
    await captureException(err, { source: "other", context: { streamId, kind: "council" } });
  } finally {
    clearTimeout(killTimer);
    releaseSlot();
  }
}

async function main(): Promise<void> {
  log("starting", {
    maxConcurrent: MAX_CONCURRENT,
    maxRenders: MAX_RENDERS,
    maxQueries: MAX_QUERIES,
    maxExecs: MAX_EXECS,
    maxResearchRuns: MAX_RESEARCH_RUNS,
    maxResearchFramings: MAX_RESEARCH_FRAMINGS,
    maxScheduleRuns: MAX_SCHEDULE_RUNS,
    maxCouncils: MAX_COUNCILS,
    idleExitMs: IDLE_EXIT_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    killAfterMs: KILL_AFTER_MS,
    handoffMs: process.env.CHAT_HANDOFF_THRESHOLD_MS ?? "(default 250000)",
  });

  process.on("SIGTERM", () => {
    log("SIGTERM received, draining…");
    shuttingDown = true;
  });
  process.on("SIGINT", () => {
    log("SIGINT received, draining…");
    shuttingDown = true;
  });

  while (true) {
    if (
      shuttingDown &&
      active === 0 &&
      activeRenders === 0 &&
      activeQueries === 0 &&
      activeExecs === 0 &&
      activeResearchRuns === 0 &&
      activeResearchFramings === 0 &&
      activeScheduleRuns === 0 &&
      activeCouncils === 0
    ) {
      log("drain complete, exiting");
      process.exit(0);
    }

    // Render jobs first — they're short and memory-bound, and draining them
    // promptly keeps the export route's poll latency low. Gated by its own
    // concurrency cap independent of the chat budget.
    if (activeRenders < MAX_RENDERS) {
      let renderJobId: string | null = null;
      try {
        renderJobId = await popRenderJob();
      } catch (err) {
        log("popRenderJob threw — backing off 2s", {
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(2000);
        continue;
      }
      if (renderJobId) {
        void runRender(renderJobId);
        continue;
      }
    }

    // artifact.query() jobs next — also short and I/O-bound. Drained on their
    // own budget so a burst of queries doesn't starve (or get starved by) the
    // chat stream slots, and an iframe waiting on a result gets a low-latency
    // turnaround.
    if (activeQueries < MAX_QUERIES) {
      let queryStreamId: string | null = null;
      try {
        queryStreamId = await popQueryJob();
      } catch (err) {
        log("popQueryJob threw — backing off 2s", {
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(2000);
        continue;
      }
      if (queryStreamId) {
        void runQuery(queryStreamId);
        continue;
      }
    }

    // Code-execution sandbox jobs (artifact.exec). Own budget so a heavy
    // ffmpeg run doesn't starve chat/query slots and vice versa.
    if (activeExecs < MAX_EXECS) {
      let execStreamId: string | null = null;
      try {
        execStreamId = await popExecJob();
      } catch (err) {
        log("popExecJob threw — backing off 2s", {
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(2000);
        continue;
      }
      if (execStreamId) {
        void runExec(execStreamId);
        continue;
      }
    }

    // Structured-research runs (chat). Long-running; own budget so they don't
    // starve chat/query/exec slots, and so a run started before the user closed
    // the tab finishes here regardless of duration.
    if (activeResearchRuns < MAX_RESEARCH_RUNS) {
      let researchStreamId: string | null = null;
      try {
        researchStreamId = await popResearchRunJob();
      } catch (err) {
        log("popResearchRunJob threw — backing off 2s", {
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(2000);
        continue;
      }
      if (researchStreamId) {
        void runResearchRun(researchStreamId);
        continue;
      }
    }

    // Research-framing jobs (scoping-question pre-step). Short, but kept on
    // their own budget so a burst of framings doesn't starve the chat slots
    // and a framing started before the user closed the tab finishes here
    // regardless of the Vercel wall clock.
    if (activeResearchFramings < MAX_RESEARCH_FRAMINGS) {
      let framingStreamId: string | null = null;
      try {
        framingStreamId = await popResearchFramingJob();
      } catch (err) {
        log("popResearchFramingJob threw — backing off 2s", {
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(2000);
        continue;
      }
      if (framingStreamId) {
        void runResearchFramingJob(framingStreamId);
        continue;
      }
    }

    // Scheduled research runs (a research artifact's cadence / Run-now handed
    // off from the cron sweep). Long-running like the chat research runs; own
    // budget so a daily deep scan finishes regardless of the Vercel wall clock.
    if (activeScheduleRuns < MAX_SCHEDULE_RUNS) {
      let scheduleAppId: string | null = null;
      try {
        scheduleAppId = await popScheduleJob();
      } catch (err) {
        log("popScheduleJob threw — backing off 2s", {
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(2000);
        continue;
      }
      if (scheduleAppId) {
        void runScheduleJob(scheduleAppId);
        continue;
      }
    }

    // Council debates (multi-member × multi-round + verifier + synthesizer).
    // Long-running; own budget so a debate finishes regardless of the Vercel
    // wall clock and doesn't starve the chat/query/exec slots.
    if (activeCouncils < MAX_COUNCILS) {
      let councilStreamId: string | null = null;
      try {
        councilStreamId = await popCouncilJob();
      } catch (err) {
        log("popCouncilJob threw — backing off 2s", {
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(2000);
        continue;
      }
      if (councilStreamId) {
        void runCouncil(councilStreamId);
        continue;
      }
    }

    if (active >= MAX_CONCURRENT) {
      await sleep(200);
      continue;
    }

    let streamId: string | null = null;
    try {
      streamId = await popJob();
    } catch (err) {
      log("popJob threw — backing off 2s", {
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(2000);
      continue;
    }

    if (streamId) {
      // Fire-and-forget — runOne handles its own errors. RPOP returns
      // immediately so the loop can drain bursts as fast as Upstash
      // serves them, fan-out limited only by MAX_CONCURRENT.
      void runOne(streamId);
      continue;
    }

    // Queues empty. If nothing is in flight and we've been idle past the
    // threshold, exit so Fly stops the machine. Otherwise back off a
    // beat before the next poll.
    if (
      active === 0 &&
      activeRenders === 0 &&
      activeQueries === 0 &&
      activeExecs === 0 &&
      activeResearchRuns === 0 &&
      activeResearchFramings === 0 &&
      activeScheduleRuns === 0 &&
      activeCouncils === 0 &&
      Date.now() - lastWorkAt > IDLE_EXIT_MS
    ) {
      log("idle past threshold, exiting cleanly");
      process.exit(0);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
