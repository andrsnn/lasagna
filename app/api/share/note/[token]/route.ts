// GET /api/share/note/[token] — public read of a shared pinned note.
//
// This route is allowlisted in proxy.ts (matches the `/api/share/` prefix) so
// a recipient who doesn't have an account on this deployment can still fetch
// the payload and view the note in their browser.

import {
  NOTE_SHARE_TOKEN_REGEX,
  getNoteShare,
} from "@/app/lib/note-share-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!NOTE_SHARE_TOKEN_REGEX.test(token)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  let payload;
  try {
    payload = await getNoteShare(token);
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
