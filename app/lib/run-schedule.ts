// Single place that actually runs a scheduled task. Used by the
// catch-up-on-visit path (GET /api/schedules/{appId}), the manual "Run now"
// path (POST /api/schedules/{appId}/run), and the cron sweep
// (GET /api/cron/run-schedules), so schedules behave identically no matter who
// triggered them.
//
// Rate-limit + lock semantics live in app/lib/schedule-store.ts. This module
// assumes the caller has already acquired the lock; it does NOT release the
// lock on its own — the caller does, in a finally block.
//
// Task types ("query" / "fetch"): both run INLINE here (a single Ollama call or
// a proxy fetch), with the result written to Redis before returning.

import type { ScheduledTask } from "@/app/db";
import { executeQuery, executeResearch, type QueryOutcome } from "@/app/lib/executors";
import { runStructuredResearch } from "@/app/lib/structured-research";
import { DEFAULT_RESEARCH_MODEL, DEFAULT_SCHEDULED_MODEL } from "@/app/models";
import type { ResearchRecord } from "@/app/db";
import { POST as proxyPost } from "@/app/api/proxy/route";
import {
  appendHistory,
  getMeta,
  getResult,
  getScheduleConnectors,
  recordLastRun,
  releaseBudget,
  setResult,
  type ScheduleHistoryEntry,
} from "@/app/lib/schedule-store";
import { get as getAccountEntity } from "@/app/lib/account-store";
import { enqueueScheduleJob, saveScheduleJob } from "@/app/lib/stream-store";
import { isFlyWorkerConfigured, wakeWorker } from "@/app/lib/fly-wake";
import { captureError } from "@/app/lib/error-log";

function describeInput(task: ScheduledTask): ScheduleHistoryEntry["input"] {
  if (task.type === "query") {
    return {
      type: "query",
      prompt: task.prompt,
      model: task.model,
      webSearch: !!task.tools && task.tools.includes("web_search"),
    };
  }
  return { type: "fetch", url: task.url, method: task.init?.method };
}

type RunResult = { status: "complete" | "error"; result: unknown; error?: string };

/**
 * Build the guarded Redis bookkeeping for one run. Each write is wrapped so a
 * hung Upstash on one call can't sink the others (or leave the snapshot stuck
 * on status="running" after a SIGTERM at maxDuration). Shared by the inline
 * runner and the Fly worker's research completion.
 */
function makeBookkeeping(appId: string, task: ScheduledTask, runAt: number) {
  const input = describeInput(task);

  const recordHistory = async (
    entry: Omit<ScheduleHistoryEntry, "input" | "runAt" | "durationMs">
  ): Promise<void> => {
    try {
      await appendHistory(appId, {
        ...entry,
        input,
        runAt,
        durationMs: Math.max(0, Date.now() - runAt),
      });
    } catch (e) {
      console.error(`[schedule ${appId}] appendHistory failed`, e);
    }
  };

  const complete = async (result: unknown, modelUsed?: string): Promise<RunResult> => {
    await setResult(appId, { result, runAt, status: "complete" });
    try {
      await recordLastRun(appId, runAt);
    } catch (e) {
      console.error(`[schedule ${appId}] recordLastRun failed`, e);
    }
    await recordHistory({ status: "complete", result, modelUsed });
    return { status: "complete", result };
  };

  const fail = async (error: string, modelUsed?: string): Promise<RunResult> => {
    try {
      await setResult(appId, { result: null, runAt, status: "error", error });
    } catch (e) {
      console.error(`[schedule ${appId}] setResult(error) failed`, e);
    }
    try {
      await recordLastRun(appId, runAt);
    } catch (e) {
      console.error(`[schedule ${appId}] recordLastRun failed`, e);
    }
    try {
      await releaseBudget(appId);
    } catch (e) {
      console.error(`[schedule ${appId}] releaseBudget failed`, e);
    }
    await recordHistory({ status: "error", error, modelUsed });
    await captureError({
      source: "schedule",
      message: error,
      appId,
      context: {
        taskType: task.type,
        cron: task.cron,
        model: modelUsed ?? (task.type !== "fetch" ? task.model : undefined),
        prompt: task.type !== "fetch" ? task.prompt.slice(0, 300) : undefined,
        url: task.type === "fetch" ? task.url : undefined,
        durationMs: Math.max(0, Date.now() - runAt),
      },
    });
    return { status: "error", result: null, error };
  };

  return { complete, fail };
}

