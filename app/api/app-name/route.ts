import type { Message as OllamaMessage } from "ollama";
import { chatClientFor } from "@/app/lib/llm/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fixed model: low-cost utility call. Names are 1-3 words so latency matters
// more than reasoning depth. Clients cannot override.
const MODEL = "gemma4:31b";

const MAX_NAME_CHARS = 28;

type ManifestParamLite = { key: string; label?: string; type?: string };

type Body = {
  description?: string;
  notes?: string;
  manifestParams?: ManifestParamLite[];
  codeExcerpt?: string;
};

const SYSTEM = `You name tiny generated apps shown on a tile grid.

Rules:
- Output ONE short name: 1 to 3 words.
- Title Case. No quotes. No trailing punctuation.
- Maximum 28 characters. Shorter is better.
- Describe the function, not the medium. Avoid the words "App", "Artifact", "Tool", "Untitled".
- Concrete and specific over generic.

Output only the name itself.`;

const PLACEHOLDER_RE = /^\s*(untitled|new (artifact|chat)|app|artifact)\s*$/i;

function clip(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function buildUserPrompt(body: Body): string {
  const parts: string[] = [];
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
  parts.push("Write the 1-3 word name.");
  return parts.join("\n\n");
}

function sanitize(raw: string): string {
  let t = raw.trim();
  // Strip markdown bold/italics/backticks the model may add.
  t = t.replace(/[*_`]+/g, "");
  // Strip wrapping quotes.
  t = t.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").trim();
  // Take only the first line.
  t = t.split(/\r?\n/)[0]?.trim() ?? "";
  // Drop trailing punctuation.
  t = t.replace(/[\s.,;:!?-]+$/, "").trim();
  // Collapse internal whitespace.
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > MAX_NAME_CHARS) {
    t = t.slice(0, MAX_NAME_CHARS).replace(/[\s,;:.!?-]+$/, "").trim();
  }
  if (PLACEHOLDER_RE.test(t)) return "";
  return t;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const hasAnything = !!(
    body.description ||
    body.notes ||
    body.codeExcerpt ||
    (body.manifestParams && body.manifestParams.length > 0)
  );
  if (!hasAnything) {
    return Response.json(
      { error: "Need at least one of description/notes/codeExcerpt/manifestParams." },
      { status: 400 }
    );
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
    const name = sanitize(res.message?.content ?? "");
    if (!name) {
      return Response.json({ error: "Empty or placeholder name." }, { status: 502 });
    }
    return Response.json({ name, model: MODEL });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
