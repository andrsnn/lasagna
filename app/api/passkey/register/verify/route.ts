// POST /api/passkey/register/verify — finish passkey enrollment.
//
// Body: { response: RegistrationResponseJSON, label?: string }
//
// Verifies the authenticator's attestation against the challenge we issued in
// /register/options, then persists the new credential (public key + counter +
// backup flags) so the user can sign in with it from this device next time.

import { getCurrentUserEmail } from "@/app/lib/current-user";
import { getUserByEmail } from "@/app/lib/user-store";
import {
  addPasskey,
  bytesToB64Url,
  consumeRegistrationChallenge,
  getPasskeyOwner,
  isPasskeyStoreConfigured,
  toPasskeySummary,
  type StoredPasskey,
} from "@/app/lib/passkey-store";
import {
  deviceNameFromUserAgent,
  getExpectedOrigin,
  getRpID,
} from "@/app/lib/passkey-config";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isPasskeyStoreConfigured()) {
    return Response.json(
      { error: "Passkeys are unavailable — Redis isn't configured." },
      { status: 503 }
    );
  }
  const email = await getCurrentUserEmail(req);
  if (!email) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const user = await getUserByEmail(email).catch(() => null);
  if (user?.passkeysDisabled) {
    return Response.json(
      { error: "Passkeys are disabled for this account." },
      { status: 403 }
    );
  }

  let body: { response?: unknown; label?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const response = body.response as RegistrationResponseJSON | undefined;
  if (!response || typeof response !== "object") {
    return Response.json({ error: "Missing registration response." }, { status: 400 });
  }

  const expectedChallenge = await consumeRegistrationChallenge(email);
  if (!expectedChallenge) {
    return Response.json(
      { error: "Your enrollment session expired. Please try again." },
      { status: 400 }
    );
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: getExpectedOrigin(req),
      expectedRPID: getRpID(req),
      // We ask for UV "preferred", so don't hard-require it at verify time —
      // otherwise an authenticator that only did user-presence would fail.
      requireUserVerification: false,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Could not verify passkey." },
      { status: 400 }
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return Response.json({ error: "Passkey verification failed." }, { status: 400 });
  }

  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  // Guard against enrolling a credential ID that already belongs to someone
  // else (should be impossible in practice, but the reverse index must stay
  // 1:1 or usernameless login would resolve to the wrong account).
  const owner = await getPasskeyOwner(credential.id);
  if (owner && owner !== email.toLowerCase()) {
    return Response.json(
      { error: "That passkey is already registered to another account." },
      { status: 409 }
    );
  }

  const label =
    typeof body.label === "string" && body.label.trim().length > 0
      ? body.label.trim().slice(0, 60)
      : deviceNameFromUserAgent(req.headers.get("user-agent"), credential.transports);

  const now = Date.now();
  const stored: StoredPasskey = {
    id: credential.id,
    publicKey: bytesToB64Url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    name: label,
    createdAt: now,
    lastUsedAt: now,
  };
  await addPasskey(email, stored);

  return Response.json({ ok: true, passkey: toPasskeySummary(stored) });
}
