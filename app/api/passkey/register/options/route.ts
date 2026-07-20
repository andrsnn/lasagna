// POST /api/passkey/register/options — begin passkey enrollment.
//
// The caller is already authenticated (this route is behind the proxy auth
// gate), so we scope everything to their session email. We generate WebAuthn
// registration options, list their existing credentials as `excludeCredentials`
// (so the same authenticator can't be enrolled twice), and stash the challenge
// in Redis keyed by email for the verify step to consume.

import { getCurrentUserEmail } from "@/app/lib/current-user";
import { getUserByEmail, getOrCreateWebauthnId } from "@/app/lib/user-store";
import {
  isPasskeyStoreConfigured,
  listPasskeys,
  setRegistrationChallenge,
  b64UrlToBytes,
} from "@/app/lib/passkey-store";
import { getRpID, getRpName } from "@/app/lib/passkey-config";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";

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

  const webauthnId = await getOrCreateWebauthnId(email);
  if (!webauthnId) {
    return Response.json({ error: "Account not found." }, { status: 404 });
  }

  const existing = await listPasskeys(email);
  const options = await generateRegistrationOptions({
    rpName: getRpName(),
    rpID: getRpID(req),
    userName: email,
    userDisplayName: email,
    userID: b64UrlToBytes(webauthnId),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.id,
      transports: c.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: {
      // "preferred" (not "required") keeps enrollment working on the widest
      // range of authenticators while still creating a discoverable passkey on
      // every modern platform (Face ID, Touch ID, Windows Hello, phones).
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  await setRegistrationChallenge(email, options.challenge);
  return Response.json(options);
}
