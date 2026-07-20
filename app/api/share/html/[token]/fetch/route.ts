// Public `artifact.fetch()` for viewers of a shared HTML artifact.
//
//   POST /api/share/html/[token]/fetch   { url, method?, headers?, body? }
//
// Sits under the public `/api/share/` allowlist in proxy.ts. Outbound
// requests go through the same SSRF-guarded runSafeProxy the authenticated
// /api/proxy uses (HTTPS only, private/loopback addresses blocked, body +
// time caps), so opening this to anonymous viewers doesn't widen the
// network surface beyond what the owner's frame already allows. Abuse is
// bounded by the unguessable token, the 7-day share TTL, and a per-(token,
// IP) rate cap.

import {
  HTML_SHARE_TOKEN_REGEX,
  isHtmlShareLive,
} from "@/app/lib/html-share-store";
import {
  FETCH_RATE_PER_MINUTE,
  checkRateLimit,
  isShareInputStoreConfigured,
} from "@/app/lib/share-input-store";
import { runSafeProxy } from "@/app/lib/safe-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const ip = clientIp(req);
  const limited = await checkRateLimit(token, ip, "fetch", FETCH_RATE_PER_MINUTE);
  if (limited) {
    return Response.json(
      { error: "Too many requests. Wait a minute and try again." },
      { status: 429 }
    );
  }

  const { httpStatus, payload } = await runSafeProxy(body as Record<string, unknown>);
  return Response.json(payload, { status: httpStatus });
}
