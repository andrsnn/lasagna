// GET /api/account/user-hash — returns the 16-hex stable hash of the
// authenticated caller's email. The blob upload pathnames are scoped to
// this hash (so URLs don't leak the email), and the client needs to know
// the value to construct the path it requests an upload token for. The
// hash is computed server-side from the session-derived email; the client
// cannot forge it.

import { getCurrentUserEmail } from "@/app/lib/current-user";
import { userHash } from "@/app/lib/blob-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const email = await getCurrentUserEmail(req);
  if (!email) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ userHash: await userHash(email) });
}
