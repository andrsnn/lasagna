// SSRF-protected outbound fetch, shared by the authenticated artifact proxy
// (`/api/proxy`) and the public shared-viewer proxy
// (`/api/share/html/[token]/fetch`). Keeping the guard logic in one place
// means anonymous share viewers get exactly the same protections — HTTPS
// only, private/loopback/link-local addresses blocked, header stripping,
// body + time caps — as the owner-facing route, with no chance of the two
// drifting apart.

import { lookup } from "node:dns/promises";

const MAX_BODY_BYTES = 1_000_000; // 1 MB
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const STRIPPED_REQ_HEADERS = new Set([
  "host",
  "cookie",
  "authorization",
  "content-length",
  "connection",
  "transfer-encoding",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
]);

export type ProxyRequestBody = {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type ProxyResult = {
  httpStatus: number;
  payload: Record<string, unknown>;
};

/**
 * Perform one SSRF-guarded outbound fetch and return a structured result the
 * caller serializes with `Response.json(payload, { status: httpStatus })`.
 * The success payload mirrors the original `/api/proxy` shape exactly so the
 * artifact SDK's `artifact.fetch()` consumers don't need to branch on caller.
 */
export async function runSafeProxy(body: ProxyRequestBody): Promise<ProxyResult> {
  if (typeof body.url !== "string") {
    return { httpStatus: 400, payload: { error: "url is required." } };
  }

  let url: URL;
  try {
    url = new URL(body.url);
  } catch {
    return { httpStatus: 400, payload: { error: "Invalid URL." } };
  }

  if (url.protocol !== "https:") {
    return { httpStatus: 400, payload: { error: "Only https:// URLs are allowed." } };
  }

  // Resolve hostname and refuse private / loopback / link-local addresses.
  const safe = await isHostnameSafe(url.hostname);
  if (!safe.ok) {
    return { httpStatus: 400, payload: { error: safe.reason } };
  }

  const method = (body.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return { httpStatus: 400, payload: { error: `Method ${method} not allowed.` } };
  }

  // Sanitise request headers — no auth, no host overrides, no cookies.
  const headers = new Headers();
  for (const [k, v] of Object.entries(body.headers ?? {})) {
    if (STRIPPED_REQ_HEADERS.has(k.toLowerCase())) continue;
    headers.set(k, v);
  }
  if (!headers.has("user-agent")) {
    headers.set("user-agent", "LasagnaProxy/1.0");
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body.body,
      redirect: "follow",
      signal: ctrl.signal,
    });

    // Read the body into a length-bounded buffer.
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (total + value.byteLength > MAX_BODY_BYTES) {
          chunks.push(value.slice(0, MAX_BODY_BYTES - total));
          total = MAX_BODY_BYTES;
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    }

    const buf = concatBuffers(chunks, total);
    const contentType = res.headers.get("content-type") ?? "";

    let bodyOut: string | null = null;
    if (looksTextual(contentType)) {
      bodyOut = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    } else {
      // Base64 binary up to 1 MB.
      bodyOut = Buffer.from(buf).toString("base64");
    }

    return {
      httpStatus: 200,
      payload: {
        status: res.status,
        ok: res.ok,
        url: res.url,
        contentType,
        headers: pickHeaders(res.headers),
        body: bodyOut,
        isBase64: !looksTextual(contentType),
        truncated,
      },
    };
  } catch (err) {
    const aborted = (err as { name?: string }).name === "AbortError";
    return {
      httpStatus: 502,
      payload: {
        error: aborted
          ? "Upstream timed out."
          : err instanceof Error
            ? err.message
            : String(err),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function looksTextual(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return (
    t.startsWith("text/") ||
    t.includes("json") ||
    t.includes("xml") ||
    t.includes("javascript") ||
    t.includes("html") ||
    t.includes("svg") ||
    t.includes("csv")
  );
}

function pickHeaders(h: Headers): Record<string, string> {
  const safe = ["content-type", "content-length", "etag", "last-modified", "cache-control"];
  const out: Record<string, string> = {};
  for (const k of safe) {
    const v = h.get(k);
    if (v) out[k] = v;
  }
  return out;
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

export async function isHostnameSafe(
  hostname: string,
  redirectDepth = 0
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (redirectDepth > MAX_REDIRECTS) {
    return { ok: false, reason: "Too many DNS redirects." };
  }
  // Block obvious local names.
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
    // Let fetch fail naturally if DNS fails.
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
  // IPv4
  const v4 = addr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = +v4[1], b = +v4[2];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // IPv6
  const lower = addr.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower === "::") return true;
  return false;
}
