// IndexedDB schema for the Lasagna app.
//
// DATA DURABILITY INVARIANT (v7+):
//   - app.state (the artifact KV) is the user's data and is NEVER deleted by
//     the host. Designer code edits, version bumps, reverts, schema migrations,
//     and DB version bumps must preserve every key in app.state.
//   - State writes are merge-by-key (see mergeAppStateKey). Setting one key
//     never replaces the whole state object. There is no public "clear" or
//     "delete-key" operation on app.state.
//   - Roll-forward only: new versions copy out of legacy stores; the old stores
//     remain readable for one DB version after migration so a hotfix can
//     recover from a buggy migration.
//   - Apps cannot be hard-deleted. archiveApp moves a row from `apps` to
//     `archivedApps`; deleteDesigner cascades through archiveApp first.
//
// Stores:
//   messages       chat messages (carry chatId; system role + summary kind).
//   settings       singleton user settings.
//   chats          first-class chats; can target a designer (edit) or app (use).
//   designers      v7+ replaces legacy `templates` (1:1 rename + structural copy).
//   apps           v7+ replaces legacy `instances`; pairs to designers by id
//                  (app.id === designer.id). No templateId field anymore.
//   archivedApps   v7+ non-canonical legacy instances + soft-deleted apps.
//   queryCache     transient artifact.query/fetch result cache. Regenerable.
//   pendingQueries in-flight artifact.query streamIds for tab-close recovery.
//   templates      v6 legacy. Read-only after v7 upgrade; scheduled removal in v8.
//   instances      v6 legacy. Same.

export type StoredUsage = {
  promptTokens: number;
  completionTokens: number;
  evalMs: number;
  totalMs: number;
  tokensPerSec: number;
  // Set when the model hit its output-token ceiling and the reply was cut off
  // mid-thought (provider stop reason "length"). Drives the in-place
  // "Continue" affordance on completed assistant messages.
  truncated?: boolean;
};

export type ToolEvent =
  | { kind: "call"; name: string; args: Record<string, unknown>; at: number }
  | { kind: "result"; name: string; summary?: string; error?: string; at: number };

export type CouncilFramingQuestion = {
  id: string;
  question: string;
  /** When provided, the framing card renders pill choices instead of a free-
   *  text textarea. The user can still type a custom answer alongside. */
  suggestedAnswers?: string[];
};

/** Pre-framer actions surfaced to the user in the framing card so the
 *  describe_image / attach_pdf work the framing endpoint did before
 *  generating its scoping questions is visible (otherwise the user sees
 *  the questions but has no way to tell the framer actually read the
 *  attached image). */
export type FramerAction =
  | {
      kind: "describe_image";
      /** 1-based index within the user message's attachments. */
      index: number;
      name?: string;
      describer: string;
      summary?: string;
      error?: string;
    }
  | {
      kind: "attach_pdf";
      index: number;
      name: string;
      pageCount: number;
      truncated?: boolean;
    };

export type CouncilFramingPayload = {
  /** One-line explanation from the framer for why these questions matter — shown above the form. */
  rationale: string;
  questions: CouncilFramingQuestion[];
  /**
   * User's answers keyed by question id. Persisted as the user types so a
   * tab close doesn't lose progress. `undefined` for unanswered questions.
   */
  answers?: Record<string, string>;
  /** Roster + situation captured at framing time so the run uses the same shape the questions assumed. */
  members: CouncilMember[];
  situationId: string;
  /** Pre-framer actions (describe_image, attach_pdf) surfaced in the card so
   *  the user can see the framer actually read their attachments. */
  actions?: FramerAction[];
  /** Once the user clicks "Run council", we record the launched stream's
   *  assistant message id so the framing card can disable its submit and
   *  link to the synthesis bubble. */
  launchedAssistantId?: string;
  pendingImageCount?: number;
  pendingPdfCount?: number;
};

/** Same shape as `CouncilFramingPayload` minus the council-specific roster
 *  and situation — research framing has no debaters. The answers feed the
 *  research planner so its sub-questions reflect the user-confirmed
 *  scope (entities, time window, source types, depth). */
export type ResearchFramingPayload = {
  rationale: string;
  questions: CouncilFramingQuestion[];
  answers?: Record<string, string>;
  /** Pre-framer actions (describe_image, attach_pdf) surfaced in the card so
   *  the user can see the framer actually read their attachments. */
  actions?: FramerAction[];
  /** Set once the user clicks "Run research" — disables the card and links
   *  it to the synthesis bubble. */
  launchedAssistantId?: string;
  /** Number of images being described server-side before framing starts.
   *  Set on the placeholder so the card can show "Describing N images…"
   *  instead of jumping straight to "Framing the question…". */
  pendingImageCount?: number;
  pendingPdfCount?: number;
  /** When `"choice"`, no framer has run yet: the card shows the up-front
   *  decision ("Frame first" vs. "Research now") and waits for the user to
   *  pick before anything kicks off. Cleared once a choice is made. */
  stage?: "choice";
  /** Set when the framer errored or timed out. The card then offers "Retry
   *  framing" / "Run research as-is" instead of silently auto-launching the
   *  research — so a flaky framer never decides for the user. */
  framerFailed?: boolean;
};

/** One row in a structured-research result. `id` is a stable, model-assigned
 *  identity (e.g. normalized company + person) used to dedupe/merge on re-run.
 *  `fields` are the per-column values keyed by the schema's column keys. */
export type ResearchRecord = {
  id: string;
  fields: Record<string, unknown>;
};

/** A display column derived from the auto-generated schema. */
export type ResearchColumn = {
  key: string;
  label: string;
  /** Render hint. "link" makes the value an anchor; others render as text. */
  type?: "text" | "link" | "number";
};

/** One run in the append history. */
export type ResearchRun = {
  at: number;
  /** The query used for this run (may differ from the original on a re-run). */
  query: string;
  status: "running" | "complete" | "error" | "stopped";
  /** How this run folds into the table on completion. "append" (default) keeps
   *  the existing columns and merges new rows by id. "fresh" re-derives the
   *  columns from the (edited) query and REPLACES the rows - used when the
   *  prompt was corrected and the old shape/results should be discarded.
   *  Absent ⇒ "append" for back-compat with runs persisted before this field. */
  mode?: "append" | "fresh";
  /** Record ids that were NEW in this run (for the "added N" badge). */
  addedIds?: string[];
  error?: string;
  /** Resume handle while this run streams server-side. Cleared when terminal. */
  streamId?: string;
};

/** Payload for `kind === "research-result"` — the in-chat structured research
 *  artifact. Records accumulate across runs (append/merge by `id`); the viewer
 *  renders them as a table/cards driven by `columns`. */
export type StructuredResearchPayload = {
  /** Current/last query. */
  query: string;
  /** Auto-derived columns the viewer renders. */
  columns: ResearchColumn[];
  /** Column key(s) whose values identify a row, chosen dynamically per query
   *  (e.g. ["company"], ["name","company"], ["title"]). Used to dedupe/merge.
   *  Empty/absent ⇒ fall back to the first column. */
  idKeys?: string[];
  /** JSON-schema-ish shape the synthesis must conform to (records wrapper). */
  schema: unknown;
  /** Merged records across all runs. */
  records: ResearchRecord[];
  /** Newest-last run history. */
  runs: ResearchRun[];
  /** Overall status of the most recent run. */
  status: "running" | "complete" | "error" | "stopped";
  error?: string;
  /** Model used (for display). */
  model?: string;
};

/** One report inside a Multi Research card. Starts as an editable prompt the
 *  model drafted (`draft`), then becomes a self-driving research run whose
 *  finished markdown lands in `report` (with inline `Sources`). Each report
 *  owns its own `streamId` so N of them run in parallel and resume
 *  independently after a reload — the same self-driving model as the
 *  structured-research viewer, but producing a prose report instead of a table. */
export type MultiResearchReport = {
  id: string;
  /** Short human label shown on the report card header (e.g. "Business opportunity"). */
  title: string;
  /** The research prompt — editable by the user during the review stage. */
  prompt: string;
  /** Depth of the run. "deep" spends more sub-agent rounds; "standard" is faster. */
  depth?: "standard" | "deep";
  status: "draft" | "running" | "done" | "error" | "stopped";
  /** Resume handle for an in-flight run; cleared when the run settles. */
  streamId?: string;
  /** Epoch ms the run started (drives the elapsed timer). */
  startedAt?: number;
  /** Full markdown report (findings + inline citations + a Sources list). */
  report?: string;
  /** Coarse last progress stage for liveness ("Researching sources (2)…"). */
  progress?: string;
  model?: string;
  error?: string;
  /** Set once the user has saved this report to Notes — hides the Save action. */
  savedNoteId?: string;
};

/** Payload for `kind === "multi-research"` rows. One card owns the whole
 *  round: the model drafts the prompts (`drafting` → `review`), the user
 *  edits/adds/removes them, then "Run" fans out N parallel report runs
 *  (`running` → `done`). Display-only during drafting/review; once reports
 *  finish, `wireContentFor` emits their full markdown so they stay in the
 *  model's context for follow-up questions. */
export type MultiResearchPayload = {
  stage: "drafting" | "review" | "running" | "done";
  /** The user's natural-language ask that seeded the round. */
  intent: string;
  /** One short sentence from the drafter explaining the split. */
  rationale?: string;
  /** The reports — drafted, edited, then run. */
  reports: MultiResearchReport[];
  /** Model used for the runs (for display + defaulting). */
  model?: string;
  /** Set when drafting the prompts failed, so the card can offer a retry. */
  draftError?: string;
};

/** Structured outline returned by /api/novel/outline. Mirrors `NovelOutline`
 *  in app/api/chat/novel/prompts.ts (kept in db.ts as a duplicate so client
 *  code doesn't reach into the route tree). */
export type NovelOutlineCharacter = {
  name: string;
  role: string;
  description: string;
};

export type NovelOutlineChapter = {
  id: string;
  title: string;
  beats: string;
};

export type NovelOutlineData = {
  title: string;
  logline: string;
  setting: string;
  characters: NovelOutlineCharacter[];
  chapters: NovelOutlineChapter[];
};

/** Web searches the premise-research stage issued before the outline was
 *  generated. Surfaced in the editor card so the user can see what was
 *  looked up to ground the outline. Empty array when the model decided no
 *  research was needed. */
export type NovelOutlineSearch = {
  query: string;
  summary: string;
  error?: string;
};

/** Length preset the outline was generated against. Mirrors `NovelLength`
 *  server-side — kept here so the editor card knows which chapter count to
 *  enforce when the user adds/removes chapters. */
export type NovelLengthClient = "short" | "standard" | "long";

/** Payload for `kind === "novel-outline-edit"` rows. The user can edit any
 *  field; on "Generate novel" the edited shape is posted back to /api/chat
 *  with `novelOutline` in the body. On "Re-outline" the prior outline +
 *  free-text feedback is re-posted to /api/novel/outline. */
export type NovelOutlineEditPayload = {
  /** Length preset the outline was generated against. */
  length: NovelLengthClient;
  /** The current outline being edited. Updates as the user types so a tab
   *  close mid-edit doesn't lose progress. */
  outline: NovelOutlineData;
  /** Plain-text research note from the premise-research stage. Null when
   *  the model returned NO_RESEARCH_NEEDED. */
  researchNote: string | null;
  /** Searches the premise-research stage issued. */
  searches: NovelOutlineSearch[];
  /** True while a /api/novel/outline revision request is in flight (user
   *  clicked "Re-outline" and is waiting for the model's revised outline). */
  revising?: boolean;
  /** True while the INITIAL /api/novel/outline request is still running
   *  server-side (handshake returned, resume long-poll is pending). Card
   *  flips into a loading state — same visual treatment as revising but
   *  with copy that matches "first outline" instead of "revising". */
  outlining?: boolean;
  /** Set once the user clicks "Generate novel" — disables the card and
   *  links it to the streaming bubble below. */
  launchedAssistantId?: string;
};

/** Live progress snapshot for an outline that's still being produced server-
 *  side. Held in component state (NOT persisted to IDB) and re-derived from
 *  /api/novel/outline/progress on remount, so closing and reopening the tab
 *  recovers the timeline. Drives the action-style activity panel that
 *  replaces the empty form while `outlining || revising` is true. */
export type NovelOutlineProgressStep = {
  key: string;
  label: string;
  status: "running" | "ok" | "error";
  at: number;
  detail?: string;
};

export type NovelOutlineProgress = {
  status: "running" | "complete" | "error" | "missing";
  steps: NovelOutlineProgressStep[];
  startedAt?: number;
  /** Epoch ms of the most recent step. Client uses (now - workerSeenAt) to
   *  detect a zombie producer (Vercel killed waitUntil after 120s but meta
   *  stayed "running") so it can surface a "looks stuck" prompt with retry. */
  workerSeenAt?: number;
};

export type MessageRole = "user" | "assistant" | "system";

export type FileChangeOp = "write" | "edit" | "delete";
export type FileChange = { path: string; op: FileChangeOp; addedLines?: number; removedLines?: number };

export type BuildIssue = { file: string; line: number; column: number; message: string; snippet?: string };
export type BuildOutcome =
  | { ok: true; warnings?: BuildIssue[]; durationMs?: number }
  | { ok: false; errors: BuildIssue[]; warnings?: BuildIssue[]; durationMs?: number };

/**
 * VFS-edit mode: the assistant's proposed multi-file change. The chat
 * commits this to the designer via Save, replacing the old single-file
 * `proposedArtifact` flow for new artifacts.
 */
export type ProposedVfs = {
  files: ArtifactFiles;
  entry: string;
  summary: string;
  ops: FileChange[];
  build?: BuildOutcome;
  streaming?: boolean;
};

/**
 * Image attached to a user message. `dataUrl` is a `data:image/...;base64,…`
 * URL produced client-side after a downscale pass (≤1024px on the longest
 * edge) so we don't blow IndexedDB or the wire payload.
 */
export type AttachedImage = {
  /** Stable id within the message — used as React key. */
  id: string;
  /** `data:<mime>;base64,<…>` — what the iframe / <img> renders directly. */
  dataUrl: string;
  /** MIME type from the original File. Useful for the Ollama wire payload. */
  mime: string;
  /** Original filename (best-effort, optional). */
  name?: string;
  /** Byte size of the resized base64 payload (≈ raw bytes after b64 decode). */
  bytes?: number;
  /**
   * Filled in by the server when the chosen main model is text-only — the
   * vision describer's caption is appended to the wire payload as text and
   * also surfaced on the bubble so the user sees what the model "saw".
   */
  description?: string;
};

/**
 * PDF attached to a user message. Text is extracted client-side via pdfjs
 * before send so the server bundle stays lean and we don't double the wire
 * payload as base64. `text` is what the model sees; `excerpt` powers tooltips.
 */
