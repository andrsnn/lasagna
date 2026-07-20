import { RUNPOD_PREFIX, upstreamModelId } from "@/app/lib/llm/provider";

/**
 * Estimated Ollama Cloud "usage level" (1-4). Ollama Cloud bills usage by
 * GPU-time - how heavy a model is to run, times request duration - not by token
 * count, and groups models into four levels: level 1 is light (Ollama's example
 * is `gpt-oss:20b`) and burns the plan slowly, level 4 is extra-heavy (Ollama's
 * example is `deepseek-v4-pro`) and burns it fastest. Session limits reset every
 * 5 hours, weekly limits every 7 days. These per-model levels are our estimates,
 * anchored to those two published examples and scaled by total/active parameter
 * size; treat them as a rough "how fast does this eat my plan" hint, not a
 * billing guarantee. See https://ollama.com/pricing.
 */
export type BurnLevel = 1 | 2 | 3 | 4;

export type CloudModel = {
  id: string;
  label: string;
  size: string;
  useCase: string;
  /** Published Ollama context window (input tokens). */
  contextTokens: number;
  /** Model accepts image inputs alongside text. */
  vision?: boolean;
  /** Estimated Ollama Cloud usage level (1 = light, 4 = burns plan fastest). */
  burn?: BurnLevel;
};

/**
 * Curated metadata overlay. The authoritative list of models the user can
 * actually run is fetched at runtime from Ollama Cloud via `/api/models` —
 * this catalog only supplies labels, use-case blurbs, vision flags and
 * context windows for ids that we know about. Discovered models that aren't
 * in the catalog get sensible defaults (id-as-label, 128k ctx).
 */
export const CATALOG: CloudModel[] = [
  // -- Conversation / EQ / all-round flagship -------------------------------
  { id: "kimi-k2.6",           label: "Kimi K2.6",         size: "~1T MoE",      useCase: "Best for therapy & natural conversation (EQ); strong agentic coding & multimodal", contextTokens: 256_000, vision: true, burn: 4 },

  // -- Coding & agentic dev -------------------------------------------------
  { id: "qwen3-coder-next",    label: "Qwen3 Coder Next",  size: "MoE",          useCase: "Best dedicated coder: coding & agentic dev workflows", contextTokens: 256_000, burn: 3 },
  { id: "minimax-m3",          label: "MiniMax M3",        size: "MoE, ~1M ctx", useCase: "Frontier coding/agentic + long-context multimodal research", contextTokens: 512_000, vision: true, burn: 3 },
  { id: "glm-5.2",             label: "GLM-5.2",           size: "MoE, ~1M ctx", useCase: "Strongest open (MIT) coding & agentic model; 1M context", contextTokens: 1_000_000, burn: 3 },
  { id: "glm-5.1",             label: "GLM-5.1",           size: "756B MoE",     useCase: "Agentic engineering & coding (top SWE-Bench Pro)", contextTokens: 198_000, burn: 3 },
  { id: "kimi-k2.7",           label: "Kimi K2.7",         size: "~1T MoE",      useCase: "Agentic coding & all-round; strong reasoning and tool use", contextTokens: 256_000, vision: true, burn: 4 },
  { id: "kimi-k2.7-code",      label: "Kimi K2.7 Code",    size: "~1T MoE",      useCase: "Agentic coding specialist; lower thinking-token usage", contextTokens: 256_000, vision: true, burn: 4 },
  { id: "qwen3-coder:480b",    label: "Qwen3 Coder 480B",  size: "480B",         useCase: "Long-context agentic coding (top verified SWE-bench)", contextTokens: 256_000, burn: 3 },

  // -- Deep research / frontier reasoning -----------------------------------
  { id: "deepseek-v4-pro",     label: "DeepSeek V4 Pro",   size: "1.6T/49B MoE", useCase: "Frontier reasoning & deep research; 1M context", contextTokens: 1_000_000, burn: 4 },
  { id: "deepseek-v4-flash",   label: "DeepSeek V4 Flash", size: "284B/13B MoE", useCase: "Fast long-context reasoning; 1M context", contextTokens: 1_000_000, burn: 2 },
  { id: "nemotron-3-ultra",    label: "Nemotron 3 Ultra",  size: "550B/55B MoE", useCase: "Long-running agents & high-throughput reasoning", contextTokens: 256_000, burn: 3 },
  { id: "deepseek-v3.1:671b",  label: "DeepSeek V3.1 671B", size: "671B",        useCase: "Hybrid reasoning; verified strong coding", contextTokens: 160_000, burn: 3 },

  // -- Vision / multimodal --------------------------------------------------
  { id: "qwen3.5:397b",        label: "Qwen3.5 397B",      size: "397B/17B MoE", useCase: "Best open vision/multimodal: charts, docs, images; 201 languages", contextTokens: 256_000, vision: true, burn: 3 },

  // -- Fast / cheaper general chat ------------------------------------------
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", size: "—",           useCase: "Fast frontier intelligence + vision, 1M context (proprietary, cloud-only)", contextTokens: 1_000_000, vision: true, burn: 2 },
  { id: "gpt-oss:120b",        label: "GPT-OSS 120B",      size: "120B",         useCase: "Fast, strong general reasoning & agentic (OpenAI open-weight)", contextTokens: 128_000, burn: 2 },
  { id: "gpt-oss:20b",         label: "GPT-OSS 20B",       size: "20B",          useCase: "Faster, cheaper general chat",        contextTokens: 128_000, burn: 1 },
  { id: "gemma4:31b",          label: "Gemma 4 31B",       size: "31B",          useCase: "Small/fast general chat with vision",  contextTokens: 256_000, vision: true, burn: 1 },
  { id: "nemotron-3-nano:30b", label: "Nemotron 3 Nano",   size: "30B/3B MoE",   useCase: "Efficient high-throughput agentic tasks", contextTokens: 128_000, burn: 1 },
];

