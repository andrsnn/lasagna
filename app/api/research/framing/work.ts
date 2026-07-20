// Research framer work: the LLM call the POST handshake hands off to via
// waitUntil. Lives in its own module so the route handler can stay tiny and
// the worker survives client disconnects — the same shape /api/query uses for
// single-shot LLM calls that need to recover across a mobile network drop or a
// backgrounded tab.
//
// Scoping questions are a quick, interactive pre-step — the user is staring at
// a spinner waiting to answer 0–4 clarifications before the real research runs.
// So the framer is a SINGLE constrained LLM call: no web_search / web_fetch
// loop. The sub-agents do the actual web research downstream; making the user
// wait on tool calls here just to generate clarifying questions was the main
// source of the "framing takes forever / times out" UX. Premise-checking moved
// to where it belongs (the sub-agents); the framer now returns in one turn.
//
// Returns `{status, payload}` (see app/lib/framing/work-output.ts) so the
// resume route can return the same HTTP status the old synchronous endpoint
// did and the client doesn't need a separate code path for handshake errors
// vs framer-LLM errors.

import type { Message as OllamaMessage } from "ollama";
import {
  chatClientFor,
  isTransientErrorFor,
  friendlyErrorFor,
} from "@/app/lib/llm/router";
import {
  FRAMING_OUTPUT_SCHEMA,
  SUBMIT_FRAMING_TOOL,
  extractSubmitFramingArgs,
  parseFramerOutput,
} from "@/app/lib/framing/parse";
import {
  researchFramerSystem,
  renderChatTranscript,
} from "@/app/lib/research/prompts";
import { currentDateSystemLine } from "@/app/lib/system-context";
import {
  preprocessFramerAttachments,
  type FramerIncomingCsv,
  type FramerIncomingImage,
  type FramerIncomingPdf,
} from "@/app/lib/framing/attachments";
import type { FramerWorkOutcome } from "@/app/lib/framing/work-output";
import {
  emitProgress,
  streamFramerCall,
  type FramerEmit,
} from "@/app/lib/framing/stream-call";
import {
  FRAMER_BUDGET_MS,
  FRAMER_CALL_HARD_CAP_MS,
  FRAMER_FINALIZE_RESERVE_MS,
} from "@/app/lib/framing/budget";

// Bounded retry on malformed output. Even with format:<schema> + the tool,
// some models occasionally return prose ("Now let me check one more thing…")
// on the first call. Two extra attempts with a stronger reinforcement message
// turn that into a hard recovery instead of a 502 the user has to retry.
const FRAMER_MAX_ATTEMPTS = 3;

export type ResearchFramerTurn = {
  role: "user" | "assistant" | "system";
  content: string;
  images?: FramerIncomingImage[];
  pdfs?: FramerIncomingPdf[];
  csvs?: FramerIncomingCsv[];
};

export type ResearchFramerInput = {
  turns: ResearchFramerTurn[];
  framerModel: string;
  runpodEndpointId?: string;
  publicOrigin: string;
  /** Optional sink for live progress / reasoning events. When wired by the
   *  producer (route waitUntil or Fly worker) to append into the stream's
   *  Redis events list, the framing card renders the framer's thinking as it
   *  happens instead of a blank spinner. */
  onEvent?: FramerEmit;
};

export async function runResearchFraming(
  input: ResearchFramerInput
): Promise<FramerWorkOutcome> {
  const { turns, framerModel, runpodEndpointId, publicOrigin, onEvent } = input;

  // Budget the whole run from entry (covers attachment preprocessing too), so a
  // slow image-describe call can't leave no time for the finalize call.
  const deadlineAt = Date.now() + FRAMER_BUDGET_MS;

  await emitProgress(onEvent, "Reading the chat…");

  const { messages: conv, actions: preActions } =
    await preprocessFramerAttachments(turns, {
      framerModel,
      runpodEndpointId,
    });

  const transcript = renderChatTranscript(conv);

  const loopConv: OllamaMessage[] = [
    { role: "system", content: `${currentDateSystemLine()}\n\n${researchFramerSystem()}` },
    {
      role: "user",
      content: `=== CHAT ===\n${transcript || "(empty chat)"}\n\nProduce the scoping questions per the system instructions. Output STRICT JSON only.`,
    },
  ];

  const llm = chatClientFor(framerModel, { runpodEndpointId });

  let finalRaw = "";
  let attempts = 0;

  try {
    for (let attempt = 0; attempt < FRAMER_MAX_ATTEMPTS; attempt++) {
      // Reinforce on retries: the previous turn wasn't valid JSON for the
      // schema. Push a stronger, shape-exact instruction and try again.
      if (attempt > 0) {
        await emitProgress(onEvent, "Tightening the questions…");
        loopConv.push({
          role: "system",
          content:
            'Your previous response was not valid JSON matching the required schema. Try again. Output ONLY one of these two shapes and nothing else. With questions: {"rationale": "<one short sentence>", "questions": [{"id": "q1", "question": "<text>", "suggestedAnswers": ["<opt1>", "<opt2>"]}]}. Without questions: {"rationale": "<one short sentence explaining why no scoping is needed>", "questions": []}. No prose before or after, no markdown fences, no explanation.',
        });
      } else {
        await emitProgress(onEvent, "Weighing what to ask…");
      }

      // Stream the turn so the framer's reasoning surfaces in the card while it
      // works. Still bounded: streamFramerCall aborts the iterator at the call
      // cap / run deadline, so a wedged model can't outrun the producer's host
      // timeout. The call is constrained with the framing JSON schema — Ollama
      // enforces it at decode time on every model that ships structured outputs
      // (DeepSeek V4 Pro/Flash included), stronger than `format: "json"` and
      // surviving models that ignore tool_choice entirely.
      const { content: rawContent, toolCalls: calls } = await streamFramerCall({
        llm,
        model: framerModel,
        messages: loopConv,
        tools: [SUBMIT_FRAMING_TOOL],
        format: FRAMING_OUTPUT_SCHEMA,
        deadlineAt,
        hardCapMs: FRAMER_CALL_HARD_CAP_MS,
        label: "Scoping",
        emit: onEvent,
      });

      const content = rawContent.trim();
      const fromTool = extractSubmitFramingArgs(calls);
      finalRaw = fromTool ?? content;
      attempts += 1;

      if (
        parseFramerOutput(finalRaw) ||
        attempts >= FRAMER_MAX_ATTEMPTS ||
        deadlineAt - Date.now() <= FRAMER_FINALIZE_RESERVE_MS
      ) {
        break;
      }
    }

    const parsed = parseFramerOutput(finalRaw);
    if (!parsed) {
      return {
        status: 502,
        payload: {
          error: `Framer returned unparseable output. Head: ${finalRaw.slice(0, 160)}`,
          actions: preActions,
        },
      };
    }
    return {
      status: 200,
      payload: {
        framing: { rationale: parsed.rationale, questions: parsed.questions },
        actions: preActions,
      },
    };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = isTransientErrorFor(framerModel, err)
      ? friendlyErrorFor(framerModel, raw)
      : raw;
    return {
      status: 500,
      payload: { error: message, actions: preActions },
    };
  }
}
