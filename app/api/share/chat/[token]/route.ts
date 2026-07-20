// GET /api/share/chat/[token] — public read of a shared chat payload.
//
// This route lives under the `/api/share/` prefix that proxy.ts allowlists, so
// a recipient who doesn't have an account on this deployment can still fetch
// the payload. The matching create route is POST /api/share-chat (deliberately
// outside the public prefix so it stays gated behind the session check).

import {
  CHAT_SHARE_TOKEN_REGEX,
  getChatShare,
} from "@/app/lib/chat-share-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!CHAT_SHARE_TOKEN_REGEX.test(token)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  let payload;
  try {
    payload = await getChatShare(token);
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