/**
 * @deprecated Pre-dynamic-discovery alias for the curated catalog. Prefer
 * `useAvailableModels()` on the client and `/api/models` on the server.
 * Kept so SSR / fallback paths still have something to render.
 */
export const MODELS = CATALOG;

const CATALOG_BY_ID = new Map(CATALOG.map((m) => [m.id, m]));

/** Look up curated metadata for `id`, falling back to the bare model name.
 *  Strips any `runpod:` prefix first so a RunPod-routed alias of a known
 *  Ollama tag (e.g. `runpod:gpt-oss:120b`) inherits the catalog entry. */
export function catalogEntry(id: string): CloudModel | undefined {
  const bare = upstreamModelId(id);
  return CATALOG_BY_ID.get(bare) ?? CATALOG_BY_ID.get(bare.split(":")[0]);
}

/** Synthesize a CloudModel for a model id we have no curated entry for. */
export function defaultModelMeta(id: string, parameterSize?: string, vision?: boolean): CloudModel {
  const isRunpod = id.startsWith(RUNPOD_PREFIX);
  return {
    id,
    label: id,
    size: parameterSize ?? "—",
    useCase: isRunpod
      ? "Available via your RunPod endpoint"
      : "Available on your Ollama account",
    contextTokens: 128_000,
    vision,
  };
}

/**
 * Synthesize a stand-in CloudModel for a configured RunPod endpoint. We surface
 * this whenever the user has set `runpodEndpointId` so they can target their
 * endpoint from the picker even if the worker doesn't expose `/v1/models`
 * (some vLLM/SGLang/custom workers omit it). The bare `default` id is what
 * gets sent upstream — for OpenAI-compat workers that ignore the model param,
 * or `svenbrnn/runpod-ollama` images that resolve it via OLLAMA_MODEL, this is
 * enough to start chatting; the user can add a more specific
 * `runpod:<modelid>` later if their worker rejects it.
 */
export const RUNPOD_DEFAULT_MODEL_ID = `${RUNPOD_PREFIX}default`;

export function syntheticRunpodModel(endpointId: string): CloudModel {
  const trimmed = endpointId.trim();
  return {
    id: RUNPOD_DEFAULT_MODEL_ID,
    label: trimmed ? `RunPod · ${trimmed}` : "RunPod endpoint",
    size: "—",
    useCase: "Routes to your configured RunPod endpoint",
    contextTokens: 128_000,
  };
}

export type RawOllamaModel = {
  name?: string;
  model?: string;
  details?: {
    family?: string;
    families?: string[];
    parameter_size?: string;
  };
};

/**
 * Merge the live `ollama.list()` result with the curated catalog. Order
 * follows the upstream list so the user sees their account's models in
 * Ollama's preferred order; deduped by id.
 */
export function mergeModels(raw: ReadonlyArray<RawOllamaModel>): CloudModel[] {
  const seen = new Set<string>();
  const out: CloudModel[] = [];
  for (const r of raw) {
    const id = r.name ?? r.model;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const curated = catalogEntry(id);
    if (curated) {
      out.push({ ...curated, id });
      continue;
    }
    const families = r.details?.families ?? (r.details?.family ? [r.details.family] : []);
    const visionFamily = families.some((f) => /vision|llava|multimodal/i.test(f));
    out.push(defaultModelMeta(id, r.details?.parameter_size, visionFamily || undefined));
  }
  return out;
}

