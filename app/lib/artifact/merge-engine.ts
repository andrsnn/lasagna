// Generic record-merge engine for artifact data collections.
//
// This is the platform half of the SDK v2 "declared data" design
// (docs/artifact-sdk-v2-schema.md): every app that declares a collection gets
// record identity, canonicalized dedupe, filler scrubbing, and cross-run merge
// FOR FREE, instead of each generated app hand-rolling (and mis-rolling) its
// own. The primitives here generalize what app/lib/structured-research.ts
// already proved out for the research feature - lifted so any app collection
// (events, recipes, papers, prices) benefits, per the CLAUDE.md test.
//
// Everything is deliberately domain-agnostic: identity keys, merge mode, and
// retention come from the app's declared config, never from hardcoded rules.

export type CollectionMergeMode = "upsert" | "replace" | "append";

export type CollectionConfig = {
  /** Record keys whose normalized values identify one logical record. */
  identity?: string[];
  /** How incoming records combine with existing ones. Default "upsert". */
  merge?: CollectionMergeMode;
  /** Optional retention: drop records whose `dateKey` field parses to a date
   *  older than yesterday (UTC). Keeps "upcoming X" collections from
   *  accumulating stale rows forever. */
  retain?: { dateKey?: string };
};

export type MergeOutcome = {
  records: Record<string, unknown>[];
  added: number;
  updated: number;
  /** Incoming records discarded before merge: empty after scrubbing, or (for
   *  identified collections) carrying no identity-field values. A batch where
   *  EVERY record drops almost always means the data's field names don't
   *  match the declared schema - callers surface that as an error instead of
   *  a silent empty success. */
  dropped: number;
};

/** Canonicalize one identity part: lowercase, strip non-alphanumerics. Same
 *  normalization the research feature uses, so "Yellow Racket Records" and
 *  "yellow racket records." dedupe to one record. */
export function normalizeIdentity(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 80);
}

/** Build a record's identity from the configured identity keys. Empty string
 *  means "no usable identity" - the record is kept but never deduped. */
export function recordIdentity(
  rec: Record<string, unknown>,
  identityKeys: string[]
): string {
  const parts = identityKeys
    .map((k) => normalizeIdentity(String(rec[k] ?? "")))
    .filter((p) => p.length > 0);
  return parts.join("|");
}

// Models write research-process meta-commentary or filler INTO data fields
// ("N/A", "not verified", "see website"). A field should hold the real value
// or be blank. Same defensive scrub the research table applies to cells.
const META_SENTENCE =
  /(not\s+\w+[^.;]*\bbriefs?\b|\bbriefs?\b[^.;]*\bnot\s+(transcribed|verified|provided|available|found|listed)|not\s+(transcribed|verified)\b[^.;]*)/i;
const FILLER_TOKEN =
  /^(n\/?a|none(\s+found)?|unknown|undisclosed|not\s+(available|found|specified|provided|listed|disclosed|transcribed|verified)|see\s+(the\s+)?website|tbd|—|-)\.?$/i;

export function scrubValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  let s = v.trim();
  if (!s) return "";
  s = s
    .split(/(?<=[.;])\s+/)
    .filter((sentence) => !META_SENTENCE.test(sentence))
    .join(" ")
    .trim();
  if (!s || FILLER_TOKEN.test(s)) return "";
  return s;
}

/** Scrub every string field of a record. Non-objects pass through untouched. */
export function scrubRecord(rec: unknown): unknown {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return rec;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
    out[k] = scrubValue(v);
  }
  return out;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is Record<string, unknown> =>
      !!r && typeof r === "object" && !Array.isArray(r)
  );
}

/** True when every configured identity + string field of the record is blank
 *  after scrubbing - a filler row the model invented, not data. */
function isEmptyRecord(rec: Record<string, unknown>): boolean {
  return Object.values(rec).every((v) => {
    if (v === null || v === undefined) return true;
    if (typeof v === "string") return v.trim().length === 0;
    return false;
  });
}

