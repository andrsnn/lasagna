// POST /api/share-html — completes an HTML-artifact share after the browser
// has already uploaded the doc to Vercel Blob.
//
// New two-step flow (the bytes never travel through this function):
//   1. Browser:  POST /api/share-blob-upload + PUT to blob CDN → blobUrl
//   2. Browser:  POST /api/share-html { token, blobUrl, title, summary, appId? }
//                ↓
//   This route:  composes the SDK-injected HTML into the blob (idempotently)
//                — actually we do this client-side now since the bytes are
//                already in the blob. The route just writes the Redis
//                pointer { blobUrl, title, summary, ... } with a 7-day TTL.
//
// Composing the SDK into the HTML used to happen here in `composeArtifactSrcdoc`.
// We've moved that step into the client so the bytes uploaded to blob
// already contain the SDK injection — no server-side mutation of blob
// contents is needed, and the route stays small.

import {
  HTML_SHARE_TOKEN_REGEX,
  HTML_SHARE_TTL_SECONDS,
  isHtmlShareStoreConfigured,
  putHtmlShareIndex,
} from "@/app/lib/html-share-store";
import { htmlShareBlobPath, isBlobStoreConfigured } from "@/app/lib/blob-store";
import { putAppShareToken } from "@/app/lib/share-input-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APP_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const TITLE_MAX = 120;
const SUMMARY_MAX = 600;

type Body = {
  token?: unknown;
  blobUrl?: unknown;
  title?: unknown;
  summary?: unknown;
  appId?: unknown;
};

export async function POST(req: Request) {
  if (!isHtmlShareStoreConfigured()) {
    return Response.json(
      {
        error:
          "HTML sharing isn't configured on this server. Ask the operator to set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      },
      { status: 503 }
    );
  }
  if (!isBlobStoreConfigured()) {
    return Response.json(
      {
        error:
          "Blob storage isn't configured on this server. Ask the operator to set BLOB_READ_WRITE_TOKEN.",
      },
      { status: 503 }
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  const blobUrl = typeof body.blobUrl === "string" ? body.blobUrl : "";
  const title = sanitizeShortText(body.title, TITLE_MAX) || "Shared artifact";
  const summary =
    sanitizeShortText(body.summary, SUMMARY_MAX) ||
    "An HTML artifact made on Lasagna.";
  const appId =
    typeof body.appId === "string" && APP_ID_REGEX.test(body.appId)
      ? body.appId
      : undefined;

  if (!HTML_SHARE_TOKEN_REGEX.test(token)) {
    return Response.json({ error: "Invalid share token." }, { status: 400 });
  }
  if (!blobUrl) {
    return Response.json({ error: "blobUrl is required." }, { status: 400 });
  }
  // Defense in depth: the blob URL must point at this token's path.
  const expectedPath = htmlShareBlobPath(token);
  if (!blobUrl.includes(expectedPath)) {
    return Response.json(
      { error: "blobUrl doesn't match the expected share path." },
      { status: 400 }
    );
  }

  const now = Date.now();
  const expiresAt = now + HTML_SHARE_TTL_SECONDS * 1000;

  try {
    await putHtmlShareIndex(token, {
      blobUrl,
      title,
      summary,
      createdAt: now,
      expiresAt,
      ...(appId ? { appId } : {}),
    });
    // Best-effort: if the owner is sharing a designer-paired app, persist
    // the appId → token mapping so the live owner frame can immediately
    // route artifact.shared.* through this share. Failure here doesn't
    // invalidate the share — the public viewer path still works without
    // the mapping.
    if (appId) await putAppShareToken(appId, token).catch(() => {});
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to write share." },
      { status: 500 }
    );
  }

  return Response.json({
    token,
    url: `/share/html/${token}`,
    title,
    summary,
    expiresAt,
  });
}

function sanitizeShortText(input: unknown, max: number): string {
  if (typeof input !== "string") return "";
  return input.replace(/\s+/g, " ").trim().slice(0, max);
}
