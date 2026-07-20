// Signed-upload broker for share payloads (apps + raw HTML artifacts).
//
// Mirrors /api/account/blob-upload: the client calls
// `upload(pathname, blob, { handleUploadUrl: '/api/share-blob-upload', ... })`,
// which negotiates a short-lived token here, and then PUTs the bytes directly
// to Vercel Blob — never through this function. That removes the per-share
// size cap (was 500 KB for app, 800 KB for HTML) since the bytes never have
// to fit in a Vercel function body.
//
// Path shape (enforced — both lines are public read-only via the blob CDN):
//   share/app/{token}.json
//   share/html/{token}.json
//
// The token is generated client-side via crypto.getRandomValues; this route
// only validates its shape. The matching `POST /api/share` and
// `POST /api/share-html` write the Redis pointer that maps token → blob URL.
// Without that pointer write, even a blob with a known token URL has no
// matching share entry — the public `/share/...` page won't find it.
//
// Why this route lives at `/api/share-blob-upload` and not `/api/share/blob-upload`:
// proxy.ts allow-lists every path under `/api/share/` for unauthenticated
// recipients. We need this endpoint to remain authenticated (otherwise
// anyone could mint upload tokens), so it sits at the sibling path that
// matches the existing `/api/share-html`, `/api/share-chat`,
// `/api/share-note` convention for owner-authenticated share endpoints.

import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import {
  assertShareUploadPath,
  isBlobStoreConfigured,
} from "@/app/lib/blob-store";
import { getCurrentUserEmail } from "@/app/lib/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isBlobStoreConfigured()) {
    return Response.json(
      {
        error:
          "Blob storage isn't configured on this server. Set BLOB_READ_WRITE_TOKEN.",
      },
      { status: 503 }
    );
  }

  const email = await getCurrentUserEmail(req);
  if (!email) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        // Throws if the path isn't a recognized share shape.
        assertShareUploadPath(pathname);
        return {
          allowedContentTypes: ["application/json"],
          addRandomSuffix: false,
          // Share tokens are client-generated random 22-char IDs; a
          // collision is effectively impossible, so we leave overwrite off.
          maximumSizeInBytes: 50 * 1024 * 1024,
          tokenPayload: JSON.stringify({ email }),
        };
      },
      onUploadCompleted: async () => {
        // No-op; the matching `/api/share*` route writes the Redis pointer.
      },
    });
    return Response.json(jsonResponse);
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : "Upload-token request failed.",
      },
      { status: 400 }
    );
  }
}
