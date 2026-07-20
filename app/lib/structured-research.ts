// Server engine for the chat "Structured research" feature.
//
// Wraps the deep-research engine (executeResearch = planner -> parallel web
// sub-agents -> reflection -> structured synthesis) and shapes the output as a
// table of records the in-chat viewer renders. Two extra concerns on top of
// executeResearch:
//   1. Auto-derive display columns + a records JSON schema from the query when
//      the caller doesn't already have one (first run). Re-runs reuse the
//      stored columns so the shape stays stable for append/merge.
//   2. Thread prior record ids/labels into the prompt so a re-run finds NEW
//      items instead of repeating what's already in the table.

import type { Message as OllamaMessage } from "ollama";
import { chatClientFor } from "@/app/lib/llm/router";
import { executeResearch } from "@/app/lib/executors";
import { coerceJson } from "@/app/lib/structured-output";
import { DEFAULT_RESEARCH_MODEL } from "@/app/models";
import { currentDateSystemLine } from "@/app/lib/system-context";
import type { ResearchColumn, ResearchRecord } from "@/app/db";

export type StructuredResearchInput = {
  query: string;
  /** Reused on re-runs so the shape stays stable. Derived on the first run. */
  columns?: ResearchColumn[];
  /** Identity columns, reused on re-runs (derived alongside columns). */
  idKeys?: string[];
  /** Existing rows, so a re-run finds NEW items and assigns non-colliding ids. */
  priorRecords?: ResearchRecord[];
  model?: string;
  /** Coarse progress callback for UI liveness. Best-effort. */
  onProgress?: (stage: string) => void;
  /** Optional user-stop check, polled at stage boundaries. On a hit the run
   *  throws UserStoppedError instead of finishing. */
  shouldStop?: () => boolean | Promise<boolean>;
};

export type StructuredResearchResult = {
  columns: ResearchColumn[];
  idKeys: string[];
  schema: unknown;
  records: ResearchRecord[];
};

const COLUMN_SYSTEM =
  "You design the columns for a research results TABLE and pick its identity. " +
  "Given the user's research request, return JSON: { \"columns\": [ { \"key\": " +
  "string, \"label\": string, \"type\": \"text\"|\"link\"|\"number\" } ], " +
  "\"idKeys\": [string] }. Pick 3-6 columns that capture the concrete data the " +
  "user wants (e.g. company, person, role, link, why). Include a column for EVERY " +
  "distinct data point the user explicitly asks for — if they ask for contacts AND " +
  "open roles AND a way to apply, give a contact column, an open-roles column, and " +
  "an apply/link column; never drop a requested field. Use \"link\" for URL " +
  "columns. `key` is a short snake_case identifier; `label` is a human header. " +
  "`idKeys` is the SUBSET of column keys whose values uniquely identify one row " +
  "(the entity being listed) — e.g. [\"company\"] for companies, [\"name\"," +
  "\"company\"] for people at companies, [\"title\"] for papers/jobs. Choose the " +
  "minimal set that makes each row distinct. Output JSON only.";

const MAX_COLUMNS = 8;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

// Generic, domain-agnostic identity normalization for dedupe/merge: lowercase,
// collapse all non-alphanumerics. Works for any entity type (companies, people,
// papers, jobs) since the identifying COLUMN(S) are chosen dynamically per query
// (idKeys) — we don't hardcode entity-specific rules here.
function normalizeIdentity(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 80);
}

// Models sometimes write research-process meta-commentary INTO a data cell
// ("Specific funding stage not verified in briefs", "Named contact not
// transcribed in briefs", "N/A"). That's noise in a results table — the cell
// should hold the real value or be blank. The synthesis prompt now forbids this,
// but scrub defensively so older/again-misbehaving runs don't surface filler.
const META_SENTENCE =
  /(not\s+\w+[^.;]*\bbriefs?\b|\bbriefs?\b[^.;]*\bnot\s+(transcribed|verified|provided|available|found|listed)|not\s+(transcribed|verified)\b[^.;]*)/i;
const FILLER_TOKEN =
  /^(n\/?a|none(\s+found)?|unknown|undisclosed|not\s+(available|found|specified|provided|listed|disclosed|transcribed|verified)|see\s+(the\s+)?website|tbd|—|-)\.?$/i;

function scrubCell(v: unknown): unknown {
  if (typeof v !== "string") return v;
  let s = v.trim();
  if (!s) return "";
  // Drop sentences that are pure research-process meta-commentary, keeping any
  // real content in the same cell.
  s = s
    .split(/(?<=[.;])\s+/)
    .filter((sentence) => !META_SENTENCE.test(sentence))
    .join(" ")
    .trim();
  if (!s || FILLER_TOKEN.test(s)) return "";
  return s;
}

