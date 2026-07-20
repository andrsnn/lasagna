// Pick up the JSON result of a previously-issued POST /api/research/framing
// call. The framer LLM runs in waitUntil on the POST side and mirrors its
// `{status, payload}` envelope into Redis as a single `result` event; this
// endpoint long-polls until that event lands and returns it verbatim. A tab
// close or phone sleep mid-flight is recoverable from any future mount that
// knows the streamId.

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
  // The producer runs either in a Vercel waitUntil task (bounded by the POST
  // route's 120s maxDuration → 150s with slack) or on the Fly worker (bounded
  // by its framing kill timer, ~5min → 6min with slack). The resume helpers
  // pick the matching ceiling from meta.producer.
  const ceilings = {
    maxProducerLifetimeMsVercel: 150 * 1000,
    maxProducerLifetimeMsFly: 6 * 60 * 1000,
  };
  // `?cursor=N` → streaming consumer: return live reasoning/progress events
  // from N onward plus the terminal result. No cursor → legacy single-result
  // long-poll (kept for any client that hasn't adopted the streaming path).
  const cursorParam = new URL(req.url).searchParams.get("cursor");
  if (cursorParam != null) {
    return resumeEventStream(streamId, Number(cursorParam), ceilings);
  }
  return resumeSingleResultStream(streamId, ceilings);
}