export type AttachedPdf = {
  id: string;
  name: string;
  pageCount: number;
  /** Raw PDF byte size (pre-extract). For display only. */
  bytes: number;
  /** Post-truncation text — what gets sent on the wire. */
  text: string;
  /** Length of the original (pre-truncation) extract. */
  textChars: number;
  truncated: boolean;
  /** First ~280 chars of the extract, whitespace-normalized. */
  excerpt: string;
};

/**
 * CSV file attached to a user message. Parsed client-side into a text
 * representation (markdown table or raw CSV) so the model can reference
 * columns, rows, and values throughout the conversation. `text` is what
 * the model sees; `excerpt` powers tooltips.
 */
export type AttachedCsv = {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  /** Raw file byte size. For display only. */
  bytes: number;
  /** Column headers (first row). */
  headers: string[];
  /** Post-truncation text — what gets sent on the wire. */
  text: string;
  /** Length of the original (pre-truncation) text. */
  textChars: number;
  truncated: boolean;
  /** First ~280 chars of the text, whitespace-normalized. */
  excerpt: string;
};

/**
 * A binary file attached to a user message (audio, video, zip, or any other
 * non-text payload) for the code-execution sandbox. Unlike images/PDFs/CSVs we
 * do NOT inline the bytes — they can be tens of MB — so the file is uploaded to
 * Vercel Blob and the message carries only a pointer (`blobKey` + a short-lived
 * `url`). The sandbox worker downloads it into the run workspace by key, and
 * any files the run produces are stored the same way and surfaced back as
 * `AttachedFile`s the user can download or re-attach to the next turn.
 */
export type AttachedFile = {
  id: string;
  /** Original (or produced) filename, e.g. "clip.mp3". The sandbox exposes the
   *  file to code under this name in the run workspace. */
  name: string;
  /** Blob pathname under the user's namespace (account/{userHash}/uploads/…). */
  blobKey: string;
  /** Best-effort browser-resolvable URL for download/preview. May be a
   *  Blob CDN URL; for private stores the client re-mints via /api/account/blob-read. */
  url: string;
  /** MIME type from the original File (or inferred for produced outputs). */
  contentType: string;
  /** Byte size. For display + the worker's output-size accounting. */
  bytes: number;
  /** True when this descriptor is a file the sandbox produced (vs. user-uploaded).
   *  Drives the "generated" affordance on the chip. */
  produced?: boolean;
};

/**
 * A user-created research annotation on an assistant message. The user
 * highlights a passage, asks a follow-up, and a small background model
 * (Gemma 4 31B) answers. The result is rendered inline as a yellow `<mark>`
 * and lives separately as a child chat (linked via `childChatId`).
 *
 * Anchor strategy: `selectedText` must appear verbatim in `msg.content`
 * (the raw markdown). `startOffset`/`endOffset` index the matched substring
 * in `msg.content`; `occurrenceIndex` is the nth match counting from zero
 * and serves as a re-anchor fallback if the content shifts (today the chat
 * has no message-edit feature, but the field makes future migrations safe).
 */
