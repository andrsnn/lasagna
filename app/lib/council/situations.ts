// Council situation presets — the dropdown the user picks from in the
// Council Settings sub-modal. Each preset seeds a default member roster and
// supplies a `framingHint` that biases the framer LLM toward the kinds of
// clarifying questions that matter for THIS situation.
//
// The persona pool itself is UNIVERSAL (see `COUNCIL_PERSONAS` below). The
// same ~10 voices show up in the Add / Replace dropdown regardless of which
// situation is selected — each situation just seeds a different default
// subset of them.
//
// Personas DO NOT carry a model. The council is meant to be a fair debate
// between perspectives; assigning a 1M-context frontier model to one persona
// and a 120B general-chat model to another biases the outcome toward the
// stronger LLM regardless of the actual merits of the position. The seeding
// path picks a single model and applies it to every member; the user can
// still override individual members in the dialog.

import { DEFAULT_MODEL } from "@/app/models";
import type { CouncilMember, Settings } from "@/app/db";

export type CouncilPersona = {
  /** Stable id; used by the swap UI. */
  id: string;
  name: string;
  perspective: string;
};

export type CouncilSituation = {
  id: string;
  label: string;
  /** Short blurb shown below the situation select in the settings dialog. */
  description: string;
  /** Steers the framer LLM. Pasted into FRAMER_SYSTEM as situation context. */
  framingHint: string;
  /** Personas (by id, from COUNCIL_PERSONAS) seeded when this situation is picked. */
  defaultPersonaIds: string[];
};

/**
 * Universal council pool. The same voices apply to any kind of decision —
 * career, product, interpersonal, technical, negotiation, life moves,
 * creative critique. Each persona is written to argue from a stance, not
 * a domain, so it transfers across situations.
 */
export const COUNCIL_PERSONAS: CouncilPersona[] = [
  {
    id: "mentor",
    name: "Mentor",
    perspective:
      "A senior voice who has watched many people navigate decisions like this one. Calm and supportive, but blunt about the trade-offs and pitfalls they've seen play out. Cares about long-term outcomes and reputation, not just what feels right today.",
  },
  {
    id: "devils-advocate",
    name: "Devil's advocate",
    perspective:
      "Steel-mans the option the user seems LEAST inclined toward. Surfaces the strongest case against the user's apparent preference. Not contrarian for its own sake — argues the path the user is undervaluing.",
  },
  {
    id: "pragmatist",
    name: "Pragmatist",
    perspective:
      "Wants the smallest thing that could possibly work. Cares about concrete costs, realistic constraints, and what's actually achievable with the resources on hand. Suspicious of vibes-based reasoning and plans that don't survive contact with execution.",
  },
  {
    id: "long-game",
    name: "Long-game strategist",
    perspective:
      "Thinks in 5–10 year arcs. Asks where each option puts the user in terms of optionality, leverage, and the kind of life or work they want to be living in a decade. Discounts short-term comfort against compounding outcomes.",
  },
  {
    id: "financial-realist",
    name: "Financial realist",
    perspective:
      "Reads every decision through cost, runway, and downside risk. Cares about what the choice actually costs, what happens in a bad scenario, and the total cost over time — not just the sticker price. Suspicious of optimistic projections.",
  },
  {
    id: "future-self",
    name: "Future self",
    perspective:
      "Imagines the user 5 and 10 years out and works backward. Asks what version of this decision they'll be glad they made, and which one quietly compounds into regret.",
  },
  {
    id: "honest-mirror",
    name: "Honest mirror",
    perspective:
      "Gently surfaces the user's role in the situation — patterns, blind spots, things they might be doing that contribute to the problem. Caring but unflinching. Asks the question the user is avoiding.",
  },
  {
    id: "bold-move",
    name: "Bold-move advocate",
    perspective:
      "Argues for the move that scares the user. Believes most people regret the safe choice and that good outcomes compound through asymmetric bets. Names the upside that fear is hiding.",
  },
  {
    id: "reversibility",
    name: "Reversibility checker",
    perspective:
      "Asks how expensive this is to undo, and at which step it becomes irreversible. Looks for ways to make the bet smaller — a trial run, a soft launch, a cheap experiment — before fully committing.",
  },
  {
    id: "ruthless-cutter",
    name: "Ruthless cutter",
    perspective:
      "Argues for cutting more than feels comfortable. Believes most plans, drafts, and decisions carry 30% too much, and that the best version is hiding inside the current one. Allergic to scope creep and 'just one more thing'.",
  },
];

