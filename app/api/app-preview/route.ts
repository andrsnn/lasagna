import type { Message as OllamaMessage } from "ollama";
import { chatClientFor } from "@/app/lib/llm/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fixed model: tile previews are decorative, not functional. Clients cannot override.
const MODEL = "gemma4:31b";

// Hard ceiling on the persisted html. Gemma occasionally over-elaborates with
// long inline svg gradients; clamp so IndexedDB rows stay small.
const MAX_HTML_BYTES = 8 * 1024;

type ManifestParamLite = { key: string; label?: string; type?: string };

type Body = {
  name?: string;
  description?: string;
  notes?: string;
  manifestParams?: ManifestParamLite[];
  codeExcerpt?: string;
};

const SYSTEM = `You generate tiny decorative HTML hero cards used as thumbnails for generated apps.

Rules:
- Output a single self-contained HTML document. Start with <!doctype html>.
- Inline CSS only. NO <script>. NO fetch. NO imports. NO external URLs of any kind. NO web fonts.
- Total under 4KB.
- The card visually represents what the app DOES — pick colors and a hero element that fit its purpose.
- Center the content. Include the app name and a one-line description.
- Use system fonts (system-ui, ui-serif, ui-monospace).
- No emojis unless the app domain is explicitly playful.

Output only the HTML — no markdown, no fences, no commentary.`;

function clip(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function buildUserPrompt(body: Body): string {
  const parts: string[] = [];
  parts.push(`Name: ${body.name?.trim() || "Untitled"}`);
  if (body.description?.trim()) {
    parts.push(`Description: ${clip(body.description.trim(), 400)}`);
  }
  if (body.notes?.trim()) {
    parts.push(`Project notes (excerpt):\n${clip(body.notes.trim(), 1200)}`);
  }
  if (body.manifestParams && body.manifestParams.length > 0) {
    const labels = body.manifestParams
      .map((p) => p.label || p.key)
      .filter(Boolean)
      .slice(0, 8)
      .join(", ");
    if (labels) parts.push(`Inputs: ${labels}`);
  }
  if (body.codeExcerpt?.trim()) {
    parts.push(`Code excerpt:\n${clip(body.codeExcerpt.trim(), 1200)}`);
  }
  parts.push("Write the HTML hero card.");
  return parts.join("\n\n");
}

const FORBIDDEN_RE = /<script\b|on\w+\s*=|fetch\s*\(|\bimport\s|https?:\/\/|src\s*=\s*["']?[^"'>\s]+\.(js|mjs)/i;

function sanitize(raw: string): string | null {
  let html = raw.trim();
  // Strip markdown fences.
  html = html.replace(/^```(?:html|HTML)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  html = html.trim();
  if (!html) return null;
  // Reject anything that contains scripts, event handlers, network calls, or external URLs.
  if (FORBIDDEN_RE.test(html)) return null;
  // Ensure a doctype shell.
  if (!/^<!doctype/i.test(html)) {
    if (/^<html/i.test(html)) {
      html = `<!doctype html>\n${html}`;
    } else {
      html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${html}</body></html>`;
    }
  }
  // Hard byte clamp (UTF-8 length is overestimated by .length but close enough for our limits).
  if (html.length > MAX_HTML_BYTES) return null;
  return html;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const hasAnything = !!(
    body.name ||
    body.description ||
    body.notes ||
    body.codeExcerpt
  );
  if (!hasAnything) {
    return Response.json({ error: "Need at least one of name/description/notes/codeExcerpt." }, { status: 400 });
  }

  let llm;
  try {
    llm = chatClientFor(MODEL);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "LLM provider unavailable" },
      { status: 500 }
    );
  }

  const conv: OllamaMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: buildUserPrompt(body) },
  ];

  try {
    const res = await llm.chat({ model: MODEL, messages: conv, stream: false });
    const html = sanitize(res.message?.content ?? "");
    if (!html) {
      return Response.json({ error: "Rejected or empty preview." }, { status: 502 });
    }
    return Response.json({ html, model: MODEL });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
