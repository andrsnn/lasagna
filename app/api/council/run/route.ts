// POST /api/council/run — handshake. Mirrors POST /api/chat: validates the
// payload, probes provider creds, allocates a streamId, persists meta, and
// hands off to runCouncilWork() under waitUntil(). Returns 202 with the
// streamId; the client reads the SSE feed via the existing
// /api/chat/resume/{streamId} endpoint (the council emits the same event
// shapes consumeChatStream already drains).

import { waitUntil } from "@vercel/functions";
import type { Message as OllamaMessage } from "ollama";
import {
  enqueueCouncilJob,
  isStreamStoreConfigured,
  saveCouncilJob,
  setMeta,
  setStreamScratchpad,
} from "@/app/lib/stream-store";
import { isFlyWorkerConfigured, wakeWorker } from "@/app/lib/fly-wake";
import { probeClientFor } from "@/app/lib/llm/router";
import { runCouncilWork } from "@/app/api/council/work";
import {
  MAX_COUNCIL_DEBATE_ROUNDS,
  MAX_COUNCIL_MEMBERS,
} from "@/app/lib/council/situations";
import type {
  CouncilFramingPayload,
  CouncilFramingQuestion,
  CouncilMember,
} from "@/app/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type IncomingBody = {
  messages?: { role: "user" | "assistant" | "system"; content: string }[];
  members?: CouncilMember[];
  situationId?: string;
  debateRounds?: number;
  /** Synthesizer model id. Falls back to the first member's model if missing. */
  synthesizerModel?: string;
  framing?: {
    rationale?: string;
    questions?: CouncilFramingQuestion[];
    answers?: Record<string, string>;
  };
  runpodEndpointId?: string;
  /**
   * Already-completed member positions, supplied by the "Continue" button on
   * an errored council bubble. The client extracts these from the assistant
   * message's events array (which renders the council disclosure). The server
   * pre-populates the per-stream scratchpad with them so the orchestrator
   * skips those members and only runs the missing rounds + synthesizer.
   * Self-contained: doesn't depend on the original streamId being known or
   * the prior meta still being in Redis.
   */
  priorPositions?: {
    memberId: string;
    round: number;
    position: string;
  }[];
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
  // The verifier's tool executor needs a same-origin URL for image proxying.
  // The user-visible host lives on x-forwarded-* (req.url is the internal
  // lambda URL on Vercel) — same pattern the chat route uses.
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
    ? body.members.filter(isPlainMember).slice(0, MAX_COUNCIL_MEMBERS)
    : [];
  if (members.length === 0) {
    return Response.json(
      {
        error:
          "Council has no members. Add at least one in Preferences → Council.",
      },
      { status: 400 }
    );
  }

  const debateRounds = Math.max(
    0,
    Math.min(MAX_COUNCIL_DEBATE_ROUNDS, Math.floor(body.debateRounds ?? 1))
  );

  const synthesizerModel =
    typeof body.synthesizerModel === "string" && body.synthesizerModel.trim()
      ? body.synthesizerModel.trim()
      : members[0].model;

  const runpodEndpointId =
    typeof body.runpodEndpointId === "string" && body.runpodEndpointId.trim()
      ? body.runpodEndpointId.trim()
      : undefined;

  if (!isStreamStoreConfigured()) {
    return Response.json(
      {
        error:
          "Resumable streams are disabled — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      },
      { status: 503 }
    );
  }

  // Probe creds for every model we'll touch — fail the handshake if any
  // member's provider is missing creds, instead of letting the worker
  // partial-fail mid-debate.
  const providerProbes = new Set<string>();
  providerProbes.add(synthesizerModel);
  for (const m of members) providerProbes.add(m.model);
  try {
    for (const id of providerProbes) {
      probeClientFor(id, { runpodEndpointId });
    }
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "LLM provider unavailable for at least one council member.",
      },
      { status: 500 }
    );
  }

  const conv: OllamaMessage[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const framing: CouncilFramingPayload | undefined =
    body.framing && Array.isArray(body.framing.questions)
      ? {
          rationale:
            typeof body.framing.rationale === "string"
              ? body.framing.rationale
              : "",
          questions: body.framing.questions.filter(
            (q): q is CouncilFramingQuestion =>
              !!q &&
              typeof q.id === "string" &&
              typeof q.question === "string"
          ),
          answers:
            body.framing.answers && typeof body.framing.answers === "object"
              ? Object.fromEntries(
                  Object.entries(body.framing.answers).filter(
                    ([, v]) => typeof v === "string"
                  ) as [string, string][]
                )
              : undefined,
          members,
          situationId: typeof body.situationId === "string" ? body.situationId : "custom",
        }
      : undefined;

  // Route the debate to the off-Vercel Fly worker whenever it's configured —
  // a multi-member × multi-round council plus the verifier and synthesizer can
  // blow this route's 300s wall clock. When Fly env vars are unset (local dev /
  // a deploy without a worker) we fall through to the in-process waitUntil
  // path, which is bounded by maxDuration but works for short debates.
  const useFlyWorker = isFlyWorkerConfigured();

  const streamId = crypto.randomUUID();
  const now = Date.now();
  try {
    await setMeta(streamId, {
      status: "running",
      createdAt: now,
      workerStartedAt: now,
      workerSeq: 1,
      producer: useFlyWorker ? "fly" : "vercel",
    });
  } catch (err) {
    console.warn(`[council ${streamId}] setMeta(running) failed`, err);
    return Response.json(
      { error: "Failed to initialize stream buffer." },
      { status: 503 }
    );
  }

  // Pre-populate the per-stream scratchpad with positions the client already
  // has from a prior errored run, so the worker emits cached results for
  // them and only does the missing work. Best-effort: if a write fails the
  // worker just re-runs that member.
  if (Array.isArray(body.priorPositions) && body.priorPositions.length > 0) {
    const memberById = new Map(members.map((m) => [m.id, m]));
    let seeded = 0;
    await Promise.all(
      body.priorPositions.map(async (pp) => {
        if (
          !pp ||
          typeof pp.memberId !== "string" ||
          typeof pp.round !== "number" ||
          !Number.isFinite(pp.round) ||
          typeof pp.position !== "string" ||
          !pp.position.trim()
        ) {
          return;
        }
        const member = memberById.get(pp.memberId);
        if (!member) return;
        const cacheKey = `council:member:${pp.memberId}:r${pp.round}`;
        try {
          await setStreamScratchpad(streamId, cacheKey, {
            member,
            roundNum: pp.round,
            position: pp.position,
            elapsedMs: 0,
          });
          seeded++;
        } catch (err) {
          console.warn(
            `[council ${streamId}] seed scratchpad ${cacheKey} failed`,
            err
          );
        }
      })
    );
    if (seeded > 0) {
      console.log(
        `[council ${streamId}] continuing with ${seeded} pre-seeded position${seeded === 1 ? "" : "s"}`
      );
    }
  }

  const situationId =
    typeof body.situationId === "string" ? body.situationId : "custom";

  // Fly path: persist the job + enqueue it for the worker, then wake the
  // machine. The worker runs runCouncilWork() with no per-request wall clock.
  // The client reads the SSE feed via /api/chat/resume/{streamId} exactly as
  // it does for the in-process path.
  if (useFlyWorker) {
    try {
      await saveCouncilJob(streamId, {
        v: 1,
        conv,
        members,
        situationId,
        framing,
        debateRounds,
        synthesizerModel,
        runpodEndpointId,
        publicOrigin,
      });
      await enqueueCouncilJob(streamId);
    } catch (err) {
      console.warn(`[council ${streamId}] failed to enqueue worker job`, err);
      return Response.json(
        { error: "Failed to enqueue council job." },
        { status: 503 }
      );
    }
    // Fire-and-forget; an already-running worker will RPOP regardless.
    void wakeWorker();
    return Response.json({ streamId }, { status: 202 });
  }

  // Fallback: in-process producer (local dev, or a deploy without a Fly
  // worker). waitUntil keeps the Vercel function alive until runCouncilWork
  // resolves, bounded by maxDuration.
  waitUntil(
    runCouncilWork({
      streamId,
      conv,
      members,
      situationId,
      framing,
      debateRounds,
      synthesizerModel,
      runpodEndpointId,
      publicOrigin,
    })
  );

  return Response.json({ streamId }, { status: 202 });
}
