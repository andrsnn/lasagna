// GET /api/novel/outline/progress/{streamId} — snapshot of the progress
// timeline the outline worker has emitted so far. Returns immediately (no
// long-poll) so the client can poll on a fixed cadence alongside the
// long-poll resume request and render a live action timeline.
//
// Response shape:
//   {
//     status:      "running" | "complete" | "error" | "missing",
//     steps:       NovelOutlineProgressStep[],   // in emit order
//     startedAt?:  number,                       // epoch ms
//     workerSeenAt?: number,                     // epoch ms of last event
//   }
//
// `status: "missing"` means the streamId TTL elapsed or it was bogus — the
// caller should stop polling and surface a "retry" prompt.

import {
  getEvents,
  getMeta,
  isStreamStoreConfigured,
} from "@/app/lib/stream-store";

// Mirror of NovelOutlineProgressStep — kept structurally identical to
// app/api/novel/outline/work.ts and app/db.ts so the snapshot response
// matches the client's NovelOutlineProgress type without forcing a
// cross-module import (work.ts pulls in Vercel-only deps the bundler
// shouldn't have to walk just for a type).
type ProgressStep = {
  key: string;
  label: string;
  status: "running" | "ok" | "error";
  at: number;
  detail?: string;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ streamId: string }> }
) {
  if (!isStreamStoreConfigured()) {
    return Response.json(
      {
        status: "missing",
        steps: [],
        error:
          "Resumable streams are disabled — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      },
      { status: 503 }
    );
  }
  const { streamId } = await params;
  if (!streamId) {
    return Response.json(
      { status: "missing", steps: [], error: "Missing streamId." },
      { status: 400 }
    );
  }

  const [meta, events] = await Promise.all([
    getMeta(streamId),
    getEvents(streamId, 0),
  ]);

  if (!meta && events.length === 0) {
    return Response.json(
      { status: "missing", steps: [] },
      { status: 200 }
    );
  }

  const steps: ProgressStep[] = [];
  let lastAt = meta?.createdAt;
  for (const ev of events) {
    if (ev.event !== "progress") continue;
    const data = ev.data as ProgressStep | undefined;
    if (!data || typeof data !== "object") continue;
    if (typeof data.key !== "string" || typeof data.label !== "string") continue;
    steps.push(data);
    if (typeof data.at === "number" && (!lastAt || data.at > lastAt)) {
      lastAt = data.at;
    }
  }

  const hasTerminalResult = events.some((ev) => ev.event === "result");
  const reportedStatus =
    meta?.status ?? (hasTerminalResult ? "complete" : "running");

  return Response.json(
    {
      status: reportedStatus,
      steps,
      startedAt: meta?.createdAt,
      workerSeenAt: lastAt,
    },
    { status: 200 }
  );
}
