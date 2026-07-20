// Reliable structured output for artifact LLM calls.
//
// The recurring pain: artifact.query({schema}) and recurring research return
// JSON in inconsistent shapes — fenced, wrapped in prose, or missing required
// fields — because the schema is only *suggested* via the system prompt and
// never validated. This module makes structured output deterministic:
//
//   1. coerceJson()        — tolerant extraction: strip code fences / prose,
//                            pull the first balanced {…}/[…], then JSON.parse.
//   2. validateAgainstSchema() — a small handwritten JSON-Schema-ish validator
//                            (type / required / properties / items / enum /
//                            pattern / format / min-max length / numeric bounds
//                            / min-max items) that returns human-readable error
//                            paths.
//   3. enforceStructured() — parse → validate → bounded repair loop that
//                            re-prompts the model with the concrete errors and
//                            "output JSON only" until it conforms (or gives up).
//
// No new dependency: ajv/zod aren't in the repo and the subset below covers the
// schemas apps actually hand us. Exotic features (oneOf/allOf/$ref) fall through
// as "valid JSON, unvalidated" rather than spuriously failing.

/**
 * Extract a JSON value from raw model text. Handles the three shapes models
 * actually emit even when asked for JSON-only:
 *   - clean JSON,
 *   - ```json … ``` fenced blocks,
 *   - JSON embedded in surrounding prose ("Here is the result: { … }").
 * Returns `undefined` when no parseable JSON value can be recovered.
 */
export function coerceJson(text: string): unknown | undefined {
  if (typeof text !== "string") return undefined;
  let t = text.trim();
  if (!t) return undefined;

  // Strip a leading/trailing markdown code fence (```json … ``` or ``` … ```).
  const fence = t.match(/^```(?:json|json5)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();

  // Fast path: the whole thing is already a JSON value.
  const direct = tryParse(t);
  if (direct !== SENTINEL) return direct;

  // Fall back to the first balanced object/array embedded in the text. Models
  // sometimes prepend "Here's the JSON:" or append a trailing sentence.
  const slice = firstBalancedJson(t);
  if (slice !== undefined) {
    const parsed = tryParse(slice);
    if (parsed !== SENTINEL) return parsed;
  }
  return undefined;
}

const SENTINEL = Symbol("parse-failed");

function tryParse(s: string): unknown | typeof SENTINEL {
  try {
    return JSON.parse(s);
  } catch {
    return SENTINEL;
  }
}

/** Return the first balanced {…} or […] substring, respecting strings and
 *  escapes so a brace inside a quoted value doesn't end the scan early. */
function firstBalancedJson(text: string): string | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  pattern?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  // Unknown keywords (oneOf/allOf/$ref/…) are ignored — see file header.
  [k: string]: unknown;
};

// The formats apps actually declare. Anything else is ignored (tolerant), so a
// creative `format` never spuriously fails a build — but the common ones give
// real rejection + repair instead of being silently dropped.
const FORMAT_CHECKS: Record<string, (s: string) => boolean> = {
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)),
  "date-time": (s) => !Number.isNaN(Date.parse(s)) && /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s),
  time: (s) => /^\d{2}:\d{2}(:\d{2})?$/.test(s),
  uri: (s) => /^https?:\/\/\S+$/i.test(s) || /^[a-z][a-z0-9+.-]*:\S+$/i.test(s),
  url: (s) => /^https?:\/\/\S+$/i.test(s),
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
};

/**
 * Validate `value` against `schema`, returning a list of human-readable error
 * strings (empty ⇒ valid). Best-effort over a common JSON-Schema subset; an
 * unrecognized/empty schema validates anything (returns []).
 */
export function validateAgainstSchema(value: unknown, schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const errors: string[] = [];
  walk(value, schema as JsonSchema, "$", errors);
  return errors;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // "object" | "string" | "number" | "boolean" | …
}

function matchesType(value: unknown, t: string): boolean {
  if (t === "integer") return typeof value === "number" && Number.isInteger(value);
  if (t === "number") return typeof value === "number";
  if (t === "array") return Array.isArray(value);
  if (t === "object") return typeOf(value) === "object";
  if (t === "null") return value === null;
  return typeOf(value) === t; // string | boolean
}

function walk(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  const { type } = schema;
  if (type !== undefined) {
    const allowed = Array.isArray(type) ? type : [type];
    if (!allowed.some((t) => matchesType(value, String(t)))) {
      errors.push(`${path}: expected ${allowed.join(" | ")}, got ${typeOf(value)}`);
      return; // shape is wrong; deeper checks would just add noise
    }
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const ok = schema.enum.some((e) => deepEqual(e, value));
    if (!ok) errors.push(`${path}: value not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: string shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path}: string longer than maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string" && schema.pattern.length > 0) {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push(`${path}: string does not match pattern ${JSON.stringify(schema.pattern)}`);
        }
      } catch {
        // Invalid regex in the schema — never fail the value for it.
      }
    }
    if (typeof schema.format === "string") {
      const check = FORMAT_CHECKS[schema.format];
      if (check && value.trim().length > 0 && !check(value.trim())) {
        errors.push(`${path}: string is not a valid ${schema.format}`);
      }
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: number below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: number above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: array has fewer than minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: array has more than maxItems ${schema.maxItems}`);
    }
  }

  if (typeOf(value) === "object" && (schema.properties || schema.required)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: required field missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) walk(obj[key], sub, `${path}.${key}`, errors);
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => walk(item, schema.items as JsonSchema, `${path}[${i}]`, errors));
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export type EnforceResult =
  | { ok: true; json: unknown; text: string }
  | { ok: false; error: string; text: string };

/**
 * Turn raw model text into validated structured JSON, repairing in-loop.
 *
 * `runRepair(instruction)` is a caller-supplied thunk that re-runs the model
 * with the given correction instruction appended and returns the new raw text;
 * this keeps the module provider-agnostic. When `schema` is falsy we only
 * require *parseable* JSON (no shape check).
 */
export async function enforceStructured(opts: {
  initialText: string;
  schema?: unknown;
  /** Max repair rounds after the initial attempt. Default 2. */
  maxRepairs?: number;
  runRepair: (instruction: string) => Promise<string>;
}): Promise<EnforceResult> {
  const { initialText, schema, runRepair } = opts;
  const maxRepairs = opts.maxRepairs ?? 2;

  let text = initialText;
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const parsed = coerceJson(text);
    if (parsed === undefined) {
      if (attempt === maxRepairs) {
        return { ok: false, error: "Model did not return valid JSON.", text };
      }
      text = await runRepair(
        "Your previous reply was not valid JSON. Output ONLY one JSON value " +
          "(object or array) — no prose, no markdown code fences. It must start " +
          "with `{` or `[` and end with `}` or `]`."
      );
      continue;
    }

    const errors = schema ? validateAgainstSchema(parsed, schema) : [];
    if (errors.length === 0) {
      return { ok: true, json: parsed, text: JSON.stringify(parsed) };
    }
    if (attempt === maxRepairs) {
      return {
        ok: false,
        error: `Output did not match the schema: ${errors.slice(0, 8).join("; ")}`,
        text,
      };
    }
    text = await runRepair(
      "Your previous JSON did not match the required schema. Fix exactly these " +
        `problems and output ONLY the corrected JSON (no prose, no code fences):\n- ${errors
          .slice(0, 8)
          .join("\n- ")}`
    );
  }
  // Unreachable, but satisfies the type checker.
  return { ok: false, error: "Structured output enforcement exhausted.", text };
}
