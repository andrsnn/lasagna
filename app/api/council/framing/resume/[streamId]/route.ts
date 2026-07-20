// Pick up the JSON result of a previously-issued POST /api/council/framing
// call. Same shape as the research framing resume — long-poll Redis for the
// `result` event and return its payload verbatim. See
// app/lib/single-result-resume.ts for the poll loop.

import {
  resumeEventStream,
  resumeSingleResultStream,
} from "@/app/lib/single-result-resume";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ streamId: string }> }
) {
  const { streamId } = await params;
  // Producer (POST /api/council/framing) is a Vercel waitUntil task bounded by
  // its 120s maxDuration; allow 30s of platform slack before declaring a
  // still-"running" stream dead.
  const ceilings = { maxProducerLifetimeMsVercel: 150 * 1000 };
  // `?cursor=N` → streaming consumer (live reasoning + web-search progress);
  // no cursor → legacy single-result long-poll.
  const cursorParam = new URL(req.url).searchParams.get("cursor");
  if (cursorParam != null) {
    return resumeEventStream(streamId, Number(cursorParam), ceilings);
  }
  return resumeSingleResultStream(streamId, ceilings);
}