/** Build a row's identity from the dynamically-chosen identity columns. */
function rowIdentity(
  rec: Record<string, unknown>,
  idKeys: string[]
): string {
  const parts = idKeys
    .map((k) => normalizeIdentity(String(rec[k] ?? "")))
    .filter((p) => p.length > 0);
  return parts.join("|");
}

export type TableShape = { columns: ResearchColumn[]; idKeys: string[] };

const FALLBACK_SHAPE: TableShape = {
  columns: [
    { key: "title", label: "Title", type: "text" },
    { key: "detail", label: "Detail", type: "text" },
    { key: "link", label: "Link", type: "link" },
  ],
  idKeys: ["title"],
};

/** Derive display columns + identity columns from the query (one cheap LLM
 *  call). Falls back to a generic title/detail/link shape if the model
 *  misbehaves. */
async function deriveShape(query: string, model: string): Promise<TableShape> {
  let llm;
  try {
    llm = chatClientFor(model);
  } catch {
    return FALLBACK_SHAPE;
  }
  try {
    const messages: OllamaMessage[] = [
      { role: "system", content: `${currentDateSystemLine()}\n\n${COLUMN_SYSTEM}` },
      { role: "user", content: query },
    ];
    const res = await llm.chat({
      model,
      messages,
      stream: false,
      ...(model.startsWith("gpt-oss") ? {} : { format: "json" }),
    });
    const parsed = coerceJson(res.message?.content ?? "") as
      | {
          columns?: Array<{ key?: unknown; label?: unknown; type?: unknown }>;
          idKeys?: unknown;
        }
      | undefined;
    const raw = parsed && Array.isArray(parsed.columns) ? parsed.columns : null;
    if (!raw || raw.length === 0) return FALLBACK_SHAPE;
    const seen = new Set<string>();
    const cols: ResearchColumn[] = [];
    for (const c of raw) {
      if (cols.length >= MAX_COLUMNS) break;
      const label = typeof c.label === "string" && c.label.trim() ? c.label.trim() : "";
      const key = typeof c.key === "string" && c.key.trim() ? slug(c.key) : slug(label);
      if (!key || !label || seen.has(key)) continue;
      seen.add(key);
      const type =
        c.type === "link" ? "link" : c.type === "number" ? "number" : "text";
      cols.push({ key, label, type });
    }
    if (cols.length === 0) return FALLBACK_SHAPE;
    const idKeys = normalizeIdKeys(parsed?.idKeys, cols);
    return { columns: cols, idKeys };
  } catch {
    return FALLBACK_SHAPE;
  }
}

/** Validate model-chosen idKeys against the real columns; fall back to the first
 *  column when missing/invalid. */
function normalizeIdKeys(raw: unknown, columns: ResearchColumn[]): string[] {
  const valid = new Set(columns.map((c) => c.key));
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const k of raw) {
      const key = typeof k === "string" ? slug(k) : "";
      if (key && valid.has(key) && !out.includes(key)) out.push(key);
    }
  }
  if (out.length === 0 && columns[0]) out.push(columns[0].key);
  return out;
}

/** Build the records-wrapper JSON schema the synthesis must conform to. */
function buildSchema(columns: ResearchColumn[]): unknown {
  const props: Record<string, unknown> = { id: { type: "string" } };
  for (const c of columns) {
    props[c.key] = { type: c.type === "number" ? "number" : "string" };
  }
  return {
    type: "object",
    properties: {
      records: {
        type: "array",
        items: { type: "object", properties: props, required: ["id"] },
      },
    },
    required: ["records"],
  };
}

function priorContext(
  columns: ResearchColumn[],
  idKeys: string[],
  prior: ResearchRecord[]
): string {
  if (!prior || prior.length === 0) return "";
  const keys = idKeys.length > 0 ? idKeys : columns[0] ? [columns[0].key] : [];
  const lines = prior.slice(0, 200).map((r) => {
    const label = keys
      .map((k) => String(r.fields?.[k] ?? "").trim())
      .filter(Boolean)
      .join(" — ");
    return `- ${label || r.id}`;
  });
  return (
    "\n\nThese results are ALREADY in the table - do NOT repeat them. Find NEW, " +
    "distinct items not in this list:\n" +
    lines.join("\n")
  );
}

/**
 * Run one structured-research pass and return columns + schema + records.
 * Long-running (the orchestrator can take minutes); call from a durable
 * producer (Fly worker, or waitUntil for shorter runs).
 */
