// Fly Machines API wake helper.
//
// Pairs with the scale-to-zero worker pattern in worker/index.ts: when
// /api/chat enqueues a job, it fire-and-forget POSTs to the Fly Machines
// REST API to bring the worker machine out of `stopped` state. The worker
// boots, BRPOPs the queue, drains it, and exits when idle — Fly stops the
// machine because we deploy with `restart_policy = "no"`.
//
// Machine resolution is DYNAMIC. We list the app's machines and start whichever
// live one exists, rather than trusting a pinned FLY_MACHINE_ID. Fly mints a
// NEW machine id whenever a deploy replaces the worker (destroy + recreate), so
// a pinned id silently goes stale on redeploy: wake POSTs /start to a destroyed
// machine, gets a 404, and the queue backs up with nothing draining it. That
// exact failure took chat down once. FLY_MACHINE_ID is now only a fallback for
// when the list call can't be made.
//
// When FLY_API_TOKEN / FLY_APP_NAME are unset (local dev, or when the user
// wants to fall back to the in-process waitUntil path), wakeWorker() becomes a
// no-op. The caller still enqueues the job; an already-running worker process
// will pick it up via BRPOP regardless.

const FLY_MACHINES_BASE = "https://api.machines.dev";
const FLY_REQUEST_TIMEOUT_MS = 8000;
// A wake is fire-and-forget on the request hot path, so keep its Fly calls
// snappy — a slow list/start shouldn't hold the chat response.
const WAKE_TIMEOUT_MS = 3000;

/** Token + app are all we need now that the machine is resolved dynamically. */
function flyBase(): { token: string; app: string } | null {
  const token = process.env.FLY_API_TOKEN;
  const app = process.env.FLY_APP_NAME;
  if (!token || !app) return null;
  return { token, app };
}

type FlyMachine = { id: string; state?: string; region?: string };

// A resolved machine id is cached module-side so the common case (many wakes
// against a stable worker) doesn't re-list on every enqueue. Short TTL so a
// redeploy's new id is picked up quickly; a stale hit is self-correcting via
// the 404 → re-resolve path in wakeWorker.
let machineCache: { id: string; at: number } | null = null;
const MACHINE_CACHE_MS = 60_000;

/** List every machine in the app (including destroyed ones — Fly excludes
 *  destroyed machines from this list, which is exactly what lets us tell a live
 *  machine from a torn-down one). */
async function listMachines(
  token: string,
  app: string,
  timeoutMs = FLY_REQUEST_TIMEOUT_MS
): Promise<FlyMachine[]> {
  const url = `${FLY_MACHINES_BASE}/v1/apps/${encodeURIComponent(app)}/machines`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Fly API ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as FlyMachine[]) : [];
  } catch {
    return [];
  }
}

/** Pick the worker machine from a list: a live (non-destroyed) machine,
 *  preferring one that's already started so a wake is a no-op. */
function pickWorkerMachine(machines: FlyMachine[]): FlyMachine | null {
  const live = machines.filter((m) => m.id && m.state !== "destroyed");
  return live.find((m) => m.state === "started") ?? live[0] ?? null;
}

/**
 * Resolve the current worker machine id. Lists the app's machines and picks a
 * live one; falls back to the pinned FLY_MACHINE_ID when the list call fails so
 * a transient Fly API hiccup can't strand a correctly-pinned machine. Returns
 * null only when there's genuinely nothing to start.
 */
async function resolveMachineId(opts?: {
  fresh?: boolean;
  timeoutMs?: number;
}): Promise<string | null> {
  const base = flyBase();
  if (!base) return null;
  const pinned = process.env.FLY_MACHINE_ID || null;
  if (
    !opts?.fresh &&
    machineCache &&
    Date.now() - machineCache.at < MACHINE_CACHE_MS
  ) {
    return machineCache.id;
  }
  try {
    const machines = await listMachines(base.token, base.app, opts?.timeoutMs);
    const pick = pickWorkerMachine(machines);
    if (pick) {
      machineCache = { id: pick.id, at: Date.now() };
      return pick.id;
    }
    // App exists but has no live machine — nothing to wake. Don't cache a
    // fallback that's likely destroyed; report the pinned id for a last try.
  } catch (err) {
    console.warn(
      "[fly-wake] machine list failed; falling back to FLY_MACHINE_ID",
      err
    );
  }
  return pinned;
}

