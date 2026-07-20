// Debug-only tool runner. Lets the /admin/tools page exercise web_search,
// web_fetch, and image_search and inspect the raw upstream payloads.
//
// image_search now hits the Brave Search Images API directly — no more
// per-page HTML fetch / extractor pipeline. The trace shows the raw Brave
// response alongside the mapped results so the operator can see exactly what
// the model would receive.

import { ollamaClient } from "@/app/lib/ollama/client";
import {
  braveImageSearch,
  BraveConfigError,
  type BraveImage,
} from "@/app/lib/brave/images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_PREVIEW_CHARS = 4000;
const LINKS_PREVIEW_LIMIT = 50;
const HTML_HINT_RE = /<(meta|img|picture|source)\b/i;

type ToolName = "web_search" | "web_fetch" | "image_search";

type FetchResult = { content?: string; links?: string[]; title?: string };

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

function clampMax(raw: unknown, fallback: number, max = 10): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(n)));
}

export async function POST(req: Request) {
  if (!process.env.OLLAMA_API_KEY) {
    return Response.json(
      { error: "OLLAMA_API_KEY is not configured for this deployment." },
      { status: 503 }
    );
  }

  let body: { tool?: ToolName; args?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return badRequest("Body must be JSON.");
  }

  const tool = body.tool;
  const args = body.args ?? {};
  if (tool !== "web_search" && tool !== "web_fetch" && tool !== "image_search") {
    return badRequest(`Unknown tool: ${String(tool)}`);
  }

  const ollama = ollamaClient();
  const startedAt = performance.now();

  try {
    if (tool === "web_search") {
      const query = String(args.query ?? "").trim();
      if (!query) return badRequest("query is required.");
      const maxResults = clampMax(args.max_results ?? args.maxResults, 5);
      const raw = (await ollama.webSearch({ query, maxResults })) as unknown;
      return Response.json({
        tool,
        args: { query, max_results: maxResults },
        durationMs: Math.round(performance.now() - startedAt),
        raw,
      });
    }

    if (tool === "web_fetch") {
      const url = String(args.url ?? "").trim();
      if (!url) return badRequest("url is required.");
      const raw = (await ollama.webFetch({ url })) as FetchResult;
      const content = raw.content ?? "";
      const links = Array.isArray(raw.links) ? raw.links : [];
      return Response.json({
        tool,
        args: { url },
        durationMs: Math.round(performance.now() - startedAt),
        raw,
        contentLength: content.length,
        linksCount: links.length,
        contentLooksLikeHtml: HTML_HINT_RE.test(content),
        contentPreview: content.slice(0, CONTENT_PREVIEW_CHARS),
        contentTruncated: content.length > CONTENT_PREVIEW_CHARS,
        linksPreview: links.slice(0, LINKS_PREVIEW_LIMIT),
        linksTruncated: links.length > LINKS_PREVIEW_LIMIT,
      });
    }

    // image_search — Brave Images API.
    const query = String(args.query ?? "").trim();
    if (!query) return badRequest("query is required.");
    const maxResults = clampMax(args.max_results ?? args.maxResults, 6);

    let images: BraveImage[];
    try {
      images = await braveImageSearch({ query, maxResults });
    } catch (err) {
      if (err instanceof BraveConfigError) {
        return Response.json(
          {
            tool,
            args: { query, max_results: maxResults },
            durationMs: Math.round(performance.now() - startedAt),
            error: err.message,
          },
          { status: 503 }
        );
      }
      throw err;
    }

    return Response.json({
      tool,
      args: { query, max_results: maxResults },
      durationMs: Math.round(performance.now() - startedAt),
      results: images,
      counts: { results: images.length },
    });
  } catch (err) {
    return Response.json(
      {
        tool,
        args,
        durationMs: Math.round(performance.now() - startedAt),
        error: err instanceof Error ? err.message : "Tool execution failed.",
      },
      { status: 500 }
    );
  }
}
