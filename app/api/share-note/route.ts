// POST /api/share-note — owner publishes a pinned note (html / markdown /
// chat snapshot) to Redis with a 7-day TTL, gets back a token + URL the
// recipient can paste into a browser.
//
// The path is authenticated (the owner must be signed in via the proxy
// session cookie — it deliberately doesn't match the `/api/share/` public
// prefix). The matching GET route at /api/share/note/[token] IS public so a
// recipient can fetch without signing up — see proxy.ts for the bypass.

import {
  NOTE_SHARE_TOKEN_REGEX,
  NOTE_SHARE_TTL_SECONDS,
  MAX_NOTE_SHARE_BYTES,
  isNoteShareStoreConfigured,
  newNoteShareToken,
  putNoteShare,
  type SharedNoteBody,
  type SharedNotePayload,
} from "@/app/lib/note-share-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IncomingBody = {
  title?: string;
  summary?: string;
  body?: {
    kind?: string;
    html?: string;
    markdown?: string;
    messages?: Array<{ role?: string; content?: string }>;
  };
  /**
   * When set, write the payload back to the same Redis key (and refresh the
   * 7-day TTL) instead of minting a fresh token. Used by the linked-note
   * iteration flow so the URL the recipient holds keeps working as the
   * owner iterates on the artifact. Falls back to a fresh token if the
   * passed value doesn't match the token format.
   */
  reuseToken?: string;
};

export async function POST(req: Request) {
  let raw: IncomingBody;
  try {
    raw = (await req.json()) as IncomingBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const body = normalizeBody(raw.body);
  if (!body) {
    return Response.json(
      { error: "body.kind must be html, markdown, or snapshot with non-empty content." },
      { status: 400 }
    );
  }

  if (!isNoteShareStoreConfigured()) {
    return Response.json(
      {
        error:
          "Note sharing isn't configured on this server. Ask the operator to set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      },
      { status: 503 }
    );
  }

  const title =
    sanitizeShortText(raw.title, 120) || defaultTitle(body);
  const summary =
    sanitizeShortText(raw.summary, 600) || defaultSummary(body);

  const now = Date.now();
  const payload: SharedNotePayload = {
    title,
    summary,
    body,
    createdAt: now,
    expiresAt: now + NOTE_SHARE_TTL_SECONDS * 1000,
  };

  const sizeProbe = JSON.stringify(payload).length;
  if (sizeProbe > MAX_NOTE_SHARE_BYTES) {
    return Response.json(
      {
        error: `Note is too large to share (${Math.round(sizeProbe / 1024)} KB; limit ${Math.round(MAX_NOTE_SHARE_BYTES / 1024)} KB). Trim the content.`,
      },
      { status: 413 }
    );
  }

  let token: string;
  try {
    token =
      typeof raw.reuseToken === "string" && NOTE_SHARE_TOKEN_REGEX.test(raw.reuseToken)
        ? raw.reuseToken
        : newNoteShareToken();
    await putNoteShare(token, payload);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to write share." },
      { status: 500 }
    );
  }

  return Response.json({
    token,
    url: `/share/note/${token}`,
    title,
    summary,
    kind: body.kind,
    expiresAt: payload.expiresAt,
  });
}

function normalizeBody(input: IncomingBody["body"]): SharedNoteBody | null {
  if (!input || typeof input !== "object") return null;
  if (input.kind === "html") {
    const html = typeof input.html === "string" ? input.html : "";
    if (!html.trim()) return null;
    return { kind: "html", html };
  }
  if (input.kind === "markdown") {
    const markdown = typeof input.markdown === "string" ? input.markdown : "";
    if (!markdown.trim()) return null;
    return { kind: "markdown", markdown };
  }
  if (input.kind === "snapshot") {
    const arr = Array.isArray(input.messages) ? input.messages : [];
    const messages = arr
      .map((m) => ({
        role: normalizeRole(m?.role),
        content: typeof m?.content === "string" ? m.content : "",
      }))
      .filter((m) => m.content.trim().length > 0);
    if (messages.length === 0) return null;
    return { kind: "snapshot", messages };
  }
  return null;
}

function normalizeRole(role: unknown): "user" | "assistant" | "system" {
  if (role === "user" || role === "assistant" || role === "system") return role;
  return "assistant";
}

function defaultTitle(body: SharedNoteBody): string {
  if (body.kind === "html") return "Shared artifact";
  if (body.kind === "snapshot") return "Shared chat";
  return "Shared note";
}

function defaultSummary(body: SharedNoteBody): string {
  if (body.kind === "html") return "An HTML artifact pinned from Lasagna.";
  if (body.kind === "snapshot") {
    return `A ${body.messages.length}-message conversation copy from Lasagna.`;
  }
  return "A note pinned from Lasagna.";
}

function sanitizeShortText(input: unknown, max: number): string {
  if (typeof input !== "string") return "";
  return input.replace(/\s+/g, " ").trim().slice(0, max);
}
