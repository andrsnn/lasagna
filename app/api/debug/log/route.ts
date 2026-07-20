// POST /api/debug/log — durable breadcrumb sink for Preferences → Debug.
//
// localStorage breadcrumbs DON'T survive an iOS OOM tab-kill: WebKit flushes
// localStorage to disk lazily, so the last writes before the crash are lost
// with the renderer process. The client therefore also sends each breadcrumb
// here via a SYNCHRONOUS XHR — by the time send() returns, this route has the
// crumb in Redis, so it survives no matter what happens to the tab a moment
// later. Kept per-user, capped, and short-lived.

import { Redis } from "@upstash/redis";
import { getCurrentUserEmail } from "@/app/lib/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CAP = 800;
const TTL_SECONDS = 24 * 60 * 60;

let cached: Redis | null = null;
function getRedis(): Redis | null {
  if (cached) return cached;
  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  cached = new Redis({ url, token });
  return cached;
}

function keyFor(email: string): string {
  return `debug:trail:${email.trim().toLowerCase()}`;
}

export async function POST(req: Request) {
  // Never error out — a debug breadcrumb must be cheap and best-effort, and the
  // client sends these synchronously on the render path.
  const redis = getRedis();
  if (!redis) return new Response(null, { status: 204 });
  const email = await getCurrentUserEmail(req).catch(() => null);
  if (!email) return new Response(null, { status: 204 });
  let crumb: unknown = null;
  try {
    crumb = await req.json();
  } catch {
    return new Response(null, { status: 204 });
  }
  if (!crumb || typeof crumb !== "object") {
    return new Response(null, { status: 204 });
  }
  try {
    const key = keyFor(email);
    await redis.rpush(key, JSON.stringify(crumb));
    await redis.ltrim(key, -CAP, -1);
    await redis.expire(key, TTL_SECONDS);
  } catch {
    // swallow — losing a breadcrumb is fine, blocking the render is not
  }
  return new Response(null, { status: 204 });
}
