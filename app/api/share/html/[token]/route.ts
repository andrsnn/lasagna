// GET /api/share/html/[token] — public read of a shared HTML payload.
//
// This route is allowlisted in proxy.ts (matches the `/api/share/` prefix) so
// a recipient who doesn't have an account on this deployment can still fetch
// the payload and view the artifact in their browser.

import {
  HTML_SHARE_TOKEN_REGEX,
  getHtmlShare,
} from "@/app/lib/html-share-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!HTML_SHARE_TOKEN_REGEX.test(token)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  let payload;
  try {
    payload = await getHtmlShare(token);
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