export function modelSupportsVision(id: string): boolean {
  return catalogEntry(id)?.vision === true;
}

/**
 * Deterministic display order for model pickers: alphabetical by label with
 * natural numeric ordering, so "GPT-OSS 20B" sorts before "GPT-OSS 120B" and
 * "Kimi K2.6" before "Kimi K2.7". Ollama Cloud's live `list()` returns models
 * in an order that changes between calls, which made the picker reshuffle every
 * time it was opened; sorting by label gives one repeatable order the user can
 * rely on. Ties on label fall back to id so the ordering is total (stable
 * across renders). Returns a new array; does not mutate the input.
 */
export function sortModelsForDisplay(
  models: ReadonlyArray<CloudModel>
): CloudModel[] {
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  return [...models].sort(
    (a, b) => collator.compare(a.label, b.label) || collator.compare(a.id, b.id)
  );
}

/** Estimated Ollama Cloud usage level for `id`, or undefined if we don't have a
 *  curated burn level (e.g. a discovered model or a RunPod endpoint, where the
 *  plan-burn concept doesn't apply). See {@link BurnLevel}. */
export function burnLevel(id: string): BurnLevel | undefined {
  return catalogEntry(id)?.burn;
}

/**
 * Approximate plan-burn rate per level, relative to a level-1 model (the
 * lightest, e.g. gpt-oss:20b = 1x). Ollama bills by GPU-time and does not
 * publish per-level multipliers, so these are deliberately round
 * order-of-magnitude estimates scaled from model size - enough to answer
 * "roughly how much faster does this drain my plan than the lightest model",
 * not a billing figure. Each level is about 2x the one below it.
 */
const BURN_RATE: Readonly<Record<BurnLevel, number>> = {
  1: 1,
  2: 3,
  3: 6,
  4: 12,
};

/** Estimated plan-burn rate for `id` relative to the lightest model (1x), or
 *  undefined when we have no burn level for it. See {@link BURN_RATE}. */
export function burnRate(id: string): number | undefined {
  const lvl = burnLevel(id);
  return lvl ? BURN_RATE[lvl] : undefined;
}

/**
 * Short, value-first note on how fast `id` eats your Ollama Cloud plan, e.g.
 * "lvl 3/4 · ~6x" - i.e. drains the plan about six times faster than the
 * lightest model. Level 1 reads "~1x (lightest)". Returns "" for models we
 * don't rate so callers can omit it. The "~Nx" baseline is meant to be spelled
 * out once next to the picker; see {@link BURN_RATE}.
 */
export function burnNote(id: string): string {
  const lvl = burnLevel(id);
  if (!lvl) return "";
  const x = BURN_RATE[lvl];
  return lvl === 1 ? "lvl 1/4 · ~1x (lightest)" : `lvl ${lvl}/4 · ~${x}x`;
}

/**
 * Small vision model used to describe uploaded images when the user picks a
 * text-only main model. Must be in CATALOG with `vision: true`.
 */
export const VISION_DESCRIBER_MODEL = "gemma4:31b";

/** @deprecated The live allow-list now comes from `/api/models`. */
export const MODEL_IDS = CATALOG.map((m) => m.id);
// kimi-k2.6: the default for general artifact.query data fetches. (deepseek-v4-pro
// is faster/more robust but far more expensive, so it's not the default - choose
// it per-app when a query genuinely needs it.) NOTE: during testing kimi-k2.6 /
// minimax-m3 were timing out on the backend; if scans/research stall, it's that
// backend load, not the app.
export const DEFAULT_MODEL = "kimi-k2.6";

/**
 * Default model for Structured research in chat / scheduled refreshes. MiniMax
 * M3 is the long-horizon agentic + long-context pick. Overridable per-user via
 * Settings.researchModel and per-app via the schedule task's `model`.
 */
export const DEFAULT_RESEARCH_MODEL = "minimax-m3";

/**
 * Default model for unattended scheduled runs - the cron-fired refreshes behind
 * scheduled tasks, apps and widgets. GPT-OSS 120B is fast, cheap and strong
 * enough for the recurring "re-fetch and summarize" shape these jobs almost
 * always are; unattended jobs fire on their own and can burn a plan quietly, so
 * the built-in default deliberately favors a light model over a frontier one.
 *
 * Overridable globally via `Settings.scheduledModel` (Preferences → Defaults →
 * Scheduled tasks) and per-app via the app's own Model setting, which always
 * wins. Deep-research schedules still resolve through
 * {@link DEFAULT_RESEARCH_MODEL} instead - a research table needs the
 * long-context model, not the fast one.
 */
