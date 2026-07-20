// Server-side Redis state for scheduled artifact tasks.
//
// Hard caps that keep this from costing real money:
//   - One schedule per app (no name field, no array).
//   - Cron expressions are validated to fire at most once per hour
//     before they reach this layer (see app/lib/cron-eval.ts).
//   - acquireBudget() = SET NX EX 3600 → at most one run per app per hour
//     across ALL paths (catch-up read, cron sweep, manual "run now").
//     This matches the minimum cron granularity, so an hourly schedule
//     can fire on every cron sweep that catches it.
//   - acquireLock()   = SET NX EX 300  → blocks two paths from running the
//     same task in parallel; whoever wins fills Redis, the other path
//     just returns the prior cached value.

import { Redis } from "@upstash/redis";
import type { ScheduledTask } from "@/app/db";
import type { McpRuntimeConnector } from "@/app/lib/mcp/shared";

const PREFIX = "ollchat:schedule";
const META_TTL_S = 30 * 24 * 60 * 60; // 30d
// Results live 3 days so a user can come back and download last night's run
// without us paying for indefinite Redis storage.
export const RESULT_TTL_S = 3 * 24 * 60 * 60;
// History shares the result TTL — a run that's no longer in the result cache
// shouldn't linger in the history view either.
const HISTORY_TTL_S = RESULT_TTL_S;
// Cap how many past runs we keep so a chatty schedule can't blow Redis value
// size, and so the modal stays scannable.
export const HISTORY_MAX_ENTRIES = 10;
const LOCK_TTL_S = 5 * 60; // 5min
// Budget window sits just under the minimum cron granularity (1 hour). The
// Vercel sweep runs every 30 minutes; the in-between sweep is still blocked
// (55min > 30min) but the next hourly sweep finds the slot free instead of
// racing with a TTL that expires the exact moment the schedule next fires.
// Without this margin a `0 * * * *` schedule lands on every-other sweep and
// the user sees ~90min cadence instead of hourly. Manual + catch-up paths
// share the same window.
const BUDGET_TTL_S = 55 * 60;
const APPS_KEY = `${PREFIX}:apps`;
const PAUSED_KEY = `${PREFIX}:paused`;
// Set of owner emails who've paused their OWN scheduled tasks from the Control
// Center. Distinct from PAUSED_KEY: that flag is the deployment-wide (admin)
// kill-switch; this one is per-user, so a member's apps are skipped by the
// sweep while everyone else's keep running.
const PAUSED_USERS_KEY = `${PREFIX}:paused:users`;

let cached: Redis | null = null;
let cachedError: Error | null = null;

function readRedisCreds(): { url?: string; token?: string } {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  };
}

export function isScheduleStoreConfigured(): boolean {
  const { url, token } = readRedisCreds();
  return !!(url && token);
}

function getRedis(): Redis {
  if (cached) return cached;
  if (cachedError) throw cachedError;
  const { url, token } = readRedisCreds();
  if (!url || !token) {
    cachedError = new Error(
      "Schedules need Redis credentials. Provision an Upstash Redis (or Vercel KV) " +
        "database and expose either UPSTASH_REDIS_REST_URL+UPSTASH_REDIS_REST_TOKEN or " +
        "KV_REST_API_URL+KV_REST_API_TOKEN to the project."
    );
    throw cachedError;
  }
  cached = new Redis({ url, token });
  return cached;
}

export type ScheduleOrigin = "manifest" | "sdk";

