// Platform health checks — the shared probes behind the two "why is my chat
// stuck?" surfaces:
//
//   - Preferences → Debug "System status" (any signed-in user): is the model
//     provider reachable, and is the sync/streaming backend up? Answers the
//     first fork of the question — "is llama down, or is it something else?"
//   - /admin/diagnostics (admins only): the deeper view — provider latency,
//     the Fly worker's machine state, and the depth of every job queue plus
//     how many chat streams are currently in flight. Answers the second fork —
//     "the providers are fine, so what's wedged?"
//
// Every probe is best-effort and time-boxed: a hung provider or Redis must not
// make the health endpoint itself hang. Failures are reported inline as
// `{ ok: false, error }` rather than thrown, so a partial outage still renders.

import { Redis } from "@upstash/redis";
import { ollamaClient } from "@/app/lib/ollama/client";
import { runpodClient } from "@/app/lib/runpod/client";
import { getWorkerStatus, type WorkerStatus } from "@/app/lib/fly-wake";

export type ProviderHealth = {
  configured: boolean;
  ok: boolean;
  /** Models the provider advertised — a non-zero count is a strong "it's up". */
  count: number;
  /** Round-trip time of the list() probe, in ms. */
  latencyMs?: number;
  error?: string;
};

export type ServiceHealth = {
  configured: boolean;
  ok: boolean;
  latencyMs?: number;
  error?: string;
};

const PROVIDER_PROBE_TIMEOUT_MS = 6000;
const REDIS_PROBE_TIMEOUT_MS = 4000;

/** Race a promise against a timeout so one hung dependency can't hang the
 *  whole health check. Rejects with a clear message on timeout. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/** Ping Ollama Cloud by listing models. A successful list with a model count
 *  is the cheapest proof the provider (and the account's key) is live. */
export async function pingOllama(): Promise<ProviderHealth> {
  if (!process.env.OLLAMA_API_KEY) {
    return { configured: false, ok: false, count: 0, error: "OLLAMA_API_KEY not set." };
  }
  const started = Date.now();
  try {
    const client = ollamaClient();
    const list = await withTimeout(client.list(), PROVIDER_PROBE_TIMEOUT_MS, "Ollama list");
    return {
      configured: true,
      ok: true,
      count: list.models?.length ?? 0,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      count: 0,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : "Couldn't reach Ollama Cloud.",
    };
  }
}

/** Ping RunPod, when configured. Returns null when the deployment has no
 *  RunPod endpoint so the UI can omit the row entirely. */
export async function pingRunpod(runpodEndpointId?: string): Promise<ProviderHealth | null> {
  const endpointId = runpodEndpointId?.trim() || process.env.RUNPOD_ENDPOINT_ID;
  if (!process.env.RUNPOD_API_KEY || !endpointId) return null;
  const started = Date.now();
  try {
    const rp = runpodClient({ endpointId });
    const listed = await withTimeout(rp.list(), PROVIDER_PROBE_TIMEOUT_MS, "RunPod list");
    return {
      configured: true,
      ok: true,
      count: listed.models?.length ?? 0,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      count: 0,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : "Couldn't reach RunPod.",
    };
  }
}

function redisCreds(): { url?: string; token?: string } {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  };
}

let cachedRedis: Redis | null = null;
function healthRedis(): Redis | null {
  if (cachedRedis) return cachedRedis;
  const { url, token } = redisCreds();
  if (!url || !token) return null;
  cachedRedis = new Redis({ url, token });
  return cachedRedis;
}

/** The sync/streaming backend is Upstash Redis: chats stream through it and
 *  the account-sync layer persists to it. A PING confirms it's reachable. */
export async function pingSync(): Promise<ServiceHealth> {
  const redis = healthRedis();
  if (!redis) {
    return { configured: false, ok: false, error: "Redis (sync backend) not configured." };
  }
  const started = Date.now();
  try {
    await withTimeout(redis.ping(), REDIS_PROBE_TIMEOUT_MS, "Redis ping");
    return { configured: true, ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : "Couldn't reach the sync backend.",
    };
  }
}

