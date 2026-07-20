// POST /api/share — completes a share after the browser has already uploaded
// the payload to Vercel Blob.
//
// New two-step flow (the bytes never travel through this function):
//   1. Browser:  POST /api/share-blob-upload + PUT to blob CDN → blobUrl
//   2. Browser:  POST /api/share { token, blobUrl, includeState? }
//                ↓
//   This route:  fetch blobUrl → extract material for Gemma summary →
//                write Redis pointer { blobUrl, summary, createdAt, expiresAt }
//                under a 7-day TTL → return { token, url, summary, expiresAt }.
//
// The matching GET route at /api/share/[token] (allowlisted for
// unauthenticated recipients in proxy.ts) reads the pointer and hydrates
// the full SharedAppPayload from the blob.

import { chatClientFor } from "@/app/lib/llm/router";
import {
  SHARE_TOKEN_REGEX,
  SHARE_TTL_SECONDS,
  isShareStoreConfigured,
  putShareIndex,
  type SharedApp,
  type SharedDesigner,
} from "@/app/lib/share-store";
import {
  appShareBlobPath,
  fetchBlobJson,
  isBlobStoreConfigured,
} from "@/app/lib/blob-store";
import type { ArtifactFiles } from "@/app/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUMMARY_MODEL = "gemma4:31b";

// Hard cap on how long we'll wait for the model. The share button stalls
// until this resolves; a manifest-description fallback is fine if Gemma is
// slow.
const SUMMARY_TIMEOUT_MS = 5_000;

const SUMMARY_SYSTEM = `You write a 2-3 sentence plain-prose description of what an app does, so a recipient deciding whether to import it knows what they're getting. No preamble. No "this app". No emojis. Mention what the user sees and what data it shows. Avoid implementation details. Aim for under 60 words.`;

type Body = {
  token?: unknown;
  blobUrl?: unknown;
};

export async function POST(req: Request) {
  if (!isShareStoreConfigured()) {
    return Response.json(
      {
        error:
          "App sharing isn't configured on this server. Ask the operator to set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
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
  if (!SHARE_TOKEN_REGEX.test(token)) {
    return Response.json({ error: "Invalid share token." }, { status: 400 });
  }
  if (!blobUrl) {
    return Response.json({ error: "blobUrl is required." }, { status: 400 });
  }
  // Defense in depth: the blob URL must point at the share namespace path
  // we'd issue for this token. Without this, a malicious caller could
  // upload to their own account namespace (via /api/account/blob-upload)
  // and register it as a share to expose private data via the unauth
  // `/share/{token}` page.
  const expectedPath = appShareBlobPath(token);
  if (!blobUrl.includes(expectedPath)) {
    return Response.json(
      { error: "blobUrl doesn't match the expected share path." },
      { status: 400 }
    );
  }

  // Fetch the blob so we can summarize it. Server-to-blob via the private
  // store; @vercel/blob's get() signs the request for us.
  const stored = await fetchBlobJson<{
    designer: SharedDesigner;
    app: SharedApp;
  }>(blobUrl);
  if (!stored?.designer || !stored?.app) {
    return Response.json(
      { error: "Couldn't read uploaded share blob, or it was malformed." },
      { status: 502 }
    );
  }

  const summary = await summarizeWithGemma(stored.designer);

  const now = Date.now();
  const expiresAt = now + SHARE_TTL_SECONDS * 1000;

  try {
    await putShareIndex(token, {
      blobUrl,
      summary,
      createdAt: now,
      expiresAt,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to write share." },
      { status: 500 }
    );
  }

  return Response.json({
    token,
    url: `/share/${token}`,
    summary,
    expiresAt,
  });
}

async function summarizeWithGemma(designer: SharedDesigner): Promise<string> {
  const fallback =
    designer.manifest?.description?.trim() || `${designer.name} — shared app`;

  let llm;
  try {
    llm = chatClientFor(SUMMARY_MODEL);
  } catch {
    return fallback;
  }

  const filesPreview = buildFilesPreview(designer.files);
  const userPrompt = `App name: ${designer.name}
Manifest: ${JSON.stringify(designer.manifest ?? {}, null, 2)}

Files:
${filesPreview}`;

  try {
    const res = await Promise.race([
      llm.chat({
        model: SUMMARY_MODEL,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM },
          { role: "user", content: userPrompt },
        ],
        stream: false,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("summary-timeout")), SUMMARY_TIMEOUT_MS)
      ),
    ]);
    const text = (res.message?.content ?? "").trim();
    if (text) return text.slice(0, 600);
    return fallback;
  } catch {
    return fallback;
  }
}

function buildFilesPreview(files: ArtifactFiles): string {
  return Object.entries(files)
    .filter(([p]) => /\.(html|tsx?|jsx?|json|md|css)$/i.test(p))
    .slice(0, 8)
    .map(([p, c]) => `--- ${p} ---\n${c.slice(0, 1500)}`)
    .join("\n\n");
}