export type MessageAnnotation = {
  id: string;
  selectedText: string;
  /** Exact source slice for re-anchoring; differs from `selectedText` only
   *  when the selection crossed inline markdown syntax. See `Anchor`. */
  sourceText?: string;
  startOffset: number;
  endOffset: number;
  occurrenceIndex: number;
  prompt: string;
  status: "pending" | "done" | "error";
  result?: string;
  errorMessage?: string;
  childChatId?: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * A plain reader highlight on a message (therapist mode). Same anchoring
 * contract as MessageAnnotation (`selectedText` must appear verbatim in
 * `msg.content`; nth-occurrence fallback), but carries no research
 * prompt/result — it's purely a visual mark, with the passage also clipped
 * into the chat's "Saved passages" pinned note at save time.
 */
export type MessageHighlight = {
  id: string;
  selectedText: string;
  /** Exact source slice for re-anchoring; see `Anchor`. */
  sourceText?: string;
  startOffset: number;
  endOffset: number;
  occurrenceIndex: number;
  createdAt: number;
};

/**
 * A review comment left on a pinned note in the canvas editor. Same anchoring
 * contract as MessageAnnotation (`selectedText` must appear verbatim in the
 * note body; nth-occurrence fallback re-anchors it as the body drifts), plus
 * a free-text `body` — the instruction the user wants the assistant to act on.
 * Comments accumulate across the document and are applied in one pass via the
 * canvas "Apply comments" action, after which they're cleared.
 */
export type NoteComment = {
  id: string;
  selectedText: string;
  /** Exact source slice for re-anchoring; differs from `selectedText` only
   *  when the selection crossed inline markdown syntax. See `Anchor`. */
  sourceText?: string;
  startOffset: number;
  endOffset: number;
  occurrenceIndex: number;
  /** The user's comment / instruction for this passage. */
  body: string;
  createdAt: number;
};

export type StoredMessage = {
  id: string;
  chatId: string;
  role: MessageRole;
  content: string;
  /** Reasoning channel from thinking-capable models (DeepSeek, GPT-OSS, …). Display-only; never sent on the wire. */
  thinking?: string;
  /** Photos the user attached to this message (user role only). */
  images?: AttachedImage[];
  /** PDFs the user attached to this message (user role only). */
  pdfs?: AttachedPdf[];
  /** CSVs the user attached to this message (user role only). */
  csvs?: AttachedCsv[];
  /**
   * Binary files for the code-execution sandbox. On user messages these are
   * uploads (audio/video/zip/etc.) the model can read by name via run_code; on
   * assistant messages these are files a sandbox run produced and offered back
   * as downloads. Bytes live in Blob — this carries only pointers + metadata.
   */
  files?: AttachedFile[];
  /**
   * LEGACY: Structured artifact the assistant produced inside <artifact>…</artifact>
   * sentinel tags. Kept for old messages; new vfs-edit messages use proposedVfs instead.
   */
  proposedArtifact?: { html: string; summary: string; streaming?: boolean };
  /** vfs-edit mode: multi-file change the assistant produced via Read/Edit/Write tool calls. */
  proposedVfs?: ProposedVfs;
  createdAt: number;
  /**
   * Set when a message's body is mutated in place after creation - most
   * importantly when a canvas "Save version" rewrites the source artifact
   * message's `proposedVfs` / `proposedArtifact.html`. The account-sync
   * chat-touch derives `chat.updatedAt` from the newest message timestamp
   * to drive last-write-wins; in-place edits never add a row, so without
   * this field they leave `updatedAt` unchanged and the next pull silently
   * reverts the save (the "Save version then it reverts" bug). flushChatTouch
   * factors this in alongside `createdAt`.
   */
  editedAt?: number;
  model?: string;
  usage?: StoredUsage;
  error?: string;
  events?: ToolEvent[];
  /**
   * Row kind. `summary` collapses subsumed messages under one entry.
   * `council-framing` renders an interactive form of grounding questions
   * the council framer LLM produced — the user fills it in, then clicks
   * "Run council" to launch the orchestrator.
   * `research-framing` is the analogous form for research mode — the
   * answers feed the planner's sub-question decomposition.
   */
  kind?:
    | "summary"
    | "council-framing"
    | "research-framing"
    | "novel-outline-edit"
    | "research-result"
    | "multi-research";
  /**
   * Payload for `kind === "council-framing"` rows. Persisted so a tab close
   * mid-fill doesn't lose the questions or any answers the user has typed.
   */
  councilFraming?: CouncilFramingPayload;
  /** Payload for `kind === "research-framing"` rows. */
  researchFraming?: ResearchFramingPayload;
  /** Payload for `kind === "research-result"` rows — the in-chat structured
   *  research artifact (records + schema + run history). Persisted so it
   *  survives reloads and so re-runs can append/merge into it. */
  researchResult?: StructuredResearchPayload;
  /** Payload for `kind === "novel-outline-edit"` rows. Carries the outline
   *  the user is editing plus the premise-research note + searches so the
   *  card can show what grounded the outline. */
  novelOutlineEdit?: NovelOutlineEditPayload;
  /** Payload for `kind === "multi-research"` rows — the Multi Research card:
   *  N editable research prompts the user reviews, then N full-report runs
   *  that stream back in parallel. Persisted so a reload mid-run resumes each
   *  report from its own streamId, and so the finished reports (full markdown
   *  + sources) survive reloads and stay available as chat context. */
  multiResearch?: MultiResearchPayload;
  /** Set on subsumed messages — they are still rendered (collapsed) but never sent on the wire. */
  summarizedInto?: string;
  /** Set on summary messages — the messages they replace. */
  subsumedIds?: string[];
  /**
   * Set while the assistant message is being generated server-side. Lets the
   * client reconnect to /api/chat/resume/{streamId} after a tab close or phone
   * sleep. Cleared on the `done` SSE event.
   */
  streamId?: string;
  /** Index of the last SSE event applied — used as the resume cursor. */
  streamCursor?: number;
  /**
   * For user messages in designer-edit chats: the designer `version` that was
   * current when this message was sent. The "Revert to here" action uses it
   * to restore files from `designer.history`.
   *
   * Field is named `templateVersion` for IDB-row backwards compatibility with
   * v6-era messages; readers should accept either name. Newly written rows
   * still use `templateVersion` to avoid forking the data shape.
   */
  templateVersion?: number;
  /**
   * Set on assistant messages whose chat-mode artifact has been promoted to a
   * designer via the "Convert to App" action. Stored so the inline render's
   * "Saved as designer" badge survives reloads.
   */
  convertedDesignerId?: string;
  /**
   * Set on user messages that were posted via the queue endpoint while
   * another stream was already in flight. Cleared once the server echoes the
   * matching `user_turn` SSE event back into the stream (i.e. the worker
   * picked the message up and started processing it). Persisted so a reload
   * mid-queue still surfaces the "queued" badge.
   */
  queued?: boolean;
  /** Research annotations the user attached to spans of `content`. */
  annotations?: MessageAnnotation[];
  /** Reader highlights saved from therapist mode. See MessageHighlight. */
  highlights?: MessageHighlight[];
  /**
   * Plan-mode state: long coding edits decomposed into bounded steps,
   * each cached server-side so worker handoffs and the user's "Continue
   * plan" button resume from the first uncached step rather than
   * restarting. Populated from the SSE `plan_outline` / `plan_step_*`
   * events and persisted so a reload after the chain exhausted still
   * renders the progress card + continuation affordance.
   *
   * `pausedAt` is set when the assistant message ends in a chain-
   * exhausted state with steps remaining; the client routes the
   * Continue button to /api/chat/plan-continue/{streamId} when set.
   */
  plan?: {
    brief: string;
    steps: {
      id: string;
      title: string;
      description?: string;
      targetFiles?: string[];
      status: "pending" | "running" | "done" | "errored";
      summary?: string;
      filesChanged?: string[];
      cached?: boolean;
      error?: string;
    }[];
    pausedAt?: string;
  };
  /**
   * v13: highlight anchor captured from the canvas preview at send time.
   * Set on user messages in note-canvas chats when the user pinned a
   * passage before sending — restores the chip in the composer and the
   * `<mark>` overlay on the preview after reload. The server uses this
   * anchor (passed alongside the message in the request body) to constrain
   * Edit/MultiEdit to the highlighted slice.
   */
  selectionAnchor?: SelectionAnchor;
  /**
   * Set on assistant messages produced by `chat-artifact-canvas` edit mode:
   * points at the source artifact message this response is editing. Lets
   * the auto-save path apply the new VFS body back to the source message
   * even when the user navigates out of the canvas page mid-stream — without
   * it, the response strands on a side message and renders in the regular
   * chat view as a duplicate "new artifact". Persistent (not cleared after
   * apply) so the rendering layer can keep suppressing the duplicate inline
   * artifact on every subsequent mount.
   */
  editsArtifactMessageId?: string;
  /**
   * Snapshot of the source artifact's HTML at the moment this edit was
   * submitted, captured on the assistant message that carries
   * `editsArtifactMessageId`. Because canvas edits clobber the source
   * message's `proposedArtifact.html` / `proposedVfs.files[entry]` in place,
   * the original body would otherwise be unrecoverable — this field lets
   * "Revert chat (and code) to here" roll the source back to the state
   * immediately before this (and any later) edit landed.
   */
  priorArtifactHtml?: string;
};

/** One tool advertised by a connected MCP server (cached from tools/list at
 *  connect time so the picker + wire assembly don't re-discover on every
 *  send). `inputSchema` is a JSON Schema handed to the model as the tool's
 *  parameters. */
export type McpConnectorTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

/**
 * A user-configured MCP (Model Context Protocol) server connector. A "custom"
 * connector points the platform at a remote MCP server reachable with a URL +
 * an API key: the host makes a discovery call to enumerate the server's tools
 * and caches them here, and any chat the connector is enabled in can call
 * those tools. This is a GENERIC platform capability — every app/chat can use
 * any connector, and nothing about a specific server is baked into the
 * surface.
 *
 * The `apiKey` lives in the local Settings singleton (IndexedDB) alongside the
 * rest of the user's config. It only ever leaves the browser on the wire to
 * the user's own MCP server (proxied through /api/connectors/discover and the
 * chat route), the same trust model as the RunPod endpoint id.
 */
export type McpConnector = {
  /** Stable client-generated id (used to namespace the server's tools and to
   *  track per-chat enablement). */
  id: string;
  /** User-facing display name. */
  name: string;
  /** Streamable-HTTP MCP endpoint URL. */
  url: string;
  /** Bearer token sent as `Authorization: Bearer <key>`. Optional — some
   *  servers are open. */
  apiKey?: string;
  /** Tools discovered at connect time. */
  tools: McpConnectorTool[];
  /** Epoch ms of the last successful discovery. */
  discoveredAt?: number;
  createdAt: number;
};

export type Settings = {
  webSearch: boolean;
  imageSearch: boolean;
  /**
   * Custom MCP connectors the user has configured (registry). Managed from
   * Preferences → Connectors; enablement for a given chat is tracked
   * separately in `enabledConnectorIds` (mirroring how `webSearch` is a
   * boolean the composer flips). Undefined ⇒ none configured.
   */
  connectors?: McpConnector[];
  /**
   * Ids of connectors currently toggled on. Like the other tool flags this is
   * global state flipped from a chat's ••• → Tools sheet ("per chat" as a UX
   * framing). Only enabled connectors' tools are sent to the model. Undefined
   * or empty ⇒ no connector tools this send.
   */
  enabledConnectorIds?: string[];
  /**
   * Research mode. Runs a planner → parallel research sub-agents →
   * synthesizer flow before answering: the planner decomposes the question
   * into sub-questions, each sub-agent investigates one in parallel with its
   * own web_search/web_fetch budget, and the final model synthesizes their
   * briefs into the user-facing answer. Force-enables web tools and raises
   * the per-stream wall-clock budget. Off by default.
   */
  research?: boolean;
  /**
   * Structured research mode. When on, sending a message creates an in-chat
   * structured-research artifact (a table of records) instead of a normal chat
   * turn: it runs the deep-research engine server-side, streams progress, and
   * renders the result with a built-in viewer that supports re-run/append.
   * Mutually exclusive with research/novel/plan.
   */
  structuredResearch?: boolean;
  /**
   * Multi Research mode. A per-round tool (like `research`/`structuredResearch`,
   * reset after one send): sending a message drops a Multi Research card in
   * which the model drafts N parallel research prompts. The user reviews/edits
   * them, then runs them together — each streams back as its own full-report
   * card. The composer locks while the reports run. Mutually exclusive with the
   * other heavy turn modes.
   */
  multiResearch?: boolean;
  /**
   * App creation in chat. OFF by default (opt-in). When on, free-form chat
   * gets the artifact-builder system prompt so the assistant can promote an
   * answer into an interactive HTML mini-app (and offer "Convert to App").
   * When off, plain chat uses a lean prompt with NO app-building instructions,
   * keeping the model focused on the conversation instead of being primed to
   * emit artifacts. Independent of the manual "New app" launcher + template
   * picker, which stay available regardless.
   */
  appCreation?: boolean;
  /**
   * Advanced Web mode. Hands the model a much more capable (and more
   * dangerous) web toolset: browse_page (a real headless Chromium that runs
   * page JS, follows links, and screenshots), http_request (a raw curl-style
   * HTTP client), and run_command (a sandboxed pipeline of allow-listed
   * binaries like curl/jq with a secret-scrubbed environment). Because
   * Chromium and the shell binaries only exist in the Fly worker image, the
   * chat route forces Fly-worker routing whenever this is on. Off by default.
   */
  advancedWeb?: boolean;
  /**
   * Code Execution Sandbox mode. Hands the model a `run_code` tool that runs
   * real python/node in an isolated workspace on the Fly worker: it can read
   * files the user attached, write output files (offered back as downloads),
   * use ffmpeg + common libs, and reach the network — e.g. "speed up this
   * audio 1.5x" or "scrape this page and chart it". The interpreters + ffmpeg
   * only exist in the Fly worker image, so (like Advanced Web) the chat route
   * forces Fly-worker routing whenever this is on. Off by default.
   */
  codeExec?: boolean;
  /**
   * Long-running novel mode. Outlines the user's premise, then writes each
   * chapter sequentially with running-recap continuity. Mutually exclusive
   * with research. Each preset implies a chapter count and per-
   * chapter word target: short ≈ 50 pages, standard ≈ 100 pages,
   * long ≈ 200 pages. "off" (or undefined) disables novel mode.
   */
  novelMode?: "off" | "short" | "standard" | "long";
  /**
   * Force plan mode on for the next message. When `true`, the chat route
   * sets cfg.planModeEnabled regardless of the auto-trigger heuristic
   * (entry-file size + last-user-prompt length) in work.ts. Useful when
   * the heuristic doesn't fire but the user knows the task is large
   * enough to need chunked execution. Undefined / false ⇒ auto-detect.
   */
  planMode?: boolean;
  /**
   * Route the next send to the Fly.io worker instead of the in-process
   * Vercel waitUntil path. Pulls the producer off Vercel so the job has
   * no per-request wall clock (the Vercel chain otherwise caps at
   * ~15 min via 3 chained 300s functions). The worker enforces its own
   * 1-hour kill timer to bound stuck jobs. Requires FLY_API_TOKEN /
   * FLY_APP_NAME / FLY_MACHINE_ID on the server; if any are missing the
   * route falls back to waitUntil regardless of this flag.
   */
  flyWorker?: boolean;
  /** Last-used model (across all chats). */
  defaultModel?: string;
  /**
   * Model used for Structured research in chat. Undefined ⇒
   * DEFAULT_RESEARCH_MODEL ("minimax-m3").
   */
  researchModel?: string;
  /**
   * Model used by unattended scheduled runs (scheduled tasks, apps, widgets)
   * when the app itself has no explicit Model set. An app's own Model setting
   * still wins over this. Set, it applies to every scheduled run including
   * deep research. Undefined ⇒ the built-in per-branch default:
   * DEFAULT_RESEARCH_MODEL for research schedules, else
   * DEFAULT_SCHEDULED_MODEL ("gpt-oss:120b"). Resolved client-side in
   * ArtifactFrame (scheduledModelFor) and baked onto the registered task -
   * scheduled runs have no browser, so the server can't read this directly.
   */
  scheduledModel?: string;
  /**
   * Vision model that captions uploaded images when the main model is
   * text-only (the `describe_image` step). Empty/undefined ⇒ the built-in
   * default (VISION_DESCRIBER_MODEL). Should be a vision-capable model.
   */
  describerModel?: string;
  /**
   * How much detail the image describer returns. Undefined ⇒ "standard".
   * Kept as an inline union so this module stays dependency-free; mirrors
   * `DescribeDetail` in app/lib/describe-image.ts.
   */
  describeDetail?: "concise" | "standard" | "detailed";
  /**
   * Subset of model ids the user wants visible in pickers. The full list is
   * discovered dynamically via GET /api/models. Undefined = show all (the
   * default for users who have never opened Preferences). NOT an authorization
   * boundary — server routes accept any non-empty model id and let Ollama
   * Cloud reject unknown ones.
   */
  enabledModels?: string[];
  /**
   * User-entered model ids that aren't returned by /api/models. Merged into
   * the visible picker list so power users can target a model their account
   * has access to before our discovery endpoint sees it. Same caveat as
   * enabledModels: not an auth boundary; Ollama Cloud rejects unknown ids.
   */
  customModels?: string[];
  /**
   * RunPod Serverless endpoint id (e.g. `fi5f7k8xyrbobj`) — sent with each
   * request that targets a `runpod:` model so the server knows which RunPod
   * deployment to hit. The API key stays server-side as RUNPOD_API_KEY.
   * Empty/undefined falls back to the RUNPOD_ENDPOINT_ID env var on the server.
   */
  runpodEndpointId?: string;
  /**
   * Model ids we've already auto-enabled once (currently just RunPod-discovered
   * ids). Used to ensure the auto-enable on first sight is idempotent — if the
   * user disables a model they were given, the next discovery refresh won't
   * re-enable it. Persisted but otherwise opaque to the rest of the app.
   */
  autoEnabledIds?: string[];
  /** Epoch ms of the last successful "Download backup" — surfaced in Preferences. */
  lastBackupAt?: number;
  /** Compressed byte size of the last backup — for the caption in Preferences. */
  lastBackupBytes?: number;
  /**
   * Show the dictation mic button in the composer. Off by default because the
   * Whisper model download is a noticeable one-time cost and most people type.
   */
  micEnabled?: boolean;
  /**
   * Chat model used by hands-free voice mode. Voice conversations are
   * latency-sensitive (the user is waiting in silence), so this is separate
   * from defaultModel and falls back to DEFAULT_VOICE_MODEL - a fast model -
   * rather than to the chat's pinned model. Set from the picker inside voice
   * mode.
   */
  voiceModel?: string;
  /**
   * OpenAI TTS voice for voice mode. Undefined = "nova". Values are validated
   * server-side by /api/tts; unknown names fall back to the default voice.
   */
  voiceName?: string;
  /**
   * Voice-mode playback speed for the assistant's spoken replies (applied
   * as HTMLAudioElement.playbackRate, pitch-preserving). Undefined = 1.
   * The in-page control cycles 1 / 1.25 / 1.5 / 2.
   */
  voiceSpeed?: number;
  /**
   * Voice-mode conversation style. "auto" (default) is hands-free: silence
   * auto-sends and the mic reopens after each reply. "manual" is tap-to-talk:
   * tap to open the mic, tap to send, tap to stop the reply - the mic never
   * opens on its own, which sidesteps VAD/echo-cancellation trouble entirely
   * (noisy rooms, loudspeakers with weak AEC).
   */
  voiceInputMode?: "auto" | "manual";
  /**
   * Voice-mode barge-in: interrupt the assistant mid-reply by speaking over
   * it. Undefined = true. Relies on browser echo cancellation to keep the
   * assistant's own audio out of the mic; the in-page toggle exists for
   * devices where AEC is weak (e.g. loud external speakers) and the session
   * keeps interrupting itself.
   */
  voiceBargeIn?: boolean;
  /**
   * Council mode. When on, the composer's send call routes through
   * `/api/council/framing` (which produces grounding questions) instead of
   * `/api/chat` directly, then `/api/council/run` orchestrates parallel
   * personas → optional debate rounds → synthesizer. Mutually exclusive with
   * research and novel mode at the UI level.
   */
  councilEnabled?: boolean;
  /** Active situation preset id from `COUNCIL_SITUATIONS`. */
  councilSituationId?: string;
  /** Editable roster — seeded from the chosen preset, then user-customised. */
  councilMembers?: CouncilMember[];
  /** Number of debate rounds AFTER each member's initial position (0/1/2). */
  councilDebateRounds?: 0 | 1 | 2;
  /**
   * Optional override for the synthesizer model. Empty/undefined falls back
   * to the chat's currently-selected model (sent on the wire as `model`).
   */
  councilSynthesizerModel?: string;
  /**
   * Versioned tag on the default council roster — bumped when we change what
   * "default council" means so we can re-seed users who are still on a stale
   * default but haven't customised. Missing/lower = a migration is due. See
   * `migrateCouncilSettings` in `app/lib/council/situations.ts`.
   */
  councilSeedVersion?: number;
  chatPersonaId?: string;
};

/** One persona on the user's council. The `model` may be any id valid for
 *  `chatClientFor()` — runpod-prefixed ids route to the user's RunPod
 *  endpoint; bare ids hit Ollama Cloud. */
export type CouncilMember = {
  id: string;
  name: string;
  perspective: string;
  model: string;
};

export const DEFAULT_SETTINGS: Settings = { webSearch: false, imageSearch: false };

export const DEFAULT_CHAT_ID = "default";

export type ChatTarget =
  | {
      /** v7+: "designer" (was "template") and "app" (was "instance"). */
      kind: "designer" | "app";
      id: string;
      /** edit = build/modify the designer code. setup = configure / use the app. */
      mode: "edit" | "setup";
    }
  | {
      /**
       * v13: Gemini-style canvas chat that edits a single pinned note (any
       * body kind — markdown, HTML, or chat snapshot). The note's body lands
       * in the chat API as a one-file VFS (`responseFormat: "note-edit"`)
       * and the assistant edits it via Read/Edit/MultiEdit/Write/Finish.
       * Persisted edits are written back to the pinned note via
       * `applyCanvasResult` (see app/lib/note-canvas/persist.ts).
       */
      kind: "note-canvas";
      /** Pinned-note id this canvas chat is editing. */
      noteId: string;
      mode: "edit";
    }
  | {
      /**
       * Full-screen canvas view layered over an existing chat: edits the HTML
       * artifact on a specific assistant message in place (no pinned note is
       * created). Constructed transiently by /chats/[id]/canvas — never
       * persisted on the chat row, since the underlying chat is the same
       * /chats/[id] conversation. Routes to `responseFormat: "artifact-edit"`
       * via the VFS dispatcher, same backend as note-canvas.
       */
      kind: "chat-artifact-canvas";
      chatId: string;
      messageId: string;
      mode: "edit";
    };

/**
 * Persisted selection anchor — the user's highlighted span at send time.
 * Same shape as `Anchor` in `app/lib/annotations/anchor.ts`, duplicated here
 * because db.ts is also pulled in server-side and `anchor.ts` references
 * `window.getSelection`.
 */
export type SelectionAnchor = {
  selectedText: string;
  /** Exact source slice for re-anchoring; see `Anchor`. */
  sourceText?: string;
  startOffset: number;
  endOffset: number;
  occurrenceIndex: number;
};

export type ManifestParam =
  | { key: string; type: "string"; label: string; required?: boolean; default?: string; placeholder?: string }
  | { key: string; type: "number"; label: string; required?: boolean; default?: number; min?: number; max?: number }
  | { key: string; type: "boolean"; label: string; default?: boolean }
  | { key: string; type: "enum"; label: string; options: string[]; default?: string; required?: boolean }
  | { key: string; type: "model"; label: string; default?: string; required?: boolean };

/**
 * Scheduled background task. One per app — kept deliberately scalar (no
 * `name` discriminator, no array) to bound Ollama spend. The cron expression
 * is server-validated to fire at most once per hour; combined with a Redis
 * 1h-ratelimit on every run path, an app cannot consume more than 24 LLM
 * calls per day even if the user spams "Run now" or two clients race.
 */
export type ScheduledTask =
  | {
      cron: string;
      type: "query";
      prompt: string;
      schema?: unknown;
      tools?: ("web_search" | "web_fetch")[];
      model?: string;
      /** Run the deep multi-agent research engine instead of a single-shot
       *  query. Set by research apps so a scheduled refresh re-runs the same
       *  engine that produced the table. */
      research?: boolean;
      /** Research apps only: the table's display + identity columns. When set,
       *  the scheduled run uses the SAME structured engine as a manual Refresh,
       *  conforming records to these exact column keys (so the table actually
       *  populates) instead of letting the model invent keys. */
      columns?: ResearchColumn[];
      idKeys?: string[];
    }
  | {
      cron: string;
      type: "fetch";
      url: string;
      init?: { method?: string; headers?: Record<string, string>; body?: string };
    };

export type WidgetSizePreset = "S" | "M" | "L" | "W";

/**
 * Concrete widget size pushed into the iframe at init time. `cols`/`rows` are
 * the grid-cell extents; `w`/`h` are the live pixel dimensions of the iframe,
 * filled in by the host's ResizeObserver once the cell has laid out.
 */
export type WidgetSize = {
  preset: WidgetSizePreset;
  cols: 1 | 2 | 4;
  rows: 1 | 2;
  w: number;
  h: number;
};

export const WIDGET_PRESETS: Record<
  WidgetSizePreset,
  { cols: 1 | 2 | 4; rows: 1 | 2; label: string }
> = {
  S: { cols: 1, rows: 1, label: "Small" },
  M: { cols: 2, rows: 1, label: "Medium" },
  L: { cols: 2, rows: 2, label: "Large" },
  W: { cols: 4, rows: 1, label: "Wide" },
};

/**
 * Optional widget metadata in `manifest.json`. Absence does NOT mean "no
 * widget" — a default-exported `Widget.tsx` at the VFS root is also detected.
 * See detectWidgetEntry in app/lib/artifact/manifest.ts.
 */
export type ArtifactWidgetManifest = {
  /** VFS path of the widget entry. Defaults to "Widget.tsx" when omitted. */
  entry?: string;
  /** Default size when the user adds the widget to the board. Falls back to "M". */
  defaultSize?: WidgetSizePreset;
  /** Sizes the widget supports — picker hides others. Omitted = all 4 allowed. */
  supportedSizes?: WidgetSizePreset[];
};

/**
 * Declared data source for a v2 state entry (docs/artifact-sdk-v2-schema.md).
 * The HOST runs sources - on the Refresh button, on artifact.entries.refresh(),
 * and on the declared cron - validates the result against the entry schema,
 * merges by identity, and lands it in app.state. Generated code never wires
 * queries, schedules, or state persistence for source-backed entries.
 *
 * `prompt` supports `{params.key}` placeholders, interpolated with the app's
 * current params (serializable, so scheduled server runs see the same prompt).
 */
export type ArtifactEntrySource = {
  type: "query";
  prompt: string;
  system?: string;
  webSearch?: boolean;
  /** Run the deep research engine instead of a single-shot query. */
  research?: boolean;
  /**
   * Expose the user's configured MCP (Model Context Protocol) connectors to
   * this source's query run, so the prompt can instruct the model to call a
   * connected server's tools (e.g. a status/analytics API) to fetch the entry's
   * data. Generic: the host passes the user's own connectors; nothing about a
   * specific server is baked into the app. Works on the interactive Refresh /
   * refresh() paths always, and on the background schedule when the user last
   * opened the app with those connectors configured (the host persists them
   * server-side alongside the schedule). Default false.
   */
  mcp?: boolean;
  refresh?: {
    /** User-triggered refresh (host Refresh button / entries.refresh()). Default true. */
    user?: boolean;
    /** 5-field cron for background server-side refresh. At most ONE entry per app may declare this. */
    schedule?: string;
  };
};

/** One declared state entry: a record collection with identity + merge policy,
 *  or a plain value with a default. */
export type ArtifactStateEntryConfig =
  | {
      kind: "collection";
      /** JSON Schema for ONE record (object). The runtime validates the model's
       *  output as an array of these. */
      schema?: unknown;
      /** Record keys whose normalized values identify one logical record. */
      identity?: string[];
      /** How refreshed data combines with existing records. Default "upsert". */
      merge?: "upsert" | "replace" | "append";
      /** Drop records whose `dateKey` field is in the past. */
      retain?: { dateKey?: string };
      source?: ArtifactEntrySource;
    }
  | {
      kind: "value";
      default?: unknown;
    };

/** Host-maintained per-entry metadata, stored in app.state under
 *  ARTIFACT_ENTRY_META_KEY so it survives reloads and syncs across devices. */
export type ArtifactEntryMeta = {
  status: "idle" | "refreshing" | "error";
  lastRefreshedAt?: number;
  error?: string;
  /** runAt of the last schedule snapshot merged into this entry (dedupe guard). */
  scheduleRunAt?: number;
  /** When the current/last refresh attempt started. Lets a fresh mount reset a
   *  "refreshing" flag orphaned by a frame that unloaded mid-run. */
  attemptAt?: number;
};

/** Reserved app.state key holding Record<entryKey, ArtifactEntryMeta>. */
export const ARTIFACT_ENTRY_META_KEY = "__artifact_entry_meta__";

export type ArtifactManifest = {
  name: string;
  description?: string;
  params: ManifestParam[];
  refresh?: { minIntervalSeconds?: number };
  schedule?: ScheduledTask;
  /** Optional widget metadata. Absence ≠ "no widget" — Widget.tsx alone counts. */
  widget?: ArtifactWidgetManifest;
  /** v2 declared data: entry key → config. See ArtifactStateEntryConfig. */
  state?: Record<string, ArtifactStateEntryConfig>;
};

export type DesignerStatus = "draft" | "published";
/** @deprecated v7 alias — use DesignerStatus. */
export type TemplateStatus = DesignerStatus;

/** Path → file content. Paths use forward slashes, no leading "/". */
export type ArtifactFiles = Record<string, string>;

/** Cached compose+bundle output for an artifact. Iframe srcdoc is ready to mount. */
export type BuiltArtifact = {
  /** Composed iframe srcdoc (SDK injected, bundled JS inlined, CSS inlined). */
  html: string;
  /** Stable hash of the source files used for this build. Skip rebuild if unchanged. */
  bundleHash: string;
  builtAt: number;
  warnings?: BuildIssue[];
};

/**
 * One entry in `StoredDesigner.history`. Acts as a lightweight git-style
 * commit log kept locally in IndexedDB — no real git is involved. Older rows
 * may not have `commitMessage`/`hash`; readers must tolerate undefined.
 */
export type DesignerCommit = {
  version: number;
  files: ArtifactFiles;
  entry: string;
  savedAt: number;
  /** Short human-readable description of what changed (from the assistant's summary). */
  commitMessage?: string;
  /** Stable content hash of (files, entry) at this version — vfsHash output. */
  hash?: string;
};

export type StoredDesigner = {
  id: string;
  name: string;
  description?: string;
  /** Virtual filesystem: path → content. */
  files: ArtifactFiles;
  /** Bundle entrypoint (e.g. "main.tsx" for React, "index.html" for static/legacy). */
  entry: string;
  /** Cached build output; cleared whenever files change. */
  lastBuild?: BuiltArtifact;
  manifest: ArtifactManifest | null;
  /** Cached widget build, parallel to `lastBuild`. Cleared on save (same as lastBuild). */
  lastWidgetBuild?: BuiltArtifact;
  status: DesignerStatus;
  version: number;
  /** Each save bumps version; every prior VFS snapshot is retained here so a
   *  designer's full edit history is rollback-able. No cap — IDB sizes are
   *  generous and the cost of losing a snapshot exceeds the cost of storing it. */
  history?: DesignerCommit[];
  /**
   * CLAUDE.md-style project notes maintained across chat sessions. Capped at
   * 500 lines by the /api/notes endpoint that produces it. Injected into every
   * fresh chat's system prompt so the assistant carries app context without
   * rereading the prior chat thread.
   */
  notes?: string;
  notesUpdatedAt?: number;
  sourceChatId?: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Account-level sharing (v10): when true, this designer is mirrored to the
   * server account store and pulled into every signed-in browser. Toggle off
   * removes the server copy; the local row stays put with the flag cleared.
   * `lastSyncedAt` carries the server-stamped updatedAt of the most recent
   * push or pull, used as the watermark for incremental pulls.
   */
  accountShared?: boolean;
  accountSharedAt?: number;
  lastSyncedAt?: number;
  /**
   * Summary of the edit that produced the *current* `version`'s files — the
   * head's own commit message. History only holds prior commits, so without
   * this the head's description would be lost until it's demoted. Carried
   * forward on every save/revert and written onto the prior commit when the
   * head moves into history, keeping each version's number, files, and
   * description aligned (a stale convention attached the new edit's summary to
   * the *old* version, shifting every label by one).
   */
  headCommitMessage?: string;
  /** User-assigned checkpoint names, keyed by version number (as string). */
  checkpointLabels?: Record<string, string>;
  /** App state snapshots captured when a checkpoint is bookmarked, keyed by version number (as string). */
  stateSnapshots?: Record<string, Record<string, unknown>>;
  /**
   * Sync-only metadata (added when designer heavy data moved to Vercel
   * Blob to escape Upstash's 1 MB per-value cap). These travel as part of
   * the wire payload but the UI doesn't read them.
   *
   * `filesBlobUrl`: URL of the most recent `current.json` upload (the
   *   current VFS + entry + version). Set after a successful push; refreshed
   *   on pull. Lets a future push skip uploading current.json again if the
   *   version hasn't moved.
   * `filesBlobVersion`: the `version` the current blob was last uploaded
   *   at. Read with `filesBlobUrl` to detect a stale pointer race.
   * `historyBlobs`: map from stringified commit `version` → blob URL for
   *   that commit's full VFS snapshot. Each save uploads only the new
   *   commit(s) — versions already in this map are skipped, which is how
   *   per-save bandwidth stays bounded regardless of total history length.
   */
  filesBlobUrl?: string;
  filesBlobVersion?: number;
  historyBlobs?: Record<string, string>;
  /**
   * v12: when this designer was promoted from a pinned HTML note, the
   * originating note id. While set, designer saves (onSaveHtml, onSaveVfs,
   * revert) write the new index.html back to that note's `artifactHtml` so
   * the /notes preview and the public share link stay in sync.
   */
  sourceNoteId?: string;
};

/**
 * Shape persisted before v4 — kept as a TS type so the lazy-migration helper
 * can recognize it. Don't write this shape; only read from it.
 */
type LegacyV3Template = Omit<StoredDesigner, "files" | "entry" | "history"> & {
  html?: string;
  files?: undefined;
  entry?: undefined;
  history?: {
    version: number;
    html?: string;
    files?: ArtifactFiles;
    entry?: string;
    savedAt: number;
    commitMessage?: string;
    hash?: string;
  }[];
};

/** Legacy v6 instance shape, preserved so the v7 upgrade can read it. */
type LegacyInstance = {
  id: string;
  templateId: string;
  name: string;
  params: Record<string, unknown>;
  model?: string;
  state?: Record<string, unknown>;
  lastRunAt?: number;
  lastResult?: unknown;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * v7+ canonical app row. `id === paired designer.id`. State is append-only
 * from the host's perspective: the artifact may overwrite individual keys via
 * artifact.state.set, but the host never strips keys behind its back.
 */
export type StoredApp = {
  id: string;
  name: string;
  params: Record<string, unknown>;
  /** Override the global default model for this app's chat and artifact.query() calls. */
  model?: string;
  /** Persistent KV scratch the artifact writes via artifact.state.set. Never deleted. */
  state?: Record<string, unknown>;
  /** User tapped "Not now" on the app-page update banner. The banner stays
   *  hidden; the Settings "Update app" row remains as the quiet path. */
  updateOfferDismissedAt?: number;
  lastRunAt?: number;
  lastResult?: unknown;
  lastError?: string;
  /**
   * One-sentence tile tagline. Resolved cheapest-first: designer.description,
   * then designer.notes' first sentence, then a Gemma-generated fallback. The
   * `taglineSource` discriminator drives invalidation — only `"gemma"` rows
   * are refreshed when `designer.updatedAt > taglineUpdatedAt`.
   */
  tagline?: string;
  taglineSource?: "description" | "notes" | "gemma";
  taglineUpdatedAt?: number;
  /**
   * Tracks how `name` was resolved. `"manifest"` (or absent) means the value came
   * from the artifact's manifest.json / user. `"gemma"` means the lazy renamer
   * filled in for a placeholder ("Untitled" / "Untitled artifact").
   */
  nameSource?: "manifest" | "gemma";
  nameUpdatedAt?: number;
  /**
   * Self-contained HTML hero card generated by Gemma for the apps tile preview.
   * Decoupled from the build pipeline — populated lazily once the tile is visible.
   */
  previewHtml?: string;
  previewSource?: "gemma";
  previewUpdatedAt?: number;
  /** User-chosen widget size for the home board. Absent = use widget.defaultSize or "M". */
  widgetSize?: WidgetSizePreset;
  /**
   * Drag-to-reorder position on the widgets board. Lower number = earlier.
   * New apps with no value go to the tail (max+1) at hydration time. Stored
   * sparsely (typically multiples of 100) so future inserts don't require a
   * full renumber.
   */
  widgetOrder?: number;
  /** Bumped on resize/reorder; tiebreaks the sort below widgetOrder. */
  widgetUpdatedAt?: number;
  /**
   * Whether this app's widget shows on the home board. Undefined or `true`
   * means shown; `false` hides it. Opt-out so widgets that predate this flag
   * keep appearing. Toggled from the app page or the widget tile's menu —
   * note this only controls the home tile; the artifact's widget entry is
   * untouched, so flipping it back on re-pins the same live tile.
   */
  widgetEnabled?: boolean;
  /**
   * Master on/off switch surfaced in the Control Center. Opt-out: absent or
   * `true` means the app is active; `false` "pauses" the whole app — its
   * widget is hidden from the Home board (regardless of `widgetEnabled`) and
   * its scheduled task is paused server-side (the Control Center flips the
   * Redis schedule flag alongside this). Independent of archiving, which
   * removes the app entirely; a disabled app is just dormant and one click
   * from active again.
   */
  appEnabled?: boolean;
  /**
   * User archive timestamp. When set, the app is archived: its tile is hidden
   * from the Apps list, its widget is hidden from the Home board, it drops out
   * of the Control Center, and its scheduled task is paused server-side. Unlike
   * the `archivedApps` graveyard store (a soft-delete for removed apps), an
   * archived app keeps its row in `apps` and its paired designer, so it can be
   * restored intact from the archive panel - or deleted for good from there.
   * Absent/undefined ⇒ the app is live.
   */
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
  /** Account-level sharing (v10). See StoredDesigner for semantics; designer
   *  and app pair together — toggling the designer also toggles the app. */
  accountShared?: boolean;
  accountSharedAt?: number;
  lastSyncedAt?: number;
};

/**
 * Soft-delete archive for non-canonical legacy instances and any app the user
 * "deletes" via the UI. The original payload is preserved verbatim so data is
 * never lost.
 */
export type ArchivedApp = {
  id: string;
  /** The designer/app id this row was originally paired with. */
  originalAppId: string;
  archivedAt: number;
  payload: StoredApp | LegacyInstance;
  reason: "v7-migration-non-canonical" | "user-archive" | "designer-deleted";
};

// Base name preserved as a constant for backup/restore compatibility and
// for the admin's existing IndexedDB. Multi-user installs derive the
// per-user DB name from the `user_hash` cookie set at login (see
// `resolveDbName` below) so each user gets an isolated store.
const BASE_DB_NAME = "ollama-chat";
const DB_VERSION = 13;

// Sentinel `user_hash` cookie value that maps back to the legacy unsuffixed
// DB name. Set for the admin account so their pre-multiuser data stays in
// place after the upgrade. Must match `ADMIN_USER_HASH` in lib/auth.ts —
// we don't import from there to keep this module dependency-free.
const ADMIN_HASH_SENTINEL = "admin";
const USER_HASH_COOKIE_NAME = "user_hash";

function readUserHashCookie(): string | null {
  if (typeof document === "undefined") return null;
  const raw = document.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === USER_HASH_COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

let cachedDbName: string | null = null;

/**
 * Returns the IndexedDB name for the current user. Admin (or no cookie at
 * all — share-link recipients on `/share/*` reach this code with no
 * session) gets the legacy unsuffixed name so existing data is preserved.
 * Every other user gets `ollama-chat-{hash}`.
 *
 * Cached after the first call: changing identity requires a logout, which
 * also drops the cookie, and the user_hash always tracks the auth cookie's
 * lifetime. A fresh page load picks up the new hash naturally.
 */
function resolveDbName(): string {
  if (cachedDbName) return cachedDbName;
  const hash = readUserHashCookie();
  if (!hash || hash === ADMIN_HASH_SENTINEL) {
    cachedDbName = BASE_DB_NAME;
  } else {
    // Keep the hash URL-safe — the cookie itself already is, but be defensive
    // against any future change to the cookie format.
    const safe = hash.replace(/[^A-Za-z0-9_-]/g, "");
    cachedDbName = `${BASE_DB_NAME}-${safe || "anon"}`;
  }
  return cachedDbName;
}

const MESSAGES = "messages";
const SETTINGS = "settings";
const TEMPLATES = "templates"; // v6 legacy, read-only after v7
const INSTANCES = "instances"; // v6 legacy, read-only after v7
const DESIGNERS = "designers";
const APPS = "apps";
const ARCHIVED_APPS = "archivedApps";
const CHATS = "chats";
const QUERY_CACHE = "queryCache";
const PENDING_QUERIES = "pendingQueries";
const PINNED_NOTES = "pinnedNotes";
const SEARCH_INDEX = "searchIndex";

const SETTINGS_KEY = "user";
const CHAT_INDEX_KEY = "chatIndex";

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Account-sync push hook. Registered at runtime by app/lib/account-sync.ts
 * (the only consumer) so this module avoids importing it back — that would
 * cycle. After each put\* / delete\* completes, the matching hook fires
 * fire-and-forget so account-shared rows replicate to the backend.
 * Non-shared rows are filtered inside the hook implementation.
 *
 * The single (type, row) shape lets db.ts dispatch without growing a new
 * field every time we add an entity type — every save path lands in the
 * same call.
 */
export type AccountSyncEntity =
  | { type: "designer"; row: StoredDesigner }
  | { type: "app"; row: StoredApp }
  | { type: "chat"; row: StoredChat }
  | { type: "note"; row: StoredPinnedNote };

export type AccountSyncHook = {
  onSave?: (entity: AccountSyncEntity) => void;
  onDelete?: (type: AccountSyncEntity["type"], id: string) => void;
  // Fires whenever a message belonging to `chatId` is written. Chats are
  // pushed as a bundle (chat row + all messages), so a new message changes
  // the bundle even though no putChat was called — without this signal the
  // server's copy goes stale until something else bumps the chat row.
  onMessageSave?: (chatId: string) => void;
};
let accountSyncHook: AccountSyncHook | null = null;
export function registerAccountSyncHook(h: AccountSyncHook): void {
  accountSyncHook = h;
}

function openDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(resolveDbName(), DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction!;
      const oldVersion = event.oldVersion;

      // v1 → v2 (existed before): create messages + settings if missing.
      if (!db.objectStoreNames.contains(MESSAGES)) {
        const store = db.createObjectStore(MESSAGES, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(SETTINGS)) {
        db.createObjectStore(SETTINGS);
      }

      // v4: templates store a VFS instead of a single `html` field.
      // The migration is lazy on read (see migrateDesigner) — we only need
      // to ensure the upgrade transaction completes; no row-level rewrite here.
      void oldVersion;

      // v3: chats / templates / instances + chatId on messages.
      if (oldVersion < 3) {
        if (!db.objectStoreNames.contains(CHATS)) {
          const chats = db.createObjectStore(CHATS, { keyPath: "id" });
          chats.createIndex("updatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains(TEMPLATES)) {
          const templates = db.createObjectStore(TEMPLATES, { keyPath: "id" });
          templates.createIndex("status", "status");
          templates.createIndex("updatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains(INSTANCES)) {
          const instances = db.createObjectStore(INSTANCES, { keyPath: "id" });
          instances.createIndex("templateId", "templateId");
          instances.createIndex("updatedAt", "updatedAt");
        }

        const messages = tx.objectStore(MESSAGES);
        if (!messages.indexNames.contains("chatId_createdAt")) {
          messages.createIndex("chatId_createdAt", ["chatId", "createdAt"]);
        }

        // Migrate existing messages → assign chatId="default" and ensure a default chat row.
        const cursorReq = messages.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const msg = cursor.value as StoredMessage;
          if (!msg.chatId) {
            msg.chatId = DEFAULT_CHAT_ID;
            cursor.update(msg);
          }
          cursor.continue();
        };

        const chats = tx.objectStore(CHATS);
        const now = Date.now();
        chats.put({
          id: DEFAULT_CHAT_ID,
          title: "Default chat",
          createdAt: now,
          updatedAt: now,
          // Stamp lastSyncedAt so a newer account-synced default chat can win on
          // first pull, rather than being blocked by the unsynced-edit clause.
          lastSyncedAt: now,
        });
      }

      // v4: per-instance cache for artifact.query / artifact.fetch results so
      // reloading a tab doesn't immediately re-run the request.
      if (oldVersion < 4) {
        if (!db.objectStoreNames.contains(QUERY_CACHE)) {
          const cache = db.createObjectStore(QUERY_CACHE, { keyPath: "key" });
          cache.createIndex("instanceId", "instanceId");
          cache.createIndex("storedAt", "storedAt");
        }
      }

      // v6: pending artifact.query() calls — streamId persisted before the
      // POST resolves so a tab close mid-fetch can be recovered on next mount
      // by hitting /api/query/resume/{streamId}.
      if (oldVersion < 6) {
        if (!db.objectStoreNames.contains(PENDING_QUERIES)) {
          const pending = db.createObjectStore(PENDING_QUERIES, { keyPath: "key" });
          pending.createIndex("instanceId", "instanceId");
        }
      }

      // v7: rename templates → designers, instances → apps. 1:1 pairing by id.
      // Roll-forward only: legacy stores remain readable; non-canonical
      // instances are archived rather than discarded.
      if (oldVersion < 7) {
        if (!db.objectStoreNames.contains(DESIGNERS)) {
          const designers = db.createObjectStore(DESIGNERS, { keyPath: "id" });
          designers.createIndex("status", "status");
          designers.createIndex("updatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains(APPS)) {
          const apps = db.createObjectStore(APPS, { keyPath: "id" });
          apps.createIndex("updatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains(ARCHIVED_APPS)) {
          const archived = db.createObjectStore(ARCHIVED_APPS, { keyPath: "id" });
          archived.createIndex("originalAppId", "originalAppId");
          archived.createIndex("archivedAt", "archivedAt");
        }

        // Add appId index to query/pending stores so callers don't have to
        // pun on the legacy field name. Existing rows still carry instanceId;
        // the cursor pass below copies it across.
        if (db.objectStoreNames.contains(QUERY_CACHE)) {
          const cache = tx.objectStore(QUERY_CACHE);
          if (!cache.indexNames.contains("appId")) {
            cache.createIndex("appId", "appId");
          }
        }
        if (db.objectStoreNames.contains(PENDING_QUERIES)) {
          const pending = tx.objectStore(PENDING_QUERIES);
          if (!pending.indexNames.contains("appId")) {
            pending.createIndex("appId", "appId");
          }
        }

        const designersStore = tx.objectStore(DESIGNERS);
        const appsStore = tx.objectStore(APPS);
        const archivedStore = tx.objectStore(ARCHIVED_APPS);
        const now = Date.now();

        // 1. Copy templates → designers, running migrateDesigner inline so
        //    the new store is canonical going forward.
        if (db.objectStoreNames.contains(TEMPLATES)) {
          const tpls = tx.objectStore(TEMPLATES);
          const tcur = tpls.openCursor();
          tcur.onsuccess = () => {
            const c = tcur.result;
            if (!c) return;
            const migrated = migrateDesigner(c.value as StoredDesigner | LegacyV3Template);
            if (migrated) designersStore.put(migrated);
            c.continue();
          };
        }

        // 2. Group instances by templateId; pick the latest as canonical app,
        //    archive the rest. Run synchronously by collecting first then writing.
        if (db.objectStoreNames.contains(INSTANCES)) {
          const insts = tx.objectStore(INSTANCES);
          const allReq = insts.getAll();
          allReq.onsuccess = () => {
            const all = (allReq.result ?? []) as LegacyInstance[];
            const byTemplate = new Map<string, LegacyInstance[]>();
            for (const inst of all) {
              if (!inst || !inst.templateId) continue;
              const list = byTemplate.get(inst.templateId) ?? [];
              list.push(inst);
              byTemplate.set(inst.templateId, list);
            }
            // canonicalAppByOriginalInstanceId: maps every legacy instance.id
            // to the app.id (= templateId) it now points to. Used for chat
            // target repointing in step 3.
            const canonicalByInstanceId = new Map<string, string>();

            for (const [templateId, list] of byTemplate) {
              list.sort((a, b) => {
                const ar = a.lastRunAt ?? a.updatedAt ?? 0;
                const br = b.lastRunAt ?? b.updatedAt ?? 0;
                return br - ar;
              });
              const [canonical, ...rest] = list;
              if (canonical) {
                const app: StoredApp = {
                  id: templateId,
                  name: canonical.name || "App",
                  params: canonical.params ?? {},
                  model: canonical.model,
                  state: canonical.state ?? {},
                  lastRunAt: canonical.lastRunAt,
                  lastResult: canonical.lastResult,
                  lastError: canonical.lastError,
                  createdAt: canonical.createdAt,
                  updatedAt: now,
                };
                appsStore.put(app);
                canonicalByInstanceId.set(canonical.id, templateId);
              }
              for (const orphan of rest) {
                const archived: ArchivedApp = {
                  id: orphan.id,
                  originalAppId: templateId,
                  archivedAt: now,
                  payload: orphan,
                  reason: "v7-migration-non-canonical",
                };
                archivedStore.put(archived);
                canonicalByInstanceId.set(orphan.id, templateId);
              }
            }

            // 3. Repoint chats targeting a template/instance kind onto the new
            //    designer/app concept. Non-canonical instance targets repoint
            //    to the canonical app id so chat history stays meaningful.
            if (db.objectStoreNames.contains(CHATS)) {
              const chats = tx.objectStore(CHATS);
              const chatCur = chats.openCursor();
              chatCur.onsuccess = () => {
                const c = chatCur.result;
                if (!c) return;
                const chat = c.value as { target?: { kind?: string; id?: string; mode?: string } };
                if (chat.target) {
                  if (chat.target.kind === "template") {
                    chat.target.kind = "designer";
                    c.update(chat);
                  } else if (chat.target.kind === "instance") {
                    chat.target.kind = "app";
                    if (chat.target.id) {
                      const repointed = canonicalByInstanceId.get(chat.target.id);
                      if (repointed) chat.target.id = repointed;
                    }
                    c.update(chat);
                  }
                }
                c.continue();
              };
            }

            // 4. Designers with no instance get an empty paired app so the
            //    1:1 invariant holds immediately. params: {} — manifest
            //    defaults are filled in lazily on first open.
            const designerIdReq = designersStore.getAllKeys();
            designerIdReq.onsuccess = () => {
              const ids = (designerIdReq.result ?? []) as string[];
              const existingAppIdsReq = appsStore.getAllKeys();
              existingAppIdsReq.onsuccess = () => {
                const existing = new Set((existingAppIdsReq.result ?? []) as string[]);
                for (const id of ids) {
                  if (existing.has(id)) continue;
                  const app: StoredApp = {
                    id,
                    name: "App",
                    params: {},
                    state: {},
                    createdAt: now,
                    updatedAt: now,
                  };
                  appsStore.put(app);
                }
              };
            };
          };
        }

        // 5. Copy instanceId → appId on cache rows so the new appId index
        //    populates. We don't drop instanceId — old code reading the
        //    legacy field still works through v7.
        if (db.objectStoreNames.contains(QUERY_CACHE)) {
          const cache = tx.objectStore(QUERY_CACHE);
          const cur = cache.openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return;
            const row = c.value as { instanceId?: string; appId?: string };
            if (row && row.instanceId && !row.appId) {
              row.appId = row.instanceId;
              c.update(row);
            }
            c.continue();
          };
        }
        if (db.objectStoreNames.contains(PENDING_QUERIES)) {
          const pending = tx.objectStore(PENDING_QUERIES);
          const cur = pending.openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return;
            const row = c.value as { instanceId?: string; appId?: string };
            if (row && row.instanceId && !row.appId) {
              row.appId = row.instanceId;
              c.update(row);
            }
            c.continue();
          };
        }
      }

      // v8: user-curated collection of pinned artifacts/messages. Independent
      // store with no relation to designers/apps — pins can outlive their
      // source chat.
      if (oldVersion < 8) {
        if (!db.objectStoreNames.contains(PINNED_NOTES)) {
          const pins = db.createObjectStore(PINNED_NOTES, { keyPath: "id" });
          pins.createIndex("createdAt", "createdAt");
          pins.createIndex("chatId", "chatId");
        }
      }

      // v9: persisted client-side inverted index for chat search. Keyed
      // singleton (one row under CHAT_INDEX_KEY); excluded from backups
      // since it's regenerable from chats + messages on next /chats visit.
      if (oldVersion < 9) {
        if (!db.objectStoreNames.contains(SEARCH_INDEX)) {
          db.createObjectStore(SEARCH_INDEX);
        }
      }

      // v10: account-level sharing fields (accountShared / accountSharedAt /
      // lastSyncedAt) on designers, apps, chats, and pinned notes. Purely
      // additive — no new stores or indexes; existing rows simply carry
      // `undefined` (treated as "not shared") until the user opts in.
      void oldVersion;

      // v11: chat-scoped pinned-note attachments (attachedPinIds) and a
      // back-pointer for research-mode chats spawned from a designer
      // (researchFor). Purely additive on StoredChat; no new stores or
      // indexes; existing rows simply carry `undefined`.
      void oldVersion;

      // v12: linked-note iteration. A pinned HTML artifact can be promoted
      // into a designer+app while keeping the note as the canonical share
      // surface. Adds `convertedDesignerId`, `shareToken`, and
      // `shareTokenExpiresAt` to StoredPinnedNote; adds `sourceNoteId` to
      // StoredDesigner. Purely additive — existing rows simply carry
      // `undefined` until the user runs the convert flow.
      void oldVersion;

      // v13: note-canvas chats — a Gemini-style split-pane editor for any
      // pinned note. Adds `kind: "note-canvas"` to ChatTarget,
      // `canvasForNoteId` to StoredChat (denormalized back-pointer used by
      // listChatsForNote), and `selectionAnchor` to StoredMessage (so the
      // highlighted span the user pinned to a message survives reload).
      // Purely additive — no new stores or indexes; existing rows carry
      // `undefined` for the new fields.
      void oldVersion;
    };
    req.onsuccess = () => {
      const db = req.result;
      // If another tab later opens this DB at a higher version, the browser
      // fires `versionchange` on every existing connection. Closing here lets
      // the new tab's upgrade transaction proceed instead of stalling on
      // `blocked`. Without this, a stale tab at v(N) silently deadlocks every
      // future tab at v(N+1) — the symptom is `openDB()` hanging forever and
      // pages stuck on their loading spinner.
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          // already closed — nothing to do
        }
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
    // Fires when an OPEN-WITH-UPGRADE is held up by another tab still holding
    // a connection at the prior version. Pair this with the `versionchange`
    // handler above (which closes those stale connections proactively) so the
    // user doesn't have to manually close other tabs. Reject rather than hang
    // so the caller's `.catch` can surface a real error.
    req.onblocked = () => {
      dbPromise = null;
      reject(
        new Error(
          "Database upgrade blocked by another open tab. Close other Lasagna tabs and reload."
        )
      );
    };
  });
  return dbPromise;
}

// ---------- shared helpers ----------

function txWait<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------- messages ----------

/** Load all messages for a chat, oldest-first. */
export async function loadMessages(chatId: string = DEFAULT_CHAT_ID): Promise<StoredMessage[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDB();
  const tx = db.transaction(MESSAGES, "readonly");
  const store = tx.objectStore(MESSAGES);
  if (store.indexNames.contains("chatId_createdAt")) {
    const range = IDBKeyRange.bound([chatId, -Infinity], [chatId, Infinity]);
    return txWait(store.index("chatId_createdAt").getAll(range));
  }
  const all = await txWait(store.index("createdAt").getAll());
  return (all as StoredMessage[]).filter((m) => m.chatId === chatId);
}

/**
 * Load concatenated text per chat in a single read transaction. Each chat's
 * body is capped at MAX_BODY_BYTES so the persisted search index stays bounded
 * even for chats with hundreds of long messages. Pass `chatIds` to limit the
 * scan to specific chats (used by the incremental update path).
 *
 * The body includes message text, thinking, and any artifact bodies (legacy
 * `proposedArtifact.html` plus the file paths and contents inside
 * `proposedVfs.files`) so the search box surfaces matches inside
 * code blocks, markdown, and generated files — not just chat prose.
 */
const MAX_INDEX_BODY_BYTES = 24 * 1024;

export async function loadAllMessageBodies(
  chatIds?: ReadonlyArray<string>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (typeof indexedDB === "undefined") return out;
  const db = await openDB();
  const tx = db.transaction(MESSAGES, "readonly");
  const store = tx.objectStore(MESSAGES);
  const wanted = chatIds && chatIds.length > 0 ? new Set(chatIds) : null;

  if (wanted && store.indexNames.contains("chatId_createdAt")) {
    // Targeted: range-scan per chat. Cheap when only a few chats are dirty.
    await Promise.all(
      [...wanted].map(async (chatId) => {
        const range = IDBKeyRange.bound([chatId, -Infinity], [chatId, Infinity]);
        const rows = (await txWait(
          store.index("chatId_createdAt").getAll(range)
        )) as StoredMessage[];
        out.set(chatId, joinMessagesForIndex(rows));
      })
    );
    return out;
  }

  // Full scan: getAll once, group in JS. Still one transaction.
  const all = (await txWait(store.getAll())) as StoredMessage[];
  const byChat = new Map<string, StoredMessage[]>();
  for (const m of all) {
    if (wanted && !wanted.has(m.chatId)) continue;
    const list = byChat.get(m.chatId);
    if (list) list.push(m);
    else byChat.set(m.chatId, [m]);
  }
  for (const [chatId, rows] of byChat) {
    rows.sort((a, b) => a.createdAt - b.createdAt);
    out.set(chatId, joinMessagesForIndex(rows));
  }
  return out;
}

function joinMessagesForIndex(rows: StoredMessage[]): string {
  let acc = "";
  const append = (chunk: string | undefined): boolean => {
    if (!chunk) return false;
    if (acc) acc += "\n";
    acc += chunk;
    return acc.length >= MAX_INDEX_BODY_BYTES;
  };
  for (const m of rows) {
    if (append(m.content)) break;
    if (append(m.thinking)) break;
    const artifactHtml = m.proposedArtifact?.html;
    if (artifactHtml && append(stripHtmlForIndex(artifactHtml))) break;
    const vfs = m.proposedVfs;
    if (vfs?.files) {
      let stop = false;
      for (const [path, content] of Object.entries(vfs.files)) {
        if (append(path)) { stop = true; break; }
        if (typeof content === "string" && append(content)) { stop = true; break; }
      }
      if (stop) break;
    }
  }
  return acc.length > MAX_INDEX_BODY_BYTES ? acc.slice(0, MAX_INDEX_BODY_BYTES) : acc;
}

function stripHtmlForIndex(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

export async function loadPersistedChatIndex<T>(): Promise<T | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await openDB();
  const tx = db.transaction(SEARCH_INDEX, "readonly");
  const row = (await txWait(tx.objectStore(SEARCH_INDEX).get(CHAT_INDEX_KEY))) as T | undefined;
  return row ?? null;
}

export async function savePersistedChatIndex<T>(index: T): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(SEARCH_INDEX, "readwrite");
  tx.objectStore(SEARCH_INDEX).put(index, CHAT_INDEX_KEY);
  return txDone(tx);
}

export async function clearPersistedChatIndex(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(SEARCH_INDEX, "readwrite");
  tx.objectStore(SEARCH_INDEX).delete(CHAT_INDEX_KEY);
  return txDone(tx);
}

export async function putMessage(msg: StoredMessage): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(MESSAGES, "readwrite");
  tx.objectStore(MESSAGES).put(msg);
  await txDone(tx);
  accountSyncHook?.onMessageSave?.(msg.chatId);
}

