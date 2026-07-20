import type { ResearchColumn, ScheduledTask } from "@/app/db";
import { get as getAccountEntity } from "@/app/lib/account-store";
import { parseCron } from "@/app/lib/cron-eval";
import { getCurrentUserEmail } from "@/app/lib/current-user";
import {
  isScheduleStoreConfigured,
  registerSchedule,
  setScheduleConnectors,
  type ScheduleOrigin,
} from "@/app/lib/schedule-store";
import { sanitizeRuntimeConnectors } from "@/app/lib/mcp/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  appId?: string;
  schedule?: unknown;
  origin?: ScheduleOrigin;
  /** Set by the host's cadence dropdown to mark this as an explicit user
   *  edit. The store preserves user-overridden cron across later manifest /
   *  SDK auto-registers. */
  userOverride?: boolean;
  /** Caller attests schedule.model was resolved from the app's configured
   *  model (app.model / model param / the user's default seen alongside it).
   *  Without this, the route strips the model and the store preserves the
   *  previously-registered value — unknowing writers can't change it. */
  modelResolved?: boolean;
  /** The user's MCP connectors to persist server-side for an mcp-flagged
   *  source's unattended run. An empty array CLEARS any stored connectors
   *  (source no longer mcp-flagged); an absent field leaves them untouched
   *  (older client). Stored in a server-only key, never echoed back. */
  connectors?: unknown;
};

export async function POST(req: Request) {
  if (!isScheduleStoreConfigured()) {
    return Response.json(
      {
        error:
          "Schedules need Redis credentials. Provision an Upstash Redis (or Vercel KV) database.",
      },
      { status: 503 }
    );
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const appId = typeof body.appId === "string" ? body.appId.trim() : "";
  if (!appId || appId.length > 200) {
    return Response.json({ error: "appId is required." }, { status: 400 });
  }

  const validation = validateTask(body.schedule);
  if (!validation.ok) {
    return Response.json({ error: validation.error }, { status: 400 });
  }

  // Only account-shared apps get enrolled in the recurring cron SWEEP — that
  // unattended auto-fire needs a durable server-side record so we never orphan
  // a schedule for a local-only app that's since been deleted. But the schedule
  // is still REGISTERED (meta stored) for any app, so manual "Run now" +
  // result persistence work everywhere: kick off a run, close the phone, and
  // read the result on return. Only the recurring auto-fire is gated.
  let accountShared = false;
  let ownerEmail: string | undefined;
  try {
    const userEmail = await getCurrentUserEmail(req);
    if (userEmail) {
      ownerEmail = userEmail;
      const accountApp = await getAccountEntity(userEmail, "app", appId);
      // Account-shared lives on the top-level app payload — chat bundles
      // (the other AccountPayload shape) don't reach this code path.
      accountShared = !!(accountApp as { accountShared?: boolean } | null)
        ?.accountShared;
    }
  } catch {
    // Reading the account store failed (Redis hiccup). Fail closed on the
    // recurring sweep; the on-demand path still works.
    accountShared = false;
  }

  const origin: ScheduleOrigin = body.origin === "sdk" ? "sdk" : "manifest";
  // A register may only CHANGE the stored model when the caller attests it
  // resolved the app's configured model (modelResolved: true — sent by frames
  // that received app.model and by the settings-save sync). Any other writer
  // (a stale manifest carried by account-sync, an old client, artifact code)
  // gets its model stripped here, and registerSchedule then preserves the
  // previously-stored value. This closes the last-writer-wins hole behind the
  // recurring "scheduled run used the wrong model" bug at the server boundary,
  // where every client version and every future call site must pass through.
  const task = validation.task;
  if (task.type === "query" && body.modelResolved !== true && task.model !== undefined) {
    task.model = undefined;
  }
  try {
    await registerSchedule(appId, task, origin, {
      userOverride: body.userOverride === true,
      includeInSweep: accountShared,
      ownerEmail,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Register failed" },
      { status: 500 }
    );
  }

  // Persist (or clear) the MCP connectors this app's scheduled source should
  // run with. Only act when the field is present: an array (even empty) is an
  // authoritative write from a current frame — [] clears; a populated list
  // stores. An absent field is an older client, so leave any stored connectors
  // intact. Best-effort: a connectors hiccup must not fail schedule register.
  if (Array.isArray(body.connectors)) {
    try {
      await setScheduleConnectors(appId, sanitizeRuntimeConnectors(body.connectors) ?? []);
    } catch (err) {
      console.warn(`[schedule ${appId}] setScheduleConnectors failed`, err);
    }
  }
  return Response.json({ ok: true, shared: accountShared, recurring: accountShared }, { status: 200 });
}

function validateTask(
  raw: unknown
): { ok: true; task: ScheduledTask } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "schedule must be an object." };
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.cron !== "string") {
    return { ok: false, error: "schedule.cron must be a string." };
  }
  const parsed = parseCron(s.cron);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  if (s.type !== "query" && s.type !== "fetch") {
    return { ok: false, error: 'schedule.type must be "query" or "fetch".' };
  }
  if (s.type === "query") {
    const prompt = typeof s.prompt === "string" ? s.prompt.trim() : "";
    if (!prompt) return { ok: false, error: "schedule.prompt is required." };
    if (prompt.length > 16000) {
      return { ok: false, error: "schedule.prompt is too long (max 16000 chars)." };
    }
    let tools: ("web_search" | "web_fetch")[] | undefined;
    if (s.tools !== undefined) {
      if (!Array.isArray(s.tools)) {
        return { ok: false, error: "schedule.tools must be an array." };
      }
      tools = [];
      for (const t of s.tools) {
        if (t !== "web_search" && t !== "web_fetch") {
          return { ok: false, error: `schedule.tools entry ${JSON.stringify(t)} not allowed.` };
        }
        tools.push(t);
      }
      if (tools.length === 0) tools = undefined;
    }
    const model = typeof s.model === "string" && s.model.length > 0 ? s.model : undefined;
    const research = s.research === true || undefined;
    // Research apps thread their table columns + identity columns so a scheduled
    // run conforms records to the same keys the table uses. Keep them only when
    // well-formed; a malformed value is dropped, never a hard error.
    const columns: ResearchColumn[] | undefined =
      Array.isArray(s.columns) &&
      s.columns.every(
        (c) => c && typeof c === "object" && typeof (c as { key?: unknown }).key === "string"
      )
        ? (s.columns as ResearchColumn[])
        : undefined;
    const idKeys: string[] | undefined =
      Array.isArray(s.idKeys) && s.idKeys.every((k) => typeof k === "string")
        ? (s.idKeys as string[])
        : undefined;
    return {
      ok: true,
      task: { cron: s.cron, type: "query", prompt, schema: s.schema, tools, model, research, columns, idKeys },
    };
  }
  // fetch
  const url = typeof s.url === "string" ? s.url.trim() : "";
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: "schedule.url must be an http(s) URL." };
  }
  let init: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
  if (s.init !== undefined) {
    if (!s.init || typeof s.init !== "object") {
      return { ok: false, error: "schedule.init must be an object." };
    }
    const i = s.init as Record<string, unknown>;
    const headers =
      i.headers && typeof i.headers === "object"
        ? (Object.fromEntries(
            Object.entries(i.headers as Record<string, unknown>).filter(
              ([, v]) => typeof v === "string"
            )
          ) as Record<string, string>)
        : undefined;
    init = {
      method: typeof i.method === "string" ? i.method : undefined,
      headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
      body: typeof i.body === "string" ? i.body : undefined,
    };
  }
  return { ok: true, task: { cron: s.cron, type: "fetch", url, init } };
}