export async function runStructuredResearch(
  input: StructuredResearchInput
): Promise<StructuredResearchResult> {
  const model =
    typeof input.model === "string" && input.model.length > 0
      ? input.model
      : DEFAULT_RESEARCH_MODEL;
  let columns: ResearchColumn[];
  let idKeys: string[];
  if (input.columns && input.columns.length > 0) {
    columns = input.columns;
    idKeys = normalizeIdKeys(input.idKeys, columns);
  } else {
    input.onProgress?.("Designing result columns…");
    const shape = await deriveShape(input.query, model);
    columns = shape.columns;
    idKeys = shape.idKeys;
  }
  const schema = buildSchema(columns);

  const colDesc = columns
    .map((c) => `- ${c.key} (${c.label}${c.type === "link" ? ", a URL" : ""})`)
    .join("\n");
  const entity = columns[0]?.label ?? "result";
  const idLabels = idKeys
    .map((k) => columns.find((c) => c.key === k)?.label ?? k)
    .join(" + ");
  const prompt =
    `RESEARCH REQUEST:\n${input.query}\n\n` +
    `Return findings as table ROWS. Every row MUST be a real, specific ${entity} ` +
    `you found through web research — an actual real-world entity, not a category ` +
    `or example.\n` +
    `Do NOT create rows about the research process itself: no rows about building, ` +
    `running, automating, scheduling, or tooling for this research (no "DIY research ` +
    `app", "n8n/Make pipeline", "set up Google Alerts", etc.). If the request ` +
    `includes instructions about making the results re-runnable, an "app", a ` +
    `pipeline, or a schedule, IGNORE them — that is handled by the product, not by ` +
    `a result row.\n` +
    `Each row is an object with a stable, unique "id" (a short slug of its ` +
    `identity: ${idLabels}) and these fields:\n${colDesc}\n` +
    `Each row must be a DISTINCT ${idLabels} — never list the same one twice. ` +
    `Use canonical names (no duplicate spellings/legal suffixes for the same ` +
    `entity). Fill every field from real evidence — when a field the user asked ` +
    `for is missing from the briefs, use web_search/web_fetch to find it before ` +
    `emitting the row. Use an empty string ONLY when a value is genuinely ` +
    `unavailable; NEVER write meta-commentary like "not transcribed in briefs", ` +
    `"not verified", or "N/A" into a cell — leave it blank instead. Aim for as ` +
    `many high-quality, distinct rows as the evidence supports.` +
    priorContext(columns, idKeys, input.priorRecords ?? []);

  const outcome = await executeResearch({
    prompt,
    schema,
    model,
    onProgress: input.onProgress,
    shouldStop: input.shouldStop,
  });
  if (outcome.status < 200 || outcome.status >= 300) {
    const err = (outcome.payload as { error?: string }).error;
    throw new Error(err ?? `research failed (${outcome.status})`);
  }
  const json = (outcome.payload as { json?: unknown }).json as
    | { records?: unknown }
    | undefined;
  const rawRecords = json && Array.isArray(json.records) ? json.records : [];

  // Identity is derived from the VALUES of the dynamically-chosen identity
  // columns (idKeys), not the model's arbitrary `id` field, which varies
  // run-to-run and row-to-row for the same entity — the cause of duplicate rows.
  // Same identity → same key → merged (within this batch AND, via the client
  // merge, across re-runs). idKeys adapt to the entity type (company, person,
  // paper, …), so this isn't hardcoded to any one domain.
  const byId = new Map<string, ResearchRecord>();
  const priorIds = new Set((input.priorRecords ?? []).map((r) => r.id));
  let positional = 0;
  for (const r of rawRecords) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const c of columns) fields[c.key] = scrubCell(rec[c.key] ?? "");

    // After scrubbing, a row with no real content anywhere is junk (a fully
    // blank row, or one that was only meta-filler). Drop it rather than render
    // an em-dash-only row — this is what made re-runs look padded/duplicated.
    const hasContent = columns.some((c) => {
      const v = fields[c.key];
      return typeof v === "number" || (typeof v === "string" && v.trim().length > 0);
    });
    if (!hasContent) continue;

    let id = rowIdentity(rec, idKeys);
    if (!id && typeof rec.id === "string") id = normalizeIdentity(rec.id);

    if (!id) {
      // No usable identity (blank name) — keep as a distinct row with a
      // positional id that can't collide with a prior row or this batch.
      positional += 1;
      let candidate = `r${positional}`;
      let n = 2;
      while (priorIds.has(candidate) || byId.has(candidate)) {
        candidate = `r${positional}_${n++}`;
      }
      byId.set(candidate, { id: candidate, fields });
      continue;
    }

    const existing = byId.get(id);
    if (existing) {
      // Same entity twice in one batch — merge, filling blanks rather than
      // emitting a duplicate row.
      const mergedFields = { ...existing.fields };
      for (const [k, v] of Object.entries(fields)) {
        if (v !== "" && v != null) mergedFields[k] = v;
      }
      byId.set(id, { id, fields: mergedFields });
    } else {
      byId.set(id, { id, fields });
    }
  }
  const records: ResearchRecord[] = Array.from(byId.values());

  return { columns, idKeys, schema, records };
}
