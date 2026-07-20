import type {
  ArtifactEntrySource,
  ArtifactFiles,
  ArtifactManifest,
  ArtifactStateEntryConfig,
  ArtifactWidgetManifest,
  BuildIssue,
  ManifestParam,
  ScheduledTask,
  WidgetSizePreset,
} from "@/app/db";
import { parseCron } from "@/app/lib/cron-eval";
import { templateParamKeys } from "@/app/lib/artifact/merge-engine";

export type ParseResult = { manifest: ArtifactManifest | null };

const VALID_WIDGET_SIZES = new Set<WidgetSizePreset>(["S", "M", "L", "W"]);
const WIDGET_ENTRY_EXT_RE = /\.(tsx|ts|jsx|js)$/;
const DEFAULT_WIDGET_ENTRY = "Widget.tsx";

/**
 * Single source of truth for "does this artifact have a widget?". Returns the
 * resolved widget entry path (relative to the VFS root), or null if no
 * widget is defined or its declared file doesn't exist.
 *
 * Detection rules:
 *   1. If `manifest.widget.entry` is declared AND the file exists → use it.
 *   2. Else if `Widget.tsx` exists at the VFS root → use that.
 *   3. Else null.
 */
export function detectWidgetEntry(
  files: ArtifactFiles,
  manifest: ArtifactManifest | null
): string | null {
  const declared = manifest?.widget?.entry;
  if (declared && Object.prototype.hasOwnProperty.call(files, declared)) {
    return declared;
  }
  if (Object.prototype.hasOwnProperty.call(files, DEFAULT_WIDGET_ENTRY)) {
    return DEFAULT_WIDGET_ENTRY;
  }
  return null;
}

const MANIFEST_RE =
  /<script\b[^>]*type=["']application\/artifact-manifest["'][^>]*>([\s\S]*?)<\/script>/i;

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const VALID_TYPES = new Set(["string", "number", "boolean", "enum", "model"]);

export function parseManifest(html: string): ParseResult {
  const match = html.match(MANIFEST_RE);
  if (!match) return { manifest: null };
  const raw = match[1].trim();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { manifest: null };
  }
  return { manifest: repairManifest(json) };
}

/** Multi-file manifest extraction: prefer manifest.json, fall back to a script block in the entry HTML. */
export function parseManifestFromVfs(files: ArtifactFiles, entry: string): ParseResult {
  const json = files["manifest.json"];
  if (typeof json === "string" && json.trim().length > 0) {
    try {
      return { manifest: repairManifest(JSON.parse(json)) };
    } catch {
      // Bad JSON → fall through to the entry HTML; if that also fails we just
      // surface a null manifest and the caller keeps the prior name.
    }
  }
  const html = files[entry] ?? files["index.html"];
  if (typeof html === "string") return parseManifest(html);
  return { manifest: null };
}

/**
 * Tolerant manifest reader. Coerces or drops bad fields rather than rejecting,
 * so an LLM-generated manifest with a stray hyphen, missing label, or unknown
 * type still yields a usable manifest. The caller never sees a validation
 * error — the artifact just keeps building.
 */
function repairManifest(input: unknown): ArtifactManifest | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const name =
    typeof obj.name === "string" && obj.name.trim().length > 0
      ? obj.name.trim()
      : "Untitled artifact";
  const description = typeof obj.description === "string" ? obj.description : undefined;
  const rawParams = Array.isArray(obj.params) ? obj.params : [];
  const params: ManifestParam[] = [];
  const usedKeys = new Set<string>();
  for (const [i, raw] of rawParams.entries()) {
    const repaired = repairParam(raw, i, usedKeys);
    if (repaired) {
      usedKeys.add(repaired.key);
      params.push(repaired);
    }
  }
  let refresh: ArtifactManifest["refresh"];
  if (obj.refresh && typeof obj.refresh === "object") {
    const min = (obj.refresh as Record<string, unknown>).minIntervalSeconds;
    if (typeof min === "number" && min >= 0) {
      refresh = { minIntervalSeconds: min };
    }
  }
  // Tolerate `schedules: [task]` arrays from older drafts — pluck the first
  // entry so a stray array shape doesn't drop the whole schedule.
  let scheduleInput = obj.schedule;
  if (scheduleInput === undefined && Array.isArray(obj.schedules) && obj.schedules.length > 0) {
    scheduleInput = obj.schedules[0];
  }
  const schedule = scheduleInput ? repairSchedule(scheduleInput) : undefined;
  const widget = obj.widget ? repairWidget(obj.widget) : undefined;
  const state = obj.state ? repairStateConfig(obj.state) : undefined;
  return { name, description, params, refresh, schedule, widget, state };
}