export type StoredScheduleMeta = {
  task: ScheduledTask;
  origin: ScheduleOrigin;
  registeredAt: number;
  /** Set when the user explicitly edits cadence in the host UI. Subsequent
   *  manifest / SDK auto-registers preserve the user's cron instead of
   *  clobbering it with the artifact's hard-coded value. */
  userCronOverride?: boolean;
  /** Last cron handed in by a non-user registration (manifest or SDK).
   *  Cached so "reset to default" can restore the artifact's cron without
   *  waiting for the next iframe load. */
  defaultCron?: string;
  /** Wall-clock of the last terminal run (complete or error). Mirrored from
   *  the result blob so the cron sweep can decide due-ness without a second
   *  Redis read per app. Absent for schedules registered before this field
   *  existed; the sweep falls back to getResult() once and stamps it here. */
  lastRunAt?: number;
  /** Non-destructive on/off switch for the recurring task. Opt-out: absent or
   *  `true` means the cron sweep and catch-up-on-visit may auto-fire it;
   *  `false` pauses both while keeping the schedule, its cached result, and
   *  its history intact. Manual "Run now" is unaffected — pausing stops the
   *  unattended runs, not a deliberate click. Toggled from the Control Center
   *  per app, or flipped en masse when an app is disabled there. */
  enabled?: boolean;
  /** Email of the account that owns this app. Stored so a server-side run
   *  (cron sweep / worker) can look the app entity up and resolve the user's
   *  currently-configured model at run time — the schedule always uses the
   *  model the user picked, never one baked into artifact code/manifest. */
  ownerEmail?: string;
};

export type ScheduleStatus = "idle" | "running" | "complete" | "error";

export type StoredScheduleResult = {
  result: unknown;
  runAt: number;
  status: "running" | "complete" | "error";
  error?: string;
};

/**
 * One terminal run, captured for the "Recent runs" view in the Edit-params
 * modal. Inputs and outputs travel together so the user can see what the
 * model was actually asked, what model answered, and how long it took —
 * useful when a long-running model (e.g. a 31B Gemma) hits the 280s
 * executor deadline and the snapshot shows nothing but an error.
 */
export type ScheduleHistoryEntry = {
  runAt: number;
  /** Wall-clock duration of the run in ms. */
  durationMs: number;
  status: "complete" | "error";
  /** Snapshot of the task that was executed. Captured per-entry because
   *  the task definition can be edited between runs (cadence, prompt). */
  input:
    | { type: "query"; prompt: string; model?: string; webSearch?: boolean }
    | { type: "fetch"; url: string; method?: string };
  /** Model the executor reported back. May differ from `input.model` when
   *  the task omitted one and DEFAULT_MODEL was used. */
  modelUsed?: string;
  result?: unknown;
  error?: string;
};

export type ScheduleSnapshot = {
  task: ScheduledTask;
  origin: ScheduleOrigin;
  registeredAt: number;
  result: unknown;
  runAt: number | null;
  status: ScheduleStatus;
  error?: string;
  userCronOverride?: boolean;
  defaultCron?: string;
  /** Whether the recurring task may auto-fire. Mirrors StoredScheduleMeta.enabled,
   *  normalized to a concrete boolean (absent meta flag → true). */
  enabled: boolean;
  /** Newest-first list of recent terminal runs. Capped at HISTORY_MAX_ENTRIES. */
  history?: ScheduleHistoryEntry[];
};

function metaKey(appId: string): string {
  return `${PREFIX}:meta:${appId}`;
}
function resultKey(appId: string): string {
  return `${PREFIX}:result:${appId}`;
}
function historyKey(appId: string): string {
  return `${PREFIX}:history:${appId}`;
}
function lockKey(appId: string): string {
  return `${PREFIX}:lock:${appId}`;
}
function budgetKey(appId: string): string {
  return `${PREFIX}:budget:${appId}`;
}
function connectorsKey(appId: string): string {
  return `${PREFIX}:connectors:${appId}`;
}

function parseJsonOrObject<T>(raw: T | string | null): T | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return raw;
}

