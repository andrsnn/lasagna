// POST /api/council/framing — handshake-only. Same pattern as
// /api/research/framing: validate the body, kick off `runCouncilFraming` in
// a waitUntil background producer, return `{streamId}` 202. The client
// reads the final JSON via GET /api/council/framing/resume/{streamId}, so
// a phone sleeping mid-flight no longer kills the framer.

import { waitUntil } from "@vercel/functions";
import {
  appendEvent,
  isStreamStoreConfigured,
  setMeta,
} from "@/app/lib/stream-store";
import { runCouncilFraming, type CouncilFramerTurn } from "./work";
import type { FramerWorkOutcome } from "@/app/lib/framing/work-output";
import type { CouncilMember } from "@/app/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 120s because the framer runs a tool loop (web_search / web_fetch) up to a
// 40s budget plus a final JSON turn; even though the route returns 202
// almost immediately, waitUntil keeps the function alive until the producer
// finishes, so maxDuration bounds the worker not the handshake.
export const maxDuration = 120;

type IncomingBody = {
  messages?: CouncilFramerTurn[];
  members?: CouncilMember[];
  situationId?: string;
  /** Model id for the framer call. Caller (chat.tsx) sends the active chat
   *  model so framing inherits the user's existing model preferences and
   *  RunPod routing. */
  framerModel?: string;
  runpodEndpointId?: string;
};

function isPlainMember(value: unknown): value is CouncilMember {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.perspective === "string" &&
    typeof v.model === "string"
  );
}

export async function POST(req: Request) {
  // publicOrigin for the framer's tool executor (image_search proxy). Same
  // header pattern as the chat route — req.url is the internal lambda URL.
  const fwdHost =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const fwdProto =
    req.headers.get("x-forwarded-proto") ??
    (fwdHost && /^(localhost|127\.|0\.0\.0\.0)/.test(fwdHost) ? "http" : "https");
  const publicOrigin = fwdHost
    ? `${fwdProto}://${fwdHost}`
    : new URL(req.url).origin;

  let body: IncomingBody;
  try {
    body = (await req.json()) as IncomingBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return Response.json(
      { error: "messages must be a non-empty array." },
      { status: 400 }
    );
  }
  const members = Array.isArray(body.members)
    ? body.members.filter(isPlainMember)
    : [];
  if (members.length === 0) {
    return Response.json(
      {
        error:
          "Council has no members. Add at least one in Preferences → Council before running.",
      },
      { status: 400 }
    );
  }
  const framerModel =
    typeof body.framerModel === "string" && body.framerModel.trim()
      ? body.framerModel.trim()
      : null;
  if (!framerModel) {
    return Response.json(
      { error: "framerModel must be a non-empty string." },
      { status: 400 }
    );
  }
  const runpodEndpointId =
    typeof body.runpodEndpointId === "string" && body.runpodEndpointId.trim()
      ? body.runpodEndpointId.trim()
      : undefined;

  // Strip system messages — the framer brings its own.
  const turns = messages.filter((m) => m.role !== "system");
  if (turns.length === 0) {
    return Response.json(
      { error: "messages contained no user or assistant turns." },
      { status: 400 }
    );
  }

  if (!isStreamStoreConfigured()) {
    return Response.json(
      {
        error:
          "Resumable streams are disabled — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      },
      { status: 503 }
    );
  }

  const streamId = crypto.randomUUID();

  try {
    await setMeta(streamId, { status: "running", createdAt: Date.now() });
  } catch (err) {
    console.warn(`[council-framing ${streamId}] setMeta(running) failed`, err);
    return Response.json(
      { error: "Failed to initialize stream buffer." },
      { status: 503 }
    );
  }

  waitUntil(
    (async () => {
      let outcome: FramerWorkOutcome;
      try {
        outcome = await runCouncilFraming({
          turns,
          members,
          situationId: body.situationId,
          framerModel,
          runpodEndpointId,
          publicOrigin,
          // Mirror live reasoning / progress into the events list so the resume
          // endpoint can stream it to the framing card. Best-effort.
          onEvent: async (ev) => {
            try {
              await appendEvent(streamId, ev);
            } catch {
              /* progress is diagnostic — drop on failure */
            }
          },
        });
      } catch (err) {
        outcome = {
          status: 500,
          payload: {
            error: err instanceof Error ? err.message : "Framer failed",
          },
        };
      }
      try {
        await appendEvent(streamId, { event: "result", data: outcome });
        const ok = outcome.status >= 200 && outcome.status < 300;
        await setMeta(streamId, {
          status: ok ? "complete" : "error",
          finishedAt: Date.now(),
          error: ok ? undefined : (outcome.payload as { error?: string }).error,
        });
      } catch (err) {
        console.warn(`[council-framing ${streamId}] KV mirror failed`, err);
      }
    })()
  );

  return Response.json({ streamId }, { status: 202 });
}
