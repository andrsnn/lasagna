// Tiny 5-field cron parser tuned for one purpose: deciding when an app's
// background task is due. Vocabulary: `*`, `n`, `*/n`, `a-b`, `a,b,c`.
// Field order: minute hour day-of-month month day-of-week.
//
// We deliberately reject anything that fires more often than once an hour
// (see MIN_INTERVAL_MS) — Ollama Cloud spend grows with every fire, and
// the Vercel Cron sweep that drives execution runs every 30 minutes so
// sub-hour cadences couldn't fire reliably anyway.

const MIN_INTERVAL_MS = 60 * 60_000;

type FieldRange = { min: number; max: number };
const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // dom
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 },  // dow (0 = Sunday)
];

export type CronSpec = {
  /** Sorted ascending sets of allowed values per field. */
  fields: number[][];
  /** Original expression string for round-tripping / display. */
  expr: string;
};

export type CronValidation =
  | { ok: true; spec: CronSpec; minIntervalMs: number }
  | { ok: false; error: string };

function parseField(raw: string, range: FieldRange): number[] | string {
  if (!raw) return `empty field`;
  // Comma-separated list — recurse and union.
  if (raw.includes(",")) {
    const set = new Set<number>();
    for (const piece of raw.split(",")) {
      const sub = parseField(piece, range);
      if (typeof sub === "string") return sub;
      for (const v of sub) set.add(v);
    }
    return [...set].sort((a, b) => a - b);
  }
  // Step: */n or a-b/n or *
  let stepBase = raw;
  let step = 1;
  if (raw.includes("/")) {
    const [base, stepStr] = raw.split("/");
    stepBase = base ?? "";
    if (!stepStr) return `bad step in "${raw}"`;
    const n = Number(stepStr);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      return `step must be a positive integer in "${raw}"`;
    }
    step = n;
  }
  let lo: number;
  let hi: number;
  if (stepBase === "*") {
    lo = range.min;
    hi = range.max;
  } else if (stepBase.includes("-")) {
    const [a, b] = stepBase.split("-");
    const an = Number(a);
    const bn = Number(b);
    if (!Number.isInteger(an) || !Number.isInteger(bn)) return `bad range "${raw}"`;
    if (an < range.min || bn > range.max || an > bn) return `range "${raw}" out of bounds`;
    lo = an;
    hi = bn;
  } else {
    const n = Number(stepBase);
    if (!Number.isInteger(n)) return `bad value "${raw}"`;
    if (n < range.min || n > range.max) return `value "${raw}" out of bounds`;
    if (step !== 1) {
      // `5/3` is meaningless; require `*/3` or `5-23/3`.
      return `step needs a range or "*" base, not a single value, in "${raw}"`;
    }
    return [n];
  }
  const out: number[] = [];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out;
}

export function parseCron(expr: string): CronValidation {
  const trimmed = expr.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return { ok: false, error: `cron must have 5 space-separated fields, got ${parts.length}` };
  }
  const fields: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const result = parseField(parts[i], FIELD_RANGES[i]);
    if (typeof result === "string") {
      return { ok: false, error: `field ${i + 1}: ${result}` };
    }
    if (result.length === 0) {
      return { ok: false, error: `field ${i + 1}: no values matched` };
    }
    fields.push(result);
  }
  const spec: CronSpec = { fields, expr: trimmed };
  const minIntervalMs = computeMinInterval(spec);
  if (minIntervalMs < MIN_INTERVAL_MS) {
    return {
      ok: false,
      error: `cron fires too often (smallest gap: ${Math.round(
        minIntervalMs / 60_000
      )}min). Schedules must be at least 1 hour apart.`,
    };
  }
  return { ok: true, spec, minIntervalMs };
}

/** Public wrapper that returns a boolean + error for the manifest validator. */
export function validateCron(expr: string): CronValidation {
  return parseCron(expr);
}

/**
 * Smallest gap between any two consecutive fires across the next ~7 days.
 * Walks `nextDue` forward; bails out once we've found a gap < MIN_INTERVAL_MS
 * or covered the window. 7 days catches weekly-only patterns without being
 * expensive.
 */
