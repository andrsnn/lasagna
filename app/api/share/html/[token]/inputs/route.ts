// Public CRUD for inputs viewers contribute to a shared HTML artifact.
//
//   POST   /api/share/html/[token]/inputs           append one entry
//   GET    /api/share/html/[token]/inputs           list all entries
//                                       ?collection=name
//
// Both paths sit under the public `/api/share/` allowlist in proxy.ts —
// no session cookie required. Abuse is bounded by:
//   - 128-bit unguessable token
//   - per-(token, IP) rate limit
//   - per-collection / per-token / per-value caps in share-input-store
//   - 7-day TTL on the parent share
//
// The matching DELETE handler lives at ./[id]/route.ts.

import {
  APPEND_RATE_PER_MINUTE,
  appendInput,
  assertJsonValue,
  checkRateLimit,
  isShareInputStoreConfigured,
  isValidCollectionName,
  listInputs,
  type ShareInputEntry,
} from "@/app/lib/share-input-store";
import {
  HTML_SHARE_TOKEN_REGEX,
  getHtmlShare,
} from "@/app/lib/html-share-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AppendBody = {
  collection?: unknown;
  value?: unknown;
};

function clientIp(req: Request): string {
  // Vercel sets x-forwarded-for to a comma-separated list, left-most being
  // the original client. Trim to that. Fallback to "anon" so the rate-limit
  // bucket still works even when no header is set (local dev).
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const ip = xff.split(",")[0]?.trim();
  return ip && ip.length > 0 ? ip : "anon";
}

async function ensureShareLive(token: string): Promise<Response | null> {
  if (!HTML_SHARE_TOKEN_REGEX.test(token)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  if (!isShareInputStoreConfigured()) {
    return Response.json(
      {
        error:
          "Shared inputs aren't configured on this server. Ask the operator to set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      },
      { status: 503 }
    );
  }
  // Inputs piggyback on the parent share's lifetime. If the share is gone
  // or expired, the inputs are stale by definition — return 410 so the SDK
  // can stop polling.
  const share = await getHtmlShare(token);
  if (!share) {
    return Response.json(
      { error: "This share link has expired or doesn't exist." },
      { status: 410 }
    );
  }
  return null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const fail = await ensureShareLive(token);
  if (fail) return fail;

  const url = new URL(req.url);
  const collection = url.searchParams.get("collection");
  if (!isValidCollectionName(collection)) {
    return Response.json(
      { error: "collection is required and must match [a-z0-9_-]{1,32}." },
      { status: 400 }
    );
  }

  let entries: ShareInputEntry[];
  try {
    entries = await listInputs(token, collection);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to read inputs." },
      { status: 500 }
    );
  }
  return Response.json({ collection, entries });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const fail = await ensureShareLive(token);
  if (fail) return fail;

  let body: AppendBody;
  try {
    body = (await req.json()) as AppendBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const collection = body.collection;
  if (!isValidCollectionName(collection)) {
    return Response.json(
      { error: "collection is required and must match [a-z0-9_-]{1,32}." },
      { status: 400 }
    );
  }

  try {
    assertJsonValue(body.value);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid value." },
      { status: 400 }
    );
  }

  const ip = clientIp(req);
  const limited = await checkRateLimit(token, ip, "append", APPEND_RATE_PER_MINUTE);
  if (limited) {
    return Response.json(
      { error: "Too many submissions. Try again in a minute." },
      { status: 429 }
    );
  }

  try {
    const entry = await appendInput(token, collection, body.value);
    return Response.json({ collection, entry });
  } catch (err) {
    const status =
      err && typeof err === "object" && "httpStatus" in err
        ? Number((err as { httpStatus: number }).httpStatus)
        : 500;
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to append." },
      { status }
    );
  }
}
