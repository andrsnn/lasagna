// Regenerates app/lib/html-to-image-source.ts from the vendored html-to-image
// UMD bundle, embedding it as a string literal.
//
// Why embed instead of fetch: the image-export feature rasterizes artifacts in
// an opaque-origin sandboxed iframe. Loading the renderer over the network
// (either via <script src> from the frame, or a fetch from the parent) is
// fragile behind the auth proxy — cookieless/opaque requests for /vendor/* get
// redirected to the login page, so the renderer never loads. Bundling the
// source into the JS removes the network entirely.
//
// Run: node scripts/embed-html-to-image.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SRC = join(root, "public/vendor/html-to-image.min.js");
const OUT = join(root, "app/lib/html-to-image-source.ts");

const src = readFileSync(SRC, "utf8");
const banner =
  "// AUTO-GENERATED — do not edit by hand.\n" +
  "// Source: public/vendor/html-to-image.min.js (html-to-image UMD bundle).\n" +
  "// Embedded as a string so the image-export capture frame can inline the\n" +
  "// renderer with zero network requests (a fetch/<script src> is redirected to\n" +
  "// the login page by the auth proxy when it comes from the opaque-origin frame,\n" +
  "// and even a parent fetch can be intercepted/cached in production).\n" +
  "// Regenerate with: node scripts/embed-html-to-image.mjs\n";
const out = `${banner}export const HTML_TO_IMAGE_SOURCE = ${JSON.stringify(src)};\n`;
writeFileSync(OUT, out);
console.log(`wrote ${OUT} (${out.length} bytes, source ${src.length} chars)`);
