import type { StoredPinnedNote } from "@/app/db";

export type ExportFormat = "markdown" | "docx" | "pdf";

type MdBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "paragraph"; text: string };

// Tiny line-based markdown parser. Recognises ATX headings (#, ##, ###) and
// unordered bullets (-, *). Inline marks (**bold**, _italic_) are preserved as
// literal text in DOCX/PDF output for v1. Blank lines split paragraphs.
function parseMarkdown(md: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, text: heading[2].trim() });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      blocks.push({ kind: "bullet", text: bullet[1].trim() });
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

function firstLineOfMarkdown(md: string): string {
  const heading = /^\s*#{1,6}\s+(.+?)\s*$/m.exec(md);
  if (heading) return heading[1];
  for (const line of md.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

function deriveNoteTitle(note: StoredPinnedNote): string {
  return (
    note.title?.trim() ||
    note.summary?.trim() ||
    (note.messageMarkdown ? firstLineOfMarkdown(note.messageMarkdown).trim() : "") ||
    note.chatTitle?.trim() ||
    note.chatSnapshot?.title?.trim() ||
    "note"
  );
}

function safeFilename(note: StoredPinnedNote, ext: string): string {
  // Strip markdown emphasis / code marks, and unwrap [text](url) to "text" so
  // the filename reflects the rendered title, not its markdown source.
  const unmarked = deriveNoteTitle(note)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~#>]+/g, "");
  const base =
    unmarked
      // Remove characters that are illegal in filenames on Windows/macOS, plus
      // control chars. Everything else (letters incl. unicode, digits, dashes,
      // parens, etc.) is preserved.
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80)
      .replace(/\s+/g, "_")
      .replace(/^[._]+|[._]+$/g, "") || "note";
  return `${base}.${ext}`;
}

function triggerDownload(filename: string, mime: string, body: BlobPart): void {
  const blob = body instanceof Blob ? body : new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Lightweight HTML → plain text for the markdown export of a document note.
// Not a full converter — block tags become line breaks, the rest is stripped —
// but it beats dumping raw markup or a misleading placeholder.
function htmlToPlainText(html: string): string {
  return html
    .replace(/<\s*(script|style|head)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|h[1-6]|li|tr)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildNoteMarkdown(note: StoredPinnedNote): string {
  const parts: string[] = [];
  if (note.messageMarkdown) parts.push(note.messageMarkdown.trim());
  if (note.artifactHtml) {
    const text = htmlToPlainText(note.artifactHtml);
    if (text) parts.push(text);
  }
  if (note.chatSnapshot) {
    parts.push("## Chat copy");
    for (const m of note.chatSnapshot.messages) {
      parts.push(`**${m.role}:** ${m.content}`);
    }
  }
  return parts.join("\n\n") + "\n";
}

export function downloadNoteAsMarkdown(note: StoredPinnedNote): void {
  triggerDownload(safeFilename(note, "md"), "text/markdown", buildNoteMarkdown(note));
}

export async function downloadNoteAsDocx(note: StoredPinnedNote): Promise<void> {
  const {
    Document,
    Packer,
    Paragraph,
    HeadingLevel,
    TextRun,
  } = await import("docx");

  // Spacing is in twentieths of a point (240 = 12pt). Required because Word/Docs
  // render Paragraphs flush by default, losing the preview's blank-line gaps.
  const PARAGRAPH_SPACING = { after: 200 };
  const HEADING_SPACING = { before: 240, after: 120 };
  const BULLET_SPACING = { after: 80 };

  const children: Array<
    import("docx").Paragraph | import("docx").Table
  > = [];

  if (note.messageMarkdown) {
    for (const block of parseMarkdown(note.messageMarkdown)) {
      if (block.kind === "heading") {
        const heading =
          block.level === 1
            ? HeadingLevel.HEADING_1
            : block.level === 2
              ? HeadingLevel.HEADING_2
              : HeadingLevel.HEADING_3;
        children.push(
          new Paragraph({
            heading,
            spacing: HEADING_SPACING,
            children: [new TextRun({ text: block.text, bold: true })],
          })
        );
      } else if (block.kind === "bullet") {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: BULLET_SPACING,
            children: [new TextRun(block.text)],
          })
        );
      } else {
        children.push(
          new Paragraph({
            spacing: PARAGRAPH_SPACING,
            children: [new TextRun(block.text)],
          })
        );
      }
    }
  }

  if (note.artifactHtml) {
    // Walk the document HTML (imported docx/pdf or a pinned artifact) into real
    // docx blocks so formatting survives the round-trip.
    const { htmlToDocxBlocks } = await import("@/app/lib/export-html-docx");
    children.push(...(await htmlToDocxBlocks(note.artifactHtml)));
  }

  if (note.chatSnapshot) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: HEADING_SPACING,
        children: [new TextRun({ text: "Chat copy", bold: true })],
      })
    );
    for (const m of note.chatSnapshot.messages) {
      children.push(
        new Paragraph({
          spacing: PARAGRAPH_SPACING,
          children: [
            new TextRun({ text: `${m.role}: `, bold: true }),
            new TextRun(m.content),
          ],
        })
      );
    }
  }

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  triggerDownload(safeFilename(note, "docx"), blob.type, blob);
}