export async function getMessage(id: string): Promise<StoredMessage | undefined> {
  return loadMessageById(id);
}

async function loadMessageById(id: string): Promise<StoredMessage | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const db = await openDB();
  const tx = db.transaction(MESSAGES, "readonly");
  return (await txWait(tx.objectStore(MESSAGES).get(id))) as StoredMessage | undefined;
}

export async function addAnnotation(
  messageId: string,
  ann: MessageAnnotation
): Promise<void> {
  const msg = await loadMessageById(messageId);
  if (!msg) return;
  const next: StoredMessage = {
    ...msg,
    annotations: [...(msg.annotations ?? []), ann],
  };
  await putMessage(next);
}

export async function updateAnnotation(
  messageId: string,
  annotationId: string,
  patch: Partial<MessageAnnotation>
): Promise<void> {
  const msg = await loadMessageById(messageId);
  if (!msg?.annotations) return;
  const next: StoredMessage = {
    ...msg,
    annotations: msg.annotations.map((a) =>
      a.id === annotationId ? { ...a, ...patch, updatedAt: Date.now() } : a
    ),
  };
  await putMessage(next);
}

export async function deleteMessage(id: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(MESSAGES, "readwrite");
  tx.objectStore(MESSAGES).delete(id);
  return txDone(tx);
}

