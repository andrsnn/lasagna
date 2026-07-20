import { lookup } from "node:dns/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Image proxy used by the `image_search` tool. Search results return
 * external image URLs that often cannot be loaded directly from inside the
 * sandboxed (`about:srcdoc`, opaque-origin) artifact iframe — many CDNs
 * gate hot-linking on Referer, and any same-origin or cookie-based auth
 * upstream is unreachable from a null-origin frame. We hop through this
 * route so the artifact `<img src>` always points at our own host, the
 * server fetches the bytes with a clean User-Agent, and we hand back the
 * raw image with permissive CORS + a long cache-control. The endpoint is
 * intentionally GET-only and accepts only HTTPS image URLs; private/internal
 * addresses are blocked just like /api/proxy.
 */

const MAX_BODY_BYTES = 4_000_000; // 4 MB cap per image
const FETCH_TIMEOUT_MS = 15_000;
// One day at the edge — image URLs are content-addressed in practice (CDN
// hashes in the path) so this is safe and dramatically cuts repeat fetches
// when the same artifact is reopened.
const CACHE_CONTROL = "public, max-age=86400, s-maxage=86400, immutable";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const target = url.searchParams.get("u");
  if (!target) {
    return new Response("Missing ?u parameter.", { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new Response("Invalid URL.", { status: 400 });
  }
  if (parsed.protocol !== "https:") {
    return new Response("Only https:// URLs are allowed.", { status: 400 });
  }

  const safe = await isHostnameSafe(parsed.hostname);
  if (!safe.ok) {
    return new Response(safe.reason, { status: 400 });
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstream = await fetch(parsed.toString(), {
      method: "GET",
      headers: {
        "user-agent": "LasagnaImageProxy/1.0",
        accept: "image/*,*/*;q=0.8",
        // Some CDNs (Wikimedia, Reddit's i.redd.it, etc.) reject blank
        // referers; sending the image's own origin gets us through them
        // without leaking our app's URL.
        referer: `${parsed.protocol}//${parsed.host}/`,
      },
      redirect: "follow",
      signal: ctrl.signal,
    });

    if (!upstream.ok) {
      return new Response(`Upstream ${upstream.status}`, {
        status: upstream.status,
        headers: { "access-control-allow-origin": "*" },
      });
    }

    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    if (!isImageType(contentType)) {
      return new Response(`Refusing non-image content-type: ${contentType}`, {
        status: 415,
        headers: { "access-control-allow-origin": "*" },
      });
    }

    // Stream into a length-bounded buffer.
    const reader = upstream.body?.getReader();
    if (!reader) {
      return new Response("Empty upstream body.", {
        status: 502,
        headers: { "access-control-allow-origin": "*" },
      });
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > MAX_BODY_BYTES) {
        await reader.cancel();
        return new Response(`Image exceeds ${MAX_BODY_BYTES} bytes.`, {
          status: 413,
          headers: { "access-control-allow-origin": "*" },
        });
      }
      chunks.push(value);
      total += value.byteLength;
    }

    const buf = concatBuffers(chunks, total);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-length": String(total),
        "cache-control": CACHE_CONTROL,
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
      },
    });
  } catch (err) {
    const aborted = (err as { name?: string }).name === "AbortError";
    return new Response(
      aborted ? "Upstream timed out." : err instanceof Error ? err.message : String(err),
      { status: 502, headers: { "access-control-allow-origin": "*" } }
    );
  } finally {
    clearTimeout(timeout);
  }
}

function isImageType(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return t.startsWith("image/");
}

function concatBuffers(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function isHostnameSafe(
  hostname: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower === "metadata.google.internal" ||
    lower.endsWith(".internal") ||
    lower.endsWith(".local")
  ) {
    return { ok: false, reason: `Refusing to fetch ${hostname}` };
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    return { ok: true };
  }
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      return { ok: false, reason: `Refusing to fetch private address (${a.address}).` };
    }
  }
  return { ok: true };
}

function isPrivateAddress(addr: string): boolean {
  const v4 = addr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = +v4[1];
    const b = +v4[2];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const lower = addr.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80")) return true;
  if (lower === "::") return true;
  return false;
}