export const COUNCIL_SITUATIONS: CouncilSituation[] = [
  {
    id: "career-advice",
    label: "Career advice",
    description:
      "Job offers, leaving / staying, pivots, promotions, finding a co-founder.",
    framingHint:
      "The user is thinking through a career decision. Surface what matters most for a grounded debate: time horizon (next 6 months vs. next 5 years), financial runway and risk tolerance, what they actually want from work, family / relationship constraints, and any concrete options on the table (offers, deadlines, current comp). Do NOT ask for life history — only the load-bearing facts the council needs to argue well.",
    defaultPersonaIds: ["mentor", "devils-advocate", "pragmatist", "long-game"],
  },
  {
    id: "product-decision",
    label: "Product / startup decision",
    description:
      "Build vs. kill, pivot, pricing, hiring, fundraise, go-to-market.",
    framingHint:
      "The user is making a product or company decision. Surface: what stage the company is at, the constraint that's actually binding (cash, distribution, talent, attention), the data they have vs. the data they're guessing, and the reversibility of the decision. Frame it so the council can argue with concrete numbers, not vibes.",
    defaultPersonaIds: [
      "pragmatist",
      "devils-advocate",
      "financial-realist",
      "ruthless-cutter",
    ],
  },
  {
    id: "interpersonal",
    label: "Hard interpersonal call",
    description:
      "Difficult conversations, relationships, family, conflict resolution.",
    framingHint:
      "The user is navigating a hard interpersonal situation. Surface: who the relationship is to and how long it has been important, what specifically happened recently, what the user actually wants the outcome to be (repair, distance, acknowledgement, change), and any constraints they can't change. Do NOT psychoanalyse — just gather the facts the council needs to advise on action.",
    defaultPersonaIds: [
      "honest-mirror",
      "mentor",
      "devils-advocate",
      "future-self",
    ],
  },
  {
    id: "technical-architecture",
    label: "Technical / architecture decision",
    description:
      "System design, framework choice, refactor vs. rewrite, build vs. buy.",
    framingHint:
      "The user is making an engineering decision. Surface: the actual constraints (team size, deadline, expected scale, existing stack), what they've already tried, the cost of being wrong in each direction, and reversibility. Don't ask for theoretical preferences — get the load-bearing facts so the council can argue about real trade-offs, not abstractions.",
    defaultPersonaIds: [
      "pragmatist",
      "devils-advocate",
      "ruthless-cutter",
      "reversibility",
    ],
  },
  {
    id: "negotiation",
    label: "Negotiation prep",
    description:
      "Salary, offer, contract, deal terms, vendor pricing, equity split.",
    framingHint:
      "The user is preparing for a negotiation. Surface: who the counterparty is and their likely incentives, what the user actually wants (and their BATNA — best alternative if this falls through), the concrete numbers / terms on the table, deadlines, and what they've signalled so far. Frame it so the council can rehearse specific moves and counter-moves, not generic 'negotiate harder' advice.",
    defaultPersonaIds: [
      "pragmatist",
      "devils-advocate",
      "bold-move",
      "financial-realist",
    ],
  },
  {
    id: "big-life-move",
    label: "Big life move",
    description:
      "Relocation, buying a home, having kids, marriage, major financial commitment.",
    framingHint:
      "The user is weighing a large, hard-to-reverse life decision. Surface: what specifically is on the table (city, property, timeline), who else is affected, financial capacity vs. the commitment, what 'staying put' actually costs, and any deadlines forcing the call. Avoid lifestyle quizzes — get the load-bearing facts so the council can argue about THIS decision, not life philosophy.",
    defaultPersonaIds: [
      "financial-realist",
      "future-self",
      "reversibility",
      "mentor",
    ],
  },
  {
    id: "creative-critique",
    label: "Creative critique",
    description:
      "Review a draft — writing, design, music, pitch, talk, portfolio piece.",
    framingHint:
      "The user wants feedback on a creative piece. Surface: what the piece IS (paste / link / summary), who it's for, what stage it's at (rough draft vs. nearly shipping), what kind of feedback they want (structural vs. line-level vs. directional), and what they're already worried about. Don't ask them to defend the work — just get enough context for the council to critique sharply.",
    defaultPersonaIds: [
      "ruthless-cutter",
      "devils-advocate",
      "honest-mirror",
      "mentor",
    ],
  },
  {
    id: "custom",
    label: "Custom (blank)",
    description:
      "Start with no preset members — build the council from scratch.",
    framingHint:
      "Read the chat carefully and surface 2–4 short, load-bearing clarifying questions that would change how a thoughtful advisor responds. Avoid generic openers; tailor each question to what's actually in the conversation.",
    defaultPersonaIds: [],
  },
];

export const DEFAULT_COUNCIL_SITUATION_ID = "career-advice";

export function getSituation(id: string | undefined): CouncilSituation {
  return (
    COUNCIL_SITUATIONS.find((s) => s.id === id) ??
    COUNCIL_SITUATIONS.find((s) => s.id === DEFAULT_COUNCIL_SITUATION_ID) ??
    COUNCIL_SITUATIONS[0]
  );
}

