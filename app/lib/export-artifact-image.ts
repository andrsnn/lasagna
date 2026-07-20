// Full-height PNG export for HTML artifacts.
//
// Goals: capture the WHOLE artifact (top to bottom, not just the viewport),
// including content that artifacts build with JavaScript at runtime, WITHOUT
// granting the untrusted artifact access to our origin (cookies / IndexedDB).
//
// Approach (verified end-to-end in a headless browser):
//
//  1. The renderer source is BUNDLED into this module (imported as a string)
//     and inlined into the capture frame's srcdoc. We deliberately avoid loading
//     it over the network: a `<script src>` from inside the frame fails because
//     the frame has an opaque origin (no `allow-same-origin`), so its request
//     carries no session cookie and the auth proxy redirects the cookieless
//     `/vendor/...` request to the login page. Even a parent-side `fetch` proved
//     unreliable in production (it can resolve with proxied/login HTML instead
//     of the JS, leaving `htmlToImage` undefined → "Renderer failed to load").
//     Bundling removes the network entirely.
//
//  2. Render the artifact into an offscreen iframe sandboxed with
//     `allow-scripts` but NOT `allow-same-origin`. That gives it an opaque
//     origin — its scripts run (so JS-built DOM renders) but it can't reach our
//     origin. A small injected bootstrap waits for fonts/images, measures the
//     full document height, and uses html-to-image's `toSvg` to serialize the
//     whole document to an SVG, then postMessages it to the parent.
//
//  3. The parent (normal origin) draws that SVG into a canvas and exports a PNG.
//
// Why split serialization (frame) from rasterization (parent):
//   - html2canvas can't be used at all here: it clones the document into a
//     child iframe and reads it back, which is cross-origin-blocked inside an
//     opaque sandbox.
//   - html-to-image's `toPng`/`toCanvas` hang inside the opaque sandbox (the
//     final SVG-image -> canvas step never settles there). But `toSvg`, which
//     is pure DOM serialization, works. So we do serialization in the frame and
//     rasterization in the parent, where canvas access is unrestricted.
//
// The embedded source is generated from public/vendor/html-to-image.min.js by
// scripts/embed-html-to-image.mjs.

import { HTML_TO_IMAGE_SOURCE } from "./html-to-image-source";

export type ExportArtifactImageOptions = {
  /** Capture width in CSS px. Defaults to a phone-ish 420 if not provided. */
  width?: number;
  /** Download filename (without extension). */
  filename?: string;
  /** Device pixel scale for the output. Higher = sharper + bigger file. */
  scale?: number;
};

const DEFAULT_WIDTH = 420;
const DEFAULT_SCALE = 2;
// Guard against pathological artifacts producing a multi-hundred-MB canvas.
const MAX_HEIGHT = 20000;
// Marker so the parent only acts on messages from our own capture bootstrap.
const MSG_NS = "artifact-image-export";
// Overall safety valve so a hung artifact can never block the UI forever.
const TIMEOUT_MS = 30000;

type CaptureMessage =
  | { ns: typeof MSG_NS; ok: true; svg: string; width: number; height: number }
  | { ns: typeof MSG_NS; ok: false; error: string };

function sanitizeFilename(name: string): string {
  const base = name
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || "artifact";
}

// Bootstrap that runs *inside* the opaque-origin capture frame. Stringified and
// injected into the srcdoc, so it must be self-contained (no closure refs).
function buildBootstrap(maxHeight: number): string {
  return `
(function () {
  var NS = ${JSON.stringify(MSG_NS)};
  var MAX = ${JSON.stringify(maxHeight)};
  function post(msg) {
    try { msg.ns = NS; parent.postMessage(msg, "*"); } catch (e) {}
  }
  function fail(err) {
    post({ ok: false, error: (err && err.message) ? err.message : String(err) });
  }
  function settleImages() {
    var imgs = Array.prototype.slice.call(document.images || []);
    return Promise.all(imgs.map(function (img) {
      if (img.complete) return null;
      return new Promise(function (res) {
        img.addEventListener("load", res, { once: true });
        img.addEventListener("error", res, { once: true });
      });
    }));
  }
  function run() {
    if (typeof htmlToImage === "undefined" || !htmlToImage.toSvg) {
      fail(new Error("Renderer failed to load."));
      return;
    }
    var fontsReady = (document.fonts && document.fonts.ready) || Promise.resolve();
    Promise.resolve(fontsReady).catch(function () {}).then(settleImages).then(function () {
      // Give script-driven artifacts a beat to paint after assets settle. Use a
      // timer, NOT requestAnimationFrame: this capture frame is offscreen and
      // opacity:0, so the browser throttles its rendering and a rAF callback may
      // never fire (which would hang the export).
      return new Promise(function (r) { setTimeout(r, 64); });
    }).then(function () {
      var root = document.documentElement;
      var body = document.body;
      var height = Math.min(MAX, Math.max(
        root ? root.scrollHeight : 0,
        root ? root.offsetHeight : 0,
        body ? body.scrollHeight : 0,
        body ? body.offsetHeight : 0,
        1
      ));
      var width = Math.max(1, root ? root.clientWidth : window.innerWidth);
      // Serialize only — rasterizing to PNG inside an opaque-origin sandbox
      // hangs, so the parent does the canvas step.
      return htmlToImage.toSvg(body || root, {
        width: width,
        height: height,
        backgroundColor: "#ffffff",
        style: { margin: "0" },
      }).then(function (svg) {
        post({ ok: true, svg: svg, width: width, height: height });
      });
    }).catch(fail);
  }
  if (document.readyState === "complete") run();
  else window.addEventListener("load", run, { once: true });
})();
`;
}

