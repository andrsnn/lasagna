// Image search for artifacts — the server side of `artifact.imageSearch()`.
//
// The SDK runs inside a sandboxed iframe and the host RPC handler runs in the
// browser, but Brave's image API needs the server-only BRAVE_SEARCH_API_KEY,
// so the search has to happen here. We reuse braveImageSearchValidated (the
// same over-fetch + reachability gate the `image_search` chat tool uses) so
// the artifact never receives a dead URL, then rewrite every hit through the
// /api/img proxy: the artifact's <img> base is `about:srcdoc`, hot-link-
// blocking CDNs reject the null-origin frame, and the proxied URL is stable
// and long-cached — which also makes it safe to persist via artifact.state.

import { braveImageSearchValidated, BraveConfigError } from "@/app/lib/brave/images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Light per-app rate limit mirroring /api/query. The host frame also rate-
// limits, but this guards the Brave budget against a frame that bypasses it.
const searchRateLimits = new Map<string, number[]>();

function isRateLimited(appId: string): boolean {
  const windowMs = 60_000;
  const maxCalls = 20;
  const now = Date.now();
  const fresh = (searchRateLimits.get(appId) ?? []).filter((t) => now - t < windowMs);
  if (fresh.length >= maxCalls) {
    searchRateLimits.set(appId, fresh);
    return true;
  }
  fresh.push(now);
  searchRateLimits.set(appId, fresh);
  return false;
}

type Body = {
  query?: string;
  maxResults?: number;
  safesearch?: "off" | "strict";
  appId?: string;
};

/**
 * Rewrite a full-res image URL through our same-origin image proxy so it loads
 * inside the sandboxed artifact iframe. Mirrors proxyImageUrl in
 * app/lib/ollama/tools.ts. Needs an absolute URL because `about:srcdoc` has no
 * useful base for relative paths.
 */
function proxyImageUrl(rawUrl: string, publicOrigin: string): string {
  try {
    if (new URL(rawUrl).protocol !== "https:") return rawUrl;
  } catch {
    return rawUrl;
  }
  return `${publicOrigin.replace(/\/+$/, "")}/api/img?u=${encodeURIComponent(rawUrl)}`;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return Response.json({ error: "query is required." }, { status: 400 });
  }

  const appId = typeof body.appId === "string" && body.appId ? body.appId : "anon";
  if (isRateLimited(appId)) {
    return Response.json(
      { error: "Too many image searches. Wait a minute." },
      { status: 429 }
    );
  }

  const maxResults = Number.isFinite(body.maxResults)
    ? Math.min(20, Math.max(1, Math.trunc(body.maxResults as number)))
    : 6;
  const safesearch = body.safesearch === "off" ? "off" : "strict";

  // Resolve the user-visible origin behind Vercel's proxy so proxied image
  // URLs point at the real host, not the internal lambda URL. Mirrors the
  // derivation in app/api/chat/route.ts.
  const fwdHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const fwdProto =
    req.headers.get("x-forwarded-proto") ??
    (fwdHost && /^(localhost|127\.|0\.0\.0\.0)/.test(fwdHost) ? "http" : "https");
  const publicOrigin = fwdHost ? `${fwdProto}://${fwdHost}` : new URL(req.url).origin;

  try {
    const images = await braveImageSearchValidated({ query, maxResults, safesearch });
    const seen = new Set<string>();
    const results: Array<{
      url: string;
      source: string;
      title?: string;
      width?: number;
      height?: number;
    }> = [];
    for (const img of images) {
      if (results.length >= maxResults) break;
      if (seen.has(img.finalUrl)) continue;
      seen.add(img.finalUrl);
      results.push({
        url: proxyImageUrl(img.finalUrl, publicOrigin),
        source: img.source,
        title: img.title,
        width: img.width,
        height: img.height,
      });
    }
    return Response.json({ query, results });
  } catch (err) {
    // BraveConfigError = missing API key (a deploy config problem); surface a
    // clear, non-retryable message rather than a generic 500.
    if (err instanceof BraveConfigError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "Image search failed." },
      { status: 502 }
    );
  }
}
