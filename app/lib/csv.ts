"use client";

import { type AttachedCsv, newId } from "@/app/db";

export const MAX_CSV_BYTES = 10 * 1024 * 1024;
export const MAX_CSVS_PER_MESSAGE = 5;
const CSV_TEXT_CHAR_LIMIT = 60_000;
const CSV_EXCERPT_CHARS = 280;

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function toMarkdownTable(headers: string[], rows: string[][]): string {
  const sep = headers.map(() => "---");
  const escape = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines: string[] = [
    "| " + headers.map(escape).join(" | ") + " |",
    "| " + sep.join(" | ") + " |",
  ];
  for (const row of rows) {
    const padded = headers.map((_, i) => escape(row[i] ?? ""));
    lines.push("| " + padded.join(" | ") + " |");
  }
  return lines.join("\n");
}

function squashWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function detectDelimiter(firstLine: string): string {
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  const semis = (firstLine.match(/;/g) ?? []).length;
  if (tabs > commas && tabs > semis) return "\t";
  if (semis > commas) return ";";
  return ",";
}

function parseLine(line: string, delimiter: string): string[] {
  if (delimiter === ",") return parseCsvLine(line);
  return line.split(delimiter).map((f) => f.replace(/^"|"$/g, "").trim());
}

export async function fileToAttachedCsv(file: File): Promise<AttachedCsv> {
  if (file.size > MAX_CSV_BYTES) {
    throw new Error(
      `CSV "${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — limit is ${Math.round(
        MAX_CSV_BYTES / 1024 / 1024
      )} MB.`
    );
  }

  const raw = await file.text();
  if (raw.trim().length === 0) {
    throw new Error(`"${file.name}" is empty.`);
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(`"${file.name}" has no data rows.`);
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = parseLine(lines[0], delimiter);
  const dataRows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    dataRows.push(parseLine(lines[i], delimiter));
  }

  const totalRows = dataRows.length;
  const columnCount = headers.length;

  let truncated = false;
  let includedRows = dataRows;
  let full = toMarkdownTable(headers, dataRows);

  if (full.length > CSV_TEXT_CHAR_LIMIT) {
    truncated = true;
    let lo = 1;
    let hi = dataRows.length;
    let best = 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = toMarkdownTable(headers, dataRows.slice(0, mid));
      if (candidate.length <= CSV_TEXT_CHAR_LIMIT) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    includedRows = dataRows.slice(0, best);
    full = toMarkdownTable(headers, includedRows);
  }

  let text = full;
  if (truncated) {
    text +=
      `\n\n[…truncated; showing ${includedRows.length} of ${totalRows} data rows, ${columnCount} columns]`;
  }

  const excerpt = squashWhitespace(
    headers.join(", ") + " — " + totalRows + " rows"
  ).slice(0, CSV_EXCERPT_CHARS);

  return {
    id: newId(),
    name: file.name,
    rowCount: totalRows,
    columnCount,
    bytes: file.size,
    headers,
    text,
    textChars: full.length,
    truncated,
    excerpt,
  };
}

export function formatCsvBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
