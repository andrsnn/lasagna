// POST /api/artifact-image — server-side full-page PNG export of an artifact.
//
// Why server-side: iOS Safari can't reliably rasterize a sandboxed artifact in
// the browser (canvas tainting / foreignObject restrictions), so every
// client-side approach failed on iPhone. Here the browser just POSTs the
// artifact HTML and gets a finished PNG back — the actual rendering happens in
// the Fly worker via headless Chromium (see app/lib/artifact/render-image.ts).
//
// Flow: save a RenderJob → enqueue it → wake the Fly worker → poll Redis for
// the result → stream the PNG bytes back. Mirrors the chat off-Vercel worker
// pattern (saveJobPayload/enqueueJob/wakeWorker) so it rides the same proven
// plumbing.

import {
  isStreamStoreConfigured,
  saveRenderJob,
  enqueueRenderJob,
  getRenderResult,
  readRenderPng,
  deleteRenderArtifacts,
} from "@/app/lib/stream-store";
import { wakeWorker } from "@/app/lib/fly-wake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The route waits for the worker to render (cold-start wake + screenshot).
// Comfortably covers a cold Fly boot (~1-3s) plus a large render.
export const maxDuration = 60;

// Reject artifacts larger than this (defensive — real artifacts are well under).
const MAX_HTML_BYTES = 2 * 1024 * 1024;
// Poll cadence + ceiling for the result. Ceiling sits under maxDuration so we
// return a clean 504 instead of being killed mid-flight.
const POLL_INTERVAL_MS = 400;
const POLL_CEILING_MS = 50_000;

type Body = {
  html?: unknown;
  width?: unknown;
  scale?: unknown;
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function POST(req: Request): Promise<Response> {
  if (!isStreamStoreConfigured()) {
    return Response.json(
      { error: "Image export needs Redis configured on the server." },
      { status: 503 }
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.html !== "string" || body.html.trim().length === 0) {
    return Response.json({ error: "Missing artifact HTML." }, { status: 400 });
  }
  if (body.html.length > MAX_HTML_BYTES) {
    return Response.json({ error: "Artifact is too large to export." }, { status: 413 });
  }

  const width = clampInt(body.width, 420, 240, 1280);
  const scale = clampInt(body.scale, 2, 1, 3);
  const jobId = crypto.randomUUID();

  try {
    await saveRenderJob(jobId, { v: 1, html: body.html, width, scale });
    await enqueueRenderJob(jobId);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Couldn't enqueue render." },
      { status: 500 }
    );
  }

  // Best-effort wake — if no Fly worker is configured, an already-running
  // worker still drains the queue (same semantics as the chat path).
  void wakeWorker();

  const deadline = Date.now() + POLL_CEILING_MS;
  while (Date.now() < deadline) {
    const result = await getRenderResult(jobId);
    if (result?.status === "error") {
      await deleteRenderArtifacts(jobId);
      return Response.json(
        { error: `Render failed: ${result.error}` },
        { status: 502 }
      );
    }
    if (result?.status === "ok") {
      const png = await readRenderPng(jobId);
      await deleteRenderArtifacts(jobId);
      if (!png) {
        return Response.json(
          { error: "Render completed but the image was unavailable." },
          { status: 502 }
        );
      }
      return new Response(new Uint8Array(png), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(png.length),
          "Cache-Control": "no-store",
        },
      });
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Timed out — leave the job for a late worker to drain (it'll age out via
  // TTL) but tell the client to retry.
  return Response.json(
    {
      error:
        "Timed out waiting for the renderer. The image worker may be cold — try again in a moment.",
    },
    { status: 504 }
  );
}