export async function registerSchedule(
  appId: string,
  task: ScheduledTask,
  origin: ScheduleOrigin,
  options?: { userOverride?: boolean; includeInSweep?: boolean; ownerEmail?: string }
): Promise<void> {
  const redis = getRedis();
  const existing = await getMeta(appId);
  const isUserEdit = options?.userOverride === true;
  // The host UI sends userOverride=true when the user picks a cadence — that
  // wins, full stop. Otherwise (manifest auto-register on mount, iframe
  // schedule.define on load) we keep any prior user-chosen cron so the
  // artifact's hard-coded value can't silently undo the user's edit.
  const preserveCron = !isUserEdit && existing?.userCronOverride === true;
  const finalTask = preserveCron ? { ...task, cron: existing.task.cron } : { ...task };
  // Model is preserved the same way cron is: a register that doesn't carry a
  // model (the API route strips it unless the caller proved it resolved the
  // app's configured model — see modelResolved in register/route.ts) can
  // NEVER erase or downgrade a model a knowing caller stored earlier. This is
  // the server-boundary fix for the recurring "scheduled run used the wrong
  // model" bug: last-writer-wins on task.model let any mount that didn't know
  // app.model clobber the registry, and the run-time account-store lookup
  // can't always save it for local-first apps.
  if (
    finalTask.type === "query" &&
    finalTask.model === undefined &&
    existing?.task.type === "query" &&
    existing.task.model !== undefined
  ) {
    finalTask.model = existing.task.model;
  }
  // Track the artifact's "natural" cron so a later reset can restore it
  // without waiting for the next iframe load. User edits leave it alone.
  const defaultCron = isUserEdit ? existing?.defaultCron : task.cron;
  const meta: StoredScheduleMeta = {
    task: finalTask,
    origin,
    registeredAt: Date.now(),
    userCronOverride: isUserEdit || existing?.userCronOverride === true,
    defaultCron,
    // Preserve a prior pause across re-registers — editing the cadence or a
    // manifest/SDK auto-register on mount must not silently re-arm a schedule
    // the user paused in the Control Center.
    enabled: existing?.enabled,
    // Keep the owner on file so server-side runs can resolve the user's model.
    // Preserve a previously-stored value if this register didn't supply one.
    ownerEmail: options?.ownerEmail ?? existing?.ownerEmail,
  };
  await redis.set(metaKey(appId), JSON.stringify(meta), { ex: META_TTL_S });
  // APPS_KEY is the cron sweep's worklist — only apps in it get the recurring
  // background auto-fire. We always store the meta (so manual "Run now" and
  // result persistence work for ANY app — run it, close the phone, read the
  // result on return), but only enroll account-shared apps in the recurring
  // sweep. That keeps the unattended cron tied to a durable server-side record
  // (no orphaned schedules running forever for a local-only app that's since
  // been deleted) while still letting every app run on demand.
  if (options?.includeInSweep === false) {
    await redis.srem(APPS_KEY, appId);
  } else {
    await redis.sadd(APPS_KEY, appId);
  }
}

/**
 * Drop the user's cadence override. Restores the artifact's last-known
 * default cron when one is cached; otherwise leaves the cron in place and
 * just clears the flag so the next manifest / SDK auto-register can win.
 */
export async function clearUserCronOverride(appId: string): Promise<void> {
  const redis = getRedis();
  const existing = await getMeta(appId);
  if (!existing) return;
  const restoredCron = existing.defaultCron ?? existing.task.cron;
  const meta: StoredScheduleMeta = {
    task: { ...existing.task, cron: restoredCron },
    origin: existing.origin,
    registeredAt: existing.registeredAt,
    userCronOverride: false,
    defaultCron: existing.defaultCron,
    enabled: existing.enabled,
  };
  await redis.set(metaKey(appId), JSON.stringify(meta), { ex: META_TTL_S });
}

/**
 * Pause or resume a schedule's unattended auto-fire without tearing it down.
 * Read-modify-write so the rest of the meta (cron, override flags, lastRunAt)
 * round-trips unchanged. No-op when the app has no schedule registered.
 * Returns whether a meta row was found and updated.
 */
export async function setScheduleEnabled(
  appId: string,
  enabled: boolean
): Promise<boolean> {
  const redis = getRedis();
  const existing = await getMeta(appId);
  if (!existing) return false;
  if ((existing.enabled !== false) === enabled) return true;
  const updated: StoredScheduleMeta = { ...existing, enabled };
  await redis.set(metaKey(appId), JSON.stringify(updated), { ex: META_TTL_S });
  return true;
}

export async function unregisterApp(appId: string): Promise<void> {
  const redis = getRedis();
  await Promise.all([
    redis.del(metaKey(appId)),
    redis.del(resultKey(appId)),
    redis.del(historyKey(appId)),
    redis.del(lockKey(appId)),
    redis.del(budgetKey(appId)),
    redis.del(connectorsKey(appId)),
  ]);
  await redis.srem(APPS_KEY, appId);
}

