"use client";

// HTML → docx walker, used to export an edited canvas document (stored as a full
// HTML string in `note.artifactHtml`) back to a Word file. Parses the HTML with
// the browser's DOMParser (client-side) and maps the DOM onto nodes from the
// existing `docx` dependency — no new library. Scope (v1): paragraphs, h1–h6,
// bold/italic/underline, ul/ol (one level of nesting), <a>, <table>, and inline
// images decoded from base64 data URIs. Exotic CSS is ignored.

type Docx = typeof import("docx");
type DocxBlock = InstanceType<Docx["Paragraph"]> | InstanceType<Docx["Table"]>;
type InlineRun =
  | InstanceType<Docx["TextRun"]>
  | InstanceType<Docx["ExternalHyperlink"]>
  | InstanceType<Docx["ImageRun"]>;

// Twentieths of a point — mirror the spacing used by the markdown docx path in
// app/lib/export-note.ts so mixed exports look consistent.
const PARAGRAPH_SPACING = { after: 200 };
const HEADING_SPACING = { before: 240, after: 120 };
const BULLET_SPACING = { after: 80 };
// A4 content width (210mm − 2×25mm margins) in points, used to cap image width.
const MAX_IMAGE_WIDTH_PT = 453;

type Fmt = { bold?: boolean; italics?: boolean; underline?: boolean };
type ImgInfo = { data: Uint8Array; type: "png" | "jpg" | "gif" | "bmp"; w: number; h: number };

function decodeDataUri(src: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
  if (!m) return null;
  const mime = m[1];
  const isBase64 = !!m[2];
  const payload = m[3];
  try {
    if (isBase64) {
      const bin = atob(payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { bytes, mime };
    }
    return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mime };
  } catch {
    return null;
  }
}

function mimeToImageType(mime: string): ImgInfo["type"] | null {
  if (/png/i.test(mime)) return "png";
  if (/jpe?g/i.test(mime)) return "jpg";
  if (/gif/i.test(mime)) return "gif";
  if (/bmp/i.test(mime)) return "bmp";
  return null; // svg & friends skipped in v1
}

function loadImageDims(src: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const done = (v: { w: number; h: number } | null) => resolve(v);
    img.onload = () => done({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
    img.onerror = () => done(null);
    img.src = src;
    // Belt-and-braces: don't hang the export on a broken image.
    setTimeout(() => done({ w: 0, h: 0 }), 4000);
  });
}

// Pre-load every <img data:...> so the synchronous DOM walk can size images.
async function collectImages(doc: Document): Promise<Map<string, ImgInfo>> {
  const out = new Map<string, ImgInfo>();
  const imgs = Array.from(doc.querySelectorAll("img"));
  await Promise.all(
    imgs.map(async (el) => {
      const src = el.getAttribute("src") ?? "";
      if (!src.startsWith("data:") || out.has(src)) return;
      const decoded = decodeDataUri(src);
      if (!decoded) return;
      const type = mimeToImageType(decoded.mime);
      if (!type) return;
      const dims = await loadImageDims(src);
      let w = dims?.w || 0;
      let h = dims?.h || 0;
      if (w <= 0 || h <= 0) {
        w = 400;
        h = 300;
      }
      // Scale to fit the content width, preserving aspect ratio.
      if (w > MAX_IMAGE_WIDTH_PT) {
        h = Math.round((h * MAX_IMAGE_WIDTH_PT) / w);
        w = MAX_IMAGE_WIDTH_PT;
      }
      out.set(src, { data: decoded.bytes, type, w, h });
    })
  );
  return out;
}

