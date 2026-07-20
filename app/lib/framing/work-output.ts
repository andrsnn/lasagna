// Shared return shape for the framer work functions. Mirrors the
// `{status, payload}` envelope `executeQuery` (app/lib/executors.ts) uses so
// the POST handshake can mirror outcomes into Redis as a single `result`
// event and the resume route can return them with the same HTTP status the
// old synchronous endpoint did.
//
// Both research framing and council framing share the success/error shapes;
// council adds situationId / situationLabel and uses a different system
// prompt, but the wire-shape the client renders is identical.

import type { FramerAction } from "@/app/db";
import type { FramerOutput } from "@/app/lib/framing/parse";

export type FramerSuccessPayload = {
  framing: FramerOutput;
  actions?: FramerAction[];
  /** Council-only: echo the situation back so the card knows which one the
   *  framer ran under (the client may have changed the selector mid-flight). */
  situationId?: string;
  situationLabel?: string;
};

export type FramerErrorPayload = {
  error: string;
  /** Pre-framer actions (describe_image, attach_pdf) still ran before the LLM
   *  failure — surface them so the card can show the framer touched the
   *  user's attachments even when the JSON turn died. */
  actions?: FramerAction[];
};

export type FramerWorkOutcome =
  | { status: 200; payload: FramerSuccessPayload }
  | { status: 400 | 500 | 502; payload: FramerErrorPayload };
