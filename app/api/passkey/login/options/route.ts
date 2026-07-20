// POST /api/passkey/login/options — begin a usernameless passkey sign-in.
//
// Public (pre-session) route. We generate WebAuthn authentication options with
// NO allowCredentials list so the browser offers every discoverable passkey
// bound to this site — the user just picks their phone / Face ID / security
// key. The challenge is stored in Redis under a random flowId that we hand
// back to the browser in a short-lived HttpOnly cookie; /login/verify reads it
// there. (Login can't be scoped by email, so a cookie-carried flow id is how
// the two calls are tied together.)

import {
  isPasskeyStoreConfigured,
  randomB64Url,
  setAuthenticationChallenge,
} from "@/app/lib/passkey-store";
import { PASSKEY_AUTH_COOKIE, getRpID } from "@/app/lib/passkey-config";
import { generateAuthenticationOptions } from "@simplewebauthn/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isPasskeyStoreConfigured()) {
    return Response.json(
      { error: "Passkeys are unavailable — Redis isn't configured." },
      { status: 503 }
    );
  }

  const options = await generateAuthenticationOptions({
    rpID: getRpID(req),
    userVerification: "preferred",
    // No allowCredentials → discoverable-credential (usernameless) flow.
  });

  const flowId = randomB64Url(24);
  await setAuthenticationChallenge(flowId, options.challenge);

  const isProd = process.env.NODE_ENV === "production";
  const cookie = [
    `${PASSKEY_AUTH_COOKIE}=${flowId}`,
    "Max-Age=300",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isProd) cookie.push("Secure");

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", cookie.join("; "));
  return new Response(JSON.stringify(options), { status: 200, headers });
}