/** Mark the snapshot running while preserving any prior result, so a mid-run
 *  refresh doesn't blank the data the user is staring at. */
async function markRunning(appId: string, runAt: number): Promise<void> {
  const prior = await getResult(appId);
  await setResult(appId, {
    result: prior?.result ?? null,
    runAt: prior?.runAt ?? runAt,
    status: "running",
  });
}

/** Store a query-shaped outcome (executeQuery) via the shared bookkeeping. */
async function storeOutcome(
  appId: string,
  task: ScheduledTask,
  runAt: number,
  outcome: QueryOutcome
): Promise<RunResult> {
  const { complete, fail } = makeBookkeeping(appId, task, runAt);
  const ok = outcome.status >= 200 && outcome.status < 300;
  const modelUsed = (outcome.payload as { model?: string }).model;
  if (ok) {
    const payload = outcome.payload as { json?: unknown; text: string };
    return complete(payload.json ?? payload.text, modelUsed);
  }
  const errPayload = outcome.payload as { error?: string };
  return fail(errPayload.error ?? "Run failed", modelUsed);
}

/**
 * The model a scheduled run should use, resolved server-side and authoritatively
 * at run time: whatever the user currently has configured for the app (the app's
 * Model setting, `app.model`) always wins over any model baked into the task by
 * artifact code or a manifest schedule. Re-read every run so a changed Model
 * setting takes effect on the next scan without re-registering the schedule.
 *
 * Falls back to the task's own model only when the app's model can't be resolved
 * (app not account-synced, owner unknown, or Redis hiccup) — never throws.
 */
async function resolveScheduledModel(
  appId: string,
  taskModel: string | undefined
): Promise<string | undefined> {
  try {
    const meta = await getMeta(appId);
    const ownerEmail = meta?.ownerEmail;
    if (!ownerEmail) return taskModel;
    const app = await getAccountEntity(ownerEmail, "app", appId);
    const configured = (app as { model?: unknown } | null)?.model;
    if (typeof configured === "string" && configured.length > 0) return configured;
    return taskModel;
  } catch {
    return taskModel;
  }
}

/**
 * Execute the task, write the result to Redis, return the stored payload.
 * Always writes — both success and failure are observable to the artifact
 * (status "complete" with `result`, or "error" with `error`). On error the
 * budget slot is refunded so the user isn't locked out over our crash.
 */
