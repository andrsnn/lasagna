// Signed-upload broker for account-sync blobs.
//
// The client calls `upload(pathname, blob, { handleUploadUrl: '/api/account/blob-upload', ... })`
// from `@vercel/blob/client`. That helper hits this route with a small
// metadata-only request; we mint a short-lived token scoped to a specific
// pathname under the caller's namespace, and the browser then PUTs the bytes
// directly to Vercel Blob — never through this function. That's how we sidestep
// Vercel's 4.5 MB function-body cap for arbitrarily large designer VFS payloads
// and per-commit history snapshots.
//
// Path shape (enforced):
//   account/{userHash}/designer/{designerId}/current.json
//   account/{userHash}/designer/{designerId}/history/v{version}.json
//
// userHash is derived server-side from the authenticated email so a malicious
// caller can't request an upload token for someone else's pathname.

import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import {
  assertAccountUploadPath,
  isBlobStoreConfigured,
  userHash,
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

  const expectedUserHash = await userHash(email);
  const body = (await req.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        // Throws if the path isn't well-formed or escapes the caller's namespace.
        const parsed = assertAccountUploadPath(pathname, expectedUserHash);
        // Sandbox uploads are arbitrary binaries (audio/video/zip/…), so the
        // designer's JSON-only allowlist would reject them. Widen the content
        // types for the uploads namespace while keeping the same size cap and
        // namespace isolation. The store is public-access for these so the
        // browser can preview/download produced media directly.
        const isUpload = parsed.kind === "upload";
        return {
          allowedContentTypes: isUpload ? ["*/*"] : ["application/json"],
          addRandomSuffix: false,
          // current.json is rewritten on every save; commit blobs are
          // content-addressable by version and only ever written once. Sandbox
          // upload ids are unique per attach, so overwrite is harmless.
          allowOverwrite: true,
          // Designers can ship multi-MB current.json snapshots; bump the
          // ceiling well clear of that. 50 MB is generous and still well
          // below Vercel Blob's 5 GB per-blob cap.
          maximumSizeInBytes: 50 * 1024 * 1024,
          tokenPayload: JSON.stringify({ email }),
        };
      },
      onUploadCompleted: async () => {
        // No-op. The follow-up `POST /api/account` writes the Redis pointer;
        // an orphan blob (upload succeeded, metadata POST never arrived) is
        // tolerable — costs a few cents and can be cleaned up later.
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