// The durable job queues the Fly worker drains (see stream-store.ts). A chat
// that never starts is usually a payload sitting in `ollchat:jobs` that nothing
// popped — a non-zero depth here with a stopped/wedged worker is the smoking
// gun. Kept in sync with the *_JOBS_KEY constants in stream-store.ts.
const JOB_QUEUES: { key: string; label: string }[] = [
  { key: "ollchat:jobs", label: "Chat" },
  { key: "ollchat:council-jobs", label: "Council" },
  { key: "ollchat:query-jobs", label: "Query" },
  { key: "ollchat:schedule-jobs", label: "Schedules" },
  { key: "ollchat:exec-jobs", label: "Code exec" },
  { key: "ollchat:research-run-jobs", label: "Research" },
  { key: "ollchat:research-framing-jobs", label: "Research framing" },
  { key: "ollchat:render-jobs", label: "Render" },
];

export type QueueDepth = { key: string; label: string; depth: number };

/** Depth (LLEN) of each job queue. A backed-up queue points at a worker that
 *  isn't draining; an empty queue with a stuck chat points at the provider or
 *  stale stream state instead. */
export async function queueDepths(): Promise<QueueDepth[]> {
  const redis = healthRedis();
  if (!redis) return [];
  const results = await Promise.all(
    JOB_QUEUES.map(async ({ key, label }) => {
      try {
        const depth = await withTimeout(redis.llen(key), REDIS_PROBE_TIMEOUT_MS, `LLEN ${key}`);
        return { key, label, depth: depth ?? 0 };
      } catch {
        return { key, label, depth: 0 };
      }
    })
  );
  return results;
}

/** Rough count of chat streams currently in flight — one `:meta` key exists per
 *  live stream. A large, non-decreasing count is the fingerprint of chats
 *  wedged mid-stream (the case cleared from /admin/redis). Bounded by a SCAN
 *  iteration cap so it stays cheap on a big keyspace. */
export async function activeStreamCount(): Promise<number> {
  const redis = healthRedis();
  if (!redis) return 0;
  let cursor = "0";
  let count = 0;
  let iterations = 0;
  try {
    do {
      const [next, keys] = (await withTimeout(
        redis.scan(cursor, { match: "ollchat:stream:*:meta", count: 500 }),
        REDIS_PROBE_TIMEOUT_MS,
        "SCAN streams"
      )) as [string | number, string[]];
      cursor = String(next);
      count += keys.length;
      iterations += 1;
    } while (cursor !== "0" && iterations < 20);
  } catch {
    // best-effort; return what we counted so far
  }
  return count;
}

export type UserHealth = {
  fetchedAt: number;
  providers: { ollama: ProviderHealth; runpod: ProviderHealth | null };
  sync: ServiceHealth;
};

/** The user-facing summary (Preferences → Debug). Provider + sync only — no
 *  worker internals or queue depths, which are admin concerns. */
export async function collectUserHealth(runpodEndpointId?: string): Promise<UserHealth> {
  const [ollama, runpod, sync] = await Promise.all([
    pingOllama(),
    pingRunpod(runpodEndpointId),
    pingSync(),
  ]);
  return { fetchedAt: Date.now(), providers: { ollama, runpod }, sync };
}

export type AdminDiagnostics = UserHealth & {
  worker: WorkerStatus;
  queues: QueueDepth[];
  activeStreams: number;
};

/** The admin deep view (/admin/diagnostics). Everything the user view has,
 *  plus the Fly worker's machine state, job-queue depths, and the in-flight
 *  stream count — the signals that tell an admin what to reset. */
export async function collectAdminDiagnostics(
  runpodEndpointId?: string
): Promise<AdminDiagnostics> {
  const [user, worker, queues, activeStreams] = await Promise.all([
    collectUserHealth(runpodEndpointId),
    getWorkerStatus(),
    queueDepths(),
    activeStreamCount(),
  ]);
  return { ...user, worker, queues, activeStreams };
}
