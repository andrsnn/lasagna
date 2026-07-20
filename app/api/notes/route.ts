import type { Message as OllamaMessage } from "ollama";
import { DEFAULT_MODEL } from "@/app/models";
import { chatClientFor } from "@/app/lib/llm/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LINES = 500;

type RecentCommit = {
  version: number;
  commitMessage?: string;
  savedAt: number;
};

type Body = {
  model?: string;
  designerName?: string;
  designerDescription?: string;
  currentNotes?: string;
  recentCommits?: RecentCommit[];
  chatMessages?: { role: "user" | "assistant" | "system"; content: string }[];
  /** Forwarded to the RunPod adapter when `model` resolves to that provider. */
  runpodEndpointId?: string;
  /**
   * Optional one-line instruction appended to the user prompt before the
   * trailing "Update the notes file" line. Used by the send-to-notes flow to
   * tell the model the chat content is supplementary research, not the build
   * chat. Keeps the SYSTEM prompt stable across call sites.
   */
  mergeHint?: string;
};

const SYSTEM = `You maintain a CLAUDE.md project notes file for an app under iterative AI-assisted development. Output ONLY the updated notes file. No preamble, no "Here is the updated notes" — just the file contents.

REQUIRED SECTIONS, in this order:
# {App Name}
## Purpose
2-4 sentences: what this app does and who it's for.
## Architecture
Bullets: key files, data flow, external deps. Reference paths when helpful.
## Core Decisions
Dated bullets: non-obvious tradeoffs the team has committed to. Keep load-bearing decisions even if old.
## Recent Changes
Last 5-10 commits as terse dated bullets.

RULES:
- HARD CAP: 500 lines total. Compress aggressively.
- Merge new info from this chat into the existing notes; supersede outdated entries.
- Drop entries that have been fully replaced.
- No code blocks longer than 8 lines. Paraphrase, don't quote.
- No emoji. No "I" voice. Plain prose.
- Dates use ISO format (YYYY-MM-DD).`;

const COMPRESS_SYSTEM = `You are pruning a project notes file that exceeds its 500-line budget. Compress it to <= 500 lines while preserving the four sections (Purpose, Architecture, Core Decisions, Recent Changes) and every load-bearing decision. Drop redundant or outdated entries first. Output ONLY the pruned notes file, no preamble.`;

function lineCount(s: string): string {
  return String(s.split("\n").length);
}

function tooLong(s: string): boolean {
  return s.split("\n").length > MAX_LINES;
}

function hardTruncate(s: string): string {
  const lines = s.split("\n");
  if (lines.length <= MAX_LINES) return s;
  return lines.slice(0, MAX_LINES - 1).join("\n") + "\n<!-- truncated -->";
}

function buildUserPrompt(body: Body): string {
  const today = new Date().toISOString().slice(0, 10);
  const parts: string[] = [];
  parts.push(`Today's date: ${today}.`);
  parts.push(`App name: ${body.designerName ?? "(unnamed)"}`);
  if (body.designerDescription) {
    parts.push(`App description: ${body.designerDescription}`);
  }
  parts.push("");
  parts.push("=== CURRENT NOTES ===");
  parts.push(body.currentNotes?.trim() || "(empty — this is the first update)");
  parts.push("");
  if (body.recentCommits && body.recentCommits.length) {
    parts.push("=== RECENT COMMITS (newest first) ===");
    for (const c of body.recentCommits) {
      const when = new Date(c.savedAt).toISOString().slice(0, 10);
      parts.push(`- v${c.version} (${when}): ${c.commitMessage ?? "(no message)"}`);
    }
    parts.push("");
  }
  if (body.chatMessages && body.chatMessages.length) {
    parts.push("=== JUST-FINISHED CHAT (oldest first) ===");
    for (const m of body.chatMessages) {
      parts.push(`[${m.role}] ${m.content}`);
      parts.push("");
    }
  }
  if (body.mergeHint && body.mergeHint.trim()) {
    parts.push(body.mergeHint.trim());
    parts.push("");
  }
  parts.push(
    "Update the notes file. Merge anything new from the chat and the recent commits into the existing sections. Drop superseded entries. Output ONLY the updated notes file."
  );
  return parts.join("\n");
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.designerName || typeof body.designerName !== "string") {
    return Response.json({ error: "designerName is required." }, { status: 400 });
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

  try {
    const conv: OllamaMessage[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: buildUserPrompt(body) },
    ];
    const res = await llm.chat({ model, messages: conv, stream: false });
    let notes = (res.message?.content ?? "").trim();
    if (!notes) {
      return Response.json({ error: "Empty notes." }, { status: 502 });
    }

    // 500-line cap. One compress retry, then hard truncate.
    if (tooLong(notes)) {
      const compress: OllamaMessage[] = [
        { role: "system", content: COMPRESS_SYSTEM },
        {
          role: "user",
          content: `The current notes file is ${lineCount(notes)} lines, over the 500-line cap. Compress it.\n\n${notes}`,
        },
      ];
      const second = await llm.chat({ model, messages: compress, stream: false });
      const pruned = (second.message?.content ?? "").trim();
      if (pruned) notes = pruned;
    }
    if (tooLong(notes)) notes = hardTruncate(notes);

    return Response.json({ notes, model, lines: notes.split("\n").length });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