export async function htmlToDocxBlocks(html: string): Promise<DocxBlock[]> {
  const docx = await import("docx");
  const { Paragraph, TextRun, ExternalHyperlink, ImageRun, Table, TableRow, TableCell, HeadingLevel, WidthType } =
    docx;

  const doc = new DOMParser().parseFromString(html, "text/html");
  const images = await collectImages(doc);

  const headingFor = (tag: string) => {
    switch (tag) {
      case "h1":
        return HeadingLevel.HEADING_1;
      case "h2":
        return HeadingLevel.HEADING_2;
      case "h3":
        return HeadingLevel.HEADING_3;
      case "h4":
        return HeadingLevel.HEADING_4;
      case "h5":
        return HeadingLevel.HEADING_5;
      default:
        return HeadingLevel.HEADING_6;
    }
  };

  function imageRun(src: string): InstanceType<Docx["ImageRun"]> | null {
    const info = images.get(src);
    if (!info) return null;
    return new ImageRun({
      data: info.data,
      type: info.type,
      transformation: { width: info.w, height: info.h },
    });
  }

  // Collect inline runs from a node, threading bold/italic/underline context.
  function inlineRuns(node: Node, fmt: Fmt): InlineRun[] {
    const runs: InlineRun[] = [];
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent ?? "").replace(/\s+/g, " ");
        if (text) {
          runs.push(
            new TextRun({
              text,
              bold: fmt.bold,
              italics: fmt.italics,
              // docx expects an underline *object*, not a boolean.
              ...(fmt.underline ? { underline: {} } : {}),
            })
          );
        }
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (tag === "br") {
        runs.push(new TextRun({ text: "", break: 1 }));
        return;
      }
      if (tag === "img") {
        const run = imageRun(el.getAttribute("src") ?? "");
        if (run) runs.push(run);
        return;
      }
      if (tag === "a") {
        const link = el.getAttribute("href");
        const children = inlineRuns(el, fmt).filter(
          (r): r is InstanceType<Docx["TextRun"]> => r instanceof TextRun
        );
        if (link && children.length) {
          runs.push(new ExternalHyperlink({ children, link }));
        } else {
          runs.push(...inlineRuns(el, fmt));
        }
        return;
      }
      const nextFmt: Fmt = { ...fmt };
      if (tag === "strong" || tag === "b") nextFmt.bold = true;
      if (tag === "em" || tag === "i") nextFmt.italics = true;
      if (tag === "u") nextFmt.underline = true;
      runs.push(...inlineRuns(el, nextFmt));
    });
    return runs;
  }

  function listItems(
    listEl: Element,
    ordered: boolean,
    level: number,
    out: DocxBlock[]
  ): void {
    let index = 1;
    Array.from(listEl.children).forEach((li) => {
      if (li.tagName.toLowerCase() !== "li") return;
      // Inline content of the <li> (excluding any nested list).
      const inlineFrag = li.cloneNode(true) as Element;
      Array.from(inlineFrag.querySelectorAll("ul,ol")).forEach((n) => n.remove());
      const runs = inlineRuns(inlineFrag, {});
      const prefix = ordered ? [new TextRun({ text: `${index}. ` })] : [];
      out.push(
        new Paragraph({
          ...(ordered ? { indent: { left: 360 * (level + 1) } } : { bullet: { level } }),
          spacing: BULLET_SPACING,
          children: [...prefix, ...runs],
        })
      );
      index++;
      // One level of nesting.
      Array.from(li.children).forEach((sub) => {
        const subTag = sub.tagName.toLowerCase();
        if (subTag === "ul" || subTag === "ol") {
          listItems(sub, subTag === "ol", level + 1, out);
        }
      });
    });
  }

  function tableFor(tableEl: Element): InstanceType<Docx["Table"]> {
    const rows: InstanceType<Docx["TableRow"]>[] = [];
    Array.from(tableEl.querySelectorAll("tr")).forEach((tr) => {
      const cells: InstanceType<Docx["TableCell"]>[] = [];
      Array.from(tr.children).forEach((cell) => {
        const tag = cell.tagName.toLowerCase();
        if (tag !== "td" && tag !== "th") return;
        const runs = inlineRuns(cell, tag === "th" ? { bold: true } : {});
        cells.push(
          new TableCell({
            children: [new Paragraph({ children: runs })],
          })
        );
      });
      if (cells.length) rows.push(new TableRow({ children: cells }));
    });
    return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
  }

  const blocks: DocxBlock[] = [];

  function walk(node: Node): void {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent ?? "").trim();
        if (text) blocks.push(new Paragraph({ spacing: PARAGRAPH_SPACING, children: [new TextRun(text)] }));
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        blocks.push(
          new Paragraph({
            heading: headingFor(tag),
            spacing: HEADING_SPACING,
            children: inlineRuns(el, { bold: true }),
          })
        );
      } else if (tag === "p") {
        blocks.push(new Paragraph({ spacing: PARAGRAPH_SPACING, children: inlineRuns(el, {}) }));
      } else if (tag === "ul" || tag === "ol") {
        listItems(el, tag === "ol", 0, blocks);
      } else if (tag === "table") {
        blocks.push(tableFor(el));
      } else if (tag === "img") {
        const run = imageRun(el.getAttribute("src") ?? "");
        if (run) blocks.push(new Paragraph({ spacing: PARAGRAPH_SPACING, children: [run] }));
      } else if (tag === "br" || tag === "hr") {
        blocks.push(new Paragraph({ children: [] }));
      } else {
        // Container (div/section/article/etc.) — recurse into its children.
        walk(el);
      }
    });
  }

  // Prefer the document "page" wrapper produced by wrapInPageHtml; fall back to
  // the whole body for AI-rewritten HTML that may have dropped the wrapper.
  const root = doc.querySelector(".doc-page") ?? doc.body;
  if (root) walk(root);

  if (blocks.length === 0) {
    blocks.push(new Paragraph({ children: [new TextRun("")] }));
  }
  return blocks;
}