/** Roster (sans ids and model) loaded when a situation is picked or Reset is
 *  clicked. Default seeds the full pool — the user can remove or swap from
 *  there. The caller fills in `model` with a single consistent choice so the
 *  debate is fair; see `pickMemberModel` in the dialog. `situation` is kept
 *  on the signature so we can re-introduce per-situation defaults later
 *  without touching callers. */
export function getDefaultMembers(
  _situation: CouncilSituation
): Omit<CouncilMember, "id" | "model">[] {
  return COUNCIL_PERSONAS.map((p) => ({
    name: p.name,
    perspective: p.perspective,
  }));
}

export const MAX_COUNCIL_MEMBERS = 10;
export const MAX_COUNCIL_DEBATE_ROUNDS = 2;

/** Bumped whenever the default council roster changes shape. Stored on
 *  `settings.councilSeedVersion` so we re-seed users sitting on an old
 *  default exactly once. v2: full 10-persona pool (was 4 per situation).
 *  v3: drop the per-persona model so all members run on one consistent LLM
 *  — the v2 default seeded a mix of frontier and mid-tier models, which
 *  biased debates toward whichever persona happened to draw the strong one. */
export const CURRENT_COUNCIL_SEED_VERSION = 3;

function makeCouncilMemberId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** True if `members` looks like a pre-v2 default roster for ANY situation —
 *  i.e. the user never touched their council and what they have is just
 *  stale seed data. Matches by NAME ONLY (in order), because persona
 *  perspective text has been rewritten over time, so even untouched stored
 *  rosters won't agree on the prose. Models drift too (the dialog overwrites
 *  them with the chat's current model). Names, in contrast, are stable. */
function isPreV2DefaultRoster(members: CouncilMember[]): boolean {
  for (const situation of COUNCIL_SITUATIONS) {
    const legacyNames = situation.defaultPersonaIds
      .map((id) => COUNCIL_PERSONAS.find((p) => p.id === id)?.name)
      .filter((n): n is string => Boolean(n));
    if (legacyNames.length === 0) continue;
    if (legacyNames.length !== members.length) continue;
    if (legacyNames.every((n, i) => n === members[i].name)) return true;
  }
  return false;
}

/** True if `members` is the v2 default — all 10 personas in canonical order.
 *  Used to detect rosters that need their heterogeneous v2 models flattened
 *  to one consistent model. Custom rosters (different order, different names,
 *  added/removed members) don't match and are left alone. */
function isV2DefaultRoster(members: CouncilMember[]): boolean {
  if (members.length !== COUNCIL_PERSONAS.length) return false;
  return COUNCIL_PERSONAS.every((p, i) => p.name === members[i].name);
}

/** Pick a single model for every member of a freshly-seeded or migrated
 *  roster. Prefers the chat's current model so the council follows whatever
 *  the user picked in the composer, then falls back to the global default.
 *  The dialog uses a richer `pickMemberModel` that also checks the visible
 *  list; this one runs at settings-load time without that context. */
function pickConsistentModel(s: Settings): string {
  return s.defaultModel?.trim() || DEFAULT_MODEL;
}

/** One-time migration to the current council seed version. Returns a new
 *  Settings object if anything changed, or `null` if no migration was needed
 *  (caller can skip the IndexedDB write). Safe to call on every settings load.
 *
 *  Behaviour by case (when stored `councilSeedVersion < CURRENT`):
 *  - No stored roster: just bump the version. The dialog seeds fresh on first
 *    open using the current default.
 *  - Pre-v2 per-situation default (4 members): replace it with the current
 *    full-pool default, all on one consistent model.
 *  - v2 full-pool default (10 members on mixed models): keep the personas,
 *    rewrite every model to one consistent choice so the debate is fair.
 *  - Stored roster is something else (custom): leave it alone, just bump the
 *    version so we don't keep checking. */
export function migrateCouncilSettings(s: Settings): Settings | null {
  if ((s.councilSeedVersion ?? 0) >= CURRENT_COUNCIL_SEED_VERSION) return null;
  const bumped: Settings = {
    ...s,
    councilSeedVersion: CURRENT_COUNCIL_SEED_VERSION,
  };
  if (!s.councilMembers || s.councilMembers.length === 0) return bumped;
  const model = pickConsistentModel(s);
  if (isPreV2DefaultRoster(s.councilMembers)) {
    const situation = getSituation(s.councilSituationId);
    const seeded: CouncilMember[] = getDefaultMembers(situation).map((m) => ({
      ...m,
      id: makeCouncilMemberId(),
      model,
    }));
    return { ...bumped, councilMembers: seeded };
  }
  if (isV2DefaultRoster(s.councilMembers)) {
    const flattened: CouncilMember[] = s.councilMembers.map((m) => ({
      ...m,
      model,
    }));
    return { ...bumped, councilMembers: flattened };
  }
  return bumped;
}