// Inject the inlined renderer + bootstrap just before </body> (or append if the
// artifact omitted a body tag). Placing them last means the artifact's own
// markup/scripts have already been parsed. The renderer is inlined (not an
// external <script src>) so the opaque-origin frame makes no network request —
// see the file header for why an external load fails behind the auth proxy.
//
// `</script>` inside the renderer source would prematurely close our wrapper
// tag, so split any such sequence. (The vendored bundle has none today, but
// this keeps the injection robust if that changes.)
function injectCapture(
  html: string,
  rendererSource: string,
  maxHeight: number
): string {
  const safeRenderer = rendererSource.replace(/<\/(script)/gi, "<\\/$1");
  const inject =
    `<script>${safeRenderer}</script>` +
    `<script>${buildBootstrap(maxHeight)}</script>`;
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${inject}</body>`);
  }
  return html + inject;
}

// Draw an SVG data URL into a canvas at the given scale. Runs in the parent
// (normal origin) so canvas access isn't tainted/blocked. Shared by the PNG and
// PDF export paths.
export function rasterizeSvgToCanvas(
  svgDataUrl: string,
  width: number,
  height: number,
  scale: number
): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Couldn't get a canvas context.");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => reject(new Error("Couldn't render the artifact image."));
    img.src = svgDataUrl;
  });
}

async function rasterizeSvg(
  svgDataUrl: string,
  width: number,
  height: number,
  scale: number
): Promise<Blob> {
  const canvas = await rasterizeSvgToCanvas(svgDataUrl, width, height, scale);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Couldn't encode the image."));
    }, "image/png");
  });
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

export type ArtifactCapture = { svg: string; width: number; height: number };

/**
 * Render artifact HTML in an offscreen, opaque-origin frame and serialize the
 * full document to an SVG data URL (returned with its CSS pixel dimensions).
 * This is the shared, iOS-safe capture step behind both the PNG and PDF exports:
 * it renders the artifact exactly as it appears on screen (incl. JS-built DOM)
 * without granting it access to our origin. The caller rasterizes the SVG on the
 * parent side (see {@link rasterizeSvgToCanvas}).
 */
export async function captureArtifactSvg(
  html: string,
  options: { width?: number; maxHeight?: number } = {}
): Promise<ArtifactCapture> {
  if (typeof window === "undefined") {
    throw new Error("Artifact capture is only available in the browser.");
  }

  const width = Math.max(240, Math.round(options.width || DEFAULT_WIDTH));
  const maxHeight = options.maxHeight || MAX_HEIGHT;

  const iframe = document.createElement("iframe");
  // allow-scripts so the artifact renders (incl. JS-built DOM); NO
  // allow-same-origin, so this opaque-origin frame can't reach our cookies /
  // storage. Serialization happens inside the frame; the parent rasterizes.
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("tabindex", "-1");
  Object.assign(iframe.style, {
    position: "fixed",
    left: "-99999px",
    top: "0",
    // Give the frame a tall viewport up front so viewport-relative (vh) layouts
    // resolve sensibly before we measure the real content height.
    width: `${width}px`,
    height: "1200px",
    border: "0",
    background: "#ffffff",
    pointerEvents: "none",
    opacity: "0",
  } satisfies Partial<CSSStyleDeclaration>);
  iframe.srcdoc = injectCapture(html, HTML_TO_IMAGE_SOURCE, maxHeight);

  return new Promise<ArtifactCapture>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      iframe.remove();
    };
    const onMessage = (event: MessageEvent) => {
      if (settled) return;
      if (event.source !== iframe.contentWindow) return;
      const data = event.data as CaptureMessage | null;
      if (!data || data.ns !== MSG_NS) return;
      settled = true;
      cleanup();
      if (data.ok) resolve({ svg: data.svg, width: data.width, height: data.height });
      else reject(new Error(data.error || "Capture failed."));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Timed out rendering the artifact."));
    }, TIMEOUT_MS);
    window.addEventListener("message", onMessage);
    document.body.appendChild(iframe);
  });
}

/**
 * Render the given artifact HTML to a full-height PNG and download it.
 * Resolves once the download has been triggered. Throws on failure so the
 * caller can surface an error to the user.
 */
export async function exportArtifactImage(
  html: string,
  options: ExportArtifactImageOptions = {}
): Promise<void> {
  const scale = options.scale || DEFAULT_SCALE;
  const filename = `${sanitizeFilename(options.filename || "artifact")}.png`;

  const serialized = await captureArtifactSvg(html, { width: options.width });
  const blob = await rasterizeSvg(
    serialized.svg,
    serialized.width,
    serialized.height,
    scale
  );
  triggerDownload(blob, filename);
}
