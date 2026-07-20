// Draft the prompts for a Multi Research round. Given the chat so far and the
// user's natural-language ask, a single constrained LLM call proposes a small
// set of INDEPENDENT, parallelizable research prompts — each a self-contained
// brief with a short title. The user then reviews/edits them before running.
//
// This is a quick, interactive pre-step (the user is staring at a spinner
// waiting for the prompts to appear), so it's ONE non-streaming call with no
// web tools — the actual web research happens downstream in the report runs.
// Mirrors the research framer's "single constrained call" shape.

import { chatClientFor } from "@/app/lib/llm/router";
import { DEFAULT_RESEARCH_MODEL } from "@/app/models";
import { currentDateSystemLine } from "@/app/lib/system-context";
import { captureException } from "@/app/lib/error-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Keep the fan-out small: parallel deep-research runs are expensive, and the
// review UI stays legible. The model is told to aim for 2; we clamp hard here.
const MAX_REPORTS = 4;
const MIN_REPORTS = 1;
const DRAFT_MAX_ATTEMPTS = 3;

type DraftReport = { title: string; prompt: string; depth?: "standard" | "deep" };

type Body = {
  /** The user's ask that seeded this round (e.g. "research the opportunity and best image model"). */
  intent?: string;
  /** Rendered transcript of the chat so far, for grounding the split. */
  transcript?: string;
  model?: string;
  /** Optional single-report revise: return one improved prompt for this report. */
  revise?: { title: string; prompt: string; instruction: string };
};

const DRAFT_SYSTEM =
  "You are the planner for a MULTI RESEARCH round. The user wants several " +
  "research reports produced IN PARALLEL. Read the chat and the user's ask, " +
  "then split the work into a small set of INDEPENDENT research prompts.\n\n" +
  "Rules:\n" +
  "- Aim for 2 prompts. Use more (up to 4) ONLY if the ask clearly names more " +
  "distinct threads; never pad. Use 1 if the ask is genuinely single-threaded.\n" +
  "- Each prompt must be SELF-CONTAINED: a research analyst should be able to " +
  "run it with zero other context. Bake in the relevant specifics from the " +
  "chat (the product, audience, constraints) — never write 'see above' or 'the " +
  "app we discussed'.\n" +
  "- Prompts must be INDEPENDENT: no prompt should depend on another's output.\n" +
  "- Each prompt should read like a thorough research brief: what to investigate, " +
  "which angles/comparisons to cover, and what a useful answer looks like " +
  "(end each with a concrete deliverable, e.g. a recommendation or a go/no-go).\n" +
  "- `title` is a 2-4 word label for the report card (e.g. 'Business opportunity').\n" +
  "- `depth` is 'deep' for broad/ambiguous investigations, 'standard' for focused ones.\n\n" +
  'Output STRICT JSON only, no prose, no markdown fences: ' +
  '{"rationale":"<one short sentence on the split>","reports":[{"title":"<label>","prompt":"<full brief>","depth":"standard|deep"}]}';

const REVISE_SYSTEM =
  "You are refining ONE research prompt for a Multi Research round. Apply the " +
  "user's instruction and return the improved prompt. Keep it self-contained " +
  "and thorough. Output STRICT JSON only: " +
  '{"title":"<label>","prompt":"<improved brief>","depth":"standard|deep"}';

/** Pull the first JSON object out of a model reply, tolerating stray prose or
 *  code fences some models still emit around structured output. */
function extractJson(raw: string): unknown | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to brace-slice */
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function coerceDepth(v: unknown): "standard" | "deep" {
  return v === "deep" ? "deep" : "standard";
}

function sanitizeReports(value: unknown): DraftReport[] {
  const arr = Array.isArray((value as { reports?: unknown })?.reports)
    ? (value as { reports: unknown[] }).reports
    : Array.isArray(value)
      ? (value as unknown[])
      : [];
  const out: DraftReport[] = [];
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const title = typeof (r as DraftReport).title === "string" ? (r as DraftReport).title.trim() : "";
    const prompt = typeof (r as DraftReport).prompt === "string" ? (r as DraftReport).prompt.trim() : "";
    if (!prompt) continue;
    out.push({
      title: title || `Report ${out.length + 1}`,
      prompt,
      depth: coerceDepth((r as DraftReport).depth),
    });
    if (out.length >= MAX_REPORTS) break;
  }
  return out;
}

async function callModel(model: string, system: string, user: string): Promise<string> {
  const llm = chatClientFor(model);
  const res = await llm.chat({
    model,
    messages: [
      { role: "system", content: `${currentDateSystemLine()}\n\n${system}` },
      { role: "user", content: user },
    ],
    stream: false,
    // gpt-oss models reject the json format flag; describe the shape in the
    // prompt and parse defensively instead (mirrors executeQuery).
    ...(model.startsWith("gpt-oss") ? {} : { format: "json" }),
  });
  return res.message?.content ?? "";
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const model =
    typeof body.model === "string" && body.model.length > 0
      ? body.model
      : DEFAULT_RESEARCH_MODEL;

  try {
    // --- revise: refine a single prompt ---
    if (body.revise) {
      const { title, prompt, instruction } = body.revise;
      const user =
        `Current title: ${title || "(untitled)"}\n\n` +
        `Current prompt:\n${prompt}\n\n` +
        `Instruction: ${instruction || "Improve and tighten this prompt."}\n\n` +
        `Return the improved prompt as STRICT JSON.`;
      let parsed: unknown | null = null;
      for (let i = 0; i < DRAFT_MAX_ATTEMPTS && !parsed; i++) {
        parsed = extractJson(await callModel(model, REVISE_SYSTEM, user));
      }
      const obj = (parsed ?? {}) as DraftReport;
      const nextPrompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
      if (!nextPrompt) {
        return Response.json({ error: "Could not revise the prompt — try again." }, { status: 502 });
      }
      return Response.json(
        {
          title: typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : title,
          prompt: nextPrompt,
          depth: coerceDepth(obj.depth),
        },
        { status: 200 }
      );
    }

    // --- draft: split the ask into parallel prompts ---
    const intent = typeof body.intent === "string" ? body.intent.trim() : "";
    if (!intent) {
      return Response.json({ error: "intent is required." }, { status: 400 });
    }
    const transcript =
      typeof body.transcript === "string" ? body.transcript.slice(0, 12_000) : "";
    const user =
      `=== CHAT SO FAR ===\n${transcript || "(no prior chat)"}\n\n` +
      `=== USER'S ASK ===\n${intent}\n\n` +
      `Draft the parallel research prompts per the system instructions. STRICT JSON only.`;

    let reports: DraftReport[] = [];
    let rationale = "";
    for (let i = 0; i < DRAFT_MAX_ATTEMPTS && reports.length < MIN_REPORTS; i++) {
      const parsed = extractJson(await callModel(model, DRAFT_SYSTEM, user));
      if (parsed) {
        reports = sanitizeReports(parsed);
        const r = (parsed as { rationale?: unknown }).rationale;
        if (typeof r === "string") rationale = r.trim();
      }
    }

    if (reports.length < MIN_REPORTS) {
      // Last-ditch fallback: run the whole ask as a single report so the user
      // still gets something to review rather than a hard failure.
      reports = [{ title: "Research", prompt: intent, depth: "deep" }];
      rationale = rationale || "Ran the ask as a single report — edit or split it below.";
    }

    return Response.json({ rationale, reports, model }, { status: 200 });
  } catch (err) {
    await captureException(err, { source: "query", context: { kind: "multi-research-draft" } });
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to draft prompts." },
      { status: 500 }
    );
  }
}
