import type { Message as OllamaMessage } from "ollama";
import { DEFAULT_MODEL } from "@/app/models";
import { chatClientFor } from "@/app/lib/llm/router";
import { SUMMARIZE_SYSTEM } from "@/app/lib/llm/summarize-prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  messages?: { role: "user" | "assistant" | "system"; content: string }[];
  model?: string;
  /** Forwarded to the RunPod adapter when `model` resolves to that provider. */
  runpodEndpointId?: string;
};

const SYSTEM = SUMMARIZE_SYSTEM;

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const incoming = body.messages;
  if (!Array.isArray(incoming) || incoming.length === 0) {
    return Response.json({ error: "messages must be a non-empty array." }, { status: 400 });
  }

  const model = typeof body.model === "string" && body.model.length > 0 ? body.model : DEFAULT_MODEL;

  const runpodEndpointId =
    typeof body.runpodEndpointId === "string" && body.runpodEndpointId.trim()
      ? body.runpodEndpointId.trim()
      : undefined;

  let llm;
  try {
    llm = chatClientFor(model, { runpodEndpointId });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "LLM provider unavailable" },
      { status: 500 }
    );
  }

  const conv: OllamaMessage[] = [
    { role: "system", content: SYSTEM },
    ...incoming.map((m) => ({ role: m.role, content: m.content })),
    {
      role: "user",
      content:
        "Please summarize the conversation above. Output only the summary, no preamble.",
    },
  ];

  try {
    const res = await llm.chat({ model, messages: conv, stream: false });
    const summary = (res.message?.content ?? "").trim();
    if (!summary) {
      return Response.json({ error: "Empty summary." }, { status: 502 });
    }
    return Response.json({ summary, model });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