/**
 * Tolerant reader for the v2 declared-data block. Drops unusable entries
 * rather than rejecting, mirroring repairManifest's philosophy: a half-broken
 * manifest never bricks the app at save time. The strict counterpart
 * (validateStateStrict) surfaces the same problems to the model at Build time.
 */
function repairStateConfig(
  raw: unknown
): Record<string, ArtifactStateEntryConfig> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, ArtifactStateEntryConfig> = {};
  let scheduledSeen = false;
  for (const [rawKey, rawEntry] of Object.entries(raw as Record<string, unknown>)) {
    const key = KEY_RE.test(rawKey) ? rawKey : slugifyKey(rawKey);
    if (!key || !rawEntry || typeof rawEntry !== "object") continue;
    const e = rawEntry as Record<string, unknown>;
    if (e.kind === "value") {
      out[key] = { kind: "value", default: e.default };
      continue;
    }
    if (e.kind !== "collection") continue;
    const entry: ArtifactStateEntryConfig = { kind: "collection" };
    if (e.schema && typeof e.schema === "object") entry.schema = e.schema;
    if (Array.isArray(e.identity)) {
      const ids = e.identity.filter((k): k is string => typeof k === "string" && k.length > 0);
      if (ids.length > 0) entry.identity = ids;
    }
    if (e.merge === "upsert" || e.merge === "replace" || e.merge === "append") {
      entry.merge = e.merge;
    }
    if (e.retain && typeof e.retain === "object") {
      const dateKey = (e.retain as Record<string, unknown>).dateKey;
      if (typeof dateKey === "string" && dateKey.length > 0) entry.retain = { dateKey };
    }
    const source = repairEntrySource(e.source);
    if (source) {
      // One schedule per app: keep the first scheduled source, strip the rest.
      if (source.refresh?.schedule && scheduledSeen) {
        source.refresh = { ...source.refresh, schedule: undefined };
      }
      if (source.refresh?.schedule) scheduledSeen = true;
      entry.source = source;
    }
    out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function repairEntrySource(raw: unknown): ArtifactEntrySource | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  if (s.type !== undefined && s.type !== "query") return undefined;
  const prompt = typeof s.prompt === "string" ? s.prompt.trim() : "";
  if (!prompt) return undefined;
  const out: ArtifactEntrySource = { type: "query", prompt };
  if (typeof s.system === "string" && s.system.trim()) out.system = s.system.trim();
  if (typeof s.webSearch === "boolean") out.webSearch = s.webSearch;
  if (typeof s.research === "boolean") out.research = s.research;
  if (typeof s.mcp === "boolean") out.mcp = s.mcp;
  if (s.refresh && typeof s.refresh === "object") {
    const r = s.refresh as Record<string, unknown>;
    const refresh: NonNullable<ArtifactEntrySource["refresh"]> = {};
    if (typeof r.user === "boolean") refresh.user = r.user;
    if (typeof r.schedule === "string" && parseCron(r.schedule).ok) {
      refresh.schedule = r.schedule;
    }
    if (refresh.user !== undefined || refresh.schedule !== undefined) out.refresh = refresh;
  }
  return out;
}

function repairWidget(raw: unknown): ArtifactWidgetManifest | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const w = raw as Record<string, unknown>;
  const out: ArtifactWidgetManifest = {};
  if (typeof w.entry === "string" && w.entry.trim().length > 0) {
    out.entry = w.entry.trim();
  } else {
    out.entry = DEFAULT_WIDGET_ENTRY;
  }
  if (
    typeof w.defaultSize === "string" &&
    VALID_WIDGET_SIZES.has(w.defaultSize as WidgetSizePreset)
  ) {
    out.defaultSize = w.defaultSize as WidgetSizePreset;
  }
  if (Array.isArray(w.supportedSizes)) {
    const filtered = (w.supportedSizes as unknown[]).filter(
      (s): s is WidgetSizePreset =>
        typeof s === "string" && VALID_WIDGET_SIZES.has(s as WidgetSizePreset)
    );
    if (filtered.length > 0) out.supportedSizes = filtered;
  }
  return out;
}