export const DEFAULT_SCHEDULED_MODEL = "gpt-oss:120b";

/**
 * Best catalog model for emotionally attuned conversation — used by
 * therapist mode to suggest a switch when the chat is pinned to another
 * model. Kimi K2.6 leads open models on EQ-Bench 3 emotional intelligence
 * (~1576 Elo) and EQ-Bench Creative (~1782), well ahead of GLM-5 (1658),
 * DeepSeek V3.2 (1515), Qwen3-235B (1459), and MiniMax (1330); coding/agentic
 * models in particular drift into formulaic therapy-speak.
 */
export const THERAPY_RECOMMENDED_MODEL = "kimi-k2.6";

/**
 * Best catalog model per task, distilled from mid-2026 open-model benchmark
 * standings (SWE-bench Verified, Artificial Analysis Intelligence Index,
 * EQ-Bench 3, vision benchmarks). These are the picks we steer toward and
 * surface in copy; `THERAPY_RECOMMENDED_MODEL` above is the conversation
 * entry and stays a standalone export because therapist mode imports it
 * directly. Every id here is also in `DEFAULT_ENABLED_MODELS` so the
 * recommended model is visible in the picker out of the box.
 */
export const BEST_FOR: Readonly<Record<string, string>> = {
  /** Agentic coding & dev workflows — purpose-built coder. */
  coding: "qwen3-coder-next",
  /** Long-horizon agentic tasks / tool use across many turns. */
  agentic: "minimax-m3",
  /** Deep research & frontier reasoning over very long context (1M). */
  research: "deepseek-v4-pro",
  /** Emotionally attuned conversation & therapy (EQ). */
  therapy: THERAPY_RECOMMENDED_MODEL,
  /** Vision / multimodal — charts, documents, images. */
  vision: "qwen3.5:397b",
  /** Fast, cheaper everyday general chat. */
  general: "gpt-oss:120b",
};

/**
 * Ordered, human-facing version of {@link BEST_FOR} for a "Best for the job"
 * picker: the user chooses what they're doing and we switch to the model that
 * leads that task. `label` is the dropdown text; `hint` is a short gloss.
 * Keep this in sync with BEST_FOR — same model ids, just presentation.
 */
export type TaskPick = {
  task: keyof typeof BEST_FOR | string;
  label: string;
  hint: string;
  model: string;
};

export const TASK_PICKS: readonly TaskPick[] = [
  { task: "coding",   label: "Coding",        hint: "code & dev edits",      model: BEST_FOR.coding },
  { task: "agentic",  label: "Agentic tasks", hint: "long multi-step / tools", model: BEST_FOR.agentic },
  { task: "research", label: "Deep research", hint: "reasoning, long docs",  model: BEST_FOR.research },
  { task: "therapy",  label: "Therapy & talk", hint: "warm conversation (EQ)", model: BEST_FOR.therapy },
  { task: "vision",   label: "Vision & images", hint: "charts, docs, photos", model: BEST_FOR.vision },
  { task: "general",  label: "Fast general chat", hint: "quick everyday answers", model: BEST_FOR.general },
];

/** The task whose recommended model is `id`, if any (for reflecting selection). */
export function taskForModel(id: string): TaskPick | undefined {
  return TASK_PICKS.find((t) => t.model === id);
}

/**
 * Models best suited to structured / deep research, in recommendation order:
 * long-horizon agentic reasoning over long context. The first id is
 * {@link DEFAULT_RESEARCH_MODEL}. Drives the research model pickers (chat
 * Structured-research card + saved Research apps) so the strong-research models
 * float to the top of the list instead of being buried among small/fast chat
 * models that produce thin research tables.
 */
export const RESEARCH_MODEL_IDS: readonly string[] = Array.from(
  new Set([
    DEFAULT_RESEARCH_MODEL, // long-horizon agentic + long-context multimodal
    BEST_FOR.research,      // frontier reasoning & deep research, 1M context
    "deepseek-v4-flash",    // fast long-context reasoning, 1M context
    "glm-5.2",              // strong agentic, 1M context
    "nemotron-3-ultra",     // long-running agents & high-throughput reasoning
    "kimi-k2.6",            // strong all-round + long context
  ])
);

