// AI sort/rank pass for a Research app. Takes the already-collected rows and a
// ranking criterion, asks the model to order them, and returns { order: [ids] }.
// This is intentionally SEPARATE from the research engine: it never collects or
// changes data, it only reorders existing rows - so it can't break a manual or
// scheduled research run.

import { executeQuery } from "@/app/lib/executors";
import { currentDateSystemLine } from "@/app/lib/system-context";
import type { ResearchColumn } from "@/app/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Body = {
  records?: Array<Record<string, unknown>>;
  columns?: ResearchColumn[];
  instruction?: string;
  model?: string;
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const records = Array.isArray(body.records) ? body.records : [];
  const columns = Array.isArray(body.columns) ? body.columns : [];
  if (records.length === 0) return Response.json({ order: [] }, { status: 200 });
  if (records.length === 1) {
    return Response.json({ order: [String(records[0].id ?? "")] }, { status: 200 });
  }

  const instruction =
    typeof body.instruction === "string" && body.instruction.trim()
      ? body.instruction.trim()
      : "overall best / most promising first";

  // Compact each row to id + the ranking-SIGNAL columns only (name + tier /
  // stage / fit / reward / equity / risk …), each short. A full multi-column
  // dump made the prompt huge and the call timed out (504) on big tables, so the
  // sort never reordered. Keeping it lean returns fast.
  const allCols: ResearchColumn[] =
    columns.length > 0
      ? columns
      : Object.keys(records[0] ?? {})
          .filter((k) => k !== "id")
          .map((k) => ({ key: k, label: k }));
  const signal = /tier|stage|fit|reason|why|reward|equity|comp|risk|raise|fund|valuation|score|rank|priorit|name|company/i;
  const chosen = allCols.filter((c, i) => i === 0 || signal.test(c.key) || signal.test(c.label)).slice(0, 7);
  const lines = records.slice(0, 200).map((r) => {
    const id = String(r.id ?? "");
    const parts = chosen
      .map((c) => {
        const v = r[c.key];
        const s = v == null ? "" : String(v).replace(/\s+/g, " ").slice(0, 110);
        return s ? `${c.label}: ${s}` : "";
      })
      .filter(Boolean)
      .join(" | ");
    return `${id} :: ${parts}`;
  });

  const ids = records.map((r) => String(r.id ?? ""));
  const schema = {
    type: "object",
    properties: { order: { type: "array", items: { type: "string" } } },
    required: ["order"],
  };
  const system =
    `${currentDateSystemLine()}\n\n` +
    "You rank a list of items. You are given rows as `id :: fields` and a " +
    "ranking criterion. Return JSON { \"order\": [ids] } listing EVERY id " +
    "exactly once, best-first by the criterion. Use only the ids given. Output JSON only.";
  const prompt =
    `RANKING CRITERION: ${instruction}\n\n` +
    `Rank these ${records.length} rows best-first. Return every id exactly once.\n\n` +
    lines.join("\n");

  // Ranking is a fast mechanical reorder over short summaries - use a fast
  // model by default (the heavy research model thinks for minutes and times
  // out). Honor an explicit override if the caller insists.
  const model = body.model || "gpt-oss:120b";
  const outcome = await executeQuery({ prompt, schema, model, system, webSearch: false });
  if (outcome.status < 200 || outcome.status >= 300) {
    return Response.json(
      { error: (outcome.payload as { error?: string }).error ?? "Rank failed." },
      { status: outcome.status || 500 }
    );
  }
  const json = (outcome.payload as { json?: unknown }).json as { order?: unknown } | undefined;
  const rawOrder = json && Array.isArray(json.order) ? json.order : [];

  // Validate: keep only known ids, dedupe, then append any the model dropped so
  // no row ever disappears from the table.
  const known = new Set(ids);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const v of rawOrder) {
    const id = String(v);
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  for (const id of ids) if (!seen.has(id)) order.push(id);

  return Response.json({ order, model }, { status: 200 });
}