function parseDateish(v: unknown): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Drop records whose retention date field is older than ~yesterday (UTC).
 *  Records without a parseable date are kept - retention never guesses. */
export function applyRetention(
  records: Record<string, unknown>[],
  retain: CollectionConfig["retain"],
  now: number = Date.now()
): Record<string, unknown>[] {
  const dateKey = retain?.dateKey;
  if (!dateKey) return records;
  const cutoff = now - 36 * 60 * 60 * 1000; // yesterday, generous to timezones
  return records.filter((r) => {
    const t = parseDateish(r[dateKey]);
    return t === null || t >= cutoff;
  });
}

/**
 * Merge incoming records into an existing collection.
 *
 * - "replace": incoming (scrubbed, deduped, retained) becomes the collection.
 * - "append": incoming records are added; no dedupe against existing.
 * - "upsert" (default): dedupe by identity. New identities append; existing
 *   identities are updated field-by-field, where an incoming BLANK value never
 *   clobbers an existing real value (fill-blanks semantics, both directions).
 *
 * When identity keys are configured, an incoming record whose identity fields
 * are ALL blank is dropped: it cannot be deduped on this or any future
 * refresh, so keeping it would append a new ghost row every run (the classic
 * scrubbed-filler case). Collections without identity keys keep everything.
 */
export function mergeCollection(
  existing: unknown,
  incoming: unknown,
  cfg: CollectionConfig = {},
  now: number = Date.now()
): MergeOutcome {
  const mode: CollectionMergeMode = cfg.merge ?? "upsert";
  const identityKeys = Array.isArray(cfg.identity) ? cfg.identity : [];

  const incomingRaw = asRecordArray(incoming);
  const incomingClean = incomingRaw
    .map((r) => scrubRecord(r) as Record<string, unknown>)
    .filter((r) => !isEmptyRecord(r))
    // Identified collections drop identity-less records - they can never be
    // deduped, so they would re-append as ghost rows on every refresh.
    .filter((r) => identityKeys.length === 0 || recordIdentity(r, identityKeys) !== "");
  const dropped = incomingRaw.length - incomingClean.length;

  if (mode === "replace") {
    const deduped = dedupeWithin(incomingClean, identityKeys);
    return {
      records: applyRetention(deduped, cfg.retain, now),
      added: deduped.length,
      updated: 0,
      dropped,
    };
  }

  const current = asRecordArray(existing);

  if (mode === "append") {
    const records = applyRetention([...current, ...incomingClean], cfg.retain, now);
    return { records, added: incomingClean.length, updated: 0, dropped };
  }

  // upsert
  const out = [...current];
  const byId = new Map<string, number>();
  if (identityKeys.length > 0) {
    current.forEach((r, i) => {
      const id = recordIdentity(r, identityKeys);
      if (id && !byId.has(id)) byId.set(id, i);
    });
  }

  let added = 0;
  let updated = 0;
  for (const rec of incomingClean) {
    const id = identityKeys.length > 0 ? recordIdentity(rec, identityKeys) : "";
    if (!id || !byId.has(id)) {
      out.push(rec);
      if (id) byId.set(id, out.length - 1);
      added++;
      continue;
    }
    const idx = byId.get(id)!;
    const prev = out[idx];
    const next: Record<string, unknown> = { ...prev };
    let changed = false;
    for (const [k, v] of Object.entries(rec)) {
      const isBlank = v === null || v === undefined || (typeof v === "string" && v.trim() === "");
      if (isBlank) continue; // incoming blank never clobbers existing value
      if (!deepEqualJson(next[k], v)) {
        next[k] = v;
        changed = true;
      }
    }
    if (changed) {
      out[idx] = next;
      updated++;
    }
  }

  return { records: applyRetention(out, cfg.retain, now), added, updated, dropped };
}

/**
 * Harden a declared entry's ONE-record schema for a source run: identity
 * fields become required, non-empty strings. The executor's validate + repair
 * loop then fixes records that arrive with missing/blank identity fields
 * (usually the model naming fields differently than the schema), instead of
 * the merge silently dropping every row as identity-less.
 */
