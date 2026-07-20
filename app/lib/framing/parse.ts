// Shared framer-output parser used by both council framing and research
// framing. The shape is identical: `{ rationale, questions: [{id, question,
// suggestedAnswers?}] }`. Tolerates code-fence wrappers and prose around the
// JSON so a noisy framer model still recovers; returns null when we can't
// pull a usable shape out so the caller can fall back gracefully.

import type { Tool, ToolCall } from "ollama";

export type FramingQuestion = {
  id: string;
  question: string;
  /** Optional pill choices rendered alongside the textarea. */
  suggestedAnswers?: string[];
};

export type FramerOutput = {
  rationale: string;
  questions: FramingQuestion[];
};

export function parseFramerOutput(raw: string): FramerOutput | null {
  if (!raw) return null;
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace > 0 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const rationale =
    typeof obj.rationale === "string" ? obj.rationale.trim() : "";
  // `questions` is optional and may legitimately be absent or empty — the
  // framer decides whether scoping questions are useful for this chat. We
  // treat any of {missing key, empty array, all-blank items} as "no
  // questions" and let the caller proceed without them. The rationale is
  // still required so the user sees WHY the framer skipped scoping.
  const rawQuestions = Array.isArray(obj.questions) ? obj.questions : [];
  const questions: FramingQuestion[] = [];
  for (let i = 0; i < rawQuestions.length && questions.length < 4; i++) {
    const q = rawQuestions[i];
    if (!q || typeof q !== "object") continue;
    const qo = q as Record<string, unknown>;
    const text = typeof qo.question === "string" ? qo.question.trim() : "";
    if (!text) continue;
    const id =
      typeof qo.id === "string" && qo.id.trim()
        ? qo.id.trim()
        : `q${questions.length + 1}`;
    const suggested = Array.isArray(qo.suggestedAnswers)
      ? qo.suggestedAnswers
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.trim())
          .slice(0, 4)
      : undefined;
    questions.push({
      id,
      question: text,
      suggestedAnswers: suggested && suggested.length > 0 ? suggested : undefined,
    });
  }
  // A response with no rationale AND no questions is unparseable noise — reject
  // it so the caller can retry. An empty `questions` array with a non-empty
  // rationale is a valid "no scoping needed" reply.
  if (questions.length === 0 && !rationale) return null;
  return { rationale, questions };
}

// ---- framing output schema ---------------------------------------------
//
// Passed to Ollama's `format` parameter on the finalize round. Ollama enforces
// the schema at decode time on every model that supports structured outputs
// (DeepSeek V4 Pro/Flash, Llama 3.x, Qwen, GPT-OSS, Kimi, Gemma) — much
// stricter than `format: "json"`, which only nudges the model to "produce
// JSON" and is widely ignored.
//
// See https://ollama.com/blog/structured-outputs for the format-as-schema
// contract. The Ollama JS SDK types `format` as `string | object`.

export const FRAMING_OUTPUT_SCHEMA = {
  type: "object",
  required: ["rationale", "questions"],
  properties: {
    rationale: {
      type: "string",
      description:
        "One short sentence (≤25 words) explaining why these scoping answers will sharpen the work.",
    },
    questions: {
      type: "array",
      // The framer decides whether scoping questions are useful at all — many
      // chats are already concrete enough that asking anything would just be
      // friction. Cap is 4; floor is 0 (omit / empty array when no question
      // would meaningfully change the planner's decomposition).
      minItems: 0,
      maxItems: 4,
      items: {
        type: "object",
        required: ["id", "question"],
        properties: {
          id: {
            type: "string",
            description: 'Stable id like "q1", "q2", "q3", "q4" in order.',
          },
          question: {
            type: "string",
            description: "The question text shown to the user.",
          },
          suggestedAnswers: {
            type: "array",
            maxItems: 4,
            items: { type: "string" },
            description:
              "Optional 2-4 short pill choices when the answer space is naturally enumerable.",
          },
        },
      },
    },
  },
} as const;

// ---- submit_framing tool ------------------------------------------------
//
// Belt-and-suspenders alongside FRAMING_OUTPUT_SCHEMA: some backends
// (notably DeepSeek V4 Pro on the cloud edge) occasionally produce a tool
// call instead of honoring the format constraint. Either path lands in
// `extractSubmitFramingArgs(calls) ?? content` and then parseFramerOutput.
// Used by both council/framing/work.ts and research/framing/work.ts on the
// final-round call. See app/api/research/framing/work.ts for the call site.

export const SUBMIT_FRAMING_TOOL_NAME = "submit_scoping_questions";

export const SUBMIT_FRAMING_TOOL: Tool = {
  type: "function",
  function: {
    name: SUBMIT_FRAMING_TOOL_NAME,
    description:
      "Submit the final scoping questions for the user. Call this EXACTLY ONCE when you're done researching. Do not call any other tool after this one. Pass an empty `questions` array when no scoping question would meaningfully change the downstream work.",
    parameters: {
      type: "object",
      required: ["rationale", "questions"],
      properties: {
        rationale: {
          type: "string",
          description:
            "One short sentence (≤25 words). When questions are present, explain why these scoping answers will sharpen the work. When the array is empty, explain why no scoping is needed (e.g. the request is already concrete).",
        },
        questions: {
          type: "array",
          description:
            "Between 0 and 4 grounding questions — pick the count that fits. Use 0 when the request is already concrete enough that no answer would change the plan. Each question must be independently answerable and load-bearing.",
          items: {
            type: "object",
            required: ["id", "question"],
            properties: {
              id: {
                type: "string",
                description: 'Stable id like "q1", "q2", "q3", "q4" in order.',
              },
              question: {
                type: "string",
                description: "The question text shown to the user.",
              },
              suggestedAnswers: {
                type: "array",
                description:
                  "Optional 2-4 short pill choices when the answer space is naturally enumerable.",
                items: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

/** Read the submit-framing tool call out of a finalize-round response.
 *  Returns the raw JSON string to feed into `parseFramerOutput`, or `null`
 *  when the model didn't call the tool. Handles both string and object
 *  `arguments` (Ollama clients normalize differently across backends). */
export function extractSubmitFramingArgs(calls: ToolCall[]): string | null {
  for (const call of calls) {
    if (call.function?.name !== SUBMIT_FRAMING_TOOL_NAME) continue;
    const args = call.function.arguments;
    if (typeof args === "string") return args;
    if (args && typeof args === "object") {
      try {
        return JSON.stringify(args);
      } catch {
        return null;
      }
    }
  }
  return null;
}
