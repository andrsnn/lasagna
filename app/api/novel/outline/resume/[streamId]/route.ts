// Pick up the JSON result of a previously-issued POST /api/novel/outline
// call. Same shape as the framing resume endpoints — long-poll Redis for
// the `result` event and return its payload verbatim. See
// app/lib/single-result-resume.ts for the poll loop.

import { resumeSingleResultStream } from "@/app/lib/single-result-resume";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ streamId: string }> }
) {
  const { streamId } = await params;
  // Producer (POST /api/novel/outline) is a Vercel waitUntil task bounded by
  // its 120s maxDuration; allow 30s of platform slack before declaring a
  // still-"running" stream dead.
  return resumeSingleResultStream(streamId, {
    maxProducerLifetimeMsVercel: 150 * 1000,
  });
}
