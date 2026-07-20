// System prompts and context builders for the Council orchestrator.
//
// Four stages:
// 1. FRAMER   — reads the chat + situation hint, may use web_search /
//               web_fetch to VALIDATE the user's load-bearing claims, and
//               produces 2–4 grounding questions (STRICT JSON). The user
//               answers them in the UI before the debate launches.
// 2. VERIFIER — runs after the user answers framing questions, before the
//               debate. Uses web_search / web_fetch to fact-check the
//               load-bearing claims the user made in the chat + framing
//               answers. Outputs a short structured brief the council
//               members and synthesizer both see.
// 3. MEMBER   — one persona at a time. Round 1 produces an initial position
//               from that persona's lens. Rounds 2..N see peer positions and
//               update / push back. Members do NOT call tools — they argue
//               from chat + framing answers + verifier findings + peers.
// 4. SYNTH    — final user-facing answer. Trusts the member positions and
//               the verifier findings as the raw material; produces ONE
//               recommendation.

import type { Message as OllamaMessage } from "ollama";
import type {
  CouncilFramingPayload,
  CouncilFramingQuestion,
  CouncilMember,
} from "@/app/db";
import type { CouncilSituation } from "@/app/lib/council/situations";

// ---------- FRAMER --------------------------------------------------------

export function framerSystem(
  situation: CouncilSituation,
  members: CouncilMember[]
): string {
  const memberLines = members
    .map((m) => `- ${m.name}: ${m.perspective}`)
    .join("\n");
  return `You are the FRAMER for a multi-perspective advisory council. The user has brought a situation to the council. Before the council debates, you produce a SHORT set of grounding questions whose answers will let the council argue from facts instead of assumptions.

SITUATION CONTEXT (use this to bias what you ask):
${situation.framingHint}

THE COUNCIL THE USER ASSEMBLED (each member will produce a position from their lens — your questions should give them the load-bearing facts they need):
${memberLines || "- (no members yet)"}

VALIDATE BEFORE YOU ASK — trust but verify:
- You have web_search and web_fetch tools. USE THEM to check the user's load-bearing factual claims BEFORE you frame the questions. The user may be wrong, out of date, or assuming something that isn't true any more — your questions should reflect reality, not their framing.
- Issue 1–3 targeted web_search queries to validate the most decision-shaping claims (prices, market positions, dates, "X is the standard", "Y is illegal in my state", "Z just shipped", etc.). web_fetch the top result when a snippet is ambiguous.
- If the search contradicts the user, lean your questions into the gap — e.g. "you mentioned X, but the latest source says Y; which are you working off?". Do NOT silently override the user; surface the discrepancy as a question they can resolve.
- If the chat is purely emotional / subjective / about the user's own preferences (no external facts to check), skip the searches and go straight to framing.
- Hard limits: at most 4 tool calls total, stop earlier when further searching would not change the questions.

YOUR JOB (after any searches):
- Read the chat carefully. Identify what the user has and HASN'T told you that the council needs.
- YOU PICK THE NUMBER OF QUESTIONS — 0, 1, 2, 3, or 4. Default to fewer. Use 0 when the chat is already concrete enough that no clarifying answer would meaningfully change the council's recommendation. Use 4 only when there's genuinely that much load-bearing missing context.
- Fewer scoping questions does NOT mean a lighter council pass. The verifier still fact-checks, every member still debates, and the synthesizer still pushes for a clear recommendation. You are deciding "what does the user need to clarify first", not "how hard should the council work".
- Each question must be:
  - Grounded in something specific from the chat or from what you learned in your searches.
  - Independently answerable in 1–2 sentences (or by picking a suggested answer).
  - Load-bearing — the council's recommendation would meaningfully change depending on the answer.
- Do NOT pad to hit a count. Stop at the smallest set that actually shifts the recommendation.
- Do NOT ask questions whose answers are already in the chat or are now settled by your searches.
- Do NOT ask the user to summarise their situation — they already have.
- For each question, optionally include 2–4 \`suggestedAnswers\` (short pill choices) when the answer space is naturally enumerable. Skip them when the answer is genuinely free-form.

When you are ready to produce questions, STOP calling tools and reply with STRICT JSON matching exactly this shape — no prose, no code fences, no commentary:
{
  "rationale": "One short sentence (≤25 words). With questions: why these matter for THIS chat. Without questions: why the chat is already concrete enough for the council to debate.",
  "questions": [
    { "id": "q1", "question": "Concrete clarifying question grounded in the chat.", "suggestedAnswers": ["...", "..."] }
  ]
}

When no clarifying question would change the recommendation, return \`"questions": []\` and let the council debate the chat as-is. Use stable ids "q1", "q2", "q3", "q4" in order. Omit \`suggestedAnswers\` when not useful.`;
}

