// /api/admin/sessions
//
//   GET  — returns the current session epoch (ms) plus whether the Redis
//          backing store is configured. The /admin/sessions page renders
//          "last expired N minutes ago" from this.
//
//   POST { action: "expireAll" } — bumps the epoch to Date.now(). Every
//          outstanding session cookie fails its next verification (because
//          its implied issuedAt is now < epoch) and the client is bounced
//          to /login. Same auth posture as the rest of /api/admin/* —
//          gated by the proxy session check.
//
// Note: the caller's own session gets booted too. The UI warns about that.

import {
  SESSION_COOKIE,
  SESSION_DURATION_MS,
  USER_HASH_COOKIE,
} from "@/app/lib/auth";
import {
  getSessionEpoch,
  isSessionEpochConfigured,
  setSessionEpoch,
} from "@/app/lib/session-epoch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const configured = isSessionEpochConfigured();
  const epoch = configured ? await getSessionEpoch() : 0;
  return Response.json({
    configured,
    epoch,
    sessionDurationMs: SESSION_DURATION_MS,
  });
}

export async function POST(req: Request) {
  if (!isSessionEpochConfigured()) {
    return Response.json(
      { error: "Session epoch unavailable — Redis is not configured." },
      { status: 503 }
    );
  }

  let body: { action?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.action !== "expireAll") {
    return Response.json(
      { error: "Unknown action. Expected { action: \"expireAll\" }." },
      { status: 400 }
    );
  }

  const epoch = await setSessionEpoch(Date.now());

  // Clear the caller's own cookies too — the next request would 401 anyway
  // (their token predates the new epoch), but unsetting now sends the
  // browser straight to /login instead of flashing a 401 redirect. Also
  // drop the non-HttpOnly user_hash cookie so the client-side IndexedDB
  // scoping doesn't keep pointing at this user's namespace.
  const isProd = process.env.NODE_ENV === "production";
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const name of [SESSION_COOKIE, USER_HASH_COOKIE]) {
    const parts = [`${name}=`, "Max-Age=0", "Path=/", "SameSite=Lax"];
    if (name === SESSION_COOKIE) parts.push("HttpOnly");
    if (isProd) parts.push("Secure");
    headers.append("Set-Cookie", parts.join("; "));
  }

  return new Response(JSON.stringify({ ok: true, epoch }), {
    status: 200,
    headers,
  });
}
