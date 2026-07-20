// POST /api/passkey/login/verify — finish a usernameless passkey sign-in.
//
// Body: { response: AuthenticationResponseJSON }
//
// Flow:
//   1. Read the flowId from the HttpOnly cookie set by /login/options and
//      consume the matching challenge from Redis (single use).
//   2. Resolve the credential the browser returned (`response.id`) to its
//      owning account via the reverse index.
//   3. Verify the assertion signature against the stored public key.
//   4. Bump the stored signature counter, then issue the normal session
//      cookies (same `issueSession` the password login uses).
//
// Public (pre-session) route — the whole point is to establish a session.

import { getAdminEmail, getUserByEmail } from "@/app/lib/user-store";
import {
  b64UrlToBytes,
  consumeAuthenticationChallenge,
  getPasskeyOwner,
  isPasskeyStoreConfigured,
  listPasskeys,
  touchPasskey,
} from "@/app/lib/passkey-store";
import {
  PASSKEY_AUTH_COOKIE,
  getExpectedOrigin,
  getRpID,
} from "@/app/lib/passkey-config";
import { getSessionSecret } from "@/app/lib/auth";
import { issueSession } from "../../../login/route";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GENERIC_ERROR = "That passkey didn't work. Try again or use your password.";

function parseCookie(header: string, name: string): string | null {
  if (!header) return null;
  for (const raw of header.split(";")) {
    const eq = raw.indexOf("=");
    if (eq < 0) continue;
    if (raw.slice(0, eq).trim() === name) return raw.slice(eq + 1).trim();
  }
  return null;
}

/** Expired-cookie header so a used/failed flow can't be replayed. */
function clearFlowCookie(): string {
  const parts = [
    `${PASSKEY_AUTH_COOKIE}=`,
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export async function POST(req: Request) {
  if (!getSessionSecret()) {
    return Response.json(
      { error: "Server is not configured." },
      { status: 503 }
    );
  }
  if (!isPasskeyStoreConfigured()) {
    return Response.json(
      { error: "Passkeys are unavailable — Redis isn't configured." },
      { status: 503 }
    );
  }

  const flowId = parseCookie(req.headers.get("cookie") ?? "", PASSKEY_AUTH_COOKIE);
  if (!flowId) {
    return Response.json(
      { error: "Your sign-in session expired. Please try again." },
      { status: 400 }
    );
  }
  const expectedChallenge = await consumeAuthenticationChallenge(flowId);
  if (!expectedChallenge) {
    return Response.json(
      { error: "Your sign-in session expired. Please try again." },
      { status: 400 }
    );
  }

  let body: { response?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const response = body.response as AuthenticationResponseJSON | undefined;
  const credentialId = response && typeof response === "object" ? response.id : null;
  if (!response || typeof credentialId !== "string" || !credentialId) {
    return Response.json({ error: "Missing sign-in response." }, { status: 400 });
  }

  const email = await getPasskeyOwner(credentialId);
  if (!email) {
    return Response.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  const user = await getUserByEmail(email).catch(() => null);
  if (user?.passkeysDisabled) {
    return Response.json(
      { error: "Passkeys are disabled for this account." },
      { status: 403 }
    );
  }

  const passkeys = await listPasskeys(email);
  const stored = passkeys.find((p) => p.id === credentialId);
  if (!stored) {
    return Response.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: getExpectedOrigin(req),
      expectedRPID: getRpID(req),
      credential: {
        id: stored.id,
        publicKey: b64UrlToBytes(stored.publicKey),
        counter: stored.counter,
        transports: stored.transports as AuthenticatorTransportFuture[] | undefined,
      },
      requireUserVerification: false,
    });
  } catch {
    return Response.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  if (!verification.verified) {
    return Response.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  await touchPasskey(email, credentialId, verification.authenticationInfo.newCounter);

  const isAdmin = user?.isAdmin === true || email === getAdminEmail();
  const res = await issueSession({ email, isAdmin });
  // Clear the one-time login-flow cookie now that we've minted a real session.
  res.headers.append("Set-Cookie", clearFlowCookie());
  return res;
}
