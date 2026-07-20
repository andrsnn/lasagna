"use client";

import { type AttachedPdf, newId } from "@/app/db";
import { wrapInPageHtml, titleFromFilename } from "@/app/lib/page-html";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PDFS_PER_MESSAGE = 2;
/** ~16k tokens at 3.6 chars/token (matches estimateTokens heuristic). */
export const PDF_TEXT_CHAR_LIMIT = 60_000;
export const PDF_EXCERPT_CHARS = 280;

type PdfWorkerModule = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (src: { data: ArrayBuffer; disableFontFace?: boolean; useSystemFonts?: boolean }) => {
    promise: Promise<PdfDocument>;
  };
};

type PdfDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
  destroy?: () => Promise<void>;
};

type PdfTextItem = {
  str?: string;
  hasEOL?: boolean;
  /** [a, b, c, d, e, f] affine transform; e = x, f = y (PDF user space). */
  transform?: number[];
  height?: number;
  width?: number;
  fontName?: string;
};

type PdfPage = {
  getTextContent: () => Promise<{ items: PdfTextItem[] }>;
  cleanup?: () => void;
};

let workerConfigured = false;
let pdfjsPromise: Promise<PdfWorkerModule> | null = null;

async function loadPdfjs(): Promise<PdfWorkerModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const mod = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfWorkerModule;
      if (!workerConfigured) {
        // Worker is bundled by Next/Turbopack via the URL constructor.
        const workerUrl = new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url);
        mod.GlobalWorkerOptions.workerSrc = workerUrl.toString();
        workerConfigured = true;
      }
      return mod;
    })();
  }
  return pdfjsPromise;
}

function readArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as ArrayBuffer);
    fr.onerror = () => reject(fr.error ?? new Error("failed to read PDF"));
    fr.readAsArrayBuffer(file);
  });
}

function squashWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export async function fileToAttachedPdf(file: File): Promise<AttachedPdf> {
  if (file.size > MAX_PDF_BYTES) {
    throw new Error(
      `PDF "${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — limit is ${Math.round(
        MAX_PDF_BYTES / 1024 / 1024
      )} MB.`
    );
  }

  const data = await readArrayBuffer(file);
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;

  let full = "";
  let truncated = false;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      try {
        const tc = await page.getTextContent();
        const pageText = tc.items
          .map((it) => (typeof it.str === "string" ? it.str : ""))
          .join(" ");
        const header = p === 1 ? "" : `\n\n--- Page ${p} ---\n\n`;
        full += header + pageText;
        if (full.length >= PDF_TEXT_CHAR_LIMIT) {
          truncated = true;
          break;
        }
      } finally {
        page.cleanup?.();
      }
    }
  } finally {
    await doc.destroy?.();
  }

  const textChars = full.length;
  if (squashWhitespace(full).length === 0) {
    throw new Error(`"${file.name}" has no extractable text — looks scanned.`);
  }

  let text = full;
  if (truncated) {
    text =
      full.slice(0, PDF_TEXT_CHAR_LIMIT) +
      `\n\n[…truncated; original length ${textChars.toLocaleString()} chars across ${doc.numPages} pages]`;
  }

  const excerpt = squashWhitespace(full.slice(0, PDF_EXCERPT_CHARS * 2)).slice(
    0,
    PDF_EXCERPT_CHARS
  );

  return {
    id: newId(),
    name: file.name,
    pageCount: doc.numPages,
    bytes: file.size,
    text,
    textChars,
    truncated,
    excerpt,
  };
}

// ---------------------------------------------------------------------------
// PDF → HTML import (best-effort, editable).
//
// PDF stores positioned glyphs, not document structure, so this is intentionally
// approximate: we group text items into lines by their y-position, join lines
// into paragraphs on large vertical gaps, and promote a line to a heading when
// its font size is materially larger than the document's most common size. The
// result is clean, reflowable, editable HTML — fonts, columns, exact layout, and
// images are NOT preserved (import the original .docx for fidelity).

type ImportLine = { y: number; size: number; parts: Array<{ x: number; str: string }> };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function itemFontSize(it: PdfTextItem): number {
  if (it.transform && it.transform.length >= 4) {
    const h = Math.hypot(it.transform[2], it.transform[3]);
    if (h > 0) return h;
  }
  return it.height && it.height > 0 ? it.height : 12;
}

// Bucket text items into visual lines. Items sharing roughly the same baseline
// (within half their font size) belong to one line; within a line we sort by x.
function itemsToLines(items: PdfTextItem[]): ImportLine[] {
  const lines: ImportLine[] = [];
  for (const it of items) {
    const str = typeof it.str === "string" ? it.str : "";
    if (!str) continue;
    const tr = it.transform;
    const y = tr && tr.length >= 6 ? tr[5] : 0;
    const x = tr && tr.length >= 6 ? tr[4] : 0;
    const size = itemFontSize(it);
    const tol = Math.max(size * 0.5, 2);
    const line = lines.find((l) => Math.abs(l.y - y) <= tol);
    if (line) {
      line.parts.push({ x, str });
      line.size = Math.max(line.size, size);
    } else {
      lines.push({ y, size, parts: [{ x, str }] });
    }
  }
  // PDF y grows upward, so sort top-to-bottom by descending y.
  lines.sort((a, b) => b.y - a.y);
  for (const l of lines) l.parts.sort((a, b) => a.x - b.x);
  return lines;
}