/**
 * Delete every message in `chatId` whose createdAt is >= `fromCreatedAt`.
 * Used by the "Revert to here" action to truncate the chat at a chosen point.
 */
export async function deleteMessagesFrom(chatId: string, fromCreatedAt: number): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(MESSAGES, "readwrite");
  const store = tx.objectStore(MESSAGES);
  if (store.indexNames.contains("chatId_createdAt")) {
    const range = IDBKeyRange.bound([chatId, fromCreatedAt], [chatId, Infinity]);
    const cur = store.index("chatId_createdAt").openCursor(range);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      c.delete();
      c.continue();
    };
  }
  return txDone(tx);
}

export async function clearMessages(chatId?: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(MESSAGES, "readwrite");
  const store = tx.objectStore(MESSAGES);
  if (!chatId) {
    store.clear();
  } else if (store.indexNames.contains("chatId_createdAt")) {
    const range = IDBKeyRange.bound([chatId, -Infinity], [chatId, Infinity]);
    const cur = store.index("chatId_createdAt").openCursor(range);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      c.delete();
      c.continue();
    };
  }
  return txDone(tx);
}

// ---------- settings ----------

export async function loadSettings(): Promise<Settings> {
  if (typeof indexedDB === "undefined") return { ...DEFAULT_SETTINGS };
  const db = await openDB();
  const tx = db.transaction(SETTINGS, "readonly");
  const stored = await txWait(tx.objectStore(SETTINGS).get(SETTINGS_KEY));
  return { ...DEFAULT_SETTINGS, ...((stored as Partial<Settings> | undefined) ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(SETTINGS, "readwrite");
  tx.objectStore(SETTINGS).put(settings, SETTINGS_KEY);
  return txDone(tx);
}

// ---------- chats ----------

/**
 * Defensive coercion: any chat row that slipped past the v7 upgrade with
 * the old kind strings is normalized here so the rest of the app can rely
 * on "designer" | "app".
 */
function normalizeChatTarget(chat: StoredChat): StoredChat {
  if (!chat.target) return chat;
  const t = chat.target as unknown as { kind: string; id?: string; mode?: string; noteId?: string };
  if (t.kind === "template" && typeof t.id === "string") {
    return {
      ...chat,
      target: { kind: "designer", id: t.id, mode: (t.mode as "edit" | "setup") ?? "edit" },
    };
  }
  if (t.kind === "instance" && typeof t.id === "string") {
    return {
      ...chat,
      target: { kind: "app", id: t.id, mode: (t.mode as "edit" | "setup") ?? "setup" },
    };
  }
  return chat;
}

export type StoredChat = {
  id: string;
  title: string;
  target?: ChatTarget;
  model?: string;
  /**
   * Tracks how `title` was set. `"default"` means the placeholder ("New chat" /
   * "New artifact" / "Edit · …") is still in place and the lazy titler may
   * overwrite it. `"user"` means the user renamed manually — never touch it.
   * `"gemma"` means the titler already filled it; refreshed only if cleared.
   */
  titleSource?: "default" | "user" | "gemma";
  titleUpdatedAt?: number;
  createdAt: number;
  updatedAt: number;
  /**
   * Set on chats spawned by the highlight-to-research flow. Points back to
   * the parent chat + message + annotation so the child can render a
   * back-link banner and the parent can find its children.
   */
  parentChatId?: string;
  parentMessageId?: string;
  parentAnnotationId?: string;
  /** Denormalized copy of the highlighted passage, for the banner UI. */
  parentSelection?: { text: string };
  /**
   * Set on chats spawned by the "Fork chat" header action. Points back to the
   * source chat so the fork can render a back-link banner. Distinct from
   * parentChatId, which is reserved for the highlight-to-research flow.
   */
  forkedFromChatId?: string;
  /**
   * Set on chats spawned from a pinned note via the Notes → Chat & Edit
   * action. Lets PinDialog detect that a re-pin from this chat may want to
   * override (in place) the original pinned note rather than create a new one.
   */
  sourcePinId?: string;
  /**
   * Soft-delete timestamp. When set, the chat is in trash: hidden from
   * listChats() (and therefore the chat list, search index, and per-designer
   * pickers). Auto-purged CHAT_TRASH_RETENTION_MS after this timestamp.
   */
  archivedAt?: number;
  /** Account-level sharing (v10). When true, this chat — and its full message
   *  history — is mirrored to the server account store. */
  accountShared?: boolean;
  accountSharedAt?: number;
  lastSyncedAt?: number;
  /**
   * Account-sync image offload (Blob). A shared chat's inline base64 image
   * `dataUrl`s can push the sync bundle past Vercel's 4.5 MB POST cap, so the
   * push silently fails. When the bundle is too large, every image's dataUrl
   * is uploaded to ONE blob (`images.json`, a `{ imageId: dataUrl }` map) and
   * stripped from the wire payload; the receiving device rehydrates from it.
   * `imagesBlobUrl` points at that blob; `imagesBlobSig` is the signature of
   * the image-id set already uploaded, so an unchanged chat skips re-upload.
   * Local IDB always keeps the full dataUrls - these are sync-only metadata,
   * cleared when sharing is turned off (the blob is deleted server-side then).
   */
  imagesBlobUrl?: string;
  imagesBlobSig?: string;
  /**
   * v11 — ephemeral pinned notes attached to this chat as supplementary
   * context. Each turn injects the pin contents into the system prompt
   * inside an `<attached_notes>` block. User-managed via the composer
   * paperclip; removable as chips above the composer.
   */
  attachedPinIds?: string[];
  /**
   * v11 — set when this chat was launched by the "Research →" button on
   * `/designer/{id}`. Points back to the originating designer/app so the
   * chat can render a banner with Back and "Send to notes" affordances,
   * and so the designer page can list research chats in its picker.
   */
  researchFor?: string;
  /**
   * v13 — denormalized back-pointer for canvas chats that edit a pinned
   * note. Mirrors `researchFor` / `sourcePinId`. Kept here (not on the note)
   * so multiple concurrent canvas conversations on one note don't contend
   * for the note row. `target.kind === "note-canvas"` implies this is set;
   * the duplicate makes `listChatsForNote` a single JS filter without
   * destructuring discriminated unions.
   */
  canvasForNoteId?: string;
  /**
   * Wall-clock when the user last opened this chat in the detail view.
   * Compared against `updatedAt` on the chats list to flag chats that
   * gained new content since the user looked at them. Writing this field
   * must NOT bump `updatedAt` — otherwise viewing a chat would mark it
   * as having new content for itself.
   */
  lastViewedAt?: number;
  /**
   * Per-chat auto-archive timer. When `ttlExpiresAt` is set, the chat is
   * moved to trash the next time `autoArchiveExpiredChats` runs after the
   * timestamp. When `ttlPausedRemainingMs` is set instead, the chat is
   * paused with that much time still on the clock — resuming sets
   * ttlExpiresAt = now + remaining. Both unset means "no expiry".
   * `ttlDurationMs` records the user's configured duration so the popover
   * can highlight the active preset.
   */
  ttlExpiresAt?: number;
  ttlPausedRemainingMs?: number;
  ttlDurationMs?: number;
  sessionMemoryNoteId?: string;
  /**
   * Pinned note collecting passages the user highlighted in therapist mode
   * ("Saved passages — {title}"). Created lazily on the first clip. Distinct
   * from sessionMemoryNoteId so the AI-maintained session summary never
   * rewrites the user's verbatim clippings.
   */
  therapyClipsNoteId?: string;
};

export const CHAT_TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Default per-chat TTL applied when a chat is created. The user can override
 * (or clear) via the TTL chip in the header / list row. Currently 7 days.
 */
export const DEFAULT_CHAT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fields to spread into a newly-created StoredChat so it picks up the
 * default auto-archive timer. Existing rows are not retroactively stamped —
 * only chats created after this lands carry the default.
 */
export function newChatTtl(now: number = Date.now()): Pick<StoredChat, "ttlExpiresAt" | "ttlDurationMs"> {
  return {
    ttlExpiresAt: now + DEFAULT_CHAT_TTL_MS,
    ttlDurationMs: DEFAULT_CHAT_TTL_MS,
  };
}

/**
 * Archive every chat whose ttlExpiresAt is in the past. Called alongside
 * `purgeArchivedChatsOlderThan` on the chats list so expired chats slide
 * straight into trash (and then get hard-purged 7 days later via the
 * existing retention policy). Returns the number of chats archived.
 */
export async function autoArchiveExpiredChats(now: number = Date.now()): Promise<number> {
  if (typeof indexedDB === "undefined") return 0;
  const db = await openDB();
  const tx = db.transaction(CHATS, "readonly");
  const all = (await txWait(tx.objectStore(CHATS).getAll())) as StoredChat[];
  const expired = all.filter(
    (c) => !c.archivedAt && c.ttlExpiresAt && c.ttlExpiresAt <= now
  );
  for (const c of expired) {
    await archiveChat(c.id);
  }
  return expired.length;
}

export async function listChats(): Promise<StoredChat[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDB();
  const tx = db.transaction(CHATS, "readonly");
  const all = (await txWait(tx.objectStore(CHATS).index("updatedAt").getAll())) as StoredChat[];
  return all
    .filter((c) => !c.archivedAt)
    .map(normalizeChatTarget)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listArchivedChats(): Promise<StoredChat[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDB();
  const tx = db.transaction(CHATS, "readonly");
  const all = (await txWait(tx.objectStore(CHATS).index("updatedAt").getAll())) as StoredChat[];
  return all
    .filter((c): c is StoredChat & { archivedAt: number } => !!c.archivedAt)
    .map(normalizeChatTarget)
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
}

/**
 * All edit-mode chats targeting the given designer, newest first. Used by the
 * designer page's chat picker and "+ New chat" flow. Strict on
 * `kind==="designer"` and `mode==="edit"` so app/setup chats stay out.
 *
 * Research chats (no target, `researchFor === designerId`) are also included
 * so the user can pop back into a research session from the designer chat
 * picker. They render with a "research" badge.
 */
export async function listChatsForDesigner(designerId: string): Promise<StoredChat[]> {
  const all = await listChats();
  return all.filter(
    (c) =>
      (c.target?.kind === "designer" &&
        c.target.id === designerId &&
        c.target.mode === "edit") ||
      (c.researchFor === designerId && !c.target)
  );
}

/**
 * All canvas chats editing the given pinned note, newest first. Mirrors
 * `listChatsForDesigner`. The note-canvas page uses this to resume the
 * most recent conversation or surface a picker; the /chats list relies on
 * the same target/back-pointer to label these chats correctly.
 */
export async function listChatsForNote(noteId: string): Promise<StoredChat[]> {
  const all = await listChats();
  return all.filter(
    (c) =>
      (c.target?.kind === "note-canvas" && c.target.noteId === noteId) ||
      c.canvasForNoteId === noteId
  );
}

export async function getChat(id: string): Promise<StoredChat | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const db = await openDB();
  const tx = db.transaction(CHATS, "readonly");
  const raw = (await txWait(tx.objectStore(CHATS).get(id))) as StoredChat | undefined;
  return raw ? normalizeChatTarget(raw) : undefined;
}

export async function putChat(chat: StoredChat): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(CHATS, "readwrite");
  tx.objectStore(CHATS).put(chat);
  await txDone(tx);
  accountSyncHook?.onSave?.({ type: "chat", row: chat });
}

/**
 * Record that the user looked at this chat. Does NOT touch `updatedAt` (which
 * would re-sort the chat list and self-cancel the "you have new content"
 * indicator). No-op if the chat row is missing — we don't want to materialize
 * stub rows from a transient navigation.
 */
export async function markChatViewed(id: string, at: number = Date.now()): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(CHATS, "readwrite");
  const store = tx.objectStore(CHATS);
  const existing = (await txWait(store.get(id))) as StoredChat | undefined;
  if (!existing) return;
  if ((existing.lastViewedAt ?? 0) >= at) return;
  store.put({ ...existing, lastViewedAt: at });
  await txDone(tx);
}

