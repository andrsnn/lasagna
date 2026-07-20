import {
  appendHistory,
  getMeta,
  getResult,
  isScheduleStoreConfigured,
  recordLastRun,
  setResult,
} from "@/app/lib/schedule-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The schedule ledger is the app's ONE run history: the Settings panel reads
// its lastRun/result/history for "Last scan" and "Recent runs". Cron and
// "Run now" runs write to it server-side; this endpoint lets the host record
// the third kind of run - an in-app declared-entry refresh (entries.refresh /
// the chrome Refresh button) - so the panel can never claim "Last scan:
// never" while the app itself shows data refreshed seconds ago.

type Body = {
  status?: "complete" | "error";
  runAt?: number;
  durationMs?: number;
  prompt?: string;
  model?: string;
  webSearch?: boolean;
  result?: unknown;
  error?: string;
};

// Keep giant payloads out of the history list (Redis values are capped and
// the panel only previews results). Results above this are recorded without
// the payload; the data itself already lives in app.state.
const MAX_RESULT_JSON_CHARS = 200_000;

export async function POST(req: Request, ctx: { params: Promise<{ appId: string }> }) {
  if (!isScheduleStoreConfigured()) {
    return Response.json({ error: "Schedules disabled." }, { status: 503 });
  }
  const { appId } = await ctx.params;
  if (!appId) return Response.json({ error: "appId required." }, { status: 400 });

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const status = body.status === "error" ? "error" : "complete";
  const runAt = typeof body.runAt === "number" ? body.runAt : Date.now();
  const durationMs = typeof body.durationMs === "number" ? Math.max(0, body.durationMs) : 0;

  // Only reflect runs for apps with a registered schedule - the ledger (and
  // the panel that reads it) doesn't exist otherwise.
  const meta = await getMeta(appId);
  if (!meta) return Response.json({ ok: true, recorded: false }, { status: 200 });

  let result = body.result;
  try {
    if (result !== undefined && JSON.stringify(result).length > MAX_RESULT_JSON_CHARS) {
      result = undefined;
    }
  } catch {
    result = undefined;
  }

  // Mirror what a settled schedule run writes, with one guard: never clobber
  // a run the server currently has in flight (status "running") - its own
  // terminal write is coming.
  const existing = await getResult(appId).catch(() => null);
  if (existing?.status !== "running") {
    await setResult(appId, {
      result: result ?? null,
      runAt,
      status,
      ...(typeof body.error === "string" && body.error ? { error: body.error } : {}),
    });
  }
  await recordLastRun(appId, runAt);
  await appendHistory(appId, {
    runAt,
    durationMs,
    status,
    input: {
      type: "query",
      prompt: typeof body.prompt === "string" ? body.prompt : "",
      model: typeof body.model === "string" && body.model ? body.model : undefined,
      webSearch: body.webSearch === true,
    },
    modelUsed: typeof body.model === "string" && body.model ? body.model : undefined,
    ...(result !== undefined ? { result } : {}),
    ...(typeof body.error === "string" && body.error ? { error: body.error } : {}),
  });
  return Response.json({ ok: true, recorded: true }, { status: 200 });
}
