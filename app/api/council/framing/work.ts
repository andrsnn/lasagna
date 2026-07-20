// Council framer work: extracted LLM tool loop the POST handshake hands
// off to via waitUntil. Same shape as ./../../research/framing/work.ts —
// the routing differs (council uses a situation-aware system prompt and
// echoes situationId / situationLabel into the payload), but the resume /
// recovery story is identical.

import type { Message as OllamaMessage } from "ollama";
import {
  chatClientFor,
  isTransientErrorFor,
  friendlyErrorFor,
} from "@/app/lib/llm/router";
import {
  framerSystem,
  parseFramerOutput,
  renderChatTranscript,
} from "@/app/lib/council/prompts";
import {
  FRAMING_OUTPUT_SCHEMA,
  SUBMIT_FRAMING_TOOL,
  extractSubmitFramingArgs,
} from "@/app/lib/framing/parse";
import { getSituation } from "@/app/lib/council/situations";
import {
  MAX_FETCH_CHARS,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  executeTool,
} from "@/app/lib/ollama/tools";
import {
  preprocessFramerAttachments,
  type FramerIncomingCsv,
  type FramerIncomingImage,
  type FramerIncomingPdf,
} from "@/app/lib/framing/attachments";
import type { CouncilMember } from "@/app/db";
import type { FramerWorkOutcome } from "@/app/lib/framing/work-output";
import {
  emitProgress,
  streamFramerCall,
  type FramerEmit,
} from "@/app/lib/framing/stream-call";
import { currentDateSystemLine } from "@/app/lib/system-context";
import { withDeadline } from "@/app/lib/with-deadline";
import {
  FRAMER_BUDGET_MS,
  FRAMER_CALL_HARD_CAP_MS,
  FRAMER_FINALIZE_RESERVE_MS,
  FRAMER_TOOL_TIMEOUT_MS,
} from "@/app/lib/framing/budget";

const FRAMER_MAX_TOOL_CALLS = 4;
// Bounded retry inside the finalize phase — matches research/framing/work.ts.
// DeepSeek V4 Pro and other models occasionally produce prose instead of
// honoring format/tool constraints on the first finalize call; two extra
// attempts with a stronger reinforcement recover the call before we 502.
const FRAMER_MAX_FINALIZE_ATTEMPTS = 3;

export type CouncilFramerTurn = {
  role: "user" | "assistant" | "system";
  content: string;
  images?: FramerIncomingImage[];
  pdfs?: FramerIncomingPdf[];
  csvs?: FramerIncomingCsv[];
};

export type CouncilFramerInput = {
  turns: CouncilFramerTurn[];
  members: CouncilMember[];
  situationId?: string;
  framerModel: string;
  runpodEndpointId?: string;
  publicOrigin: string;
  /** Optional sink for live progress / reasoning events. Wired by the route's
   *  waitUntil producer to append into the stream's Redis events list so the
   *  council framing card shows the framer reasoning + its web searches as
   *  they happen. */
  onEvent?: FramerEmit;
};

