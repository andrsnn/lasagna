// Deterministic gradient pickers so each template/instance gets a stable, distinctive look.

const PALETTES: { from: string; via: string; to: string }[] = [
  { from: "#a78bfa", via: "#7c3aed", to: "#60a5fa" },
  { from: "#60a5fa", via: "#22d3ee", to: "#a78bfa" },
  { from: "#f472b6", via: "#a78bfa", to: "#60a5fa" },
  { from: "#fbbf24", via: "#f472b6", to: "#a78bfa" },
  { from: "#34d399", via: "#22d3ee", to: "#60a5fa" },
  { from: "#fb7185", via: "#f472b6", to: "#a78bfa" },
  { from: "#22d3ee", via: "#a78bfa", to: "#f472b6" },
  { from: "#facc15", via: "#fb923c", to: "#f472b6" },
];

export function gradientFor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const idx = Math.abs(hash) % PALETTES.length;
  return PALETTES[idx];
}

export function gradientCss(id: string) {
  const p = gradientFor(id);
  return `linear-gradient(135deg, ${p.from}, ${p.via}, ${p.to})`;
}

/**
 * 1-2 letter monogram for a tile fallback hero. Picks the first letter of the
 * first 1-2 whitespace tokens (skipping punctuation), uppercased. Falls back
 * to the first two letters of the trimmed name if there's only one token.
 */
export function monogramFor(name: string | undefined | null): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "?";
  const tokens = trimmed
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (tokens.length >= 2) {
    return (tokens[0][0] + tokens[1][0]).toUpperCase();
  }
  const only = tokens[0] ?? trimmed;
  return only.slice(0, 2).toUpperCase();
}

/**
 * Inlined SVG dot pattern as a data URL — used as a soft overlay on the
 * gradient hero so it doesn't read as a flat blob. Single shared output;
 * the gradient underneath provides the per-app variation.
 */
export function patternDataUrl(): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="2" cy="2" r="1" fill="white" fill-opacity="0.55"/><circle cx="14" cy="14" r="1" fill="white" fill-opacity="0.4"/></svg>';
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

export function relativeTime(ms?: number): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  // Future timestamps (e.g. an invite/share expiry) read "in 7d", not the
  // nonsensical "-604800s ago" a past-only formatter would produce.
  const future = diff < 0;
  const phrase = (n: number, unit: string) =>
    future ? `in ${n}${unit}` : `${n}${unit} ago`;
  const sec = Math.round(Math.abs(diff) / 1000);
  if (sec < 60) return phrase(sec, "s");
  const min = Math.round(sec / 60);
  if (min < 60) return phrase(min, "m");
  const hr = Math.round(min / 60);
  if (hr < 24) return phrase(hr, "h");
  const day = Math.round(hr / 24);
  return phrase(day, "d");
}

/**
 * Plain-English copy for "scan ran recently, here's when the next one's
 * available" — used in the schedule chrome, the artifact iframe error path,
 * and any future surface that hits the per-app rate limit. Hides the words
 * "budget", "cron", "minutes" and gives the user an absolute clock time
 * (their browser's locale) plus a soft relative hint.
 */
export function nextAvailableMessage(retryAfterMs?: number): string {
  if (!retryAfterMs || retryAfterMs <= 0) return "Already scanned recently. Try again shortly.";
  const when = new Date(Date.now() + retryAfterMs);
  const clock = when.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const mins = Math.round(retryAfterMs / 60_000);
  const relative =
    mins < 60
      ? `in about ${mins} min`
      : mins < 90
        ? "in about an hour"
        : `in about ${Math.round(mins / 60)} hours`;
  return `Already scanned recently. Next scan ${relative} (around ${clock}).`;
}