function repairSchedule(raw: unknown): ScheduledTask | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  const cron = typeof s.cron === "string" ? s.cron : "";
  if (!cron) return undefined;
  const parsed = parseCron(cron);
  if (!parsed.ok) return undefined;
  const type = s.type === "fetch" ? "fetch" : s.type === "query" ? "query" : null;
  if (!type) return undefined;
  if (type === "query") {
    const prompt = typeof s.prompt === "string" ? s.prompt.trim() : "";
    if (!prompt) return undefined;
    const tools = Array.isArray(s.tools)
      ? (s.tools.filter((t) => t === "web_search" || t === "web_fetch") as ("web_search" | "web_fetch")[])
      : undefined;
    return {
      cron,
      type: "query",
      prompt,
      schema: s.schema,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: typeof s.model === "string" && s.model.length > 0 ? s.model : undefined,
    };
  }
  // fetch
  const url = typeof s.url === "string" ? s.url.trim() : "";
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  let init: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
  if (s.init && typeof s.init === "object") {
    const i = s.init as Record<string, unknown>;
    const headers =
      i.headers && typeof i.headers === "object"
        ? (Object.fromEntries(
            Object.entries(i.headers as Record<string, unknown>).filter(
              ([, v]) => typeof v === "string"
            )
          ) as Record<string, string>)
        : undefined;
    init = {
      method: typeof i.method === "string" ? i.method : undefined,
      headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
      body: typeof i.body === "string" ? i.body : undefined,
    };
  }
  return { cron, type: "fetch", url, init };
}

function slugifyKey(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[^a-zA-Z]+/, "");
  return cleaned;
}

