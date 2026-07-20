// Shared, framework-agnostic helpers for identifying a pinned note: a smart
// title derived from the note's own content, a plain-text projection for
// search, and a search snippet that centers on the matched term.
//
// Why this lives in one place: a note's title is rendered in at least four
// surfaces (the /notes card, the attach picker, the attached-note chips, and
// the `<note title>` tag injected into the system prompt). They used to each
// inline `note.title || note.summary.slice(0, 60) || "Untitled pin"`, so an
// untitled pin showed up as "Untitled pin" everywhere even though its body
// almost always starts with a perfectly good heading or sentence. Deriving a
// title from the content makes a note self-identifying with zero user effort.

import type { StoredPinnedNote } from "@/app/db";

const MAX_TITLE = 72;

/** Drop tags + collapse whitespace. Mirrors extra-system's stripHtml; the goal
 *  is readable prose for titling/search, not faithful HTML rendering. */
export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Truncate on a word boundary with an ellipsis, never mid-word. */
export function truncate(s: string, max = MAX_TITLE): string {
  const t = clean(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/** Strip the common inline + leading markdown markers off a single line so a
 *  heading like "## **Plan** for `x`" titles as "Plan for x". */
function stripMarkdownInline(s: string): string {
  return s
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

/** First markdown heading (preferred) or first substantial line of prose. */
function firstHeadingOrLine(md: string): string | null {
  const lines = md.split(/\r?\n/);
  for (const line of lines.slice(0, 12)) {
    const m = line.match(/^#{1,6}\s+(.+)/);
    if (m) {
      const t = stripMarkdownInline(m[1]);
      if (t) return t;
    }
  }
  for (const line of lines) {
    const t = stripMarkdownInline(line);
    // Skip blank lines, lone punctuation, and horizontal rules (---, ===, ***).
    if (t && t.length > 1 && !/^[-=_*~]{2,}$/.test(t)) return t;
  }
  return null;
}

/** Trim a long opening line down to its first sentence when one is obvious. */
function firstSentence(s: string): string {
  const m = s.match(/^(.{12,}?[.!?])(\s|$)/);
  return m ? m[1] : s;
}

function titleFromHtml(html: string): string | null {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) {
    const txt = stripHtmlToText(t[1]);
    if (txt) return txt;
  }
  const h =
    html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
    html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (h) {
    const txt = stripHtmlToText(h[1]);
    if (txt) return txt;
  }
  const body = stripHtmlToText(html);
  return body ? firstSentence(body) : null;
}

function deriveTitleFromContent(note: StoredPinnedNote): string | null {
  if (note.messageMarkdown && note.messageMarkdown.trim()) {
    const t = firstHeadingOrLine(note.messageMarkdown);
    if (t) return firstSentence(t);
  }
  if (note.artifactHtml && note.artifactHtml.trim()) {
    const t = titleFromHtml(note.artifactHtml);
    if (t) return t;
  }
  if (note.chatSnapshot && note.chatSnapshot.messages.length) {
    const first =
      note.chatSnapshot.messages.find((m) => m.role === "user") ??
      note.chatSnapshot.messages[0];
    const t = firstHeadingOrLine(first.content);
    if (t) return firstSentence(t);
  }
  if (note.summary && note.summary.trim()) return firstSentence(note.summary.trim());
  return null;
}

/**
 * The display title for a note: the explicit title if the user set one,
 * otherwise a clean title derived from the note's own content. Always returns
 * a non-empty, length-capped string ("Untitled note" only as a last resort for
 * a genuinely empty pin).
 */
export function deriveNoteTitle(note: StoredPinnedNote): string {
  const explicit = note.title?.trim();
  if (explicit) return truncate(explicit);
  const derived = deriveTitleFromContent(note);
  return derived ? truncate(derived) : "Untitled note";
}

/** Flatten a note into searchable plain text (title + summary + body). */
export function noteToPlainText(note: StoredPinnedNote): string {
  const parts: string[] = [];
  if (note.title) parts.push(note.title);
  if (note.summary) parts.push(note.summary);
  if (note.messageMarkdown) parts.push(note.messageMarkdown);
  if (note.chatSnapshot) {
    const snap = note.chatSnapshot.messages
      .map((m) => m.content)
      .join("\n\n");
    if (snap) parts.push(snap);
  }
  if (note.artifactHtml && !note.messageMarkdown && !note.chatSnapshot) {
    parts.push(stripHtmlToText(note.artifactHtml));
  }
  return parts.join("\n\n").trim();
}

/**
 * A short preview snippet for a note. When `query` matches the body, the
 * snippet is centered on the first match so the user sees *why* the note hit;
 * otherwise it's the opening of the body. Returns null when there's no body.
 */
export function noteSnippet(
  note: StoredPinnedNote,
  query?: string,
  radius = 64
): string | null {
  // Prefer body text the title doesn't already cover, so the snippet adds info.
  const body = clean(
    [
      note.messageMarkdown ?? "",
      note.chatSnapshot?.messages.map((m) => m.content).join(" ") ?? "",
      note.artifactHtml ? stripHtmlToText(note.artifactHtml) : "",
      note.summary ?? "",
    ]
      .filter(Boolean)
      .join("  ·  ")
  );
  if (!body) return null;

  const q = query?.trim().toLowerCase();
  if (!q) return truncate(body, 150);

  const idx = body.toLowerCase().indexOf(q);
  if (idx === -1) return truncate(body, 150);

  const start = Math.max(0, idx - radius);
  const end = Math.min(body.length, idx + q.length + radius);
  let snip = body.slice(start, end).trim();
  if (start > 0) snip = "…" + snip;
  if (end < body.length) snip = snip + "…";
  return snip;
}

/**
 * Rank notes against a query: title/source hits sort above body-only hits, and
 * notes that don't match at all are dropped. With no query the input order
 * (already newest-first from the caller) is preserved.
 */
export function searchNotes(
  notes: StoredPinnedNote[],
  query: string
): StoredPinnedNote[] {
  const q = query.trim().toLowerCase();
  if (!q) return notes;
  const scored: Array<{ note: StoredPinnedNote; score: number }> = [];
  for (const note of notes) {
    const title = deriveNoteTitle(note).toLowerCase();
    const source = (note.chatTitle ?? "").toLowerCase();
    const body = noteToPlainText(note).toLowerCase();
    let score = 0;
    if (title.includes(q)) score += 3;
    if (source.includes(q)) score += 2;
    if (body.includes(q)) score += 1;
    if (score > 0) scored.push({ note, score });
  }
  // Stable sort by score desc; ties keep the caller's newest-first order.
  return scored
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((s) => s.note);
}
