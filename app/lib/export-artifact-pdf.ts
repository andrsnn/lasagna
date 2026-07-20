// Client-side PDF export for HTML artifacts.
//
// Why not window.print()? Printing an artifact iframe is unreliable on mobile:
// iOS Safari ignores `iframe.contentWindow.print()` and prints the TOP-LEVEL
// page instead, so the "PDF" came out as a screenshot of the app (export dialog
// and all) rather than the artifact. This path produces a real .pdf file and
// downloads it directly - no system print dialog - and it renders the artifact
// exactly as it appears on screen.
//
// How: reuse the offscreen, opaque-origin capture from export-artifact-image
// (renders the artifact incl. JS-built DOM, serializes to SVG without touching
// our origin), rasterize to a canvas on the parent side, then slice that tall
// canvas into A4-height pages and assemble a jsPDF. The result is an image-based
// PDF that's a pixel-faithful copy of the preview (text isn't selectable - that's
// the trade for matching the design exactly; use DOCX for an editable export).

import {
  captureArtifactSvg,
  rasterizeSvgToCanvas,
} from "@/app/lib/export-artifact-image";

// A4 at 96 CSS dpi. We render the artifact at the page's content width so its own
// responsive layout settles to a document-sized column, then paginate by height.
const A4_WIDTH_PX = 794;
// A4 in PostScript points (jsPDF "pt" unit).
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
// Uniform page margin (all four sides) when the caller doesn't specify one.
// ~0.75in - a moderate "Normal" print margin. Clamped so a content area always
// remains. The export dialog offers named presets that resolve to a pt value.
const DEFAULT_MARGIN_PT = 54;
const MAX_MARGIN_PT = 144; // 2in - keeps a usable content area on A4
// Oversample so text stays crisp in the rasterized page.
const SCALE = 2;
// Per-page encoding. JPEG over PNG: a rasterized full-page document (lots of
// anti-aliased text) encodes to tens of MB as PNG but a few hundred KB as JPEG;
// at this quality on a white page the difference is imperceptible at read zoom.
const PAGE_IMAGE_TYPE = "image/jpeg";
const PAGE_IMAGE_QUALITY = 0.92;
// Backstop against a pathological artifact producing an enormous canvas.
const MAX_CONTENT_HEIGHT = 20000;

export type ExportArtifactPdfOptions = {
  /** Download filename (with or without the .pdf extension). */
  filename?: string;
  /**
   * When true (default), page boundaries snap to a blank row so a line of text
   * is never sliced across pages. When false, pages are cut at the exact A4
   * height (text may be split mid-line) - which keeps every page exactly full
   * and the page count minimal.
   */
  smartPageBreaks?: boolean;
  /**
   * Uniform margin on all four sides, in PostScript points (72pt = 1in).
   * Defaults to {@link DEFAULT_MARGIN_PT}; clamped to [0, {@link MAX_MARGIN_PT}].
   */
  marginPt?: number;
};

// Choose where each page ends. A naive cut every `pageHeightPx` slices straight
// through whatever line of text straddles the boundary (the bug this fixes). So
// for each page we aim for `pageHeightPx` but search UPWARD for a "blank" row -
// one where every sampled pixel is the same shade (a gap between text lines, or
// uniform background) - and cut there instead, so no glyph is bisected. We never
// back up past half a page, so this can't produce near-empty sheets; if no blank
// row exists in range (e.g. a dense photo/gradient spanning the seam) we fall
// back to the hard cut. Works for white and solid-colored backgrounds alike.
//
// Returns the ascending y offsets that END each page; the last entry is
// `totalHeight`. Reads the canvas pixels once up front.
// Naive pagination: cut at every exact page height. May split a line of text
// across the seam, but keeps each page exactly full. Used when the caller turns
// smart page breaks off.
function hardPageBreaks(totalHeight: number, pageHeightPx: number): number[] {
  const breaks: number[] = [];
  for (let end = pageHeightPx; end < totalHeight; end += pageHeightPx) {
    breaks.push(end);
  }
  breaks.push(totalHeight);
  return breaks;
}