function uniqueKey(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}_${used.size + 1}`;
}

function repairParam(
  raw: unknown,
  index: number,
  used: Set<string>
): ManifestParam | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const labelStr =
    typeof p.label === "string" && p.label.trim().length > 0 ? p.label.trim() : "";
  let key = typeof p.key === "string" && KEY_RE.test(p.key) ? p.key : "";
  if (!key && typeof p.key === "string") key = slugifyKey(p.key);
  if (!key && labelStr) key = slugifyKey(labelStr);
  if (!key) key = `param_${index + 1}`;
  key = uniqueKey(key, used);
  const label = labelStr || key;
  const type = typeof p.type === "string" && VALID_TYPES.has(p.type) ? p.type : "string";

  switch (type) {
    case "number":
      return {
        key,
        type: "number",
        label,
        required: p.required === true,
        default: typeof p.default === "number" ? p.default : undefined,
        min: typeof p.min === "number" ? p.min : undefined,
        max: typeof p.max === "number" ? p.max : undefined,
      };
    case "boolean":
      return {
        key,
        type: "boolean",
        label,
        default: typeof p.default === "boolean" ? p.default : undefined,
      };
    case "enum": {
      const opts = Array.isArray(p.options)
        ? p.options.filter((o): o is string => typeof o === "string")
        : [];
      // Enum without usable options collapses to a free-text string so the
      // param still works instead of disappearing.
      if (opts.length === 0) {
        return {
          key,
          type: "string",
          label,
          required: p.required === true,
          default: typeof p.default === "string" ? p.default : undefined,
          placeholder: typeof p.placeholder === "string" ? p.placeholder : undefined,
        };
      }
      return {
        key,
        type: "enum",
        label,
        options: opts,
        required: p.required === true,
        default:
          typeof p.default === "string" && opts.includes(p.default) ? p.default : undefined,
      };
    }
    case "model":
      return {
        key,
        type: "model",
        label,
        required: p.required === true,
        default: typeof p.default === "string" ? p.default : undefined,
      };
    case "string":
    default:
      return {
        key,
        type: "string",
        label,
        required: p.required === true,
        default: typeof p.default === "string" ? p.default : undefined,
        placeholder: typeof p.placeholder === "string" ? p.placeholder : undefined,
      };
  }
}

/**
 * Strict manifest validation for the build pipeline. Returns a list of issues
 * so the build can fail and the LLM auto-corrects (same loop it already runs
 * for esbuild errors). Empty array = manifest is fine OR there is no manifest
 * at all (which is allowed — chat-mode HTML deliberately omits one).
 *
 * The user-facing save path uses repairManifest() so a half-broken manifest
 * never blocks the app; this function is only for surfacing problems to the
 * model.
 */
export function diagnoseManifest(files: ArtifactFiles, entry: string): BuildIssue[] {
  const jsonText = files["manifest.json"];
  if (typeof jsonText === "string" && jsonText.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      return [issue("manifest.json", `manifest.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)];
    }
    return [
      ...validateStrict(parsed, "manifest.json"),
      ...diagnoseWidgetExport(files, parsed),
      ...diagnoseEntryKeyRefs(files, parsed),
    ];
  }
  const html = files[entry] ?? files["index.html"];
  if (typeof html !== "string") return [];
  const match = html.match(MANIFEST_RE);
  if (!match) return [];
  const file = files[entry] !== undefined ? entry : "index.html";
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch (err) {
    return [issue(file, `<script type="application/artifact-manifest"> body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)];
  }
  return [
    ...validateStrict(parsed, file),
    ...diagnoseWidgetExport(files, parsed),
    ...diagnoseEntryKeyRefs(files, parsed),
  ];
}

// Matches the entry key literal in useArtifact("k"), useArtifactValue("k"),
// and artifact.entries.get/watch/update/refresh("k").
const ENTRY_KEY_REF_RE =
  /(?:useArtifact(?:Value)?|entries\s*\.\s*(?:get|watch|update|refresh))\s*\(\s*(["'`])([^"'`]+)\1/g;

/**
 * Cross-check every entry key the CODE references against the keys the
 * manifest DECLARES. A mismatch (useArtifact("concerts") vs manifest.state
 * declaring "events") compiles fine and then fails silently at runtime -
 * refresh() rejects, data never appears, and the button "does nothing".
 * Failing the Build with the exact key list turns that dead end into a
 * one-edit fix inside the model's own loop.
 */
function diagnoseEntryKeyRefs(files: ArtifactFiles, parsedManifest: unknown): BuildIssue[] {
  const state =
    parsedManifest && typeof parsedManifest === "object"
      ? (parsedManifest as Record<string, unknown>).state
      : undefined;
  if (!state || typeof state !== "object" || Array.isArray(state)) return [];
  const declared = new Set(Object.keys(state as Record<string, unknown>));
  if (declared.size === 0) return [];
  const out: BuildIssue[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (!/\.(tsx?|jsx?|html)$/.test(path) || typeof content !== "string") continue;
    for (const m of content.matchAll(ENTRY_KEY_REF_RE)) {
      const key = m[2];
      if (declared.has(key)) continue;
      // `update` may legitimately write undeclared scratch keys via raw
      // state semantics; everything else must reference a declared entry.
      out.push(
        issue(
          path,
          `References entry "${key}" (${m[0].split("(")[0].trim()}), but manifest.state declares: ${[...declared].join(", ")}. Entry keys must match the manifest exactly.`
        )
      );
    }
  }
  return out;
}

/**
 * Soft-check that the resolved widget file looks like it has a default export.
 * Surfaces a clearer build issue than the synthesized harness's import error
 * does. Pattern matches `export default …` and `export { Foo as default }`.
 */
function diagnoseWidgetExport(files: ArtifactFiles, parsedManifest: unknown): BuildIssue[] {
  if (!parsedManifest || typeof parsedManifest !== "object") return [];
  const w = (parsedManifest as Record<string, unknown>).widget;
  // Same precedence as detectWidgetEntry — resolve through the manifest first.
  let entry: string | undefined;
  if (w && typeof w === "object") {
    const raw = (w as Record<string, unknown>).entry;
    if (typeof raw === "string" && raw.trim().length > 0) entry = raw.trim();
    else entry = DEFAULT_WIDGET_ENTRY;
  } else if (Object.prototype.hasOwnProperty.call(files, DEFAULT_WIDGET_ENTRY)) {
    entry = DEFAULT_WIDGET_ENTRY;
  }
  if (!entry) return [];
  if (!Object.prototype.hasOwnProperty.call(files, entry)) {
    return [
      issue(
        "manifest.json",
        `manifest.widget.entry "${entry}" does not exist in the VFS. Either create the file or remove the widget block.`
      ),
    ];
  }
  const source = files[entry];
  if (typeof source !== "string") return [];
  const hasDefault = /\bexport\s+default\b/.test(source) || /\bas\s+default\b/.test(source);
  if (!hasDefault) {
    return [
      issue(
        entry,
        `Widget file "${entry}" has no default export. Add \`export default function Widget() { ... }\` so the host's mount harness can render it.`
      ),
    ];
  }
  return [];
}

function issue(file: string, message: string): BuildIssue {
  return { file, line: 0, column: 0, message };
}

function validateStrict(input: unknown, file: string): BuildIssue[] {
  const out: BuildIssue[] = [];
  if (!input || typeof input !== "object") {
    out.push(issue(file, `Manifest must be a JSON object with at least { "name": string, "params": [] }.`));
    return out;
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.trim().length === 0) {
    out.push(issue(file, `Manifest is missing a non-empty "name" string.`));
  }
  if (!Array.isArray(obj.params)) {
    out.push(issue(file, `Manifest "params" must be an array (use [] for none).`));
  } else {
    const seen = new Set<string>();
    for (const [i, raw] of (obj.params as unknown[]).entries()) {
      if (!raw || typeof raw !== "object") {
        out.push(issue(file, `params[${i}] must be an object with "key", "label", and "type".`));
        continue;
      }
      const p = raw as Record<string, unknown>;
      if (typeof p.key !== "string" || !KEY_RE.test(p.key)) {
        out.push(
          issue(
            file,
            `params[${i}].key must be a valid identifier (letters, digits, underscores, starting with a letter) — got ${JSON.stringify(p.key)}.`
          )
        );
      } else if (seen.has(p.key)) {
        out.push(issue(file, `params[${i}].key "${p.key}" duplicates an earlier param. Each key must be unique.`));
      } else {
        seen.add(p.key);
      }
      if (typeof p.label !== "string" || p.label.trim().length === 0) {
        out.push(issue(file, `params[${i}].label must be a non-empty string.`));
      }
      if (typeof p.type !== "string" || !VALID_TYPES.has(p.type)) {
        out.push(
          issue(
            file,
            `params[${i}].type must be one of "string", "number", "boolean", "enum", "model" — got ${JSON.stringify(p.type)}.`
          )
        );
      } else if (p.type === "enum") {
        if (!Array.isArray(p.options) || p.options.length === 0) {
          out.push(issue(file, `params[${i}] (type "enum") needs a non-empty "options" array.`));
        } else if (!p.options.every((o) => typeof o === "string")) {
          out.push(issue(file, `params[${i}].options must be all strings.`));
        }
      }
    }
  }
  if (obj.refresh !== undefined) {
    if (!obj.refresh || typeof obj.refresh !== "object") {
      out.push(issue(file, `Manifest "refresh" must be an object like { "minIntervalSeconds": 60 }.`));
    } else {
      const min = (obj.refresh as Record<string, unknown>).minIntervalSeconds;
      if (min !== undefined && (typeof min !== "number" || min < 0)) {
        out.push(issue(file, `refresh.minIntervalSeconds must be a non-negative number.`));
      }
    }
  }
  if (Array.isArray(obj.schedules)) {
    if (obj.schedules.length > 1) {
      out.push(
        issue(
          file,
          `Only one schedule is allowed per app. Use "schedule" (singular) instead of an array.`
        )
      );
    }
  }
  const scheduleInput =
    obj.schedule ?? (Array.isArray(obj.schedules) ? obj.schedules[0] : undefined);
  if (scheduleInput !== undefined) {
    out.push(...validateScheduleStrict(scheduleInput, file));
  }
  if (obj.widget !== undefined) {
    out.push(...validateWidgetStrict(obj.widget, file));
  }
  if (obj.state !== undefined) {
    out.push(...validateStateStrict(obj.state, obj.params, obj.schedule, file));
  }
  return out;
}

/**
 * Strict validation for the v2 declared-data block ("state"). Every problem is
 * an actionable Build error, so the model fixes the config in its tool loop
 * instead of the runtime silently mis-wiring data (the failure mode the v2
 * design exists to kill - see docs/artifact-sdk-v2-schema.md).
 */
function validateStateStrict(
  raw: unknown,
  rawParams: unknown,
  rawSchedule: unknown,
  file: string
): BuildIssue[] {
  const out: BuildIssue[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    out.push(
      issue(
        file,
        `"state" must be an object mapping entry keys to configs, e.g. { "events": { "kind": "collection", ... } }.`
      )
    );
    return out;
  }
  const declaredParams = new Set<string>(
    Array.isArray(rawParams)
      ? (rawParams as unknown[])
          .map((p) =>
            p && typeof p === "object" && typeof (p as Record<string, unknown>).key === "string"
              ? ((p as Record<string, unknown>).key as string)
              : ""
          )
          .filter(Boolean)
      : []
  );
  const scheduledEntries: string[] = [];
  for (const [key, rawEntry] of Object.entries(raw as Record<string, unknown>)) {
    const at = `state.${key}`;
    if (!KEY_RE.test(key)) {
      out.push(
        issue(
          file,
          `${at}: entry key must be a valid identifier (letters, digits, underscores, starting with a letter).`
        )
      );
    }
    if (!rawEntry || typeof rawEntry !== "object") {
      out.push(issue(file, `${at}: must be an object with "kind": "collection" or "value".`));
      continue;
    }
    const e = rawEntry as Record<string, unknown>;
    if (e.kind !== "collection" && e.kind !== "value") {
      out.push(
        issue(file, `${at}.kind must be "collection" or "value" - got ${JSON.stringify(e.kind)}.`)
      );
      continue;
    }
    if (e.kind === "value") continue;

    // collection
    const schemaProps = collectSchemaProps(e.schema);
    if (e.schema !== undefined) {
      if (!e.schema || typeof e.schema !== "object" || Array.isArray(e.schema)) {
        out.push(issue(file, `${at}.schema must be a JSON Schema object describing ONE record.`));
      } else if ((e.schema as Record<string, unknown>).type === "array") {
        out.push(
          issue(
            file,
            `${at}.schema describes ONE record (an object) - the runtime wraps it in an array itself. Remove the outer { "type": "array", "items": ... } and declare the item schema directly.`
          )
        );
      }
    }
    if (e.identity !== undefined) {
      if (!Array.isArray(e.identity) || e.identity.length === 0) {
        out.push(issue(file, `${at}.identity must be a non-empty array of record keys.`));
      } else {
        for (const k of e.identity) {
          if (typeof k !== "string" || k.length === 0) {
            out.push(issue(file, `${at}.identity entries must be non-empty strings.`));
          } else if (schemaProps && !schemaProps.has(k)) {
            out.push(
              issue(
                file,
                `${at}.identity references "${k}", which is not in schema.properties. Identity keys must be declared record fields.`
              )
            );
          }
        }
      }
    }
    if (e.merge !== undefined && e.merge !== "upsert" && e.merge !== "replace" && e.merge !== "append") {
      out.push(
        issue(file, `${at}.merge must be "upsert", "replace", or "append" - got ${JSON.stringify(e.merge)}.`)
      );
    }
    if (e.retain !== undefined) {
      const dateKey =
        e.retain && typeof e.retain === "object"
          ? (e.retain as Record<string, unknown>).dateKey
          : undefined;
      if (typeof dateKey !== "string" || dateKey.length === 0) {
        out.push(issue(file, `${at}.retain must be { "dateKey": "<record field>" }.`));
      } else if (schemaProps && !schemaProps.has(dateKey)) {
        out.push(
          issue(file, `${at}.retain.dateKey "${dateKey}" is not in schema.properties.`)
        );
      }
    }
    if (e.source !== undefined) {
      out.push(...validateEntrySourceStrict(e.source, declaredParams, at, file));
      const src = e.source as Record<string, unknown> | null;
      const refresh =
        src && typeof src === "object" && src.refresh && typeof src.refresh === "object"
          ? (src.refresh as Record<string, unknown>)
          : undefined;
      if (refresh && typeof refresh.schedule === "string" && refresh.schedule.trim()) {
        scheduledEntries.push(key);
      }
    }
  }
  if (scheduledEntries.length > 1) {
    out.push(
      issue(
        file,
        `Only one state entry per app may declare source.refresh.schedule (one schedule per app). Found: ${scheduledEntries.join(", ")}.`
      )
    );
  }
  if (scheduledEntries.length > 0 && rawSchedule !== undefined) {
    out.push(
      issue(
        file,
        `Declare the background refresh EITHER as state.${scheduledEntries[0]}.source.refresh.schedule OR as the top-level "schedule" block - not both. Remove the top-level "schedule".`
      )
    );
  }
  return out;
}

function collectSchemaProps(schema: unknown): Set<string> | null {
  if (!schema || typeof schema !== "object") return null;
  let obj = schema as Record<string, unknown>;
  // A mistakenly array-wrapped schema gets its own diagnostic, but still look
  // through to items.properties so identity/retain checks surface too.
  if (obj.type === "array" && obj.items && typeof obj.items === "object") {
    obj = obj.items as Record<string, unknown>;
  }
  const props = obj.properties;
  if (!props || typeof props !== "object") return null;
  return new Set(Object.keys(props as Record<string, unknown>));
}

function validateEntrySourceStrict(
  raw: unknown,
  declaredParams: Set<string>,
  at: string,
  file: string
): BuildIssue[] {
  const out: BuildIssue[] = [];
  if (!raw || typeof raw !== "object") {
    out.push(issue(file, `${at}.source must be an object like { "type": "query", "prompt": "..." }.`));
    return out;
  }
  const s = raw as Record<string, unknown>;
  if (s.type !== undefined && s.type !== "query") {
    out.push(issue(file, `${at}.source.type must be "query" - got ${JSON.stringify(s.type)}.`));
  }
  if (typeof s.prompt !== "string" || s.prompt.trim().length === 0) {
    out.push(issue(file, `${at}.source.prompt must be a non-empty string.`));
  } else {
    for (const key of templateParamKeys(s.prompt)) {
      if (!declaredParams.has(key)) {
        out.push(
          issue(
            file,
            `${at}.source.prompt references {params.${key}} but no param with key "${key}" is declared in "params".`
          )
        );
      }
    }
  }
  if (s.model !== undefined) {
    out.push(
      issue(
        file,
        `${at}.source.model is not allowed - the host always runs sources on the user's configured model. Remove it.`
      )
    );
  }
  if (s.mcp !== undefined && typeof s.mcp !== "boolean") {
    out.push(
      issue(
        file,
        `${at}.source.mcp must be a boolean. Set it to true to let this source call the user's connected MCP servers' tools.`
      )
    );
  }
  if (s.refresh !== undefined) {
    if (!s.refresh || typeof s.refresh !== "object") {
      out.push(issue(file, `${at}.source.refresh must be an object like { "user": true, "schedule": "0 6 * * *" }.`));
    } else {
      const r = s.refresh as Record<string, unknown>;
      if (r.user !== undefined && typeof r.user !== "boolean") {
        out.push(issue(file, `${at}.source.refresh.user must be a boolean.`));
      }
      if (r.schedule !== undefined) {
        if (typeof r.schedule !== "string" || r.schedule.trim().length === 0) {
          out.push(issue(file, `${at}.source.refresh.schedule must be a 5-field cron string.`));
        } else {
          const parsed = parseCron(r.schedule);
          if (!parsed.ok) {
            out.push(issue(file, `${at}.source.refresh.schedule is invalid: ${parsed.error}`));
          }
        }
      }
    }
  }
  return out;
}

function validateWidgetStrict(raw: unknown, file: string): BuildIssue[] {
  const out: BuildIssue[] = [];
  if (!raw || typeof raw !== "object") {
    out.push(
      issue(
        file,
        `"widget" must be an object like { "entry"?: "Widget.tsx", "defaultSize"?: "M", "supportedSizes"?: ["S","M","L","W"] }.`
      )
    );
    return out;
  }
  const w = raw as Record<string, unknown>;
  if (w.entry !== undefined) {
    if (typeof w.entry !== "string" || w.entry.trim().length === 0) {
      out.push(issue(file, `widget.entry must be a non-empty string path.`));
    } else if (!WIDGET_ENTRY_EXT_RE.test(w.entry)) {
      out.push(
        issue(file, `widget.entry must end in .tsx, .ts, .jsx, or .js — got ${JSON.stringify(w.entry)}.`)
      );
    }
  }
  if (
    w.defaultSize !== undefined &&
    !VALID_WIDGET_SIZES.has(w.defaultSize as WidgetSizePreset)
  ) {
    out.push(
      issue(
        file,
        `widget.defaultSize must be one of "S", "M", "L", "W" — got ${JSON.stringify(w.defaultSize)}.`
      )
    );
  }
  if (w.supportedSizes !== undefined) {
    if (!Array.isArray(w.supportedSizes) || w.supportedSizes.length === 0) {
      out.push(
        issue(file, `widget.supportedSizes must be a non-empty array of "S" | "M" | "L" | "W".`)
      );
    } else {
      for (const [i, s] of (w.supportedSizes as unknown[]).entries()) {
        if (typeof s !== "string" || !VALID_WIDGET_SIZES.has(s as WidgetSizePreset)) {
          out.push(
            issue(
              file,
              `widget.supportedSizes[${i}] must be one of "S","M","L","W" — got ${JSON.stringify(s)}.`
            )
          );
        }
      }
    }
  }
  return out;
}

function validateScheduleStrict(raw: unknown, file: string): BuildIssue[] {
  const out: BuildIssue[] = [];
  if (!raw || typeof raw !== "object") {
    out.push(issue(file, `"schedule" must be an object with "cron", "type", and the type-specific fields.`));
    return out;
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.cron !== "string" || s.cron.trim().length === 0) {
    out.push(issue(file, `schedule.cron must be a non-empty 5-field cron expression.`));
  } else {
    const parsed = parseCron(s.cron);
    if (!parsed.ok) {
      out.push(issue(file, `schedule.cron is invalid: ${parsed.error}`));
    }
  }
  if (s.type !== "query" && s.type !== "fetch") {
    out.push(issue(file, `schedule.type must be "query" or "fetch" - got ${JSON.stringify(s.type)}.`));
    return out;
  }
  if (s.type === "query") {
    if (typeof s.prompt !== "string" || s.prompt.trim().length === 0) {
      out.push(issue(file, `schedule.prompt must be a non-empty string for type "query".`));
    }
    if (s.tools !== undefined) {
      if (!Array.isArray(s.tools)) {
        out.push(issue(file, `schedule.tools must be an array of "web_search" / "web_fetch".`));
      } else {
        for (const [i, t] of s.tools.entries()) {
          if (t !== "web_search" && t !== "web_fetch") {
            out.push(
              issue(
                file,
                `schedule.tools[${i}] must be "web_search" or "web_fetch" — got ${JSON.stringify(t)}.`
              )
            );
          }
        }
      }
    }
  } else {
    if (typeof s.url !== "string" || !/^https?:\/\//i.test(s.url.trim())) {
      out.push(issue(file, `schedule.url must be an http(s) URL for type "fetch".`));
    }
  }
  return out;
}

/** Apply param defaults + return the final params record for a fresh instance. */
export function defaultParamsFor(manifest: ArtifactManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of manifest.params) {
    if (p.type === "string" && p.default !== undefined) out[p.key] = p.default;
    else if (p.type === "number" && p.default !== undefined) out[p.key] = p.default;
    else if (p.type === "boolean" && p.default !== undefined) out[p.key] = p.default;
    else if (p.type === "enum" && p.default !== undefined) out[p.key] = p.default;
    else if (p.type === "model" && p.default !== undefined) out[p.key] = p.default;
  }
  return out;
}