function lineText(line: ImportLine): string {
  return squashWhitespace(line.parts.map((p) => p.str).join(" "));
}

// Modal (most common, rounded) font size — our baseline for "body text". Lines
// noticeably larger than this read as headings.
function modalSize(lines: ImportLine[]): number {
  const counts = new Map<number, number>();
  for (const l of lines) {
    const k = Math.round(l.size);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = 12;
  let bestCount = -1;
  for (const [size, count] of counts) {
    if (count > bestCount) {
      best = size;
      bestCount = count;
    }
  }
  return best || 12;
}

// A line that begins with a bullet glyph starts a list item. Dash/star variants
// require a trailing space so we don't mistake a sentence that opens with a
// hyphen or an em-dash for a list.
const BULLET_RE = /^\s*(?:[•·▪◦‣●○∙◆■▸▹»]|[-–—*]\s)\s*/;
function isBullet(t: string): boolean {
  return BULLET_RE.test(t);
}
function stripBullet(t: string): string {
  return t.replace(BULLET_RE, "").trim();
}
// Short, fully-uppercase lines (SUMMARY, EXPERIENCE, SKILLS) read as section
// headings even when their font is only marginally larger than body text — a
// common résumé/report pattern PDFs don't otherwise signal. Require ≥4 letters
// so stray all-caps fragments (e.g. a wrapped "ARR") aren't promoted.
function isAllCapsHeading(t: string): boolean {
  if (t.length > 48) return false;
  const letters = t.replace(/[^A-Za-z]/g, "");
  return letters.length >= 4 && letters === letters.toUpperCase();
}

/**
 * Convert a text-based `.pdf` File into a full, standalone HTML document for
 * `note.artifactHtml`. Throws the same "looks scanned" error as
 * `fileToAttachedPdf` when there's no extractable text.
 */
export async function pdfToNoteHtml(file: File): Promise<string> {
  if (file.size > MAX_PDF_BYTES) {
    throw new Error(
      `PDF "${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — limit is ${Math.round(
        MAX_PDF_BYTES / 1024 / 1024
      )} MB.`
    );
  }

  const data = await readArrayBuffer(file);
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;

  const allLines: ImportLine[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      try {
        const tc = await page.getTextContent();
        allLines.push(...itemsToLines(tc.items));
      } finally {
        page.cleanup?.();
      }
    }
  } finally {
    await doc.destroy?.();
  }

  if (allLines.every((l) => squashWhitespace(lineText(l)).length === 0)) {
    throw new Error(`"${file.name}" has no extractable text — looks scanned.`);
  }

  const base = modalSize(allLines);
  const blocks: string[] = [];
  let para: string[] = [];
  let list: string[] = []; // inner HTML of the <li>s in the open list
  let listX = 0; // x of the open list's bullet glyph (for wrap detection)

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(`<p>${escapeHtml(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(
      `<ul>\n${list.map((li) => `<li>${escapeHtml(li)}</li>`).join("\n")}\n</ul>`
    );
    list = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
  };

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    const text = lineText(line);
    if (!text) continue;
    const x0 = line.parts.length ? line.parts[0].x : 0;

    // Heading inference: a materially larger line, kept short, becomes a heading.
    const ratio = line.size / base;
    if (ratio >= 1.25 && text.length <= 120) {
      flushAll();
      const tag = ratio >= 1.6 ? "h1" : "h2";
      blocks.push(`<${tag}>${escapeHtml(text)}</${tag}>`);
      continue;
    }

    // A bullet line opens (or extends) a list. Each bullet is its own <li>.
    if (isBullet(text)) {
      flushPara();
      list.push(stripBullet(text));
      listX = x0;
      continue;
    }

    // Short all-caps section labels become headings (checked after bullets so a
    // rare all-caps bullet isn't misread).
    if (isAllCapsHeading(text)) {
      flushAll();
      blocks.push(`<h2>${escapeHtml(text)}</h2>`);
      continue;
    }

    // A non-bullet line indented past the open list's bullet is the wrapped
    // continuation of the current item — fold it back in.
    if (list.length > 0 && x0 > listX + 2) {
      list[list.length - 1] = `${list[list.length - 1]} ${text}`.trim();
      continue;
    }

    // Body text. Leaving a list closes it first.
    flushList();
    para.push(text);

    // Paragraph break on a large vertical gap to the next line.
    const next = allLines[i + 1];
    if (next) {
      const gap = line.y - next.y;
      if (gap > line.size * 1.8) flushPara();
    }
  }
  flushAll();

  const fragment = blocks.join("\n") || "<p></p>";
  return wrapInPageHtml(fragment, titleFromFilename(file.name));
}

export function formatPdfBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