/**
 * Single-transaction scan of all messages to find which chats currently
 * have an assistant turn mid-stream. `streamId` is set while the server
 * is producing the message and cleared on the `done` SSE event, so a
 * non-empty `streamId` is the canonical "still working" signal.
 *
 * Returns the chatIds — the list view uses this to render a Working
 * indicator without having to per-chat-loadMessages.
 */
export async function loadStreamingChatIds(): Promise<Set<string>> {
  const out = new Set<string>();
  if (typeof indexedDB === "undefined") return out;
  const db = await openDB();
  const tx = db.transaction(MESSAGES, "readonly");
  const all = (await txWait(tx.objectStore(MESSAGES).getAll())) as StoredMessage[];
  for (const m of all) {
    if (m.streamId) out.add(m.chatId);
  }
  return out;
}

export async function deleteChat(id: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction([CHATS, MESSAGES], "readwrite");
  tx.objectStore(CHATS).delete(id);
  // Cascade: drop all messages in this chat.
  const messages = tx.objectStore(MESSAGES);
  if (messages.indexNames.contains("chatId_createdAt")) {
    const range = IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
    const cur = messages.index("chatId_createdAt").openCursor(range);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      c.delete();
      c.continue();
    };
  }
  await txDone(tx);
  accountSyncHook?.onDelete?.("chat", id);
}

