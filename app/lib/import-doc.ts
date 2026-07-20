"use client";

// docx → HTML import for the note canvas. Converts an uploaded Word document
// into a self-contained HTML document we store in `note.artifactHtml`, where the
// existing canvas editor (preview iframe + textarea + AI tools) edits it and the
// export paths turn it back into docx/pdf. See app/lib/page-html.ts for why the
// output must be a full document, and app/components/note-canvas/note-preview.tsx
// for why images MUST be inline data URIs (the preview iframe is `allow-scripts`
// only — no network, no same-origin).

import { wrapInPageHtml, titleFromFilename } from "@/app/lib/page-html";

export { titleFromFilename };

export const MAX_DOCX_BYTES = 25 * 1024 * 1024;

// Minimal shape of the mammoth browser build we rely on. We import lazily so the
// (~150-200 KB) bundle only loads when the user actually imports a document.
type MammothModule = {
  convertToHtml: (
    input: { arrayBuffer: ArrayBuffer },
    options?: { convertImage?: unknown; styleMap?: string[] }
  ) => Promise<{ value: string; messages: Array<{ type: string; message: string }> }>;
  images: {
    imgElement: (
      fn: (image: {
        read: (encoding: string) => Promise<string>;
        contentType: string;
      }) => Promise<{ src: string }>
    ) => unknown;
  };
};

let mammothPromise: Promise<MammothModule> | null = null;

async function loadMammoth(): Promise<MammothModule> {
  if (!mammothPromise) {
    // The *browser* build — the bare `mammoth` entry pulls in node:fs/path and
    // breaks the client bundle.
    mammothPromise = import("mammoth/mammoth.browser").then(
      (m) => (m.default ?? m) as unknown as MammothModule
    );
  }
  return mammothPromise;
}

function readArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as ArrayBuffer);
    fr.onerror = () => reject(fr.error ?? new Error("failed to read file"));
    fr.readAsArrayBuffer(file);
  });
}

/**
 * Convert a `.docx` File into a full, standalone HTML document suitable for
 * `note.artifactHtml`. Preserves headings, bold/italic/underline, ordered and
 * unordered lists, tables, links, and inline images (emitted as data URIs).
 * Exact fonts/sizes/colors/columns are approximated — mammoth is semantic, not
 * pixel-faithful, which is the right tradeoff for an *editable* document.
 */
export async function docxToNoteHtml(file: File): Promise<string> {
  if (file.size > MAX_DOCX_BYTES) {
    throw new Error(
      `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — limit is ${Math.round(
        MAX_DOCX_BYTES / 1024 / 1024
      )} MB.`
    );
  }

  const arrayBuffer = await readArrayBuffer(file);
  const mammoth = await loadMammoth();

  const { value: fragment } = await mammoth.convertToHtml(
    { arrayBuffer },
    {
      // Inline images as base64 data URIs so they render in the sandboxed
      // (network-less) preview iframe and survive into the exported docx.
      convertImage: mammoth.images.imgElement(async (image) => {
        const base64 = await image.read("base64");
        return { src: `data:${image.contentType};base64,${base64}` };
      }),
    }
  );

  if (!fragment.trim()) {
    throw new Error(`"${file.name}" appears to be empty.`);
  }

  return wrapInPageHtml(fragment, titleFromFilename(file.name));
}
