// POST /api/annotate
//
// Backs the highlight-to-research feature in the chat UI. The user highlights
// a passage in a chat message, asks a follow-up, and we route the question
// through Gemma 4 31B with the passage as context. The client persists the
// returned `result` onto a MessageAnnotation and seeds a child chat with the
// same Q/A pair so the user can continue researching.

import type { Message as OllamaMessage } from "ollama";
import { chatClientFor } from "@/app/lib/llm/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const RESEARCH_MODEL = "gemma4:31b";

const SYSTEM = `You are a research assistant. The user highlighted a passage from a chat conversation and asked a follow-up question about it. Answer concisely and helpfully.

- Quote or reference the passage when it clarifies your answer.
- If the user asks for a link, return one concrete URL plus a short caption — pick the single best source.
- If you don't know, say so plainly; do not invent facts.
- Markdown is fine; keep responses tight (under ~200 words unless the question demands more).`;

type Body = {
  selectedText?: string;
  prompt?: string;
  runpodEndpointId?: string;
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const selectedText = typeof body.selectedText === "string" ? body.selectedText.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!selectedText) {
    return Response.json({ error: "selectedText is required." }, { status: 400 });
  }
  if (!prompt) {
    return Response.json({ error: "prompt is required." }, { status: 400 });
  }

  const runpodEndpointId =
    typeof body.runpodEndpointId === "string" && body.runpodEndpointId.trim()
      ? body.runpodEndpointId.trim()
      : undefined;

  let llm;
  try {
    llm = chatClientFor(RESEARCH_MODEL, { runpodEndpointId });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "LLM provider unavailable" },
      { status: 500 }
    );
  }

  const passage = selectedText.length > 4000 ? selectedText.slice(0, 4000) + "…" : selectedText;
  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `Passage:\n> ${passage.replace(/\n/g, "\n> ")}\n\nQuestion: ${prompt}`,
    },
  ];

  try {
    const res = await llm.chat({ model: RESEARCH_MODEL, messages, stream: false });
    const result = (res.message?.content ?? "").trim();
    if (!result) {
      return Response.json({ error: "Empty response from research model." }, { status: 502 });
    }
    return Response.json({ result, model: RESEARCH_MODEL });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