/** Low-level start. Returns true on success (200) or already-started (412).
 *  On 404 the machine id is gone (a redeploy replaced it) — clear the cache so
 *  the caller re-resolves against a fresh list. */
async function startMachine(
  token: string,
  app: string,
  machineId: string,
  timeoutMs = WAKE_TIMEOUT_MS
): Promise<{ ok: boolean; gone: boolean }> {
  const url = `${FLY_MACHINES_BASE}/v1/apps/${encodeURIComponent(
    app
  )}/machines/${encodeURIComponent(machineId)}/start`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok || res.status === 412) return { ok: true, gone: false };
    const body = await res.text().catch(() => "");
    const gone = res.status === 404;
    if (gone) machineCache = null;
    console.warn(
      `[fly-wake] start returned ${res.status}: ${body.slice(0, 200)}`
    );
    return { ok: false, gone };
  } catch (err) {
    console.warn(`[fly-wake] start request failed`, err);
    return { ok: false, gone: false };
  }
}

/** Best-effort wake. Never throws — a wake failure is recoverable as long as a
 *  worker is running (it'll pick up via BRPOP) or the user retries. Resolves
 *  the live machine dynamically and, if the resolved id turns out to be stale
 *  (404), re-resolves once against a fresh list and retries. */
export async function wakeWorker(): Promise<boolean> {
  const base = flyBase();
  if (!base) return false;

  const machineId = await resolveMachineId({ timeoutMs: WAKE_TIMEOUT_MS });
  if (machineId) {
    const first = await startMachine(base.token, base.app, machineId);
    if (first.ok) return true;
    if (!first.gone) return false;
  }

  // Resolved id was stale (or absent) — re-list fresh and try the real one.
  const fresh = await resolveMachineId({
    fresh: true,
    timeoutMs: WAKE_TIMEOUT_MS,
  });
  if (fresh && fresh !== machineId) {
    return (await startMachine(base.token, base.app, fresh)).ok;
  }
  return false;
}

/** True when Fly is configured enough to run the durable worker. The machine id
 *  is resolved at call time, so only the token + app name are required here. */
export function isFlyWorkerConfigured(): boolean {
  return !!(process.env.FLY_API_TOKEN && process.env.FLY_APP_NAME);
}

// ---------------------------------------------------------------------------
// Admin worker control.
//
// The scale-to-zero worker can wedge: runChatWork has no AbortSignal, so a
// provider call that never returns pins a concurrency slot until the hour-long
// kill timer fires (see worker/index.ts). When that happens a chat looks
// "stuck" and there's no self-service way to recover it short of waiting.
//
// These helpers drive the Fly Machines API directly so the /admin/worker page
// can hard-reset the machine on demand: force-kill the wedged process, then
// bring a fresh one up. With `restart_policy = "never"` a stopped machine also
// comes back on its own on the next enqueue, so a bare stop is enough to clear
// a wedge — restart just makes a live worker available immediately.
//
// Like wakeWorker, these resolve the live machine dynamically so they act on
// the machine that actually exists, not a stale pin.

/** Fly machine lifecycle states we care about. Fly reports others
 *  (`created`, `replacing`, `destroying`, …); anything unrecognised is passed
 *  through verbatim so the admin UI shows the raw truth rather than guessing. */
type WorkerState = string;

export type WorkerStatus =
  | { configured: false }
  | {
      configured: true;
      app: string;
      machineId: string;
      /** Fly's reported machine state, e.g. "started" | "stopped" | "stopping". */
      state: WorkerState;
      region?: string;
    }
  | { configured: true; app: string; machineId: string; error: string };

/** Low-level Machines API call against a specific machine. Returns the parsed
 *  JSON on 2xx, else throws a message carrying the status + a slice of the body
 *  so callers can surface it. */
