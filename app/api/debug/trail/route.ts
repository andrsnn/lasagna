// GET /api/debug/trail  — read the current user's durable breadcrumb trail.
// DELETE /api/debug/trail — clear it.
//
// The trail is written by /api/debug/log from Preferences → Debug. Because it
// lives server-side it survives a crashed tab AND is readable from any device
// (crash on mobile, read the trail on the laptop) and directly from Redis.

import { Redis } from "@upstash/redis";
import { getCurrentUserEmail } from "@/app/lib/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET(req: Request) {
  const redis = getRedis();
  if (!redis) return Response.json({ trail: [] });
  const email = await getCurrentUserEmail(req).catch(() => null);
  if (!email) return Response.json({ trail: [] });
  try {
    const raw = (await redis.lrange<string>(keyFor(email), 0, -1)) ?? [];
    const trail = raw.map((r) =>
      typeof r === "string" ? safeParse(r) : (r as unknown)
    );
    return Response.json({ trail });
  } catch {
    return Response.json({ trail: [] });
  }
}

export async function DELETE(req: Request) {
  const redis = getRedis();
  if (!redis) return new Response(null, { status: 204 });
  const email = await getCurrentUserEmail(req).catch(() => null);
  if (email) {
    try {
      await redis.del(keyFor(email));
    } catch {
      /* ignore */
    }
  }
  return new Response(null, { status: 204 });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: s };
  }
}