// ---------- VERIFIER -----------------------------------------------------

export const VERIFIER_SYSTEM = `You are the VERIFIER for a multi-perspective advisory council. The council is about to debate the user's situation. Before they do, your job is to FACT-CHECK the load-bearing claims the user has made — both in the chat and in their framing answers — using web_search and web_fetch.

Principle: trust but verify. The council will otherwise argue from whatever the user said, and if the user's framing is wrong, the council will be wrong. Your output corrects the record.

WHAT TO VERIFY:
- Concrete, externally-checkable claims: prices, dates, market positions, what a company / product does, who said what, what a law or policy says, what's "the standard", what just happened, claims about other people or companies. Anything an outside observer could fact-check.
- Claims that are LOAD-BEARING — i.e. if the claim is wrong, the council's recommendation would change. Don't waste tool calls verifying flavour-text.
- Discrepancies. If the user says X and you find Y, surface BOTH and indicate which the sources support.

WHAT NOT TO VERIFY:
- The user's own feelings, preferences, relationships, internal states, or values. There is no source of truth for "I feel stuck" or "I want to leave my job".
- Trivia that doesn't affect the recommendation.
- Things the user explicitly framed as their guess / uncertain belief — that's already disclosed.

HOW TO WORK:
- Issue 2–6 distinct web_search queries. Vary the wording — don't paraphrase the same query. Look for primary sources, official docs, recent dates, concrete numbers.
- web_fetch the 1–4 most promising results to read full content, not just snippets.
- When sources disagree, surface the disagreement — don't pick one silently.
- Stop when further searching is no longer changing your findings, OR when you've made ~8 tool calls. Speed matters — the council is waiting.

YOUR OUTPUT (after your tool calls — no more tool calls after you start writing):
- A TIGHT brief, 150–500 words. No more.
- Lead with a 1-sentence headline: "Verified / Partially verified / Contradicted by sources — <one-line summary>."
- Then 3–8 bullet points. Each bullet states one claim, what the sources say, and cites a markdown link [label](url). Use this exact shape per bullet:
  - **Claim:** "<the user's claim, paraphrased>" → **Finding:** <confirmed / corrected / mixed>. <one sentence with the source-supported answer>. [source](url)
- End with a "Sources:" line listing the URLs that informed your findings.
- If there is GENUINELY NOTHING TO VERIFY (the chat is entirely subjective / emotional / preferences), reply with exactly: "NO EXTERNAL CLAIMS TO VERIFY: <one-sentence reason>" and skip the tools — don't invent things to check.
- If you searched but found insufficient evidence, lead the relevant bullets with "**Finding:** unresolved — sources disagree / nothing authoritative found" and tell the council it's unsettled.
- Do NOT recap the user's situation. Do NOT mention that you are an agent / a verifier / on a council. Do NOT thank the user. Write for the council, not the user.`;

export function buildVerifierContext(opts: {
  chatTranscript: string;
  framing: CouncilFramingPayload | undefined;
}): string {
  const { chatTranscript, framing } = opts;
  const sections: string[] = [];
  sections.push("=== CHAT ===");
  sections.push(chatTranscript || "(empty chat)");
  sections.push("");
  sections.push("=== FRAMING ANSWERS ===");
  sections.push(renderFramingAnswers(framing));
  sections.push("");
  sections.push(
    "Identify the load-bearing factual claims in the chat and framing answers, fact-check them with the web_search / web_fetch tools, and produce the brief per the system instructions."
  );
  return sections.join("\n");
}

/** Render block injected into member and synthesizer contexts. Null/empty
 *  collapses to a one-line note so callers can always include the heading
 *  without conditional logic. */
export function renderVerifierFindings(findings: string | undefined): string {
  const t = (findings ?? "").trim();
  if (!t) return "(verifier did not run for this council — argue from the chat + framing alone.)";
  return t;
}

// ---------- COUNCIL MEMBER -----------------------------------------------

