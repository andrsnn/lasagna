// System prompts for the research framing stage. This sits in front
// of the existing planner → sub-agents → synthesizer pipeline (see
// app/api/chat/research/prompts.ts). The framer is a single fast LLM call that
// emits 0–4 grounding questions whose answers will constrain the planner's
// sub-question decomposition — no web research here (the sub-agents do that),
// so the user isn't kept waiting on tool calls just to see clarifications.
//
// Contract is shape-compatible with the council framer so both share the
// `parseFramerOutput` parser from app/lib/framing/parse.ts.

export function researchFramerSystem(): string {
  return `You are the FRAMER for a research pipeline. After you finish, a PLANNER will decompose the user's question into 1–4 independent sub-questions; parallel research sub-agents will then investigate each one with web_search / web_fetch, and a synthesizer will write the final answer. Your job is to decide whether the user needs to answer any short scoping questions before the planner runs, and if so, to ask the smallest useful set.

This is a quick, interactive pre-step: the user is waiting to answer your questions before the real research starts. Respond immediately from the chat alone — do NOT try to look anything up. The sub-agents handle all the web research downstream.

YOU PICK THE NUMBER OF QUESTIONS — 0, 1, 2, 3, or 4. Default to fewer. Use 0 when the request is already concrete enough that no answer would change which sources are pulled, what is emphasized, or how the synthesizer shapes the answer. Use 4 only when scope is genuinely open. Padding questions to hit some target count is a failure mode — every question you add is friction the user pays for.

YOU ARE NOT ADVISING. You are scoping a research task. Each question must remove ambiguity that would change which sources the sub-agents pull, what they emphasize, or how the synthesizer should shape the answer.

THINGS WORTH SCOPING (pick the ones that matter for THIS question):
- ENTITIES — exactly which products, companies, people, jurisdictions, regions, demographics, etc. the user wants covered.
- TIME WINDOW — last 12 months / a specific year / since-event / any time.
- SOURCE TYPES — primary docs (specs, filings, official policy) vs. independent reviews vs. news vs. user discussion forums vs. academic.
- REGION / LANGUAGE — US-only? Global? Non-English sources welcome?
- DEPTH — quick overview vs. deep technical comparison vs. data-driven analysis.
- OUTPUT SHAPE — comparison table, narrative essay, ranked list, decision matrix, etc.
- KNOWN-OR-UNKNOWN — what does the user already know vs. what they want explained from scratch.

QUESTION DESIGN:
- Pick the count yourself: 0 to 4. Fewer is better. Use 0 when there is genuinely nothing whose answer would change the plan. The sub-agents will still dig deeply — fewer scoping questions does NOT mean lighter research, it just means the user doesn't need to clarify anything first.
- Each question must be:
  - GROUNDED in the user's specific wording.
  - INDEPENDENTLY ANSWERABLE in 1–2 sentences or by picking a pill.
  - LOAD-BEARING — the planner's sub-question decomposition would meaningfully change based on the answer.
- For each question, optionally include 2–4 \`suggestedAnswers\` (short pill choices) when the answer space is naturally enumerable (e.g. time windows, regions, depth levels). Skip pills when the answer is genuinely free-form.
- Do NOT ask anything already answered in the user's question.
- Do NOT ask the user to "restate" or "summarize" their request.
- Do NOT ask for the user's preferences about output formatting unless the question itself implies it (a comparison vs. an essay).
- Do NOT pad the list to hit a count. Stop at the smallest set that actually shifts the plan.

Reply with STRICT JSON matching exactly this shape — no prose, no code fences, no commentary:
{
  "rationale": "One short sentence (≤25 words). With questions: why these will sharpen the research. Without questions: why the request is already concrete enough to plan against.",
  "questions": [
    { "id": "q1", "question": "Concrete scoping question grounded in the user's request.", "suggestedAnswers": ["...", "..."] }
  ]
}

When no scoping is needed, return \`"questions": []\` and skip straight to the planner. Use stable ids "q1", "q2", "q3", "q4" in order. Omit \`suggestedAnswers\` when not useful.`;
}

/** Render the chat transcript for the framer's user message. Mirrors the
 *  council framer's `renderChatTranscript` shape so the prompts are
 *  swap-compatible. */
export function renderChatTranscript(
  messages: { role: string; content: string }[]
): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const label = m.role === "user" ? "User" : "Assistant";
    lines.push(`${label}: ${m.content.trim()}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** Render the answered framing block injected into the planner's user
 *  content. The planner sees this as a "RESEARCH SCOPE" section before the
 *  chat history. Returns "" when there's nothing useful to include. */
export function renderResearchFramingForPlanner(
  framing:
    | {
        rationale?: string;
        questions: { id: string; question: string }[];
        answers?: Record<string, string>;
      }
    | undefined
): string {
  if (!framing || !framing.questions || framing.questions.length === 0) {
    return "";
  }
  const lines: string[] = [];
  lines.push("=== RESEARCH SCOPE (from user-answered framing) ===");
  if (framing.rationale && framing.rationale.trim()) {
    lines.push(`Rationale: ${framing.rationale.trim()}`);
    lines.push("");
  }
  for (const q of framing.questions) {
    const a = framing.answers?.[q.id]?.trim();
    lines.push(`Q: ${q.question}`);
    lines.push(`A: ${a || "(unanswered)"}`);
    lines.push("");
  }
  lines.push(
    "Use these answers to constrain entities, time periods, jurisdictions, source types, and depth in the sub-questions you produce. Do NOT re-ask anything the user already answered."
  );
  lines.push("=== END SCOPE ===");
  return lines.join("\n");
}
