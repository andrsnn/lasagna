// Per-row assistant for a Research app: answer a free-form question about ONE
// row of the table (optionally with web search). Domain-agnostic - it just
// reasons over the row's fields. One LLM call, returns free text. Separate from
// the research engine so it never touches collection.

import { executeQuery } from "@/app/lib/executors";
import { DEFAULT_RESEARCH_MODEL } from "@/app/models";
import { currentDateSystemLine } from "@/app/lib/system-context";
import type { ResearchColumn } from "@/app/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Body = {
  row?: Record<string, unknown>;
  columns?: ResearchColumn[];
  instruction?: string;
  webSearch?: boolean;
  model?: string;
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const row = body.row && typeof body.row === "object" ? body.row : null;
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  if (!row || !instruction) {
    return Response.json({ error: "row and instruction are required." }, { status: 400 });
  }

  const cols =
    Array.isArray(body.columns) && body.columns.length > 0
      ? body.columns
      : Object.keys(row)
          .filter((k) => k !== "id")
          .map((k) => ({ key: k, label: k }) as ResearchColumn);
  const rowDesc = cols
    .map((c) => {
      const v = row[c.key];
      const s = v == null ? "" : String(v).replace(/\s+/g, " ").slice(0, 600);
      return s ? `${c.label}: ${s}` : "";
    })
    .filter(Boolean)
    .join("\n");

  const system =
    `${currentDateSystemLine()}\n\n` +
    "You answer a question about ONE row of a research table. Be concrete and " +
    "specific, grounded in the row's fields (and the web tools if enabled). Do " +
    "NOT invent facts (names, emails, links, numbers) - if you are unsure, say " +
    "what you'd verify and how.";
  const prompt = [`ROW:\n${rowDesc}`, `QUESTION: ${instruction}`].join("\n\n");

  const model = body.model || DEFAULT_RESEARCH_MODEL;
  const outcome = await executeQuery({
    prompt,
    model,
    system,
    webSearch: body.webSearch === true,
  });
  if (outcome.status < 200 || outcome.status >= 300) {
    return Response.json(
      { error: (outcome.payload as { error?: string }).error ?? "Request failed." },
      { status: outcome.status || 500 }
    );
  }
  const answer = (outcome.payload as { text?: string }).text ?? "";
  return Response.json({ answer, model }, { status: 200 });
}