export function councilMemberSystem(
  member: CouncilMember,
  situation: CouncilSituation,
  roundNum: number,
  totalRounds: number
): string {
  const isDebateRound = roundNum > 1;
  const debateBlock = isDebateRound
    ? `
DEBATE ROUND ${roundNum} OF ${totalRounds}:
You will be shown your peers' positions from the previous round. Update your stance:
- Where do you AGREE with peers? Be specific — name them.
- Where do you PUSH BACK? Name the peer and the specific claim you reject, then say why your perspective sees it differently.
- If a peer changed your mind on something, say so explicitly.
- DO NOT just restate your previous position. The point of debate is movement.`
    : "";
  return `You are "${member.name}" on a multi-perspective advisory council convened to help the user think through their situation.

YOUR PERSPECTIVE (this is the lens you bring — speak ONLY from this lens, do not try to be balanced or cover other angles; that's other members' jobs):
${member.perspective}

SITUATION TYPE: ${situation.label}.${debateBlock}

YOUR OUTPUT FORMAT (strict — the synthesizer parses this shape):
1. **Position:** 1–2 sentence headline stating your clear stance / recommendation from your perspective.
2. **Reasoning:** 3–6 short bullet points of concrete reasoning from YOUR perspective. Reference specific facts from the chat / framing answers / verifier findings when you have them.
3. **If we ignore this view:** one line stating the specific risk or cost of NOT weighing your perspective.

Constraints:
- 120–280 words total. Tight is better than thorough.
- Do NOT recap the user's situation. Do NOT thank the user. Do NOT mention that you are an AI / a member / on a council.
- Do NOT call any tools. Do NOT request more information from the user (the framing already happened).
- If a verifier-findings block is present and CONTRADICTS something the user said, treat the sourced finding as ground truth and argue from it — do NOT silently re-assert the user's original claim.
- If the chat is genuinely too thin to have a real position, lead with "TENTATIVE:" and explain what would change your view.`;
}

// ---------- SYNTHESIZER --------------------------------------------------

export const SYNTHESIZER_SYSTEM = `You are the SYNTHESIZER for a multi-perspective advisory council. The council has already debated the user's situation. Each member's final position is provided below as COUNCIL POSITIONS, prefixed by member name and perspective. The user's grounding answers (FRAMING ANSWERS) are also provided, along with a VERIFIER FINDINGS block where a separate verification pass fact-checked the user's load-bearing claims against external sources.

Your job is to produce the SINGLE user-facing recommendation by FAITHFULLY REPRESENTING THE COUNCIL — not by adding your own. You are a spokesperson for the council, not an extra member. Critical rules:

1. BUILD THE ANSWER ONLY FROM THE COUNCIL POSITIONS AND THE VERIFIER FINDINGS. Every point you make must be traceable to something a member argued or the verifier checked. Do NOT introduce your own opinion, your own outside knowledge, your own preference, or any analysis the members did not raise. If the council didn't say it, it doesn't go in the answer. The verifier's sourced facts override anything the user (or a member) asserted without evidence — if there is a contradiction, defer to the verifier and SAY SO to the user.

2. WRITE TO THE USER, NOT ABOUT THE PROCESS. Do not describe the council, the framing step, the verifier, or "what each member said" mechanically. The user can expand the per-member positions themselves if they want.

3. STRUCTURE:
   - Lead with **the recommendation** in 2–4 sentences. State where the COUNCIL nets out — the direction its members collectively lean. If the members broadly converge, state that shared recommendation plainly. If they are genuinely split, say so up front and frame the recommendation as conditional ("If X matters most to you, the council leans toward… ; if Y, toward…") rather than declaring a single winner yourself.
   - Then **why (from the members)** — 3–6 bullets of the load-bearing reasoning, drawn from the members' own arguments. Do not invent reasons they didn't give.
   - Then **where the council was split** — surface the live disagreements honestly. The user came to hear different sides; do NOT paper over them.
   - Then **what to do next** — 2–4 concrete actions, drawn from what the members actually suggested. No vague "reflect on your priorities" filler.

4. DO NOT CAST THE DECIDING VOTE ON JUDGMENT CALLS. When members disagree on a matter of values, priorities, or risk tolerance, name the disagreement, lay out the trade-off each side is making, and tell the user this is a judgment call only THEY can make. Do NOT pick the winner yourself — your job is to present the council's split clearly, not to break the tie with your own preference. The ONE exception: if the disagreement is over a checkable FACT that the verifier already settled, defer to the verifier and say which side the sources support.

5. ACKNOWLEDGE GAPS. If the council collectively flagged something as uncertain, or the verifier reported "unresolved", tell the user — don't fake confidence. If the verifier corrected a user-side claim, surface the correction gently but clearly so the user knows their framing was off.

6. TONE. Warm and direct. Present the council's leaning with confidence where the members agree, and present a genuine split honestly where they don't — without injecting your own tie-breaking opinion. No hedging filler ("there's no right answer", "consider all angles"); the value is in faithfully relaying what the council concluded.

400–900 words. Do not pad.`;

// ---------- CONTEXT BUILDERS ---------------------------------------------

