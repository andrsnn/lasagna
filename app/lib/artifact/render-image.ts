// Server-side artifact → full-page PNG renderer.
//
// This runs ONLY in the Fly worker (worker/index.ts imports it), never in a
// Next.js route or the browser bundle — so puppeteer-core never ends up in the
// Vercel function. Rendering server-side is what makes the export reliable:
// iOS Safari can't rasterize a sandboxed artifact client-side (canvas tainting
// / foreignObject restrictions), but a headless Chromium on the server captures
// any artifact — including JS-built DOM and external images — and the phone
// only has to download the finished PNG.
//
// The Chromium binary is provided by the worker's Docker image (apk add
// chromium); its path comes from CHROMIUM_PATH. Locally you can point
// CHROMIUM_PATH at any Chrome/Chromium executable to exercise this directly.

import puppeteer from "puppeteer-core";

export type RenderArtifactOptions = {
  /** Capture width in CSS px. */
  width?: number;
  /** Device pixel scale for the output. Higher = sharper + bigger file. */
  scale?: number;
};

const DEFAULT_WIDTH = 420;
const DEFAULT_SCALE = 2;
// Cap so a pathological artifact can't pin the worker forever.
const NAV_TIMEOUT_MS = 20_000;

function chromiumPath(): string {
  return process.env.CHROMIUM_PATH || "/usr/bin/chromium-browser";
}

/**
 * Render the given artifact HTML to a full-height PNG (top to bottom, whole
 * scrollable document) and return the PNG bytes. Throws on failure.
 */
export async function renderArtifactToPng(
  html: string,
  options: RenderArtifactOptions = {}
): Promise<Buffer> {
  const width = Math.max(240, Math.round(options.width || DEFAULT_WIDTH));
  const scale = options.scale || DEFAULT_SCALE;

  const browser = await puppeteer.launch({
    executablePath: chromiumPath(),
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      // Chromium's default /dev/shm is tiny in containers; use /tmp instead so
      // large pages don't crash the renderer.
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 800, deviceScaleFactor: scale });
    // `load` fires after the document and its subresources (images, CSS) load.
    // Note: setContent's types only allow "load"/"domcontentloaded" — not the
    // navigation-only "networkidle0" — so we wait for `load` and then settle
    // fonts + any still-in-flight images explicitly below.
    await page.setContent(html, {
      waitUntil: "load",
      timeout: NAV_TIMEOUT_MS,
    });
    // Belt-and-suspenders: wait for webfonts to decode and any lazily-added
    // images to finish, so text isn't captured in a fallback face and images
    // aren't half-loaded. Bounded by NAV_TIMEOUT_MS via Promise.race.
    await Promise.race([
      page.evaluate(async () => {
        const fontsReady = (document as Document & { fonts?: FontFaceSet }).fonts
          ?.ready;
        if (fontsReady) {
          await fontsReady;
        }
        const imgs = Array.from(document.images);
        await Promise.all(
          imgs.map((img) =>
            img.complete
              ? Promise.resolve()
              : new Promise<void>((res) => {
                  img.addEventListener("load", () => res(), { once: true });
                  img.addEventListener("error", () => res(), { once: true });
                })
          )
        );
      }),
      new Promise((r) => setTimeout(r, NAV_TIMEOUT_MS)),
    ]);
    // Give script-driven layouts a final beat to settle after assets land.
    await new Promise((r) => setTimeout(r, 150));
    const data = await page.screenshot({ type: "png", fullPage: true });
    return Buffer.from(data);
  } finally {
    await browser.close();
  }
}