/**
 * The user's MCP connectors for an app's scheduled (unattended) source run.
 * Stored in a SEPARATE server-side key — never in StoredScheduleMeta (which is
 * spread into the client-facing ScheduleSnapshot) and never in the manifest —
 * so the API keys they carry don't leak back to the browser or into the app's
 * saved files. Shares the meta TTL; cleared when the app unregisters, and
 * overwritten (with []) whenever a frame registers a schedule whose source is
 * not mcp-flagged, so toggling MCP off drops the stored keys promptly.
 */
export async function setScheduleConnectors(
  appId: string,
  connectors: McpRuntimeConnector[]
): Promise<void> {
  const redis = getRedis();
  if (!connectors.length) {
    await redis.del(connectorsKey(appId));
    return;
  }
  await redis.set(connectorsKey(appId), JSON.stringify(connectors), { ex: META_TTL_S });
}

export async function getScheduleConnectors(
  appId: string
): Promise<McpRuntimeConnector[] | null> {
  const redis = getRedis();
  const raw = await redis.get<McpRuntimeConnector[] | string>(connectorsKey(appId));
  const parsed = parseJsonOrObject<McpRuntimeConnector[]>(raw);
  return Array.isArray(parsed) && parsed.length ? parsed : null;
}

export async function getMeta(appId: string): Promise<StoredScheduleMeta | null> {
  const redis = getRedis();
  const raw = await redis.get<StoredScheduleMeta | string>(metaKey(appId));
  return parseJsonOrObject<StoredScheduleMeta>(raw);
}

export async function getResult(appId: string): Promise<StoredScheduleResult | null> {
  const redis = getRedis();
  const raw = await redis.get<StoredScheduleResult | string>(resultKey(appId));
  return parseJsonOrObject<StoredScheduleResult>(raw);
}

export async function setResult(
  appId: string,
  payload: StoredScheduleResult
): Promise<void> {
  const redis = getRedis();
  await redis.set(resultKey(appId), JSON.stringify(payload), { ex: RESULT_TTL_S });
}

/**
 * Stamp the wall-clock of the most recent terminal run onto the meta blob
 * so the cron sweep can answer "is this due?" from a single GET per app
 * instead of GET-meta + GET-result. Read-modify-write because meta carries
 * other fields (cron override flags, defaultCron) that must round-trip
 * unchanged. Skipped if meta has been deleted in the meantime.
 */
export async function recordLastRun(appId: string, runAt: number): Promise<void> {
  const redis = getRedis();
  const existing = await getMeta(appId);
  if (!existing) return;
  if (existing.lastRunAt === runAt) return;
  const updated: StoredScheduleMeta = { ...existing, lastRunAt: runAt };
  await redis.set(metaKey(appId), JSON.stringify(updated), { ex: META_TTL_S });
}

