// /api/passkey — the signed-in user's own passkey management surface.
//
//   GET    → { configured, disabled, credentials }. Also the gate the
//            enroll-prompt reads: no credentials + not disabled → prompt.
//   POST   { disabled: boolean }   → turn passkeys on/off for yourself
//                                    (e.g. "Don't ask again").
//   PATCH  { id, name }            → rename one of your passkeys.
//   DELETE ?id=<credentialId>      → remove one of your passkeys.
//
// Every operation is scoped to the caller's session email — you can only ever
// touch your own credentials.

import { getCurrentUserEmail } from "@/app/lib/current-user";
import { getUserByEmail, setPasskeysDisabled } from "@/app/lib/user-store";
import {
  deletePasskey,
  isPasskeyStoreConfigured,
  listPasskeys,
  renamePasskey,
  toPasskeySummary,
} from "@/app/lib/passkey-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unconfigured() {
  return Response.json(
    { configured: false, disabled: false, credentials: [] },
    { status: 200 }
  );
}

export async function GET(req: Request) {
  const email = await getCurrentUserEmail(req);
  if (!email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isPasskeyStoreConfigured()) return unconfigured();

  const [user, passkeys] = await Promise.all([
    getUserByEmail(email).catch(() => null),
    listPasskeys(email).catch(() => []),
  ]);
  return Response.json({
    configured: true,
    disabled: !!user?.passkeysDisabled,
    credentials: passkeys.map(toPasskeySummary),
  });
}

export async function POST(req: Request) {
  const email = await getCurrentUserEmail(req);
  if (!email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isPasskeyStoreConfigured()) {
    return Response.json(
      { error: "Passkeys are unavailable — Redis isn't configured." },
      { status: 503 }
    );
  }

  let body: { disabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.disabled !== "boolean") {
    return Response.json({ error: "`disabled` must be a boolean." }, { status: 400 });
  }
  const ok = await setPasskeysDisabled(email, body.disabled);
  if (!ok) return Response.json({ error: "Account not found." }, { status: 404 });
  return Response.json({ ok: true, disabled: body.disabled });
}

export async function PATCH(req: Request) {
  const email = await getCurrentUserEmail(req);
  if (!email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isPasskeyStoreConfigured()) {
    return Response.json(
      { error: "Passkeys are unavailable — Redis isn't configured." },
      { status: 503 }
    );
  }

  let body: { id?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!id || !name) {
    return Response.json({ error: "`id` and `name` are required." }, { status: 400 });
  }
  const ok = await renamePasskey(email, id, name);
  if (!ok) return Response.json({ error: "Passkey not found." }, { status: 404 });
  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  const email = await getCurrentUserEmail(req);
  if (!email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isPasskeyStoreConfigured()) {
    return Response.json(
      { error: "Passkeys are unavailable — Redis isn't configured." },
      { status: 503 }
    );
  }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return Response.json({ error: "`id` query param required." }, { status: 400 });
  }
  const ok = await deletePasskey(email, id);
  if (!ok) return Response.json({ error: "Passkey not found." }, { status: 404 });
  return Response.json({ ok: true });
}
