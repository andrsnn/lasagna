// /api/admin/accounts/passkeys — admin control over any account's passkeys.
//
//   POST   { email, disabled }        → turn passkeys on/off for an account.
//                                       Disabling is the QA-account escape
//                                       hatch: no enroll prompt, no passkey
//                                       login, enrollment refused.
//   DELETE ?email=<e>[&id=<credId>]   → remove one passkey, or all of an
//                                       account's passkeys when no id given.
//
// Auth: the proxy admin gate already blocks non-admins on /api/admin/*, so no
// per-route isAdmin check is needed here.

import { isUserStoreConfigured, setPasskeysDisabled } from "@/app/lib/user-store";
import {
  deleteAllPasskeys,
  deletePasskey,
  isPasskeyStoreConfigured,
} from "@/app/lib/passkey-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notConfigured() {
  return Response.json(
    { error: "Passkeys unavailable — Redis isn't configured." },
    { status: 503 }
  );
}

export async function POST(req: Request) {
  if (!isUserStoreConfigured() || !isPasskeyStoreConfigured()) return notConfigured();

  let body: { email?: unknown; disabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email : "";
  if (!email) {
    return Response.json({ error: "`email` is required." }, { status: 400 });
  }
  if (typeof body.disabled !== "boolean") {
    return Response.json({ error: "`disabled` must be a boolean." }, { status: 400 });
  }
  const ok = await setPasskeysDisabled(email, body.disabled);
  if (!ok) return Response.json({ error: "Account not found." }, { status: 404 });
  return Response.json({ ok: true, disabled: body.disabled });
}

export async function DELETE(req: Request) {
  if (!isUserStoreConfigured() || !isPasskeyStoreConfigured()) return notConfigured();

  const url = new URL(req.url);
  const email = url.searchParams.get("email");
  const id = url.searchParams.get("id");
  if (!email) {
    return Response.json({ error: "`email` query param required." }, { status: 400 });
  }
  if (id) {
    const ok = await deletePasskey(email, id);
    if (!ok) return Response.json({ error: "Passkey not found." }, { status: 404 });
    return Response.json({ ok: true, removed: 1 });
  }
  const removed = await deleteAllPasskeys(email);
  return Response.json({ ok: true, removed });
}