export async function getHistory(appId: string): Promise<ScheduleHistoryEntry[]> {
  const redis = getRedis();
  // LRANGE returns newest-first because we LPUSH on append.
  const raw = await redis.lrange<ScheduleHistoryEntry | string>(
    historyKey(appId),
    0,
    HISTORY_MAX_ENTRIES - 1
  );
  if (!raw) return [];
  const out: ScheduleHistoryEntry[] = [];
  for (const item of raw) {
    const parsed = parseJsonOrObject<ScheduleHistoryEntry>(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Append a terminal-state run to the history list. LPUSH + LTRIM keeps the
 * newest HISTORY_MAX_ENTRIES entries; the surrounding TTL on the key drops
 * the whole list once it goes idle for the result-TTL window.
 */
export async function appendHistory(
  appId: string,
  entry: ScheduleHistoryEntry
): Promise<void> {
  const redis = getRedis();
  const key = historyKey(appId);
  await redis.lpush(key, JSON.stringify(entry));
  await redis.ltrim(key, 0, HISTORY_MAX_ENTRIES - 1);
  await redis.expire(key, HISTORY_TTL_S);
}

/**
 * Get a per-app exclusive lock for at most 5 minutes. Returns true on
 * acquisition. The caller must release via `releaseLock` on completion;
 * if it crashes, the TTL clears it within 5 minutes.
 */
export async function acquireLock(appId: string): Promise<boolean> {
  const redis = getRedis();
  // Upstash returns "OK" on success and null when the NX guard fired.
  const ok = await redis.set(lockKey(appId), "1", { nx: true, ex: LOCK_TTL_S });
  return ok === "OK";
}

export async function releaseLock(appId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(lockKey(appId));
}

/**
 * Consume one slot from the per-app hourly budget. Returns
 * `{ ok: true }` on success, `{ ok: false, retryAfterMs }` when exhausted.
 * Both the catch-up path and the cron sweep call this before kicking off
 * a run, so a misbehaving cron + tab-spamming user can never combine to
 * exceed 1 run per hour per app.
 */
export async function acquireBudget(
  appId: string
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  const redis = getRedis();
  const taken = await redis.set(budgetKey(appId), "1", {
    nx: true,
    ex: BUDGET_TTL_S,
  });
  if (taken === "OK") return { ok: true };
  const ttl = await redis.ttl(budgetKey(appId));
  return { ok: false, retryAfterMs: Math.max(0, ttl) * 1000 };
}

/**
 * Refund the budget slot. Called when a run fails before producing a
 * useful result, so the user isn't locked out for an hour over our crash.
 */
export async function releaseBudget(appId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(budgetKey(appId));
}

export type PauseState = {
  paused: boolean;
  /** Wall-clock the pause flag was last set. Absent when not paused. */
  since?: number;
};

export async function getPauseState(): Promise<PauseState> {
  const redis = getRedis();
  const raw = await redis.get<PauseState | string>(PAUSED_KEY);
  const parsed = parseJsonOrObject<PauseState>(raw);
  if (!parsed || parsed.paused !== true) return { paused: false };
  return { paused: true, since: parsed.since };
}

export async function setPaused(paused: boolean): Promise<PauseState> {
  const redis = getRedis();
  if (!paused) {
    await redis.del(PAUSED_KEY);
    return { paused: false };
  }
  const state: PauseState = { paused: true, since: Date.now() };
  await redis.set(PAUSED_KEY, JSON.stringify(state));
  return state;
}

/**
 * Per-user "pause my scheduled tasks" flag, keyed by the owner's email.
 * Powers the Control Center kill-switch so a user only stops their own crons,
 * not the whole deployment (that's the admin PAUSED_KEY above). Backed by a
 * Redis SET of paused emails: membership is the state, so one SMEMBERS in the
 * sweep tells us every paused user in a single read.
 */
export async function getUserPauseState(email: string): Promise<PauseState> {
  const redis = getRedis();
  const member = await redis.sismember(PAUSED_USERS_KEY, email.toLowerCase());
  return member ? { paused: true } : { paused: false };
}

export async function setUserPaused(
  email: string,
  paused: boolean
): Promise<PauseState> {
  const redis = getRedis();
  const normalized = email.toLowerCase();
  if (paused) {
    await redis.sadd(PAUSED_USERS_KEY, normalized);
    return { paused: true };
  }
  await redis.srem(PAUSED_USERS_KEY, normalized);
  return { paused: false };
}

/**
 * Every owner email that's currently paused. Returned as a lowercased Set so
 * the sweep can test each app's ownerEmail in O(1) after one Redis read.
 */
export async function listPausedUsers(): Promise<Set<string>> {
  const redis = getRedis();
  const members = await redis.smembers(PAUSED_USERS_KEY);
  return new Set((members ?? []).map((m) => String(m).toLowerCase()));
}

export async function listAllAppsWithSchedules(): Promise<string[]> {
  const redis = getRedis();
  const ids = await redis.smembers(APPS_KEY);
  return ids ?? [];
}

export async function getSnapshot(appId: string): Promise<ScheduleSnapshot | null> {
  const meta = await getMeta(appId);
  if (!meta) return null;
  const [result, history] = await Promise.all([
    getResult(appId),
    getHistory(appId),
  ]);
  return {
    task: meta.task,
    origin: meta.origin,
    registeredAt: meta.registeredAt,
    result: result?.result ?? null,
    runAt: result?.runAt ?? null,
    status: result?.status ?? "idle",
    error: result?.error,
    userCronOverride: meta.userCronOverride === true,
    defaultCron: meta.defaultCron,
    enabled: meta.enabled !== false,
    history,
  };
}
