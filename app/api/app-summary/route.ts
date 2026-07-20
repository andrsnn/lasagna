import type { Message as OllamaMessage } from "ollama";
import { chatClientFor } from "@/app/lib/llm/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fixed model: this is a low-cost utility call and Gemma 4 31B handles short
// taglines well. Clients cannot override.
const MODEL = "gemma4:31b";

const MAX_TAGLINE_CHARS = 80;

type ManifestParamLite = { key: string; label?: string; type?: string };

type Body = {
  name?: string;
  designerName?: string;
  description?: string;
  notes?: string;
  manifestParams?: ManifestParamLite[];
};

const SYSTEM = `You write one-sentence taglines for tiny generated apps shown on a tile grid.

Rules:
- Output ONE sentence, present tense, concrete.
- No quotes, no preamble, no trailing period if it fits without one.
- Maximum 80 characters. Shorter is better.
- Describe what the app DOES, not what it IS. Avoid the word "app".
- Lowercase except for proper nouns and the first letter.

Output only the tagline itself.`;

function clip(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function buildUserPrompt(body: Body): string {
  const parts: string[] = [];
  parts.push(`Name: ${body.name?.trim() || body.designerName?.trim() || "Untitled"}`);
  if (body.designerName && body.designerName.trim() !== body.name?.trim()) {
    parts.push(`Designer: ${body.designerName.trim()}`);
  }
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
  parts.push("Write the one-sentence tagline.");
  return parts.join("\n\n");
}

function sanitize(raw: string): string {
  let t = raw.trim();
  // Strip wrapping quotes if the model added any.
  t = t.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").trim();
  // Collapse newlines / extra whitespace.
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > MAX_TAGLINE_CHARS) {
    t = t.slice(0, MAX_TAGLINE_CHARS).replace(/[\s,;:.!?-]+$/, "").trim() + "…";
  }
  return t;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const hasAnything = !!(body.name || body.designerName || body.description || body.notes);
  if (!hasAnything) {
    return Response.json({ error: "Need at least one of name/description/notes." }, { status: 400 });
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
    const tagline = sanitize(res.message?.content ?? "");
    if (!tagline) {
      return Response.json({ error: "Empty tagline." }, { status: 502 });
    }
    return Response.json({ tagline, model: MODEL });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
