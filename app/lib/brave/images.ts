/**
 * Brave Search Images API client. Used by the `image_search` tool.
 *
 * Replaces the old web_search → fetchPageHtml → extractImagesFromHtml
 * pipeline, which mis-treated `og:image` (a share/preview hint, not a content
 * image) as authoritative and got blocked by JS-required stubs on most modern
 * sites. Brave returns ranked image results directly — no HTML scraping
 * required.
 *
 * Docs: https://api.search.brave.com/app/documentation/image-search/get-started
 */
const BRAVE_IMAGES_ENDPOINT = "https://api.search.brave.com/res/v1/images/search";
const DEFAULT_TIMEOUT_MS = 12_000;

export type BraveImage = {
  /** Full-resolution source image URL. */
  url: string;
  /** Page that hosts the image. */
  source: string;
  title?: string;
  width?: number;
  height?: number;
  /** Brave CDN thumbnail (fast preview, no hot-link blocks). */
  thumbnail?: string;
};

export type BraveImageSearchOptions = {
  query: string;
  /** 1–100; Brave's hard cap is 100, we clamp to 20 for sanity. */
  maxResults?: number;
  /** "off" | "strict" — Brave's two supported values for image search. */
  safesearch?: "off" | "strict";
  signal?: AbortSignal;
};

export class BraveConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BraveConfigError";
  }
}

/**
 * Brave's response shape (subset). The API has a stable envelope around
 * `results`, but each result carries a deeply nested image-properties object
 * that's optional in their typings — defensive parsing here.
 */
type BraveRawResponse = {
  type?: string;
  results?: Array<{
    type?: string;
    title?: string;
    url?: string;
    source?: string;
    thumbnail?: { src?: string };
    properties?: {
      url?: string;
      placeholder?: string;
    };
    meta_url?: { hostname?: string };
    // Some payload variants put dimensions on `image_properties`.
    image_properties?: { width?: number; height?: number };
  }>;
};

export async function braveImageSearch(
  opts: BraveImageSearchOptions
): Promise<BraveImage[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new BraveConfigError(
      "Image search is unavailable: configure BRAVE_SEARCH_API_KEY."
    );
  }

  const query = opts.query.trim();
  if (!query) return [];
  const count = Math.min(20, Math.max(1, Math.trunc(opts.maxResults ?? 6)));

  const url = new URL(BRAVE_IMAGES_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  url.searchParams.set("safesearch", opts.safesearch ?? "strict");

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  // Forward an external AbortSignal if one was passed.
  opts.signal?.addEventListener("abort", () => ctrl.abort(), { once: true });

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Brave Images returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`
    );
  }

  const json = (await res.json()) as BraveRawResponse;
  const out: BraveImage[] = [];
  for (const r of json.results ?? []) {
    const imgUrl = r.properties?.url ?? r.thumbnail?.src;
    if (!imgUrl || typeof imgUrl !== "string") continue;
    if (!imgUrl.startsWith("https://")) continue;
    out.push({
      url: imgUrl,
      source: r.url ?? "",
      title: r.title,
      width: r.image_properties?.width,
      height: r.image_properties?.height,
      thumbnail: r.thumbnail?.src,
    });
  }
  return out;
}

/** A Brave image with the URL that actually loaded resolved. */
export type ValidatedBraveImage = BraveImage & {
  /** Either `url` or `thumbnail`, whichever passed the reachability check. */
  finalUrl: string;
  /** True iff the original `url` was dead and we fell back to the thumbnail. */
  usedThumbnail: boolean;
};

const VALIDATE_TIMEOUT_MS = 4_000;

/**
 * Brave image search + per-result reachability check. Filters dead URLs
 * before the model sees them, which is the load-bearing fix for the "model
 * burns 50 tool rounds verifying broken image URLs" failure mode: Brave
 * happily returns stale real-estate listings, removed Wikipedia images, and
 * other 404s, and without this gate the artifact iframe shows a broken-image
 * glyph and the model loops re-searching or `web_fetch`-ing each URL.
 *
 * When the original full-res URL is dead, we fall back to Brave's own CDN
 * thumbnail — smaller, but it effectively always loads (no hot-link blocks,
 * no expired listings). That keeps the "found nothing" case very rare. We
 * over-fetch ~2x from Brave so a normal dead-URL rate still yields the
 * caller's requested count of working hits.
 */
export async function braveImageSearchValidated(
  opts: BraveImageSearchOptions
): Promise<ValidatedBraveImage[]> {
  const askedFor = Math.min(20, Math.max(1, Math.trunc(opts.maxResults ?? 6)));
  const overfetch = Math.min(20, askedFor * 2);
  const raw = await braveImageSearch({ ...opts, maxResults: overfetch });

  const results = await Promise.all(
    raw.map(async (img): Promise<ValidatedBraveImage | null> => {
      if (await validateImageReachable(img.url, VALIDATE_TIMEOUT_MS)) {
        return { ...img, finalUrl: img.url, usedThumbnail: false };
      }
      if (img.thumbnail && img.thumbnail !== img.url) {
        if (await validateImageReachable(img.thumbnail, VALIDATE_TIMEOUT_MS)) {
          return { ...img, finalUrl: img.thumbnail, usedThumbnail: true };
        }
      }
      return null;
    })
  );

  const out: ValidatedBraveImage[] = [];
  for (const r of results) {
    if (!r) continue;
    out.push(r);
    if (out.length >= askedFor) break;
  }
  return out;
}

/**
 * Cheap pre-flight check used to filter dead image URLs before they reach the
 * model. Issues a 1-byte `Range` GET with the same Referer/User-Agent trick
 * `/api/img` uses on the real load, so CDNs that hot-link-block don't
 * false-negative us. Returns `false` on network errors, timeouts, non-2xx
 * responses, or obvious non-image content-types (text/html, JSON — the
 * "image was deleted, here's our 404 page" case); `true` otherwise.
 */
export async function validateImageReachable(
  url: string,
  timeoutMs: number
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": "LasagnaImageProxy/1.0",
        accept: "image/*,*/*;q=0.8",
        referer: `${parsed.protocol}//${parsed.host}/`,
        range: "bytes=0-0",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    // Don't drain the body — we have what we need from the headers.
    res.body?.cancel().catch(() => {});
    if (!res.ok && res.status !== 206) return false;
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct.startsWith("image/")) return true;
    if (ct.startsWith("text/html") || ct.startsWith("application/json")) {
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
