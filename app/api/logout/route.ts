// Clears the session and user_hash cookies. Idempotent — calling without
// a session just no-ops on the client.

import { SESSION_COOKIE, USER_HASH_COOKIE } from "@/app/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const isProd = process.env.NODE_ENV === "production";
  const headers = new Headers({ "Content-Type": "application/json" });

  for (const name of [SESSION_COOKIE, USER_HASH_COOKIE]) {
    const parts = [`${name}=`, "Max-Age=0", "Path=/", "SameSite=Lax"];
    if (name === SESSION_COOKIE) parts.push("HttpOnly");
    if (isProd) parts.push("Secure");
    headers.append("Set-Cookie", parts.join("; "));
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