export async function archiveChat(id: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(CHATS, "readwrite");
  const store = tx.objectStore(CHATS);
  const existing = (await txWait(store.get(id))) as StoredChat | undefined;
  if (!existing) return;
  const now = Date.now();
  store.put({ ...existing, archivedAt: now, updatedAt: now });
  return txDone(tx);
}

export async function restoreChat(id: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(CHATS, "readwrite");
  const store = tx.objectStore(CHATS);
  const existing = (await txWait(store.get(id))) as StoredChat | undefined;
  if (!existing) return;
  const { archivedAt: _archivedAt, ...rest } = existing;
  void _archivedAt;
  const now = Date.now();
  // A chat usually lands in trash because its TTL expired. Restoring it with
  // the stale ttlExpiresAt still in the past would let the next
  // autoArchiveExpiredChats sweep re-trash it immediately, so restart the
  // clock with the chat's configured duration.
  if (rest.ttlExpiresAt !== undefined && rest.ttlExpiresAt <= now) {
    rest.ttlExpiresAt = now + (rest.ttlDurationMs ?? DEFAULT_CHAT_TTL_MS);
  }
  store.put({ ...rest, updatedAt: now });
  return txDone(tx);
}

/**
 * Hard-deletes every archived chat whose archivedAt is strictly less than
 * cutoffMs. Reuses deleteChat() so the cascade-to-messages logic isn't
 * duplicated. Returns the number of chats purged.
 */
export async function purgeArchivedChatsOlderThan(cutoffMs: number): Promise<number> {
  if (typeof indexedDB === "undefined") return 0;
  const db = await openDB();
  const tx = db.transaction(CHATS, "readonly");
  const all = (await txWait(tx.objectStore(CHATS).getAll())) as StoredChat[];
  const expired = all.filter((c) => c.archivedAt && c.archivedAt < cutoffMs);
  for (const c of expired) {
    await deleteChat(c.id);
  }
  return expired.length;
}

// ---------- designers ----------

/**
 * Lazy v3→v4 migration: convert a legacy { html: string } designer into the
 * VFS shape on read. Pure — does not write back. Also tolerates rows that
 * were copied verbatim from the legacy `templates` store during the v7
 * upgrade if any escaped the inline migration.
 */
function migrateDesigner(t: StoredDesigner | LegacyV3Template | undefined): StoredDesigner | undefined {
  if (!t) return undefined;
  if ("files" in t && t.files && typeof t.files === "object" && t.entry) {
    return t as StoredDesigner;
  }
  const legacy = t as LegacyV3Template;
  const html = legacy.html ?? "";
  const files: ArtifactFiles = { "index.html": html };
  const history = (legacy.history ?? []).map((h) => ({
    version: h.version,
    files: h.files ?? { "index.html": h.html ?? "" },
    entry: h.entry ?? "index.html",
    savedAt: h.savedAt,
  }));
  return {
    id: legacy.id,
    name: legacy.name,
    description: legacy.description,
    files,
    entry: "index.html",
    lastBuild: undefined,
    manifest: legacy.manifest,
    status: legacy.status,
    version: legacy.version,
    history,
    sourceChatId: legacy.sourceChatId,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
  };
}

export async function listDesigners(): Promise<StoredDesigner[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDB();
  const tx = db.transaction(DESIGNERS, "readonly");
  const all = (await txWait(tx.objectStore(DESIGNERS).index("updatedAt").getAll())) as Array<
    StoredDesigner | LegacyV3Template
  >;
  return all
    .map(migrateDesigner)
    .filter((d): d is StoredDesigner => !!d)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDesigner(id: string): Promise<StoredDesigner | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const db = await openDB();
  const tx = db.transaction(DESIGNERS, "readonly");
  const raw = (await txWait(tx.objectStore(DESIGNERS).get(id))) as
    | StoredDesigner
    | LegacyV3Template
    | undefined;
  return migrateDesigner(raw);
}

export async function putDesigner(designer: StoredDesigner): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(DESIGNERS, "readwrite");
  tx.objectStore(DESIGNERS).put(designer);
  await txDone(tx);
  accountSyncHook?.onSave?.({ type: "designer", row: designer });
}

/**
 * Remove a designer. Cascades: the paired app (same id) is moved into
 * archivedApps so its state survives. The designer's edit chat is dropped.
 * App data is never hard-deleted.
 */
export async function deleteDesigner(id: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await archiveApp(id, "designer-deleted");
  const db = await openDB();
  const tx = db.transaction(DESIGNERS, "readwrite");
  tx.objectStore(DESIGNERS).delete(id);
  await txDone(tx);
  // archiveApp() above already moved the local app row into archivedApps and
  // fired no hook; mirror both deletions to the account store here so the
  // server doesn't keep ghost rows for a deleted designer.
  accountSyncHook?.onDelete?.("designer", id);
  accountSyncHook?.onDelete?.("app", id);
}

// ---------- apps ----------

export async function listApps(): Promise<StoredApp[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDB();
  const tx = db.transaction(APPS, "readonly");
  const all = (await txWait(tx.objectStore(APPS).index("updatedAt").getAll())) as StoredApp[];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getApp(id: string): Promise<StoredApp | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const db = await openDB();
  const tx = db.transaction(APPS, "readonly");
  return (await txWait(tx.objectStore(APPS).get(id))) as StoredApp | undefined;
}

export async function putApp(app: StoredApp): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(APPS, "readwrite");
  tx.objectStore(APPS).put(app);
  await txDone(tx);
  accountSyncHook?.onSave?.({ type: "app", row: app });
}

/**
 * Toggle an app's user-archive flag. Sets `archivedAt` (to now) when
 * archiving, strips it when restoring. Bumps `updatedAt` so account-sync's
 * last-write-wins picks the change up. Returns the updated row, or undefined
 * if the app doesn't exist. Note: this only flips the local flag - the caller
 * is responsible for pausing/resuming the server-side schedule (see
 * app/lib/app-archive.ts), which the cron sweep can't read from IndexedDB.
 */
export async function setAppArchived(
  id: string,
  archived: boolean
): Promise<StoredApp | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const db = await openDB();
  const tx = db.transaction(APPS, "readwrite");
  const store = tx.objectStore(APPS);
  const fresh = (await txWait(store.get(id))) as StoredApp | undefined;
  if (!fresh) return txDone(tx).then(() => undefined);
  const now = Date.now();
  let next: StoredApp;
  if (archived) {
    next = { ...fresh, archivedAt: now, updatedAt: now };
  } else {
    const { archivedAt: _archivedAt, ...rest } = fresh;
    void _archivedAt;
    next = { ...rest, updatedAt: now };
  }
  store.put(next);
  await txDone(tx);
  accountSyncHook?.onSave?.({ type: "app", row: next });
  return next;
}

/**
 * Idempotent: ensures the app row paired with `designerId` exists. If it
 * does, returns it unchanged — never resets state. If missing, creates a
 * fresh empty app. This is the 1:1 invariant enforcement point.
 */
export async function ensureAppForDesigner(designerId: string, name: string): Promise<StoredApp> {
  const existing = await getApp(designerId);
  if (existing) return existing;
  const now = Date.now();
  const app: StoredApp = {
    id: designerId,
    name: name || "App",
    params: {},
    state: {},
    createdAt: now,
    updatedAt: now,
  };
  await putApp(app);
  return app;
}

/**
 * Move an app row from `apps` into `archivedApps`. Never destroys data —
 * the original payload is preserved verbatim. Safe to call when the row
 * doesn't exist (no-op).
 */
export async function archiveApp(
  id: string,
  reason: ArchivedApp["reason"] = "user-archive"
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction([APPS, ARCHIVED_APPS], "readwrite");
  const apps = tx.objectStore(APPS);
  const archive = tx.objectStore(ARCHIVED_APPS);
  const app = (await txWait(apps.get(id))) as StoredApp | undefined;
  if (app) {
    const archived: ArchivedApp = {
      id: `${id}-${Date.now()}`,
      originalAppId: id,
      archivedAt: Date.now(),
      payload: app,
      reason,
    };
    archive.put(archived);
    apps.delete(id);
  }
  return txDone(tx);
}

/**
 * Merge a single key into an app's state, preserving every other key.
 * This is the ONLY supported mutation path for app.state — keeps the
 * "state never shrinks behind the artifact's back" invariant local to
 * one helper. Reads-fresh, writes-merged, in a single transaction.
 */
export async function mergeAppStateKey(
  appId: string,
  key: string,
  value: unknown
): Promise<StoredApp | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const db = await openDB();
  const tx = db.transaction(APPS, "readwrite");
  const store = tx.objectStore(APPS);
  const fresh = (await txWait(store.get(appId))) as StoredApp | undefined;
  if (!fresh) {
    return txDone(tx).then(() => undefined);
  }
  const nextState = { ...(fresh.state ?? {}), [key]: value };
  const next: StoredApp = { ...fresh, state: nextState, updatedAt: Date.now() };
  store.put(next);
  await txDone(tx);
  accountSyncHook?.onSave?.({ type: "app", row: next });
  return next;
}

