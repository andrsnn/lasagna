// GET /api/share/[token] — public read of a shared app payload.
//
// This route is allowlisted in proxy.ts so a recipient who doesn't have an
// account on this deployment can still fetch the payload and import the app
// into their own browser.

import { SHARE_TOKEN_REGEX, getShare } from "@/app/lib/share-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!SHARE_TOKEN_REGEX.test(token)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  let payload;
  try {
    payload = await getShare(token);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to read share." },
      { status: 500 }
    );
  }

  if (!payload) {
    return Response.json(
      { error: "This share link has expired or doesn't exist." },
      { status: 410 }
    );
  }

  return Response.json(payload);
}