export async function runScheduledTask(
  appId: string,
  task: ScheduledTask,
  opts?: { onWorker?: boolean }
): Promise<RunResult> {
  const runAt = Date.now();
  await markRunning(appId, runAt);
  const { fail } = makeBookkeeping(appId, task, runAt);

  // A stored prompt still carrying {params.*} placeholders was registered
  // without interpolation (a pre-fix client). Running it verbatim makes the
  // model search for the literal "{params.city}" and return junk that LOOKS
  // like a successful (empty) scan. Fail fast with the fix instead - the
  // next app open re-registers the schedule with interpolated values.
  if (task.type === "query" && /\{params\.[a-zA-Z][a-zA-Z0-9_]*\}/.test(task.prompt)) {
    return fail(
      "This schedule's prompt still contains unfilled {params.…} placeholders " +
        "from an older registration. Open the app once to re-register it with " +
        "the current parameter values, then run again."
    );
  }

  // Research schedules run the deep multi-agent engine, which takes minutes —
  // far past the maxDuration of the cron sweep / Run-now function. When a Fly
  // worker is available, hand the run off to it (no per-request wall clock) and
  // return: the snapshot is already status="running", so the artifact keeps
  // polling and the worker writes the real result when it finishes. On the
  // worker itself (onWorker) we fall through and run inline. With no Fly worker
  // (local dev) we also run inline, bounded by maxDuration.
  if (
    task.type === "query" &&
    task.research &&
    !opts?.onWorker &&
    isFlyWorkerConfigured()
  ) {
    try {
      await saveScheduleJob(appId, task);
      await enqueueScheduleJob(appId);
      // AWAIT the wake — do not fire-and-forget. Every caller that reaches this
      // branch (Run-now POST, catch-up GET) runs us inside a `waitUntil(...)`
      // that resolves the instant this function returns; a bare
      // `void wakeWorker()` is then torn down by the Vercel runtime before its
      // 3s Fly-start request lands, so a *stopped* worker machine never boots
      // and the enqueued job sits in `ollchat:schedule-jobs` until some
      // unrelated chat happens to wake the worker (or forever, if none does).
      // Awaiting keeps the function alive until the start request completes.
      // wakeWorker() never throws and is a no-op when Fly isn't configured, so
      // this can't convert a successful enqueue into a failure.
      await wakeWorker();
    } catch (err) {
      return await fail(
        `Failed to enqueue research run: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // Dispatched, not yet complete — the snapshot stays "running" until the
    // worker writes the result. Callers only use this to count a dispatch.
    return { status: "complete", result: null };
  }

  try {
    if (task.type === "query") {
      // Inline path: the shallow query, or deep research on the worker / in
      // local dev (no Fly). Deep research inline is bounded by maxDuration —
      // the dispatch branch above is the durable home for it in production.
      let outcome: QueryOutcome;
      // The user's currently-configured app model always wins over any model
      // the task carries (baked in by artifact code or a manifest schedule).
      const model = await resolveScheduledModel(appId, task.model);
      if (task.research && task.columns && task.columns.length > 0) {
        // Unified with the manual Refresh path: run the structured engine
        // against the app's OWN columns so every record is keyed to those
        // columns (the table then populates), and use the app's model. This
        // replaces the old executeResearch(schema) call that let the model
        // invent its own keys (fit_reason, contact_person, …) and ran on a
        // stale schedule model.
        const prior = await getResult(appId).catch(() => null);
        const priorJson =
          prior && prior.result && typeof prior.result === "object"
            ? (prior.result as { records?: Array<Record<string, unknown>> })
            : null;
        const priorRecords: ResearchRecord[] | undefined = Array.isArray(priorJson?.records)
          ? priorJson!.records.map((r) => {
              const { id, ...fields } = r;
              return { id: String(id ?? ""), fields };
            })
          : undefined;
        const r = await runStructuredResearch({
          query: task.prompt,
          columns: task.columns,
          idKeys: task.idKeys,
          priorRecords,
          model,
        });
        outcome = {
          status: 200,
          payload: {
            text: "",
            json: {
              // Flat {id, ...fields} so the app merges directly into app.state.
              records: r.records.map((rec) => ({ id: rec.id, ...rec.fields })),
              columns: r.columns,
              idKeys: r.idKeys,
              schema: r.schema,
            },
            model: model || DEFAULT_RESEARCH_MODEL,
          },
        };
      } else if (task.research) {
        outcome = await executeResearch({
          prompt: task.prompt,
          schema: task.schema,
          model,
        });
      } else {
        // An mcp-flagged source persisted its connectors at register time;
        // hand them to the run so an unattended cron fire can call the same
        // connected tools an interactive refresh would. Absent ⇒ no MCP tools.
        const connectors = (await getScheduleConnectors(appId).catch(() => null)) ?? undefined;
        outcome = await executeQuery({
          prompt: task.prompt,
          schema: task.schema,
          webSearch: !!task.tools && task.tools.includes("web_search"),
          // Unattended runs fall back to the scheduled-task default rather than
          // executeQuery's interactive DEFAULT_MODEL. This is the tier that
          // catches schedules registered before the preference existed, or by a
          // client that never saw it — they'd otherwise silently keep using the
          // heavier chat default. Research branches above keep their own
          // DEFAULT_RESEARCH_MODEL fallback.
          model: model || DEFAULT_SCHEDULED_MODEL,
          connectors,
        });
      }
      return await storeOutcome(appId, task, runAt, outcome);
    }

    // type === "fetch"
    const fakeReq = new Request("http://internal/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: task.url,
        method: task.init?.method,
        headers: task.init?.headers,
        body: task.init?.body,
      }),
    });
    const res = await proxyPost(fakeReq);
    const json = (await res.json()) as Record<string, unknown> & { error?: string };
    if (!res.ok) {
      return await fail(typeof json.error === "string" ? json.error : `fetch failed (${res.status})`);
    }
    const { complete } = makeBookkeeping(appId, task, runAt);
    return await complete(json);
  } catch (err) {
    return await fail(err instanceof Error ? err.message : String(err));
  }
}