async function flyMachineReq(
  token: string,
  app: string,
  machineId: string,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; timeoutMs?: number }
): Promise<unknown> {
  const url = `${FLY_MACHINES_BASE}/v1/apps/${encodeURIComponent(
    app
  )}/machines/${encodeURIComponent(machineId)}${path}`;
  const res = await fetch(url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init.body != null ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? FLY_REQUEST_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(
      `Fly API ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`
    );
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Current machine state for the admin readout. Never throws — a failure is
 *  reported inline so the page can render it instead of erroring out. Resolves
 *  the live machine fresh so the admin sees the machine that actually exists
 *  (not a destroyed pin). */
export async function getWorkerStatus(): Promise<WorkerStatus> {
  const base = flyBase();
  if (!base) return { configured: false };
  try {
    const machineId = await resolveMachineId({ fresh: true });
    if (!machineId) {
      return {
        configured: true,
        app: base.app,
        machineId: "",
        error: "No worker machine found for this app.",
      };
    }
    const machine = (await flyMachineReq(base.token, base.app, machineId, "", {
      method: "GET",
    })) as { state?: string; region?: string };
    return {
      configured: true,
      app: base.app,
      machineId,
      state: machine.state ?? "unknown",
      region: machine.region,
    };
  } catch (err) {
    return {
      configured: true,
      app: base.app,
      machineId: process.env.FLY_MACHINE_ID || "",
      error: err instanceof Error ? err.message : "Status check failed.",
    };
  }
}

/** Force-stop the worker machine. SIGKILL rather than SIGTERM because a wedged
 *  provider call ignores the worker's graceful-drain path and would otherwise
 *  hang until Fly's kill_timeout. */
async function stopWorkerMachine(
  token: string,
  app: string,
  machineId: string
): Promise<void> {
  await flyMachineReq(token, app, machineId, "/stop", {
    method: "POST",
    body: { signal: "SIGKILL" },
  });
}

/** Block until the machine reaches `state` (or the timeout). Best-effort — a
 *  wait failure isn't fatal to the restart, we just proceed and let the caller
 *  read the final state. */
async function waitForState(
  token: string,
  app: string,
  machineId: string,
  state: string,
  timeoutSecs: number
): Promise<void> {
  await flyMachineReq(
    token,
    app,
    machineId,
    `/wait?state=${encodeURIComponent(state)}&timeout=${timeoutSecs}`,
    { method: "GET", timeoutMs: timeoutSecs * 1000 + 2000 }
  );
}

/**
 * Hard-reset the worker: force-kill the current (possibly wedged) process, wait
 * for it to actually stop, then boot a fresh one. Returns the machine's final
 * state so the admin page can confirm it came back up. Throws with a
 * user-facing message on failure.
 */
export async function restartWorker(): Promise<{ state: string }> {
  const base = flyBase();
  if (!base) throw new Error("Fly worker is not configured on the server.");
  const machineId = await resolveMachineId({ fresh: true });
  if (!machineId) throw new Error("No worker machine found for this app.");

  await stopWorkerMachine(base.token, base.app, machineId);
  // A SIGKILL stop is near-instant, but starting a machine that's still
  // "stopping" is rejected by Fly — wait for the stopped state first.
  await waitForState(base.token, base.app, machineId, "stopped", 10).catch(
    () => {
      /* proceed; start will error clearly if it's genuinely not stopped yet */
    }
  );
  await flyMachineReq(base.token, base.app, machineId, "/start", {
    method: "POST",
  });
  const status = await getWorkerStatus();
  return {
    state: status.configured && "state" in status ? status.state : "unknown",
  };
}

/** Force-kill the worker without restarting it. It comes back on its own on the
 *  next chat enqueue (wakeWorker), so this is the lightest way to clear a wedge
 *  when there's no in-flight work worth keeping warm for. */
export async function stopWorker(): Promise<{ state: string }> {
  const base = flyBase();
  if (!base) throw new Error("Fly worker is not configured on the server.");
  const machineId = await resolveMachineId({ fresh: true });
  if (!machineId) throw new Error("No worker machine found for this app.");

  await stopWorkerMachine(base.token, base.app, machineId);
  await waitForState(base.token, base.app, machineId, "stopped", 10).catch(
    () => {}
  );
  const status = await getWorkerStatus();
  return {
    state: status.configured && "state" in status ? status.state : "unknown",
  };
}