export type PdfExportOptions = {
  /**
   * For HTML-artifact notes: snap page breaks to blank rows so text isn't
   * sliced across pages (default true). Ignored for markdown / snapshot notes,
   * whose jsPDF text layout already breaks between lines.
   */
  smartPageBreaks?: boolean;
  /**
   * For HTML-artifact notes: uniform page margin (all sides) in PostScript
   * points. Ignored for markdown / snapshot notes (their layout has its own
   * fixed margin).
   */
  marginPt?: number;
};

export async function downloadNoteAsPdf(
  note: StoredPinnedNote,
  options: PdfExportOptions = {}
): Promise<void> {
  // HTML-bodied notes (imported documents / artifacts) are a full styled page.
  // Render them to a real .pdf that mirrors the on-screen preview and download it
  // directly — see export-artifact-pdf for why we don't use window.print() (it
  // prints the host app, not the artifact, on iOS). The jsPDF text layout below
  // stays the exporter for markdown / snapshot notes.
  if (note.artifactHtml) {
    const { exportArtifactPdf } = await import("@/app/lib/export-artifact-pdf");
    await exportArtifactPdf(note.artifactHtml, {
      filename: safeFilename(note, "pdf"),
      smartPageBreaks: options.smartPageBreaks,
      marginPt: options.marginPt,
    });
    return;
  }

  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 56;
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  const ensureSpace = (lineHeight: number) => {
    if (y + lineHeight > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const writeBlock = (
    text: string,
    opts: { size: number; bold?: boolean; gapAfter: number; indent?: number }
  ) => {
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(opts.size);
    const indent = opts.indent ?? 0;
    const lines = doc.splitTextToSize(text, maxWidth - indent) as string[];
    const lineHeight = opts.size * 1.35;
    for (const line of lines) {
      ensureSpace(lineHeight);
      doc.text(line, margin + indent, y);
      y += lineHeight;
    }
    y += opts.gapAfter;
  };

  if (note.messageMarkdown) {
    for (const block of parseMarkdown(note.messageMarkdown)) {
      if (block.kind === "heading") {
        const size = block.level === 1 ? 20 : block.level === 2 ? 16 : 14;
        writeBlock(block.text, { size, bold: true, gapAfter: 6 });
      } else if (block.kind === "bullet") {
        writeBlock(`• ${block.text}`, { size: 11, gapAfter: 2, indent: 12 });
      } else {
        writeBlock(block.text, { size: 11, gapAfter: 8 });
      }
    }
  }

  if (note.chatSnapshot) {
    writeBlock("Chat copy", { size: 14, bold: true, gapAfter: 6 });
    for (const m of note.chatSnapshot.messages) {
      writeBlock(`${m.role}:`, { size: 10, bold: true, gapAfter: 2 });
      writeBlock(m.content, { size: 10, gapAfter: 6, indent: 12 });
    }
  }

  const blob = doc.output("blob");
  triggerDownload(safeFilename(note, "pdf"), "application/pdf", blob);
}

export async function downloadNote(
  note: StoredPinnedNote,
  format: ExportFormat,
  options: PdfExportOptions = {}
): Promise<void> {
  if (format === "markdown") return downloadNoteAsMarkdown(note);
  if (format === "docx") return downloadNoteAsDocx(note);
  if (format === "pdf") return downloadNoteAsPdf(note, options);
}
