import type { Message as OllamaMessage } from "ollama";
import { DEFAULT_MODEL } from "@/app/models";
import { chatClientFor } from "@/app/lib/llm/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  messages?: { role: "user" | "assistant" | "system"; content: string }[];
  noteBody: string;
  noteTitle?: string;
  model?: string;
  runpodEndpointId?: string;
  /** "therapy" swaps in the between-sessions therapist prompt. */
  mode?: "chat" | "therapy";
};

const SYSTEM = `You are updating a running session note for a conversation. The user maintains this note as a living memory across the chat.

You will receive:
1. The current note content (may be empty if this is the first sync)
2. Recent conversation messages

Your job:
- Read the existing note content carefully
- Analyze the recent conversation for key points: decisions made, patterns noticed, questions raised, action items, evolving themes, important facts — whatever is relevant
- Produce an updated version of the note that preserves existing content still relevant and integrates new observations
- Organize naturally with short sections or bullet points as needed
- Be concise but thorough — this note is the user's long-term memory for this conversation

Output ONLY the updated note body. No preamble, no markdown fences, no "Here's the updated note" — just the note content itself.`;

// Therapist mode: the note is the quiet between-sessions memory the
// "therapist" reads before each reply, so it should read like a thoughtful
// practitioner's notes, not meeting minutes.
const THERAPY_SYSTEM = `You are maintaining private between-session notes for an ongoing therapeutic conversation — the kind of notes a thoughtful therapist keeps so the next session starts with context instead of from zero.

You will receive the current notes (possibly empty) and recent conversation messages.

Update the notes to capture, in plain warm language:
- Life situation: the concrete facts of what's going on (work, relationships, health, money, transitions)
- Themes: recurring patterns, beliefs, or dynamics that keep surfacing
- Emotional state: how they seem to be doing, and how that is shifting over time
- What resonates: ideas or reframings that landed, and anything they pushed back on
- Coping and supports: strategies that have helped (or clearly haven't), and people they can lean on
- Threads to follow: open questions or topics worth gently returning to

Guidelines:
- Preserve still-relevant existing notes; integrate new observations rather than restarting
- Refer to the person as "they"
- Be specific but compassionate; no diagnoses, no clinical jargon, no advice
- Keep it under roughly 400 words, organized under the short headings above as needed

Output ONLY the updated note body. No preamble, no markdown fences.`;

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

  if (typeof body.noteBody !== "string") {
    return Response.json({ error: "noteBody must be a string." }, { status: 400 });
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

  const titleLine = body.noteTitle ? ` titled "${body.noteTitle}"` : "";
  const recent = incoming.slice(-50);

  const conv: OllamaMessage[] = [
    { role: "system", content: body.mode === "therapy" ? THERAPY_SYSTEM : SYSTEM },
    {
      role: "user",
      content: `Here is the current session note${titleLine}:\n\n${body.noteBody || "(empty — first sync)"}`,
    },
    {
      role: "assistant",
      content: "I've read the current note. Please show me the recent conversation.",
    },
    {
      role: "user",
      content: `Here are the recent conversation messages:\n\n${recent.map((m) => `[${m.role}] ${m.content}`).join("\n\n")}`,
    },
    {
      role: "user",
      content: "Now produce the updated session note. Output only the note content.",
    },
  ];

  try {
    const res = await llm.chat({ model, messages: conv, stream: false });
    const updatedBody = (res.message?.content ?? "").trim();
    if (!updatedBody) {
      return Response.json({ error: "Empty response." }, { status: 502 });
    }
    return Response.json({ updatedBody, model });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