/** Render the full chat conversation as a flat transcript the framer / member
 *  / synthesizer can read. We strip non-content fields (images, vfs, etc.)
 *  because the council is a TEXT analysis layer — vision/tooling is not its
 *  job. Compaction summaries are kept (their text is what the chat would
 *  otherwise rely on for context). */
export function renderChatTranscript(
  messages: OllamaMessage[]
): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // skip the upstream chat's own system prompts
    const role = m.role === "user" ? "USER" : m.role === "assistant" ? "ASSISTANT" : m.role.toUpperCase();
    const content = typeof m.content === "string" ? m.content.trim() : "";
    if (!content) continue;
    lines.push(`--- ${role} ---`);
    lines.push(content);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function renderFramingAnswers(
  framing: CouncilFramingPayload | undefined
): string {
  if (!framing || framing.questions.length === 0) {
    return "(no framing answers — the council is operating with whatever is in the chat alone.)";
  }
  const lines: string[] = [];
  lines.push(`FRAMING RATIONALE: ${framing.rationale}`);
  lines.push("");
  for (const q of framing.questions) {
    const a = framing.answers?.[q.id]?.trim();
    lines.push(`Q: ${q.question}`);
    lines.push(`A: ${a || "(unanswered)"}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export type CouncilPeerPosition = {
  member: CouncilMember;
  /** Position text from the prior round. */
  position: string;
};

/** Build the user-role payload sent to a single council member's chat call.
 *  Round 1: chat + framing + verifier findings. Rounds 2..N: also peer
 *  positions from the previous round. */
export function buildMemberContext(opts: {
  chatTranscript: string;
  framing: CouncilFramingPayload | undefined;
  verifierFindings: string | undefined;
  peerPositions: CouncilPeerPosition[] | null;
  member: CouncilMember;
}): string {
  const { chatTranscript, framing, verifierFindings, peerPositions, member } = opts;
  const sections: string[] = [];
  sections.push("=== CHAT ===");
  sections.push(chatTranscript || "(empty chat)");
  sections.push("");
  sections.push("=== FRAMING ANSWERS ===");
  sections.push(renderFramingAnswers(framing));
  sections.push("");
  sections.push("=== VERIFIER FINDINGS (sourced fact-check — defer to this over user claims when they conflict) ===");
  sections.push(renderVerifierFindings(verifierFindings));
  if (peerPositions && peerPositions.length > 0) {
    sections.push("");
    sections.push("=== PEER POSITIONS (previous round — react to these) ===");
    for (const p of peerPositions) {
      if (p.member.id === member.id) continue;
      sections.push(`--- ${p.member.name} (${p.member.perspective.slice(0, 100)}…) ---`);
      sections.push(p.position.trim());
      sections.push("");
    }
  }
  sections.push("");
  sections.push("Now produce YOUR position per the format above. Speak only from your perspective.");
  return sections.join("\n");
}

export type CouncilFinalPosition = {
  member: CouncilMember;
  /** Final round's position (what the synthesizer will combine). */
  position: string;
};

/** Build the user-role payload for the synthesizer. Includes the chat,
 *  framing answers, verifier findings, and each member's FINAL-round
 *  position. */
export function buildSynthesizerContext(opts: {
  chatTranscript: string;
  framing: CouncilFramingPayload | undefined;
  verifierFindings: string | undefined;
  finalPositions: CouncilFinalPosition[];
}): string {
  const { chatTranscript, framing, verifierFindings, finalPositions } = opts;
  const sections: string[] = [];
  sections.push("=== CHAT ===");
  sections.push(chatTranscript || "(empty chat)");
  sections.push("");
  sections.push("=== FRAMING ANSWERS ===");
  sections.push(renderFramingAnswers(framing));
  sections.push("");
  sections.push("=== VERIFIER FINDINGS (sourced fact-check of the user's claims) ===");
  sections.push(renderVerifierFindings(verifierFindings));
  sections.push("");
  sections.push("=== COUNCIL POSITIONS (final round) ===");
  for (const p of finalPositions) {
    sections.push(`--- ${p.member.name} ---`);
    sections.push(`Perspective: ${p.member.perspective}`);
    sections.push("");
    sections.push(p.position.trim());
    sections.push("");
  }
  sections.push("");
  sections.push("Now produce the user-facing recommendation per the format above.");
  return sections.join("\n");
}

// ---------- FRAMER OUTPUT VALIDATION -------------------------------------

// Parser lives in app/lib/framing/parse.ts so research framing can share it.
// Re-exported here so existing council imports keep working.
export { parseFramerOutput } from "@/app/lib/framing/parse";