export async function runCouncilFraming(
  input: CouncilFramerInput
): Promise<FramerWorkOutcome> {
  const {
    turns,
    members,
    situationId,
    framerModel,
    runpodEndpointId,
    publicOrigin,
    onEvent,
  } = input;

  const situation = getSituation(situationId);

  await emitProgress(onEvent, "Reading the chat…");

  // Budget the whole run from entry (covers attachment preprocessing too), so a
  // slow image-describe call can't leave the tool loop with no time to finalize.
  const deadlineAt = Date.now() + FRAMER_BUDGET_MS;
  const loopDeadlineAt = deadlineAt - FRAMER_FINALIZE_RESERVE_MS;

  const { messages: preprocessed, actions: preActions } =
    await preprocessFramerAttachments(turns, {
      framerModel,
      runpodEndpointId,
    });
  const conv: OllamaMessage[] = preprocessed.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const transcript = renderChatTranscript(conv);

  const framerMessages: OllamaMessage[] = [
    { role: "system", content: `${currentDateSystemLine()}\n\n${framerSystem(situation, members)}` },
    {
      role: "user",
      content: `=== CHAT ===\n${transcript || "(empty chat)"}\n\nProduce the framing questions per the system instructions. Output STRICT JSON only.`,
    },
  ];

  const llm = chatClientFor(framerModel, { runpodEndpointId });

  const loopConv: OllamaMessage[] = framerMessages.slice();
  const tools = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL];
  let toolCallCount = 0;
  let finalRaw = "";
  let forceFinalizeNext = false;
  let finalizeAttempts = 0;

  try {
    for (
      let round = 0;
      round < FRAMER_MAX_TOOL_CALLS + FRAMER_MAX_FINALIZE_ATTEMPTS + 1;
      round++
    ) {
      const timeLeftForFinalize = deadlineAt - Date.now();
      const mustFinalize =
        forceFinalizeNext ||
        toolCallCount >= FRAMER_MAX_TOOL_CALLS ||
        timeLeftForFinalize <= FRAMER_FINALIZE_RESERVE_MS;

      if (mustFinalize) {
        loopConv.push({
          role: "system",
          content:
            finalizeAttempts === 0
              ? "Stop researching now. Using ONLY what you've already gathered, submit your decision by calling the submit_scoping_questions tool, OR by writing a single JSON object matching the response schema. If no clarifying question would change the council's recommendation, return `\"questions\": []` with a rationale explaining the chat is already concrete. Do not call web_search or web_fetch again. No prose, no markdown, no thinking — output ONLY the JSON object (or the tool call)."
              : 'Your previous response was not valid JSON matching the required schema. Try again. Output ONLY one of these two shapes and nothing else. With questions: {"rationale": "<one short sentence>", "questions": [{"id": "q1", "question": "<text>", "suggestedAnswers": ["<opt1>", "<opt2>"]}]}. Without questions: {"rationale": "<one short sentence explaining why no scoping is needed>", "questions": []}. No prose before or after, no markdown fences, no explanation.',
        });
      }

      if (mustFinalize) {
        await emitProgress(onEvent, "Drafting the questions…");
      }

      // Stream the turn so the framer's reasoning surfaces in the card while it
      // works. Still bounded: streamFramerCall aborts the iterator at the call
      // cap / run deadline, so a wedged model can't outrun the producer's host
      // timeout. Finalize turns get until the full deadline (the reserved tail);
      // gathering turns are capped earlier so they can't eat into that reserve.
      // On finalize, constrain output with the framing JSON schema — Ollama
      // enforces it at decode time on every model that ships structured outputs
      // (DeepSeek V4 Pro/Flash included), stronger than `format: "json"` and
      // surviving models that ignore tool_choice entirely.
      const { content: rawContent, toolCalls } = await streamFramerCall({
        llm,
        model: framerModel,
        messages: loopConv,
        tools: mustFinalize ? [SUBMIT_FRAMING_TOOL] : tools,
        ...(mustFinalize ? { format: FRAMING_OUTPUT_SCHEMA } : {}),
        deadlineAt: mustFinalize ? deadlineAt : loopDeadlineAt,
        hardCapMs: FRAMER_CALL_HARD_CAP_MS,
        label: mustFinalize ? "Framing finalize" : "Framing research",
        emit: onEvent,
      });

      const content = rawContent.trim();
      const calls = toolCalls;

      if (mustFinalize) {
        const fromTool = extractSubmitFramingArgs(calls);
        finalRaw = fromTool ?? content;
        finalizeAttempts += 1;
        if (
          parseFramerOutput(finalRaw) ||
          finalizeAttempts >= FRAMER_MAX_FINALIZE_ATTEMPTS ||
          deadlineAt - Date.now() <= FRAMER_FINALIZE_RESERVE_MS
        ) {
          break;
        }
        continue;
      }
      if (calls.length === 0) {
        if (parseFramerOutput(content)) {
          finalRaw = content;
          break;
        }
        forceFinalizeNext = true;
        continue;
      }

      loopConv.push({
        role: "assistant",
        content,
        tool_calls: calls,
      });

      for (const call of calls) {
        if (toolCallCount >= FRAMER_MAX_TOOL_CALLS) break;
        const name = call.function.name;
        const args = (call.function.arguments as Record<string, unknown>) ?? {};
        toolCallCount += 1;
        const q =
          typeof args.query === "string"
            ? args.query
            : typeof args.url === "string"
              ? args.url
              : "";
        await emitProgress(
          onEvent,
          name === "web_search"
            ? `Searching the web${q ? `: ${q}` : "…"}`
            : name === "web_fetch"
              ? `Reading ${q || "a page"}…`
              : `Running ${name}…`
        );
        // Bound the tool call too — a hung web_fetch (no AbortSignal) would
        // otherwise strand the loop. On timeout, feed the model the error and
        // force finalize so it works with what it already gathered.
        let toolContent: string;
        try {
          const r = await withDeadline(
            () =>
              executeTool(name, args, Math.min(MAX_FETCH_CHARS, 4000), {
                publicOrigin,
              }),
            loopDeadlineAt,
            `tool:${name}`,
            FRAMER_TOOL_TIMEOUT_MS
          );
          toolContent = JSON.stringify(r.ok ? r.result : { error: r.error });
        } catch (toolErr) {
          toolContent = JSON.stringify({
            error: toolErr instanceof Error ? toolErr.message : String(toolErr),
          });
          forceFinalizeNext = true;
        }
        loopConv.push({
          role: "tool",
          content: toolContent,
          tool_name: name,
        } as OllamaMessage);
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
        situationId: situation.id,
        situationLabel: situation.label,
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