export function hardenEntrySchema(itemSchema: unknown, identity: string[] | undefined): unknown {
  if (!itemSchema || typeof itemSchema !== "object" || !identity || identity.length === 0) {
    return itemSchema;
  }
  const schema = itemSchema as Record<string, unknown>;
  const props =
    schema.properties && typeof schema.properties === "object"
      ? { ...(schema.properties as Record<string, unknown>) }
      : undefined;
  if (!props) return itemSchema;
  for (const key of identity) {
    const p = props[key];
    if (p && typeof p === "object") {
      const prop = p as Record<string, unknown>;
      if (prop.type === "string" && prop.minLength === undefined) {
        props[key] = { ...prop, minLength: 1 };
      }
    }
  }
  const required = Array.isArray(schema.required)
    ? [...new Set([...(schema.required as string[]), ...identity])]
    : [...identity];
  return { ...schema, properties: props, required };
}

/** Dedupe a single batch by identity, merging fill-blanks like upsert does. */
function dedupeWithin(
  records: Record<string, unknown>[],
  identityKeys: string[]
): Record<string, unknown>[] {
  if (identityKeys.length === 0) return records;
  const out: Record<string, unknown>[] = [];
  const byId = new Map<string, number>();
  for (const rec of records) {
    const id = recordIdentity(rec, identityKeys);
    if (!id || !byId.has(id)) {
      out.push(rec);
      if (id) byId.set(id, out.length - 1);
      continue;
    }
    const idx = byId.get(id)!;
    const merged = { ...out[idx] };
    for (const [k, v] of Object.entries(rec)) {
      const isBlank = v === null || v === undefined || (typeof v === "string" && v.trim() === "");
      const prevBlank =
        merged[k] === null || merged[k] === undefined ||
        (typeof merged[k] === "string" && String(merged[k]).trim() === "");
      if (!isBlank && prevBlank) merged[k] = v;
    }
    out[idx] = merged;
  }
  return out;
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Interpolate `{params.key}` placeholders in a declared source prompt with the
 * app's current param values. Serializable by design - the same interpolated
 * string is registered for server-side scheduled runs, so interactive and
 * scheduled executions see the identical prompt. Unknown placeholders are left
 * verbatim (strict validation flags them at build time).
 */
export function interpolateTemplate(
  template: string,
  ctx: { params?: Record<string, unknown> }
): string {
  return template.replace(/\{params\.([a-zA-Z][a-zA-Z0-9_]*)\}/g, (whole, key: string) => {
    const v = ctx.params?.[key];
    if (v === null || v === undefined) return whole;
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

/**
 * Effective param values for interpolation: the app's stored instance values
 * with each declared param's manifest `default` filled in for any key the
 * instance doesn't set. Apps are created with `params: {}` and defaults live
 * only in the manifest (a display fallback in the param form) - so without
 * this, a prompt like "events in {params.city}" interpolates against an
 * undefined `city` and the literal `{params.city}` is stored and searched
 * for, returning nothing. Instance values always win over defaults.
 */
export function resolveParamValues(
  manifestParams:
    | Array<{ key?: unknown; default?: unknown }>
    | undefined,
  instanceParams: Record<string, unknown> | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(manifestParams)) {
    for (const p of manifestParams) {
      if (
        p &&
        typeof p.key === "string" &&
        p.default !== undefined &&
        p.default !== null &&
        !(p.default === "")
      ) {
        out[p.key] = p.default;
      }
    }
  }
  for (const [k, v] of Object.entries(instanceParams ?? {})) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

/** Extract the param keys referenced by `{params.key}` placeholders. */
export function templateParamKeys(template: string): string[] {
  const keys = new Set<string>();
  for (const m of template.matchAll(/\{params\.([a-zA-Z][a-zA-Z0-9_]*)\}/g)) {
    keys.add(m[1]);
  }
  return [...keys];
}
