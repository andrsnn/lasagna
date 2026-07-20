// Presigned-URL minter for account-shared designer blobs.
//
// The store is private (the URL host is `*.private.blob.vercel-storage.com`),
// so the browser can't `fetch(blobUrl)` directly. It posts the pathname here
// and we mint a short-lived signed URL scoped to that exact pathname — but
// only after confirming the path lives under the caller's own namespace, so
// a malicious caller can't request a token for someone else's designer.
//
// Why presign + direct fetch instead of proxying bytes through a function:
// the designer's current.json can be many MB. Proxying would re-introduce
// the Vercel function body cap (the whole reason we moved to blob in the
// first place); presigning lets the browser pull the bytes straight from
// the blob CDN.

import { issueSignedToken, presignUrl } from "@vercel/blob";
import {
  assertAccountUploadPath,
  isBlobStoreConfigured,
  userHash,
} from "@/app/lib/blob-store";
import { getCurrentUserEmail } from "@/app/lib/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One minute is plenty for the browser to fan out the read; keep the window
// tight so a stolen URL has minimal blast radius.
const PRESIGN_TTL_MS = 60 * 1000;

export async function POST(req: Request) {
  if (!isBlobStoreConfigured()) {
    return Response.json(
      { error: "Blob storage isn't configured on this server." },
      { status: 503 }
    );
  }
  const email = await getCurrentUserEmail(req);
  if (!email) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { pathname?: string; url?: string }
    | null;
  let pathname = body?.pathname;
  if (!pathname && typeof body?.url === "string") {
    try {
      pathname = new URL(body.url).pathname.replace(/^\//, "");
    } catch {
      // fall through to the "pathname required" error
    }
  }
  if (typeof pathname !== "string" || pathname.length === 0) {
    return Response.json({ error: "pathname required" }, { status: 400 });
  }

  const expectedUserHash = await userHash(email);
  try {
    assertAccountUploadPath(pathname, expectedUserHash);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid pathname." },
      { status: 403 }
    );
  }

  const validUntil = Date.now() + PRESIGN_TTL_MS;
  const signedToken = await issueSignedToken({
    pathname,
    operations: ["get"],
    validUntil,
  });
  const { presignedUrl } = await presignUrl(signedToken, {
    operation: "get",
    pathname,
    access: "private",
  });

  return Response.json({ url: presignedUrl, validUntil });
}
