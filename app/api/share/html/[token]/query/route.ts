// Public `artifact.query()` for viewers of a shared HTML artifact.
//
//   POST /api/share/html/[token]/query   { prompt, schema?, model?,
//                                          webSearch?, system? }
//
// Sits under the public `/api/share/` allowlist in proxy.ts — no session
// cookie required, so anyone with the (128-bit unguessable) link can run the
// shared app's AI calls through this deployment. Because each call spends the
// operator's Ollama quota, abuse is bounded by:
//   - 128-bit unguessable token + 7-day TTL on the parent share
//   - per-(token, IP) cap   (QUERY_RATE_PER_MINUTE)
//   - per-token ceiling summed across ALL viewers (QUERY_RATE_PER_MINUTE_PER_TOKEN)
//
// Unlike the authenticated /api/query (which uses a resumable Redis stream so
// a closed tab can reconnect), this is single-shot: the viewer has no
// IndexedDB breadcrumb to resume from, so we just run executeQuery inline and
// return the same `{ text, json?, model }` payload shape the owner's frame
// ultimately resolves with.

import { executeQuery } from "@/app/lib/executors";
import { SHARE_QUERY_DEFAULT_MODEL } from "@/app/models";
import {
  HTML_SHARE_TOKEN_REGEX,
  isHtmlShareLive,
} from "@/app/lib/html-share-store";
import {
  QUERY_RATE_PER_MINUTE,
  QUERY_RATE_PER_MINUTE_PER_TOKEN,
  RATE_ALL_VIEWERS,
  checkRateLimit,
  isShareInputStoreConfigured,
} from "@/app/lib/share-input-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Body = {
  prompt?: unknown;
  schema?: unknown;
  model?: unknown;
  webSearch?: unknown;
  system?: unknown;
};

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const ip = xff.split(",")[0]?.trim();
  return ip && ip.length > 0 ? ip : "anon";
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!HTML_SHARE_TOKEN_REGEX.test(token)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  if (!isShareInputStoreConfigured()) {
    return Response.json(
      {
        error:
          "Live sharing isn't configured on this server. Ask the operator to set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      },
      { status: 503 }
    );
  }
  if (!(await isHtmlShareLive(token))) {
    return Response.json(
      { error: "This share link has expired or doesn't exist." },
      { status: 410 }
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (prompt.trim().length === 0) {
    return Response.json({ error: "prompt is required." }, { status: 400 });
  }

  // Two gates: a tight per-viewer cap, plus a per-token ceiling summed across
  // every viewer so one widely-shared link can't run up unbounded LLM spend.
  const ip = clientIp(req);
  const perViewer = await checkRateLimit(token, ip, "query", QUERY_RATE_PER_MINUTE);
  if (perViewer) {
    return Response.json(
      { error: "Too many requests. Wait a minute and try again." },
      { status: 429 }
    );
  }
  const perToken = await checkRateLimit(
    token,
    RATE_ALL_VIEWERS,
    "query",
    QUERY_RATE_PER_MINUTE_PER_TOKEN
  );
  if (perToken) {
    return Response.json(
      { error: "This shared app is busy right now. Try again in a minute." },
      { status: 429 }
    );
  }

  // Default to Gemma when the caller didn't pick a model. executeQuery would
  // otherwise fall back to DEFAULT_MODEL (a large model that may not be
  // provisioned on the operator's account and would hang here), so a shared
  // app with no explicit model gets the same fast, available default the app
  // uses in-app.
  const model =
    typeof body.model === "string" && body.model.length > 0
      ? body.model
      : SHARE_QUERY_DEFAULT_MODEL;

  const outcome = await executeQuery({
    prompt,
    schema: body.schema,
    model,
    webSearch: body.webSearch === true,
    system: typeof body.system === "string" ? body.system : undefined,
  });

  return Response.json(outcome.payload, { status: outcome.status });
}