/** Split `available` into (ids ∩ available, in `ids` order) and the rest. */
function partitionByIds(
  available: ReadonlyArray<CloudModel>,
  ids: readonly string[]
): { recommended: CloudModel[]; others: CloudModel[] } {
  const byId = new Map(available.map((m) => [m.id, m]));
  const recommended: CloudModel[] = [];
  const picked = new Set<string>();
  for (const id of ids) {
    const m = byId.get(id);
    if (m && !picked.has(id)) {
      recommended.push(m);
      picked.add(id);
    }
  }
  const others = available.filter((m) => !picked.has(m.id));
  return { recommended, others };
}

/**
 * Split an available-models list into the research-recommended set (in
 * {@link RESEARCH_MODEL_IDS} order, only those the account can actually run)
 * and everything else (in the account's original order). Used by the research
 * model picker to group the dropdown.
 */
export function partitionResearchModels(available: ReadonlyArray<CloudModel>): {
  recommended: CloudModel[];
  others: CloudModel[];
} {
  return partitionByIds(available, RESEARCH_MODEL_IDS);
}

/**
 * Default chat model for hands-free voice mode. A spoken conversation lives
 * and dies by time-to-first-token: the huge MoE flagships (kimi-k2.6,
 * deepseek-v4-pro) give noticeably better prose but make the user sit in
 * silence for several extra seconds per turn, which reads as "broken" in
 * voice. gpt-oss:120b is the best fast-and-still-smart tradeoff in the
 * catalog (burn 2, strong general reasoning). Overridable per-user via
 * Settings.voiceModel and the picker inside voice mode.
 */
export const DEFAULT_VOICE_MODEL = "gpt-oss:120b";

/**
 * Models best suited to live voice conversation, in recommendation order:
 * fast first token, conversational quality second. Drives the grouped model
 * picker inside voice mode. kimi-k2.6 is included last for users who want
 * the best conversational EQ and will tolerate a slower first reply.
 */
export const VOICE_MODEL_IDS: readonly string[] = [
  DEFAULT_VOICE_MODEL,   // fast + strong general chat (the default)
  "gemma4:31b",          // lightest with good conversational tone
  "gpt-oss:20b",         // fastest/cheapest, fine for casual back-and-forth
  "deepseek-v4-flash",   // fast long-context reasoning when turns get meaty
  "kimi-k2.6",           // best EQ/conversation quality; slower first token
];

/**
 * Voice-mode grouping of the picker: recommended-for-voice first (in
 * {@link VOICE_MODEL_IDS} order), then everything else the account can run.
 */
export function partitionVoiceModels(available: ReadonlyArray<CloudModel>): {
  recommended: CloudModel[];
  others: CloudModel[];
} {
  return partitionByIds(available, VOICE_MODEL_IDS);
}

/**
 * Fallback model for `artifact.query()` in a public shared app when the share
 * didn't capture an explicit model. Gemma is small, fast, and broadly
 * available, so it's the safe default for anonymous viewers — matching how
 * artifact queries behave in the app.
 */
export const SHARE_QUERY_DEFAULT_MODEL = "gemma4:31b";

/**
 * Models shown in the picker for users who haven't customized Preferences.
 * A short curated set keeps first-time users from drowning in choices; they
 * can enable more (or disable these) via the Preferences dialog. When
 * `Settings.enabledModels` is undefined, this list is the visible set.
 */
export const DEFAULT_ENABLED_MODELS: readonly string[] = [
  "kimi-k2.6",        // best conversation/EQ + strong all-round (therapy default)
  "glm-5.2",          // strongest open (MIT) coder/agentic, 1M context
  "qwen3-coder-next", // best dedicated coder
  "kimi-k2.7",        // Kimi K2.7 all-round agentic
  "kimi-k2.7-code",   // agentic coding specialist (Kimi K2.7), fewer thinking tokens
  "minimax-m3",       // frontier coding/agentic + long-context multimodal
  "deepseek-v4-pro",  // deep research / frontier reasoning, 1M context
  "qwen3.5:397b",     // best open vision/multimodal (qwen3-vl:235b cloud tag retiring 2026-06-16)
  "gpt-oss:120b",     // fast, strong general default
  "gpt-oss:20b",      // fastest/cheapest everyday chat
];

export function modelContextTokens(id: string): number {
  return catalogEntry(id)?.contextTokens ?? 128_000;
}

/** Tokens we always keep free for the model's reply. */
export const OUTPUT_RESERVE_TOKENS = 4096;
/** Fraction of (contextTokens - reserve) that triggers auto-compaction. */
export const SUMMARIZE_AT = 0.75;
/** Always keep at least this many of the most-recent messages verbatim when compacting. */
export const KEEP_TAIL_MESSAGES = 6;