/**
 * Stamp the app's "Last refreshed" clock. One writer for one value: the host
 * calls this whenever a declared source lands data (user refresh OR schedule
 * bridge), so the header can never say "never" while the widget shows data.
 * Monotonic - an older schedule snapshot never rewinds the clock.
 */
export async function touchAppLastRun(
  appId: string,
  at: number = Date.now()
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(APPS, "readwrite");
  const store = tx.objectStore(APPS);
  const fresh = (await txWait(store.get(appId))) as StoredApp | undefined;
  if (!fresh || (fresh.lastRunAt ?? 0) >= at) {
    await txDone(tx);
    return;
  }
  const next: StoredApp = { ...fresh, lastRunAt: at, updatedAt: Date.now() };
  store.put(next);
  await txDone(tx);
  accountSyncHook?.onSave?.({ type: "app", row: next });
}

// ---------- query cache ----------

export type CachedQuery = {
  /** Stable hash of (appId, kind, prompt/url, opts/init). */
  key: string;
  /** v7+ canonical name for the owning app. */
  appId: string;
  /** @deprecated v7 alias kept on the IDB row so the legacy index keeps working. */
  instanceId?: string;
  kind: "query" | "fetch" | "image-search";
  result: unknown;
  storedAt: number;
  /**
   * For `kind: "query"` rows only: the originating artifact.query() request.
   * Stored so the row is self-describing and a later mount can replay the
   * result to artifact.onQueryResult (which is keyed by prompt+opts) without
   * having to re-run the query — this is what makes a button-driven query
   * still show its data after the user leaves and returns much later.
   */
  prompt?: string;
  opts?: unknown;
};

export async function getCachedQuery(key: string): Promise<CachedQuery | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const db = await openDB();
  const tx = db.transaction(QUERY_CACHE, "readonly");
  const raw = (await txWait(tx.objectStore(QUERY_CACHE).get(key))) as CachedQuery | undefined;
  if (!raw) return undefined;
  if (!raw.appId && raw.instanceId) raw.appId = raw.instanceId;
  return raw;
}

export async function putCachedQuery(entry: CachedQuery): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(QUERY_CACHE, "readwrite");
  // Mirror appId → instanceId so the legacy index (which still exists for
  // compatibility) continues to find rows.
  const row: CachedQuery = { ...entry, instanceId: entry.appId };
  tx.objectStore(QUERY_CACHE).put(row);
  return txDone(tx);
}

/**
 * All cached `query`-kind results for an app, newest first. Used on mount to
 * replay the last result of each distinct query to artifact.onQueryResult so
 * an artifact that renders from that handler shows its data again after the
 * user returns — even days later, long after the server-side stream and the
 * pending-query breadcrumb have aged out. fetch / image-search rows are
 * skipped: those aren't surfaced through onQueryResult.
 */
export async function getCachedQueriesByApp(appId: string): Promise<CachedQuery[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDB();
  const tx = db.transaction(QUERY_CACHE, "readonly");
  const store = tx.objectStore(QUERY_CACHE);
  const indexName = store.indexNames.contains("appId") ? "appId" : "instanceId";
  const all = (await txWait(
    store.index(indexName).getAll(IDBKeyRange.only(appId))
  )) as CachedQuery[];
  return all
    .filter((row) => row.kind === "query")
    .map((row) => (row.appId ? row : { ...row, appId: row.instanceId ?? "" }))
    .sort((a, b) => b.storedAt - a.storedAt);
}

export async function clearAppQueryCache(appId: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(QUERY_CACHE, "readwrite");
  const store = tx.objectStore(QUERY_CACHE);
  const indexName = store.indexNames.contains("appId") ? "appId" : "instanceId";
  const cur = store.index(indexName).openCursor(IDBKeyRange.only(appId));
  cur.onsuccess = () => {
    const c = cur.result;
    if (!c) return;
    c.delete();
    c.continue();
  };
  return txDone(tx);
}

// ---------- pending queries ----------

export type PendingQuery = {
  /** Same cache key shape as CachedQuery so a successful resume can drop straight into queryCache. */
  key: string;
  appId: string;
  /** @deprecated v7 alias kept for legacy index. */
  instanceId?: string;
  streamId: string;
  startedAt: number;
  /** The original query() request, stashed so the recovery sweep can deliver
   *  a meaningful `query-result` event (prompt + opts) to artifact.onQueryResult
   *  on the next mount. Optional for backward-compat with older breadcrumbs. */
  prompt?: string;
  opts?: unknown;
  /** Set when this run is a declared-data entry refresh (entries.refresh /
   *  host Refresh). The recovery sweep then lands the result in the entry via
   *  the merge engine instead of delivering a query-result event. */
  entryKey?: string;
};

export async function putPendingQuery(entry: PendingQuery): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(PENDING_QUERIES, "readwrite");
  const row: PendingQuery = { ...entry, instanceId: entry.appId };
  tx.objectStore(PENDING_QUERIES).put(row);
  return txDone(tx);
}

export async function getPendingQueriesByApp(appId: string): Promise<PendingQuery[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDB();
  const tx = db.transaction(PENDING_QUERIES, "readonly");
  const store = tx.objectStore(PENDING_QUERIES);
  const indexName = store.indexNames.contains("appId") ? "appId" : "instanceId";
  const all = (await txWait(
    store.index(indexName).getAll(IDBKeyRange.only(appId))
  )) as PendingQuery[];
  return all.map((p) => (p.appId ? p : { ...p, appId: p.instanceId ?? "" }));
}

export async function deletePendingQuery(key: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(PENDING_QUERIES, "readwrite");
  tx.objectStore(PENDING_QUERIES).delete(key);
  return txDone(tx);
}

// ---------- ids ----------

export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- backup / restore ----------

// Backup blobs carry the live per-user DB name so a restore lands in the
// same store on the same browser. Cross-user restores aren't a supported
// flow — the backup format's magic-string check (in lib/backup.ts) plus the
// fact that each user only sees their own backup in their own UI keeps
// this safe.
export const BACKUP_DB_NAME = resolveDbName();
export const BACKUP_DB_VERSION = DB_VERSION;

// ---------- pinned notes ----------

/**
 * A user-pinned artifact and/or message captured from a chat. Each pin can
 * carry any combination of: the HTML artifact body, the assistant message's
 * markdown prose, an embedded chat transcript snapshot, and/or a flag that
 * means "show a link back to the source chat". Pins are independent records:
 * deleting the source chat does not invalidate them.
 */
export type StoredPinnedNote = {
  id: string;
  createdAt: number;
  title?: string;
  summary?: string;
  chatId?: string;
  chatTitle?: string;
  messageId?: string;
  /** Captured HTML artifact body (when the pin includes the artifact). */
  artifactHtml?: string;
  /** Captured assistant message prose (when the pin includes the message). */
  messageMarkdown?: string;
  /** Previous body before the most recent canvas edit, for one-step Revert.
   *  Stashed by applyCanvasResult right before it overwrites the live body. */
  prevArtifactHtml?: string;
  prevMessageMarkdown?: string;
  /**
   * Review comments left on the note in the canvas editor. Each anchors a
   * passage (verbatim + offset/occurrence fallback) to a free-text
   * instruction. Rendered as highlights in the preview and applied in one
   * pass via the "Apply comments" action; cleared once actioned.
   */
  comments?: NoteComment[];
  /** Embedded transcript copy (when the pin includes a chat snapshot). */
  chatSnapshot?: {
    title: string;
    messages: Array<{
      role: "user" | "assistant" | "system";
      content: string;
      createdAt: number;
    }>;
  };
  /** If true, the notes page renders a link back to /chats/[chatId]. */
  linkToChat?: boolean;
  /**
   * Per-note display preferences applied by the /notes index. Omitted on
   * existing pins (legacy + chat-pin flow) so they render with the original
   * "default" layout.
   *   - "default": full preview (markdown rendered, artifact iframe shown).
   *   - "compact": body is line-clamped; padding tightened.
   *   - "hidden":  only the header row renders; body collapsed behind a
   *               disclosure toggle.
   */
  viewConfig?: {
    display?: "default" | "compact" | "hidden";
  };
  /** Account-level sharing (v10). When true, this note is mirrored to the
   *  server account store. Notes carry their own updatedAt for sync; absent
   *  rows fall back to createdAt. */
  accountShared?: boolean;
  accountSharedAt?: number;
  lastSyncedAt?: number;
  updatedAt?: number;
  /**
   * v12: id of the designer this note was promoted into (the "Convert to
   * App" flow). When set, the notes UI surfaces an "Open app" affordance,
   * the designer/app pages render a "Linked to pinned note" banner, and
   * iterating in the designer writes the new HTML back to `artifactHtml`.
   */
  convertedDesignerId?: string;
  /**
   * v12: persistent public-share token for this note. Once present, the
   * Share dialog re-PUTs to the same Redis key on subsequent shares (and
   * automatic write-backs from a linked designer) so the URL the recipient
   * holds stays alive and updates in place.
   */
  shareToken?: string;
  shareTokenExpiresAt?: number;
};

export async function listPinnedNotes(): Promise<StoredPinnedNote[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDB();
  const tx = db.transaction(PINNED_NOTES, "readonly");
  const all = (await txWait(
    tx.objectStore(PINNED_NOTES).index("createdAt").getAll()
  )) as StoredPinnedNote[];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getPinnedNote(id: string): Promise<StoredPinnedNote | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const db = await openDB();
  const tx = db.transaction(PINNED_NOTES, "readonly");
  return (await txWait(tx.objectStore(PINNED_NOTES).get(id))) as
    | StoredPinnedNote
    | undefined;
}

export async function putPinnedNote(note: StoredPinnedNote): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(PINNED_NOTES, "readwrite");
  tx.objectStore(PINNED_NOTES).put(note);
  await txDone(tx);
  accountSyncHook?.onSave?.({ type: "note", row: note });
}

export async function deletePinnedNote(id: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const tx = db.transaction(PINNED_NOTES, "readwrite");
  tx.objectStore(PINNED_NOTES).delete(id);
  await txDone(tx);
  accountSyncHook?.onDelete?.("note", id);
}

/**
 * Stores included in user-facing backups. Order matters for the readwrite
 * transaction in bulkRestore — IndexedDB locks all named stores up front.
 * Excludes queryCache and pendingQueries (transient/regenerable) and the
 * v6 legacy templates/instances stores (already migrated into designers/apps
 * at v7 upgrade — see top-of-file comment).
 */
export const BACKUPABLE_STORES = [
  MESSAGES,
  CHATS,
  DESIGNERS,
  APPS,
  ARCHIVED_APPS,
  PINNED_NOTES,
  SETTINGS,
] as const;

export type BackupStores = {
  messages: StoredMessage[];
  chats: StoredChat[];
  designers: StoredDesigner[];
  apps: StoredApp[];
  archivedApps: ArchivedApp[];
  pinnedNotes: StoredPinnedNote[];
  settings: Settings | null;
};

export type RestoreCounts = Record<keyof BackupStores, number>;

export type RestoreSummary = {
  mode: "replace" | "merge";
  written: RestoreCounts;
};

/** Snapshot every backupable store in one readonly transaction. */
export async function exportAllStores(): Promise<BackupStores> {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB unavailable");
  }
  const db = await openDB();
  const tx = db.transaction(BACKUPABLE_STORES as unknown as string[], "readonly");
  const [messages, chats, designers, apps, archivedApps, pinnedNotes, settings] =
    await Promise.all([
      txWait(tx.objectStore(MESSAGES).getAll()) as Promise<StoredMessage[]>,
      txWait(tx.objectStore(CHATS).getAll()) as Promise<StoredChat[]>,
      txWait(tx.objectStore(DESIGNERS).getAll()) as Promise<StoredDesigner[]>,
      txWait(tx.objectStore(APPS).getAll()) as Promise<StoredApp[]>,
      txWait(tx.objectStore(ARCHIVED_APPS).getAll()) as Promise<ArchivedApp[]>,
      txWait(tx.objectStore(PINNED_NOTES).getAll()) as Promise<StoredPinnedNote[]>,
      txWait(tx.objectStore(SETTINGS).get(SETTINGS_KEY)) as Promise<Settings | undefined>,
    ]);
  await txDone(tx);
  return {
    messages,
    chats: chats.map(normalizeChatTarget),
    designers,
    apps,
    archivedApps,
    pinnedNotes,
    settings: (settings ?? null) as Settings | null,
  };
}

/**
 * Atomically restore a backup bundle. Replace mode clears each keyed store
 * before writing; merge mode upserts by id. Settings is a singleton — we
 * always overwrite the whole row when the bundle has one.
 *
 * If mode is "replace" and the bundle has no chats but does have messages,
 * we re-seed the DEFAULT_CHAT_ID row so the chat shell renders (parallels
 * the v3 migration above).
 */
export async function bulkRestore(
  bundle: BackupStores,
  mode: "replace" | "merge"
): Promise<RestoreSummary> {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB unavailable");
  }
  const db = await openDB();
  const tx = db.transaction(BACKUPABLE_STORES as unknown as string[], "readwrite");

  const written: RestoreCounts = {
    messages: 0,
    chats: 0,
    designers: 0,
    apps: 0,
    archivedApps: 0,
    pinnedNotes: 0,
    settings: 0,
  };

  const writeKeyed = <T>(
    storeName: string,
    rows: T[],
    counter: keyof RestoreCounts
  ) => {
    const store = tx.objectStore(storeName);
    if (mode === "replace") store.clear();
    for (const row of rows) {
      store.put(row);
      written[counter]++;
    }
  };

  writeKeyed(MESSAGES, bundle.messages, "messages");
  writeKeyed(CHATS, bundle.chats.map(normalizeChatTarget), "chats");
  writeKeyed(DESIGNERS, bundle.designers, "designers");
  writeKeyed(APPS, bundle.apps, "apps");
  writeKeyed(ARCHIVED_APPS, bundle.archivedApps, "archivedApps");
  writeKeyed(PINNED_NOTES, bundle.pinnedNotes ?? [], "pinnedNotes");

  // Settings is a singleton keyed by SETTINGS_KEY (not keyPath) — handled separately.
  const settingsStore = tx.objectStore(SETTINGS);
  if (mode === "replace") settingsStore.clear();
  if (bundle.settings) {
    settingsStore.put(bundle.settings, SETTINGS_KEY);
    written.settings = 1;
  }

  // Re-seed default chat if replace-mode wiped chats but messages still reference it.
  if (
    mode === "replace" &&
    bundle.chats.length === 0 &&
    bundle.messages.length > 0
  ) {
    const now = Date.now();
    tx.objectStore(CHATS).put({
      id: DEFAULT_CHAT_ID,
      title: "Default chat",
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });
    written.chats = 1;
  }

  await txDone(tx);
  return { mode, written };
}