function computeMinInterval(spec: CronSpec): number {
  const start = Date.UTC(2024, 0, 1, 0, 0, 0); // deterministic anchor
  const end = start + 7 * 24 * 60 * 60_000;
  let cursor = start - 60_000;
  let prev: number | null = null;
  let smallest = Number.POSITIVE_INFINITY;
  // Cap iterations: a `* * * * *` would be 7*24*60 = 10080 fires.
  let safety = 12000;
  while (safety-- > 0) {
    const next = nextFireFrom(spec, cursor + 60_000);
    if (next === null || next > end) break;
    if (prev !== null) {
      const gap = next - prev;
      if (gap < smallest) smallest = gap;
      if (smallest < MIN_INTERVAL_MS) return smallest;
    }
    prev = next;
    cursor = next;
  }
  return smallest === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : smallest;
}

/**
 * Returns the next epoch-ms at which the cron fires at or after `fromMs`.
 * Resolution is 1 minute. UTC throughout — the host's local timezone never
 * affects scheduling decisions.
 */
function nextFireFrom(spec: CronSpec, fromMs: number): number | null {
  // Round up to the next whole minute so we don't fire twice in the same
  // second.
  let t = Math.ceil(fromMs / 60_000) * 60_000;
  // Bound the search to ~5 years out — anything larger is a misconfigured
  // cron (e.g. impossible day-of-month + month combo) and we should give up.
  const limit = t + 5 * 365 * 24 * 60 * 60_000;
  while (t < limit) {
    const d = new Date(t);
    const m = d.getUTCMinutes();
    const h = d.getUTCHours();
    const dom = d.getUTCDate();
    const mon = d.getUTCMonth() + 1;
    const dow = d.getUTCDay();
    if (
      spec.fields[0].includes(m) &&
      spec.fields[1].includes(h) &&
      spec.fields[2].includes(dom) &&
      spec.fields[3].includes(mon) &&
      spec.fields[4].includes(dow)
    ) {
      return t;
    }
    t += 60_000;
  }
  return null;
}

/** Public helper used by run-schedule + cron sweep. */
export function nextDue(spec: CronSpec, fromMs: number): number | null {
  return nextFireFrom(spec, fromMs);
}

/**
 * Did this schedule become due since `lastRunMs`? If `lastRunMs` is null we
 * treat the schedule as "never run" → due now.
 */
export function isDue(spec: CronSpec, lastRunMs: number | null, nowMs: number): boolean {
  if (lastRunMs == null) return true;
  const next = nextFireFrom(spec, lastRunMs + 60_000);
  if (next == null) return false;
  return next <= nowMs;
}

/** Best-effort human-readable rendering for the UI. */
export function formatCron(expr: string): string {
  const parsed = parseCron(expr);
  if (!parsed.ok) return expr;
  const [min, hour, dom, mon, dow] = parsed.spec.fields;
  const oneHour = hour.length === 1;
  const oneMin = min.length === 1;
  const everyDay = dom.length === 31 && mon.length === 12 && dow.length === 7;
  if (oneHour && oneMin && everyDay) {
    const hh = String(hour[0]).padStart(2, "0");
    const mm = String(min[0]).padStart(2, "0");
    return `daily at ${hh}:${mm} UTC`;
  }
  if (oneHour && oneMin && dow.length < 7 && dom.length === 31 && mon.length === 12) {
    const hh = String(hour[0]).padStart(2, "0");
    const mm = String(min[0]).padStart(2, "0");
    const days = dow.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ");
    return `${days} at ${hh}:${mm} UTC`;
  }
  // `0 */N * * *` and friends — even step across the day starting at :00.
  if (oneMin && min[0] === 0 && everyDay && hour.length > 1) {
    const step = hour[1] - hour[0];
    const evenStep = hour.every((h, i) => i === 0 || h - hour[i - 1] === step);
    if (evenStep && hour[0] === 0 && 24 % step === 0) {
      return step === 1 ? "every hour" : `every ${step} hours`;
    }
  }
  return expr;
}

export const CRON_MIN_INTERVAL_MS = MIN_INTERVAL_MS;