function computePageBreaks(
  ctx: CanvasRenderingContext2D,
  width: number,
  totalHeight: number,
  pageHeightPx: number
): number[] {
  const breaks: number[] = [];
  const { data } = ctx.getImageData(0, 0, width, totalHeight);
  // Sample ~240 columns per row - enough to catch a thin descender without
  // scanning every pixel.
  const colStep = Math.max(1, Math.floor(width / 240));
  // Max luminance spread (0-255) for a row to count as blank. Small but nonzero
  // to tolerate anti-aliasing / subtle texture in the background.
  const tol = 22;
  const maxLookback = Math.floor(pageHeightPx * 0.18);

  const rowIsBlank = (y: number): boolean => {
    let min = 255;
    let max = 0;
    const base = y * width * 4;
    for (let x = 0; x < width; x += colStep) {
      const i = base + x * 4;
      const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      if (lum < min) min = lum;
      if (lum > max) max = lum;
      if (max - min > tol) return false;
    }
    return true;
  };

  let start = 0;
  while (start < totalHeight) {
    const ideal = start + pageHeightPx;
    if (ideal >= totalHeight) {
      breaks.push(totalHeight);
      break;
    }
    const floor = Math.max(
      start + Math.floor(pageHeightPx * 0.5),
      ideal - maxLookback
    );
    let cut = ideal;
    for (let y = ideal; y >= floor; y--) {
      if (rowIsBlank(y)) {
        cut = y;
        break;
      }
    }
    breaks.push(cut);
    start = cut;
  }
  return breaks;
}

function ensurePdfExt(name: string): string {
  const base = (name || "artifact").trim() || "artifact";
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

function triggerDownload(blob: Blob, filename: string): void {
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

/**
 * Render the given artifact HTML to a multi-page A4 PDF and download it.
 * Resolves once the download has been triggered. Throws on failure so the caller
 * can surface an error to the user.
 */
export async function exportArtifactPdf(
  html: string,
  options: ExportArtifactPdfOptions = {}
): Promise<void> {
  if (typeof window === "undefined") {
    throw new Error("PDF export is only available in the browser.");
  }

  const capture = await captureArtifactSvg(html, {
    width: A4_WIDTH_PX,
    maxHeight: MAX_CONTENT_HEIGHT,
  });
  const canvas = await rasterizeSvgToCanvas(
    capture.svg,
    capture.width,
    capture.height,
    SCALE
  );

  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "pt", format: "a4" });

  // The full render is `canvas.width` px wide and is scaled to fit the content
  // area (the sheet minus a uniform margin on all four sides). One page therefore
  // holds the content-area height worth of pixels. Walk down the canvas a page at
  // a time, copying each strip onto a scratch canvas and placing it inside the
  // margins on its own sheet.
  const marginPt = Math.min(
    MAX_MARGIN_PT,
    Math.max(0, options.marginPt ?? DEFAULT_MARGIN_PT)
  );
  const contentWidthPt = A4_WIDTH_PT - marginPt * 2;
  const contentHeightPt = A4_HEIGHT_PT - marginPt * 2;
  const pageWidthPx = canvas.width;
  const totalHeightPx = canvas.height;
  // px per pt when the full-width render is scaled down to the content width.
  const pxPerPt = pageWidthPx / contentWidthPt;
  const pageHeightPx = Math.round(contentHeightPt * pxPerPt);

  const breaks =
    options.smartPageBreaks === false
      ? hardPageBreaks(totalHeightPx, pageHeightPx)
      : (() => {
          const canvasCtx = canvas.getContext("2d");
          if (!canvasCtx) throw new Error("Couldn't get a canvas context.");
          return computePageBreaks(
            canvasCtx,
            pageWidthPx,
            totalHeightPx,
            pageHeightPx
          );
        })();

  const scratch = document.createElement("canvas");
  const scratchCtx = scratch.getContext("2d");
  if (!scratchCtx) throw new Error("Couldn't get a canvas context.");

  let offset = 0;
  breaks.forEach((end, page) => {
    const sliceHeightPx = end - offset;
    scratch.width = pageWidthPx;
    scratch.height = sliceHeightPx;
    scratchCtx.fillStyle = "#ffffff";
    scratchCtx.fillRect(0, 0, pageWidthPx, sliceHeightPx);
    scratchCtx.drawImage(
      canvas,
      0,
      offset,
      pageWidthPx,
      sliceHeightPx,
      0,
      0,
      pageWidthPx,
      sliceHeightPx
    );

    const imgData = scratch.toDataURL(PAGE_IMAGE_TYPE, PAGE_IMAGE_QUALITY);
    if (page > 0) pdf.addPage();

    // Inset from all four sides by the margin. A short page (we cut early at a
    // blank row, or the final strip) keeps its proportional height, so it sits
    // below the top margin and leaves natural white space beneath rather than
    // being stretched to fill the sheet.
    const drawHeightPt = sliceHeightPx / pxPerPt;
    pdf.addImage(
      imgData,
      "JPEG",
      marginPt,
      marginPt,
      contentWidthPt,
      Math.min(drawHeightPt, contentHeightPt)
    );

    offset = end;
  });

  const blob = pdf.output("blob");
  triggerDownload(blob, ensurePdfExt(options.filename || "artifact"));
}
