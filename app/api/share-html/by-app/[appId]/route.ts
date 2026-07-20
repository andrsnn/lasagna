// GET /api/share-html/by-app/[appId] — owner-only lookup of the active
// public share token for an app. Used by the authenticated artifact frame
// to wire `artifact.shared.*` into the same pool the public viewer sees.
//
// This route deliberately does NOT match the `/api/share/` public prefix —
// proxy.ts requires a session, which is what we want (only the owner
// should learn the token via this endpoint; everyone else has it because
// they were given the link).

import { getAppShareToken } from "@/app/lib/share-input-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APP_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ appId: string }> }
) {
  const { appId } = await params;
  if (!APP_ID_REGEX.test(appId)) {
    return Response.json({ error: "Invalid appId." }, { status: 400 });
  }
  let token: string | null = null;
  try {
    token = await getAppShareToken(appId);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Lookup failed." },
      { status: 500 }
    );
  }
  return Response.json({ token });
}
