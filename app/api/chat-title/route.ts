import type { Message as OllamaMessage } from "ollama";
import { chatClientFor } from "@/app/lib/llm/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fixed model: chat titles are short and run once per chat. Clients cannot override.
const MODEL = "gemma4:31b";

const MAX_TITLE_CHARS = 48;

type Body = {
  firstUserMessage?: string;
  firstAssistantSnippet?: string;
  target?: { kind?: string; name?: string };
};

const SYSTEM = `You write concise titles for short chats listed in a sidebar.

Rules:
- Output a single title: 3 to 6 words.
- Sentence case. No quotes. No trailing period.
- Maximum 48 characters.
- Summarize the topic, not the action. Avoid leading verbs like "Discussing", "Asking", "Creating".
- Concrete and specific over generic. Avoid the word "chat".

Output only the title itself.`;

function clip(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function buildUserPrompt(body: Body): string {
  const parts: string[] = [];
  if (body.target?.name && body.target.kind) {
    parts.push(`This chat is about a ${body.target.kind} named "${body.target.name}".`);
  }
  if (body.firstUserMessage?.trim()) {
    parts.push(`User's first message:\n${clip(body.firstUserMessage.trim(), 1200)}`);
  }
  if (body.firstAssistantSnippet?.trim()) {
    parts.push(`Assistant's reply (excerpt):\n${clip(body.firstAssistantSnippet.trim(), 600)}`);
  }
  parts.push("Write the 3-6 word title.");
  return parts.join("\n\n");
}

const PLACEHOLDER_RE = /^\s*(new chat|new artifact|untitled chat|untitled)\s*$/i;

function sanitize(raw: string): string {
  let t = raw.trim();
  // Strip markdown bold/italics/backticks.
  t = t.replace(/[*_`]+/g, "");
  // Strip wrapping quotes.
  t = t.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").trim();
  // First line only.
  t = t.split(/\r?\n/)[0]?.trim() ?? "";
  // Drop trailing punctuation.
  t = t.replace(/[\s.,;:!?-]+$/, "").trim();
  // Collapse whitespace.
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > MAX_TITLE_CHARS) {
    t = t.slice(0, MAX_TITLE_CHARS).replace(/[\s,;:.!?-]+$/, "").trim() + "…";
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

  if (!body.firstUserMessage?.trim()) {
    return Response.json({ error: "firstUserMessage is required." }, { status: 400 });
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
    const title = sanitize(res.message?.content ?? "");
    if (!title) {
      return Response.json({ error: "Empty or placeholder title." }, { status: 502 });
    }
    return Response.json({ title, model: MODEL });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
