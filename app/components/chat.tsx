"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ArrowRight, BookOpen, ChevronDown, ChevronUp, Clock, Cloud, Code2, Copy, Download, ExternalLink, Eye, FileText, FlaskConical, Globe, Image as ImageIcon, ListChecks, Loader2, Maximize2, MessageSquare, MoreHorizontal, Paperclip, Pencil, Pin, Plug, RotateCw, Search, Send, Settings2, Share2, Sparkles, Square, Telescope, Terminal, Trash2, Check, Undo2, Users, Volume2, VolumeX, Wand2, Workflow, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ComposerMicButton } from "./composer-mic-button";
import {
  downloadSpeech,
  isSpeechSupported,
  speakMessage,
  stopSpeaking,
  useSpeakingMessageId,
  useSpeechState,
} from "@/app/lib/speech";
import { ShareHtmlDialog } from "./share-html-dialog";
import { useCachedImage } from "@/app/lib/use-cached-image";
import { dbg, isSafeRender } from "@/app/lib/debug-log";
import { exportArtifactImage } from "@/app/lib/export-artifact-image";
import {
  DEFAULT_SETTINGS,
  type ArtifactFiles,
  type AttachedCsv,
  type AttachedFile,
  type AttachedImage,
  type AttachedPdf,
  type BuildIssue,
  type BuildOutcome,
  type ChatTarget,
  type FileChange,
  type MessageAnnotation,
  type ProposedVfs,
  type SelectionAnchor,
  type Settings,
  type McpConnector,
  type FramerAction,
  type NovelLengthClient,
  type NovelOutlineData,
  type NovelOutlineEditPayload,
  type NovelOutlineProgress,
  type NovelOutlineProgressStep,
  type NovelOutlineSearch,
  type MultiResearchPayload,
  type MultiResearchReport,
  type StoredChat,
  type StoredMessage,
  type StructuredResearchPayload,
  type ToolEvent,
  addAnnotation,
  deleteMessage,
  deleteMessagesFrom,
  getChat,
  getMessage,
  loadMessages,
  loadSettings,
  newId,
  putChat,
  putMessage,
  putPinnedNote,
  saveSettings,
  updateAnnotation,
  type StoredPinnedNote,
} from "@/app/db";
import { injectSentinels, selectionToAnchor } from "@/app/lib/annotations/anchor";
import { activeConnectors } from "@/app/lib/mcp/shared";
import { rehypeHighlights } from "@/app/lib/annotations/rehype-highlights";
import {
  CATALOG,
  DEFAULT_ENABLED_MODELS,
  DEFAULT_MODEL,
  KEEP_TAIL_MESSAGES,
  OUTPUT_RESERVE_TOKENS,
  RUNPOD_DEFAULT_MODEL_ID,
  SUMMARIZE_AT,
  TASK_PICKS,
  VISION_DESCRIBER_MODEL,
  burnNote,
  catalogEntry,
  defaultModelMeta,
  modelContextTokens,
  modelSupportsVision,
  taskForModel,
  type CloudModel,
} from "@/app/models";
import { useAvailableModels } from "@/app/lib/use-available-models";
import { RUNPOD_PREFIX } from "@/app/lib/llm/provider";
import { estimateTokens } from "@/app/lib/tokens";
import {
  fileToAttachedPdf,
  formatPdfBytes,
  MAX_PDFS_PER_MESSAGE,
  MAX_PDF_BYTES,
} from "@/app/lib/pdf";
import {
  fileToAttachedCsv,
  formatCsvBytes,
  MAX_CSVS_PER_MESSAGE,
  MAX_CSV_BYTES,
} from "@/app/lib/csv";
import {
  uploadSandboxFile,
  MAX_SANDBOX_FILE_BYTES,
  MAX_SANDBOX_FILES_PER_MESSAGE,
} from "@/app/lib/exec/upload-client";
import { makeWriteScheduler } from "@/app/lib/idb-write";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PaperPill } from "@/app/components/paper-pill";
import { NoteViewer } from "@/app/components/note-viewer";
import { deriveNoteTitle, noteSnippet, searchNotes } from "@/app/lib/note-title";
import { CodeBlock } from "@/app/components/code-block";
import { toast } from "@/app/components/toast";
import { extractFencedCode, looksLikeHtmlArtifact } from "@/app/lib/fenced-code";
import { LiveStatusPill } from "@/app/components/live-status-pill";
import { CouncilEvents, hasCouncilEvents } from "@/app/components/council-events";
import { CouncilFramingCard } from "@/app/components/council-framing-card";
import { ResearchFramingCard } from "@/app/components/research-framing-card";
import { StructuredResearchViewer } from "@/app/components/structured-research-viewer";
import { MultiResearchCard } from "@/app/components/multi-research-card";
import { NovelOutlineCard } from "@/app/components/novel-outline-card";
import { PlanProgressCard } from "@/app/components/plan-progress-card";
import { migrateCouncilSettings } from "@/app/lib/council/situations";
import { SettingsDialog } from "@/app/components/settings-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CardActions,
  type CardActionItem,
} from "@/app/components/card-actions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MessagesSquare, Mic, Plus, User } from "lucide-react";
import { CHAT_PERSONAS, chatPersonaById } from "@/app/lib/chat-personas";

type Props = {
  chatId: string;
  target?: ChatTarget;
  /** Initial model; persisted globally in settings unless onModelChange is provided. */
  initialModel?: string;
  /** Called when the assistant proposes a single-file legacy artifact and the user clicks Save. */
  onSaveHtml?: (html: string, summary: string) => Promise<void> | void;
  /**
   * Chat-mode only: called when the user clicks "Convert to App" on an assistant
   * HTML artifact rendered inline. The handler should seed a new designer + paired
   * app from the html (see `createDesignerAndChatFromHtml`) and return the
   * resulting designer id so the inline render can swap to a "Saved as designer"
   * link. Wire this prop only when `target` is undefined (free-form chat).
   */
  onConvertArtifact?: (
    html: string,
    summary: string
  ) => Promise<{ designerId: string } | void> | { designerId: string } | void;
  /**
   * Called when the user clicks "Pin" on an assistant HTML artifact. Parent
   * should open a dialog that lets the user save the artifact (and optionally
   * the message / chat link / chat copy) into /notes.
   */
  onPinArtifact?: (args: { messageId: string; html: string; summary: string }) => void;
  /**
   * Called when the user clicks "Pin" in an assistant message's action cluster.
   * Parent opens the same dialog scoped to the message prose rather than an
   * artifact.
   */
  onPinMessage?: (args: { messageId: string; markdown: string }) => void;
  /**
   * Called when the assistant proposes a multi-file VFS edit and the user clicks Save.
   * When this prop AND `templateFiles` are provided, the chat sends `responseFormat: "vfs-edit"`
   * and surfaces tool calls + build status instead of the artifact stream parser.
   */
  // Resolves to `false` when the save was genuinely refused (e.g. the note was
  // deleted) so the caller can avoid falsely marking the card "Saved". Any
  // other resolution (void / true) counts as saved. Callers that don't care
  // can keep returning void.
  onSaveVfs?: (proposed: ProposedVfs) => Promise<boolean | void> | boolean | void;
  /** Current persisted VFS the AI should operate on (for vfs-edit mode). */
  templateFiles?: ArtifactFiles;
  /** Current bundle entry (for vfs-edit mode). */
  templateEntry?: string;
  /**
   * Current template version. Stamped onto user messages at send time so the
   * "Revert to here" action can ask the parent to restore that historical VFS.
   */
  templateVersion?: number;
  /**
   * Restore the template's files/entry to the snapshot recorded at `version`.
   * Called by the "Revert to here" action before chat truncation; the chat
   * truncates either way, but skips this call for messages without a recorded
   * `templateVersion` (e.g. messages from before this feature shipped).
   */
  onRevertToVersion?: (version: number) => void | Promise<void>;
  /**
   * Fired by the "Revert to here" action after the source artifact message
   * has been rolled back in IDB (and in Chat's local `messages` state).
   * Lets the chat-artifact-canvas page resync its own `sourceMsg` state so
   * the iframe preview snaps back without waiting for a remount.
   */
  onRevertInlineArtifact?: (sourceMessageId: string) => void;
  /** Live-preview hook: fires while the model streams VFS edits. Parents wire this to ArtifactFrame.pendingFiles. */
  onPendingVfs?: (files: ArtifactFiles | null, entry: string | null) => void;
  /** Runtime error text from the preview iframe. When provided, Chat auto-injects it as a user message. */
  runtimeError?: string;
  /** Called after Chat has consumed the runtimeError prop so the parent can clear it. */
  onRuntimeErrorConsumed?: () => void;
  /** Optional placeholder for the composer. */
  placeholder?: string;
  /** Hide the model picker (e.g. when used in a tight sidebar). */
  hideModelPicker?: boolean;
  /** If provided, model changes are forwarded here instead of being saved to global settings. */
  onModelChange?: (model: string) => void | Promise<void>;
  /**
   * Extra system-prompt context appended after the format-specific instructions.
   * Used by designer mode to inject the CLAUDE.md-style project notes (and
   * any attached pinned notes — see attachedPins) so a fresh chat carries app
   * context without rereading the prior thread. Already composed by the
   * parent via buildExtraSystem in app/lib/extra-system.ts.
   */
  extraSystem?: string;
  /**
   * Hydrated pinned-note rows attached to this chat as ephemeral context.
   * Drives the chip strip above the composer. Add/remove via the paperclip
   * button in the toolbar — parent persists via `onChangeAttachedPins`.
   */
  attachedPins?: StoredPinnedNote[];
  /**
   * Persist a new list of attached pin ids onto the parent's chat row.
   * Receives the full next list (not a diff) so callers can implement
   * add/remove uniformly.
   */
  onChangeAttachedPins?: (nextIds: string[]) => void | Promise<void>;
  /** All chats sharing this designer/target — feeds the chat picker. */
  chats?: StoredChat[];
  /** Switch to a different existing chat (parent re-renders with new chatId). */
  onSelectChat?: (chatId: string) => void;
  /** Start a fresh chat. Parent kicks off any background notes refresh non-blockingly. */
  onNewChat?: () => void | Promise<void>;
  /**
   * Indicator-only: a background notes refresh is in flight. Does NOT disable
   * new-chat or chat selection — that gate was the old, blocking behavior.
   * The picker shows a subtle spinner so the user knows the digest is running.
   */
  newChatBusy?: boolean;
  /**
   * Called when the user taps "View details" on an assistant message's
   * activity chip. Parent should switch the Details panel to the Activity
   * sub-tab and scroll to the matching turn.
   */
  onOpenDetails?: (messageId: string) => void;
  /**
   * One-shot text to seed the composer with on mount. Used by the
   * /designer/{id}?prefill=… route — when the "+ Widget" CTA on /apps/{id}
   * navigates here, we want the input pre-filled so the user only has to
   * hit Send. Cleared via onPrefillConsumed once it's been applied.
   */
  prefillInput?: string | null;
  /** Model to switch this chat to when a prefill arrives (e.g. the app Update
   *  flow forces a tool-capable model so the migration actually edits files
   *  instead of narrating). One-shot alongside prefillInput. */
  prefillModel?: string | null;
  /** When true, the prefill is SENT automatically on mount instead of just
   *  seeding the composer - so "describe an app" immediately starts building
   *  rather than dead-ending on a pre-filled box the user must submit. */
  autoSendPrefill?: boolean;
  /** Fires after Chat has applied prefillInput; parent clears its state. */
  onPrefillConsumed?: () => void;
  /**
   * Mirror chat's message list back to the parent so the Details/Activity
   * view can render the same data without re-reading IndexedDB. Fires after
   * every internal `setMessages`.
   */
  onMessagesChange?: (messages: StoredMessage[]) => void;
  /**
   * note-canvas only: the user's pinned highlight in the preview. When set,
   * the composer shows a chip naming the selection and the send path attaches
   * the anchor to both the wire request (`selection`) and the persisted user
   * message (`selectionAnchor`). Cleared by `onSelectionConsumed` after send
   * so the next message starts unanchored unless the user re-highlights.
   */
  selectionAnchor?: SelectionAnchor | null;
  onSelectionConsumed?: () => void;
  /**
   * Optional actions on the SelectionChip above the composer. When provided,
   * the chip renders Pin/Research buttons next to the highlighted-text
   * preview. The parent owns the selection state (via `selectionAnchor`) and
   * the dialogs these callbacks open — Chat just surfaces the trigger.
   */
  onSelectionPin?: () => void;
  onSelectionResearch?: () => void;
  /**
   * Optional "Comment" action on the SelectionChip. When provided, the chip
   * renders a Comment button that opens the parent's add-comment dialog so
   * the user can leave an anchored review comment on the highlighted passage.
   */
  onSelectionComment?: () => void;
  /**
   * Optional "Diagram" action on the SelectionChip. When provided, the chip
   * renders a Diagram button that asks the assistant to draw a small diagram
   * illustrating the highlighted passage and insert it next to that passage.
   */
  onSelectionDiagram?: () => void;
  /**
   * Skip rendering the per-chat ChatHeader (model picker, web/research
   * toggles, chats picker, compaction button). Used by surfaces like the
   * mobile note canvas where the page-level header already owns title/back
   * and the model rarely needs to be switched mid-edit.
   */
  hideHeader?: boolean;
  /**
   * If set, the mobile ChatHeader bar (sm:hidden variant) is portaled into
   * the DOM element with this id instead of rendering inline at the top of
   * the chat column. Canvas mobile uses this to hoist the model/token chip
   * up under the page header so it doesn't sit between the artifact iframe
   * and the messages list. Desktop ChatHeader still renders inline.
   */
  mobileHeaderHostId?: string;
  /**
   * When true, hide the scrollable messages region entirely and instead
   * render a "{N} messages" toggle pill above the composer (only when
   * `onToggleMessages` is also provided). The streaming indicator hoists
   * into the dock so pending state stays visible. Parent owns the toggle
   * state.
   */
  messagesCollapsed?: boolean;
  /** Toggle handler for the collapsed-messages pill. */
  onToggleMessages?: () => void;
  /**
   * Optional className applied to the wrapper around the attached-pins
   * strip + selection chip + composer trio. Lets the parent attach
   * sticky / safe-area / border styles for a mobile bottom-dock layout
   * without Chat caring about its host's positioning model.
   */
  dockClassName?: string;
  /** Optional label for the selection chip — defaults to the selected text. */
  className?: string;
  sessionMemoryNoteId?: string;
  onSessionMemoryNoteId?: (id: string | undefined) => void;
};

// Per-browser network-failure messages thrown by `fetch` when the connection
// drops mid-flight. iOS Safari is the most user-visible offender: backgrounding
// the tab kills any in-flight stream and the TypeError surfaces as the opaque
// "Load failed" string that gets persisted onto the assistant message.
const NETWORK_ERROR_PATTERNS = [
  "Load failed",                                  // Safari / iOS Safari
  "Failed to fetch",                              // Chrome / Edge
  "NetworkError when attempting to fetch",        // Firefox
  "The network connection was lost",              // iOS edge cases
  "The Internet connection appears to be offline",
  "network error",                                // case-insensitive fallback
  "network request failed",
];

const isNetworkError = (msg: string): boolean => {
  const m = msg.toLowerCase();
  return NETWORK_ERROR_PATTERNS.some((p) => m.includes(p.toLowerCase()));
};

// `msg.error` is TYPED `string`, but at runtime a failure path can persist a
// non-string — most notably a structured `{ code, message }` object from a 413
// (an oversized request). Calling `.toLowerCase()` on that threw
// "e.toLowerCase is not a function" and crashed the ENTIRE transcript render
// ("This page couldn't load" on iOS). Rendering a bare object as a React child
// would throw too. Coerce to a string first so one malformed error can never
// take the whole chat down.
const errorToString = (msg: unknown): string => {
  if (typeof msg === "string") return msg;
  if (msg == null) return "";
  if (typeof msg === "object") {
    const inner = (msg as { message?: unknown }).message;
    if (typeof inner === "string") return inner;
    try {
      return JSON.stringify(msg);
    } catch {
      return String(msg);
    }
  }
  return String(msg);
};

const friendlyError = (msg: unknown): string => {
  const text = errorToString(msg);
  return isNetworkError(text)
    ? "Network error — your last message wasn't delivered. Tap Retry to try again."
    : text;
};

type FramingKind = "research" | "council";

type SingleResultResumePayload<T> = T & {
  /** HTTP status the upstream work function returned (200 / 500 / 502 / 404). */
  status: number;
  error?: string;
};

type FramingResumePayload = SingleResultResumePayload<{
  framing?: {
    rationale?: string;
    questions?: { id: string; question: string; suggestedAnswers?: string[] }[];
  };
  situationId?: string;
  situationLabel?: string;
  actions?: FramerAction[];
}>;

// How long to wait between resume re-fetches when the upstream is still
// computing or the client lost its connection mid-poll. The server endpoint
// long-polls Redis on its end, so a fresh GET right after a network failure
// just reattaches to the same in-flight work.
const RESUME_RECONNECT_DELAY_MS = 2000;

/**
 * Generic long-poll of a single-result resume endpoint
 * (/api/{...}/resume/{streamId}). Survives a phone going to sleep mid-call
 * (the iOS Safari "Load failed" case): on network failure we pause and
 * reconnect to the same streamId — the work is still running server-side
 * because the POST handler stashed it in waitUntil + Redis.
 *
 * Status handling:
 * - 200 / 4xx / 5xx (other than retryable): return as the terminal result.
 * - 401: redirect to /login (the request was unauthenticated).
 * - 202 / 504: treat as "upstream still running" and reopen the poll. The
 *   resume endpoint shouldn't return 202 in normal operation; we retry
 *   defensively in case a CDN / Vercel platform layer (or a cached
 *   handshake response served to the wrong URL by an aggressive client
 *   cache) returns 202 for an in-flight call.
 *
 * 404 means the Redis TTL elapsed or the streamId is bogus — recoverable
 * only by retrying the call fresh, so we surface it to the caller.
 */
async function resolveSingleResultStream<T>(
  url: string,
  signal: AbortSignal
): Promise<SingleResultResumePayload<T>> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    let res: Response;
    try {
      res = await fetch(url, {
        signal,
        // Bypass any intermediate cache that might be replaying a previous
        // (handshake) response for this path. Resume responses are dynamic.
        cache: "no-store",
      });
    } catch (err) {
      if (signal.aborted) throw err;
      const msg = err instanceof Error ? err.message : "network error";
      if (!isNetworkError(msg)) throw err;
      await new Promise((r) => setTimeout(r, RESUME_RECONNECT_DELAY_MS));
      continue;
    }

    if (res.status === 401) {
      window.location.href = "/login";
      throw new DOMException("auth-redirect", "AbortError");
    }
    if (res.status === 504 || res.status === 202) {
      // 504: server-side poll-window timeout. 202: defensive — the resume
      // endpoint never emits 202 itself, but if a platform layer intercepts
      // and returns one we'd rather retry than mis-classify as a result.
      await new Promise((r) => setTimeout(r, RESUME_RECONNECT_DELAY_MS));
      continue;
    }

    const body = (await res.json().catch(() => ({}))) as T;
    return { ...body, status: res.status };
  }
}

// One tick of the streaming framing resume endpoint (?cursor=N): the live
// progress/reasoning events since the cursor, plus the terminal result once
// it lands. See app/lib/single-result-resume.ts:resumeEventStream.
type FramingStreamTick = {
  events?: { event: string; data: unknown }[];
  nextCursor?: number;
  done?: boolean;
  result?: {
    framing?: FramingResumePayload["framing"];
    situationId?: string;
    situationLabel?: string;
    actions?: FramerAction[];
    error?: string;
  };
  resultStatus?: number;
};

/** Turn one streamed framer event into the text chunk the card appends.
 *  Reasoning (`thinking`) flows in verbatim; coarse milestones (`progress`,
 *  e.g. "Searching the web…") get their own line so they read as steps. */
function framingChunkFor(event: string, text: string): string {
  return event === "progress" ? `\n› ${text}\n` : text;
}

/**
 * Stream a framing run: long-poll the resume endpoint with a cursor, pushing
 * the framer's live reasoning + progress to `onProgress` as it arrives, and
 * resolve with the terminal payload once the framer finishes. Replaces the
 * single-shot resolveFramingStream so the card shows the framer working
 * instead of a blank spinner. Same disconnect-resilience as
 * resolveSingleResultStream: a dropped fetch (phone sleep) reconnects to the
 * same streamId and server-side work, re-reading from cursor 0 so the card
 * replays the reasoning it missed.
 */
async function streamFramingProgress(
  streamId: string,
  kind: FramingKind,
  signal: AbortSignal,
  onProgress: (text: string) => void
): Promise<FramingResumePayload> {
  let cursor = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    let res: Response;
    try {
      res = await fetch(
        `/api/${kind}/framing/resume/${encodeURIComponent(streamId)}?cursor=${cursor}`,
        { signal, cache: "no-store" }
      );
    } catch (err) {
      if (signal.aborted) throw err;
      const msg = err instanceof Error ? err.message : "network error";
      if (!isNetworkError(msg)) throw err;
      await new Promise((r) => setTimeout(r, RESUME_RECONNECT_DELAY_MS));
      continue;
    }

    if (res.status === 401) {
      window.location.href = "/login";
      throw new DOMException("auth-redirect", "AbortError");
    }
    if (res.status === 504 || res.status === 202) {
      await new Promise((r) => setTimeout(r, RESUME_RECONNECT_DELAY_MS));
      continue;
    }

    const body = (await res.json().catch(() => ({}))) as FramingStreamTick;
    if (Array.isArray(body.events)) {
      for (const ev of body.events) {
        const data = ev?.data as { text?: unknown } | undefined;
        const text = typeof data?.text === "string" ? data.text : "";
        if (text) onProgress(framingChunkFor(ev.event, text));
      }
    }
    if (typeof body.nextCursor === "number") cursor = body.nextCursor;
    if (body.done) {
      return { ...(body.result ?? {}), status: body.resultStatus ?? 200 };
    }
    // Idle tick (server already long-polled with no new events) — brief pause
    // so the empty-tick path can't become a hot loop.
    if (!body.events || body.events.length === 0) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

type NovelOutlineResumePayload = SingleResultResumePayload<{
  outline?: NovelOutlineData;
  researchNote?: string | null;
  searches?: NovelOutlineSearch[];
}>;

function resolveNovelOutlineStream(
  streamId: string,
  signal: AbortSignal
): Promise<NovelOutlineResumePayload> {
  return resolveSingleResultStream(
    `/api/novel/outline/resume/${encodeURIComponent(streamId)}`,
    signal
  );
}

const responseFormatFor = (target: ChatTarget | undefined, hasVfs: boolean) => {
  if (target?.kind === "designer" && target.mode === "edit") {
    return hasVfs ? "vfs-edit" : "html-doc";
  }
  if (target?.kind === "note-canvas") {
    // The canvas page passes the note body as a single-file `templateFiles`
    // (+ `templateEntry`). If those aren't wired (caller bug), fall back to
    // chat mode so we don't hit the server with an invalid note-edit body.
    return hasVfs ? "note-edit" : "chat";
  }
  if (target?.kind === "chat-artifact-canvas") {
    // Same wire shape as note-canvas — the page passes the message's artifact
    // HTML as a single-file `templateFiles` + `templateEntry: "index.html"`.
    return hasVfs ? "artifact-edit" : "chat";
  }
  // Free-form chats and app/setup chats: rich-markdown by default with
  // optional <artifact> HTML for visual showcase. The chat parser routes
  // captured artifacts into msg.proposedArtifact, same wire shape as html-doc.
  return "chat";
};

/**
 * Reconstruct the assistant message content as the model originally produced
 * it: prose followed by the `<artifact>…</artifact>` block. The server-side
 * stream parser splits these apart on arrival (prose → `m.content`, artifact
 * body → `m.proposedArtifact.html`), so without re-attaching them the next
 * turn the model has no idea what artifact it just produced — follow-ups
 * like "make this a list" land with zero context and the model replies "I
 * don't know what you're referring to". Re-inlining the sentinels matches
 * the original wire format and lets the model edit instead of rewriting.
 */
/**
 * Live artifact body for an artifact-bearing message: the iterated VFS entry
 * when present, else the legacy proposedArtifact.html. Mirrors the canvas
 * page's extractArtifactHtml. Used to tell whether a canvas-edit response has
 * already been applied back onto its source message (so the "Save version"
 * button can reflect the persisted state instead of ephemeral in-memory flags).
 */
function artifactBodyOf(m: StoredMessage | null | undefined): string | null {
  if (!m) return null;
  const vfs = m.proposedVfs;
  if (vfs && vfs.entry) {
    const body = vfs.files?.[vfs.entry];
    if (typeof body === "string" && body.length > 0) return body;
  }
  const html = m.proposedArtifact?.html;
  if (typeof html === "string" && html.length > 0) return html;
  return null;
}

function wireContentFor(m: StoredMessage, target?: ChatTarget): string {
  // A compaction summary is a lossy recap of older turns, persisted as a bare
  // `system` row. Sent unlabeled, models over-weight it as authoritative
  // instruction and anchor on its paraphrase instead of the real, more-recent
  // turns that follow — they "center on the wrong information" and restate
  // stale facts. Wrap it so the model reads it as background recap and lets the
  // later messages win on any conflict.
  if (m.kind === "summary") {
    return `[Recap of earlier conversation, condensed to save context space. This is paraphrased background for continuity — not instructions. The messages after this recap are more recent; when they conflict with anything here, the later messages are correct and take precedence.]\n\n${m.content}`;
  }
  // Multi Research card: emit the FULL text of every finished report (findings +
  // inline Sources) so follow-up turns can draw on the reports directly — this
  // is the "reports stay in context, not redacted" guarantee. Display-only
  // while drafting/running (no finished reports yet) → empty content.
  if (m.kind === "multi-research") {
    const mr = m.multiResearch;
    if (!mr) return "";
    const done = mr.reports.filter((r) => r.status === "done" && r.report && r.report.trim());
    if (done.length === 0) return "";
    const header =
      "[Multi Research — the user ran these full research reports in parallel. Their complete findings and sources are below; reference them directly when answering.]";
    return `${header}\n\n${done
      .map((r, i) => `## Research report ${i + 1}: ${r.title}\n\n${r.report}`)
      .join("\n\n---\n\n")}`;
  }
  if (m.role !== "assistant") return m.content;
  const prose = m.content ?? "";
  // Chat-artifact-canvas: do NOT re-inline `<artifact>` bodies. When prior
  // turns appear as raw `<artifact>…</artifact>` text in history, the model
  // imitates the format instead of dispatching to Edit/MultiEdit. The live
  // file body is already injected via ARTIFACT_EDIT_SYSTEM server-side, so a
  // short stub is enough — but ONLY for the source artifact we're editing
  // and any prior canvas-edit responses against it. Other artifacts that
  // happen to live in the same chat aren't `index.html` for this edit
  // session, so labeling them "index.html updated" would mislead the model
  // into thinking it has been editing this file across unrelated turns.
  if (target?.kind === "chat-artifact-canvas") {
    const hasArtifact =
      !!m.proposedArtifact?.html ||
      !!(m.proposedVfs && !m.proposedVfs.streaming && m.proposedVfs.entry);
    if (!hasArtifact) return prose;
    const isTargetSource = m.id === target.messageId;
    const editsTarget = m.editsArtifactMessageId === target.messageId;
    if (!isTargetSource && !editsTarget) return prose;
    const sep = !prose || prose.endsWith("\n") ? "" : "\n";
    return `${prose}${sep}[index.html updated — call Read("index.html") to see current contents]`;
  }
  // Note-canvas (note-edit): same rationale as chat-artifact-canvas above.
  // Re-inlining a prior edit as raw <artifact>...</artifact> text trains the
  // model to ANSWER in that format - dumping the whole note back instead of
  // calling Edit/MultiEdit. The live note body is already injected
  // server-side via NOTE_EDIT_SYSTEM, so a stub pointing at the file gives
  // the follow-up all the context it needs.
  if (target?.kind === "note-canvas") {
    const editedEntry =
      m.proposedVfs && !m.proposedVfs.streaming && m.proposedVfs.entry
        ? m.proposedVfs.entry
        : null;
    if (!editedEntry && !m.proposedArtifact?.html) return prose;
    const path = editedEntry ?? "the note";
    const sep = !prose || prose.endsWith("\n") ? "" : "\n";
    return `${prose}${sep}[${path} updated - call Read("${path}") to see current contents]`;
  }
  const artifact = m.proposedArtifact;
  if (artifact && artifact.html && !artifact.streaming) {
    const sep = !prose || prose.endsWith("\n") ? "" : "\n";
    return `${prose}${sep}<artifact>\n${artifact.html}\n</artifact>`;
  }
  // Canvas-mode iteration: the message has no `proposedArtifact` (it's a
  // VFS edit result), but the VFS body IS the artifact. Re-inline it so a
  // subsequent non-canvas turn after the user exits canvas still has the
  // current artifact in context.
  const vfs = m.proposedVfs;
  if (vfs && !vfs.streaming && vfs.entry) {
    const body = vfs.files?.[vfs.entry];
    if (typeof body === "string" && body.length > 0) {
      const sep = !prose || prose.endsWith("\n") ? "" : "\n";
      return `${prose}${sep}<artifact>\n${body}\n</artifact>`;
    }
  }
  return prose;
}

/**
 * Wire form of a stored message for an /api/chat send: text content PLUS the
 * message's OWN attachments. Earlier turns' images/PDFs/CSVs must be re-sent on
 * every turn — the server inlines attachments per message, but the client used
 * to attach them only to the current message, so anything shared in a prior
 * turn silently vanished from the model's context. That's the "highly capable
 * model forgets the file I shared earlier / hallucinates its contents" bug: not
 * summarization, just history sent without its attachments. Re-attaching each
 * message's own files keeps the full multimodal history in context.
 */
function wireMsgFor(m: StoredMessage, target?: ChatTarget) {
  const msg: {
    role: StoredMessage["role"];
    content: string;
    images?: { id: string; dataUrl: string; mime: string; name?: string; description?: string }[];
    pdfs?: { id: string; name: string; pageCount: number; text: string; truncated?: boolean }[];
    csvs?: {
      id: string;
      name: string;
      rowCount: number;
      columnCount: number;
      text: string;
      truncated?: boolean;
    }[];
    files?: StoredMessage["files"];
  } = { role: m.role, content: wireContentFor(m, target) };
  if (m.images?.length) {
    msg.images = m.images.map((im) => ({
      id: im.id,
      dataUrl: im.dataUrl,
      mime: im.mime,
      name: im.name,
      // Cached describer caption (text-only models). Sending it lets the server
      // skip re-describing this image — the per-turn re-describe fix.
      ...(im.description ? { description: im.description } : {}),
    }));
  }
  if (m.pdfs?.length) {
    msg.pdfs = m.pdfs.map((p) => ({
      id: p.id,
      name: p.name,
      pageCount: p.pageCount,
      text: p.text,
      truncated: p.truncated,
    }));
  }
  if (m.csvs?.length) {
    msg.csvs = m.csvs.map((c) => ({
      id: c.id,
      name: c.name,
      rowCount: c.rowCount,
      columnCount: c.columnCount,
      text: c.text,
      truncated: c.truncated,
    }));
  }
  // Sandbox files are pointers (blob URLs), not bytes — they already rode every
  // turn that had them so run_code can reference a file attached earlier.
  if (m.files?.length) {
    msg.files = m.files;
  }
  return msg;
}

/**
 * Image-describer settings sent on every /api/chat request so the server
 * captions images for a text-only main model with the user's chosen vision
 * model + detail level (Preferences → Tools → Image description). Both fields
 * are omitted when unset so the server falls back to its built-in defaults.
 */
function describerWire(settings: Settings): {
  describerModel?: string;
  describeDetail?: "concise" | "standard" | "detailed";
} {
  const out: {
    describerModel?: string;
    describeDetail?: "concise" | "standard" | "detailed";
  } = {};
  if (settings.describerModel?.trim()) out.describerModel = settings.describerModel.trim();
  if (settings.describeDetail) out.describeDetail = settings.describeDetail;
  return out;
}

// Rough vision token cost per image (providers differ; Claude ~1.5k for a large
// image, OpenAI tiles ~85–765). A conservative flat estimate is enough for the
// compaction budget — its only job is to trip summarization before we overflow.
const PER_IMAGE_TOKENS = 1200;

/**
 * Wire-token estimate that ALSO counts attachments. The plain text estimate
 * undercounts attachment-heavy chats — and since we now re-send every prior
 * turn's images/PDFs/CSVs, a long chat with files could blow past the context
 * window without ever tripping compaction. Counting attachment tokens here is
 * what keeps long chats bounded: compaction fires, the oldest turns (and their
 * attachments) fold into a text recap and drop off the wire.
 */
function estimateStoredTokens(msgs: StoredMessage[]): number {
  let total = 0;
  for (const m of msgs) {
    total += estimateTokens(wireContentFor(m)) + 4;
    if (m.images?.length) total += m.images.length * PER_IMAGE_TOKENS;
    for (const p of m.pdfs ?? []) total += estimateTokens(p.text ?? "");
    for (const c of m.csvs ?? []) total += estimateTokens(c.text ?? "");
  }
  return total;
}

/**
 * Cold-resume primer for a plan-paused / stalled assistant bubble whose
 * server-side scratchpad is gone (TTL'd out, or never registered because the
 * conversation is older than the resumable-stream window). We can't splice
 * back into the original worker — there is no original worker. Instead we hand
 * /api/chat a synthesized `continueAssistantContent` that reads like the
 * model's own prior output, so a fresh plan-mode turn picks up from the next
 * un-done step instead of re-planning from scratch.
 *
 * We rehydrate as much state as we still have on the bubble: any partial
 * prose, the most recent thinking trace, and the per-step status/summary
 * roll-up. The plan card itself stays mounted on the bubble across the
 * continuation, so the user keeps the visual progress indicator while the
 * model's new prose appends below.
 */
function synthesizePlanResumePartial(m: StoredMessage): string {
  const plan = m.plan;
  if (!plan) return m.content ?? "";
  const prose = (m.content ?? "").trim();
  const thinking = (m.thinking ?? "").trim();
  const done = plan.steps.filter((s) => s.status === "done").length;
  const total = plan.steps.length;
  const resumeIdx = plan.pausedAt
    ? plan.steps.findIndex((s) => s.id === plan.pausedAt)
    : plan.steps.findIndex((s) => s.status !== "done");
  const lines: string[] = [];
  if (prose) lines.push(prose, "");
  if (thinking) {
    lines.push("[Prior reasoning]", thinking, "");
  }
  lines.push(`[Plan recap — ${done}/${total} complete · ${plan.brief}]`);
  plan.steps.forEach((s, i) => {
    const mark =
      s.status === "done"
        ? "[x]"
        : i === resumeIdx
          ? "[>]"
          : s.status === "errored"
            ? "[!]"
            : "[ ]";
    const summary = s.summary?.trim() ? ` — ${s.summary.trim()}` : "";
    lines.push(`${mark} ${i + 1}. ${s.title}${summary}`);
  });
  if (resumeIdx >= 0) {
    const next = plan.steps[resumeIdx];
    lines.push(
      "",
      `Resuming the plan from step ${resumeIdx + 1}: ${next.title}. The previous worker was killed mid-handoff; cached step results above are authoritative — do not redo completed steps.`
    );
  } else {
    lines.push("", "Resuming the plan from where it left off.");
  }
  return lines.join("\n");
}

/**
 * Roll up an in-flight tool-event log into a list of FileChange entries,
 * one per touched file. We can't compute exact +n -m line counts during
 * streaming (we don't carry the pre-edit content), so we leave them undefined
 * and the message bubble shows op markers without diff badges until the
 * `vfs_final` arrives with authoritative ops.
 */
function opsFromEvents(events: ToolEvent[]): FileChange[] {
  const seen = new Map<string, FileChange["op"]>();
  for (const e of events) {
    if (e.kind !== "call") continue;
    const name = e.name;
    const filePath = typeof e.args?.file_path === "string" ? (e.args.file_path as string) : null;
    if (!filePath) continue;
    if (name === "Write") seen.set(filePath, seen.get(filePath) === "edit" ? "edit" : "write");
    else if (name === "Edit" || name === "MultiEdit") seen.set(filePath, "edit");
    else if (name === "Delete") seen.set(filePath, "delete");
  }
  return [...seen.entries()].map(([path, op]) => ({ path, op }));
}

/** Max edge length for the resized image we persist + send. Kept modest so a
 *  single chat doesn't blow IndexedDB or eat the wire payload. */
const MAX_IMAGE_EDGE = 1024;
const MAX_IMAGES_PER_MESSAGE = 4;

// Stable empty references so passing "no connectors configured" into the chat
// header doesn't create a fresh array each render (which would defeat memo).
const EMPTY_CONNECTORS: McpConnector[] = [];
const EMPTY_IDS: string[] = [];

/** Best-effort host label for a connector URL (falls back to the raw string). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Read a File and downscale to ≤MAX_IMAGE_EDGE on the longest side, returning
 * a JPEG data URL. iPhone HEIC is a problem case — Safari decodes it via
 * <img> just fine, so we draw to a canvas and re-encode as JPEG to guarantee
/** Human-readable byte size for sandbox file chips (B / KB / MB). */
function formatFileBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * downstream compatibility (Ollama wants JPEG/PNG/WebP).
 */
async function fileToResizedImage(file: File): Promise<AttachedImage> {
  const original = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error ?? new Error("failed to read file"));
    fr.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("failed to decode image"));
    el.src = original;
  });

  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = longest > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / longest : 1;
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  // Approximate decoded byte count from the base64 length.
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bytes = Math.floor((b64.length * 3) / 4);

  return {
    id: newId(),
    dataUrl,
    mime: "image/jpeg",
    name: file.name,
    bytes,
  };
}

type ProgressInfo = {
  messageId: string;
  phase: "sending" | "thinking" | "tool" | "streaming";
  toolName?: string;
  startedAt: number;
  /** Timestamp of the most recent SSE event observed on this stream. Touched
   *  by `consumeChatStream` after every server-emitted block so a client-side
   *  stall detector can surface a Continue button when the worker goes quiet
   *  (Vercel maxDuration hit mid-step, Redis-resume idle, etc.) without the
   *  graceful plan_paused / error event ever firing. Falls back to startedAt
   *  when absent. */
  lastEventAt?: number;
};

type WriteScheduler = {
  schedule: (key: string, item: StoredMessage) => void;
  flushNow: () => void;
};

type ConsumeStreamOpts = {
  body: ReadableStream<Uint8Array>;
  assistantMsg: StoredMessage;
  hasVfs: boolean;
  target?: ChatTarget;
  templateFiles?: ArtifactFiles;
  templateEntry?: string;
  setMessages: React.Dispatch<React.SetStateAction<StoredMessage[]>>;
  setProgress: React.Dispatch<React.SetStateAction<ProgressInfo | null>>;
  writer: WriteScheduler;
  onPendingVfs?: (files: ArtifactFiles | null, entry: string | null) => void;
};

type ConsumeStreamResult = {
  aborted: boolean;
  error?: string;
  done: boolean;
  finalMsg: StoredMessage;
  /**
   * Set when the SSE stream broke after the server emitted `stream_id` but
   * before `done` arrived. The server-side LLM call is still running into
   * Redis; the caller should let the auto-resume effect reconnect rather
   * than treating the message as terminally errored.
   */
  resumable?: boolean;
  /**
   * Set when the SSE error event was tagged transient by the server (Ollama
   * Cloud edge blip, dead-producer detection, etc.). The caller should
   * silently auto-retry up to a small budget instead of forcing the user to
   * tap Retry.
   */
  transient?: boolean;
};

/**
 * Drives an SSE stream (from POST /api/chat or GET /api/chat/resume/{id})
 * forward, mutating `assistantMsg` into its final state and persisting on
 * every event via the RAF write scheduler.
 *
 * Initial state is read from the passed `assistantMsg` so this works for both
 * fresh sends (empty message) and resumes (partial content already in IDB).
 */
async function consumeChatStream(opts: ConsumeStreamOpts): Promise<ConsumeStreamResult> {
  const {
    body,
    assistantMsg,
    hasVfs,
    target,
    templateFiles,
    templateEntry,
    setMessages,
    setProgress,
    writer,
    onPendingVfs,
  } = opts;

  // The "active assistant" we're currently routing deltas / tool events into.
  // Starts as the message the caller passed in; flips to a freshly-inserted
  // message when an `assistant_turn` SSE event arrives (queued follow-up
  // turns get their own assistant bubble within the same stream).
  let currentAssistantId = assistantMsg.id;
  let currentAssistantBase: StoredMessage = assistantMsg;

  let assistantContent = assistantMsg.content;
  let assistantThinking = assistantMsg.thinking ?? "";
  let artifactHtml = assistantMsg.proposedArtifact?.html ?? "";
  let artifactStreaming = assistantMsg.proposedArtifact?.streaming === true;
  let artifactComplete = !!assistantMsg.proposedArtifact && !artifactStreaming;
  let artifactSummary = assistantMsg.proposedArtifact?.summary ?? "";
  let assistantUsage: StoredMessage["usage"] = assistantMsg.usage;
  let assistantError: string | undefined = assistantMsg.error;
  let assistantErrorTransient = false;
  let events: ToolEvent[] = assistantMsg.events ? [...assistantMsg.events] : [];
  // Files produced by run_code during this turn, accumulated from
  // `files_produced` SSE events and persisted on the assistant message so the
  // download chips survive reload (and feed the next turn's run_code).
  let producedFiles: AttachedFile[] = assistantMsg.files ? [...assistantMsg.files] : [];
  // Plan-mode state. Populated incrementally as plan_* SSE events arrive.
  // When a plan_paused event fires we set pausedAt so the row's Continue
  // button routes to /api/chat/plan-continue/{streamId} instead of the
  // generic re-POST-to-/api/chat path.
  let assistantPlan: StoredMessage["plan"] | undefined = assistantMsg.plan
    ? { ...assistantMsg.plan, steps: assistantMsg.plan.steps.map((s) => ({ ...s })) }
    : undefined;

  let streamId: string | undefined = assistantMsg.streamId;
  let streamCursor: number = assistantMsg.streamCursor ?? 0;
  let sawDone = false;
  let lastSnapshot: StoredMessage = assistantMsg;

  // Note-edit (canvas) mode reuses the same wire shape as vfs-edit — single
  // file, file_changed deltas, vfs_final — so it needs identical client-side
  // streaming state. Without this, file_changed events arrive but pendingFiles
  // stays null and the live preview never updates. Chat-artifact-canvas
  // (target.kind === "chat-artifact-canvas") follows the same wire shape: the
  // owning page passes the message's artifact HTML as templateFiles +
  // templateEntry, exactly like the note-canvas page does.
  const streamFormat = responseFormatFor(target, hasVfs);
  const usingVfs =
    hasVfs &&
    (streamFormat === "vfs-edit" ||
      streamFormat === "note-edit" ||
      streamFormat === "artifact-edit");
  let pendingFiles: ArtifactFiles | null = usingVfs
    ? assistantMsg.proposedVfs?.files ?? { ...(templateFiles ?? {}) }
    : null;
  let pendingEntry: string | null = usingVfs
    ? assistantMsg.proposedVfs?.entry ?? templateEntry ?? null
    : null;
  let vfsStreaming = usingVfs && (assistantMsg.proposedVfs?.streaming ?? true);
  let vfsFinal: ProposedVfs | null =
    assistantMsg.proposedVfs && assistantMsg.proposedVfs.streaming === false
      ? assistantMsg.proposedVfs
      : null;
  let vfsBuild: BuildOutcome | undefined = assistantMsg.proposedVfs?.build;

  // Build the message snapshot from current local state and apply it. Pulled
  // out of `flush` so the RAF-debounced and the sync paths share one body.
  const applySnapshot = () => {
    const proposed =
      artifactComplete || artifactStreaming
        ? { html: artifactHtml, summary: artifactSummary, streaming: !artifactComplete }
        : undefined;
    // Only surface the VFS card once something concrete has happened — a file
    // was actually written/edited/deleted, or the build ran. Read calls alone
    // would otherwise produce a misleading "Editing files · 0 files touched"
    // pill while the agent is just exploring the template.
    const liveOps = usingVfs ? opsFromEvents(events) : [];
    const proposedVfs: ProposedVfs | undefined = vfsFinal
      ? vfsFinal
      : usingVfs && pendingFiles && pendingEntry && (liveOps.length > 0 || vfsBuild)
        ? {
            files: pendingFiles,
            entry: pendingEntry,
            summary: "",
            ops: liveOps,
            build: vfsBuild,
            streaming: vfsStreaming,
          }
        : undefined;
    const updated: StoredMessage = {
      ...currentAssistantBase,
      content: assistantContent,
      thinking: assistantThinking || undefined,
      proposedArtifact: proposed,
      proposedVfs,
      usage: assistantUsage,
      error: assistantError,
      events: events.length ? [...events] : undefined,
      files: producedFiles.length ? [...producedFiles] : undefined,
      plan: assistantPlan
        ? { ...assistantPlan, steps: assistantPlan.steps.map((s) => ({ ...s })) }
        : undefined,
      // Keep streamId/cursor on the message until the stream is observed to
      // finish — that way a tab close mid-stream leaves enough breadcrumb in
      // IndexedDB for the next mount to call resumeStream(). We also keep them
      // when the stream errored so the Continue button can re-launch against
      // the same scratchpad without losing the worker's cached intermediate
      // work (council member positions, research briefs).
      streamId: sawDone && !assistantError ? undefined : streamId,
      streamCursor: sawDone && !assistantError ? undefined : streamCursor,
    };
    lastSnapshot = updated;
    setMessages((prev) => prev.map((m) => (m.id === currentAssistantId ? updated : m)));
    writer.schedule(currentAssistantId, updated);
  };

  // Coalesce React state updates within a single animation frame. Without
  // this, a resume drain that replays thousands of buffered delta events
  // forces one re-render per token and the catch-up paces visually like the
  // original stream. With it, bursts collapse to ~60 renders/sec; live
  // streaming still updates every frame so it looks identical.
  let rafHandle: number | null = null;
  const hasRaf = typeof requestAnimationFrame !== "undefined";
  const cancelRaf = () => {
    if (rafHandle === null) return;
    if (hasRaf) cancelAnimationFrame(rafHandle);
    else clearTimeout(rafHandle as unknown as number);
    rafHandle = null;
  };
  const flush = () => {
    if (rafHandle !== null) return;
    const run = () => {
      rafHandle = null;
      applySnapshot();
    };
    rafHandle = hasRaf
      ? requestAnimationFrame(run)
      : (setTimeout(run, 16) as unknown as number);
  };
  // Terminal events (done/error) and the stream-end paths must reflect
  // immediately — the user expects the final state visible the moment the
  // stream closes, not one frame later.
  const flushSync = () => {
    cancelRaf();
    applySnapshot();
  };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        let event = "message";
        const dataLines: string[] = [];
        for (const rawLine of block.split("\n")) {
          if (rawLine.startsWith(":")) continue;
          if (rawLine.startsWith("event:")) event = rawLine.slice(6).trim();
          else if (rawLine.startsWith("data:")) dataLines.push(rawLine.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(dataLines.join("\n"));
        } catch {
          continue;
        }

        // The first event from the server tells us the resume key. We capture
        // it but don't increment streamCursor — the cursor counts events that
        // appear in the Redis-backed event log past the meta envelope.
        if (event === "stream_id") {
          if (typeof data.id === "string") streamId = data.id;
          flush();
          continue;
        }

        // Every subsequent event advances the cursor 1:1 with the server-side
        // Redis list. Resume picks up at this index.
        streamCursor += 1;

        // Touch lastEventAt on every received block so the parent's stall
        // detector can surface a manual Continue affordance when the worker
        // goes silent (no plan_paused / error event arriving). Cheap — one
        // shallow merge per event into the existing progress object.
        setProgress((p) =>
          p && p.messageId === currentAssistantId
            ? { ...p, lastEventAt: Date.now() }
            : p
        );

        if (event === "user_turn") {
          // Server is echoing a queued user message back into the stream so
          // we can reconcile (or insert) the optimistic copy before the
          // matching assistant_turn fires. mergedIds covers the coalesce
          // case: the server merged several queued sends into one user
          // turn, and the siblings (whose drafts are now subsumed) should
          // disappear.
          const userId = typeof data.id === "string" ? data.id : null;
          const userContent =
            typeof data.content === "string" ? data.content : "";
          const userCreatedAt =
            typeof data.createdAt === "number" ? data.createdAt : Date.now();
          const mergedIds = Array.isArray(data.mergedIds)
            ? (data.mergedIds as string[])
            : userId
              ? [userId]
              : [];
          if (userId) {
            const mergedSet = new Set(mergedIds);
            mergedSet.add(userId);
            setMessages((prev) => {
              const hasPrimary = prev.some((m) => m.id === userId);
              const next: StoredMessage[] = [];
              for (const m of prev) {
                if (m.id === userId) {
                  const reconciled: StoredMessage = {
                    ...m,
                    content: userContent || m.content,
                    createdAt: userCreatedAt,
                    queued: false,
                  };
                  writer.schedule(reconciled.id, reconciled);
                  next.push(reconciled);
                } else if (mergedSet.has(m.id)) {
                  // Sibling that got coalesced into the primary; drop it.
                  void deleteMessage(m.id).catch(() => {});
                } else {
                  next.push(m);
                }
              }
              if (!hasPrimary) {
                // No optimistic copy locally (e.g. queued POST happened in
                // a different tab, or this client just reloaded). Insert a
                // fresh user bubble so the conversation reads correctly.
                const inserted: StoredMessage = {
                  id: userId,
                  chatId: assistantMsg.chatId,
                  role: "user",
                  content: userContent,
                  createdAt: userCreatedAt,
                };
                writer.schedule(inserted.id, inserted);
                next.push(inserted);
              }
              return next;
            });
          }
          flush();
          continue;
        }

        if (event === "assistant_turn") {
          // The server has accepted a queued user message and is about to
          // start a fresh assistant response for it. Finalize the current
          // bubble's snapshot, then switch our local state to a freshly-
          // inserted assistant message so subsequent deltas / tool / vfs
          // events on this same SSE stream attribute to the new bubble.
          const newAssistantId =
            typeof data.id === "string" ? data.id : null;
          const newCreatedAt =
            typeof data.createdAt === "number" ? data.createdAt : Date.now();
          const newModel =
            typeof data.model === "string" ? data.model : assistantMsg.model;
          if (newAssistantId) {
            // Persist whatever the previous assistant produced. After this,
            // its streamId stays cleared (sawDone is local to this consumer
            // — but the *prior* bubble is no longer the live one, so we
            // explicitly drop streamId on its snapshot below).
            flushSync();
            // Close out the prior bubble: its streaming is done, but the
            // overall stream isn't — drop streamId so a tab close mid-NEXT
            // turn doesn't re-attach the old bubble. The new bubble inherits
            // the in-flight streamId.
            setMessages((prev) =>
              prev.map((m) =>
                m.id === currentAssistantId
                  ? { ...m, streamId: undefined, streamCursor: undefined }
                  : m
              )
            );
            // Reset all per-turn working state.
            assistantContent = "";
            assistantThinking = "";
            artifactHtml = "";
            artifactStreaming = false;
            artifactComplete = false;
            artifactSummary = "";
            assistantUsage = undefined;
            assistantError = undefined;
            assistantErrorTransient = false;
            events = [];
            // VFS state resets per turn — the next response edits files
            // starting from the same template baseline.
            pendingFiles = usingVfs ? { ...(templateFiles ?? {}) } : null;
            pendingEntry = usingVfs ? templateEntry ?? null : null;
            vfsStreaming = usingVfs;
            vfsFinal = null;
            vfsBuild = undefined;
            // Build and insert the new assistant bubble.
            const newBase: StoredMessage = {
              id: newAssistantId,
              chatId: assistantMsg.chatId,
              role: "assistant",
              content: "",
              createdAt: newCreatedAt,
              model: newModel,
              events: [],
              streamId,
              streamCursor,
            };
            currentAssistantId = newAssistantId;
            currentAssistantBase = newBase;
            lastSnapshot = newBase;
            setMessages((prev) => [...prev, newBase]);
            writer.schedule(newAssistantId, newBase);
            // Move the progress indicator to the new bubble.
            setProgress((p) =>
              p
                ? {
                    ...p,
                    messageId: newAssistantId,
                    phase: "thinking",
                    startedAt: Date.now(),
                    toolName: undefined,
                  }
                : p
            );
          }
          flush();
          continue;
        }

        if (event === "delta" && typeof data.text === "string") {
          assistantContent += data.text;
          setProgress((p) =>
            p && p.messageId === currentAssistantId ? { ...p, phase: "streaming" } : p
          );
          flush();
        } else if (event === "thinking" && typeof data.text === "string") {
          assistantThinking += data.text;
          setProgress((p) =>
            p && p.messageId === currentAssistantId && p.phase !== "streaming"
              ? { ...p, phase: "thinking" }
              : p
          );
          flush();
        } else if (event === "usage") {
          assistantUsage = data as unknown as StoredMessage["usage"];
          flush();
        } else if (event === "image_mode") {
          // Surface "native" / "described" as a leading tool-event row so the
          // user sees which path their attached images took before any model
          // output streams in.
          const mode = data.mode === "described" ? "described" : "native";
          const main = typeof data.mainModel === "string" ? data.mainModel : "";
          const describer = typeof data.describer === "string" ? data.describer : "";
          const summary =
            mode === "native"
              ? `Sent images directly to ${typeof data.model === "string" ? data.model : "model"}`
              : `Describing images with ${describer}, then sending text to ${main}`;
          events.push({
            kind: "call",
            name: mode === "native" ? "image_native" : "image_describe_mode",
            args: data as Record<string, unknown>,
            at: Date.now(),
          });
          events.push({
            kind: "result",
            name: mode === "native" ? "image_native" : "image_describe_mode",
            summary,
            at: Date.now(),
          });
          flush();
        } else if (event === "tool_call") {
          const name = String(data.name ?? "");
          events.push({
            kind: "call",
            name,
            args: (data.args as Record<string, unknown>) ?? {},
            at: Date.now(),
          });
          setProgress((p) =>
            p && p.messageId === currentAssistantId ? { ...p, phase: "tool", toolName: name } : p
          );
          flush();
        } else if (event === "tool_result") {
          events.push({
            kind: "result",
            name: String(data.name ?? ""),
            summary: typeof data.summary === "string" ? data.summary : undefined,
            error: typeof data.error === "string" ? data.error : undefined,
            at: Date.now(),
          });
          // Cache a fresh image caption back onto its user message (keyed by the
          // image's stable id, which the server echoes). On later turns
          // wireMsgFor sends this caption as text so the server skips
          // re-describing — the durable, client-side fix for the per-turn
          // re-describe. Update React state (so the next in-session send carries
          // it) and persist to IndexedDB via the same write scheduler.
          if (
            data.name === "describe_image" &&
            typeof data.imageId === "string" &&
            data.imageId &&
            typeof data.description === "string" &&
            data.description.trim()
          ) {
            const imageId = data.imageId;
            const caption = data.description;
            setMessages((prev) => {
              const idx = prev.findIndex((m) =>
                m.images?.some((im) => im.id === imageId && !im.description)
              );
              if (idx === -1) return prev;
              const m = prev[idx];
              const updated: StoredMessage = {
                ...m,
                images: m.images!.map((im) =>
                  im.id === imageId ? { ...im, description: caption } : im
                ),
              };
              const next = [...prev];
              next[idx] = updated;
              writer.schedule(updated.id, updated);
              return next;
            });
          }
          setProgress((p) =>
            p && p.messageId === currentAssistantId ? { ...p, phase: "thinking", toolName: undefined } : p
          );
          flush();
        } else if (event === "compaction") {
          // Server folded older tool rounds into a recap to keep this turn
          // under the model's window. `start` shows the "Compacting context…"
          // pill (reusing the tool-phase indicator); `done` enriches the call
          // with the recap + token counts so it persists on the message and
          // renders the compaction card.
          const phase = typeof data.phase === "string" ? data.phase : "";
          if (phase === "start") {
            events.push({
              kind: "call",
              name: "compaction",
              args: {
                messagesFolded:
                  typeof data.messagesFolded === "number" ? data.messagesFolded : 0,
                tokensBefore:
                  typeof data.tokensBefore === "number" ? data.tokensBefore : undefined,
              },
              at: Date.now(),
            });
            setProgress((p) =>
              p && p.messageId === currentAssistantId
                ? { ...p, phase: "tool", toolName: "compaction" }
                : p
            );
          } else if (phase === "done") {
            const messagesFolded =
              typeof data.messagesFolded === "number" ? data.messagesFolded : 0;
            const tokensBefore =
              typeof data.tokensBefore === "number" ? data.tokensBefore : undefined;
            const tokensAfter =
              typeof data.tokensAfter === "number" ? data.tokensAfter : undefined;
            const summary = typeof data.summary === "string" ? data.summary : "";
            // Fold the final counts + recap text back onto the matching call
            // event (same object ref the next flush will persist).
            for (let i = events.length - 1; i >= 0; i--) {
              const e = events[i];
              if (e.kind === "call" && e.name === "compaction") {
                e.args = { ...e.args, messagesFolded, tokensBefore, tokensAfter, summary };
                break;
              }
            }
            events.push({
              kind: "result",
              name: "compaction",
              summary:
                messagesFolded > 0
                  ? `Condensed ${messagesFolded} message${messagesFolded === 1 ? "" : "s"}${
                      typeof tokensBefore === "number" && typeof tokensAfter === "number"
                        ? ` · ${Math.round(tokensBefore / 1000)}k→${Math.round(
                            tokensAfter / 1000
                          )}k tokens`
                        : ""
                    }`
                  : "Trimmed oldest results to fit context",
              at: Date.now(),
            });
            setProgress((p) =>
              p && p.messageId === currentAssistantId
                ? { ...p, phase: "thinking", toolName: undefined }
                : p
            );
          }
          flush();
        } else if (event === "files_produced") {
          // run_code wrote output files; the worker already uploaded them to
          // Blob. Append (dedupe by url) so the assistant bubble renders
          // download chips and the next run_code can read them by name.
          const incoming = Array.isArray(data.files)
            ? (data.files as AttachedFile[])
            : [];
          for (const f of incoming) {
            if (!f || typeof f.url !== "string") continue;
            if (producedFiles.some((p) => p.url === f.url)) continue;
            producedFiles.push(f);
          }
          flush();
        } else if (event === "artifact_open") {
          artifactStreaming = true;
          artifactComplete = false;
          artifactHtml = "";
          setProgress((p) =>
            p && p.messageId === currentAssistantId ? { ...p, phase: "streaming" } : p
          );
          flush();
        } else if (event === "artifact_delta" && typeof data.text === "string") {
          artifactHtml += data.text;
          flush();
        } else if (event === "artifact_close") {
          artifactStreaming = false;
          artifactComplete = true;
          if (typeof data.html === "string") artifactHtml = data.html;
          if (typeof data.summary === "string") artifactSummary = data.summary;
          flush();
        } else if (event === "file_changed") {
          const path = String(data.path ?? "");
          const op = String(data.op ?? "edit") as FileChange["op"];
          const content = typeof data.content === "string" ? data.content : "";
          if (path && pendingFiles) {
            if (op === "delete") {
              const next = { ...pendingFiles };
              delete next[path];
              pendingFiles = next;
            } else {
              pendingFiles = { ...pendingFiles, [path]: content };
            }
            if (onPendingVfs && pendingEntry) onPendingVfs(pendingFiles, pendingEntry);
          }
          flush();
        } else if (event === "build_result") {
          vfsBuild = data.ok
            ? {
                ok: true,
                durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
                warnings: Array.isArray(data.warnings) ? (data.warnings as BuildIssue[]) : undefined,
              }
            : {
                ok: false,
                durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
                errors: Array.isArray(data.errors) ? (data.errors as BuildIssue[]) : [],
                warnings: Array.isArray(data.warnings) ? (data.warnings as BuildIssue[]) : undefined,
              };
          flush();
        } else if (event === "vfs_final") {
          vfsStreaming = false;
          const finalFiles = (data.files as ArtifactFiles) ?? pendingFiles ?? {};
          const finalEntry = (data.entry as string) ?? pendingEntry ?? "";
          const finalOps = (data.ops as FileChange[]) ?? [];
          const finalSummary = typeof data.summary === "string" ? data.summary : "";
          const finalBuild = (data.build as BuildOutcome | undefined) ?? vfsBuild;
          pendingFiles = finalFiles;
          pendingEntry = finalEntry;
          vfsFinal = {
            files: finalFiles,
            entry: finalEntry,
            summary: finalSummary,
            ops: finalOps,
            build: finalBuild,
            streaming: false,
          };
          flush();
        } else if (event === "plan_outline") {
          // Initial (or cached-replay) plan card. Steps start as
          // "pending"; replaced by later plan_step_* events. Steps the
          // server marks as cached arrive immediately as plan_step_done
          // with cached:true, so the pending → done flip is fine here.
          const stepsRaw = Array.isArray(data.steps) ? data.steps : [];
          const incomingSteps = stepsRaw
            .map((s: Record<string, unknown>) => ({
              id: typeof s.id === "string" ? s.id : "",
              title: typeof s.title === "string" ? s.title : "",
              description: typeof s.description === "string" ? s.description : undefined,
              targetFiles: Array.isArray(s.targetFiles)
                ? (s.targetFiles as string[]).filter((p) => typeof p === "string")
                : undefined,
              status: "pending" as const,
            }))
            .filter((s: { id: string; title: string }) => s.id && s.title);
          // Merge with any existing plan steps (preserve completed status
          // from a prior worker's events the resume tail just replayed).
          const prevById = new Map(
            (assistantPlan?.steps ?? []).map((s) => [s.id, s])
          );
          assistantPlan = {
            brief: typeof data.brief === "string" ? data.brief : assistantPlan?.brief ?? "",
            steps: incomingSteps.map((s: {
              id: string;
              title: string;
              description?: string;
              targetFiles?: string[];
              status: "pending";
            }) => {
              const prev = prevById.get(s.id);
              return prev ? { ...s, ...prev } : s;
            }),
            pausedAt: assistantPlan?.pausedAt,
          };
          flush();
        } else if (event === "plan_step_pending") {
          const stepId = String(data.stepId ?? "");
          if (assistantPlan && stepId) {
            assistantPlan = {
              ...assistantPlan,
              steps: assistantPlan.steps.map((s) =>
                s.id === stepId ? { ...s, status: "running" } : s
              ),
            };
          }
          flush();
        } else if (event === "plan_step_done") {
          const stepId = String(data.stepId ?? "");
          if (assistantPlan && stepId) {
            assistantPlan = {
              ...assistantPlan,
              steps: assistantPlan.steps.map((s) =>
                s.id === stepId
                  ? {
                      ...s,
                      status: "done",
                      summary: typeof data.summary === "string" ? data.summary : s.summary,
                      filesChanged: Array.isArray(data.filesChanged)
                        ? (data.filesChanged as string[]).filter((p) => typeof p === "string")
                        : s.filesChanged,
                      cached: data.cached === true,
                    }
                  : s
              ),
            };
          }
          flush();
        } else if (event === "plan_step_errored") {
          const stepId = String(data.stepId ?? "");
          if (assistantPlan && stepId) {
            assistantPlan = {
              ...assistantPlan,
              steps: assistantPlan.steps.map((s) =>
                s.id === stepId
                  ? {
                      ...s,
                      status: "errored",
                      error: typeof data.error === "string" ? data.error : undefined,
                    }
                  : s
              ),
            };
          }
          flush();
        } else if (event === "plan_paused") {
          // Chain exhausted with steps remaining. Mark the message as
          // plan-paused (NOT errored) and let the Continue button route
          // through /api/chat/plan-continue/{streamId} for a fresh chain.
          const nextStepId = typeof data.nextStepId === "string" ? data.nextStepId : "";
          if (assistantPlan) {
            assistantPlan = { ...assistantPlan, pausedAt: nextStepId };
          } else {
            assistantPlan = { brief: "", steps: [], pausedAt: nextStepId };
          }
          sawDone = true;
          flushSync();
        } else if (event === "plan_resumed") {
          // Sent by /api/chat/plan-continue as the first event of the new
          // worker. Clear pausedAt so the UI reflects active state again.
          if (assistantPlan) {
            assistantPlan = { ...assistantPlan, pausedAt: undefined };
          }
          flush();
        } else if (event === "error" && typeof data.message === "string") {
          assistantError = data.message;
          if (data.transient === true) assistantErrorTransient = true;
          // Errors are terminal for the stream, but keep streamId/streamCursor
          // on the snapshot so the manual "Continue" button can re-launch
          // against the same Redis scratchpad (council positions, agentic
          // research briefs, etc.). The auto-resume effect filters by
          // `!m.error`, so this won't reanimate a failed stream on its own.
          sawDone = true;
          flushSync();
        } else if (event === "done") {
          sawDone = true;
          flushSync();
          break outer;
        }
      }
    }
    // Stream ended cleanly (server closed the connection). If `vfs_final`
    // never arrived (e.g. mid-edit network drop) we'd otherwise persist
    // `proposedVfs.streaming: true` and the VfsCard would stay on "Editing
    // files" forever — clear it so the user can still publish if Build was OK.
    if (usingVfs && !vfsFinal && vfsStreaming) {
      vfsStreaming = false;
    }
    flushSync();
    return {
      aborted: false,
      error: assistantError,
      done: sawDone,
      finalMsg: lastSnapshot,
      // Errored streams keep streamId for manual Continue but aren't auto-
      // resumable — distinguish so the caller doesn't reconnect a dead worker.
      resumable: !!streamId && !assistantError,
      transient: assistantErrorTransient || undefined,
    };
  } catch (err) {
    const aborted = (err as { name?: string }).name === "AbortError";
    // If the SSE handshake already delivered a streamId, the server kept the
    // LLM call alive in Redis (waitUntil). Don't pin a network error onto
    // the message — that would blacklist it from the auto-resume effect,
    // which explicitly skips errored messages. Leave the partial state +
    // streamId in place and signal `resumable: true` so the caller can
    // re-arm the resume path on this same mount.
    const resumable = !aborted && !!streamId;
    if (!assistantError && !resumable) {
      assistantError = aborted
        ? "Cancelled by user."
        : err instanceof Error
          ? err.message
          : "Network error";
    }
    if (usingVfs && !vfsFinal && vfsStreaming) {
      vfsStreaming = false;
    }
    flushSync();
    return {
      aborted,
      error: assistantError,
      done: sawDone,
      finalMsg: lastSnapshot,
      resumable,
      transient: assistantErrorTransient || undefined,
    };
  } finally {
    cancelRaf();
    if (usingVfs) onPendingVfs?.(null, null);
  }
}

export function Chat({
  chatId,
  target,
  initialModel,
  onSaveHtml,
  onConvertArtifact,
  onPinArtifact,
  onPinMessage,
  onSaveVfs,
  templateFiles,
  templateEntry,
  templateVersion,
  onRevertToVersion,
  onRevertInlineArtifact,
  onPendingVfs,
  runtimeError,
  onRuntimeErrorConsumed,
  placeholder,
  hideModelPicker,
  onModelChange,
  extraSystem,
  chats,
  onSelectChat,
  onNewChat,
  newChatBusy,
  attachedPins,
  onChangeAttachedPins,
  onOpenDetails,
  onMessagesChange,
  prefillInput,
  autoSendPrefill,
  prefillModel,
  onPrefillConsumed,
  selectionAnchor,
  onSelectionConsumed,
  onSelectionPin,
  onSelectionResearch,
  onSelectionComment,
  onSelectionDiagram,
  hideHeader,
  mobileHeaderHostId,
  messagesCollapsed,
  onToggleMessages,
  dockClassName,
  className,
  sessionMemoryNoteId,
  onSessionMemoryNoteId,
}: Props) {
  const hasVfs = !!(templateFiles && templateEntry);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // The composer owns its own input state so typing only re-renders the
  // composer, not the entire chat tree (every message bubble, header, etc.).
  // The parent reads / clears the value imperatively via this ref.
  const composerRef = useRef<ComposerHandle>(null);
  const getInput = useCallback(() => composerRef.current?.getValue() ?? "", []);
  const clearInput = useCallback(() => composerRef.current?.setValue(""), []);
  // Holds the latest `send` so the prefill effect (declared before `send`) can
  // auto-fire it without a temporal-dead-zone reference. Assigned each render
  // right after `send` is defined.
  const sendRef = useRef<((text?: string) => void) | null>(null);

  // One-shot prefill: seed the composer the first time prefillInput becomes
  // non-empty (typically on mount when the page is reached via ?prefill=…).
  // Don't overwrite if the user already typed something. With autoSendPrefill
  // (the "describe an app" launcher), SEND it instead of just seeding - so the
  // assistant starts building immediately rather than parking it in the box.
  const prefillAppliedRef = useRef(false);
  // Apply the prefill's model override as soon as it arrives (before the
  // gated send below), so the auto-sent message runs on the intended model.
  // Mirrored on a ref so the settings-hydration effect can see it without
  // re-running (it must not re-fire when the override is later cleared).
  const prefillModelRef = useRef<string | null | undefined>(prefillModel);
  useEffect(() => {
    prefillModelRef.current = prefillModel;
    if (prefillModel) setModel(prefillModel);
  }, [prefillModel]);
  useEffect(() => {
    // Re-arm once the parent clears the prefill (via onPrefillConsumed). This
    // keeps the original one-shot semantics per distinct prefill while letting
    // repeatable senders — e.g. the canvas "Apply comments" action — fire again
    // on the next non-empty value instead of being blocked after the first.
    if (!prefillInput) {
      prefillAppliedRef.current = false;
      return;
    }
    // Auto-send must wait for hydration: the IndexedDB message-load effect calls
    // setMessages(sanitized) once loaded, which would clobber an optimistic
    // user/assistant message we pushed before it finished. Seeding the composer
    // (the non-autosend path) is safe pre-hydration, so only gate the send.
    if (autoSendPrefill && !hydrated) return;
    if (prefillAppliedRef.current) return;
    prefillAppliedRef.current = true;
    const text = prefillInput.trim();
    const cur = composerRef.current?.getValue() ?? "";
    if (autoSendPrefill && text && cur.trim().length === 0) {
      sendRef.current?.(text);
    } else if (cur.trim().length === 0) {
      composerRef.current?.setValue(prefillInput);
    }
    onPrefillConsumed?.();
  }, [prefillInput, autoSendPrefill, hydrated, onPrefillConsumed]);
  const [pendingImages, setPendingImages] = useState<AttachedImage[]>([]);
  const [pendingPdfs, setPendingPdfs] = useState<AttachedPdf[]>([]);
  const [pendingCsvs, setPendingCsvs] = useState<AttachedCsv[]>([]);
  // Binary files staged for the code-execution sandbox (audio/video/zip/etc.).
  // Unlike images/pdfs/csvs these are uploaded to Blob on attach; we keep only
  // the pointer here. `uploading` count drives the composer's busy affordance.
  const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([]);
  const [filesUploading, setFilesUploading] = useState(0);
  const [imageError, setImageError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [syncingNoteId, setSyncingNoteId] = useState<string | null>(null);
  const [syncSuccessNoteId, setSyncSuccessNoteId] = useState<string | null>(null);
  const isDesignerEdit = target?.kind === "designer" && target.mode === "edit";
  const defaultForTarget = isDesignerEdit ? "kimi-k2.6" : DEFAULT_MODEL;
  const [model, setModel] = useState<string>(initialModel ?? defaultForTarget);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [prefsOpen, setPrefsOpen] = useState(false);
  // When true, opening Preferences jumps straight to the "Add a model" card -
  // set by the model picker's "+ Add a model not listed…" shortcut.
  const [prefsAddModel, setPrefsAddModel] = useState(false);
  // When true, opening Preferences jumps straight to the Connectors tab - set
  // by the chat ••• sheet's "Manage connectors" shortcut.
  const [prefsConnectors, setPrefsConnectors] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [expandedSummaryIds, setExpandedSummaryIds] = useState<Set<string>>(new Set());
  const [savedMessageId, setSavedMessageId] = useState<string | null>(null);
  /** Assistant message whose plan the user just asked to pause. Held until
   *  the worker actually emits `plan_paused` (sets plan.pausedAt) or the
   *  stream otherwise terminates — at which point the effect below clears
   *  it. Drives the "Stopping…" button label so a rapid double-click
   *  doesn't fire a second pause POST. */
  const [stoppingMessageId, setStoppingMessageId] = useState<string | null>(
    null
  );
  const [autoSavedMessageIds, setAutoSavedMessageIds] = useState<Set<string>>(
    () => new Set()
  );
  const autoSaveAttemptedRef = useRef<Set<string>>(new Set());

  /** In-flight progress: which assistant message is streaming, what phase, when did it start. */
  const [progress, setProgress] = useState<{
    messageId: string;
    phase: "sending" | "thinking" | "tool" | "streaming";
    toolName?: string;
    startedAt: number;
    /** Touched by consumeChatStream on every SSE event so the stall detector
     *  can compute time-since-last-progress. Falls back to startedAt. */
    lastEventAt?: number;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Forward reference: send() needs to call resumeStream(), but resumeStream
  // is declared further down so React deps don't form a cycle.
  const resumeStreamRef = useRef<((msg: StoredMessage) => Promise<void>) | null>(null);
  const writer = useMemo(() => makeWriteScheduler<StoredMessage>(putMessage), []);

  // Mirror the message list to the parent so the Details/Activity panel can
  // render the same data without a second IndexedDB subscription.
  useEffect(() => {
    onMessagesChange?.(messages);
  }, [messages, onMessagesChange]);

  // Canvas (note-edit / artifact-edit) mode has no Build tool —
  // `proposedVfs.build` is always undefined there, so the build-gated save
  // path below would never fire and the manual button would never enable.
  // Treat it as build-not-required.
  const noBuildRequired =
    target?.kind === "note-canvas" || target?.kind === "chat-artifact-canvas";

  // Artifact-edit messages that are already the version on disk, so their
  // "Save version" button renders as "Saved". Derived from persisted message
  // state (not the ephemeral `savedMessageId`) so the button reflects reality
  // after a reload instead of springing back to a clickable state. Covers:
  //   - the canvas's source artifact message itself (it IS the current
  //     version - nothing to save), and
  //   - any edit response whose body already equals that source's body.
  const canvasSourceMessageId =
    target?.kind === "chat-artifact-canvas" ? target.messageId : undefined;
  const appliedEditIds = useMemo(() => {
    const set = new Set<string>();
    if (target?.kind !== "chat-artifact-canvas") return set;
    if (canvasSourceMessageId) set.add(canvasSourceMessageId);
    const byId = new Map(messages.map((m) => [m.id, m]));
    for (const m of messages) {
      if (m.role !== "assistant" || !m.editsArtifactMessageId) continue;
      const editBody = artifactBodyOf(m);
      if (editBody == null) continue;
      const srcBody = artifactBodyOf(byId.get(m.editsArtifactMessageId));
      if (srcBody != null && srcBody === editBody) set.add(m.id);
    }
    return set;
  }, [messages, target?.kind, canvasSourceMessageId]);

  // Auto-save: when an assistant message's proposed VFS settles with a clean
  // build (ok && no warnings), persist it without waiting for a manual click.
  // Canvas mode skips the build check (it can't run one). Canvas mode also
  // saves only the latest eligible message - on hydrate with a backlog of
  // unsaved edits we just want the newest body on disk (last write wins),
  // so racing all of them is pointless. The attempted-ref de-dupes across
  // rerenders so each message only saves once even if the effect re-runs.
  useEffect(() => {
    // Apply a chat-artifact-canvas edit response back onto its source
    // message directly. Used when the user back-navigated out of the
    // canvas page mid-stream: the /chats/[id] Chat instance has no
    // `onSaveVfs` wired up, so the canvas's normal save path can't fire.
    // Without this the new HTML strands on Y (the assistant edit message)
    // and renders in the chat history as a duplicate "new artifact".
    const applyEditToSource = async (m: StoredMessage) => {
      const sourceId = m.editsArtifactMessageId;
      if (!sourceId) return;
      const vfs = m.proposedVfs;
      if (!vfs || vfs.streaming || !vfs.entry) return;
      const html = vfs.files?.[vfs.entry];
      if (typeof html !== "string" || html.length === 0) return;
      const source = await getMessage(sourceId);
      if (!source || source.chatId !== m.chatId) return;
      const updatedSource: StoredMessage = {
        ...source,
        // In-place edit: bump editedAt so account-sync marks the chat dirty
        // and the next pull doesn't revert this applied canvas edit.
        editedAt: Date.now(),
        proposedArtifact: source.proposedArtifact
          ? { ...source.proposedArtifact, html, streaming: false }
          : source.proposedArtifact,
        proposedVfs: {
          files: { [vfs.entry]: html },
          entry: vfs.entry,
          summary: vfs.summary ?? source.proposedVfs?.summary ?? "",
          ops: vfs.ops ?? [],
          build: vfs.build,
          streaming: false,
        },
      };
      await putMessage(updatedSource);
      setMessages((prev) =>
        prev.map((p) => (p.id === updatedSource.id ? updatedSource : p))
      );
    };

    const order = noBuildRequired ? [...messages].reverse() : messages;
    for (const m of order) {
      if (m.role !== "assistant") continue;
      const vfs = m.proposedVfs;
      if (!vfs || vfs.streaming) continue;

      if (!onSaveVfs) {
        // Fallback path: no save handler is wired in this Chat instance.
        // The only case we handle here is the canvas-edit response one —
        // every other VFS message is just informational on /chats/[id]
        // (e.g. a freshly created designer scratchpad) and shouldn't be
        // auto-applied anywhere.
        if (!m.editsArtifactMessageId) continue;
        if (vfs.ops.length === 0) continue;
        if (autoSaveAttemptedRef.current.has(m.id)) continue;
        autoSaveAttemptedRef.current.add(m.id);
        void applyEditToSource(m).catch(() => {
          autoSaveAttemptedRef.current.delete(m.id);
        });
        if (noBuildRequired) break;
        continue;
      }

      if (!noBuildRequired) {
        if (vfs.build?.ok !== true) continue;
        if ((vfs.build.warnings?.length ?? 0) > 0) continue;
      } else if (vfs.ops.length === 0) {
        // Canvas mode: nothing to save if the model touched no files.
        continue;
      }
      // In canvas mode we've now reached the newest *real* edit (it passed the
      // streaming/ops guards). It is the only message that may land on disk -
      // last-write-wins means nothing older should overwrite it. So from here
      // on every exit must `break`, never `continue` to an older edit. On a
      // fresh mount `autoSaveAttemptedRef` is empty, so a bare `continue` past
      // the already-saved newest message would fall through and re-save a stale
      // older body over it - the "reopens at the previous version" bug.
      if (savedMessageId === m.id) {
        if (noBuildRequired) break;
        continue;
      }
      // Already the version on disk (e.g. saved in a prior session, then the
      // page reloaded). Re-writing the same body every mount would thrash IDB
      // and re-trigger an account-sync push on each canvas open. Skip it - the
      // card already renders "Saved" off `appliedEditIds`, so no setState is
      // needed here (calling it would loop, since `savedMessageId` holds only
      // one id while several messages can be applied).
      if (appliedEditIds.has(m.id)) {
        if (noBuildRequired) break;
        continue;
      }
      if (autoSaveAttemptedRef.current.has(m.id)) {
        if (noBuildRequired) break;
        continue;
      }
      autoSaveAttemptedRef.current.add(m.id);
      Promise.resolve(onSaveVfs(vfs))
        .then((ok) => {
          // `false` means the write was genuinely refused (note deleted) -
          // don't mark the card saved, or the disabled "Saved" badge would
          // lie and block a manual override. Any other result counts as saved.
          if (ok === false) {
            autoSaveAttemptedRef.current.delete(m.id);
            return;
          }
          setSavedMessageId(m.id);
          setAutoSavedMessageIds((prev) => {
            const next = new Set(prev);
            next.add(m.id);
            return next;
          });
        })
        .catch(() => {
          autoSaveAttemptedRef.current.delete(m.id);
        });
      // Canvas mode: last-write-wins inside applyCanvasResult means the latest
      // eligible message is what lands on disk. Bail after queuing one so older
      // unsaved edits don't race. Designer mode keeps the parallel behavior -
      // every clean-build message represents a meaningful checkpoint there.
      if (noBuildRequired) break;
    }
  }, [messages, onSaveVfs, savedMessageId, noBuildRequired, appliedEditIds]);

  // Hydrate from IndexedDB.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadMessages(chatId).catch(() => [] as StoredMessage[]),
      loadSettings().catch(() => ({ ...DEFAULT_SETTINGS })),
    ]).then(([msgs, s]) => {
      if (cancelled) return;
      // Sanitize: a previous session may have persisted an in-flight message
      // with `streaming: true` (network drop, reload, or tab close before
      // `vfs_final` arrived). Without this the VfsCard / artifact panel would
      // sit on the spinner forever with no way to recover.
      //
      // Skip messages that still have an active `streamId` — those will be
      // picked up by the auto-resume effect below and `streaming: true` is
      // accurate (the server's still working on them).
      const sanitized = msgs.map((m) => {
        if (m.streamId) return m;
        if (!m.proposedVfs?.streaming && !m.proposedArtifact?.streaming) return m;
        return {
          ...m,
          proposedVfs: m.proposedVfs ? { ...m.proposedVfs, streaming: false } : undefined,
          proposedArtifact: m.proposedArtifact
            ? { ...m.proposedArtifact, streaming: false }
            : undefined,
        };
      });
      const imgCount = sanitized.reduce(
        (a, m) => a + (m.images?.length ?? 0),
        0
      );
      const imgBytes = sanitized.reduce(
        (a, m) =>
          a + (m.images?.reduce((b, im) => b + (im.dataUrl?.length ?? 0), 0) ?? 0),
        0
      );
      dbg("chat.messages.loaded", {
        chatId,
        count: sanitized.length,
        images: imgCount,
        imageMB: +(imgBytes / 1048576).toFixed(2),
        safeRender: isSafeRender(),
      });
      setMessages(sanitized);
      // One-time migration: re-seed the council to the current default for
      // users whose stored roster is a stale pre-v2 default (4 members).
      // Without this they'd be stuck at 4 forever — the dialog's first-open
      // seeding only fires when councilMembers is undefined.
      const migrated = migrateCouncilSettings(s);
      const finalSettings = migrated ?? s;
      if (migrated) {
        saveSettings(migrated).catch(() => {});
      }
      setSettings(finalSettings);
      // A prefill's model override outranks the settings default - the Update
      // flow depends on its chosen model surviving hydration.
      if (!initialModel && !prefillModelRef.current && finalSettings.defaultModel)
        setModel(finalSettings.defaultModel);
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, initialModel]);

  const didResumeRef = useRef(false);

  // Live progress timeline for in-flight novel-outline calls. Keyed by the
  // outline-edit message id. Populated by a background polling loop that
  // hits /api/novel/outline/progress/{streamId}; cleared on terminal status
  // or user cancel. Kept out of the StoredMessage so the transient steps
  // never touch IndexedDB — a remount re-derives them from the server.
  const [novelOutlineProgress, setNovelOutlineProgress] = useState<
    Record<string, NovelOutlineProgress>
  >({});

  // Live framer reasoning/progress, keyed by framing message id. Streamed from
  // the resume endpoint while the framer works so the card shows it thinking
  // instead of a blank spinner. Ephemeral — never persisted; a remount replays
  // it from Redis (cursor 0).
  const [framingThinking, setFramingThinking] = useState<
    Record<string, string>
  >({});
  const appendFramingThinking = useCallback(
    (messageId: string, text: string) => {
      setFramingThinking((prev) => ({
        ...prev,
        [messageId]: (prev[messageId] ?? "") + text,
      }));
    },
    []
  );
  const clearFramingThinking = useCallback((messageId: string) => {
    setFramingThinking((prev) => {
      if (!(messageId in prev)) return prev;
      const next = { ...prev };
      delete next[messageId];
      return next;
    });
  }, []);

  // AbortControllers for in-flight framing resume long-polls. Lets the user
  // stop a framing call while it's still "Framing the question…".
  const framingAbortsRef = useRef<Map<string, AbortController>>(new Map());
  const registerFramingAbort = useCallback(
    (messageId: string): AbortController => {
      const prior = framingAbortsRef.current.get(messageId);
      if (prior) prior.abort();
      const ctrl = new AbortController();
      framingAbortsRef.current.set(messageId, ctrl);
      return ctrl;
    },
    []
  );
  const clearFramingAbort = useCallback((messageId: string) => {
    const ctrl = framingAbortsRef.current.get(messageId);
    if (ctrl) {
      ctrl.abort();
      framingAbortsRef.current.delete(messageId);
    }
  }, []);

  const cancelFraming = useCallback(
    async (messageId: string) => {
      clearFramingAbort(messageId);
      clearFramingThinking(messageId);
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      setPending(false);
      setProgress(null);
      try {
        await deleteMessage(messageId);
      } catch (err) {
        console.warn("cancelFraming: deleteMessage failed", err);
      }
    },
    [clearFramingAbort, clearFramingThinking]
  );

  // AbortControllers for the in-flight resume long-poll + progress poll of
  // each outline call. Lets the user cancel a stuck outline (Cancel button
  // on the card) instead of being trapped staring at "Outlining…" forever
  // when the server-side waitUntil got reaped past its 120s budget.
  const novelOutlineAbortsRef = useRef<Map<string, AbortController>>(new Map());
  const registerNovelOutlineAbort = useCallback(
    (messageId: string): AbortController => {
      const prior = novelOutlineAbortsRef.current.get(messageId);
      if (prior) prior.abort();
      const ctrl = new AbortController();
      novelOutlineAbortsRef.current.set(messageId, ctrl);
      return ctrl;
    },
    []
  );
  const clearNovelOutlineAbort = useCallback((messageId: string) => {
    const ctrl = novelOutlineAbortsRef.current.get(messageId);
    if (ctrl) {
      ctrl.abort();
      novelOutlineAbortsRef.current.delete(messageId);
    }
  }, []);

  // Background poll of the progress snapshot endpoint. Runs every ~1.5s
  // while the outline is producing; updates novelOutlineProgress[messageId]
  // so the card's activity timeline animates with real server-side phase
  // events instead of static "Outlining…" text. Self-terminates on terminal
  // status, abort, or after the first network error in a row (we don't want
  // a polling loop hammering Upstash if the endpoint is down).
  const startNovelOutlineProgressPoll = useCallback(
    (messageId: string, streamId: string, signal: AbortSignal) => {
      const POLL_INTERVAL_MS = 1500;
      let consecutiveErrors = 0;
      const loop = async () => {
        while (!signal.aborted) {
          let snapshot: NovelOutlineProgress | null = null;
          try {
            const res = await fetch(
              `/api/novel/outline/progress/${encodeURIComponent(streamId)}`,
              { signal, cache: "no-store" }
            );
            if (signal.aborted) return;
            if (res.ok) {
              consecutiveErrors = 0;
              const body = (await res.json()) as {
                status: NovelOutlineProgress["status"];
                steps: NovelOutlineProgressStep[];
                startedAt?: number;
                workerSeenAt?: number;
              };
              snapshot = {
                status: body.status,
                steps: Array.isArray(body.steps) ? body.steps : [],
                startedAt: body.startedAt,
                workerSeenAt: body.workerSeenAt,
              };
            } else {
              consecutiveErrors += 1;
            }
          } catch (err) {
            if ((err as { name?: string })?.name === "AbortError") return;
            consecutiveErrors += 1;
          }
          if (snapshot) {
            setNovelOutlineProgress((prev) => ({
              ...prev,
              [messageId]: snapshot!,
            }));
            if (
              snapshot.status === "complete" ||
              snapshot.status === "error" ||
              snapshot.status === "missing"
            ) {
              return;
            }
          }
          if (consecutiveErrors >= 5) return;
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
      };
      void loop();
    },
    []
  );

  // User clicked Cancel on a stuck outline card. Aborts the resume +
  // progress polls, drops the placeholder message from state + IDB. The
  // server-side waitUntil keeps running on Vercel's side (we can't reach
  // into a running lambda from the browser) but the user gets their UI
  // back immediately and the Redis stream is allowed to TTL out.
  const cancelNovelOutline = useCallback(
    async (messageId: string) => {
      clearNovelOutlineAbort(messageId);
      setNovelOutlineProgress((prev) => {
        if (!(messageId in prev)) return prev;
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      setPending(false);
      setProgress(null);
      try {
        await deleteMessage(messageId);
      } catch (err) {
        console.warn("cancelNovelOutline: deleteMessage failed", err);
      }
    },
    [clearNovelOutlineAbort]
  );

  // Auto-scroll on new content. When the messages region is collapsed the
  // ref is null and the early return handles it; including
  // `messagesCollapsed` in the deps makes the first re-expand scroll to the
  // bottom of the now-mounted node.
  useEffect(() => {
    if (!hydrated) return;
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight });
    });
  }, [messages.length, hydrated, messagesCollapsed]);

  // Persist settings on change.
  const updateSettings = useCallback(async (next: Settings) => {
    setSettings(next);
    try {
      await saveSettings(next);
    } catch {
      // best-effort
    }
  }, []);

  useAutoEnableRunpodModels(settings, updateSettings);

  // Token-budget telemetry, used for both the gauge and the auto-compact gate.
  const ctxLimit = modelContextTokens(model);
  const wireBudget = ctxLimit - OUTPUT_RESERVE_TOKENS;
  const wireMessages = useMemo(
    () =>
      messages.filter(
        (m) =>
          !m.summarizedInto &&
          m.kind !== "council-framing" &&
          m.kind !== "research-framing" &&
          m.kind !== "research-result" &&
          m.kind !== "novel-outline-edit"
      ),
    [messages]
  );
  const estimatedTokens = useMemo(
    () => estimateStoredTokens(wireMessages),
    [wireMessages]
  );
  const usagePct = Math.min(1, estimatedTokens / wireBudget);

  // Run compaction. Returns the (possibly updated) wire-message list.
  const runCompaction = useCallback(
    async (force = false): Promise<StoredMessage[]> => {
      const sendable = messages.filter(
        (m) =>
          !m.summarizedInto &&
          m.kind !== "council-framing" &&
          m.kind !== "research-framing" &&
          m.kind !== "research-result" &&
          m.kind !== "novel-outline-edit"
      );
      if (!force) {
        const tokens = estimateStoredTokens(sendable);
        if (tokens <= wireBudget * SUMMARIZE_AT) return sendable;
      }
      if (sendable.length <= KEEP_TAIL_MESSAGES + 2) return sendable;

      setCompacting(true);
      try {
        // Older slice to summarise = everything except the most-recent K turns.
        // Skip messages that are already summaries.
        const head = sendable.slice(0, sendable.length - KEEP_TAIL_MESSAGES);
        if (head.length < 2) return sendable;

        const res = await fetch("/api/summarize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: head.map((m) => ({ role: m.role, content: wireContentFor(m) })),
            ...(settings.runpodEndpointId
              ? { runpodEndpointId: settings.runpodEndpointId }
              : {}),
          }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? `summarize failed (${res.status})`);
        }
        const { summary } = (await res.json()) as { summary: string };

        const summaryId = newId();
        const subsumedIds = head.map((m) => m.id);
        const summaryMsg: StoredMessage = {
          id: summaryId,
          chatId,
          role: "system",
          kind: "summary",
          content: summary,
          subsumedIds,
          createdAt: head[0].createdAt - 1,
        };

        // Mark each subsumed message + persist.
        const updated: StoredMessage[] = messages.map((m) => {
          if (subsumedIds.includes(m.id)) {
            const next = { ...m, summarizedInto: summaryId };
            void putMessage(next);
            return next;
          }
          return m;
        });
        await putMessage(summaryMsg);
        // Insert summary just before the first kept message.
        const insertIdx = updated.findIndex((m) => m.id === sendable[sendable.length - KEEP_TAIL_MESSAGES].id);
        const final = [...updated];
        final.splice(insertIdx, 0, summaryMsg);
        setMessages(final);
        return final.filter((m) => !m.summarizedInto);
      } finally {
        setCompacting(false);
      }
    },
    [chatId, messages, model, wireBudget]
  );

  // Per-message delete (works on any message, including summarised originals).
  const handleDelete = useCallback(
    async (id: string) => {
      await deleteMessage(id);
      setMessages((prev) => prev.filter((m) => m.id !== id));
    },
    []
  );

  // Undo a cross-turn compaction: clear `summarizedInto` on the subsumed
  // originals so they rejoin the live conversation, then drop the summary
  // message. The originals are back in full, so the next send re-runs
  // runCompaction and re-compacts from scratch — exactly the "remove
  // compaction, which re-triggers it" behavior.
  const handleRestoreSummary = useCallback(
    async (summary: StoredMessage) => {
      const subsumed = new Set(summary.subsumedIds ?? []);
      setMessages((prev) =>
        prev
          .map((m) => {
            if (m.summarizedInto === summary.id) {
              const restored = { ...m, summarizedInto: undefined };
              void putMessage(restored);
              return restored;
            }
            return m;
          })
          .filter((m) => m.id !== summary.id)
      );
      await deleteMessage(summary.id);
      // Belt-and-suspenders: also clear any subsumed rows we matched by id list
      // (covers a summary whose originals point at it via subsumedIds but whose
      // summarizedInto got out of sync).
      if (subsumed.size > 0) {
        setMessages((prev) =>
          prev.map((m) =>
            subsumed.has(m.id) && m.summarizedInto
              ? { ...m, summarizedInto: undefined }
              : m
          )
        );
      }
    },
    []
  );

  // "Revert to here" target: the user message we'd truncate from. The actual
  // confirmation runs in <RevertConfirmDialog/> below; cleared on cancel/confirm.
  const [revertTarget, setRevertTarget] = useState<StoredMessage | null>(null);
  const [reverting, setReverting] = useState(false);

  const handleRevertToHere = useCallback(
    async (msg: StoredMessage) => {
      setReverting(true);
      try {
        // Restore designer files first so the preview snaps back before the
        // chat re-renders without the truncated tail. App.state is intentionally
        // untouched — revert is forward-only on designer code.
        if (
          onRevertToVersion &&
          typeof msg.templateVersion === "number" &&
          typeof templateVersion === "number" &&
          msg.templateVersion < templateVersion
        ) {
          try {
            await onRevertToVersion(msg.templateVersion);
          } catch (err) {
            console.error("revert: file restore failed", err);
          }
        }

        // Inline-artifact revert: chat-artifact-canvas edits clobber the
        // source message's HTML in place, so the only record of the prior
        // body lives on the edit message itself (`priorArtifactHtml`).
        // Walk the truncated range, find the earliest edit per unique
        // source id, and roll each source back to that snapshot.
        const survivingIds = new Set(
          messages.filter((m) => m.createdAt < msg.createdAt).map((m) => m.id)
        );
        const restorations = new Map<string, string>();
        const truncated = messages
          .filter((m) => m.createdAt >= msg.createdAt)
          .sort((a, b) => a.createdAt - b.createdAt);
        for (const m of truncated) {
          const srcId = m.editsArtifactMessageId;
          const html = m.priorArtifactHtml;
          if (!srcId || typeof html !== "string") continue;
          // Source itself is being truncated → no restoration needed.
          if (!survivingIds.has(srcId)) continue;
          if (restorations.has(srcId)) continue;
          restorations.set(srcId, html);
        }
        const restoredById = new Map<string, StoredMessage>();
        for (const [srcId, html] of restorations) {
          try {
            const source = await getMessage(srcId);
            if (!source) continue;
            const entry = source.proposedVfs?.entry;
            const restored: StoredMessage = {
              ...source,
              // In-place rewrite of the source artifact - mark edited so the
              // restore survives the next account-sync pull.
              editedAt: Date.now(),
              proposedArtifact: source.proposedArtifact
                ? { ...source.proposedArtifact, html, streaming: false }
                : source.proposedArtifact,
              proposedVfs:
                source.proposedVfs && entry
                  ? {
                      ...source.proposedVfs,
                      files: { ...source.proposedVfs.files, [entry]: html },
                      streaming: false,
                    }
                  : source.proposedVfs,
            };
            await putMessage(restored);
            restoredById.set(srcId, restored);
          } catch (err) {
            console.error("revert: artifact restore failed", err);
          }
        }

        // Truncate state synchronously so the UI updates immediately, then
        // mirror the deletion to IDB. Either ordering is safe — the IDB layer
        // is the source of truth on next hydrate, and the in-memory pruning
        // matches what hydrate would produce after the delete completes.
        setMessages((prev) =>
          prev
            .filter((m) => m.createdAt < msg.createdAt)
            .map((m) => restoredById.get(m.id) ?? m)
        );
        if (restoredById.size > 0 && onRevertInlineArtifact) {
          for (const srcId of restoredById.keys()) {
            try {
              onRevertInlineArtifact(srcId);
            } catch (err) {
              console.error("revert: inline-artifact callback failed", err);
            }
          }
        }
        try {
          await deleteMessagesFrom(chatId, msg.createdAt);
        } catch (err) {
          console.error("revert: idb truncate failed", err);
        }
      } finally {
        setReverting(false);
        setRevertTarget(null);
      }
    },
    [chatId, messages, onRevertInlineArtifact, onRevertToVersion, templateVersion]
  );

  // Pending retry payload — populated by `retry` once the errored pair has
  // been deleted from state, drained by the effect below which re-issues
  // `send` against the now-cleaned-up message list.
  const queuedRetryRef = useRef<{
    text: string;
    images: AttachedImage[];
    pdfs: AttachedPdf[];
    csvs: AttachedCsv[];
  } | null>(null);

  // Retry an errored assistant turn. We strip the errored assistant message
  // AND the user message that prompted it, then re-issue the prompt — this
  // way the wire payload sent on retry is identical to the original (the
  // composed-with-error pair never reaches the server) and there's no chance
  // of accumulating stale duplicates if the user retries multiple times.
  const retry = useCallback(
    (assistantId: string) => {
      const idx = messages.findIndex((m) => m.id === assistantId);
      if (idx <= 0) return;
      const assistant = messages[idx];
      if (assistant.role !== "assistant" || !assistant.error) return;

      let userIdx = idx - 1;
      while (userIdx >= 0 && messages[userIdx].role !== "user") userIdx--;
      if (userIdx < 0) return;
      const userMsg = messages[userIdx];
      const text = userMsg.content;
      const images = userMsg.images ?? [];
      const pdfs = userMsg.pdfs ?? [];
      const csvs = userMsg.csvs ?? [];
      if (!text.trim() && images.length === 0 && pdfs.length === 0 && csvs.length === 0) return;

      const removeIds = new Set([assistantId, userMsg.id]);
      // Queue BEFORE the setMessages so the drain effect sees the payload on
      // its very first run after the re-render. Previously the queue was
      // assigned after `await`-ing the IDB deletes, which left a window where
      // React could commit the messages update — firing the drain effect with
      // queuedRetryRef.current still null — and then nothing else woke the
      // effect, so the retry sat parked until some unrelated state change
      // (typing, focus, an incoming event) finally unblocked it. That's the
      // "pressing retry takes forever" symptom.
      queuedRetryRef.current = { text, images, pdfs, csvs };
      setMessages((prev) => prev.filter((m) => !removeIds.has(m.id)));
      // IDB cleanup is fire-and-forget — the in-memory pruning above already
      // matches what the next hydrate would produce, so awaiting only delays
      // the retry without affecting user-visible state. Best-effort failures
      // are fine; the next hydrate writes back to a consistent shape.
      void Promise.all([
        deleteMessage(assistantId).catch(() => {}),
        deleteMessage(userMsg.id).catch(() => {}),
      ]);
    },
    [messages]
  );

  // Continue an errored OR cut-off assistant turn IN PLACE so the partial
  // content the model already produced extends into the SAME message bubble —
  // the user can pin / save / share the result as one response instead of a
  // chain of truncated fragments + continuations.
  //
  // Two callers reach here: an errored turn (network/worker failure mid-stream)
  // and a turn that completed normally but hit the model's output-token ceiling
  // (`usage.truncated`), so the reply reads as if it stops mid-thought. Both
  // want identical behavior — re-prompt with the visible partial as a prefill
  // and stream the continuation onto the end — so they share this path.
  //
  // Wire flow: we build a fresh /api/chat request whose `messages` array
  // omits this errored turn (it would be filtered by `!m.error` anyway), and
  // pass the partial text on `continueAssistantContent`. The route appends
  // it back into `conv` as a prior assistant turn followed by the same
  // "continue exactly where it stopped" system line the worker uses on
  // mid-stream handoff. On handshake we attach the returned streamId to the
  // EXISTING assistant message and hand it to `resumeStream` — its consumer
  // initializes from `assistantMsg.content`, so deltas append seamlessly.
  const continueGeneration = useCallback(
    async (assistantId: string) => {
      if (pending) return;
      const idx = messages.findIndex((m) => m.id === assistantId);
      if (idx < 0) return;
      const assistant = messages[idx];
      if (assistant.role !== "assistant") return;
      // Reachable for errored turns, turns cut off at the output-token ceiling
      // (`usage.truncated`), and a manual "Continue message" menu action on any
      // completed turn the user judges incomplete. All we strictly require is
      // some visible partial text to prefill and extend — the empty-content
      // guard below covers the rest.
      const partial = wireContentFor(assistant);
      if (!partial.trim()) return;

      // Clear the error and stale stream metadata up front so the spinner /
      // resume code reads a clean message. We keep content, events, thinking,
      // proposedArtifact, etc. — those are what we're extending.
      const cleared: StoredMessage = {
        ...assistant,
        error: undefined,
        streamId: undefined,
        streamCursor: undefined,
      };
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? cleared : m))
      );
      writer.schedule(assistantId, cleared);
      writer.flushNow();

      // Wire payload: every preceding non-summarized, non-errored turn, in
      // order. This message is currently non-errored (we just cleared it),
      // but we still drop it explicitly because the route will re-add it via
      // `continueAssistantContent` — including it twice would have the model
      // continue from itself.
      const wirePayload: Array<{ role: StoredMessage["role"]; content: string }> =
        messages
          .filter((m) => !m.summarizedInto && !m.error && m.id !== assistantId)
          .map((m) => wireMsgFor(m));
      if (wirePayload.length === 0) return;

      setPending(true);
      const startedAt = Date.now();
      setProgress({ messageId: assistantId, phase: "sending", startedAt });

      const responseFormat = responseFormatFor(target, hasVfs);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            model,
            webSearch: settings.webSearch,
            imageSearch: settings.imageSearch,
            advancedWeb: settings.advancedWeb === true,
            codeExec: settings.codeExec === true,
            connectors: activeConnectors(settings.connectors, settings.enabledConnectorIds),
            appCreation: settings.appCreation === true,
            research: settings.research === true,
            ...(settings.novelMode === "short" ||
            settings.novelMode === "standard" ||
            settings.novelMode === "long"
              ? { novelMode: settings.novelMode }
              : {}),
            ...(settings.planMode === true ? { planMode: true } : {}),
            ...(settings.flyWorker !== false ? { flyWorker: true } : {}),
            ...(settings.chatPersonaId ? { chatPersonaId: settings.chatPersonaId } : {}),
            ...describerWire(settings),
            messages: wirePayload,
            responseFormat,
            ...(settings.runpodEndpointId
              ? { runpodEndpointId: settings.runpodEndpointId }
              : {}),
            ...(extraSystem && extraSystem.trim()
              ? { system: extraSystem.trim() }
              : {}),
            ...(responseFormat === "vfs-edit" ||
            responseFormat === "note-edit" ||
            responseFormat === "artifact-edit"
              ? { files: templateFiles, entry: templateEntry }
              : {}),
            continueAssistantContent: partial,
          }),
        });

        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (!res.ok) {
          const errBody = await res
            .json()
            .catch(() => ({ error: `HTTP ${res.status}` }));
          const errored: StoredMessage = {
            ...cleared,
            error: errBody.error ?? "Continue failed.",
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? errored : m))
          );
          writer.schedule(assistantId, errored);
          return;
        }

        const handshake = (await res.json()) as { streamId?: string };
        if (!handshake.streamId) {
          const errored: StoredMessage = {
            ...cleared,
            error: "Server did not return a streamId.",
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? errored : m))
          );
          writer.schedule(assistantId, errored);
          return;
        }

        const withStream: StoredMessage = {
          ...cleared,
          streamId: handshake.streamId,
          streamCursor: 0,
        };
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? withStream : m))
        );
        writer.schedule(assistantId, withStream);
        writer.flushNow();

        const resumer = resumeStreamRef.current;
        if (resumer) {
          await resumer(withStream);
        } else {
          // Ref is wired on every render, so this is unreachable in practice.
          // Fall back to the auto-resume effect via didResumeRef on next render.
          didResumeRef.current = false;
        }
      } catch (err) {
        const errorText = err instanceof Error ? err.message : "Network error";
        const errored: StoredMessage = { ...cleared, error: errorText };
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? errored : m))
        );
        writer.schedule(assistantId, errored);
      } finally {
        writer.flushNow();
        setPending(false);
        setProgress(null);
      }
    },
    [
      hasVfs,
      messages,
      model,
      pending,
      settings.webSearch,
      settings.imageSearch,
      settings.advancedWeb,
      settings.connectors,
      settings.enabledConnectorIds,
      settings.research,
      settings.novelMode,
      settings.planMode,
      settings.runpodEndpointId,
      target,
      templateEntry,
      templateFiles,
      writer,
    ]
  );

  // Continue a plan-paused OR plan-stalled assistant turn. Two entry paths:
  //   1. Graceful pause: the final worker threw PlanPausedNeedsContinueError,
  //      meta is `error: "plan_paused"`, plan.pausedAt is set on the bubble.
  //   2. Stalled mid-plan: a worker got hard-killed by Vercel at maxDuration
  //      before it could throw the graceful-pause error, so plan.pausedAt is
  //      NOT set, the bubble carries a regular `error`, and some plan steps
  //      are still un-done. We still route through the plan-continue route
  //      because the orchestrator can resume from the cached step results
  //      and the last handoff's checkpoint — same recovery, different cause.
  //
  // Either way, the route resets workerSeq=1 (fresh ~15min budget) and re-
  // enters the orchestrator; cached steps in the Redis scratchpad skip, and
  // the same streamId is reused so the events buffer continuation is seamless.
  const continuePlan = useCallback(
    async (assistantId: string) => {
      if (pending) return;
      const idx = messages.findIndex((m) => m.id === assistantId);
      if (idx < 0) return;
      const assistant = messages[idx];
      if (assistant.role !== "assistant") return;
      if (!assistant.plan) return;
      const wasPaused = !!assistant.plan.pausedAt;
      const hasUnfinishedSteps = assistant.plan.steps.some(
        (s) => s.status !== "done"
      );
      // Graceful-pause OR stalled-with-work-remaining. If neither holds, the
      // plan is already done — Continue is a no-op.
      if (!wasPaused && !(assistant.error && hasUnfinishedSteps)) return;

      // Clear pausedAt locally up front so the button doesn't flicker; the
      // server will emit `plan_resumed` once its worker is live and the
      // SSE handler will re-clear it then (idempotent).
      const cleared: StoredMessage = {
        ...assistant,
        plan: { ...assistant.plan, pausedAt: undefined },
        error: undefined,
      };
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? cleared : m))
      );
      writer.schedule(assistantId, cleared);
      writer.flushNow();

      setPending(true);
      const startedAt = Date.now();
      setProgress({ messageId: assistantId, phase: "sending", startedAt });

      // Cold-resume path: re-prompt /api/chat with a partial synthesized
      // from the bubble's visible plan state, so the model sees the prior
      // output as its own and continues from the next un-done step. Used
      // when (a) the bubble has no streamId (TTL'd out, or never registered
      // because the chat is old) and (b) as a fallback when the hot path's
      // plan-continue 410s because the server-side checkpoint is gone
      // (e.g. a UserStoppedError exit that didn't checkpoint, or the
      // scratchpad got evicted).
      const runColdResume = async (): Promise<void> => {
        try {
          const partial = synthesizePlanResumePartial(cleared);
          const wirePayload: Array<{
            role: StoredMessage["role"];
            content: string;
          }> = messages
            .filter(
              (m) => !m.summarizedInto && !m.error && m.id !== assistantId
            )
            .map((m) => wireMsgFor(m, target));
          if (wirePayload.length === 0) {
            const errored: StoredMessage = {
              ...cleared,
              error: "Nothing to continue from.",
            };
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? errored : m))
            );
            writer.schedule(assistantId, errored);
            return;
          }
          const responseFormat = responseFormatFor(target, hasVfs);
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              model,
              webSearch: settings.webSearch,
              imageSearch: settings.imageSearch,
              advancedWeb: settings.advancedWeb === true,
              codeExec: settings.codeExec === true,
              connectors: activeConnectors(settings.connectors, settings.enabledConnectorIds),
              appCreation: settings.appCreation === true,
              research: settings.research === true,
              ...(settings.novelMode === "short" ||
              settings.novelMode === "standard" ||
              settings.novelMode === "long"
                ? { novelMode: settings.novelMode }
                : {}),
              // Explicitly stay OUT of plan mode on cold resume. Re-entering
              // plan mode kicks the planner from scratch, which emits a
              // plan_start that overwrites the bubble's existing plan card
              // with a fresh (and usually shorter) plan — the user sees their
              // 5/10 paused progress vanish, replaced by a brand-new 4/5
              // structure that ignores the cached step results we just
              // synthesized. The model has the full plan recap in its
              // continueAssistantContent already; it doesn't need a planner
              // to know what's left.
              planMode: false,
              // Carry the Fly toggle through cold resume too. Without this
              // a paused-and-cold-restarted plan in Fly mode silently falls
              // back to the Vercel waitUntil path — same maxDuration cap
              // the user opted out of when they enabled Fly mode.
              ...(settings.flyWorker !== false ? { flyWorker: true } : {}),
              ...(settings.chatPersonaId ? { chatPersonaId: settings.chatPersonaId } : {}),
              ...describerWire(settings),
              messages: wirePayload,
              responseFormat,
              ...(settings.runpodEndpointId
                ? { runpodEndpointId: settings.runpodEndpointId }
                : {}),
              ...(extraSystem && extraSystem.trim()
                ? { system: extraSystem.trim() }
                : {}),
              ...(responseFormat === "vfs-edit" ||
              responseFormat === "note-edit" ||
              responseFormat === "artifact-edit"
                ? { files: templateFiles, entry: templateEntry }
                : {}),
              continueAssistantContent: partial,
            }),
          });
          if (res.status === 401) {
            window.location.href = "/login";
            return;
          }
          if (!res.ok) {
            const errBody = await res
              .json()
              .catch(() => ({ error: `HTTP ${res.status}` }));
            const errored: StoredMessage = {
              ...cleared,
              error: errBody.error ?? "Continue plan failed.",
            };
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? errored : m))
            );
            writer.schedule(assistantId, errored);
            return;
          }
          const handshake = (await res.json()) as { streamId?: string };
          if (!handshake.streamId) {
            const errored: StoredMessage = {
              ...cleared,
              error: "Server did not return a streamId.",
            };
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? errored : m))
            );
            writer.schedule(assistantId, errored);
            return;
          }
          const withStream: StoredMessage = {
            ...cleared,
            streamId: handshake.streamId,
            streamCursor: 0,
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? withStream : m))
          );
          writer.schedule(assistantId, withStream);
          writer.flushNow();
          const resumer = resumeStreamRef.current;
          if (resumer) {
            await resumer(withStream);
          } else {
            didResumeRef.current = false;
          }
        } catch (err) {
          const errorText = err instanceof Error ? err.message : "Network error";
          const errored: StoredMessage = { ...cleared, error: errorText };
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? errored : m))
          );
          writer.schedule(assistantId, errored);
        }
      };

      if (!assistant.streamId) {
        try {
          await runColdResume();
        } finally {
          writer.flushNow();
          setPending(false);
          setProgress(null);
        }
        return;
      }

      try {
        const res = await fetch(
          `/api/chat/plan-continue/${encodeURIComponent(assistant.streamId)}`,
          { method: "POST" }
        );
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (!res.ok) {
          // Server-side state is gone — fall back to cold resume instead of
          // dumping the raw 4xx to the user. The cold path synthesizes a
          // partial from the bubble's visible plan and re-prompts /api/chat,
          // so it doesn't need the checkpoint / scratchpad the hot path
          // requires. Triggered by:
          //   410 "Stream meta expired."
          //   410 "No checkpoint to resume from."   (e.g. UserStoppedError exit)
          //   409 "No plan to continue (scratchpad empty or evicted)."
          // Anything else (401 already handled above, 500-class server errors)
          // we still surface so the user sees the real failure.
          if (res.status === 410 || res.status === 409) {
            await runColdResume();
            return;
          }
          const errBody = await res
            .json()
            .catch(() => ({ error: `HTTP ${res.status}` }));
          const errored: StoredMessage = {
            ...assistant,
            error: errBody.error ?? "Continue plan failed.",
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? errored : m))
          );
          writer.schedule(assistantId, errored);
          return;
        }
        // The server is now writing fresh events into the same streamId.
        // Reuse the existing resumer to pick them up from streamCursor.
        const resumer = resumeStreamRef.current;
        if (resumer) {
          await resumer(cleared);
        } else {
          didResumeRef.current = false;
        }
      } catch (err) {
        const errorText = err instanceof Error ? err.message : "Network error";
        const errored: StoredMessage = { ...assistant, error: errorText };
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? errored : m))
        );
        writer.schedule(assistantId, errored);
      } finally {
        writer.flushNow();
        setPending(false);
        setProgress(null);
      }
    },
    [
      extraSystem,
      hasVfs,
      messages,
      model,
      pending,
      settings.flyWorker,
      settings.imageSearch,
      settings.advancedWeb,
      settings.connectors,
      settings.enabledConnectorIds,
      settings.novelMode,
      settings.research,
      settings.runpodEndpointId,
      settings.webSearch,
      target,
      templateEntry,
      templateFiles,
      writer,
    ]
  );

  // User-initiated pause of a (running OR stuck) plan. Two cases:
  //
  // 1. Live worker — POST /api/chat/plan-pause writes a flag into the
  //    per-stream scratchpad. The orchestrator polls it between steps and
  //    the step executor between rounds; either throws
  //    PlanPausedNeedsContinueError, which routes through the same path as
  //    a chain-exhaust pause: `plan_paused` event fires, meta becomes
  //    error="plan_paused", plan.pausedAt is set on the bubble, and the
  //    existing "Continue plan" button picks up exactly where it left off
  //    — no replanning, cached steps stay cached.
  //
  // 2. Cold / dead stream — the row may have no `streamId` (handshake
  //    never persisted), the Redis meta may have TTL'd out (yesterday's
  //    stuck plan), or the worker may have been hard-killed by Vercel
  //    before it could throw the graceful-pause error. The pause endpoint
  //    would 404 / 409 / 410 here. We fall back to stamping the row with
  //    `error = "Stopped by user."` locally, which routes through the
  //    existing stalled-mid-plan affordance: Continue plan appears,
  //    continuePlan() uses its cold-resume path to synthesize a partial
  //    from the visible plan state and rejoin without replanning.
  //
  // Always abort any live SSE first (the auto-resumer would otherwise keep
  // trying to reconnect to a now-paused stream) and stamp `stoppingMessageId`
  // so the button shows "Stopping…" until the bubble settles.
  const stopPlan = useCallback(
    async (assistantId: string) => {
      const assistant = messages.find((m) => m.id === assistantId);
      if (!assistant || assistant.role !== "assistant") return;
      if (stoppingMessageId === assistantId) return;
      setStoppingMessageId(assistantId);

      // Tear down the in-flight SSE (if any). Live reader will surface a
      // "Cancelled by user." error via consumeChatStream's catch block; the
      // effect below clears the stopping flag once the row settles.
      abortRef.current?.abort();

      // Helper: fall back to a local-only stop so the user gets a Continue
      // affordance immediately even without a working server-side stream.
      const stopLocally = () => {
        const stopped: StoredMessage = {
          ...assistant,
          error: "Stopped by user.",
          streamCursor: undefined,
        };
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? stopped : m))
        );
        writer.schedule(assistantId, stopped);
        writer.flushNow();
        setStoppingMessageId(null);
      };

      if (!assistant.streamId) {
        stopLocally();
        return;
      }

      try {
        const res = await fetch(
          `/api/chat/plan-pause/${encodeURIComponent(assistant.streamId)}`,
          { method: "POST" }
        );
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (!res.ok) {
          // 409 (not running) / 410 (meta expired) — the server has nothing
          // left to pause. Anything else is an unexpected failure. In both
          // cases the row is effectively dead, so flip to the local-error
          // state so the user gets Continue without having to wait for a
          // stall detector that's already timed out.
          stopLocally();
          return;
        }
        // 202 — worker will observe the flag on its next between-rounds /
        // between-steps check and emit `plan_paused`. The clearing effect
        // below will drop the stopping flag once pausedAt or error lands.
      } catch {
        stopLocally();
      }
    },
    [messages, stoppingMessageId, writer]
  );

  // Clear the `stoppingMessageId` once the worker has actually paused or
  // the stream has otherwise terminated. Tracks pausedAt (graceful pause
  // landed), error (terminal), or pending flipping false (the row no
  // longer has a live worker).
  useEffect(() => {
    if (!stoppingMessageId) return;
    const m = messages.find((x) => x.id === stoppingMessageId);
    if (!m) {
      setStoppingMessageId(null);
      return;
    }
    if (m.plan?.pausedAt || m.error || !pending) {
      setStoppingMessageId(null);
    }
  }, [messages, pending, stoppingMessageId]);

  // Continue a stream that's still in-flight but has gone silent — no SSE
  // events for STREAM_STALL_MS while the bubble still shows the spinner.
  // This is distinct from the graceful-paused / hard-errored shapes the
  // standard Continue button covers: here pausedAt is unset, msg.error is
  // unset, the SSE reader is just blocked waiting on the next chunk.
  //
  // The recovery is two-step (abort, then resume) because both continuePlan
  // and continueGeneration require msg.error to be set so the auto-resume
  // effect (filters by !m.error) doesn't fight them. We queue the desired
  // resume kind in a ref, fire abort — which makes consumeChatStream's
  // catch-block stamp the bubble with "Cancelled by user." and clear the
  // pending flag — and the drain-effect below then runs the queued resume
  // against the now-correctly-shaped message.
  const queuedStalledContinueRef = useRef<
    | { kind: "plan" | "generation"; messageId: string }
    | null
  >(null);

  const continueStalled = useCallback(
    (assistantId: string) => {
      const assistant = messages.find((m) => m.id === assistantId);
      if (!assistant || assistant.role !== "assistant") return;
      const hasPlanIncomplete =
        !!assistant.plan &&
        assistant.plan.steps.some((s) => s.status !== "done");
      const hasContent = !!assistant.content?.trim();
      if (hasPlanIncomplete) {
        queuedStalledContinueRef.current = { kind: "plan", messageId: assistantId };
      } else if (hasContent) {
        queuedStalledContinueRef.current = { kind: "generation", messageId: assistantId };
      } else {
        // No plan and no prose yet — there's nothing to resume from. Aborting
        // alone surfaces the standard error + Retry path, which is the right
        // affordance when the stream died before any usable output landed.
        queuedStalledContinueRef.current = null;
      }
      // Fly mode: the local abort kills our SSE but the Fly worker keeps
      // running and burning machine minutes. Worse, the queued resume
      // below would launch a *second* worker while the first is still
      // producing tokens. Tell the original worker to bail at its next
      // safe boundary before we abort the SSE and dispatch the resume.
      // Best-effort: 409/410 means the worker already exited, fine.
      if (settings.flyWorker !== false && assistant.streamId) {
        void fetch(
          `/api/chat/stop/${encodeURIComponent(assistant.streamId)}`,
          { method: "POST" }
        ).catch(() => {});
      }
      abortRef.current?.abort();
    },
    [messages, settings.flyWorker]
  );

  // Continue an errored COUNCIL turn. The cached member positions are
  // already in the assistant's `events` array (that's what the council
  // disclosure renders), so we extract them and ship them to a fresh
  // /api/council/run as `priorPositions`. The server pre-populates the
  // per-stream scratchpad so the orchestrator skips those members and only
  // runs the missing rounds + synthesizer. Doesn't depend on the prior
  // streamId being preserved or the Redis TTL still being alive — works for
  // any council error as long as the bubble's events survived in IDB.
  const continueCouncil = useCallback(
    async (assistantId: string) => {
      if (pending) return;
      const assistant = messages.find((m) => m.id === assistantId);
      if (!assistant || assistant.role !== "assistant" || !assistant.error) return;

      // The framing message holds the council roster + situation + answers
      // captured at launch. Without it we can't reconstruct the same
      // /api/council/run body.
      const framingMsg = messages.find(
        (m) =>
          m.kind === "council-framing" &&
          m.councilFraming?.launchedAssistantId === assistantId
      );
      if (!framingMsg || !framingMsg.councilFraming) return;
      const framing = framingMsg.councilFraming;
      const members = framing.members;
      if (!members || members.length === 0) return;

      // Extract already-completed positions from the bubble's events. Each
      // council member emits a paired `tool_call` (with memberId in args)
      // and `tool_result` (summary = position text). The call's
      // `council:member:{memberId}:r{round}` name is the cache key.
      const COUNCIL_NAME_RE = /^council:member:([^:]+):r(\d+)$/;
      const positionByKey = new Map<
        string,
        { memberId: string; round: number; position: string }
      >();
      let maxRoundSeen = 0;
      for (const e of assistant.events ?? []) {
        const m = COUNCIL_NAME_RE.exec(e.name);
        if (!m) continue;
        const round = Number(m[2]);
        if (Number.isFinite(round) && round > maxRoundSeen) maxRoundSeen = round;
        if (e.kind !== "result") continue;
        if (typeof e.summary !== "string" || !e.summary.trim()) continue;
        if (e.error) continue;
        positionByKey.set(`${m[1]}:r${m[2]}`, {
          memberId: m[1],
          round,
          position: e.summary,
        });
      }
      const priorPositions = Array.from(positionByKey.values());

      // Re-derive debateRounds from the bubble itself rather than from the
      // user's CURRENT settings — they may have changed the slider since,
      // and using the current value would make the new worker run a
      // differently-shaped council than the original. Whatever the highest
      // round number we saw an attempt at is the round count the original
      // launch was configured for (members run in lockstep, so an attempt
      // at round N means rounds 1..N-1 all completed).
      const inferredDebateRounds =
        maxRoundSeen > 0
          ? Math.max(0, maxRoundSeen - 1)
          : settings.councilDebateRounds ?? 1;

      // Prefer the synthesizer model the bubble was originally launched
      // with — same reasoning as debateRounds. Only fall back to current
      // settings / chat model if we don't have one recorded.
      const synthesizerModel =
        assistant.model || settings.councilSynthesizerModel?.trim() || model;

      const wirePayload = messages
        .filter(
          (m) =>
            !m.summarizedInto &&
            !m.error &&
            m.kind !== "council-framing" &&
            m.kind !== "research-framing" &&
            m.kind !== "research-result" &&
            m.kind !== "novel-outline-edit" &&
            m.id !== framingMsg.id &&
            m.id !== assistantId
        )
        .map((m) => wireMsgFor(m));
      if (wirePayload.length === 0) return;

      // Clear error/streamId/cursor/content so the bubble flips back to
      // "running" UI and the resumer reads the new stream's events from
      // index 0. KEEP `events` — the new worker's cached re-emit for the
      // pre-seeded positions is idempotent at the rendering layer
      // (groupCouncilEvents dedupes by member+round), so leaving them in
      // place avoids the bubble's count flashing from 28 → 0 → back up.
      const cleared: StoredMessage = {
        ...assistant,
        error: undefined,
        streamId: undefined,
        streamCursor: undefined,
        content: "",
      };
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? cleared : m))
      );
      writer.schedule(assistantId, cleared);
      writer.flushNow();

      setPending(true);
      const startedAt = Date.now();
      setProgress({ messageId: assistantId, phase: "sending", startedAt });

      try {
        const res = await fetch("/api/council/run", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            messages: wirePayload,
            members,
            situationId: framing.situationId,
            debateRounds: inferredDebateRounds,
            synthesizerModel,
            framing: {
              rationale: framing.rationale,
              questions: framing.questions,
              answers: framing.answers ?? {},
            },
            ...(settings.runpodEndpointId
              ? { runpodEndpointId: settings.runpodEndpointId }
              : {}),
            ...(priorPositions.length > 0 ? { priorPositions } : {}),
          }),
        });
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (!res.ok) {
          const errBody = await res
            .json()
            .catch(() => ({ error: `HTTP ${res.status}` }));
          const errored: StoredMessage = {
            ...cleared,
            error: errBody.error ?? "Continue failed.",
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? errored : m))
          );
          writer.schedule(assistantId, errored);
          return;
        }
        const handshake = (await res.json()) as { streamId?: string };
        if (!handshake.streamId) {
          const errored: StoredMessage = {
            ...cleared,
            error: "Server did not return a streamId.",
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? errored : m))
          );
          writer.schedule(assistantId, errored);
          return;
        }

        const withStream: StoredMessage = {
          ...cleared,
          streamId: handshake.streamId,
          streamCursor: 0,
        };
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? withStream : m))
        );
        writer.schedule(assistantId, withStream);
        writer.flushNow();

        const resumer = resumeStreamRef.current;
        if (resumer) {
          await resumer(withStream);
        } else {
          didResumeRef.current = false;
        }
      } catch (err) {
        const errorText = err instanceof Error ? err.message : "Network error";
        const errored: StoredMessage = { ...cleared, error: errorText };
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? errored : m))
        );
        writer.schedule(assistantId, errored);
      } finally {
        writer.flushNow();
        setPending(false);
        setProgress(null);
      }
    },
    [
      messages,
      model,
      pending,
      settings.councilDebateRounds,
      settings.councilSynthesizerModel,
      settings.runpodEndpointId,
      writer,
    ]
  );

  // Manual escape hatch for when a vfs-edit message is wedged on the
  // "Editing files" spinner — e.g. the stream died after Build/Finish ran but
  // before `vfs_final` arrived. Tapping the pill clears `streaming` so the
  // build status / Save button surface, and re-publishes the proposed files
  // to the parent so the preview reflects the latest edits.
  const forceCompleteVfs = useCallback(
    async (id: string) => {
      let updated: StoredMessage | undefined;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== id || !m.proposedVfs?.streaming) return m;
          updated = { ...m, proposedVfs: { ...m.proposedVfs, streaming: false } };
          return updated;
        })
      );
      if (updated) {
        try {
          await putMessage(updated);
        } catch {
          // best-effort persistence; UI state is already consistent.
        }
        if (updated.proposedVfs) {
          onPendingVfs?.(updated.proposedVfs.files, updated.proposedVfs.entry);
        }
      }
    },
    [onPendingVfs]
  );

  // Council: persist updated answers from the framing card. Throttled by
  // React batching + the IDB writer scheduler; keystrokes feel jankless.
  const updateFramingAnswers = useCallback(
    (messageId: string, answers: Record<string, string>) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId || m.kind !== "council-framing" || !m.councilFraming) {
            return m;
          }
          const next: StoredMessage = {
            ...m,
            councilFraming: { ...m.councilFraming, answers },
          };
          writer.schedule(next.id, next);
          return next;
        })
      );
    },
    [writer]
  );

  // Research: same shape as updateFramingAnswers but writes the
  // researchFraming sub-field. Kept separate so the type of the field being
  // updated is obvious at the callsite.
  const updateResearchResult = useCallback(
    (messageId: string, payload: StructuredResearchPayload) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId || m.kind !== "research-result") return m;
          // In-place edit: bump editedAt so account-sync marks the chat dirty
          // and pushes the bundle — otherwise a completed structured-research
          // run never syncs to the user's other devices (same class of bug as
          // the Multi Research card below).
          const next: StoredMessage = {
            ...m,
            researchResult: payload,
            editedAt: Date.now(),
          };
          writer.schedule(next.id, next);
          return next;
        })
      );
      // Persist immediately rather than via the rAF-batched scheduler: a
      // research run can settle (and its streamId/records land here) while the
      // tab is backgrounded / phone locked, when requestAnimationFrame is
      // suspended and the batched write would never flush — losing the result
      // and the resume handle the user came back for.
      writer.flushNow();
    },
    [writer]
  );

  // Persist a Multi Research card in place — drafting → review → running → done,
  // and each report's status/report/streamId as its run settles. Flush now for
  // the same backgrounded-tab reason as updateResearchResult above.
  const updateMultiResearch = useCallback(
    (messageId: string, payload: MultiResearchPayload) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId || m.kind !== "multi-research") return m;
          // In-place edit: bump editedAt so account-sync marks the chat dirty
          // and pushes the bundle. Without it, a report completing here never
          // moves the chat's max activity time, so flushChatTouch no-ops and
          // the finished report never reaches the user's other devices.
          const next: StoredMessage = {
            ...m,
            multiResearch: payload,
            editedAt: Date.now(),
          };
          writer.schedule(next.id, next);
          return next;
        })
      );
      writer.flushNow();
    },
    [writer]
  );

  // Save one finished Multi Research report to Notes — manual, per report
  // (nothing auto-saves). Mirrors a pinned-note create: the report markdown +
  // its title, tagged with this chat.
  const saveReportToNote = useCallback(
    async (report: MultiResearchReport): Promise<string | undefined> => {
      const body = (report.report ?? "").trim();
      if (!body) return undefined;
      try {
        const id = newId();
        await putPinnedNote({
          id,
          createdAt: Date.now(),
          title: report.title || "Research report",
          chatId,
          chatTitle: chats?.find((c) => c.id === chatId)?.title,
          messageMarkdown: body,
        });
        return id;
      } catch {
        return undefined;
      }
    },
    [chatId, chats]
  );

  // Plain-conversation transcript (no card rows) that grounds Multi Research
  // drafting/revise. Bounded so a long chat can't blow the draft request.
  const multiResearchTranscript = useMemo(() => {
    return messages
      .filter(
        (m) =>
          !m.kind &&
          (m.role === "user" || m.role === "assistant") &&
          (m.content ?? "").trim().length > 0
      )
      .slice(-20)
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n")
      .slice(0, 12_000);
  }, [messages]);

  // A Multi Research round with reports still running locks the composer — the
  // user asked to not be able to chat until every report finishes. The card's
  // own "Stop all" (rendered just above the composer) is the escape hatch.
  const multiResearchRunning = useMemo(
    () =>
      messages.some(
        (m) => m.kind === "multi-research" && m.multiResearch?.stage === "running"
      ),
    [messages]
  );

  const updateResearchFramingAnswers = useCallback(
    (messageId: string, answers: Record<string, string>) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (
            m.id !== messageId ||
            m.kind !== "research-framing" ||
            !m.researchFraming
          ) {
            return m;
          }
          const next: StoredMessage = {
            ...m,
            researchFraming: { ...m.researchFraming, answers },
          };
          writer.schedule(next.id, next);
          return next;
        })
      );
    },
    [writer]
  );

  // Council: user clicked "Run council" inside the framing card. Append a
  // fresh assistant placeholder, POST to /api/council/run, and reuse the
  // existing resume plumbing — the council orchestrator emits the same SSE
  // shapes consumeChatStream already drains.
  const launchCouncil = useCallback(
    async (framingMessageId: string, answers: Record<string, string>) => {
      const framingMsg = messages.find(
        (m) => m.id === framingMessageId && m.kind === "council-framing"
      );
      if (!framingMsg || !framingMsg.councilFraming) return;
      if (framingMsg.councilFraming.launchedAssistantId) return; // already launched
      // Same cross-chat guard as launchResearch: never launch a framing
      // card that belongs to a different chat than this component.
      if (framingMsg.chatId !== chatId) return;

      const members = framingMsg.councilFraming.members;
      if (!members || members.length === 0) {
        // Surface the misconfiguration on the framing card itself so the user
        // knows where to fix it.
        setMessages((prev) =>
          prev.map((m) =>
            m.id === framingMessageId
              ? {
                  ...m,
                  error:
                    "No council members configured. Open Preferences → Council to add some.",
                }
              : m
          )
        );
        return;
      }

      const synthesizerModel =
        settings.councilSynthesizerModel?.trim() || model;

      // Wire payload — same compaction-aware filter the chat send uses, but
      // also strips any framing rows (the LLM doesn't need to see them; they
      // re-render server-side from the explicit `framing` field).
      const wirePayload = messages
        .filter(
          (m) =>
            !m.summarizedInto &&
            !m.error &&
            m.kind !== "council-framing" &&
            m.kind !== "research-framing" &&
            m.kind !== "research-result" &&
            m.kind !== "novel-outline-edit" &&
            m.id !== framingMessageId
        )
        .map((m) => wireMsgFor(m));

      const now = Date.now();
      const assistantMsg: StoredMessage = {
        id: newId(),
        chatId,
        role: "assistant",
        content: "",
        createdAt: now,
        model: synthesizerModel,
        events: [],
      };

      // Mark the framing card as launched + persist the final answers so the
      // card flips into its read-only summary state.
      const launchedFraming: StoredMessage = {
        ...framingMsg,
        councilFraming: {
          ...framingMsg.councilFraming,
          answers,
          launchedAssistantId: assistantMsg.id,
        },
      };

      setMessages((prev) => [
        ...prev.map((m) => (m.id === framingMessageId ? launchedFraming : m)),
        assistantMsg,
      ]);
      writer.schedule(launchedFraming.id, launchedFraming);
      void putMessage(assistantMsg);
      setPending(true);
      setProgress({
        messageId: assistantMsg.id,
        phase: "sending",
        startedAt: now,
      });

      try {
        const res = await fetch("/api/council/run", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            messages: wirePayload,
            members,
            situationId: launchedFraming.councilFraming?.situationId,
            debateRounds: settings.councilDebateRounds ?? 1,
            synthesizerModel,
            framing: {
              rationale: launchedFraming.councilFraming?.rationale,
              questions: launchedFraming.councilFraming?.questions,
              answers,
            },
            ...(settings.runpodEndpointId
              ? { runpodEndpointId: settings.runpodEndpointId }
              : {}),
          }),
        });
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (!res.ok) {
          const errBody = await res
            .json()
            .catch(() => ({ error: `HTTP ${res.status}` }));
          const errored: StoredMessage = {
            ...assistantMsg,
            error: errBody.error ?? "Council launch failed.",
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsg.id ? errored : m))
          );
          writer.schedule(assistantMsg.id, errored);
          return;
        }
        const handshake = (await res.json()) as { streamId?: string };
        if (!handshake.streamId) {
          const errored: StoredMessage = {
            ...assistantMsg,
            error: "Server did not return a streamId.",
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsg.id ? errored : m))
          );
          writer.schedule(assistantMsg.id, errored);
          return;
        }
        const withStream: StoredMessage = {
          ...assistantMsg,
          streamId: handshake.streamId,
          streamCursor: 0,
        };
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsg.id ? withStream : m))
        );
        writer.schedule(assistantMsg.id, withStream);
        writer.flushNow();

        const resumer = resumeStreamRef.current;
        if (resumer) {
          await resumer(withStream);
        } else {
          didResumeRef.current = false;
        }
      } catch (err) {
        const errorText = err instanceof Error ? err.message : "Network error";
        const errored: StoredMessage = { ...assistantMsg, error: errorText };
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsg.id ? errored : m))
        );
        writer.schedule(assistantMsg.id, errored);
      } finally {
        writer.flushNow();
        setPending(false);
        setProgress(null);
      }
    },
    [
      chatId,
      messages,
      model,
      settings.councilDebateRounds,
      settings.councilSynthesizerModel,
      settings.runpodEndpointId,
      writer,
    ]
  );

  // Research framing → /api/chat handoff. Mirror of launchCouncil but
  // targets the standard chat endpoint with `researchFraming` in the body —
  // server's planner picks up the answers and scopes its sub-questions
  // accordingly. The user-visible streaming flow is identical to a normal
  // send (handshake → streamId → resumer); the framing row above flips into
  // its launched/read-only state.
  const launchResearch = useCallback(
    async (framingMessageId: string, answers: Record<string, string>) => {
      const framingMsg = messages.find(
        (m) => m.id === framingMessageId && m.kind === "research-framing"
      );
      if (!framingMsg || !framingMsg.researchFraming) return;
      // A framing card carried over from another chat by stale state must
      // never launch here — the assistant turn below is stamped with this
      // component's chatId and would persist under the wrong chat.
      if (framingMsg.chatId !== chatId) return;
      if (framingMsg.researchFraming.launchedAssistantId) return;

      const wirePayload = messages
        .filter(
          (m) =>
            !m.summarizedInto &&
            !m.error &&
            m.kind !== "council-framing" &&
            m.kind !== "research-framing" &&
            m.kind !== "research-result" &&
            m.kind !== "novel-outline-edit" &&
            m.id !== framingMessageId
        )
        .map((m) => wireMsgFor(m));

      const now = Date.now();
      const assistantMsg: StoredMessage = {
        id: newId(),
        chatId,
        role: "assistant",
        content: "",
        createdAt: now,
        model,
        events: [],
      };

      const launchedFraming: StoredMessage = {
        ...framingMsg,
        researchFraming: {
          ...framingMsg.researchFraming,
          answers,
          launchedAssistantId: assistantMsg.id,
        },
      };

      setMessages((prev) => [
        ...prev.map((m) => (m.id === framingMessageId ? launchedFraming : m)),
        assistantMsg,
      ]);
      writer.schedule(launchedFraming.id, launchedFraming);
      void putMessage(assistantMsg);
      setPending(true);
      setProgress({
        messageId: assistantMsg.id,
        phase: "sending",
        startedAt: now,
      });

      const responseFormat = responseFormatFor(target, hasVfs);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            model,
            webSearch: settings.webSearch,
            imageSearch: settings.imageSearch,
            advancedWeb: settings.advancedWeb === true,
            codeExec: settings.codeExec === true,
            connectors: activeConnectors(settings.connectors, settings.enabledConnectorIds),
            research: true,
            ...(settings.chatPersonaId ? { chatPersonaId: settings.chatPersonaId } : {}),
            ...describerWire(settings),
            messages: wirePayload,
            responseFormat,
            researchFraming: {
              rationale: launchedFraming.researchFraming?.rationale,
              questions: launchedFraming.researchFraming?.questions,
              answers,
            },
            ...(settings.runpodEndpointId
              ? { runpodEndpointId: settings.runpodEndpointId }
              : {}),
            ...(extraSystem && extraSystem.trim()
              ? { system: extraSystem.trim() }
              : {}),
            ...(responseFormat === "vfs-edit" ||
            responseFormat === "note-edit" ||
            responseFormat === "artifact-edit"
              ? { files: templateFiles, entry: templateEntry }
              : {}),
          }),
        });
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (!res.ok) {
          const errBody = await res
            .json()
            .catch(() => ({ error: `HTTP ${res.status}` }));
          const errored: StoredMessage = {
            ...assistantMsg,
            error: errBody.error ?? "Research launch failed.",
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsg.id ? errored : m))
          );
          writer.schedule(assistantMsg.id, errored);
          return;
        }
        const handshake = (await res.json()) as { streamId?: string };
        if (!handshake.streamId) {
          const errored: StoredMessage = {
            ...assistantMsg,
            error: "Server did not return a streamId.",
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsg.id ? errored : m))
          );
          writer.schedule(assistantMsg.id, errored);
          return;
        }
        const withStream: StoredMessage = {
          ...assistantMsg,
          streamId: handshake.streamId,
          streamCursor: 0,
        };
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsg.id ? withStream : m))
        );
        writer.schedule(assistantMsg.id, withStream);
        writer.flushNow();

        const resumer = resumeStreamRef.current;
        if (resumer) {
          await resumer(withStream);
        } else {
          didResumeRef.current = false;
        }
      } catch (err) {
        const errorText = err instanceof Error ? err.message : "Network error";
        const errored: StoredMessage = { ...assistantMsg, error: errorText };
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsg.id ? errored : m))
        );
        writer.schedule(assistantMsg.id, errored);
      } finally {
        writer.flushNow();
        setPending(false);
        setProgress(null);
      }
    },
    [
      chatId,
      extraSystem,
      hasVfs,
      messages,
      model,
      settings.research,
      settings.imageSearch,
      settings.advancedWeb,
      settings.connectors,
      settings.enabledConnectorIds,
      settings.runpodEndpointId,
      settings.webSearch,
      target,
      templateEntry,
      templateFiles,
      writer,
    ]
  );

  // Research: run (or re-run) the framer against an existing research-framing
  // card. Shared by the "Frame first" choice button and the "Retry framing"
  // button on a timed-out card. Flips the card into its loading state, does the
  // /api/research/framing handshake, streams the framer's progress, then lands
  // either the scoping questions or a `framerFailed` card. Only auto-launches
  // research when the framer SUCCEEDS and decides no scoping is needed — a
  // timeout/error stops here and lets the user choose.
  const startResearchFraming = useCallback(
    async (framingMsgId: string) => {
      const framingMsg = messages.find(
        (m) => m.id === framingMsgId && m.kind === "research-framing"
      );
      if (!framingMsg) return;
      if (framingMsg.chatId !== chatId) return;
      if (framingMsg.researchFraming?.launchedAssistantId) return;

      // The most recent user turn drives the "Describing N images…" copy.
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const imgCount = lastUser?.images?.length ?? 0;
      const pdfCount = lastUser?.pdfs?.length ?? 0;
      const describesImages = imgCount > 0 && !modelSupportsVision(model);

      const wirePayload = messages
        .filter(
          (m) =>
            !m.summarizedInto &&
            !m.error &&
            m.kind !== "council-framing" &&
            m.kind !== "research-framing" &&
            m.kind !== "research-result" &&
            m.kind !== "novel-outline-edit"
        )
        .map((m) => wireMsgFor(m));

      // Flip the card out of "choice"/"failed" and into the loading state.
      const loadingMsg: StoredMessage = {
        ...framingMsg,
        streamId: undefined,
        streamCursor: undefined,
        researchFraming: {
          rationale: "Framing the question…",
          questions: [],
          answers: {},
          ...(describesImages ? { pendingImageCount: imgCount } : {}),
          ...(pdfCount > 0 ? { pendingPdfCount: pdfCount } : {}),
        },
      };
      setMessages((prev) =>
        prev.map((m) => (m.id === framingMsgId ? loadingMsg : m))
      );
      clearFramingThinking(framingMsgId);
      setPending(true);
      setProgress({
        messageId: framingMsgId,
        phase: "thinking",
        startedAt: Date.now(),
      });

      try {
        const handshakeRes = await fetch("/api/research/framing", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            messages: wirePayload,
            framerModel: model,
            ...(settings.runpodEndpointId
              ? { runpodEndpointId: settings.runpodEndpointId }
              : {}),
          }),
        });

        if (handshakeRes.status === 401) {
          window.location.href = "/login";
          return;
        }

        const handshakeBody = (await handshakeRes
          .json()
          .catch(() => ({}))) as { streamId?: string; error?: string };
        const streamId =
          handshakeRes.ok &&
          typeof handshakeBody.streamId === "string" &&
          handshakeBody.streamId
            ? handshakeBody.streamId
            : undefined;

        if (!streamId) {
          throw new Error(
            handshakeBody.error ?? `Handshake failed (${handshakeRes.status})`
          );
        }

        const withStream: StoredMessage = { ...loadingMsg, streamId };
        setMessages((prev) =>
          prev.map((m) => (m.id === framingMsgId ? withStream : m))
        );
        void putMessage(withStream);

        const ctrl = registerFramingAbort(framingMsgId);
        const result = await streamFramingProgress(
          streamId,
          "research",
          ctrl.signal,
          (t) => appendFramingThinking(framingMsgId, t)
        );
        framingAbortsRef.current.delete(framingMsgId);
        clearFramingThinking(framingMsgId);
        const actions = Array.isArray(result.actions)
          ? result.actions
          : undefined;

        const framerOk =
          result.status >= 200 &&
          result.status < 300 &&
          !!result.framing &&
          Array.isArray(result.framing.questions);

        let framingPayload: NonNullable<StoredMessage["researchFraming"]>;
        if (framerOk && result.framing) {
          // Zero questions here is a legitimate framer decision — preserve its
          // rationale and let the auto-launch below carry it through.
          framingPayload = {
            rationale: result.framing.rationale ?? "",
            questions: result.framing.questions ?? [],
            answers: {},
            ...(actions ? { actions } : {}),
          };
        } else {
          framingPayload = {
            rationale: result.error
              ? `The framer didn't return any scoping questions (${result.error}). Run the research as-is, or retry framing.`
              : "The framer didn't return any scoping questions. Run the research as-is, or retry framing.",
            questions: [],
            answers: {},
            framerFailed: true,
            ...(actions ? { actions } : {}),
          };
        }

        const finalMsg: StoredMessage = {
          ...withStream,
          streamId: undefined,
          streamCursor: undefined,
          researchFraming: framingPayload,
        };
        setMessages((prev) =>
          prev.map((m) => (m.id === framingMsgId ? finalMsg : m))
        );
        void putMessage(finalMsg);

        // Only auto-launch on a CLEAN framer pass with no scoping needed. A
        // timeout/error leaves `framerFailed` set and stops here so the user
        // decides between "Run research as-is" and "Retry framing".
        if (framerOk && framingPayload.questions.length === 0) {
          void launchResearch(framingMsgId, {});
        }
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        console.error("research framing failed", err);
        const failedMsg: StoredMessage = {
          ...framingMsg,
          streamId: undefined,
          streamCursor: undefined,
          researchFraming: {
            rationale:
              "Couldn't reach the framer (" +
              (err instanceof Error ? err.message : "network error") +
              "). Run the research as-is, or retry framing.",
            questions: [],
            answers: {},
            framerFailed: true,
          },
        };
        setMessages((prev) =>
          prev.map((m) => (m.id === framingMsgId ? failedMsg : m))
        );
        void putMessage(failedMsg);
      } finally {
        setPending(false);
        setProgress(null);
      }
    },
    [
      messages,
      chatId,
      model,
      settings.runpodEndpointId,
      appendFramingThinking,
      clearFramingThinking,
      registerFramingAbort,
      launchResearch,
    ]
  );

  // Novel mode: user edited a field in the outline card. Persist immediately
  // so a tab close mid-edit doesn't lose progress — same pattern as
  // updateResearchFramingAnswers.
  const updateNovelOutlineDraft = useCallback(
    (messageId: string, next: NovelOutlineData) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (
            m.id !== messageId ||
            m.kind !== "novel-outline-edit" ||
            !m.novelOutlineEdit
          ) {
            return m;
          }
          const updated: StoredMessage = {
            ...m,
            novelOutlineEdit: { ...m.novelOutlineEdit, outline: next },
          };
          writer.schedule(updated.id, updated);
          return updated;
        })
      );
    },
    [writer]
  );

  // Novel mode: user clicked "Re-outline" with free-text feedback. POST the
  // prior outline + feedback to /api/novel/outline; on response, replace the
  // card's outline with the revised one. Premise research is skipped on
  // revisions (the prior outline already baked it in).
  const reOutlineNovel = useCallback(
    async (
      messageId: string,
      outline: NovelOutlineData,
      feedback: string
    ) => {
      const card = messages.find(
        (m) => m.id === messageId && m.kind === "novel-outline-edit"
      );
      if (!card || !card.novelOutlineEdit) return;
      if (card.novelOutlineEdit.launchedAssistantId) return; // already generated

      const wirePayload = messages
        .filter(
          (m) =>
            !m.summarizedInto &&
            !m.error &&
            m.kind !== "council-framing" &&
            m.kind !== "research-framing" &&
            m.kind !== "research-result" &&
            m.kind !== "novel-outline-edit"
        )
        .map((m) => wireMsgFor(m));

      try {
        const handshakeRes = await fetch("/api/novel/outline", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            model,
            length: card.novelOutlineEdit.length,
            messages: wirePayload,
            priorOutline: outline,
            feedback,
            ...(settings.runpodEndpointId
              ? { runpodEndpointId: settings.runpodEndpointId }
              : {}),
          }),
        });
        if (handshakeRes.status === 401) {
          window.location.href = "/login";
          return;
        }

        // Read the handshake body ONCE: both the success (streamId) and
        // failure (error) branches need it, and Response bodies are
        // single-use streams — calling .json() twice on the same Response
        // throws TypeError on the second await, so the previous "parse on
        // demand" pattern leaked the streamId field whenever the JSON body
        // happened to land before we checked .ok and made the failure path
        // throw "Handshake failed (202)" against a stale empty body.
        const handshakeBody = (await handshakeRes
          .json()
          .catch(() => ({}))) as { streamId?: string; error?: string };
        const streamId =
          handshakeRes.ok &&
          typeof handshakeBody.streamId === "string" &&
          handshakeBody.streamId
            ? handshakeBody.streamId
            : undefined;
        if (!streamId) {
          throw new Error(
            handshakeBody.error ?? `Handshake failed (${handshakeRes.status})`
          );
        }

        // Flip the card into a "revising" state and persist the streamId so
        // a tab close / phone sleep mid-revise reattaches via the auto-
        // resume effect on next mount.
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== messageId || !m.novelOutlineEdit) return m;
            const updated: StoredMessage = {
              ...m,
              streamId,
              novelOutlineEdit: {
                ...m.novelOutlineEdit,
                outline,
                revising: true,
              },
            };
            writer.schedule(updated.id, updated);
            return updated;
          })
        );

        const ctrl = registerNovelOutlineAbort(messageId);
        startNovelOutlineProgressPoll(messageId, streamId, ctrl.signal);
        let result: NovelOutlineResumePayload;
        try {
          result = await resolveNovelOutlineStream(streamId, ctrl.signal);
        } finally {
          clearNovelOutlineAbort(messageId);
        }

        if (
          result.status >= 200 &&
          result.status < 300 &&
          result.outline
        ) {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== messageId || !m.novelOutlineEdit) return m;
              const updated: StoredMessage = {
                ...m,
                error: undefined,
                streamId: undefined,
                streamCursor: undefined,
                novelOutlineEdit: {
                  ...m.novelOutlineEdit,
                  outline: result.outline!,
                  // Keep the original research note/searches — revisions
                  // don't re-search. The user can still see what grounded
                  // the initial outline.
                  revising: false,
                },
              };
              writer.schedule(updated.id, updated);
              return updated;
            })
          );
          setNovelOutlineProgress((prev) => {
            if (!(messageId in prev)) return prev;
            const next = { ...prev };
            delete next[messageId];
            return next;
          });
        } else {
          // Soft fallback: leave the prior outline in place, just turn off
          // the revising flag and surface the error inline on the card.
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== messageId || !m.novelOutlineEdit) return m;
              const updated: StoredMessage = {
                ...m,
                streamId: undefined,
                streamCursor: undefined,
                error: result.error
                  ? `Re-outline failed: ${result.error}`
                  : `Re-outline failed (HTTP ${result.status}).`,
                novelOutlineEdit: {
                  ...m.novelOutlineEdit,
                  revising: false,
                },
              };
              writer.schedule(updated.id, updated);
              return updated;
            })
          );
        }
      } catch (err) {
        // User cancelled — the placeholder was already removed by
        // cancelNovelOutline; bail without smearing an error over the row.
        if ((err as { name?: string })?.name === "AbortError") {
          return;
        }
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== messageId || !m.novelOutlineEdit) return m;
            const updated: StoredMessage = {
              ...m,
              streamId: undefined,
              streamCursor: undefined,
              error:
                "Re-outline network error: " +
                (err instanceof Error ? err.message : String(err)),
              novelOutlineEdit: {
                ...m.novelOutlineEdit,
                revising: false,
              },
            };
            writer.schedule(updated.id, updated);
            return updated;
          })
        );
      }
    },
    [
      messages,
      model,
      settings.runpodEndpointId,
      writer,
      registerNovelOutlineAbort,
      clearNovelOutlineAbort,
      startNovelOutlineProgressPoll,
    ]
  );

  // Novel mode: user clicked "Generate novel" on the outline card. Append a
  // fresh assistant placeholder and POST to /api/chat with the (possibly
  // edited) outline attached as `novelOutline`. The orchestrator skips its
  // outliner stage and streams chapters straight into the bubble — same
  // resume plumbing as a regular send.
  const launchNovel = useCallback(
    async (messageId: string, outline: NovelOutlineData) => {
      const card = messages.find(
        (m) => m.id === messageId && m.kind === "novel-outline-edit"
      );
      if (!card || !card.novelOutlineEdit) return;
      if (card.novelOutlineEdit.launchedAssistantId) return; // already launched

      const wirePayload = messages
        .filter(
          (m) =>
            !m.summarizedInto &&
            !m.error &&
            m.kind !== "council-framing" &&
            m.kind !== "research-framing" &&
            m.kind !== "research-result" &&
            m.kind !== "novel-outline-edit" &&
            m.id !== messageId
        )
        .map((m) => wireMsgFor(m));

      const now = Date.now();
      const assistantMsg: StoredMessage = {
        id: newId(),
        chatId,
        role: "assistant",
        content: "",
        createdAt: now,
        model,
        events: [],
      };

      const launched: StoredMessage = {
        ...card,
        novelOutlineEdit: {
          ...card.novelOutlineEdit,
          outline,
          launchedAssistantId: assistantMsg.id,
          revising: false,
        },
      };

      setMessages((prev) => [
        ...prev.map((m) => (m.id === messageId ? launched : m)),
        assistantMsg,
      ]);
      writer.schedule(launched.id, launched);
      void putMessage(assistantMsg);
      setPending(true);
      setProgress({
        messageId: assistantMsg.id,
        phase: "sending",
        startedAt: now,
      });

      const responseFormat = responseFormatFor(target, hasVfs);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            model,
            webSearch: settings.webSearch,
            imageSearch: settings.imageSearch,
            advancedWeb: settings.advancedWeb === true,
            codeExec: settings.codeExec === true,
            connectors: activeConnectors(settings.connectors, settings.enabledConnectorIds),
            ...(settings.chatPersonaId ? { chatPersonaId: settings.chatPersonaId } : {}),
            ...describerWire(settings),
            messages: wirePayload,
            responseFormat,
            novelMode: card.novelOutlineEdit.length,
            novelOutline: outline,
            ...(settings.runpodEndpointId
              ? { runpodEndpointId: settings.runpodEndpointId }
              : {}),
            ...(extraSystem && extraSystem.trim()
              ? { system: extraSystem.trim() }
              : {}),
            ...(responseFormat === "vfs-edit" ||
            responseFormat === "note-edit" ||
            responseFormat === "artifact-edit"
              ? { files: templateFiles, entry: templateEntry }
              : {}),
          }),
        });
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (!res.ok) {
          const errBody = await res
            .json()
            .catch(() => ({ error: `HTTP ${res.status}` }));
          const errored: StoredMessage = {
            ...assistantMsg,
            error: errBody.error ?? "Novel launch failed.",
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsg.id ? errored : m))
          );
          writer.schedule(assistantMsg.id, errored);
          return;
        }
        const handshake = (await res.json()) as { streamId?: string };
        if (!handshake.streamId) {
          const errored: StoredMessage = {
            ...assistantMsg,
            error: "Server did not return a streamId.",
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsg.id ? errored : m))
          );
          writer.schedule(assistantMsg.id, errored);
          return;
        }
        const withStream: StoredMessage = {
          ...assistantMsg,
          streamId: handshake.streamId,
          streamCursor: 0,
        };
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsg.id ? withStream : m))
        );
        writer.schedule(assistantMsg.id, withStream);
        writer.flushNow();

        const resumer = resumeStreamRef.current;
        if (resumer) {
          await resumer(withStream);
        } else {
          didResumeRef.current = false;
        }
      } catch (err) {
        const errorText = err instanceof Error ? err.message : "Network error";
        const errored: StoredMessage = { ...assistantMsg, error: errorText };
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsg.id ? errored : m))
        );
        writer.schedule(assistantMsg.id, errored);
      } finally {
        writer.flushNow();
        setPending(false);
        setProgress(null);
      }
    },
    [
      chatId,
      extraSystem,
      hasVfs,
      messages,
      model,
      settings.imageSearch,
      settings.advancedWeb,
      settings.connectors,
      settings.enabledConnectorIds,
      settings.runpodEndpointId,
      settings.webSearch,
      target,
      templateEntry,
      templateFiles,
      writer,
    ]
  );

  const send = useCallback(async (
    overrideText?: string,
    overrideImages?: AttachedImage[],
    overridePdfs?: AttachedPdf[],
    overrideCsvs?: AttachedCsv[],
    overrideFiles?: AttachedFile[],
  ) => {
    const text = (overrideText ?? getInput()).trim();
    const imagesToSend = overrideImages ?? pendingImages;
    const pdfsToSend = overridePdfs ?? pendingPdfs;
    const csvsToSend = overrideCsvs ?? pendingCsvs;
    const filesToSend = overrideFiles ?? pendingFiles;
    // Allow attachment-only sends (e.g. "what's in this photo?" with no text)
    // but still require *something*.
    if (
      !text &&
      imagesToSend.length === 0 &&
      pdfsToSend.length === 0 &&
      csvsToSend.length === 0 &&
      filesToSend.length === 0
    )
      return;

    // Structured research branch: instead of a normal chat turn, drop an
    // in-chat structured-research artifact (a self-driving table viewer). The
    // viewer kicks the deep-research run server-side, polls the resumable
    // result, and supports re-run/append — so the user can fire it and walk
    // away. We don't set `pending` (it runs in the background; the composer
    // stays free).
    if (settings.structuredResearch && text) {
      const now = Date.now();
      const userMsg: StoredMessage = {
        id: newId(),
        chatId,
        role: "user",
        content: text,
        createdAt: now,
        ...(typeof templateVersion === "number" ? { templateVersion } : {}),
      };
      const resultMsg: StoredMessage = {
        id: newId(),
        chatId,
        role: "assistant",
        content: "",
        kind: "research-result",
        createdAt: now + 1,
        researchResult: {
          query: text,
          columns: [],
          schema: null,
          records: [],
          runs: [],
          status: "running",
          model: settings.researchModel,
        },
      };
      setMessages((prev) => [...prev, userMsg, resultMsg]);
      clearInput();
      if (!overrideImages) setPendingImages([]);
      if (!overridePdfs) setPendingPdfs([]);
      if (!overrideCsvs) setPendingCsvs([]);
      if (!overrideFiles) setPendingFiles([]);
      void putMessage(userMsg);
      void putMessage(resultMsg);

      // Structured research is a per-request action, not a sticky mode: flip
      // the toggle off now that the run is committed so it doesn't silently
      // stay on and fire a fresh deep-research run for the next, unrelated
      // message. The current request already launched above (the result card
      // is in the transcript), so this only affects future sends. Mirrors the
      // research-toggle reset further down in this handler.
      void updateSettings({ ...settings, structuredResearch: false });
      return;
    }

    // Multi Research branch: like structured research, but the assistant card
    // is a Multi Research card — the model drafts N parallel research prompts
    // the user reviews, then runs them together, each streaming back as its own
    // full report. Self-driving (no global `pending`): the card kicks the drafts
    // and runs itself; it locks the composer while its reports run.
    if (settings.multiResearch && text) {
      const now = Date.now();
      const userMsg: StoredMessage = {
        id: newId(),
        chatId,
        role: "user",
        content: text,
        createdAt: now,
        ...(typeof templateVersion === "number" ? { templateVersion } : {}),
      };
      const cardMsg: StoredMessage = {
        id: newId(),
        chatId,
        role: "assistant",
        content: "",
        kind: "multi-research",
        createdAt: now + 1,
        multiResearch: {
          stage: "drafting",
          intent: text,
          reports: [],
          // Use the chat-selected model, same as the chat "Research" mode.
          model,
        },
      };
      setMessages((prev) => [...prev, userMsg, cardMsg]);
      clearInput();
      if (!overrideImages) setPendingImages([]);
      if (!overridePdfs) setPendingPdfs([]);
      if (!overrideCsvs) setPendingCsvs([]);
      if (!overrideFiles) setPendingFiles([]);
      void putMessage(userMsg);
      void putMessage(cardMsg);
      // Per-request action, not a sticky mode — flip it off now the round is
      // committed. Mirrors the structured/research toggle resets.
      void updateSettings({ ...settings, multiResearch: false });
      return;
    }

    // Council mode branch: instead of streaming directly, post the user
    // message + a non-streaming framing call. The framing card lands in the
    // chat as its own row; the user fills it in, then `launchCouncil` drives
    // the actual /api/council/run handshake. Council is mutually exclusive
    // with the queue path (we never let the user pile up sends mid-debate).
    if (settings.councilEnabled && !pending) {
      const members = settings.councilMembers ?? [];
      if (members.length === 0) {
        // Surface the misconfiguration in the composer area without losing
        // the user's input — a toast would be nicer but the existing
        // imageError pattern is the closest analogue here.
        setImageError(
          "Council is on but has no members. Open Preferences → Council to add some, or turn the council off in the composer."
        );
        return;
      }

      const now = Date.now();
      const userMsg: StoredMessage = {
        id: newId(),
        chatId,
        role: "user",
        content: text,
        createdAt: now,
        images: imagesToSend.length ? imagesToSend : undefined,
        pdfs: pdfsToSend.length ? pdfsToSend : undefined,
        csvs: csvsToSend.length ? csvsToSend : undefined,
        ...(typeof templateVersion === "number" ? { templateVersion } : {}),
      };
      setMessages((prev) => [...prev, userMsg]);
      clearInput();
      if (!overrideImages) setPendingImages([]);
      if (!overridePdfs) setPendingPdfs([]);
      if (!overrideCsvs) setPendingCsvs([]);
      if (!overrideFiles) setPendingFiles([]);
      void putMessage(userMsg);
      setPending(true);
      setProgress({ messageId: userMsg.id, phase: "thinking", startedAt: now });

      // Mirror the main /api/chat wire format: prior turns ship as text only,
      // but the current user turn carries images / pdfs so the framer can
      // describe them and incorporate the attachment content into its
      // scoping questions (otherwise it asks scoping questions whose answers
      // are sitting on the attached file).
      const wirePayload: Array<{
        role: StoredMessage["role"];
        content: string;
        images?: { id: string; dataUrl: string; mime: string; name?: string }[];
        pdfs?: {
          id: string;
          name: string;
          pageCount: number;
          text: string;
          truncated?: boolean;
        }[];
        csvs?: {
          id: string;
          name: string;
          rowCount: number;
          columnCount: number;
          text: string;
          truncated?: boolean;
        }[];
      }> = [...messages, userMsg]
        .filter(
          (m) =>
            !m.summarizedInto &&
            !m.error &&
            m.kind !== "council-framing" &&
            m.kind !== "research-framing" &&
            m.kind !== "research-result" &&
            m.kind !== "novel-outline-edit"
        )
        .map((m) => wireMsgFor(m));

      const situationId = settings.councilSituationId ?? "career-advice";
      // Placeholder framing message: pushed right after the POST handshake so
      // the user sees the framing card immediately, and so the streamId is
      // persisted to IndexedDB — a reload mid-flight gets auto-resumed by the
      // effect at the bottom of this component (matches how chat handles in-
      // flight assistant messages with `streamId`).
      const framingMsgId = newId();
      try {
        const handshakeRes = await fetch("/api/council/framing", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            messages: wirePayload,
            members,
            situationId: settings.councilSituationId,
            framerModel: model,
            ...(settings.runpodEndpointId
              ? { runpodEndpointId: settings.runpodEndpointId }
              : {}),
          }),
        });

        if (handshakeRes.status === 401) {
          window.location.href = "/login";
          return;
        }

        // Read the handshake body ONCE: both the success (streamId) and
        // failure (error) branches need it, and Response bodies are
        // single-use streams — calling .json() twice on the same Response
        // throws TypeError on the second await, so the previous "parse on
        // demand" pattern leaked the streamId field whenever the JSON body
        // happened to land before we checked .ok and made the failure path
        // throw "Handshake failed (202)" against a stale empty body.
        const handshakeBody = (await handshakeRes
          .json()
          .catch(() => ({}))) as { streamId?: string; error?: string };
        const streamId =
          handshakeRes.ok &&
          typeof handshakeBody.streamId === "string" &&
          handshakeBody.streamId
            ? handshakeBody.streamId
            : undefined;

        if (!streamId) {
          // Handshake itself failed (4xx / 5xx / unparseable body). Fall
          // through to the soft fallback so the user can still launch.
          throw new Error(
            handshakeBody.error ?? `Handshake failed (${handshakeRes.status})`
          );
        }

        const cImgCount = imagesToSend.length;
        const cPdfCount = pdfsToSend.length;
        const cDescribesImages = cImgCount > 0 && !modelSupportsVision(model);
        const placeholderMsg: StoredMessage = {
          id: framingMsgId,
          chatId,
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          kind: "council-framing",
          streamId,
          councilFraming: {
            rationale: "Framing the question…",
            questions: [],
            answers: {},
            members,
            situationId,
            ...(cDescribesImages ? { pendingImageCount: cImgCount } : {}),
            ...(cPdfCount > 0 ? { pendingPdfCount: cPdfCount } : {}),
          },
        };
        setMessages((prev) => [...prev, placeholderMsg]);
        void putMessage(placeholderMsg);

        const ctrl = registerFramingAbort(framingMsgId);
        const result = await streamFramingProgress(
          streamId,
          "council",
          ctrl.signal,
          (t) => appendFramingThinking(framingMsgId, t)
        );
        framingAbortsRef.current.delete(framingMsgId);
        clearFramingThinking(framingMsgId);
        const actions = Array.isArray(result.actions) ? result.actions : undefined;

        let framingPayload: StoredMessage["councilFraming"];
        if (
          result.status >= 200 &&
          result.status < 300 &&
          result.framing &&
          Array.isArray(result.framing.questions)
        ) {
          // Zero questions is a legitimate framer decision — the rationale
          // explains why the chat is already concrete enough for the
          // council to debate as-is. Preserve it instead of dropping into
          // the soft fallback below.
          framingPayload = {
            rationale: result.framing.rationale ?? "",
            questions: result.framing.questions,
            answers: {},
            members,
            situationId: result.situationId ?? situationId,
            ...(actions ? { actions } : {}),
          };
        } else {
          // Soft fallback: framer LLM failed or returned nothing usable. Build
          // a minimal payload with no questions so the user can still launch
          // the council from chat alone via the Skip button.
          framingPayload = {
            rationale: result.error
              ? `The framer didn't return any grounding questions (${result.error}). You can launch the council on the chat as-is.`
              : "The framer didn't return any grounding questions — you can launch the council on the chat as-is.",
            questions: [],
            answers: {},
            members,
            situationId,
            ...(actions ? { actions } : {}),
          };
        }

        const finalMsg: StoredMessage = {
          ...placeholderMsg,
          streamId: undefined,
          streamCursor: undefined,
          councilFraming: framingPayload,
        };
        setMessages((prev) => prev.map((m) => (m.id === framingMsgId ? finalMsg : m)));
        void putMessage(finalMsg);

        // If the framer returned no questions (the soft fallback above), launch
        // immediately — there's nothing for the user to fill in.
        if (framingPayload.questions.length === 0) {
          void launchCouncil(framingMsgId, {});
        }
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        console.error("council framing failed", err);
        // Same soft fallback on handshake / resume errors — give the user the
        // framing card so they can still proceed.
        const fallbackMsg: StoredMessage = {
          id: framingMsgId,
          chatId,
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          kind: "council-framing",
          councilFraming: {
            rationale:
              "Couldn't reach the framer (" +
              (err instanceof Error ? err.message : "network error") +
              "). You can still run the council on what's in the chat.",
            questions: [],
            answers: {},
            members,
            situationId,
          },
        };
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === framingMsgId);
          if (existing) {
            return prev.map((m) => (m.id === framingMsgId ? fallbackMsg : m));
          }
          return [...prev, fallbackMsg];
        });
        void putMessage(fallbackMsg);
      } finally {
        setPending(false);
        setProgress(null);
      }
      return;
    }

    // Research framing branch: same pattern as council, but with an explicit
    // pre-framing choice. When agentic research is on (and council isn't taking
    // over), pause before posting to /api/chat. Instead of immediately running
    // the framer (a separate, frequently-timing-out server function whose
    // failure used to silently auto-launch), surface a choice card: "Frame
    // first" runs the framer (startResearchFraming); "Research now" skips it and
    // goes straight to launchResearch. Nothing kicks off until the user picks.
    if (
      settings.research === true &&
      !settings.councilEnabled &&
      !pending
    ) {
      const now = Date.now();
      const userMsg: StoredMessage = {
        id: newId(),
        chatId,
        role: "user",
        content: text,
        createdAt: now,
        images: imagesToSend.length ? imagesToSend : undefined,
        pdfs: pdfsToSend.length ? pdfsToSend : undefined,
        csvs: csvsToSend.length ? csvsToSend : undefined,
        ...(typeof templateVersion === "number" ? { templateVersion } : {}),
      };
      setMessages((prev) => [...prev, userMsg]);
      clearInput();
      if (!overrideImages) setPendingImages([]);
      if (!overridePdfs) setPendingPdfs([]);
      if (!overrideCsvs) setPendingCsvs([]);
      if (!overrideFiles) setPendingFiles([]);
      void putMessage(userMsg);

      // Research is a per-request action, not a sticky mode: flip the toggle
      // off now that the request is committed so it doesn't silently stay on
      // for the next, unrelated message. The current request already captured
      // research === true above, so this only affects future sends.
      void updateSettings({ ...settings, research: false });

      // The choice card waits on the user — nothing is in flight, so the
      // composer is left idle (the `!pending` guard above already holds).
      const choiceMsg: StoredMessage = {
        id: newId(),
        chatId,
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        kind: "research-framing",
        researchFraming: {
          stage: "choice",
          rationale:
            "Frame the question first (a few scoping questions), or kick off the research right away.",
          questions: [],
          answers: {},
        },
      };
      setMessages((prev) => [...prev, choiceMsg]);
      void putMessage(choiceMsg);
      setProgress(null);
      return;
    }

    // Novel mode branch: same pause-before-streaming pattern as research and
    // council framing. POST to /api/novel/outline first — it does upfront
    // web research (3 searches) and produces an outline. Render the outline
    // in an editable card; `launchNovel` posts to /api/chat with the
    // user-confirmed outline attached and streams chapters into a separate
    // assistant bubble.
    if (
      (settings.novelMode === "short" ||
        settings.novelMode === "standard" ||
        settings.novelMode === "long") &&
      !settings.councilEnabled &&
      settings.research !== true &&
      !pending
    ) {
      const novelLength: NovelLengthClient = settings.novelMode;
      const now = Date.now();
      const userMsg: StoredMessage = {
        id: newId(),
        chatId,
        role: "user",
        content: text,
        createdAt: now,
        images: imagesToSend.length ? imagesToSend : undefined,
        pdfs: pdfsToSend.length ? pdfsToSend : undefined,
        csvs: csvsToSend.length ? csvsToSend : undefined,
        ...(typeof templateVersion === "number" ? { templateVersion } : {}),
      };
      setMessages((prev) => [...prev, userMsg]);
      clearInput();
      if (!overrideImages) setPendingImages([]);
      if (!overridePdfs) setPendingPdfs([]);
      if (!overrideCsvs) setPendingCsvs([]);
      if (!overrideFiles) setPendingFiles([]);
      void putMessage(userMsg);
      setPending(true);
      setProgress({ messageId: userMsg.id, phase: "thinking", startedAt: now });

      const wirePayload = [...messages, userMsg]
        .filter(
          (m) =>
            !m.summarizedInto &&
            !m.error &&
            m.kind !== "council-framing" &&
            m.kind !== "research-framing" &&
            m.kind !== "research-result" &&
            m.kind !== "novel-outline-edit"
        )
        .map((m) => wireMsgFor(m));

      // Placeholder outline card: pushed right after the POST handshake so
      // the user sees the "outlining…" state immediately, and so the
      // streamId is persisted to IndexedDB — a reload mid-flight gets
      // auto-resumed by the effect at the bottom of this component (matches
      // how chat handles in-flight assistant messages with `streamId`).
      const cardMsgId = newId();
      try {
        const handshakeRes = await fetch("/api/novel/outline", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            model,
            length: novelLength,
            messages: wirePayload,
            ...(settings.runpodEndpointId
              ? { runpodEndpointId: settings.runpodEndpointId }
              : {}),
          }),
        });
        if (handshakeRes.status === 401) {
          window.location.href = "/login";
          return;
        }

        // Read the handshake body ONCE: both the success (streamId) and
        // failure (error) branches need it, and Response bodies are
        // single-use streams — calling .json() twice on the same Response
        // throws TypeError on the second await, so the previous "parse on
        // demand" pattern leaked the streamId field whenever the JSON body
        // happened to land before we checked .ok and made the failure path
        // throw "Handshake failed (202)" against a stale empty body.
        const handshakeBody = (await handshakeRes
          .json()
          .catch(() => ({}))) as { streamId?: string; error?: string };
        const streamId =
          handshakeRes.ok &&
          typeof handshakeBody.streamId === "string" &&
          handshakeBody.streamId
            ? handshakeBody.streamId
            : undefined;
        if (!streamId) {
          throw new Error(
            handshakeBody.error ?? `Handshake failed (${handshakeRes.status})`
          );
        }

        const placeholderPayload: NovelOutlineEditPayload = {
          length: novelLength,
          outline: {
            title: "",
            logline: "",
            setting: "",
            characters: [],
            chapters: [],
          },
          researchNote: null,
          searches: [],
          outlining: true,
        };
        const placeholderMsg: StoredMessage = {
          id: cardMsgId,
          chatId,
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          kind: "novel-outline-edit",
          streamId,
          novelOutlineEdit: placeholderPayload,
        };
        setMessages((prev) => [...prev, placeholderMsg]);
        void putMessage(placeholderMsg);

        const ctrl = registerNovelOutlineAbort(cardMsgId);
        startNovelOutlineProgressPoll(cardMsgId, streamId, ctrl.signal);
        let result: NovelOutlineResumePayload;
        try {
          result = await resolveNovelOutlineStream(streamId, ctrl.signal);
        } finally {
          clearNovelOutlineAbort(cardMsgId);
        }

        if (
          result.status >= 200 &&
          result.status < 300 &&
          result.outline
        ) {
          const finalPayload: NovelOutlineEditPayload = {
            length: novelLength,
            outline: result.outline,
            researchNote: result.researchNote ?? null,
            searches: Array.isArray(result.searches) ? result.searches : [],
          };
          const finalMsg: StoredMessage = {
            ...placeholderMsg,
            streamId: undefined,
            streamCursor: undefined,
            novelOutlineEdit: finalPayload,
          };
          setMessages((prev) => prev.map((m) => (m.id === cardMsgId ? finalMsg : m)));
          void putMessage(finalMsg);
          setNovelOutlineProgress((prev) => {
            if (!(cardMsgId in prev)) return prev;
            const next = { ...prev };
            delete next[cardMsgId];
            return next;
          });
        } else {
          // Outliner failed server-side. Replace the placeholder card with an
          // error bubble; there's no partial outline worth preserving.
          const errored: StoredMessage = {
            id: cardMsgId,
            chatId,
            role: "assistant",
            content: "",
            createdAt: Date.now(),
            error:
              result.error ??
              `Couldn't generate outline (HTTP ${result.status}). Try again.`,
          };
          setMessages((prev) => prev.map((m) => (m.id === cardMsgId ? errored : m)));
          void putMessage(errored);
        }
      } catch (err) {
        // User-initiated cancel: cancelNovelOutline already cleaned up the
        // message + progress; the AbortError just unwinds the promise here.
        // Don't recreate an error row.
        if ((err as { name?: string })?.name === "AbortError") {
          return;
        }
        // Handshake or resume failed before a placeholder existed (or after
        // — either way, collapse the row into an error bubble keyed on
        // cardMsgId so a partial placeholder doesn't dangle in IDB).
        const errored: StoredMessage = {
          id: cardMsgId,
          chatId,
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          error:
            "Network error reaching the outline endpoint: " +
            (err instanceof Error ? err.message : String(err)),
        };
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === cardMsgId);
          if (existing) {
            return prev.map((m) => (m.id === cardMsgId ? errored : m));
          }
          return [...prev, errored];
        });
        void putMessage(errored);
      } finally {
        setPending(false);
        setProgress(null);
      }
      return;
    }

    // Queue mode: a previous turn is still streaming and has a live
    // streamId on the wire. POST the new message to /api/chat/queue/{id}
    // fire-and-forget; the worker drains the queue between turns and
    // emits user_turn / assistant_turn events back into this same SSE
    // stream so the new bubbles render seamlessly.
    const inFlightAssistant = pending
      ? messages.find(
          // The chatId check is load-bearing: during a soft navigation the
          // messages state can briefly hold the previous chat's rows, and
          // queueing into a foreign chat's stream writes this user's turn
          // into that other chat.
          (m) =>
            m.role === "assistant" &&
            m.streamId &&
            !m.error &&
            m.chatId === chatId
        )
      : null;
    if (pending && !inFlightAssistant) {
      // Pre-handshake (we set pending=true before the streamId arrives).
      // Drop the send rather than racing the in-flight POST.
      return;
    }
    if (inFlightAssistant && inFlightAssistant.streamId) {
      const streamIdForQueue = inFlightAssistant.streamId;
      const queuedAt = Date.now();
      const queuedUserMsg: StoredMessage = {
        id: newId(),
        chatId,
        role: "user",
        content: text,
        createdAt: queuedAt,
        images: imagesToSend.length ? imagesToSend : undefined,
        pdfs: pdfsToSend.length ? pdfsToSend : undefined,
        csvs: csvsToSend.length ? csvsToSend : undefined,
        queued: true,
        ...(typeof templateVersion === "number" ? { templateVersion } : {}),
      };
      setMessages((prev) => [...prev, queuedUserMsg]);
      clearInput();
      if (!overrideImages) setPendingImages([]);
      if (!overridePdfs) setPendingPdfs([]);
      if (!overrideCsvs) setPendingCsvs([]);
      void putMessage(queuedUserMsg);

      void (async () => {
        try {
          const res = await fetch(
            `/api/chat/queue/${encodeURIComponent(streamIdForQueue)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                id: queuedUserMsg.id,
                content: text,
                images: imagesToSend.length
                  ? imagesToSend.map((im) => ({
                      id: im.id,
                      dataUrl: im.dataUrl,
                      mime: im.mime,
                      name: im.name,
                      ...(im.description ? { description: im.description } : {}),
                    }))
                  : undefined,
                pdfs: pdfsToSend.length
                  ? pdfsToSend.map((p) => ({
                      id: p.id,
                      name: p.name,
                      pageCount: p.pageCount,
                      text: p.text,
                      truncated: p.truncated,
                    }))
                  : undefined,
                csvs: csvsToSend.length
                  ? csvsToSend.map((c) => ({
                      id: c.id,
                      name: c.name,
                      rowCount: c.rowCount,
                      columnCount: c.columnCount,
                      text: c.text,
                      truncated: c.truncated,
                    }))
                  : undefined,
              }),
            }
          );
          if (res.status === 401) {
            window.location.href = "/login";
            return;
          }
          if (res.status === 410 || res.status === 404) {
            // Stream finished or expired between the user hitting send and
            // our POST landing. Drop the optimistic queued bubble and
            // re-fire via the existing retry-drain path as a normal send.
            setMessages((prev) =>
              prev.filter((m) => m.id !== queuedUserMsg.id)
            );
            void deleteMessage(queuedUserMsg.id).catch(() => {});
            queuedRetryRef.current = {
              text,
              images: imagesToSend,
              pdfs: pdfsToSend,
              csvs: csvsToSend,
            };
            return;
          }
          if (!res.ok) {
            const errBody = await res
              .json()
              .catch(() => ({ error: `HTTP ${res.status}` }));
            const errored: StoredMessage = {
              ...queuedUserMsg,
              error: errBody.error ?? `HTTP ${res.status}`,
              queued: false,
            };
            setMessages((prev) =>
              prev.map((m) => (m.id === queuedUserMsg.id ? errored : m))
            );
            writer.schedule(queuedUserMsg.id, errored);
          }
          // 2xx: server accepted; the user_turn SSE event will reconcile
          // this bubble (clear `queued`) when the worker actually drains it.
        } catch (err) {
          const errored: StoredMessage = {
            ...queuedUserMsg,
            error: err instanceof Error ? err.message : "Network error",
            queued: false,
          };
          setMessages((prev) =>
            prev.map((m) => (m.id === queuedUserMsg.id ? errored : m))
          );
          writer.schedule(queuedUserMsg.id, errored);
        }
      })();
      return;
    }

    let working = messages;
    try {
      const compacted = await runCompaction(false);
      // runCompaction sets state asynchronously; reuse its return for the wire payload.
      working = compacted.length === wireMessages.length ? messages : compacted;
    } catch (err) {
      // Compaction failed — proceed with the raw conversation; server will tell us if it overflows.
      console.error("compaction failed", err);
    }

    const now = Date.now();
    // Snapshot the canvas selection at send time so we can both attach it to
    // the wire request AND persist it on the user message (restores the chip
    // + preview <mark> on reload). Cleared immediately after capture so a
    // subsequent send without re-highlighting doesn't reuse a stale anchor.
    const sentSelection = selectionAnchor ?? null;
    const userMsg: StoredMessage = {
      id: newId(),
      chatId,
      role: "user",
      content: text,
      createdAt: now,
      images: imagesToSend.length ? imagesToSend : undefined,
      pdfs: pdfsToSend.length ? pdfsToSend : undefined,
      csvs: csvsToSend.length ? csvsToSend : undefined,
      files: filesToSend.length ? filesToSend : undefined,
      ...(typeof templateVersion === "number" ? { templateVersion } : {}),
      ...(sentSelection ? { selectionAnchor: sentSelection } : {}),
    };
    if (sentSelection) onSelectionConsumed?.();
    const assistantMsg: StoredMessage = {
      id: newId(),
      chatId,
      role: "assistant",
      content: "",
      createdAt: now + 1,
      model,
      events: [],
      // Tag chat-artifact-canvas edit responses with the source artifact's
      // id. The auto-save effect uses this to apply the streamed VFS back
      // to the source message even when the user has navigated back to
      // /chats/[id] mid-stream (where `onSaveVfs` isn't wired up). The
      // rendering layer also uses it to suppress the duplicate inline
      // artifact card on Y in the chat history. We also stash the source
      // artifact's current HTML so "Revert chat (and code) to here" can
      // roll the source back — the apply step clobbers the source's body
      // in place, so without this snapshot the prior version is lost.
      ...(target?.kind === "chat-artifact-canvas"
        ? {
            editsArtifactMessageId: target.messageId,
            ...(templateEntry && typeof templateFiles?.[templateEntry] === "string"
              ? { priorArtifactHtml: templateFiles[templateEntry] }
              : {}),
          }
        : {}),
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    clearInput();
    if (!overrideImages) setPendingImages([]);
    if (!overridePdfs) setPendingPdfs([]);
    if (!overrideCsvs) setPendingCsvs([]);
    if (!overrideFiles) setPendingFiles([]);
    setPending(true);
    const startedAt = Date.now();
    setProgress({ messageId: assistantMsg.id, phase: "sending", startedAt });

    void putMessage(userMsg);
    void putMessage(assistantMsg);

    try {
      // Every turn carries its OWN attachments on the wire — including prior
      // turns. The server inlines attachments per message, so if history is
      // sent without them the model silently loses every image/PDF/CSV shared
      // earlier and "forgets" or hallucinates their contents (the bug this
      // fixes: a highly-capable model that can't recall a file from two turns
      // ago). Re-sending keeps the full multimodal history in context. The
      // cost — a vision model re-reads prior frames, a described-model re-runs
      // the describer — is the correct price for not dropping context.
      const wirePayload: Array<{
        role: StoredMessage["role"];
        content: string;
        images?: { id: string; dataUrl: string; mime: string; name?: string }[];
        pdfs?: {
          id: string;
          name: string;
          pageCount: number;
          text: string;
          truncated?: boolean;
        }[];
        csvs?: {
          id: string;
          name: string;
          rowCount: number;
          columnCount: number;
          text: string;
          truncated?: boolean;
        }[];
        // Sandbox files (uploads + earlier produced outputs). Unlike images,
        // these ride on EVERY turn that has them — the server gathers the full
        // set so run_code can reference a file attached several turns ago by
        // name. They're pointers (blob URLs), not bytes, so this is cheap.
        files?: {
          id: string;
          name: string;
          blobKey: string;
          url: string;
          contentType: string;
          bytes: number;
          produced?: boolean;
        }[];
      }> = working
        .filter((m) => !m.summarizedInto && !m.error)
        .map((m) => wireMsgFor(m, target));
      wirePayload.push({
        role: "user",
        content: text,
        images: imagesToSend.length
          ? imagesToSend.map((im) => ({
              id: im.id,
              dataUrl: im.dataUrl,
              mime: im.mime,
              name: im.name,
            }))
          : undefined,
        pdfs: pdfsToSend.length
          ? pdfsToSend.map((p) => ({
              id: p.id,
              name: p.name,
              pageCount: p.pageCount,
              text: p.text,
              truncated: p.truncated,
            }))
          : undefined,
        csvs: csvsToSend.length
          ? csvsToSend.map((c) => ({
              id: c.id,
              name: c.name,
              rowCount: c.rowCount,
              columnCount: c.columnCount,
              text: c.text,
              truncated: c.truncated,
            }))
          : undefined,
        files: filesToSend.length ? filesToSend : undefined,
      });

      const responseFormat = responseFormatFor(target, hasVfs);
      // POST is now a quick handshake — server returns 202 with {streamId}
      // and writes events into Redis via waitUntil. The actual stream is
      // read via /api/chat/resume/{streamId}, exactly the same path used
      // for tab-close recovery.
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          model,
          webSearch: settings.webSearch,
          imageSearch: settings.imageSearch,
          advancedWeb: settings.advancedWeb === true,
          codeExec: settings.codeExec === true,
          connectors: activeConnectors(settings.connectors, settings.enabledConnectorIds),
          appCreation: settings.appCreation === true,
          research: settings.research === true,
          // Novel mode is a string preset. Send the preset string when set
          // to a recognized value; omit otherwise so the server treats it
          // as off. The server enforces mutual exclusion with agentic.
          ...(settings.novelMode === "short" ||
          settings.novelMode === "standard" ||
          settings.novelMode === "long"
            ? { novelMode: settings.novelMode }
            : {}),
          // Plan mode is a force-on override for the long-coding-edit
          // orchestrator. Send only when explicitly set so the route
          // falls back to auto-detect (work.ts shouldUsePlanMode) when
          // the toggle is off.
          ...(settings.planMode === true ? { planMode: true } : {}),
          ...(settings.flyWorker !== false ? { flyWorker: true } : {}),
          ...(settings.chatPersonaId ? { chatPersonaId: settings.chatPersonaId } : {}),
          ...describerWire(settings),
          messages: wirePayload,
          responseFormat,
          ...(settings.runpodEndpointId
            ? { runpodEndpointId: settings.runpodEndpointId }
            : {}),
          ...(extraSystem && extraSystem.trim() ? { system: extraSystem.trim() } : {}),
          ...(responseFormat === "vfs-edit" ||
          responseFormat === "note-edit" ||
          responseFormat === "artifact-edit"
            ? { files: templateFiles, entry: templateEntry }
            : {}),
          ...(responseFormat === "note-edit" && sentSelection
            ? { selection: sentSelection }
            : {}),
        }),
      });

      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        const errored: StoredMessage = { ...assistantMsg, error: errBody.error ?? "Request failed" };
        setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? errored : m)));
        writer.schedule(assistantMsg.id, errored);
        return;
      }

      const handshake = (await res.json()) as { streamId?: string };
      if (!handshake.streamId) {
        const errored: StoredMessage = { ...assistantMsg, error: "Server did not return a streamId." };
        setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? errored : m)));
        writer.schedule(assistantMsg.id, errored);
        return;
      }

      // Persist the streamId immediately so a tab close right now still
      // leaves enough breadcrumb for the auto-resume effect to recover.
      const withStream: StoredMessage = {
        ...assistantMsg,
        streamId: handshake.streamId,
        streamCursor: 0,
      };
      setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? withStream : m)));
      writer.schedule(assistantMsg.id, withStream);
      writer.flushNow();

      // Switch into resume-mode for the read. Same code path used after a
      // disconnect, so phone-sleep and fresh-send share the same plumbing.
      const resumer = resumeStreamRef.current;
      if (resumer) {
        await resumer(withStream);
      } else {
        // Should never happen — the ref is wired on every render. Fall back
        // to the auto-resume effect on next render.
        didResumeRef.current = false;
      }
    } catch (err) {
      const errorText = err instanceof Error ? err.message : "Network error";
      // Handshake itself failed (network, server unreachable). No streamId
      // was issued, so there is nothing to resume — surface the error.
      const errored: StoredMessage = {
        ...assistantMsg,
        error: errorText,
        streamId: undefined,
        streamCursor: undefined,
      };
      setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? errored : m)));
      writer.schedule(assistantMsg.id, errored);
    } finally {
      writer.flushNow();
      setPending(false);
      setProgress(null);
    }
  }, [
    chatId,
    getInput,
    hasVfs,
    messages,
    model,
    pending,
    pendingImages,
    pendingPdfs,
    pendingCsvs,
    pendingFiles,
    runCompaction,
    settings.webSearch,
    settings.imageSearch,
    settings.advancedWeb,
    settings.connectors,
    settings.enabledConnectorIds,
    settings.codeExec,
    settings.appCreation,
    settings.research,
    settings.novelMode,
    settings.planMode,
    settings.councilEnabled,
    settings.councilMembers,
    settings.councilSituationId,
    settings.runpodEndpointId,
    target,
    templateEntry,
    templateFiles,
    templateVersion,
    wireMessages.length,
    writer,
    launchCouncil,
    extraSystem,
    selectionAnchor,
    onSelectionConsumed,
    registerNovelOutlineAbort,
    clearNovelOutlineAbort,
    startNovelOutlineProgressPoll,
    settings,
    updateSettings,
    appendFramingThinking,
    clearFramingThinking,
  ]);

  // Reattach to a server-side stream that was still running when the tab
  // closed. Triggered for any hydrated message that has a streamId set.
  const resumeStream = useCallback(
    async (msg: StoredMessage) => {
      if (!msg.streamId) return;
      setPending(true);
      setProgress({
        messageId: msg.id,
        phase: "thinking",
        startedAt: Date.now(),
      });
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const cursor = msg.streamCursor ?? 0;
        const res = await fetch(
          `/api/chat/resume/${encodeURIComponent(msg.streamId)}?cursor=${cursor}`,
          { headers: { Accept: "text/event-stream" }, signal: ctrl.signal }
        );
        if (res.status === 404) {
          // TTL elapsed or invalid id. Mark the partial message as terminal so
          // the user knows what they're looking at.
          const errored: StoredMessage = {
            ...msg,
            error: msg.error ?? "Stream lost — server temp storage expired.",
            streamId: undefined,
            streamCursor: undefined,
          };
          setMessages((prev) => prev.map((m) => (m.id === msg.id ? errored : m)));
          writer.schedule(msg.id, errored);
          return;
        }
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (!res.ok || !res.body) {
          const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          const errored: StoredMessage = {
            ...msg,
            error: errBody.error ?? "Resume failed.",
          };
          setMessages((prev) => prev.map((m) => (m.id === msg.id ? errored : m)));
          writer.schedule(msg.id, errored);
          return;
        }
        const result = await consumeChatStream({
          body: res.body,
          assistantMsg: msg,
          hasVfs,
          target,
          templateFiles,
          templateEntry,
          setMessages,
          setProgress,
          writer,
          onPendingVfs,
        });
        if (result.aborted) {
          const cleared: StoredMessage = {
            ...result.finalMsg,
            streamId: undefined,
            streamCursor: undefined,
          };
          setMessages((prev) => prev.map((m) => (m.id === msg.id ? cleared : m)));
          writer.schedule(msg.id, cleared);
        } else if (result.resumable) {
          // Network dropped again mid-resume. Re-arm so the next render can
          // auto-reconnect (e.g. when the user brings the tab back to focus).
          didResumeRef.current = false;
        }
      } catch (err) {
        // Network error during resume — leave streamId in place so the user
        // can retry by reloading the page.
        console.warn("resume failed", err);
        didResumeRef.current = false;
      } finally {
        writer.flushNow();
        setPending(false);
        setProgress(null);
        abortRef.current = null;
      }
    },
    [hasVfs, onPendingVfs, target, templateEntry, templateFiles, writer]
  );

  // Wire the forward reference so send() can call resumeStream without
  // creating a useCallback dependency cycle.
  resumeStreamRef.current = resumeStream;

  // Reattach to a still-running framer that was started on a previous mount
  // (e.g. tab closed mid-framing, phone went to sleep, page reloaded). The
  // server-side framer survives via waitUntil + Redis; we long-poll the
  // resume endpoint to pick up the final payload and replace the placeholder
  // framing message that was persisted to IndexedDB with the streamId set.
  const resumeFramingMessage = useCallback(
    async (msg: StoredMessage) => {
      if (!msg.streamId) return;
      const kind: FramingKind =
        msg.kind === "council-framing" ? "council" : "research";

      setPending(true);
      setProgress({
        messageId: msg.id,
        phase: "thinking",
        startedAt: Date.now(),
      });

      const ctrl = registerFramingAbort(msg.id);
      try {
        const result = await streamFramingProgress(
          msg.streamId,
          kind,
          ctrl.signal,
          (t) => appendFramingThinking(msg.id, t)
        );
        framingAbortsRef.current.delete(msg.id);
        clearFramingThinking(msg.id);
        const actions = Array.isArray(result.actions) ? result.actions : undefined;
        const ok =
          result.status >= 200 &&
          result.status < 300 &&
          result.framing &&
          Array.isArray(result.framing.questions) &&
          result.framing.questions.length > 0;

        if (kind === "research") {
          // A clean pass (2xx + questions array) that simply asked nothing is
          // distinct from a timeout/error: the former may auto-launch, the
          // latter stops and lets the user retry / run as-is (framerFailed).
          const framerClean =
            result.status >= 200 &&
            result.status < 300 &&
            !!result.framing &&
            Array.isArray(result.framing.questions);
          const base = msg.researchFraming ?? { rationale: "", questions: [], answers: {} };
          const researchFraming: NonNullable<StoredMessage["researchFraming"]> = framerClean
            ? {
                ...base,
                rationale: result.framing!.rationale ?? "",
                questions: result.framing!.questions!,
                answers: base.answers ?? {},
                framerFailed: false,
                ...(actions ? { actions } : {}),
              }
            : {
                ...base,
                rationale: result.error
                  ? `The framer didn't return any scoping questions (${result.error}). Run the research as-is, or retry framing.`
                  : "The framer didn't return any scoping questions. Run the research as-is, or retry framing.",
                questions: [],
                answers: base.answers ?? {},
                framerFailed: true,
                ...(actions ? { actions } : {}),
              };
          const finalMsg: StoredMessage = {
            ...msg,
            streamId: undefined,
            streamCursor: undefined,
            researchFraming,
          };
          setMessages((prev) => prev.map((m) => (m.id === msg.id ? finalMsg : m)));
          void putMessage(finalMsg);
          // Only auto-launch on a clean framer pass that asked nothing.
          if (framerClean && researchFraming.questions.length === 0) {
            void launchResearch(msg.id, {});
          }
        } else {
          const base = msg.councilFraming;
          if (!base) return;
          const councilFraming: NonNullable<StoredMessage["councilFraming"]> = ok
            ? {
                ...base,
                rationale: result.framing!.rationale ?? "",
                questions: result.framing!.questions!,
                answers: base.answers ?? {},
                situationId: result.situationId ?? base.situationId,
                ...(actions ? { actions } : {}),
              }
            : {
                ...base,
                rationale: result.error
                  ? `The framer didn't return any grounding questions (${result.error}). You can launch the council on the chat as-is.`
                  : "The framer didn't return any grounding questions — you can launch the council on the chat as-is.",
                questions: [],
                answers: base.answers ?? {},
                ...(actions ? { actions } : {}),
              };
          const finalMsg: StoredMessage = {
            ...msg,
            streamId: undefined,
            streamCursor: undefined,
            councilFraming,
          };
          setMessages((prev) => prev.map((m) => (m.id === msg.id ? finalMsg : m)));
          void putMessage(finalMsg);
          if (councilFraming.questions.length === 0) {
            void launchCouncil(msg.id, {});
          }
        }
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        console.error("framing resume failed", err);
        // Leave the placeholder's streamId in place so the next visibility
        // transition or remount re-arms the auto-resume — matches what
        // resumeStream does for chat on transient resume failure.
      } finally {
        setPending(false);
        setProgress(null);
      }
    },
    [
      launchCouncil,
      launchResearch,
      registerFramingAbort,
      appendFramingThinking,
      clearFramingThinking,
    ]
  );

  // Reattach to a still-running novel-outline call. Same pattern as the
  // framing variant above — the server-side outliner survives via waitUntil
  // + Redis; we long-poll the resume endpoint and update the placeholder /
  // revising outline-edit card with the final outline. Covers two cases:
  //
  //   1. Placeholder card (`outlining === true` was set on initial send):
  //      replace with the real outline, clear the streamId.
  //   2. Existing card in revising state (re-outline call mid-flight):
  //      swap the outline, clear `revising` and the streamId.
  const resumeNovelOutlineMessage = useCallback(
    async (msg: StoredMessage) => {
      if (!msg.streamId) return;
      const base = msg.novelOutlineEdit;
      if (!base) return;
      const isInitial = base.outlining === true;

      setPending(true);
      setProgress({
        messageId: msg.id,
        phase: "thinking",
        startedAt: Date.now(),
      });

      const ctrl = registerNovelOutlineAbort(msg.id);
      startNovelOutlineProgressPoll(msg.id, msg.streamId, ctrl.signal);
      try {
        const result = await resolveNovelOutlineStream(msg.streamId, ctrl.signal);

        if (
          result.status >= 200 &&
          result.status < 300 &&
          result.outline
        ) {
          const finalPayload: NovelOutlineEditPayload = isInitial
            ? {
                length: base.length,
                outline: result.outline,
                researchNote: result.researchNote ?? null,
                searches: Array.isArray(result.searches) ? result.searches : [],
              }
            : {
                ...base,
                outline: result.outline,
                revising: false,
              };
          const finalMsg: StoredMessage = {
            ...msg,
            error: undefined,
            streamId: undefined,
            streamCursor: undefined,
            novelOutlineEdit: finalPayload,
          };
          setMessages((prev) => prev.map((m) => (m.id === msg.id ? finalMsg : m)));
          void putMessage(finalMsg);
          setNovelOutlineProgress((prev) => {
            if (!(msg.id in prev)) return prev;
            const next = { ...prev };
            delete next[msg.id];
            return next;
          });
        } else if (isInitial) {
          // Initial flow had no prior outline to preserve — collapse the
          // placeholder card into an error bubble, same as the live send.
          const errored: StoredMessage = {
            id: msg.id,
            chatId: msg.chatId,
            role: "assistant",
            content: "",
            createdAt: msg.createdAt,
            error:
              result.error ??
              `Couldn't generate outline (HTTP ${result.status}). Try again.`,
          };
          setMessages((prev) => prev.map((m) => (m.id === msg.id ? errored : m)));
          void putMessage(errored);
        } else {
          // Revision flow — leave the prior outline in place, just clear
          // revising and surface the error inline on the card.
          const cleared: StoredMessage = {
            ...msg,
            streamId: undefined,
            streamCursor: undefined,
            error: result.error
              ? `Re-outline failed: ${result.error}`
              : `Re-outline failed (HTTP ${result.status}).`,
            novelOutlineEdit: { ...base, revising: false },
          };
          setMessages((prev) => prev.map((m) => (m.id === msg.id ? cleared : m)));
          void putMessage(cleared);
        }
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        console.error("novel-outline resume failed", err);
        // Leave the streamId in place so the next visibility transition /
        // remount re-arms the auto-resume, same as the framing path.
      } finally {
        clearNovelOutlineAbort(msg.id);
        setPending(false);
        setProgress(null);
      }
    },
    [
      registerNovelOutlineAbort,
      clearNovelOutlineAbort,
      startNovelOutlineProgressPoll,
    ]
  );

  // After hydration, if any assistant message is still mid-stream (its
  // `streamId` survived because the previous tab closed before `done`),
  // reattach to the matching resume endpoint so the server's in-flight
  // generation finishes into IndexedDB. Framer + novel-outline messages go
  // to their respective long-poll resume routes; everything else goes
  // through the chat SSE consumer.
  useEffect(() => {
    if (!hydrated || pending || didResumeRef.current) return;
    const inFlight = messages.find(
      (m) => m.role === "assistant" && m.streamId && !m.error
    );
    if (!inFlight) return;
    didResumeRef.current = true;
    if (
      inFlight.kind === "research-framing" ||
      inFlight.kind === "council-framing"
    ) {
      void resumeFramingMessage(inFlight);
    } else if (inFlight.kind === "novel-outline-edit") {
      void resumeNovelOutlineMessage(inFlight);
    } else {
      void resumeStream(inFlight);
    }
  }, [
    hydrated,
    messages,
    pending,
    resumeStream,
    resumeFramingMessage,
    resumeNovelOutlineMessage,
  ]);

  // iOS Safari aggressively suspends backgrounded tabs and kills any in-flight
  // fetch — the page often does NOT remount when the user returns, so the
  // hydration effect above never re-fires. Listen for visibility transitions
  // to visible and re-arm the auto-resume so we reconnect to the server's
  // still-running stream via Redis.
  useEffect(() => {
    if (!hydrated) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (pending) return;
      const inFlight = messages.find(
        (m) => m.role === "assistant" && m.streamId && !m.error
      );
      if (!inFlight) return;
      didResumeRef.current = true;
      if (
        inFlight.kind === "research-framing" ||
        inFlight.kind === "council-framing"
      ) {
        void resumeFramingMessage(inFlight);
      } else if (inFlight.kind === "novel-outline-edit") {
        void resumeNovelOutlineMessage(inFlight);
      } else {
        void resumeStream(inFlight);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [
    hydrated,
    messages,
    pending,
    resumeStream,
    resumeFramingMessage,
    resumeNovelOutlineMessage,
  ]);
  // Keep the ref current so the prefill effect can auto-send (see sendRef).
  sendRef.current = send;

  // Drain a queued retry once the deletes have flushed into `messages`. We
  // can't call `send()` synchronously inside `retry` because its closure
  // would still see the about-to-be-deleted user/assistant pair and the
  // wire payload would include a phantom user turn.
  useEffect(() => {
    if (!queuedRetryRef.current || !hydrated || pending) return;
    const { text, images, pdfs, csvs } = queuedRetryRef.current;
    queuedRetryRef.current = null;
    void send(text, images, pdfs, csvs);
  }, [hydrated, pending, send, messages]);

  // Rescue orphaned queued messages. Race window: the client's queue POST
  // lands between `drainQueueWithGrace()` returning empty and the worker
  // setting meta to "complete" — the POST gets 202 (meta still "running")
  // but the worker already emitted "done" and nobody will ever drain it.
  // When `pending` drops to false, any messages still marked `queued: true`
  // are orphans. Remove them and re-issue via the normal `send()` path.
  useEffect(() => {
    if (pending || !hydrated) return;
    if (queuedRetryRef.current) return;
    const orphan = messages.find((m) => m.role === "user" && m.queued && !m.error);
    if (!orphan) return;
    setMessages((prev) => prev.filter((m) => m.id !== orphan.id));
    void deleteMessage(orphan.id).catch(() => {});
    queuedRetryRef.current = {
      text: orphan.content,
      images: orphan.images ?? [],
      pdfs: orphan.pdfs ?? [],
      csvs: orphan.csvs ?? [],
    };
  }, [hydrated, pending, messages]);

  // Drain a queued stalled-stream Continue once `continueStalled`'s abort
  // has worked its way through consumeChatStream's catch path and pending
  // settles back to false. By that point the bubble has its synthetic
  // "Cancelled by user." error set, so continuePlan / continueGeneration
  // can read it through their own messages closure and dispatch.
  useEffect(() => {
    if (pending) return;
    const queued = queuedStalledContinueRef.current;
    if (!queued) return;
    queuedStalledContinueRef.current = null;
    if (queued.kind === "plan") {
      void continuePlan(queued.messageId);
    } else {
      void continueGeneration(queued.messageId);
    }
  }, [pending, continuePlan, continueGeneration]);

  // Composer Stop button. Aborting the local SSE alone leaves the server-
  // side producer running — fine on Vercel (maxDuration cuts it off) but
  // wasteful on Fly (the long-lived worker keeps generating tokens until
  // the job is naturally done). POST to /api/chat/stop/{streamId} so the
  // worker observes the flag at the next round boundary and bails with
  // "Stopped by user." Best-effort: a 409/410 just means the worker has
  // already finished, which is fine.
  const stop = useCallback(() => {
    abortRef.current?.abort();
    const streaming = messages.find(
      (m) => m.role === "assistant" && m.streamId && !m.error
    );
    if (streaming?.streamId) {
      void fetch(
        `/api/chat/stop/${encodeURIComponent(streaming.streamId)}`,
        { method: "POST" }
      ).catch(() => {
        // Best-effort; the local abort above already settled the bubble.
      });
    }
  }, [messages]);

  // Client-side stall detection. The server-side worker may still be
  // alive (Vercel waitUntil chugging through one huge step) or fully dead
  // (Redis TTL elapsed, network drop mid-resume) — we can't tell from the
  // browser. Either way, if no SSE block has arrived for STREAM_STALL_MS
  // the user is staring at a frozen spinner with no recourse. The ticker
  // updates `stallTick` once a second while a stream is in progress so the
  // derived `stalledMessageId` flips on cleanly without forcing the whole
  // chat to re-render every frame.
  //
  // Threshold bifurcates on Fly mode: on Vercel the 15-min maxDuration
  // caps the worst-case silent stretch, so 60s of quiet is a strong
  // signal something's wrong. On Fly the worker has up to an hour and a
  // single heavy step (deep web research, big reasoning block) can
  // legitimately go several minutes without emitting — a 60s threshold
  // would surface the amber "looks stuck" callout on healthy jobs. Bump
  // to 5 min on Fly so the callout is reserved for genuinely silent
  // workers.
  const STREAM_STALL_MS = settings.flyWorker !== false ? 300_000 : 60_000;
  const [stallTick, setStallTick] = useState(() => Date.now());
  useEffect(() => {
    if (!progress) return;
    const id = setInterval(() => setStallTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [progress]);
  const stalledMessageId =
    progress &&
    stallTick - (progress.lastEventAt ?? progress.startedAt) > STREAM_STALL_MS
      ? progress.messageId
      : null;

  // Auto-fix loop: when the parent reports a runtime error from the preview iframe,
  // automatically inject it as a user message so the model sees it and can fix the code.
  const lastErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!runtimeError || !hydrated || pending) return;
    if (lastErrorRef.current === runtimeError) return;
    lastErrorRef.current = runtimeError;
    const msg = `The preview is throwing a runtime error:\n\`\`\`\n${runtimeError}\n\`\`\`\nPlease find the cause, fix the code, call Build to verify it compiles, and then Finish.`;
    void send(msg);
    onRuntimeErrorConsumed?.();
  }, [runtimeError, hydrated, pending, send, onRuntimeErrorConsumed]);

  // Render-time grouping: collapse runs of summarised messages under their summary.
  type Row =
    | { kind: "msg"; msg: StoredMessage }
    | { kind: "summary"; summary: StoredMessage; collapsed: StoredMessage[] }
    | { kind: "council-framing"; msg: StoredMessage }
    | { kind: "research-framing"; msg: StoredMessage }
    | { kind: "research-result"; msg: StoredMessage }
    | { kind: "multi-research"; msg: StoredMessage }
    | { kind: "novel-outline-edit"; msg: StoredMessage };

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const collapsedBySummary = new Map<string, StoredMessage[]>();
    for (const m of messages) {
      if (m.summarizedInto) {
        const arr = collapsedBySummary.get(m.summarizedInto) ?? [];
        arr.push(m);
        collapsedBySummary.set(m.summarizedInto, arr);
      }
    }
    for (const m of messages) {
      if (m.summarizedInto) continue;
      if (m.kind === "summary") {
        out.push({
          kind: "summary",
          summary: m,
          collapsed: collapsedBySummary.get(m.id) ?? [],
        });
      } else if (m.kind === "council-framing") {
        out.push({ kind: "council-framing", msg: m });
      } else if (m.kind === "research-framing") {
        out.push({ kind: "research-framing", msg: m });
      } else if (m.kind === "research-result") {
        out.push({ kind: "research-result", msg: m });
      } else if (m.kind === "multi-research") {
        out.push({ kind: "multi-research", msg: m });
      } else if (m.kind === "novel-outline-edit") {
        out.push({ kind: "novel-outline-edit", msg: m });
      } else {
        out.push({ kind: "msg", msg: m });
      }
    }
    return out;
  }, [messages]);

  const updateSessionNote = useCallback(
    async (noteId: string) => {
      const { getPinnedNote } = await import("@/app/db");
      // Look the note up directly — it may have been designated as memory a
      // moment ago and not be hydrated into `attachedPins` yet.
      const fullPin = await getPinnedNote(noteId);
      if (!fullPin) return;
      const noteBody =
        fullPin.messageMarkdown?.trim() ||
        fullPin.summary?.trim() ||
        "";
      const wireMessages = messages
        .filter((m) => !m.summarizedInto && !m.error && m.kind !== "summary")
        .slice(-50)
        .map((m) => ({ role: m.role, content: m.content }));
      if (wireMessages.length === 0) return;

      setSyncingNoteId(noteId);
      if (!sessionMemoryNoteId || sessionMemoryNoteId !== noteId) {
        onSessionMemoryNoteId?.(noteId);
      }
      try {
        const res = await fetch("/api/session-note/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: wireMessages,
            noteBody,
            noteTitle: fullPin.title,
            model,
            ...(settings.runpodEndpointId
              ? { runpodEndpointId: settings.runpodEndpointId }
              : {}),
          }),
        });
        if (!res.ok) {
          console.error("Session note update failed:", res.status);
          return;
        }
        const data = (await res.json()) as { updatedBody: string };
        await putPinnedNote({
          ...fullPin,
          messageMarkdown: data.updatedBody,
          updatedAt: Date.now(),
        });
        setSyncSuccessNoteId(noteId);
        setTimeout(() => setSyncSuccessNoteId(null), 1500);
      } catch (err) {
        console.error("Session note update error:", err);
      } finally {
        setSyncingNoteId(null);
      }
    },
    [messages, model, settings.runpodEndpointId, sessionMemoryNoteId, onSessionMemoryNoteId]
  );

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {!hideHeader && (
      <ChatHeader
        model={model}
        onModel={(id) => {
          setModel(id);
          if (onModelChange) {
            void onModelChange(id);
          } else {
            void updateSettings({ ...settings, defaultModel: id });
          }
        }}
        hideModelPicker={hideModelPicker}
        webSearch={settings.webSearch}
        onWebSearch={(v) => void updateSettings({ ...settings, webSearch: v })}
        imageSearch={settings.imageSearch}
        onImageSearch={(v) => void updateSettings({ ...settings, imageSearch: v })}
        advancedWeb={settings.advancedWeb === true}
        onAdvancedWeb={(v) => void updateSettings({ ...settings, advancedWeb: v })}
        codeExec={settings.codeExec === true}
        onCodeExec={(v) => void updateSettings({ ...settings, codeExec: v })}
        appCreation={settings.appCreation === true}
        onAppCreation={(v) => void updateSettings({ ...settings, appCreation: v })}
        research={settings.research ?? false}
        onResearch={(v) =>
          void updateSettings({
            ...settings,
            research: v,
            // Research forces web on so the user only flips one switch.
            // The server enforces this too; mirroring it client-side keeps
            // the pill state in sync visually. Mutually exclusive with novel
            // mode — turning research on disables novel mode in saved
            // settings so the toggle stays visually accurate.
            ...(v
              ? {
                  webSearch: true,
                  novelMode: "off" as const,
                  structuredResearch: false,
                  multiResearch: false,
                }
              : {}),
          })
        }
        structuredResearch={settings.structuredResearch === true}
        onStructuredResearch={(v) =>
          void updateSettings({
            ...settings,
            structuredResearch: v,
            // Mutually exclusive with the long-form orchestrators — it owns the
            // turn when on.
            ...(v
              ? {
                  research: false,
                  novelMode: "off" as const,
                  planMode: false,
                  councilEnabled: false,
                  multiResearch: false,
                }
              : {}),
          })
        }
        multiResearch={settings.multiResearch === true}
        onMultiResearch={(v) =>
          void updateSettings({
            ...settings,
            multiResearch: v,
            // Owns the turn when on — clear the other heavy modes. Forces web
            // search on (the report sub-agents need it), mirroring research.
            ...(v
              ? {
                  webSearch: true,
                  research: false,
                  structuredResearch: false,
                  novelMode: "off" as const,
                  planMode: false,
                  councilEnabled: false,
                }
              : {}),
          })
        }
        novelMode={settings.novelMode ?? "off"}
        onNovelMode={(v) =>
          void updateSettings({
            ...settings,
            novelMode: v,
            // Turning novel on turns research off (the server enforces
            // mutual exclusion too). Novel mode does NOT force web on —
            // chapter writers honor the user's existing web toggle and
            // cap themselves to 2 calls per chapter.
            ...(v !== "off"
              ? { research: false, planMode: false, structuredResearch: false, multiResearch: false }
              : {}),
          })
        }
        planMode={settings.planMode === true}
        onPlanMode={(v) =>
          void updateSettings({
            ...settings,
            planMode: v,
            // Plan mode forces the long-coding-edit orchestrator. It
            // conflicts with the other long-form orchestrators that own
            // the round loop — turn them off so the user only has to
            // flip one switch. The server enforces this too (see
            // route.ts: planModeEnabled is undefined unless none of
            // novel/research are active).
            ...(v
              ? {
                  novelMode: "off" as const,
                  research: false,
                  structuredResearch: false,
                  multiResearch: false,
                }
              : {}),
          })
        }
        council={settings.councilEnabled === true}
        onCouncil={(v) =>
          void updateSettings({
            ...settings,
            councilEnabled: v,
            // Council is mutually exclusive with research and novel
            // mode (they fight for the same compose/synthesis budget). The
            // server enforces this too — mirroring it client-side keeps
            // the chip state in sync without a refresh.
            ...(v
              ? {
                  research: false,
                  novelMode: "off" as const,
                  structuredResearch: false,
                  multiResearch: false,
                }
              : {}),
          })
        }
        flyWorker={settings.flyWorker !== false}
        onFlyWorker={(v) =>
          void updateSettings({
            ...settings,
            flyWorker: v,
          })
        }
        enabledModels={settings.enabledModels}
        customModels={settings.customModels}
        runpodEndpointId={settings.runpodEndpointId}
        onOpenPrefs={() => setPrefsOpen(true)}
        onAddModel={() => {
          setPrefsAddModel(true);
          setPrefsOpen(true);
        }}
        connectors={settings.connectors ?? EMPTY_CONNECTORS}
        enabledConnectorIds={settings.enabledConnectorIds ?? EMPTY_IDS}
        onToggleConnector={(id) => {
          const on = new Set(settings.enabledConnectorIds ?? []);
          if (on.has(id)) on.delete(id);
          else on.add(id);
          void updateSettings({ ...settings, enabledConnectorIds: [...on] });
        }}
        onManageConnectors={() => {
          setPrefsConnectors(true);
          setPrefsOpen(true);
        }}
        usagePct={usagePct}
        usedTokens={estimatedTokens}
        ctxLimit={ctxLimit}
        onCompact={() => void runCompaction(true)}
        compacting={compacting}
        canCompact={wireMessages.length > KEEP_TAIL_MESSAGES + 2}
        target={target}
        chatId={chatId}
        chats={chats}
        onSelectChat={onSelectChat}
        onNewChat={onNewChat}
        newChatBusy={newChatBusy}
        pending={pending}
        mobileHostId={mobileHeaderHostId}
        chatPersonaId={settings.chatPersonaId}
        onChatPersona={(id) =>
          void updateSettings({ ...settings, chatPersonaId: id })
        }
      />
      )}

      {!messagesCollapsed && (
      <div ref={scrollRef} className="scroll-area min-h-0 flex-1">
        {/* One centered reading column — the whole transcript flows like
            therapist mode rather than a card of bubbles. */}
        <div className="reader-col flex flex-col gap-6 py-6">
        {pending && <StreamingBar phase={progress?.phase} />}
        {hydrated && rows.length === 0 && (
          <EmptyState target={target} />
        )}

        {rows.map((row) => {
          if (row.kind === "council-framing") {
            const payload = row.msg.councilFraming;
            if (!payload) return null;
            // The placeholder carries `streamId` until the resume call
            // resolves; presence of streamId = framer still working. Once
            // we know the questions, streamId is cleared (see line ~3019).
            const framerLoading =
              !!row.msg.streamId && !payload.launchedAssistantId;
            return (
              <CouncilFramingCard
                key={row.msg.id}
                messageId={row.msg.id}
                payload={payload}
                launched={!!payload.launchedAssistantId}
                loading={framerLoading}
                onAnswersChange={updateFramingAnswers}
                onLaunch={launchCouncil}
                onSkip={(id) => launchCouncil(id, {})}
                onStop={framerLoading ? cancelFraming : undefined}
                thinkingText={framingThinking[row.msg.id]}
              />
            );
          }
          if (row.kind === "research-framing") {
            const payload = row.msg.researchFraming;
            if (!payload) return null;
            const framerLoading =
              !!row.msg.streamId && !payload.launchedAssistantId;
            return (
              <ResearchFramingCard
                key={row.msg.id}
                messageId={row.msg.id}
                payload={payload}
                launched={!!payload.launchedAssistantId}
                loading={framerLoading}
                onAnswersChange={updateResearchFramingAnswers}
                onLaunch={launchResearch}
                onSkip={(id) => launchResearch(id, {})}
                onFrameFirst={startResearchFraming}
                onRetryFraming={startResearchFraming}
                onStop={framerLoading ? cancelFraming : undefined}
                thinkingText={framingThinking[row.msg.id]}
              />
            );
          }
          if (row.kind === "research-result") {
            const payload = row.msg.researchResult;
            if (!payload) return null;
            const rrId = row.msg.id;
            return (
              <StructuredResearchViewer
                key={rrId}
                payload={payload}
                onPersist={(next) => updateResearchResult(rrId, next)}
              />
            );
          }
          if (row.kind === "multi-research") {
            const payload = row.msg.multiResearch;
            if (!payload) return null;
            return (
              <MultiResearchCard
                key={row.msg.id}
                messageId={row.msg.id}
                payload={payload}
                transcript={multiResearchTranscript}
                model={model}
                onPersist={updateMultiResearch}
                onSaveToNote={saveReportToNote}
              />
            );
          }
          if (row.kind === "novel-outline-edit") {
            const payload = row.msg.novelOutlineEdit;
            if (!payload) return null;
            const showCancel =
              !payload.launchedAssistantId &&
              (payload.outlining === true || payload.revising === true);
            return (
              <NovelOutlineCard
                key={row.msg.id}
                messageId={row.msg.id}
                payload={payload}
                launched={!!payload.launchedAssistantId}
                progress={novelOutlineProgress[row.msg.id]}
                onChange={updateNovelOutlineDraft}
                onGenerate={launchNovel}
                onReoutline={reOutlineNovel}
                onCancel={showCancel ? cancelNovelOutline : undefined}
              />
            );
          }
          return row.kind === "msg" ? (
            <MessageBubble
              key={row.msg.id}
              msg={row.msg}
              target={target}
              chatId={chatId}
              saved={savedMessageId === row.msg.id || appliedEditIds.has(row.msg.id)}
              autoSaved={autoSavedMessageIds.has(row.msg.id)}
              onSaveHtml={
                onSaveHtml
                  ? (html, summary) => {
                      Promise.resolve(onSaveHtml(html, summary))
                        .then(() => setSavedMessageId(row.msg.id))
                        .catch(() => {});
                    }
                  : undefined
              }
              onConvertArtifact={
                onConvertArtifact
                  ? async (html, summary) => {
                      const result = await Promise.resolve(
                        onConvertArtifact(html, summary)
                      );
                      const designerId = result?.designerId;
                      if (designerId) {
                        const next: StoredMessage = {
                          ...row.msg,
                          convertedDesignerId: designerId,
                          editedAt: Date.now(),
                        };
                        setMessages((prev) =>
                          prev.map((m) => (m.id === row.msg.id ? next : m))
                        );
                        writer.schedule(row.msg.id, next);
                        writer.flushNow();
                      }
                      return result;
                    }
                  : undefined
              }
              onPromoteArtifact={(html) => {
                const summary = (row.msg.content || "").trim().slice(0, 240);
                const next: StoredMessage = {
                  ...row.msg,
                  proposedArtifact: { html, summary, streaming: false },
                  editedAt: Date.now(),
                };
                setMessages((prev) =>
                  prev.map((m) => (m.id === row.msg.id ? next : m))
                );
                writer.schedule(row.msg.id, next);
                writer.flushNow();
              }}
              onPinArtifact={
                onPinArtifact
                  ? (html, summary) =>
                      onPinArtifact({ messageId: row.msg.id, html, summary })
                  : undefined
              }
              onPinMessage={
                onPinMessage && row.msg.role === "assistant" && row.msg.content?.trim()
                  ? () =>
                      onPinMessage({
                        messageId: row.msg.id,
                        markdown: row.msg.content,
                      })
                  : undefined
              }
              onSaveVfs={
                onSaveVfs
                  ? (proposed) => {
                      Promise.resolve(onSaveVfs(proposed))
                        .then((ok) => {
                          // Only flip to "Saved" when the override actually
                          // landed; a refused write keeps the button live.
                          if (ok !== false) setSavedMessageId(row.msg.id);
                        })
                        .catch(() => {});
                    }
                  : undefined
              }
              onDelete={() => void handleDelete(row.msg.id)}
              onForceCompleteVfs={
                row.msg.proposedVfs?.streaming && progress?.messageId !== row.msg.id
                  ? () => void forceCompleteVfs(row.msg.id)
                  : undefined
              }
              onRetry={
                row.msg.role === "assistant" && row.msg.error && !pending
                  ? () => void retry(row.msg.id)
                  : undefined
              }
              onContinue={
                row.msg.role === "assistant"
                  ? row.msg.plan?.pausedAt ||
                    (row.msg.plan &&
                      row.msg.error &&
                      row.msg.plan.steps.some((s) => s.status !== "done"))
                    ? // Plan-continue stays clickable across pending and across
                      // missing streamId. The streamId-bearing path resumes the
                      // server-side scratchpad; the cold path (TTL'd or never
                      // registered) re-prompts /api/chat with a synthesized
                      // partial so the model picks up from the visible plan
                      // state. Either way the bubble's plan card stays put.
                      // continuePlan itself bails on pending, and the card's
                      // disabled prop (driven by `progress`) greys the button
                      // while a stream is active. Same affordance covers the
                      // stalled-mid-plan case (worker hard-killed before
                      // throwing PlanPausedNeedsContinueError).
                      () => void continuePlan(row.msg.id)
                    : !pending && row.msg.error
                      ? hasCouncilEvents(row.msg.events)
                        ? () => void continueCouncil(row.msg.id)
                        : row.msg.content?.trim()
                          ? () => void continueGeneration(row.msg.id)
                          : undefined
                      : // Completed, non-errored turn: offer an in-place
                        // continuation when the model cut off at its
                        // output-token ceiling (usage.truncated drives the
                        // prominent inline button) or when the user judges any
                        // finished reply incomplete (manual "Continue message"
                        // menu action). Excludes plan / council / artifact /
                        // VFS turns and anything still streaming — those have
                        // their own resume surfaces.
                        !pending &&
                          !row.msg.streamId &&
                          !row.msg.plan &&
                          !row.msg.proposedVfs &&
                          !row.msg.proposedArtifact &&
                          !hasCouncilEvents(row.msg.events) &&
                          row.msg.content?.trim()
                        ? () => void continueGeneration(row.msg.id)
                        : undefined
                  : undefined
              }
              onRevertToHere={
                row.msg.role === "user" && !pending
                  ? () => setRevertTarget(row.msg)
                  : undefined
              }
              progress={progress?.messageId === row.msg.id ? progress : undefined}
              stalled={
                // Surface stalled only when there's a recoverable shape.
                // Without a streamId the server-side scratchpad either never
                // registered or has TTL'd out — clicking Continue would bottom
                // out at "stream lost". With one, continueStalled always has a
                // move: resume from a paused/unfinished plan or committed prose,
                // and otherwise (thinking-only — the model emitted a long
                // reasoning block then went silent before any output) abort the
                // frozen connection so the standard error + Retry takes over.
                // Including thinking here is the fix for the spinner that hangs
                // on "Thinking…" forever: that stall has no plan and no prose,
                // so the earlier content/plan-only gate left it with no
                // recourse beyond the background auto-resume reconnecting to a
                // possibly-dead worker.
                stalledMessageId === row.msg.id &&
                row.msg.role === "assistant" &&
                !!row.msg.streamId &&
                ((!!row.msg.plan &&
                  row.msg.plan.steps.some((s) => s.status !== "done")) ||
                  !!row.msg.content?.trim() ||
                  !!row.msg.thinking?.trim())
              }
              stalledResumable={
                (!!row.msg.plan &&
                  row.msg.plan.steps.some((s) => s.status !== "done")) ||
                !!row.msg.content?.trim()
              }
              onContinueStalled={
                stalledMessageId === row.msg.id && row.msg.role === "assistant"
                  ? () => continueStalled(row.msg.id)
                  : undefined
              }
              onStopPlan={
                // Wire Stop on any assistant row with an unfinished plan
                // that's not already in a terminal state. We deliberately
                // don't require a streamId or local `progress` — the most
                // common case for needing Stop is a tab that's lost its
                // SSE (or never had one) and is staring at a stuck plan
                // card. stopPlan() falls back to a local-only stop when
                // the server-side stream is gone, so the row still ends
                // up with a working Continue button.
                row.msg.role === "assistant" &&
                !!row.msg.plan &&
                !row.msg.error &&
                !row.msg.plan.pausedAt &&
                row.msg.plan.steps.some((s) => s.status !== "done")
                  ? () => void stopPlan(row.msg.id)
                  : undefined
              }
              stopping={stoppingMessageId === row.msg.id}
              onOpenDetails={onOpenDetails ? () => onOpenDetails(row.msg.id) : undefined}
              onAnnotationsChange={(id, anns) =>
                setMessages((prev) =>
                  prev.map((m) => (m.id === id ? { ...m, annotations: anns } : m))
                )
              }
              flyWorker={settings.flyWorker !== false}
            />
          ) : (
            <SummaryRow
              key={row.summary.id}
              summary={row.summary}
              collapsed={row.collapsed}
              expanded={expandedSummaryIds.has(row.summary.id)}
              onToggle={() =>
                setExpandedSummaryIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(row.summary.id)) next.delete(row.summary.id);
                  else next.add(row.summary.id);
                  return next;
                })
              }
              onDelete={() => void handleDelete(row.summary.id)}
              onRestore={() => void handleRestoreSummary(row.summary)}
            />
          );
        })}
        </div>
      </div>
      )}

      <div className={cn("flex flex-col", dockClassName)}>

      {messagesCollapsed && onToggleMessages && rows.length > 0 && (
        <button
          type="button"
          onClick={onToggleMessages}
          className="flex items-center justify-center gap-1.5 rounded-md border border-border bg-card/80 px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <ChevronUp className="h-3.5 w-3.5" />
          <MessageSquare className="h-3.5 w-3.5" />
          <span>{rows.length} message{rows.length === 1 ? "" : "s"}</span>
        </button>
      )}
      {!messagesCollapsed && onToggleMessages && rows.length > 0 && (
        <button
          type="button"
          onClick={onToggleMessages}
          className="flex items-center justify-center gap-1.5 rounded-md border border-border bg-card/80 px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <ChevronDown className="h-3.5 w-3.5" />
          <span>Hide messages</span>
        </button>
      )}

      {messagesCollapsed && pending && (
        <StreamingBar phase={progress?.phase} />
      )}

      {!!onChangeAttachedPins && (
        <AttachedPinsStrip
          pins={attachedPins ?? []}
          onChange={onChangeAttachedPins}
          disabled={pending}
          sessionMemoryNoteId={sessionMemoryNoteId}
          onSyncSessionNote={(noteId) => void updateSessionNote(noteId)}
          syncingNoteId={syncingNoteId ?? undefined}
          syncSuccessNoteId={syncSuccessNoteId ?? undefined}
          onToggleSessionMemory={(noteId) =>
            onSessionMemoryNoteId?.(
              sessionMemoryNoteId === noteId ? undefined : noteId
            )
          }
        />
      )}

      {selectionAnchor && onSelectionConsumed && (
        <SelectionChip
          anchor={selectionAnchor}
          disabled={pending}
          onClear={onSelectionConsumed}
          onPin={onSelectionPin}
          onResearch={onSelectionResearch}
          onComment={onSelectionComment}
          onDiagram={onSelectionDiagram}
        />
      )}

      <RevertConfirmDialog
        target={revertTarget}
        currentTemplateVersion={templateVersion}
        canRestoreFiles={!!onRevertToVersion}
        pending={reverting}
        onCancel={() => setRevertTarget(null)}
        onConfirm={(msg) => void handleRevertToHere(msg)}
      />

      <Composer
        ref={composerRef}
        onSend={() => void send()}
        onStop={stop}
        pending={pending}
        lockComposer={multiResearchRunning}
        canQueue={
          pending &&
          messages.some(
            (m) => m.role === "assistant" && m.streamId && !m.error
          )
        }
        model={model}
        pendingImages={pendingImages}
        pendingPdfs={pendingPdfs}
        imageError={imageError}
        onAddImages={async (files) => {
          setImageError(null);
          const slots = MAX_IMAGES_PER_MESSAGE - pendingImages.length;
          if (slots <= 0) {
            setImageError(`Up to ${MAX_IMAGES_PER_MESSAGE} images per message.`);
            return;
          }
          const accepted = files.slice(0, slots).filter((f) => f.type.startsWith("image/"));
          if (accepted.length < files.length && accepted.length === 0) {
            setImageError("Pick an image file (JPEG, PNG, HEIC, WebP, GIF).");
            return;
          }
          try {
            const next = await Promise.all(accepted.map(fileToResizedImage));
            setPendingImages((prev) => [...prev, ...next]);
          } catch (err) {
            setImageError(err instanceof Error ? err.message : "Couldn't read image.");
          }
        }}
        onRemoveImage={(id) => {
          setPendingImages((prev) => prev.filter((im) => im.id !== id));
          setImageError(null);
        }}
        onAddPdfs={async (files) => {
          setImageError(null);
          const slots = MAX_PDFS_PER_MESSAGE - pendingPdfs.length;
          if (slots <= 0) {
            setImageError(`Up to ${MAX_PDFS_PER_MESSAGE} PDFs per message.`);
            return;
          }
          const accepted = files
            .slice(0, slots)
            .filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
          if (accepted.length === 0) {
            setImageError("Pick a PDF file.");
            return;
          }
          const tooBig = accepted.find((f) => f.size > MAX_PDF_BYTES);
          if (tooBig) {
            setImageError(
              `PDF "${tooBig.name}" exceeds ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB.`
            );
            return;
          }
          try {
            const next = await Promise.all(accepted.map(fileToAttachedPdf));
            setPendingPdfs((prev) => [...prev, ...next]);
          } catch (err) {
            setImageError(err instanceof Error ? err.message : "Couldn't read PDF.");
          }
        }}
        onRemovePdf={(id) => {
          setPendingPdfs((prev) => prev.filter((p) => p.id !== id));
          setImageError(null);
        }}
        pendingCsvs={pendingCsvs}
        onAddCsvs={async (files) => {
          setImageError(null);
          const slots = MAX_CSVS_PER_MESSAGE - pendingCsvs.length;
          if (slots <= 0) {
            setImageError(`Up to ${MAX_CSVS_PER_MESSAGE} CSVs per message.`);
            return;
          }
          const accepted = files
            .slice(0, slots)
            .filter((f) => f.type === "text/csv" || /\.(csv|tsv)$/i.test(f.name));
          if (accepted.length === 0) {
            setImageError("Pick a CSV file.");
            return;
          }
          const tooBig = accepted.find((f) => f.size > MAX_CSV_BYTES);
          if (tooBig) {
            setImageError(
              `CSV "${tooBig.name}" exceeds ${Math.round(MAX_CSV_BYTES / 1024 / 1024)} MB.`
            );
            return;
          }
          try {
            const next = await Promise.all(accepted.map(fileToAttachedCsv));
            setPendingCsvs((prev) => [...prev, ...next]);
          } catch (err) {
            setImageError(err instanceof Error ? err.message : "Couldn't read CSV.");
          }
        }}
        onRemoveCsv={(id) => {
          setPendingCsvs((prev) => prev.filter((c) => c.id !== id));
          setImageError(null);
        }}
        codeExec={settings.codeExec === true}
        pendingFiles={pendingFiles}
        filesUploading={filesUploading}
        onAddFiles={async (files) => {
          setImageError(null);
          const slots = MAX_SANDBOX_FILES_PER_MESSAGE - pendingFiles.length;
          if (slots <= 0) {
            setImageError(`Up to ${MAX_SANDBOX_FILES_PER_MESSAGE} files per message.`);
            return;
          }
          const accepted = files.slice(0, slots);
          const tooBig = accepted.find((f) => f.size > MAX_SANDBOX_FILE_BYTES);
          if (tooBig) {
            setImageError(
              `File "${tooBig.name}" exceeds ${Math.round(MAX_SANDBOX_FILE_BYTES / 1024 / 1024)} MB.`
            );
            return;
          }
          setFilesUploading((n) => n + accepted.length);
          try {
            for (const f of accepted) {
              try {
                const uploaded = await uploadSandboxFile(f);
                setPendingFiles((prev) => [...prev, uploaded]);
              } catch (err) {
                setImageError(
                  err instanceof Error ? err.message : `Couldn't upload "${f.name}".`
                );
              } finally {
                setFilesUploading((n) => Math.max(0, n - 1));
              }
            }
          } catch (err) {
            setImageError(err instanceof Error ? err.message : "Upload failed.");
          }
        }}
        onRemoveFile={(id) => {
          setPendingFiles((prev) => prev.filter((f) => f.id !== id));
          setImageError(null);
        }}
        placeholder={
          multiResearchRunning
            ? "Researching reports… reply unlocks when they finish"
            : placeholder ??
              (target?.mode === "edit"
                ? "Describe the artifact you want to build…  (⌘↵ to send)"
                : target?.mode === "setup"
                  ? "Configure or refresh this instance…  (⌘↵ to send)"
                  : "Message the model…  (⌘↵ to send)")
        }
      />

      </div>

      <SettingsDialog
        open={prefsOpen}
        onOpenChange={(o) => {
          setPrefsOpen(o);
          if (!o) {
            setPrefsAddModel(false);
            setPrefsConnectors(false);
          }
        }}
        focusAddModel={prefsAddModel}
        initialTab={prefsConnectors ? "connectors" : undefined}
        settings={settings}
        onChange={(next) => void updateSettings(next)}
      />

      <SpeechStopPill />
    </div>
  );
}

// ---------- subcomponents ----------

function SpeechStopPill() {
  const speechState = useSpeechState();
  if (speechState.status === "idle" || typeof document === "undefined") {
    return null;
  }
  return createPortal(
    <button
      type="button"
      onClick={() => stopSpeaking()}
      className="fixed bottom-20 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-foreground shadow-lg hover:bg-muted"
      aria-label={
        speechState.status === "loading" ? "Generating speech" : "Stop speaking"
      }
    >
      {speechState.status === "loading" ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Generating speech…
        </>
      ) : (
        <>
          <Square className="h-3.5 w-3.5 fill-current" />
          Stop speaking
        </>
      )}
    </button>,
    document.body
  );
}

/**
 * Auto-enables RunPod-discovered model ids the first time we see them.
 * Setting a runpod endpoint is a strong signal of intent, so its models
 * should appear toggled-on in Preferences without the user hunting for the
 * switch. Each id is auto-enabled at most once (tracked in
 * `settings.autoEnabledIds`) so manually disabling a model later sticks even
 * after a refresh re-discovers it.
 *
 * Runs in the chat tree (always mounted while a chat is open) rather than
 * inside the settings dialog so a user who never opens Preferences still
 * gets the auto-enable.
 */
function useAutoEnableRunpodModels(
  settings: Settings,
  updateSettings: (next: Settings) => void | Promise<void>
) {
  const { models } = useAvailableModels(settings.runpodEndpointId);

  useEffect(() => {
    if (!settings.runpodEndpointId?.trim()) return;
    const autoEnabled = new Set(settings.autoEnabledIds ?? []);
    const newIds: string[] = [];
    for (const m of models) {
      if (!m.id.startsWith(RUNPOD_PREFIX)) continue;
      // Never auto-enable the synthetic placeholder — sending `default` to
      // ollama-style workers 404s, and we'd rather the user see no enabled
      // runpod model than have a broken one default-on.
      if (m.id === RUNPOD_DEFAULT_MODEL_ID) continue;
      if (autoEnabled.has(m.id)) continue;
      newIds.push(m.id);
    }
    if (newIds.length === 0) return;

    const baseEnabled = settings.enabledModels ?? [...DEFAULT_ENABLED_MODELS];
    const enabledSet = new Set(baseEnabled);
    const additions = newIds.filter((id) => !enabledSet.has(id));
    const nextEnabled =
      additions.length > 0 ? [...baseEnabled, ...additions] : baseEnabled;
    void updateSettings({
      ...settings,
      enabledModels: nextEnabled,
      autoEnabledIds: [...(settings.autoEnabledIds ?? []), ...newIds],
    });
  }, [models, settings, updateSettings]);
}

/**
 * Filters the live model list (fetched from /api/models) by the user's
 * `enabledModels` preference. Undefined preference → DEFAULT_ENABLED_MODELS,
 * keeping the picker short for first-time users. Two safety nets:
 * - empty subset → fall back to the full live list so we never strand the user;
 * - the active model always appears, even if the user has disabled it or it's
 *   no longer on their account (synthesizing a CloudModel from curated metadata
 *   or a generic placeholder).
 */
function useVisibleModels(
  enabledModels: string[] | undefined,
  activeModel: string,
  customModels?: string[],
  runpodEndpointId?: string
): CloudModel[] {
  const { models } = useAvailableModels(runpodEndpointId);
  return useMemo(() => {
    const base = models.length > 0 ? models : CATALOG;
    // Custom ids live in settings.customModels but aren't in the discovered
    // list, so without merging they get silently dropped from the picker even
    // when enabled.
    const seen = new Set(base.map((m) => m.id));
    const source: CloudModel[] = [...base];
    for (const id of customModels ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      source.push(defaultModelMeta(id));
    }
    const enabledIds = enabledModels ?? DEFAULT_ENABLED_MODELS;
    const subset = source.filter((m) => enabledIds.includes(m.id));
    // When the user has configured a RunPod endpoint, surface every runpod:
    // entry in the picker even if it isn't in `enabledModels`. Setting the
    // endpoint id is a strong signal of intent — making them then hunt through
    // Preferences to flip a toggle is exactly the friction the user hit here.
    let visible = subset.length === 0 ? source : subset;
    if (runpodEndpointId?.trim()) {
      const visibleIds = new Set(visible.map((m) => m.id));
      const runpodExtras = source.filter(
        (m) => m.id.startsWith(RUNPOD_PREFIX) && !visibleIds.has(m.id)
      );
      if (runpodExtras.length > 0) visible = [...visible, ...runpodExtras];
    }
    if (visible.some((m) => m.id === activeModel)) return visible;
    const active =
      source.find((m) => m.id === activeModel) ??
      catalogEntry(activeModel) ??
      defaultModelMeta(activeModel);
    return [...visible, active];
  }, [enabledModels, activeModel, models, customModels, runpodEndpointId]);
}


/**
 * Recent-chats dropdown + "New chat" button. Only renders when the parent
 * provides multi-chat callbacks (designer mode).
 *
 * `newChatBusy` is INDICATOR-ONLY: it surfaces the background notes refresh
 * without blocking the New-chat action. Creating another chat while a prior
 * refresh is in flight is fine — the refresh has its own lifecycle (see
 * `refreshNotesInBackground` in app/designer/[id]/page.tsx) and writes to
 * the designer keyed by id, so concurrent refreshes are last-write-wins on
 * the notes field.
 *
 * Streaming (`pending`) still blocks new-chat — we don't want to strand a
 * half-finished assistant turn.
 */
function ChatPicker(props: {
  chatId: string;
  chats: StoredChat[];
  onSelectChat?: (chatId: string) => void;
  onNewChat?: () => void | Promise<void>;
  newChatBusy?: boolean;
  pending: boolean;
}) {
  const active = props.chats.find((c) => c.id === props.chatId);
  const others = props.chats.filter((c) => c.id !== props.chatId).slice(0, 12);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title="Switch chat or start a new one."
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground transition",
          "hover:bg-muted hover:text-foreground",
          "data-[state=open]:bg-muted data-[state=open]:text-foreground"
        )}
      >
        {props.newChatBusy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <MessagesSquare className="h-3 w-3" />
        )}
        <span className="max-w-[110px] truncate">
          {active?.title ?? "Chat"}
        </span>
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[260px]">
        <DropdownMenuItem
          disabled={props.pending || !props.onNewChat}
          onSelect={() => {
            if (props.pending || !props.onNewChat) return;
            void props.onNewChat();
          }}
        >
          <Plus className="mr-2 h-3.5 w-3.5" />
          <span>New chat</span>
          {props.newChatBusy && (
            <span className="ml-auto text-[10px] text-muted-foreground">notes updating…</span>
          )}
        </DropdownMenuItem>
        {others.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Recent
            </DropdownMenuLabel>
            {others.map((c) => (
              <DropdownMenuItem
                key={c.id}
                disabled={props.pending || !props.onSelectChat}
                onSelect={() => {
                  if (props.pending || !props.onSelectChat) return;
                  props.onSelectChat(c.id);
                }}
              >
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="truncate">{c.title}</span>
                </span>
                {c.researchFor && (
                  <span className="ml-2 shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                    research
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Chip strip showing the pinned notes attached to this chat as ephemeral
 * context. Each chip is removable; the "+ Attach note" trigger opens a
 * picker drawer over the chat for adding more. The list of attached pin
 * ids is owned by the parent and persisted to StoredChat.attachedPinIds
 * via `onChange`.
 *
 * Rendered just above the Composer. The pin contents are injected into
 * the system prompt by `buildExtraSystem` (see app/lib/extra-system.ts);
 * this component only handles the UI side.
 */
/**
 * Renders the note-canvas "Editing this passage" chip above the Composer.
 * The chip's body is a short preview of the highlighted text; clicking the
 * × clears the selection (the parent owns the anchor state). Wraps to a
 * "max two lines" preview so a long selection doesn't push the composer
 * off-screen.
 */
function SelectionChip(props: {
  anchor: SelectionAnchor;
  disabled?: boolean;
  onClear: () => void;
  onPin?: () => void;
  onResearch?: () => void;
  onComment?: () => void;
  onDiagram?: () => void;
}) {
  const preview = props.anchor.selectedText.replace(/\s+/g, " ").trim();
  const trimmed = preview.length > 200 ? preview.slice(0, 200) + "…" : preview;
  const hasActions =
    !!props.onPin || !!props.onResearch || !!props.onComment || !!props.onDiagram;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-amber-400/50 bg-amber-400/10 px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 font-medium text-amber-700 dark:text-amber-300">
          Editing
        </span>
        <span className="line-clamp-2 flex-1 italic text-foreground/80">
          “{trimmed}”
        </span>
        <button
          type="button"
          onClick={props.onClear}
          disabled={props.disabled}
          aria-label="Clear selection"
          className="shrink-0 rounded-md p-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {hasActions && (
        <div className="flex flex-wrap items-center gap-1.5 pl-12">
          {props.onComment && (
            <button
              type="button"
              onClick={props.onComment}
              disabled={props.disabled}
              className="tap inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-card px-2 py-0.5 text-[11px] text-foreground/80 transition hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <MessageSquare className="h-3 w-3" />
              <span>Comment</span>
            </button>
          )}
          {props.onDiagram && (
            <button
              type="button"
              onClick={props.onDiagram}
              disabled={props.disabled}
              className="tap inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-card px-2 py-0.5 text-[11px] text-foreground/80 transition hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <Workflow className="h-3 w-3" />
              <span>Diagram</span>
            </button>
          )}
          {props.onResearch && (
            <button
              type="button"
              onClick={props.onResearch}
              disabled={props.disabled}
              className="tap inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-card px-2 py-0.5 text-[11px] text-foreground/80 transition hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <Search className="h-3 w-3" />
              <span>Research</span>
            </button>
          )}
          {props.onPin && (
            <button
              type="button"
              onClick={props.onPin}
              disabled={props.disabled}
              className="tap inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-card px-2 py-0.5 text-[11px] text-foreground/80 transition hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <Pin className="h-3 w-3" />
              <span>Pin as note</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AttachedPinsStrip(props: {
  pins: StoredPinnedNote[];
  onChange: (nextIds: string[]) => void | Promise<void>;
  disabled?: boolean;
  sessionMemoryNoteId?: string;
  onSyncSessionNote?: (noteId: string) => void;
  syncingNoteId?: string;
  syncSuccessNoteId?: string;
  onToggleSessionMemory?: (noteId: string) => void;
}) {
  // Why the picker is open: "memory" picks designate the note as session
  // memory (the parent attaches + designates in one chat update), "attach"
  // picks just attach it. null = closed.
  const [pickerMode, setPickerMode] = useState<"attach" | "memory" | null>(null);

  const remove = (id: string) => {
    const next = props.pins.filter((p) => p.id !== id).map((p) => p.id);
    void props.onChange(next);
  };
  const add = (id: string) => {
    const mode = pickerMode;
    setPickerMode(null);
    if (mode === "memory") {
      props.onToggleSessionMemory?.(id);
      return;
    }
    if (props.pins.some((p) => p.id === id)) return;
    void props.onChange([...props.pins.map((p) => p.id), id]);
  };

  const hasPins = props.pins.length > 0;
  const memoryPin = props.pins.find((p) => p.id === props.sessionMemoryNoteId);
  const memoryIsSyncing = memoryPin?.id === props.syncingNoteId;
  const memoryIsSuccess = memoryPin?.id === props.syncSuccessNoteId;
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 px-1">
        <button
          type="button"
          onClick={() => setPickerMode("attach")}
          disabled={props.disabled}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-dashed border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground transition",
            "hover:bg-muted hover:text-foreground",
            "disabled:opacity-50"
          )}
          title="Attach a pinned note as ephemeral context for this chat."
        >
          <BookOpen className="h-3 w-3" />
          <span>{hasPins ? "Attach another note" : "Attach note"}</span>
        </button>
        {memoryPin ? (
          <button
            type="button"
            onClick={() => !memoryIsSyncing && props.onSyncSessionNote?.(memoryPin.id)}
            disabled={memoryIsSyncing || props.disabled}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition",
              "border-primary/40 bg-primary/10 text-primary",
              "hover:bg-primary/20",
              "disabled:opacity-50"
            )}
            title="Summarize conversation into session memory"
          >
            {memoryIsSuccess ? (
              <Check className="h-3 w-3 text-green-600" />
            ) : (
              <RotateCw className={cn("h-3 w-3", memoryIsSyncing && "animate-spin")} />
            )}
            <span>Summarize notes</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setPickerMode("memory")}
            disabled={props.disabled}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border border-dashed border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground transition",
              "hover:bg-muted hover:text-foreground",
              "disabled:opacity-50"
            )}
            title="Attach a note as session memory — the model will reference it, and you can sync conversation insights into it."
          >
            <Sparkles className="h-3 w-3" />
            <span>Session memory</span>
          </button>
        )}
        {props.pins.map((pin) => {
          const title = deriveNoteTitle(pin);
          const isMemory = pin.id === props.sessionMemoryNoteId;
          const isSyncing = pin.id === props.syncingNoteId;
          const isSuccess = pin.id === props.syncSuccessNoteId;
          return (
            <span
              key={pin.id}
              className={cn(
                "group/pin inline-flex max-w-[240px] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-foreground",
                isMemory
                  ? "border-primary/40 bg-primary/10"
                  : "border-border bg-muted"
              )}
              title={pin.summary || title}
            >
              {isMemory ? (
                <button
                  type="button"
                  onClick={() => props.onToggleSessionMemory?.(pin.id)}
                  title="Remove session memory designation"
                  className="shrink-0 text-primary transition hover:text-primary/70"
                >
                  <Sparkles className="h-3 w-3" />
                </button>
              ) : (
                <BookOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{title}</span>
              {!isMemory && !isSyncing && !isSuccess && (
                <button
                  type="button"
                  onClick={() => props.onSyncSessionNote?.(pin.id)}
                  disabled={props.disabled}
                  title="Set as session memory and sync"
                  className="tap hidden h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:text-primary group-hover/pin:inline-flex"
                >
                  <RotateCw className="h-3 w-3" />
                </button>
              )}
              <button
                type="button"
                onClick={() => remove(pin.id)}
                disabled={props.disabled || isSyncing}
                aria-label={`Remove ${title}`}
                className="tap -mr-1 ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:text-destructive disabled:opacity-50"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}
      </div>
      {pickerMode !== null && (
        <PinPickerDialog
          excludeIds={new Set(props.pins.map((p) => p.id))}
          onPick={add}
          onClose={() => setPickerMode(null)}
        />
      )}
    </>
  );
}

/** Render `text` with case-insensitive occurrences of `query` highlighted, so a
 *  search match shows *why* the note surfaced. */
function HighlightedText({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const hit = lower.indexOf(ql, i);
    if (hit === -1) {
      out.push(text.slice(i));
      break;
    }
    if (hit > i) out.push(text.slice(i, hit));
    out.push(
      <mark
        key={key++}
        className="rounded bg-amber-300/40 text-foreground dark:bg-amber-400/30"
      >
        {text.slice(hit, hit + q.length)}
      </mark>
    );
    i = hit + q.length;
  }
  return <>{out}</>;
}

/**
 * Modal picker over the chat for selecting a pinned note. Lists every pinned
 * note in the user's library newest-first with a ranked, full-text search
 * (title + source + body) so a note is findable by anything it contains. Each
 * row shows a derived title, a source line, and a match snippet, plus a
 * "Quick Look" preview (the eye button / Enter) that renders the whole note
 * read-only without attaching it — attaching only injects the note as context,
 * it never edits the underlying note. `excludeIds` grays out pins that are
 * already attached so the user can't double-add.
 */
function PinPickerDialog(props: {
  excludeIds: Set<string>;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [pins, setPins] = useState<StoredPinnedNote[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [previewNote, setPreviewNote] = useState<StoredPinnedNote | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { listPinnedNotes } = await import("@/app/db");
      const all = await listPinnedNotes();
      if (cancelled) return;
      setPins(all);
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => searchNotes(pins, query), [pins, query]);

  // Keep the keyboard cursor in range as the result set changes under it.
  useEffect(() => {
    setActiveIdx((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      // Plain Enter attaches the active row; ⌘/Ctrl+Enter peeks instead.
      const note = filtered[activeIdx];
      if (!note) return;
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) setPreviewNote(note);
      else if (!props.excludeIds.has(note.id)) props.onPick(note.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <>
    <div
      role="dialog"
      aria-label="Attach pinned note"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={props.onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="text-sm font-semibold">Attach pinned note</span>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            className="tap inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="border-b border-border px-3 py-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search titles and note contents…"
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-foreground/30"
            autoFocus
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!hydrated ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              {pins.length === 0
                ? "No pinned notes yet. Pin a message or artifact to attach it here."
                : "No pins match that search."}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map((p, idx) => {
                const already = props.excludeIds.has(p.id);
                const title = deriveNoteTitle(p);
                const source = p.chatTitle ? `From “${p.chatTitle}”` : null;
                const snippet = noteSnippet(p, query);
                const isActive = idx === activeIdx;
                return (
                  <li
                    key={p.id}
                    ref={(el) => {
                      if (isActive) el?.scrollIntoView({ block: "nearest" });
                    }}
                    className={cn(
                      "flex items-stretch gap-1 transition",
                      isActive && "bg-muted/60"
                    )}
                    onMouseEnter={() => setActiveIdx(idx)}
                  >
                    <button
                      type="button"
                      disabled={already}
                      onClick={() => props.onPick(p.id)}
                      className={cn(
                        "flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5 text-left transition",
                        already ? "cursor-default opacity-50" : "hover:bg-muted"
                      )}
                    >
                      <PinThumbnail note={p} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            <HighlightedText text={title} query={query} />
                          </span>
                          {already && (
                            <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                              Attached
                            </span>
                          )}
                        </span>
                        {source && (
                          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                            <HighlightedText text={source} query={query} />
                          </span>
                        )}
                        {snippet && (
                          <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground/90">
                            <HighlightedText text={snippet} query={query} />
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewNote(p)}
                      aria-label={`Preview ${title}`}
                      title="Quick Look — preview without attaching"
                      className="tap my-1 mr-1 inline-flex w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <footer className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>↑↓ navigate</span>
          <span>↵ attach</span>
          <span className="inline-flex items-center gap-1">
            <Eye className="h-3 w-3" /> preview
          </span>
        </footer>
      </div>
    </div>
    {previewNote && (
      <NoteViewer note={previewNote} onClose={() => setPreviewNote(null)} />
    )}
    </>,
    document.body,
  );
}

/** Tiny visual for a picker row: a non-interactive thumbnail of the artifact
 *  when the note has one, otherwise a book glyph. Helps tell notes apart at a
 *  glance (the user's "hard to tell what I'm looking at"). */
function PinThumbnail({ note }: { note: StoredPinnedNote }) {
  if (note.artifactHtml) {
    return (
      <span className="relative mt-0.5 block h-9 w-9 shrink-0 overflow-hidden rounded border border-border bg-white">
        <iframe
          title=""
          aria-hidden
          tabIndex={-1}
          srcDoc={note.artifactHtml}
          sandbox=""
          // Render the page at ~3× then scale down so the thumbnail shows the
          // layout, not a zoomed-in top-left corner.
          className="pointer-events-none absolute left-0 top-0 h-[108px] w-[108px] origin-top-left scale-[0.333] border-0"
        />
      </span>
    );
  }
  return (
    <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
  );
}

function ChatHeader(props: {
  model: string;
  onModel: (id: string) => void;
  hideModelPicker?: boolean;
  webSearch: boolean;
  onWebSearch: (v: boolean) => void;
  imageSearch: boolean;
  onImageSearch: (v: boolean) => void;
  advancedWeb: boolean;
  onAdvancedWeb: (v: boolean) => void;
  codeExec: boolean;
  onCodeExec: (v: boolean) => void;
  appCreation: boolean;
  onAppCreation: (v: boolean) => void;
  research: boolean;
  onResearch: (v: boolean) => void;
  structuredResearch: boolean;
  onStructuredResearch: (v: boolean) => void;
  novelMode: "off" | "short" | "standard" | "long";
  onNovelMode: (v: "off" | "short" | "standard" | "long") => void;
  planMode: boolean;
  onPlanMode: (v: boolean) => void;
  council: boolean;
  onCouncil: (v: boolean) => void;
  multiResearch: boolean;
  onMultiResearch: (v: boolean) => void;
  flyWorker: boolean;
  onFlyWorker: (v: boolean) => void;
  enabledModels?: string[];
  customModels?: string[];
  runpodEndpointId?: string;
  onOpenPrefs: () => void;
  /** Open Preferences and jump straight to the "Add a model" card. */
  onAddModel?: () => void;
  /** Configured MCP connectors + which are toggled on for this chat. */
  connectors: McpConnector[];
  enabledConnectorIds: string[];
  onToggleConnector: (id: string) => void;
  /** Open Preferences on the Connectors tab (add/manage). */
  onManageConnectors?: () => void;
  usagePct: number;
  usedTokens: number;
  ctxLimit: number;
  onCompact: () => void;
  compacting: boolean;
  canCompact: boolean;
  target?: ChatTarget;
  chatId: string;
  chats?: StoredChat[];
  onSelectChat?: (chatId: string) => void;
  onNewChat?: () => void | Promise<void>;
  newChatBusy?: boolean;
  pending: boolean;
  /** When set, portal the mobile chip into this DOM element instead of inline. */
  mobileHostId?: string;
  chatPersonaId?: string;
  onChatPersona: (id: string | undefined) => void;
}) {
  const pct = Math.round(props.usagePct * 100);
  const overWarn = pct >= 75;
  // Resolve the optional portal target after mount. The host div lives in the
  // page header (e.g. canvas), so it's in the DOM by the time this effect
  // runs. Re-check on id change in case the parent rewires the slot.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!props.mobileHostId) {
      setPortalTarget(null);
      return;
    }
    setPortalTarget(document.getElementById(props.mobileHostId));
  }, [props.mobileHostId]);
  // One header for every breakpoint: a quiet status line + a sheet holding
  // all controls. The old always-visible desktop toolbar is gone — the calm
  // default view is the point of the redesign.
  const mobileHeader = (
    <ChatHeaderMobile {...props} pct={pct} overWarn={overWarn} />
  );
  return portalTarget ? createPortal(mobileHeader, portalTarget) : mobileHeader;
}

/** Sentinel <option> value for the model picker's "add a model" shortcut.
 *  Namespaced so it can never collide with a real model id. */
const ADD_MODEL_OPTION = "__add_model__";

/** A labeled on/off row used in the Tools and Advanced tabs of chat settings. */
function CsToggle({
  icon,
  name,
  desc,
  on,
  onToggle,
}: {
  icon: React.ReactNode;
  name: string;
  desc: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className={cn(
        "tap flex items-start justify-between gap-3 rounded-xl border px-3 py-3 text-left",
        on
          ? "border-[color-mix(in_oklab,var(--color-accent-2)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-accent-2)_10%,transparent)]"
          : "border-border bg-card"
      )}
    >
      <span className="flex min-w-0 gap-2.5">
        <span className={cn("mt-0.5 shrink-0", on ? "text-[var(--color-accent-2)]" : "text-foreground")}>
          {icon}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className={cn("text-sm font-medium", on && "text-[var(--color-accent-2)]")}>{name}</span>
          <span className="text-xs text-muted-foreground">{desc}</span>
        </span>
      </span>
      <span className={cn("mt-0.5 h-6 w-10 shrink-0 rounded-full transition", on ? "bg-[var(--color-accent-2)]" : "bg-muted")}>
        <span className={cn("block h-5 w-5 translate-y-0.5 rounded-full bg-white shadow transition", on ? "translate-x-[18px]" : "translate-x-0.5")} />
      </span>
    </button>
  );
}

/**
 * Chat header (all breakpoints): thin status row + a •••  trigger that opens
 * a bottom sheet with the full controls. Tap targets are sized for touch
 * (44px); the iOS keyboard never collides because the sheet respects
 * safe-area.
 */
function ChatHeaderMobile({
  model,
  onModel,
  hideModelPicker,
  webSearch,
  onWebSearch,
  imageSearch,
  onImageSearch,
  advancedWeb,
  onAdvancedWeb,
  codeExec,
  onCodeExec,
  appCreation,
  onAppCreation,
  research,
  onResearch,
  structuredResearch,
  onStructuredResearch,
  novelMode,
  onNovelMode,
  planMode,
  onPlanMode,
  council,
  onCouncil,
  multiResearch,
  onMultiResearch,
  flyWorker,
  onFlyWorker,
  enabledModels,
  customModels,
  runpodEndpointId,
  onOpenPrefs,
  onAddModel,
  connectors,
  enabledConnectorIds,
  onToggleConnector,
  onManageConnectors,
  usedTokens,
  ctxLimit,
  onCompact,
  compacting,
  canCompact,
  target,
  pct,
  overWarn,
  chatId,
  chats,
  onSelectChat,
  onNewChat,
  newChatBusy,
  pending,
  chatPersonaId,
  onChatPersona,
}: {
  model: string;
  onModel: (id: string) => void;
  hideModelPicker?: boolean;
  webSearch: boolean;
  onWebSearch: (v: boolean) => void;
  imageSearch: boolean;
  onImageSearch: (v: boolean) => void;
  advancedWeb: boolean;
  onAdvancedWeb: (v: boolean) => void;
  codeExec: boolean;
  onCodeExec: (v: boolean) => void;
  appCreation: boolean;
  onAppCreation: (v: boolean) => void;
  research: boolean;
  onResearch: (v: boolean) => void;
  structuredResearch: boolean;
  onStructuredResearch: (v: boolean) => void;
  novelMode: "off" | "short" | "standard" | "long";
  onNovelMode: (v: "off" | "short" | "standard" | "long") => void;
  planMode: boolean;
  onPlanMode: (v: boolean) => void;
  council: boolean;
  onCouncil: (v: boolean) => void;
  multiResearch: boolean;
  onMultiResearch: (v: boolean) => void;
  flyWorker: boolean;
  onFlyWorker: (v: boolean) => void;
  enabledModels?: string[];
  customModels?: string[];
  runpodEndpointId?: string;
  onOpenPrefs: () => void;
  onAddModel?: () => void;
  connectors: McpConnector[];
  enabledConnectorIds: string[];
  onToggleConnector: (id: string) => void;
  onManageConnectors?: () => void;
  usedTokens: number;
  ctxLimit: number;
  onCompact: () => void;
  compacting: boolean;
  canCompact: boolean;
  target?: ChatTarget;
  pct: number;
  overWarn: boolean;
  chatId: string;
  chats?: StoredChat[];
  onSelectChat?: (chatId: string) => void;
  onNewChat?: () => void | Promise<void>;
  newChatBusy?: boolean;
  pending: boolean;
  chatPersonaId?: string;
  onChatPersona: (id: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"model" | "tools" | "turn" | "advanced">("model");
  const visibleModels = useVisibleModels(
    enabledModels,
    model,
    customModels,
    runpodEndpointId
  );
  const currentModel = visibleModels.find((m) => m.id === model);

  // The heavy behaviors (research, structured, novel, plan, council) are
  // mutually exclusive — collapse them into one "This turn" selector. Each
  // on* handler already clears the conflicting modes, so we only ever fire one.
  const currentTurn:
    | "normal"
    | "research"
    | "structured"
    | "multi"
    | "novel"
    | "plan"
    | "council" =
    novelMode && novelMode !== "off"
      ? "novel"
      : council
        ? "council"
        : planMode
          ? "plan"
          : structuredResearch
            ? "structured"
            : multiResearch
              ? "multi"
              : research
                ? "research"
                : "normal";
  const setTurn = (t: typeof currentTurn) => {
    switch (t) {
      case "normal":
        if (research) onResearch(false);
        else if (structuredResearch) onStructuredResearch(false);
        else if (multiResearch) onMultiResearch(false);
        else if (novelMode && novelMode !== "off") onNovelMode("off");
        else if (planMode) onPlanMode(false);
        else if (council) onCouncil(false);
        break;
      case "research":
        onResearch(true);
        break;
      case "structured":
        onStructuredResearch(true);
        break;
      case "multi":
        onMultiResearch(true);
        break;
      case "novel":
        onNovelMode(novelMode && novelMode !== "off" ? novelMode : "standard");
        break;
      case "plan":
        onPlanMode(true);
        break;
      case "council":
        onCouncil(true);
        break;
    }
  };

  const TURN_OPTS: { id: typeof currentTurn; label: string; desc: string }[] = [
    { id: "normal", label: "Normal", desc: "A standard chat reply." },
    { id: "research", label: "Research", desc: "Planner spins up parallel sub-agents, then a synthesizer writes the answer. Best for multi-faceted questions. Runs in the background — safe to close the tab." },
    { id: "multi", label: "Multi Research", desc: "Drafts several research prompts you can edit, then runs them in parallel — each streams back as its own full report you can keep chatting about. The composer locks until they finish." },
    { id: "structured", label: "Structured", desc: "Drops a structured results table you can re-run and append to (and save as a Research app)." },
    { id: "novel", label: "Novel", desc: "A long, multi-chapter novel run." },
    { id: "plan", label: "Plan", desc: "Long coding edits are decomposed into a checklist of bounded steps, cached server-side and resumable." },
    { id: "council", label: "Council", desc: "A multi-perspective debate before each answer. Configure members in Preferences → Council." },
  ];

  return (
    <div className="reader-col flex items-center gap-2 py-1">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="tap flex min-w-0 flex-1 items-center gap-2 px-0 py-1 text-left"
        aria-label="Open chat settings"
      >
        {target && (
          <PaperPill tone="neutral" className="shrink-0">
            {target.mode}
          </PaperPill>
        )}
        {currentTurn !== "normal" && (
          <PaperPill tone="success" className="shrink-0">
            {TURN_OPTS.find((o) => o.id === currentTurn)?.label}
          </PaperPill>
        )}
        {webSearch && (
          <Globe className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent-2)]" />
        )}
        {chatPersonaId && (
          <PaperPill tone="success" className="shrink-0 max-w-[10rem] truncate">
            {chatPersonaById(chatPersonaId)?.name}
          </PaperPill>
        )}
        {!hideModelPicker && currentModel && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {currentModel.label}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
            <span
              className={cn(
                "block h-full rounded-full transition-all",
                overWarn ? "bg-amber-600/70" : "bg-primary"
              )}
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          </span>
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {Math.round(usedTokens / 1000)}k
          </span>
        </span>
      </button>
      <Button
        type="button"
        size="icon-touch"
        variant="ghost"
        onClick={() => setOpen(true)}
        aria-label="Chat settings"
        className="tap shrink-0"
      >
        <MoreHorizontal className="h-5 w-5" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent variant="sheet" className="gap-3 sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Chat settings</DialogTitle>
          </DialogHeader>

          {/* Tabs - same pattern as the app Settings sheet. */}
          <div className="flex gap-1 rounded-xl border border-border bg-secondary/40 p-1">
            {([
              ["model", "Model"],
              ["tools", "Tools"],
              ["turn", "This turn"],
              ["advanced", "Advanced"],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  "tap flex-1 rounded-lg px-2 py-1.5 text-xs font-medium",
                  tab === id
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "model" && (
            <div className="flex flex-col gap-3">
              {(onNewChat || (chats && chats.length > 1)) && (
                <div className="flex flex-col gap-2">
                  {onNewChat && (
                    <Button
                      variant="outline"
                      className="tap h-11 justify-start gap-2"
                      disabled={pending || !!newChatBusy}
                      onClick={() => {
                        void onNewChat();
                        setOpen(false);
                      }}
                    >
                      {newChatBusy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Plus className="h-4 w-4" />
                      )}
                      New chat
                    </Button>
                  )}
                  {chats && chats.length > 1 && (
                    <select
                      aria-label="Switch chat"
                      value={chatId}
                      disabled={pending || !!newChatBusy || !onSelectChat}
                      onChange={(e) => {
                        if (!onSelectChat) return;
                        onSelectChat(e.target.value);
                        setOpen(false);
                      }}
                      className="w-full min-w-0 rounded-lg border border-border bg-card px-3 py-2.5 text-base text-foreground outline-none focus:border-foreground/30"
                    >
                      {chats.slice(0, 12).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
              {!hideModelPicker && (
                <>
                  {(() => {
                    const visibleIds = new Set(visibleModels.map((m) => m.id));
                    const jobs = TASK_PICKS.filter((t) => visibleIds.has(t.model));
                    if (jobs.length === 0) return null;
                    const current = taskForModel(model);
                    return (
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium">Best for the job</span>
                        <select
                          value={current?.task ?? ""}
                          onChange={(e) => {
                            const job = jobs.find((t) => t.task === e.target.value);
                            if (job) onModel(job.model);
                          }}
                          className="w-full min-w-0 rounded-lg border border-border bg-card px-3 py-2.5 text-base text-foreground outline-none focus:border-foreground/30"
                        >
                          <option value="" disabled>
                            Choose a task...
                          </option>
                          {jobs.map((t) => (
                            <option key={t.task} value={t.task}>
                              {t.label} - {t.hint}
                            </option>
                          ))}
                        </select>
                      </label>
                    );
                  })()}
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium">Model</span>
                    <select
                      value={model}
                      onChange={(e) => {
                        // The trailing "+ Add a model…" entry isn't a real
                        // model - it routes the user to Preferences' add-model
                        // card so they're never stuck when their model is
                        // missing from the list.
                        if (e.target.value === ADD_MODEL_OPTION) {
                          setOpen(false);
                          onAddModel?.();
                          return;
                        }
                        onModel(e.target.value);
                      }}
                      className="w-full min-w-0 rounded-lg border border-border bg-card px-3 py-2.5 text-base text-foreground outline-none focus:border-foreground/30"
                    >
                      {visibleModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label} · {m.size}
                          {burnNote(m.id) ? ` · ${burnNote(m.id)}` : ""}
                        </option>
                      ))}
                      {onAddModel && (
                        <option value={ADD_MODEL_OPTION}>
                          ＋ Add a model not listed…
                        </option>
                      )}
                    </select>
                    <span className="text-[11px] text-muted-foreground">
                      Don&apos;t see your model? Choose{" "}
                      <span className="font-medium">Add a model not listed</span>{" "}
                      to add it. “~Nx” is roughly how fast a model drains your
                      Ollama Cloud plan vs the lightest model (GPT-OSS 20B =
                      ~1x).
                    </span>
                  </label>
                </>
              )}
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">Persona</span>
                <select
                  value={chatPersonaId ?? ""}
                  onChange={(e) => onChatPersona(e.target.value || undefined)}
                  className={cn(
                    "w-full min-w-0 rounded-lg border px-3 py-2.5 text-base outline-none",
                    chatPersonaId
                      ? "border-[color-mix(in_oklab,var(--color-accent-2)_30%,transparent)] bg-[color-mix(in_oklab,var(--color-accent-2)_10%,transparent)] text-[var(--color-accent-2)]"
                      : "border-border bg-card text-foreground focus:border-foreground/30"
                  )}
                >
                  <option value="">Default</option>
                  {CHAT_PERSONAS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {tab === "tools" && (
            <div className="flex flex-col gap-2.5">
              <CsToggle icon={<Globe className="h-4 w-4" />} name="Web search" desc="The model can call web_search / web_fetch." on={webSearch} onToggle={() => onWebSearch(!webSearch)} />
              <CsToggle icon={<ImageIcon className="h-4 w-4" />} name="Image search" desc="Embed real photos in answers." on={imageSearch} onToggle={() => onImageSearch(!imageSearch)} />
              <CsToggle icon={<Terminal className="h-4 w-4" />} name="Advanced web" desc="Headless browser, raw HTTP, and a sandboxed curl/jq shell." on={advancedWeb} onToggle={() => onAdvancedWeb(!advancedWeb)} />
              <CsToggle icon={<Code2 className="h-4 w-4" />} name="Code execution" desc="Run python/node (ffmpeg + file I/O) to convert files, crunch data, or scrape." on={codeExec} onToggle={() => onCodeExec(!codeExec)} />
              <CsToggle icon={<Wand2 className="h-4 w-4" />} name="App creation" desc="Turn a chat answer into an interactive mini-app." on={appCreation} onToggle={() => onAppCreation(!appCreation)} />

              {/* Custom MCP connectors: one toggle per configured server. */}
              <div className="mt-1.5 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Connectors
                </span>
                {onManageConnectors && (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onManageConnectors();
                    }}
                    className="tap text-[11px] font-medium text-[var(--color-accent-2)]"
                  >
                    Manage
                  </button>
                )}
              </div>
              {connectors.length === 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onManageConnectors?.();
                  }}
                  className="tap rounded-xl border border-dashed border-border bg-card px-3 py-3 text-left text-xs text-muted-foreground hover:text-foreground"
                >
                  <span className="flex items-center gap-2">
                    <Plug className="h-4 w-4" />
                    Connect an MCP server to ask questions against your own tools.
                  </span>
                </button>
              ) : (
                connectors.map((c) => (
                  <CsToggle
                    key={c.id}
                    icon={<Plug className="h-4 w-4" />}
                    name={c.name}
                    desc={`${c.tools.length} tool${c.tools.length === 1 ? "" : "s"} · ${hostOf(c.url)}`}
                    on={enabledConnectorIds.includes(c.id)}
                    onToggle={() => onToggleConnector(c.id)}
                  />
                ))
              )}
            </div>
          )}

          {tab === "turn" && (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-1.5">
                {TURN_OPTS.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setTurn(o.id)}
                    aria-pressed={currentTurn === o.id}
                    className={cn(
                      "tap rounded-lg border px-2 py-2.5 text-xs font-medium transition",
                      currentTurn === o.id
                        ? "border-[color-mix(in_oklab,var(--color-accent-2)_50%,transparent)] bg-[color-mix(in_oklab,var(--color-accent-2)_16%,transparent)] text-[var(--color-accent-2)]"
                        : "border-border bg-card text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <div className="rounded-xl border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground">
                {TURN_OPTS.find((o) => o.id === currentTurn)?.desc}
              </div>
              {currentTurn === "novel" && (
                <div className="grid grid-cols-3 gap-1.5">
                  {(["short", "standard", "long"] as const).map((len) => (
                    <button
                      key={len}
                      type="button"
                      onClick={() => onNovelMode(len)}
                      aria-pressed={novelMode === len}
                      className={cn(
                        "tap rounded-md border px-2 py-1.5 text-xs capitalize",
                        novelMode === len
                          ? "border-[color-mix(in_oklab,var(--color-accent-2)_50%,transparent)] bg-[color-mix(in_oklab,var(--color-accent-2)_20%,transparent)] text-[var(--color-accent-2)]"
                          : "border-border bg-card text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {len}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "advanced" && (
            <div className="flex flex-col gap-2.5">
              <CsToggle
                icon={<Cloud className="h-4 w-4" />}
                name="Fly worker"
                desc={
                  flyWorker
                    ? "On - sends run on the Fly.io worker (no 15-min wall, 1-hour kill switch). On by default; turn off only to debug."
                    : "Off - sends use Vercel waitUntil (~15-min ceiling). Flip on for long jobs."
                }
                on={flyWorker}
                onToggle={() => onFlyWorker(!flyWorker)}
              />
              <CsToggle
                icon={<ListChecks className="h-4 w-4" />}
                name="Force plan mode"
                desc="Force step-by-step plans even on smaller coding edits (auto-enables for large ones)."
                on={planMode}
                onToggle={() => onPlanMode(!planMode)}
              />
              <div className="rounded-xl border border-border bg-card px-3 py-3">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Context usage</span>
                  <span className="font-mono tabular-nums">
                    {Math.round(usedTokens / 1000)}k / {Math.round(ctxLimit / 1000)}k · {pct}%
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className={cn(
                      "block h-full rounded-full transition-all",
                      overWarn ? "bg-amber-600/70" : "bg-primary"
                    )}
                    style={{ width: `${Math.max(2, pct)}%` }}
                  />
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  Auto-compact at {Math.round(SUMMARIZE_AT * 100)}%.
                </div>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  onCompact();
                  setOpen(false);
                }}
                disabled={compacting || !canCompact}
                className="tap h-11 gap-2"
              >
                {compacting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                Compact older messages
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  onOpenPrefs();
                }}
                className="tap h-11 gap-2"
              >
                <Settings2 className="h-4 w-4" />
                Preferences
              </Button>
            </div>
          )}

          <Button variant="ghost" onClick={() => setOpen(false)} className="tap h-11">
            Done
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState({ target }: { target?: ChatTarget }) {
  if (target?.mode === "edit") {
    return (
      <div className="m-auto max-w-md text-center text-sm text-muted-foreground">
        Describe the artifact you want to build. The assistant will respond with a
        complete <code className="text-foreground">html</code> document including a
        manifest. You&apos;ll be able to save it as a new version below.
      </div>
    );
  }
  if (target?.mode === "setup") {
    return (
      <div className="m-auto max-w-md text-center text-sm text-muted-foreground">
        Tell the assistant how to configure this instance, or ask it to fetch fresh
        data — it can call <code className="text-foreground">web_search</code> and{" "}
        <code className="text-foreground">web_fetch</code> when web search is on.
      </div>
    );
  }
  return (
    <div className="reader-serif m-auto max-w-md text-center text-muted-foreground italic">
      What&apos;s on your mind?
    </div>
  );
}

function RevertConfirmDialog({
  target,
  currentTemplateVersion,
  canRestoreFiles,
  pending,
  onCancel,
  onConfirm,
}: {
  target: StoredMessage | null;
  currentTemplateVersion?: number;
  canRestoreFiles: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (msg: StoredMessage) => void;
}) {
  const willRestoreFiles =
    !!target &&
    canRestoreFiles &&
    typeof target.templateVersion === "number" &&
    typeof currentTemplateVersion === "number" &&
    target.templateVersion < currentTemplateVersion;

  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o && !pending) onCancel(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Revert to this point?</DialogTitle>
          <DialogDescription>
            {willRestoreFiles
              ? `This deletes every message from this one on, and restores the designer files to v${target!.templateVersion}. Your app's data (state) is not touched.`
              : "This deletes every message from this one on. Designer files are unchanged."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => target && onConfirm(target)}
            disabled={pending || !target}
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Revert"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImagePreview({
  src,
  alt,
  triggerClassName,
  triggerTitle,
  children,
}: {
  src: string;
  alt?: string;
  triggerClassName?: string;
  triggerTitle?: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger className={triggerClassName} title={triggerTitle}>
        {children}
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="w-auto max-w-[95vw] sm:max-w-[95vw] max-h-[95dvh] bg-transparent ring-0 p-0 gap-0 overflow-visible"
      >
        <DialogTitle className="sr-only">{alt || triggerTitle || "Image preview"}</DialogTitle>
        <DialogClose
          aria-label="Close image preview"
          className="absolute top-2 right-2 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white shadow ring-1 ring-white/20 backdrop-blur-sm transition hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
        >
          <X className="h-4 w-4" />
        </DialogClose>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt ?? "image preview"}
          className="block max-h-[95dvh] max-w-[95vw] h-auto w-auto rounded-xl object-contain"
        />
      </DialogContent>
    </Dialog>
  );
}

// Longest-edge (px) of the small thumbnail we decode for the attachment grid.
// 2x the 80px display box so it stays crisp on retina without holding the full
// ~1024px source decoded.
const ATTACHMENT_THUMB_EDGE = 160;

// Global serialize-to-one queue for thumbnail generation. Each thumbnail decodes
// its full-size source once (a ~1024px phone photo → ~3MB decoded bitmap); a
// chat with many attachments would otherwise decode them all at once and blow
// past iOS WebKit's per-tab memory limit — the "This page couldn't load" crash.
// Chaining keeps at most one full decode alive at a time.
let attachmentThumbChain: Promise<void> = Promise.resolve();
function enqueueAttachmentThumb(task: () => Promise<void>): Promise<void> {
  const run = attachmentThumbChain.then(task, task);
  attachmentThumbChain = run.catch(() => {});
  return run;
}

/**
 * Lazy, memory-bounded thumbnail for a user's attached image. It waits until the
 * grid cell is near the viewport (IntersectionObserver), then — serialized
 * against every other thumbnail — decodes the full data URL once, draws it down
 * to a small JPEG blob, and swaps that in as the <img> source, releasing the
 * full-size decode. The full-resolution image is only ever decoded again inside
 * the tap-to-zoom modal (mounted on open). This keeps a 14-photo chat from
 * decoding 14 full bitmaps at once on open.
 */
function AttachmentThumb({ dataUrl, alt }: { dataUrl: string; alt: string }) {
  const [thumb, setThumb] = useState<string | null>(null);
  const holderRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    const holder = holderRef.current;
    if (!holder) return;

    const generate = () => {
      // Safe-render bisect (Preferences → Debug): skip decoding image bytes
      // entirely, so we can tell on-device whether images are what crashes the
      // tab. If the chat opens with this on, images are the cause.
      if (isSafeRender()) {
        dbg("img.decode.skipped(safe)", { name: alt });
        return Promise.resolve();
      }
      return enqueueAttachmentThumb(
        () =>
          new Promise<void>((resolve) => {
            if (cancelled) return resolve();
            dbg("img.decode.begin", {
              name: alt,
              kb: Math.round(dataUrl.length / 1024),
            });
            const img = new Image();
            img.decoding = "async";
            img.onload = () => {
              if (cancelled) return resolve();
              try {
                const longest = Math.max(img.naturalWidth, img.naturalHeight);
                const scale =
                  longest > ATTACHMENT_THUMB_EDGE
                    ? ATTACHMENT_THUMB_EDGE / longest
                    : 1;
                const w = Math.max(1, Math.round(img.naturalWidth * scale));
                const h = Math.max(1, Math.round(img.naturalHeight * scale));
                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                  if (!cancelled) setThumb(dataUrl);
                  return resolve();
                }
                ctx.drawImage(img, 0, 0, w, h);
                canvas.toBlob(
                  (blob) => {
                    if (cancelled) return resolve();
                    if (!blob) {
                      setThumb(dataUrl);
                      return resolve();
                    }
                    objectUrl = URL.createObjectURL(blob);
                    setThumb(objectUrl);
                    dbg("img.decode.end", { name: alt });
                    resolve();
                  },
                  "image/jpeg",
                  0.7
                );
              } catch {
                if (!cancelled) setThumb(dataUrl);
                resolve();
              }
            };
            img.onerror = () => {
              if (!cancelled) setThumb(dataUrl);
              resolve();
            };
            img.src = dataUrl;
          })
      );
    };

    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        void generate();
      },
      { rootMargin: "300px" }
    );
    io.observe(holder);

    return () => {
      cancelled = true;
      io.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [dataUrl]);

  return (
    <span ref={holderRef} className="block h-full w-full">
      {thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumb}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="flex h-full w-full items-center justify-center bg-muted"
        >
          <ImageIcon className="h-4 w-4 opacity-40" />
        </span>
      )}
    </span>
  );
}

// The image URL the user actually cares about. Chat images are frequently
// rewritten to flow through our own `/api/img?u=<upstream>` proxy (CDN
// hot-link blocks, null-origin artifact frames - see app/api/img/route.ts), so
// the raw <img src> is a wrapper, not something you can meaningfully open or
// share. Unwrap the `u=` target so the debug panel can hand back a link that
// goes straight to the source. A non-proxy URL is already its own core URL.
function coreImageUrl(src: string | undefined): string | undefined {
  if (!src) return undefined;
  if (src.startsWith("data:") || src.startsWith("blob:")) return src;
  const base =
    typeof window !== "undefined" ? window.location.href : "http://localhost";
  try {
    const u = new URL(src, base);
    if (u.pathname === "/api/img") {
      const inner = u.searchParams.get("u");
      if (inner) return inner;
    }
    return u.toString();
  } catch {
    return src;
  }
}

// True for a produced/attached file we can render as an inline <img>. Trusts the
// declared MIME first, then falls back to the extension for sandbox outputs the
// workspace typed as application/octet-stream.
function isImageFile(f: AttachedFile): boolean {
  if (typeof f.contentType === "string" && f.contentType.startsWith("image/"))
    return true;
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(f.name);
}

// The trailing filename of a URL or path - query/hash and percent-encoding
// stripped, lowercased for case-insensitive matching. "" when there's nothing
// usable. Used to line a markdown image's src up with a produced file's name.
function imageBasename(src: string): string {
  const path = src.split("#")[0].split("?")[0];
  const seg = path.split("/").pop() ?? "";
  try {
    return decodeURIComponent(seg).toLowerCase();
  } catch {
    return seg.toLowerCase();
  }
}

// When the model embeds an image whose URL points at a file the code just
// produced, that URL is almost always a guess - a placeholder host, or a
// relative path the app doesn't actually serve (it 200s with the SPA's HTML, so
// the <img> silently fails). The bytes only really live at the file's Blob URL,
// so rewrite the src to that real URL by matching the basename. Data/blob URLs
// and images that don't correspond to a produced file are left untouched.
function resolveProducedImageSrc(
  src: string | undefined,
  producedByName: Map<string, AttachedFile>
): string | undefined {
  if (!src || producedByName.size === 0) return src;
  if (src.startsWith("data:") || src.startsWith("blob:")) return src;
  const hit = producedByName.get(imageBasename(src));
  return hit ? hit.url : src;
}

// Renders a markdown image without letting a broken or still-loading source
// reflow the prose around it. The motivating bug: while a reply streams, an
// image URL arrives one character at a time, so the src points at a sequence
// of incomplete (404-ing) URLs before the real one lands. Painting the
// browser's native broken-image glyph for each of those — its intrinsic size
// differs from a real image — makes the whole conversation jump on every
// reparse. We instead keep the real <img> invisible until it actually decodes
// and hold a fixed-size placeholder box in its place, so the layout is stable
// from first paint through final load.
function MarkdownImage({
  src,
  alt,
  title,
  streaming,
  fit = "cover",
}: {
  src?: string;
  alt?: string;
  title?: string;
  /** The owning bubble is mid-stream. While true we never show the broken
   *  glyph (the URL may simply not have finished arriving yet) — just a calm
   *  spinner — so a half-typed link doesn't flicker. */
  streaming?: boolean;
  /** How the loaded image sits in its box. Prose images crop to a tidy tile
   *  ("cover"); produced-output previews use "contain" so the whole image the
   *  code generated is visible, not a cropped slice. */
  fit?: "cover" | "contain";
}) {
  const href = typeof src === "string" ? src : undefined;
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(
    href ? "loading" : "error"
  );
  // Intrinsic pixel size, captured on load - useful metadata in the debug panel.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  // Persist the bytes once they load so a flaky proxy/upstream can't break an
  // already-shown image. Disabled mid-stream: the URL is still arriving one
  // char at a time, so caching partial (404-ing) URLs would just be churn - we
  // wait until the bubble settles. `displaySrc` is the original URL until the
  // local copy is ready, then a stable blob URL.
  const { src: displaySrc, onError: onCacheError } = useCachedImage(href, !streaming);

  // Each time the src changes (i.e. another chunk of the URL streamed in) drop
  // back to "loading" so we stay in the stable placeholder instead of briefly
  // flashing the previous partial URL's broken state.
  useEffect(() => {
    setStatus(displaySrc ? "loading" : "error");
    setDims(null);
  }, [displaySrc]);

  const loaded = status === "loaded";

  // --- Triple-tap → image debug panel -------------------------------------
  // A phone user whose image won't load has no way to see what URL it was
  // pointing at or why it broke - the broken placeholder isn't even tappable.
  // Three quick taps anywhere on the image opens a metadata/diagnose sheet.
  const [debugOpen, setDebugOpen] = useState(false);
  const tapTimesRef = useRef<number[]>([]);
  const TAP_WINDOW_MS = 500;

  const handleTapCapture = useCallback((e: React.MouseEvent) => {
    const now = Date.now();
    const recent = tapTimesRef.current.filter((t) => now - t < TAP_WINDOW_MS);
    recent.push(now);
    tapTimesRef.current = recent;
    // On a loaded image the first tap opens the source in a new tab (unchanged).
    // Suppress the follow-up taps so a triple-tap doesn't spawn a stack of tabs;
    // the third one opens the debug sheet instead.
    if (recent.length >= 2) e.preventDefault();
    if (recent.length >= 3) {
      tapTimesRef.current = [];
      setDebugOpen(true);
    }
  }, []);

  const core = coreImageUrl(href);
  const proxied = !!href && !!core && core !== href;

  return (
    <span
      // Capture phase so we can veto the anchor's navigation before it fires.
      onClickCapture={handleTapCapture}
      className="relative my-1 mr-1 inline-block max-w-full align-top"
    >
      {/* Reserved box: fixed dimensions so a loading/broken image never shifts
          the text below it. Removed once the real image paints. */}
      {!loaded && (
        <span
          className={cn(
            "flex h-48 w-64 max-w-full flex-col items-center justify-center gap-1.5 rounded-md border border-border bg-muted text-muted-foreground",
            status === "error" && !streaming && "cursor-pointer"
          )}
        >
          {status === "error" && !streaming ? (
            <>
              <ImageIcon className="h-6 w-6 opacity-50" />
              <span className="px-2 text-center text-[11px] leading-tight opacity-70">
                Image didn&apos;t load
                <br />
                Triple-tap for details
              </span>
            </>
          ) : (
            <Loader2 className="h-5 w-5 animate-spin opacity-50" />
          )}
        </span>
      )}
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          title={title || alt || undefined}
          // While unloaded the anchor is pulled out of flow and made invisible
          // (but still in the DOM) so the <img> can decode and fire onLoad/
          // onError — including the native broken glyph, which stays hidden.
          className={cn(
            "block no-underline",
            !loaded && "pointer-events-none absolute inset-0 opacity-0"
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={displaySrc}
            alt={alt ?? ""}
            loading="lazy"
            onLoad={(e) => {
              setStatus("loaded");
              const t = e.currentTarget;
              if (t.naturalWidth) setDims({ w: t.naturalWidth, h: t.naturalHeight });
            }}
            onError={() => {
              // Try to recover from the IndexedDB copy before giving up; the
              // hook swaps `displaySrc` to a blob URL if it has the bytes.
              onCacheError();
              setStatus("error");
            }}
            className={cn(
              // max-w-full so a wide produced image can't overflow its bubble
              // and force horizontal scroll on a phone - the fallback previews
              // render outside `.prose`, which is what normally caps img width.
              "m-0 max-h-64 max-w-full rounded-md border border-border bg-muted",
              fit === "contain" ? "object-contain" : "object-cover"
            )}
          />
        </a>
      )}
      <ImageDebugDialog
        open={debugOpen}
        onOpenChange={setDebugOpen}
        status={status}
        alt={alt}
        title={title}
        href={href}
        core={core}
        proxied={proxied}
        dims={dims}
      />
    </span>
  );
}

// The metadata/diagnose sheet opened by triple-tapping a chat image. Surfaces
// the load state, the intrinsic size, and - the point of the whole thing - the
// unwrapped "core" URL as a link you can tap to open the source directly. When
// the image failed it live-fetches the URL and reports the actual HTTP status
// (our `/api/img` proxy returns human-readable bodies like "Upstream 404"), so
// "why won't it load" gets a concrete answer instead of a silent broken glyph.
function ImageDebugDialog({
  open,
  onOpenChange,
  status,
  alt,
  title,
  href,
  core,
  proxied,
  dims,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  status: "loading" | "loaded" | "error";
  alt?: string;
  title?: string;
  href?: string;
  core?: string;
  proxied: boolean;
  dims: { w: number; h: number } | null;
}) {
  type Diag =
    | { state: "idle" | "running" }
    | { state: "done"; status?: number; ok?: boolean; contentType?: string | null; detail?: string };
  const [diag, setDiag] = useState<Diag>({ state: "idle" });

  const runDiagnose = useCallback(async () => {
    if (!href) return;
    setDiag({ state: "running" });
    try {
      const res = await fetch(href, { cache: "no-store" });
      let detail: string | undefined;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        detail = text.trim().slice(0, 300) || undefined;
      }
      setDiag({
        state: "done",
        status: res.status,
        ok: res.ok,
        contentType: res.headers.get("content-type"),
        detail,
      });
    } catch (err) {
      // A cross-origin image the browser blocks from fetch() lands here - still
      // a useful signal ("blocked or offline"), just not an HTTP code.
      setDiag({
        state: "done",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, [href]);

  // Auto-run the diagnosis the first time the sheet opens on a broken image.
  useEffect(() => {
    if (open && status === "error" && diag.state === "idle") void runDiagnose();
  }, [open, status, diag.state, runDiagnose]);

  // Reset the diagnosis when the sheet closes so a later re-open re-tests fresh.
  useEffect(() => {
    if (!open) setDiag({ state: "idle" });
  }, [open]);

  const copyCore = useCallback(async () => {
    if (!core) return;
    try {
      await navigator.clipboard.writeText(core);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy link");
    }
  }, [core]);

  const statusLabel =
    status === "loaded" ? "Loaded" : status === "error" ? "Didn't load" : "Loading…";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent variant="sheet" className="gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ImageIcon className="h-4 w-4 opacity-70" />
            Image details
          </DialogTitle>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Status</dt>
          <dd
            className={cn(
              "font-medium",
              status === "error" && "text-destructive",
              status === "loaded" && "text-[var(--color-accent-2)]"
            )}
          >
            {statusLabel}
          </dd>
          {dims && (
            <>
              <dt className="text-muted-foreground">Size</dt>
              <dd>
                {dims.w} × {dims.h} px
              </dd>
            </>
          )}
          {alt && (
            <>
              <dt className="text-muted-foreground">Alt</dt>
              <dd className="break-words">{alt}</dd>
            </>
          )}
          {title && title !== alt && (
            <>
              <dt className="text-muted-foreground">Title</dt>
              <dd className="break-words">{title}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Source</dt>
          <dd className="break-words">
            {proxied ? "Loaded via image proxy" : "Direct link"}
          </dd>
        </dl>

        {/* The core URL - the thing you can tap to go straight to the image. */}
        {core && (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
            <span className="text-xs font-medium text-muted-foreground">
              Direct link
            </span>
            <a
              href={core}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono text-xs break-all text-primary underline underline-offset-2"
            >
              {core}
            </a>
            <div className="flex gap-2">
              <a
                href={core}
                target="_blank"
                rel="noreferrer noopener"
                className={cn(buttonVariants({ variant: "default", size: "sm" }))}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open
              </a>
              <Button size="sm" variant="outline" onClick={copyCore}>
                <Copy className="h-3.5 w-3.5" />
                Copy link
              </Button>
            </div>
          </div>
        )}

        {/* Why won't it load? Live status probe of the actual URL. */}
        {status === "error" && (
          <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                Diagnosis
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void runDiagnose()}
                disabled={diag.state === "running"}
              >
                <RotateCw
                  className={cn("h-3 w-3", diag.state === "running" && "animate-spin")}
                />
                Re-test
              </Button>
            </div>
            {diag.state === "running" && (
              <span className="text-xs text-muted-foreground">Checking the URL…</span>
            )}
            {diag.state === "idle" && (
              <span className="text-xs text-muted-foreground">
                Tap “Re-test” to check the URL.
              </span>
            )}
            {diag.state === "done" && (
              <div className="flex flex-col gap-1 text-xs">
                {typeof diag.status === "number" ? (
                  <span className={cn(diag.ok ? "text-muted-foreground" : "text-destructive")}>
                    HTTP {diag.status}
                    {diag.ok
                      ? " - the URL responds; the image may have been blocked from displaying."
                      : ""}
                  </span>
                ) : (
                  <span className="text-destructive">
                    Couldn&apos;t reach the image (blocked by the source or offline).
                  </span>
                )}
                {diag.contentType && (
                  <span className="text-muted-foreground">
                    Content-Type: {diag.contentType}
                  </span>
                )}
                {diag.detail && (
                  <span className="font-mono break-words text-muted-foreground">
                    {diag.detail}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// During a live stream the assistant bubble's text grows ~60×/sec (one RAF
// flush per frame, see the coalescing loop in runStream). Re-parsing the whole
// markdown document that often is what makes long replies — and especially
// ones with images or tables — flicker: a mid-token reparse can momentarily
// restructure the rendered tree (an unterminated `|` table row, a half-written
// image link), and React then remounts that subtree, so images re-decode and
// tables blink. Throttling the text we hand the parser to a few updates per
// second keeps the stream feeling live while collapsing that structural churn.
// The moment streaming ends (`active` flips false) we return the exact `value`
// verbatim, so the final content is never a frame behind.
function useThrottledStreamingText(value: string, active: boolean, ms = 120): string {
  const [throttled, setThrottled] = useState(value);
  // Always flush the latest text, even when several tokens land inside one
  // throttle window — the pending timer reads this ref, not a stale closure.
  const valueRef = useRef(value);
  valueRef.current = value;
  const lastRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setThrottled(valueRef.current);
      return;
    }
    // A flush is already scheduled; it will pick up valueRef.current when it
    // fires, so there's nothing to do for this token.
    if (timerRef.current !== null) return;
    const fire = () => {
      timerRef.current = null;
      lastRef.current = Date.now();
      setThrottled(valueRef.current);
    };
    const elapsed = Date.now() - lastRef.current;
    if (elapsed >= ms) fire();
    else timerRef.current = setTimeout(fire, ms - elapsed);
  }, [value, active, ms]);

  // Clear any pending flush on unmount.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  return active ? throttled : value;
}

// Recognize HTML that's worth offering to render as a live artifact.
// Conservative on purpose: fires on a declared html/svg fence or a full
// document/markup root, not on inline snippets or unrelated languages.
function MessageBubble({
  msg,
  target,
  saved,
  autoSaved,
  onSaveHtml,
  onConvertArtifact,
  onPromoteArtifact,
  onPinArtifact,
  onPinMessage,
  onSaveVfs,
  onDelete,
  onForceCompleteVfs,
  onRetry,
  onContinue,
  onRevertToHere,
  progress,
  stalled,
  stalledResumable,
  onContinueStalled,
  onStopPlan,
  stopping,
  onOpenDetails,
  onAnnotationsChange,
  chatId,
  flyWorker,
}: {
  msg: StoredMessage;
  target?: ChatTarget;
  saved?: boolean;
  autoSaved?: boolean;
  onSaveHtml?: (html: string, summary: string) => Promise<void> | void;
  onConvertArtifact?: (
    html: string,
    summary: string
  ) => Promise<{ designerId: string } | void> | { designerId: string } | void;
  /** Promote an HTML code block from the rendered prose into a live artifact,
   *  client-side, with no model round-trip. */
  onPromoteArtifact?: (html: string) => void;
  onPinArtifact?: (html: string, summary: string) => void;
  onPinMessage?: () => void;
  onSaveVfs?: (proposed: ProposedVfs) => Promise<boolean | void> | boolean | void;
  onDelete: () => void;
  onForceCompleteVfs?: () => void;
  onRetry?: () => void;
  onContinue?: () => void;
  onRevertToHere?: () => void;
  progress?: ProgressInfo;
  /** Parent's stall detector flipped this stream as silent for too long.
   *  Surfaces a manual Continue affordance without waiting for the worker
   *  to emit a graceful plan_paused or terminal error. */
  stalled?: boolean;
  /** True when continuing would resume from a paused/unfinished plan or
   *  committed prose; false when the stall is thinking-only and continuing
   *  just aborts the frozen connection into the standard error + Retry.
   *  Drives the callout copy so it doesn't promise a checkpoint resume that
   *  isn't going to happen. */
  stalledResumable?: boolean;
  /** Set when `stalled` is true AND we have a viable resume path. Click
   *  aborts the in-flight fetch and queues a continuePlan/continueGeneration
   *  to fire once pending settles. */
  onContinueStalled?: () => void;
  /** Stop the in-flight plan. POSTs to /api/chat/plan-pause so the
   *  orchestrator drains to the same paused state chain-exhaustion uses,
   *  and the existing Continue button resumes from where it left off. */
  onStopPlan?: () => void;
  /** Stop POST has been sent but the worker hasn't paused yet. Drives the
   *  "Stopping…" button label so double-clicks don't fire extra POSTs. */
  stopping?: boolean;
  onOpenDetails?: () => void;
  onAnnotationsChange?: (messageId: string, annotations: MessageAnnotation[]) => void;
  /** Owning chat id. Used by ChatArtifactInline to navigate to
   *  /chats/{chatId}/canvas?messageId=… when the user opens the full-screen
   *  canvas editor on this message's artifact. */
  chatId: string;
  /** Mirrors the Fly worker toggle. Bubble-level so the StalledStream
   *  callout copy can swap (60s vs 5min) without re-plumbing the prop
   *  through every sub-component. */
  flyWorker?: boolean;
}) {
  const isUser = msg.role === "user";
  const isAssistant = msg.role === "assistant";
  const artifact = isAssistant ? msg.proposedArtifact : undefined;
  const vfs = isAssistant ? msg.proposedVfs : undefined;
  // Mirrors the PlanProgressCard's `showContinueCta` predicate. When this
  // is true the card below renders its own "Continue plan" button driven
  // by the same `onContinue` handler — so the bubble's inline Continue +
  // Retry pair is a UI duplicate and gets hidden in the error block.
  const planCardOwnsResume =
    isAssistant &&
    !!msg.plan &&
    msg.plan.steps.length > 0 &&
    !!onContinue &&
    (!!msg.plan.pausedAt ||
      (!!msg.error && msg.plan.steps.some((s) => s.status !== "done")));
  // Chat-mode artifact-edit: the iterated artifact lives in proposedVfs but
  // visually we want to render it just like a fresh artifact. When the chat
  // has no target (free-form), pull the entry file out of the VFS and treat
  // it as a single-file HTML artifact for rendering.
  const vfsArtifactHtml =
    !artifact && vfs && !target && vfs.entry && typeof vfs.files?.[vfs.entry] === "string"
      ? (vfs.files[vfs.entry] as string)
      : null;
  const prose = msg.content;
  const showProgress = isAssistant && progress && !msg.error;
  const isStreaming = !!progress && !msg.error;

  // Stable ref so a non-streaming bubble's markdown memo (below) doesn't bust
  // every parent render just because `?? []` minted a new array.
  const annotations = useMemo(() => msg.annotations ?? [], [msg.annotations]);
  // While streaming, feed the markdown parser a throttled view of the growing
  // text so it re-parses a few times per second instead of every RAF frame —
  // this is what stops long replies (and image/table-heavy ones) from
  // flickering. Annotations are only ever added after a turn completes, so this
  // never collides with sentinel injection. (`prose` itself is still used
  // verbatim for the "has content yet?" guards below.)
  const renderProse = useThrottledStreamingText(prose, isStreaming);
  const proseWithSentinels = useMemo(
    () => (annotations.length ? injectSentinels(renderProse, annotations) : renderProse),
    [renderProse, annotations]
  );
  const annById = useMemo(() => {
    const m = new Map<string, MessageAnnotation>();
    for (const a of annotations) m.set(a.id, a);
    return m;
  }, [annotations]);

  // Images the code produced this turn, keyed by lowercased basename. The model
  // never sees these files' real URLs (the tool result only hands it the name),
  // so when it embeds one inline it guesses a URL that doesn't resolve. This map
  // lets the <img> renderer rewrite that guess to the real Blob URL by name.
  const producedImagesByName = useMemo(() => {
    const map = new Map<string, AttachedFile>();
    for (const f of msg.files ?? []) {
      if (f.produced && f.url && isImageFile(f)) map.set(imageBasename(f.name), f);
    }
    return map;
  }, [msg.files]);

  // Produced images the model never surfaced inline - its prose doesn't mention
  // the filename at all. We render these as previews below the reply so a
  // produced image is always visible, even when the model only offered it as a
  // download or forgot to show it. Images it DID reference (embedded or linked)
  // are left to render in place, so we don't show them twice.
  const unreferencedProducedImages = useMemo(() => {
    if (producedImagesByName.size === 0) return [] as AttachedFile[];
    const haystack = (msg.content ?? "").toLowerCase();
    const out: AttachedFile[] = [];
    for (const [name, file] of producedImagesByName) {
      if (!haystack.includes(name)) out.push(file);
    }
    return out;
  }, [producedImagesByName, msg.content]);

  // Captured in a ref so memoizing the rendered markdown (which closes over the
  // promote handler) doesn't depend on this per-render-recreated callback.
  const onPromoteArtifactRef = useRef(onPromoteArtifact);
  onPromoteArtifactRef.current = onPromoteArtifact;

  const proseRef = useRef<HTMLDivElement | null>(null);
  const router = useRouter();
  const [selection, setSelection] = useState<{
    selectedText: string;
    // Exact source slice for re-anchoring; set alongside the offsets below.
    sourceText?: string;
    // Offsets into the markdown source. Absent only when the selection can't
    // be aligned to the source at all. Pinning still works without them;
    // Research is disabled.
    startOffset?: number;
    endOffset?: number;
    occurrenceIndex?: number;
    rect: DOMRect;
    isTouch: boolean;
  } | null>(null);
  const [composing, setComposing] = useState<false | "research" | "pin">(false);
  const [draftPrompt, setDraftPrompt] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftSummary, setDraftSummary] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [pinFlash, setPinFlash] = useState<string | null>(null);
  const [openAnnId, setOpenAnnId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const speakingId = useSpeakingMessageId();
  const isSpeakingThis = speakingId === msg.id;
  const speechAvailable = isSpeechSupported();
  const onSpeakMessage = useCallback(() => {
    if (isSpeakingThis) {
      stopSpeaking();
    } else if (prose) {
      speakMessage(msg.id, prose);
    }
  }, [isSpeakingThis, msg.id, prose]);

  const [downloadingSpeech, setDownloadingSpeech] = useState(false);
  const onDownloadSpeech = useCallback(() => {
    if (!prose || downloadingSpeech) return;
    setDownloadingSpeech(true);
    void downloadSpeech(prose)
      .catch(() => {
        // TTS route / network failure — nothing to save. Fail quietly; the
        // spinner clears below and the user can retry.
      })
      .finally(() => setDownloadingSpeech(false));
  }, [prose, downloadingSpeech]);

  const copyMessage = useCallback(async () => {
    const text = prose;
    if (!text) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be blocked (permissions / non-HTTPS) — fail quietly.
    }
  }, [prose]);

  const closeMenu = useCallback(() => {
    setSelection(null);
    setComposing(false);
    setDraftPrompt("");
    setDraftTitle("");
    setDraftSummary("");
    setSelectionError(null);
  }, []);

  useEffect(() => {
    if (!selection) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selection, closeMenu]);

  const captureSelection = useCallback((isTouch: boolean) => {
    const root = proseRef.current;
    if (!root) return;
    if (typeof window === "undefined") return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const raw = sel.toString();
    if (!raw.trim()) return;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const anchor = selectionToAnchor(root, prose);
    if (anchor) {
      setSelection({ ...anchor, rect, isTouch });
    } else {
      // No verbatim match in the markdown source (e.g. selection spans inline
      // code). Research needs the anchor, but pinning only stores the rendered
      // text, so keep the selection alive in pin-only mode.
      setSelection({ selectedText: raw, rect, isTouch });
    }
    setSelectionError(null);
  }, [prose]);

  const onProseMouseUp = useCallback(() => {
    if (isStreaming) return;
    // Defer so window.getSelection reflects the final state.
    setTimeout(() => captureSelection(false), 0);
  }, [captureSelection, isStreaming]);

  // Touch: rely on native long-press selection + the OS firing a
  // selectionchange. We don't try to override the native flow.
  useEffect(() => {
    if (isStreaming) return;
    const onSelChange = () => {
      const sel = typeof window !== "undefined" ? window.getSelection() : null;
      if (!sel || sel.isCollapsed) return;
      const root = proseRef.current;
      if (!root) return;
      if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return;
      // Only react on touch devices to avoid double-handling mouse selection.
      if (!matchMedia("(pointer: coarse)").matches) return;
      captureSelection(true);
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, [captureSelection, isStreaming]);

  // On touch, the pill sits alongside the iOS native selection toolbar
  // instead of behind a fullscreen backdrop. Dismiss the pill the same way
  // the iOS toolbar dismisses itself: when the selection collapses, or when
  // the user scrolls.
  useEffect(() => {
    if (!selection?.isTouch || composing) return;
    const onSelChange = () => {
      const sel = typeof window !== "undefined" ? window.getSelection() : null;
      if (!sel || sel.isCollapsed) closeMenu();
    };
    const onScroll = () => closeMenu();
    document.addEventListener("selectionchange", onSelChange);
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener("selectionchange", onSelChange);
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [selection, composing, closeMenu]);

  const submitResearch = useCallback(async () => {
    if (!selection) return;
    if (
      selection.startOffset === undefined ||
      selection.endOffset === undefined ||
      selection.occurrenceIndex === undefined
    ) {
      return;
    }
    const prompt = draftPrompt.trim();
    if (!prompt) return;
    const annId = newId();
    const now = Date.now();
    const optimistic: MessageAnnotation = {
      id: annId,
      selectedText: selection.selectedText,
      sourceText: selection.sourceText,
      startOffset: selection.startOffset,
      endOffset: selection.endOffset,
      occurrenceIndex: selection.occurrenceIndex,
      prompt,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    setSubmitting(true);
    const nextAnnotations = [...annotations, optimistic];
    onAnnotationsChange?.(msg.id, nextAnnotations);
    await addAnnotation(msg.id, optimistic);
    closeMenu();
    // Clear the OS selection so the highlight is the only visible mark.
    if (typeof window !== "undefined") window.getSelection()?.removeAllRanges();

    let result: string | null = null;
    let errorMessage: string | null = null;
    try {
      const res = await fetch("/api/annotate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedText: selection.selectedText, prompt }),
      });
      const data = (await res.json()) as { result?: string; error?: string };
      if (!res.ok) {
        errorMessage = data.error || `Research failed (${res.status})`;
      } else {
        result = data.result ?? "";
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : "Network error";
    }

    if (result) {
      const childChatId = newId();
      const tStamp = Date.now();
      const quoted = `> ${selection.selectedText.replace(/\n/g, "\n> ")}\n\n${prompt}`;
      await putMessage({
        id: newId(),
        chatId: childChatId,
        role: "user",
        content: quoted,
        createdAt: tStamp,
      });
      await putMessage({
        id: newId(),
        chatId: childChatId,
        role: "assistant",
        content: result,
        createdAt: tStamp + 1,
        model: "gemma4:31b",
      });
      await putChat({
        id: childChatId,
        title: prompt.length > 60 ? prompt.slice(0, 60).trim() + "…" : prompt,
        titleSource: "default",
        createdAt: tStamp,
        updatedAt: tStamp,
        parentChatId: msg.chatId,
        parentMessageId: msg.id,
        parentAnnotationId: annId,
        parentSelection: { text: selection.selectedText },
      });
      const patched: MessageAnnotation = {
        ...optimistic,
        status: "done",
        result,
        childChatId,
        updatedAt: Date.now(),
      };
      await updateAnnotation(msg.id, annId, {
        status: "done",
        result,
        childChatId,
      });
      onAnnotationsChange?.(
        msg.id,
        nextAnnotations.map((a) => (a.id === annId ? patched : a))
      );
      setOpenAnnId(annId);
    } else {
      const patched: MessageAnnotation = {
        ...optimistic,
        status: "error",
        errorMessage: errorMessage ?? "Research failed",
        updatedAt: Date.now(),
      };
      await updateAnnotation(msg.id, annId, {
        status: "error",
        errorMessage: errorMessage ?? "Research failed",
      });
      onAnnotationsChange?.(
        msg.id,
        nextAnnotations.map((a) => (a.id === annId ? patched : a))
      );
    }
    setSubmitting(false);
  }, [annotations, closeMenu, draftPrompt, msg.chatId, msg.id, onAnnotationsChange, selection]);

  const submitPin = useCallback(async () => {
    if (!selection) return;
    const title = draftTitle.trim();
    const summary = draftSummary.trim();
    setSubmitting(true);
    try {
      let chatTitle: string | undefined;
      try {
        const chat = await getChat(msg.chatId);
        chatTitle = chat?.title;
      } catch {
        // Source chat lookup is best-effort — a missing title still produces a
        // valid pin, /notes just falls back to "Pinned note".
      }
      const note: StoredPinnedNote = {
        id: newId(),
        createdAt: Date.now(),
        title: title || undefined,
        summary: summary || undefined,
        chatId: msg.chatId,
        chatTitle,
        messageId: msg.id,
        messageMarkdown: selection.selectedText,
        linkToChat: true,
      };
      await putPinnedNote(note);
      closeMenu();
      if (typeof window !== "undefined") window.getSelection()?.removeAllRanges();
      setPinFlash("Pinned to notes");
      setTimeout(() => setPinFlash(null), 1800);
    } catch (err) {
      setSelectionError(err instanceof Error ? err.message : "Failed to pin note.");
      setTimeout(() => setSelectionError(null), 2400);
    } finally {
      setSubmitting(false);
    }
  }, [selection, draftTitle, draftSummary, msg.chatId, msg.id, closeMenu]);

  const openAnnotation = annById.get(openAnnId ?? "");

  // Memoize the markdown parse so a bubble that isn't the one currently
  // streaming doesn't re-parse its whole document on every parent render (the
  // streaming loop re-renders the list ~per frame). Depends only on what
  // actually changes the output; the promote handler is read via a ref.
  const proposedArtifactHtml = msg.proposedArtifact?.html;
  const renderedProse = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={annotations.length ? [rehypeHighlights] : []}
        components={{
          pre: ({ node, children, ...props }) => {
            const fenced = extractFencedCode(node);
            const canPromote =
              isAssistant &&
              !!onPromoteArtifactRef.current &&
              !!fenced &&
              looksLikeHtmlArtifact(fenced.lang, fenced.code) &&
              proposedArtifactHtml !== fenced.code;
            if (!canPromote) {
              return <CodeBlock node={node} {...props}>{children}</CodeBlock>;
            }
            return (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => onPromoteArtifactRef.current!(fenced!.code)}
                  className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-border bg-card/90 px-2 py-1 text-[11px] font-medium text-foreground shadow-sm backdrop-blur transition hover:bg-muted"
                  title="Render this HTML as a live artifact"
                >
                  <Sparkles className="h-3 w-3 text-primary/80" />
                  Open as artifact
                </button>
                <pre {...props}>{children}</pre>
              </div>
            );
          },
          img: ({ src, alt, title }) => (
            <MarkdownImage
              src={resolveProducedImageSrc(
                typeof src === "string" ? src : undefined,
                producedImagesByName
              )}
              alt={alt}
              title={title}
              streaming={isStreaming}
            />
          ),
          mark: ({ node, children }) => {
            const props = (node as { properties?: Record<string, unknown> } | undefined)
              ?.properties;
            const annId =
              typeof props?.dataAnnId === "string" ? (props.dataAnnId as string) : "";
            const ann = annById.get(annId);
            const status = ann?.status ?? "done";
            return (
              <mark
                data-ann-id={annId}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenAnnId(annId);
                }}
                className={cn(
                  "cursor-pointer rounded-sm px-0.5 text-foreground",
                  status === "pending" && "animate-pulse bg-yellow-200/70 dark:bg-yellow-500/30",
                  status === "done" && "bg-yellow-200/70 dark:bg-yellow-500/30",
                  status === "error" && "bg-red-200/70 dark:bg-red-500/30"
                )}
              >
                {children}
              </mark>
            );
          },
        }}
      >
        {proseWithSentinels}
      </ReactMarkdown>
    ),
    [proseWithSentinels, annotations.length, annById, isAssistant, proposedArtifactHtml, isStreaming, producedImagesByName]
  );

  return (
    <div className="group/msg flex w-full flex-col items-start gap-1.5">
      {isAssistant && msg.events && msg.events.length > 0 && (
        <LiveStatusPill
          // Compaction has its own dedicated notice below — keep it out of the
          // generic activity log so it isn't double-counted. The in-flight
          // "Compacting context…" pill still shows (driven by `live`, not the
          // event list).
          events={msg.events.filter((e) => e.name !== "compaction")}
          live={
            progress
              ? { phase: progress.phase, toolName: progress.toolName }
              : undefined
          }
          onOpenDetails={onOpenDetails}
        />
      )}

      {isAssistant && msg.events && msg.events.length > 0 && (
        <CompactionNotice events={msg.events} />
      )}

      {isAssistant && msg.plan && msg.plan.steps.length > 0 && (
        <PlanProgressCard
          plan={msg.plan}
          // Surface Continue both for graceful pause (msg.plan.pausedAt) and
          // for stalled-mid-plan: a chain-exhaust error fired but steps remain
          // un-done. In the second case pausedAt is unset (the worker was
          // hard-killed before it could emit plan_paused), so we rely on the
          // bubble's error + the step list to recognize the stalled shape.
          stalled={
            !msg.plan.pausedAt &&
            !!msg.error &&
            msg.plan.steps.some((s) => s.status !== "done")
          }
          // Stream ended cleanly (no progress, no error, no pause) but the
          // plan still has un-done steps. The orchestrator's verifier sweep
          // is the primary fix; this prop is the UI safety net for the rare
          // path where it can't close the gap. Without it the card strands
          // with a spinning step and a Stop CTA for work that's already
          // wrapped up.
          finished={
            !progress &&
            !msg.plan.pausedAt &&
            !msg.error &&
            msg.plan.steps.some((s) => s.status !== "done")
          }
          onContinue={
            onContinue &&
            (msg.plan.pausedAt ||
              (msg.error && msg.plan.steps.some((s) => s.status !== "done")))
              ? onContinue
              : undefined
          }
          disabled={!!progress}
          onStop={onStopPlan}
          stopping={stopping}
        />
      )}

      {isAssistant && stalled && onContinueStalled && (
        <StalledStreamCallout
          onContinue={onContinueStalled}
          flyWorker={flyWorker}
          resumable={stalledResumable}
        />
      )}

      {isAssistant && hasCouncilEvents(msg.events) && (
        <CouncilEvents events={msg.events ?? []} />
      )}

      {isAssistant && msg.thinking && (
        <ThoughtsPanel
          thinking={msg.thinking}
          live={!!progress && !msg.error}
        />
      )}

      {showProgress && !msg.content && !msg.thinking && (
        <ProgressBubble progress={progress!} />
      )}

      {isUser && msg.queued && !msg.error && (
        <span className="reader-label">
          Queued · waiting for the current reply
        </span>
      )}

      {(msg.content || msg.error || !showProgress) && (
        <div
          className={cn(
            // No bubble: messages flow as one labeled prose column, exactly
            // like therapist mode.
            "relative w-full",
            isUser && msg.queued && !msg.error && "opacity-70"
          )}
        >
          <div className="reader-label mb-1 select-none">
            {isUser ? "You" : "Assistant"}
          </div>
          {prose ||
          (isUser && msg.images && msg.images.length > 0) ||
          (isUser && msg.pdfs && msg.pdfs.length > 0) ||
          (isUser && msg.csvs && msg.csvs.length > 0) ||
          (msg.files && msg.files.length > 0) ||
          msg.error ? (
            <div className="flex flex-col gap-2">
              {isUser && msg.images && msg.images.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {msg.images.map((img) => (
                    <ImagePreview
                      key={img.id}
                      src={img.dataUrl}
                      alt={img.name ?? "attached image"}
                      triggerTitle={img.name}
                      triggerClassName="hairline tap block h-20 w-20 overflow-hidden rounded-md p-0 transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {/* Small, lazily-decoded thumbnail — the full-res source is
                          only decoded in the tap-to-zoom modal, so a chat with
                          many photos doesn't OOM the tab on open. */}
                      <AttachmentThumb
                        dataUrl={img.dataUrl}
                        alt={img.name ?? "attached image"}
                      />
                    </ImagePreview>
                  ))}
                </div>
              )}
              {isUser && msg.pdfs && msg.pdfs.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {msg.pdfs.map((pdf) => (
                    <div
                      key={pdf.id}
                      className="hairline flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs"
                      title={pdf.excerpt || pdf.name}
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0 text-primary" />
                      <span className="max-w-[180px] truncate">{pdf.name}</span>
                      <span className="text-muted-foreground">
                        {pdf.pageCount === 1 ? "1p" : `${pdf.pageCount}p`}
                        {pdf.truncated ? " · trimmed" : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {isUser && msg.csvs && msg.csvs.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {msg.csvs.map((csv) => (
                    <div
                      key={csv.id}
                      className="hairline flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs"
                      title={csv.excerpt || csv.name}
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                      <span className="max-w-[180px] truncate">{csv.name}</span>
                      <span className="text-muted-foreground">
                        {csv.rowCount === 1 ? "1 row" : `${csv.rowCount} rows`}
                        {" · "}
                        {csv.columnCount} col{csv.columnCount !== 1 ? "s" : ""}
                        {csv.truncated ? " · trimmed" : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {(() => {
                // Images we render as a full preview below carry their own
                // download link in the caption, so keep them out of this chip
                // row to avoid a duplicate download affordance for the same file.
                const previewIds = new Set(unreferencedProducedImages.map((f) => f.id));
                const chipFiles = (msg.files ?? []).filter((f) => !previewIds.has(f.id));
                return chipFiles.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {chipFiles.map((file) => (
                    <a
                      key={file.id}
                      href={file.url}
                      download={file.name}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hairline tap flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition hover:bg-muted"
                      title={
                        file.produced
                          ? `${file.name} — produced by code, click to download`
                          : file.name
                      }
                    >
                      {file.produced ? (
                        <Download className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent-2)]" />
                      ) : (
                        <Code2 className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent-2)]" />
                      )}
                      <span className="max-w-[180px] truncate">{file.name}</span>
                      <span className="text-muted-foreground">
                        {formatFileBytes(file.bytes)}
                      </span>
                    </a>
                  ))}
                </div>
                ) : null;
              })()}
              {prose && (
                <div
                  ref={proseRef}
                  onMouseUp={isAssistant ? onProseMouseUp : undefined}
                  data-size="md"
                  className={cn(
                    "note-reader prose max-w-none break-words",
                    isUser && "opacity-80"
                  )}
                  style={selection ? { WebkitTouchCallout: "none" } : undefined}
                >
                  {renderedProse}
                </div>
              )}
              {/* Produced images the reply never showed inline - render them here
                  so an image the code generated is always viewable, not just a
                  download chip the user has to tap and leave the chat to see. */}
              {unreferencedProducedImages.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {unreferencedProducedImages.map((file) => (
                    <figure key={file.id} className="m-0 flex flex-col gap-1">
                      <MarkdownImage
                        src={file.url}
                        alt={file.name}
                        title={file.name}
                        fit="contain"
                      />
                      <figcaption>
                        <a
                          href={file.url}
                          download={file.name}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="tap inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                          title={`${file.name} - produced by code, click to download`}
                        >
                          <Download className="h-3 w-3 shrink-0 text-[var(--color-accent-2)]" />
                          <span className="max-w-[220px] truncate">{file.name}</span>
                          <span>{formatFileBytes(file.bytes)}</span>
                        </a>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
              {msg.error && (
                <>
                  <span
                    className="text-destructive"
                    title={msg.error}
                  >
                    {friendlyError(msg.error)}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    {/* When the PlanProgressCard above us is already
                        rendering its own "Continue plan" CTA we suppress the
                        bubble-level Continue + Retry pair: they trigger the
                        same continuePlan dispatch as the card, so stacking
                        them just dumps three near-identical buttons on a
                        broken bubble (Continue plan / Continue / Retry).
                        The plan card is the canonical resume surface for
                        plan-errored messages; keep the inline pair around
                        only for non-plan errors. */}
                    {onContinue && !planCardOwnsResume && (
                      <button
                        type="button"
                        onClick={onContinue}
                        className="hairline inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-xs text-foreground transition hover:text-primary"
                      >
                        <ArrowRight className="h-3 w-3" />
                        Continue
                      </button>
                    )}
                    {onRetry && !planCardOwnsResume && (
                      <button
                        type="button"
                        onClick={onRetry}
                        className="hairline inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-xs text-foreground transition hover:text-primary"
                      >
                        <RotateCw className="h-3 w-3" />
                        Retry
                      </button>
                    )}
                  </div>
                </>
              )}
              {/* Cut-off reply: the model hit its output-token ceiling and
                  stopped mid-thought (usage.truncated). Surface a prominent
                  Continue button so the user can extend the SAME bubble in
                  place — distinct from the error-block Continue above, which
                  only renders for failed turns. */}
              {isAssistant &&
                !msg.error &&
                msg.usage?.truncated &&
                onContinue && (
                  <button
                    type="button"
                    onClick={onContinue}
                    className="hairline mt-1 inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-xs text-foreground transition hover:text-primary"
                  >
                    <ArrowRight className="h-3 w-3" />
                    Continue
                  </button>
                )}
            </div>
          ) : (
            <span className="text-muted-foreground">…</span>
          )}

          <div className="mt-1 flex items-center gap-1 sm:opacity-0 sm:transition-opacity sm:group-hover/msg:opacity-100 sm:has-data-popup-open:opacity-100">
            <CardActions
              tooltipSide="bottom"
              primaryCount={0}
              actions={[
                {
                  key: "copy",
                  label: copied ? "Copied" : "Copy message",
                  icon: copied ? (
                    <Check className="h-3 w-3 text-emerald-600" />
                  ) : (
                    Copy
                  ),
                  onSelect: copyMessage,
                  hidden: !prose,
                  active: copied,
                },
                {
                  key: "speak",
                  label: isSpeakingThis ? "Stop speaking" : "Speak message",
                  ariaLabel: isSpeakingThis
                    ? "Stop speaking this message"
                    : "Read this message aloud",
                  icon: isSpeakingThis ? VolumeX : Volume2,
                  onSelect: onSpeakMessage,
                  hidden: !prose || !speechAvailable,
                  active: isSpeakingThis,
                },
                {
                  key: "download-speech",
                  label: downloadingSpeech
                    ? "Preparing audio…"
                    : "Download speech",
                  ariaLabel: "Download this message as spoken audio",
                  icon: downloadingSpeech ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    Download
                  ),
                  onSelect: onDownloadSpeech,
                  hidden: !prose || !speechAvailable,
                  disabled: downloadingSpeech,
                },
                {
                  key: "continue",
                  label: "Continue message",
                  ariaLabel: "Continue this reply where it left off",
                  icon: ArrowRight,
                  onSelect: onContinue,
                  // Manual fallback for any finished reply the user judges
                  // incomplete. Hidden on errored turns (their own inline
                  // Continue/Retry pair covers that) and whenever onContinue
                  // isn't wired (e.g. mid-stream, plan/council/artifact turns).
                  hidden: !isAssistant || !!msg.error || !onContinue,
                },
                {
                  key: "pin",
                  label: "Pin to notes",
                  ariaLabel: "Pin message to notes",
                  icon: Pin,
                  onSelect: onPinMessage,
                  hidden: !onPinMessage,
                },
                {
                  key: "revert",
                  label: "Revert chat (and code) to here",
                  ariaLabel: "Revert chat to this point",
                  icon: Undo2,
                  onSelect: onRevertToHere,
                  hidden: !onRevertToHere,
                },
                {
                  key: "delete",
                  label: "Delete message",
                  icon: Trash2,
                  onSelect: onDelete,
                  destructive: true,
                },
              ]}
            />
          </div>
        </div>
      )}

      {artifact && !(target?.kind === "chat-artifact-canvas" && vfs) && (
        artifact.streaming ? (
          <ArtifactStreamingPanel html={artifact.html} />
        ) : onSaveHtml ? (
          <ArtifactCard
            html={artifact.html}
            summary={artifact.summary || prose}
            saved={saved}
            onSave={() => onSaveHtml(artifact.html, artifact.summary || prose)}
          />
        ) : (
          // Free-form chat (no designer target): live-render the assistant's
          // visual artifact inline and offer to convert it into a designer.
          <ChatArtifactInline
            html={artifact.html}
            summary={artifact.summary || prose}
            convertedDesignerId={msg.convertedDesignerId}
            onConvert={
              onConvertArtifact
                ? () => onConvertArtifact(artifact.html, artifact.summary || prose)
                : undefined
            }
            onPin={
              onPinArtifact
                ? () => onPinArtifact(artifact.html, artifact.summary || prose)
                : undefined
            }
            chatId={chatId}
            messageId={msg.id}
            canOpenCanvas={target === undefined}
          />
        )
      )}

      {vfsArtifactHtml !== null && vfs && !msg.editsArtifactMessageId && (
        // Free-form chat, canvas iteration: the iterated artifact lives in
        // `proposedVfs.files[entry]`. Render it as a regular inline artifact —
        // the iframe updates live as `file_changed` events arrive during the
        // edit stream. Action buttons are wired through whether or not the
        // stream has finished; ChatArtifactInline itself doesn't block on
        // streaming state, which keeps the live preview responsive.
        //
        // Skip when this message is a `chat-artifact-canvas` edit response
        // (`editsArtifactMessageId` set). Its VFS body has been applied
        // back to the source artifact message, which is where the user
        // expects to see the updated artifact — rendering it again here
        // would surface as a phantom "new artifact" in the chat history.
        <ChatArtifactInline
          html={vfsArtifactHtml}
          summary={vfs.summary || prose}
          convertedDesignerId={msg.convertedDesignerId}
          onConvert={
            onConvertArtifact && !vfs.streaming
              ? () => onConvertArtifact(vfsArtifactHtml, vfs.summary || prose)
              : undefined
          }
          onPin={
            onPinArtifact && !vfs.streaming
              ? () => onPinArtifact(vfsArtifactHtml, vfs.summary || prose)
              : undefined
          }
          chatId={chatId}
          messageId={msg.id}
          canOpenCanvas={target === undefined && !vfs.streaming}
        />
      )}

      {vfs && vfsArtifactHtml === null && !(msg.editsArtifactMessageId && !target) && (
        // Same canvas-edit-response suppression as the inline branch above:
        // on /chats/[id] (no target), `vfsArtifactHtml` is forced null by
        // the editsArtifactMessageId guard, so without this we'd fall into
        // the VfsCard branch and surface an orphan "edited index.html" card
        // for a save that already landed on the source artifact message.
        // The canvas page (target set) still renders the card normally
        // so the user can see what changed inside the editor.
        <VfsCard
          proposed={vfs}
          fallbackSummary={prose}
          saved={saved}
          autoSaved={autoSaved}
          noBuildRequired={
            target?.kind === "note-canvas" ||
            target?.kind === "chat-artifact-canvas"
          }
          onSave={onSaveVfs ? () => onSaveVfs(vfs) : undefined}
          onForceComplete={onForceCompleteVfs}
        />
      )}

      {isAssistant && msg.usage && (
        <div className="flex items-center gap-2 px-2 text-[10px] text-muted-foreground">
          {msg.model && (
            <span className="font-mono rounded border border-border bg-card px-1.5 py-px">
              {msg.model}
            </span>
          )}
          <span className="font-mono tabular-nums">
            {msg.usage.promptTokens} in · {msg.usage.completionTokens} out
            {msg.usage.totalMs > 0 && (<> · {msg.usage.tokensPerSec} tok/s · {(msg.usage.totalMs / 1000).toFixed(2)}s</>)}
          </span>
        </div>
      )}

      {selection && typeof document !== "undefined" &&
        createPortal(
          selection.isTouch && !composing ? (
            // Touch pill: no backdrop, so the iOS native selection toolbar
            // and its share extensions stay tappable. Dismissal piggybacks
            // on the OS — when the selection collapses or the user scrolls,
            // the effect above closes us.
            <div
              role="dialog"
              aria-label="Act on selected text"
              className="fixed z-50 flex select-none items-center rounded-full border border-border bg-card shadow-lg"
              style={{
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",
                top: Math.min(
                  selection.rect.bottom + 12,
                  window.innerHeight - 56
                ),
                left: Math.max(
                  8,
                  Math.min(
                    selection.rect.left +
                      selection.rect.width / 2 -
                      130,
                    window.innerWidth - 268
                  )
                ),
              }}
            >
              {selection.startOffset !== undefined && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setComposing("research");
                      if (typeof window !== "undefined") {
                        window.getSelection()?.removeAllRanges();
                      }
                      setTimeout(() => {
                        const ta = document.getElementById(
                          `ann-prompt-${msg.id}`
                        ) as HTMLTextAreaElement | null;
                        ta?.focus();
                      }, 0);
                    }}
                    className="flex items-center gap-1.5 rounded-l-full px-3 py-1.5 text-sm"
                  >
                    <Search className="h-4 w-4 text-muted-foreground" />
                    <span>Research</span>
                  </button>
                  <div className="h-5 w-px bg-border" aria-hidden="true" />
                </>
              )}
              <button
                type="button"
                onClick={() => {
                  setComposing("pin");
                  if (typeof window !== "undefined") {
                    window.getSelection()?.removeAllRanges();
                  }
                  setTimeout(() => {
                    const el = document.getElementById(
                      `pin-title-${msg.id}`
                    ) as HTMLInputElement | null;
                    el?.focus();
                  }, 0);
                }}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-sm",
                  selection.startOffset !== undefined
                    ? "rounded-r-full"
                    : "rounded-full"
                )}
              >
                <Pin className="h-4 w-4 text-muted-foreground" />
                <span>Pin note</span>
              </button>
            </div>
          ) : (
            <div
              className="fixed inset-0 z-50"
              onMouseDown={closeMenu}
              onTouchStart={closeMenu}
            >
              <div
                role="dialog"
                aria-label="Research selected text"
                className="fixed z-50 w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-card p-2 shadow-lg"
                style={{
                  top: Math.min(selection.rect.bottom + 8, window.innerHeight - 220),
                  left: Math.max(
                    8,
                    Math.min(
                      selection.rect.left,
                      window.innerWidth - 288 - 8
                    )
                  ),
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
              >
                {!composing ? (
                  <div className="flex flex-col">
                    {selection.startOffset !== undefined && (
                      <button
                        type="button"
                        onClick={() => {
                          setComposing("research");
                          setTimeout(() => {
                            const ta = document.getElementById(
                              `ann-prompt-${msg.id}`
                            ) as HTMLTextAreaElement | null;
                            ta?.focus();
                          }, 0);
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        <Search className="h-4 w-4 text-muted-foreground" />
                        <span>Research this…</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setComposing("pin");
                        setTimeout(() => {
                          const el = document.getElementById(
                            `pin-title-${msg.id}`
                          ) as HTMLInputElement | null;
                          el?.focus();
                        }, 0);
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      <Pin className="h-4 w-4 text-muted-foreground" />
                      <span>Pin as note</span>
                    </button>
                  </div>
                ) : composing === "research" ? (
                  <div className="flex flex-col gap-2">
                    <div className="line-clamp-2 rounded-sm bg-yellow-200/70 px-1.5 py-0.5 text-xs text-foreground">
                      {selection.selectedText}
                    </div>
                    <textarea
                      id={`ann-prompt-${msg.id}`}
                      value={draftPrompt}
                      onChange={(e) => setDraftPrompt(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void submitResearch();
                        } else if (e.key === "Escape") {
                          closeMenu();
                        }
                      }}
                      placeholder="What about this? (⌘↵ to send)"
                      rows={3}
                      className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-foreground/30"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={closeMenu}
                        className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        Cancel
                      </button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={!draftPrompt.trim() || submitting}
                        onClick={() => void submitResearch()}
                      >
                        {submitting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <>
                            <Send className="h-3.5 w-3.5" />
                            <span className="ml-1">Send</span>
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="line-clamp-3 rounded-sm bg-yellow-200/70 px-1.5 py-0.5 text-xs text-foreground">
                      {selection.selectedText}
                    </div>
                    <input
                      id={`pin-title-${msg.id}`}
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void submitPin();
                        } else if (e.key === "Escape") {
                          closeMenu();
                        }
                      }}
                      placeholder="Title (optional)"
                      className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-foreground/30"
                    />
                    <textarea
                      value={draftSummary}
                      onChange={(e) => setDraftSummary(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void submitPin();
                        } else if (e.key === "Escape") {
                          closeMenu();
                        }
                      }}
                      placeholder="Description (optional)"
                      rows={2}
                      className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-foreground/30"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={closeMenu}
                        className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        Cancel
                      </button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={submitting}
                        onClick={() => void submitPin()}
                      >
                        {submitting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <>
                            <Pin className="h-3.5 w-3.5" />
                            <span className="ml-1">Pin</span>
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ),
          document.body
        )}

      {selectionError && typeof document !== "undefined" &&
        createPortal(
          <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground shadow-lg">
            {selectionError}
          </div>,
          document.body
        )}

      {pinFlash && typeof document !== "undefined" &&
        createPortal(
          <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground shadow-lg">
            <Check className="h-3.5 w-3.5 text-primary" />
            {pinFlash}
          </div>,
          document.body
        )}

      <Dialog
        open={!!openAnnId}
        onOpenChange={(o) => {
          if (!o) setOpenAnnId(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Research</DialogTitle>
            {openAnnotation && (
              <DialogDescription>
                <span className="mt-1 inline-block rounded-sm bg-yellow-200/70 px-1.5 py-0.5 text-foreground">
                  {openAnnotation.selectedText}
                </span>
                <span className="mt-2 block text-xs text-muted-foreground">
                  Q: {openAnnotation.prompt}
                </span>
              </DialogDescription>
            )}
          </DialogHeader>
          <div className="max-h-[50vh] overflow-y-auto">
            {openAnnotation?.status === "pending" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Researching…
              </div>
            )}
            {openAnnotation?.status === "error" && (
              <div className="text-sm text-destructive">
                {openAnnotation.errorMessage || "Research failed."}
              </div>
            )}
            {openAnnotation?.status === "done" && openAnnotation.result && (
              <div className="prose prose-sm max-w-none break-words">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>
                  {openAnnotation.result}
                </ReactMarkdown>
              </div>
            )}
          </div>
          <DialogFooter>
            {openAnnotation?.childChatId && (
              <Button
                type="button"
                onClick={() => {
                  const id = openAnnotation.childChatId!;
                  setOpenAnnId(null);
                  router.push(`/chats/${id}`);
                }}
              >
                Open as chat
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function useTicker(active: boolean) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const i = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(i);
  }, [active]);
  return tick;
}

/**
 * Sticky indeterminate progress strip pinned to the top of the messages
 * scroller. Visible whenever a send/resume is in flight so the user has a
 * clear "still working" cue even when the model has gone quiet between
 * thinking deltas — without it the only signal is the (often-collapsed)
 * Thoughts panel and the Stop button, which is easy to miss on mobile.
 */
function StreamingBar({ phase }: { phase?: ProgressInfo["phase"] }) {
  const label =
    phase === "sending"
      ? "Sending…"
      : phase === "tool"
        ? "Calling tool…"
        : phase === "streaming"
          ? "Generating…"
          : "Thinking…";
  return (
    <div className="pointer-events-none sticky top-0 z-10 -mt-6 mb-1 flex flex-col">
      <div className="flex items-center gap-2 bg-background/90 pt-2 pb-1 text-[11px] text-muted-foreground backdrop-blur">
        <Loader2 className="h-3 w-3 animate-spin text-primary" />
        <span>{label}</span>
      </div>
      <div className="relative h-px overflow-hidden bg-border">
        <span
          className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary"
          style={{ animation: "streaming-bar 1.4s ease-in-out infinite" }}
        />
      </div>
    </div>
  );
}

function ProgressBubble({ progress }: { progress: ProgressInfo }) {
  useTicker(true);
  const elapsed = (Date.now() - progress.startedAt) / 1000;
  const label =
    progress.phase === "sending"
      ? "Sending request"
      : progress.phase === "thinking"
        ? "Thinking"
        : progress.phase === "tool"
          ? `Calling ${progress.toolName ?? "tool"}`
          : "Generating";
  return (
    <div className="reader-serif inline-flex items-center gap-2 text-muted-foreground italic">
      <span className="animate-pulse">{label}…</span>
      <span className="font-mono text-[10px] not-italic tabular-nums text-muted-foreground/70">
        {elapsed.toFixed(1)}s
      </span>
    </div>
  );
}

function ThoughtsPanel({ thinking, live }: { thinking: string; live: boolean }) {
  const [open, setOpen] = useState<boolean>(live);
  const elapsed = useTicker(live);
  // Auto-expand when live; collapse when streaming finishes.
  useEffect(() => {
    setOpen(live);
  }, [live]);
  // Auto-scroll the thinking panel to bottom while streaming.
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!live || !ref.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [thinking, live, elapsed]);

  const lineCount = thinking.split("\n").filter((l) => l.trim()).length;

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group/th tap flex w-full items-center gap-2 py-1 text-left text-xs",
          "text-muted-foreground transition hover:text-foreground"
        )}
      >
        {live ? (
          <Loader2 className="h-3 w-3 animate-spin text-primary" />
        ) : (
          <Sparkles className="h-3 w-3 text-primary/80" />
        )}
        <span className="text-muted-foreground">
          {live ? "Thinking" : "Thoughts"}
          {live && <span className="ml-1 font-mono text-muted-foreground/70">· {lineCount} lines</span>}
        </span>
        <ChevronDown
          className={cn("ml-auto h-3 w-3 text-muted-foreground transition", open && "rotate-180")}
        />
      </button>
      {open && (
        <div
          ref={ref}
          className="mt-1 min-w-0 border-l-2 border-border pl-3 font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-line sm:max-h-56 sm:overflow-y-auto sm:text-[11px]"
        >
          {thinking}
        </div>
      )}
    </div>
  );
}

/**
 * Surfaces a manual Continue affordance when an in-flight stream has gone
 * silent past the parent's stall threshold. Mirrors the amber paused-here
 * treatment used in PlanProgressCard so the visual language stays consistent
 * — "yellow = the worker is somewhere it shouldn't still be."
 */
function StalledStreamCallout({
  onContinue,
  flyWorker,
  resumable = true,
}: {
  onContinue: () => void;
  flyWorker?: boolean;
  /** Whether continuing resumes from a checkpoint (plan/prose) or just aborts
   *  a thinking-only stall into the standard Retry. */
  resumable?: boolean;
}) {
  const silence = flyWorker
    ? "No update from the Fly worker in 5 minutes."
    : "No update from the model in over a minute.";
  const action = resumable
    ? flyWorker
      ? "Continue to stop the worker and resume from the last cached checkpoint."
      : "Continue to abort the current connection and resume from the last cached checkpoint."
    : "Continue to abort the stuck connection — there's no committed output yet, so you'll be able to retry the message.";
  return (
    <div className="w-full rounded-lg border border-amber-500/40 px-3 py-2 sm:px-3.5 sm:py-2.5">
      <div className="flex items-start gap-2">
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-foreground">
            Stream looks stuck
          </span>
          <span className="text-[11px] text-muted-foreground">
            {`${silence} ${action}`}
          </span>
        </div>
        <button
          type="button"
          onClick={onContinue}
          className="tap inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowRight className="h-3 w-3" />
          Continue
        </button>
      </div>
    </div>
  );
}

function ArtifactStreamingPanel({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [html]);
  const lines = html.split("\n").length;
  const chars = html.length;
  return (
    <div className="hairline w-full min-w-0 overflow-hidden rounded-lg">
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-1.5">
        <Loader2 className="h-3 w-3 animate-spin text-primary" />
        <span className="reader-label">Writing artifact</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          · {lines} lines · {chars.toLocaleString()} chars
        </span>
      </div>
      <div
        ref={ref}
        className="max-h-64 min-w-0 overflow-auto p-2.5 font-mono text-[11px] leading-relaxed text-foreground/80 whitespace-pre sm:max-h-72 sm:p-3 sm:text-[10.5px]"
      >
        {html || <span className="text-muted-foreground">…</span>}
      </div>
    </div>
  );
}

function ArtifactCard({
  html,
  summary,
  saved,
  onSave,
}: {
  html: string;
  summary: string;
  saved?: boolean;
  onSave: () => void;
}) {
  const lines = html.split("\n").length;
  const chars = html.length;
  return (
    <div className="hairline w-full rounded-lg p-2.5 sm:p-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="reader-label">Artifact ready</div>
          <div className="truncate text-xs text-muted-foreground">
            {summary.slice(0, 120)}
          </div>
          <div className="mt-1 font-mono text-[10px] text-muted-foreground">
            {lines} lines · {chars.toLocaleString()} chars
          </div>
        </div>
        <Button
          size="sm"
          onClick={onSave}
          disabled={saved}
          className={cn("ml-auto", saved && "gap-1 bg-emerald-600 text-white hover:bg-emerald-600")}
        >
          {saved ? (
            <>
              <Check className="h-3.5 w-3.5" />
              Saved
            </>
          ) : (
            "Save version"
          )}
        </Button>
      </div>
    </div>
  );
}

/**
 * Live preview of a chat-mode HTML artifact: drops the html into a sandboxed
 * iframe so the user sees the rendered result inline in the message stream,
 * with a "Convert to App" action that promotes the artifact into a real
 * designer + paired app. The iframe never gets `allow-same-origin`, so the
 * artifact cannot read parent storage. Once converted, the action collapses
 * into a "Saved as designer · open" link.
 */
function ChatArtifactInline({
  html,
  summary,
  convertedDesignerId,
  onConvert,
  onPin,
  chatId,
  messageId,
  canOpenCanvas,
}: {
  html: string;
  summary: string;
  convertedDesignerId?: string;
  onConvert?: () => Promise<{ designerId: string } | void> | { designerId: string } | void;
  onPin?: () => void;
  /** Owning chat id — used to navigate to /chats/{chatId}/canvas. */
  chatId: string;
  /** Source message id whose artifact this card renders. */
  messageId: string;
  /** Free-form chat only: show the "Edit in canvas" button. */
  canOpenCanvas?: boolean;
}) {
  const router = useRouter();
  const openCanvas = canOpenCanvas
    ? () =>
        router.push(
          `/chats/${encodeURIComponent(chatId)}/canvas?messageId=${encodeURIComponent(messageId)}`
        )
    : undefined;
  const lines = html.split("\n").length;
  const chars = html.length;
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [savingImage, setSavingImage] = useState(false);
  const srcDoc = html;

  useEffect(() => {
    setMounted(true);
  }, []);

  // Export the whole artifact (top to bottom, not just the visible viewport)
  // as a single PNG. Renders the raw HTML into an offscreen capture frame so
  // long artifacts can be saved without manual scrolling + stitching.
  const handleSaveImage = useCallback(async () => {
    if (savingImage) return;
    setSavingImage(true);
    try {
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const filename =
        titleMatch?.[1]?.trim() ||
        summary.split("\n")[0]?.slice(0, 60).trim() ||
        "artifact";
      await exportArtifactImage(html, { filename });
    } catch (err) {
      console.error("Artifact image export failed", err);
      if (typeof window !== "undefined") {
        toast.error(
          err instanceof Error
            ? `Couldn't save image: ${err.message}`
            : "Couldn't save image."
        );
      }
    } finally {
      setSavingImage(false);
    }
  }, [html, summary, savingImage]);

  const handleConvert = useCallback(async () => {
    if (!onConvert || busy) return;
    setBusy(true);
    try {
      await Promise.resolve(onConvert());
    } finally {
      setBusy(false);
    }
  }, [onConvert, busy]);

  useEffect(() => {
    if (!expanded) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [expanded]);

  // Give the iframe a real viewport (fills the flex container) so artifacts
  // that use 100vh / min-h-screen layouts render correctly. The iframe then
  // owns its own scrolling — modern iOS Safari scrolls iframes fine; sizing
  // the iframe to its scrollHeight breaks any viewport-anchored layout
  // because 100vh inside == iframe height, creating a feedback loop.
  const overlay = expanded && mounted ? (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-card"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Artifact fullscreen preview"
    >
      <div className="flex items-center gap-2 border-b border-border bg-card/95 px-3 py-2 text-[11px] text-muted-foreground backdrop-blur">
        <span className="reader-label">Artifact</span>
        <span className="font-mono tabular-nums hidden sm:inline">
          · {lines} lines · {chars.toLocaleString()} chars
        </span>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition hover:text-foreground"
          aria-label="Close fullscreen preview"
          title="Close (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <iframe
        title="Artifact preview"
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups"
        className="block min-h-0 w-full flex-1 border-0 bg-white"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      />
    </div>
  ) : null;

  return (
    <>
      <div className="hairline w-full overflow-hidden rounded-lg">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="block w-full text-left"
          aria-label="Open fullscreen preview"
          title="Tap to open fullscreen"
        >
          <iframe
            title="Artifact preview"
            srcDoc={srcDoc}
            sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups"
            className="pointer-events-none block h-[min(60svh,560px)] min-h-[360px] w-full border-0 bg-white"
          />
        </button>
        <div className="flex flex-wrap items-center gap-2 border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
          <span className="reader-label">Artifact</span>
          <span className="font-mono tabular-nums">
            · {lines} lines · {chars.toLocaleString()} chars
          </span>
          {openCanvas && (
            <Button
              size="sm"
              variant="outline"
              onClick={openCanvas}
              className="ml-auto gap-1.5"
              title="Iterate in place via diff-edit tools"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit in canvas
            </Button>
          )}
          {convertedDesignerId ? (
            <a
              href={`/designer/${convertedDesignerId}`}
              className={cn(
                "hairline inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium text-[var(--color-accent-2)] transition hover:text-foreground",
                openCanvas ? "" : "ml-auto"
              )}
            >
              <Check className="h-3 w-3" />
              Saved as designer
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : onConvert ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleConvert()}
              disabled={busy}
              className={cn("gap-1.5", openCanvas ? "" : "ml-auto")}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wand2 className="h-3.5 w-3.5" />
              )}
              Convert to App
            </Button>
          ) : null}
          <CardActions
            className={convertedDesignerId || onConvert || openCanvas ? "" : "ml-auto"}
            primaryCount={0}
            actions={[
              {
                key: "open",
                label: "Open fullscreen preview",
                icon: Maximize2,
                onSelect: () => setExpanded(true),
              },
              {
                key: "pin",
                label: "Pin to notes",
                icon: Pin,
                onSelect: onPin,
                hidden: !onPin,
              },
              {
                key: "save-image",
                label: savingImage ? "Saving image…" : "Save as full image",
                ariaLabel: "Export the whole artifact, top to bottom, as a PNG",
                icon: savingImage ? Loader2 : Download,
                onSelect: () => void handleSaveImage(),
                disabled: savingImage,
              },
              {
                key: "share",
                label: "Share public link (7 days)",
                ariaLabel: "Share a public link to this artifact",
                icon: Share2,
                onSelect: () => setShareOpen(true),
              },
            ]}
          />
        </div>
        {summary && (
          <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground line-clamp-2">
            {summary.slice(0, 240)}
          </div>
        )}
      </div>
      {overlay && createPortal(overlay, document.body)}
      <ShareHtmlDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        html={html}
        defaultSummary={summary}
        chatId={chatId}
        appId={convertedDesignerId}
      />
    </>
  );
}

function VfsCard({
  proposed,
  fallbackSummary,
  saved,
  autoSaved,
  noBuildRequired,
  onSave,
  onForceComplete,
}: {
  proposed: ProposedVfs;
  fallbackSummary: string;
  saved?: boolean;
  autoSaved?: boolean;
  /** Canvas (note-edit) mode has no Build tool. Skip the build-gated UI. */
  noBuildRequired?: boolean;
  onSave?: () => void;
  onForceComplete?: () => void;
}) {
  const { ops, build, summary, streaming } = proposed;
  const buildOk = build?.ok === true;
  const saveBlocked = !noBuildRequired && !buildOk;
  const buildErrCount = !buildOk && build && !build.ok ? build.errors.length : 0;
  const buildWarnCount = build?.warnings?.length ?? 0;
  const [confirmForceOpen, setConfirmForceOpen] = useState(false);
  const [autoSavedFlash, setAutoSavedFlash] = useState(false);
  useEffect(() => {
    if (saved && autoSaved) {
      setAutoSavedFlash(true);
      const t = setTimeout(() => setAutoSavedFlash(false), 3000);
      return () => clearTimeout(t);
    }
    setAutoSavedFlash(false);
  }, [saved, autoSaved]);

  return (
    <div className="hairline w-full rounded-lg p-2.5 sm:p-3">
      <div className="mb-2 flex items-center gap-2">
        {build ? (
          buildOk ? (
            <PaperPill tone="success">
              ✓ Build OK{build.durationMs ? ` · ${build.durationMs}ms` : ""}
              {buildWarnCount > 0 ? ` · ${buildWarnCount} warning${buildWarnCount === 1 ? "" : "s"}` : ""}
            </PaperPill>
          ) : (
            <PaperPill tone="warn">
              ✗ Build failed · {buildErrCount} error{buildErrCount === 1 ? "" : "s"}
            </PaperPill>
          )
        ) : streaming ? (
          onForceComplete ? (
            <button
              type="button"
              onClick={() => setConfirmForceOpen(true)}
              title="Tap to mark complete and unlock save"
              className="inline-flex items-center rounded-full border border-border bg-secondary/40 px-2 py-0.5 text-[11px] text-foreground/80 transition hover:bg-secondary/60"
            >
              <Loader2 className="mr-1 inline-block h-3 w-3 animate-spin" />
              Editing files · tap to finish
            </button>
          ) : (
            <PaperPill tone="neutral">
              <Loader2 className="mr-1 inline-block h-3 w-3 animate-spin" /> Editing files
            </PaperPill>
          )
        ) : noBuildRequired ? (
          ops.length > 0 ? (
            <PaperPill tone="success">✓ Edits ready</PaperPill>
          ) : (
            <PaperPill tone="neutral">No changes</PaperPill>
          )
        ) : (
          <PaperPill tone="neutral">No build run</PaperPill>
        )}
        {onForceComplete && (
          <Dialog open={confirmForceOpen} onOpenChange={setConfirmForceOpen}>
            <DialogContent className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>Force-finish edit?</DialogTitle>
                <DialogDescription>
                  The assistant hasn't reported it&apos;s done yet. Forcing this
                  closes the in-flight state so you can preview and save the
                  current files. If a build hasn't finished, the Save button
                  will stay disabled until one does.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmForceOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setConfirmForceOpen(false);
                    onForceComplete();
                  }}
                >
                  Force finish
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
        {autoSavedFlash && (
          <PaperPill tone="success">
            <Check className="mr-1 inline-block h-3 w-3" />
            Auto-saved
          </PaperPill>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {ops.length} file{ops.length === 1 ? "" : "s"} touched
        </span>
      </div>

      <div className="text-xs text-muted-foreground line-clamp-2 mb-2">
        {summary || fallbackSummary || ""}
      </div>

      {ops.length > 0 && (
        <ul className="mb-3 flex flex-col gap-0.5 border-l-2 border-border pl-3 font-mono text-[11px]">
          {ops.map((op) => (
            <li key={op.path + op.op} className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px]",
                  op.op === "write"
                    ? "bg-emerald-500/20 text-emerald-400"
                    : op.op === "delete"
                      ? "bg-red-500/20 text-red-400"
                      : "bg-amber-500/20 text-amber-400"
                )}
                aria-label={op.op}
              >
                {op.op === "write" ? "+" : op.op === "delete" ? "−" : "✎"}
              </span>
              <span className="truncate text-foreground/90">{op.path}</span>
              {(op.addedLines !== undefined || op.removedLines !== undefined) && (
                <span className="ml-auto text-muted-foreground">
                  {op.addedLines ? <span className="text-emerald-500">+{op.addedLines}</span> : null}
                  {op.addedLines && op.removedLines ? " " : null}
                  {op.removedLines ? <span className="text-red-500">−{op.removedLines}</span> : null}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {!buildOk && build && !build.ok && build.errors.length > 0 && (
        <details className="mb-3 rounded-lg border border-red-500/30 bg-red-500/5 p-2">
          <summary className="cursor-pointer text-[11px] text-red-400">
            {build.errors.length} build error{build.errors.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 flex flex-col gap-1 font-mono text-[10.5px] text-red-300">
            {build.errors.slice(0, 8).map((e, i) => (
              <li key={i}>
                <span className="text-red-400">
                  {e.file}:{e.line}:{e.column}
                </span>{" "}
                {e.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      {onSave && !streaming && (
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={onSave}
            disabled={saveBlocked || saved || (noBuildRequired && ops.length === 0)}
            title={
              saveBlocked
                ? "Fix build errors before saving."
                : saved
                  ? "This version is saved."
                  : noBuildRequired && ops.length === 0
                    ? "No changes to save."
                    : undefined
            }
            className={cn(saved && "gap-1 bg-emerald-600 text-white hover:bg-emerald-600")}
          >
            {saved ? (
              <>
                <Check className="h-3.5 w-3.5" />
                {autoSaved ? "Auto-saved" : "Saved"}
              </>
            ) : (
              "Save version"
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

function SummaryRow({
  summary,
  collapsed,
  expanded,
  onToggle,
  onDelete,
  onRestore,
}: {
  summary: StoredMessage;
  collapsed: StoredMessage[];
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onRestore: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onToggle}
        className="group/sum relative flex items-center gap-3 border-y border-border/70 px-1 py-2.5 text-left text-xs text-muted-foreground transition hover:text-foreground"
      >
        <Sparkles className="h-3.5 w-3.5 text-primary/80" />
        <span className="flex-1">
          Compacted <span className="text-foreground">{collapsed.length}</span> earlier{" "}
          {collapsed.length === 1 ? "message" : "messages"}
          <span className="ml-2 text-muted-foreground/70">{summary.content.slice(0, 90)}…</span>
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 transition",
            expanded && "rotate-180"
          )}
        />
        <button
          type="button"
          aria-label="Delete summary"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="hidden rounded-md p-1 text-muted-foreground hover:text-destructive group-hover/sum:flex"
        >
          <MoreHorizontal className="h-3 w-3" />
        </button>
      </button>

      {expanded && (
        <div className="ml-3 flex flex-col gap-3 border-l border-border pl-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
              Recap · {collapsed.length} {collapsed.length === 1 ? "message" : "messages"} folded
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRestore();
              }}
              className="tap inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
              title="Restore the original messages and remove this recap. They'll re-compact on your next message."
            >
              <Undo2 className="h-3 w-3" />
              Restore originals
            </button>
          </div>
          <div className="text-xs text-muted-foreground whitespace-pre-wrap">
            {summary.content}
          </div>
          {collapsed.map((m) => (
            <div
              key={m.id}
              className={cn(
                "text-xs whitespace-pre-wrap",
                m.role === "user" ? "text-foreground/80" : "text-muted-foreground"
              )}
            >
              <div className="mb-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground/70">
                {m.role}
              </div>
              {m.content || <em>(empty)</em>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * In-turn compaction notice. Rendered on an assistant message when the server
 * folded older tool rounds into a recap mid-turn (the "Compacting context…"
 * step) to keep the conversation under the model's window. Unlike the
 * cross-turn SummaryRow this is informational: the raw tool output it replaced
 * lived only server-side and isn't restorable - but the recap it produced is
 * persisted on the message and shown here, expandable.
 */
function CompactionNotice({ events }: { events: ToolEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  const calls = events.filter(
    (e): e is Extract<ToolEvent, { kind: "call" }> =>
      e.kind === "call" && e.name === "compaction"
  );
  if (calls.length === 0) return null;
  // A single turn rarely compacts more than once; show the latest.
  const last = calls[calls.length - 1];
  const args = last.args ?? {};
  const folded = typeof args.messagesFolded === "number" ? args.messagesFolded : 0;
  const summary = typeof args.summary === "string" ? args.summary : "";
  const tokensBefore =
    typeof args.tokensBefore === "number" ? args.tokensBefore : undefined;
  const tokensAfter =
    typeof args.tokensAfter === "number" ? args.tokensAfter : undefined;
  // Show only once the recap is in (the `done` event populates `summary`).
  // While compaction is mid-flight the live "Compacting context…" pill covers
  // it; a pure hard-trim backstop carries no recap and stays quiet here too.
  if (!summary) return null;

  return (
    <div className="flex flex-col gap-2 self-start">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        disabled={!summary}
        className="inline-flex max-w-full items-center gap-2 self-start py-1 text-xs text-muted-foreground transition hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground"
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary/80" />
        <span className="min-w-0">
          Compacted <span className="text-foreground">{folded}</span> earlier{" "}
          {folded === 1 ? "round" : "rounds"} to save context
          {typeof tokensBefore === "number" && typeof tokensAfter === "number" && (
            <span className="ml-1 text-muted-foreground/70">
              ({Math.round(tokensBefore / 1000)}k → {Math.round(tokensAfter / 1000)}k tokens)
            </span>
          )}
        </span>
        {summary && (
          <ChevronDown
            className={cn("h-3.5 w-3.5 shrink-0 transition", expanded && "rotate-180")}
          />
        )}
      </button>
      {expanded && summary && (
        <div className="ml-5 max-w-md whitespace-pre-wrap border-l border-border pl-3 text-xs text-muted-foreground">
          {summary}
        </div>
      )}
    </div>
  );
}

type ComposerHandle = {
  getValue: () => string;
  setValue: (v: string) => void;
};

type ComposerProps = {
  onSend: () => void;
  onStop: () => void;
  pending: boolean;
  /** True when a stream is in flight AND has a live streamId — the input
   *  stays enabled so the user can queue up a follow-up message that the
   *  backend will splice into the same stream when the current turn ends. */
  canQueue: boolean;
  /** True while a Multi Research round's reports are still running — the
   *  composer is fully locked (no queueing) until every report finishes. */
  lockComposer?: boolean;
  placeholder: string;
  model: string;
  pendingImages: AttachedImage[];
  pendingPdfs: AttachedPdf[];
  pendingCsvs: AttachedCsv[];
  imageError: string | null;
  onAddImages: (files: File[]) => void | Promise<void>;
  onRemoveImage: (id: string) => void;
  onAddPdfs: (files: File[]) => void | Promise<void>;
  onRemovePdf: (id: string) => void;
  onAddCsvs: (files: File[]) => void | Promise<void>;
  onRemoveCsv: (id: string) => void;
  /** Code Execution mode on — surfaces the binary-file attach affordance. */
  codeExec: boolean;
  pendingFiles: AttachedFile[];
  /** Count of files currently uploading to Blob (drives the busy chip). */
  filesUploading: number;
  onAddFiles: (files: File[]) => void | Promise<void>;
  onRemoveFile: (id: string) => void;
};

const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer({
  onSend,
  onStop,
  pending,
  canQueue,
  lockComposer,
  placeholder,
  model,
  pendingImages,
  pendingPdfs,
  pendingCsvs,
  imageError,
  onAddImages,
  onRemoveImage,
  onAddPdfs,
  onRemovePdf,
  onAddCsvs,
  onRemoveCsv,
  codeExec,
  pendingFiles,
  filesUploading,
  onAddFiles,
  onRemoveFile,
}, ref) {
  // The composer owns its own input value. Typing only re-renders this small
  // component instead of the entire Chat tree (8000+ lines, every message
  // bubble, etc.). The parent reads / writes the value through the imperative
  // handle below.
  const [value, setValue] = useState("");
  const valueRef = useRef(value);
  valueRef.current = value;
  useImperativeHandle(
    ref,
    () => ({
      getValue: () => valueRef.current,
      setValue: (v: string) => setValue(v),
    }),
    []
  );

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const visionNative = modelSupportsVision(model);
  const sandboxFileInputRef = useRef<HTMLInputElement | null>(null);
  const hasImages = pendingImages.length > 0;
  const hasPdfs = pendingPdfs.length > 0;
  const hasCsvs = pendingCsvs.length > 0;
  const hasFiles = pendingFiles.length > 0;
  const inputBlocked = (pending && !canQueue) || !!lockComposer;
  const canSubmit =
    !lockComposer &&
    (!pending || canQueue) &&
    (value.trim().length > 0 || hasImages || hasPdfs || hasCsvs || hasFiles);

  // Dictation glue. Live partials stream into a preview strip above the
  // textarea (italic, bounded) — they never touch the textarea itself, so the
  // composer height stays stable and there's no race between rapid partial
  // setState and React's render cycle. On commit (silence or stop) the
  // finalized transcript is appended to the textarea and the preview clears.
  const [micPreview, setMicPreview] = useState("");
  const micPreviewRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = micPreviewRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [micPreview]);
  const handleMicPartial = useCallback((text: string) => {
    setMicPreview(text);
  }, []);
  const handleMicCommit = useCallback((text: string) => {
    setMicPreview("");
    if (!text) return;
    const cur = valueRef.current;
    const needsSep =
      cur.length > 0 && !/[\s\n]$/.test(cur) && text.length > 0;
    setValue(cur + (needsSep ? " " : "") + text);
  }, []);

  // The mic button owns live recording state (useOpenAISTT), so it can't live
  // inside a menu that unmounts on close. The "+" menu reveals it instead;
  // once revealed it stays for the session.
  const [micVisible, setMicVisible] = useState(false);

  return (
    <form
      className="safe-bottom reader-col mt-2 flex flex-col gap-2 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSend();
      }}
    >
      {hasImages && (
        <div className="flex flex-col gap-1.5 px-1 pt-1">
          <div className="flex flex-wrap gap-2">
            {pendingImages.map((img) => (
              <div
                key={img.id}
                className="group/img relative h-16 w-16"
                title={img.name}
              >
                <ImagePreview
                  src={img.dataUrl}
                  alt={img.name ?? "attached image"}
                  triggerTitle={img.name}
                  triggerClassName="tap block h-16 w-16 overflow-hidden rounded-lg border border-border bg-muted p-0 transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.dataUrl}
                    alt={img.name ?? "attached image"}
                    className="h-full w-full object-cover"
                  />
                </ImagePreview>
                <button
                  type="button"
                  onClick={() => onRemoveImage(img.id)}
                  aria-label="Remove image"
                  disabled={inputBlocked}
                  className="tap absolute -top-1.5 -right-1.5 z-10 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow transition hover:text-destructive disabled:opacity-50"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          <span className="px-0.5 text-[10.5px] text-muted-foreground">
            {visionNative ? (
              <>
                <ImageIcon className="mr-1 inline-block h-3 w-3 text-primary" />
                Native image mode — sent directly to {model}.
              </>
            ) : (
              <>
                <ImageIcon className="mr-1 inline-block h-3 w-3 text-amber-600" />
                {model} can&apos;t see images. {VISION_DESCRIBER_MODEL} will describe them and send the
                text caption to {model}.
              </>
            )}
          </span>
        </div>
      )}
      {hasPdfs && (
        <div className="flex flex-col gap-1.5 px-1 pt-1">
          <div className="flex flex-wrap gap-2">
            {pendingPdfs.map((pdf) => (
              <div
                key={pdf.id}
                className="group/pdf relative flex items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs"
                title={pdf.excerpt || pdf.name}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="max-w-[160px] truncate">{pdf.name}</span>
                <span className="text-muted-foreground">
                  {pdf.pageCount === 1 ? "1p" : `${pdf.pageCount}p`}
                  {" · "}
                  {formatPdfBytes(pdf.bytes)}
                  {pdf.truncated ? " · trimmed" : ""}
                </span>
                <button
                  type="button"
                  onClick={() => onRemovePdf(pdf.id)}
                  aria-label="Remove PDF"
                  disabled={inputBlocked}
                  className="tap absolute -top-1.5 -right-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow transition hover:text-destructive disabled:opacity-50"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          <span className="px-0.5 text-[10.5px] text-muted-foreground">
            <FileText className="mr-1 inline-block h-3 w-3 text-primary" />
            PDF text extracted in your browser and sent inline as context to {model}.
          </span>
        </div>
      )}
      {hasCsvs && (
        <div className="flex flex-col gap-1.5 px-1 pt-1">
          <div className="flex flex-wrap gap-2">
            {pendingCsvs.map((csv) => (
              <div
                key={csv.id}
                className="group/csv relative flex items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs"
                title={csv.excerpt || csv.name}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                <span className="max-w-[160px] truncate">{csv.name}</span>
                <span className="text-muted-foreground">
                  {csv.rowCount === 1 ? "1 row" : `${csv.rowCount} rows`}
                  {" · "}
                  {csv.columnCount} col{csv.columnCount !== 1 ? "s" : ""}
                  {" · "}
                  {formatCsvBytes(csv.bytes)}
                  {csv.truncated ? " · trimmed" : ""}
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveCsv(csv.id)}
                  aria-label="Remove CSV"
                  disabled={inputBlocked}
                  className="tap absolute -top-1.5 -right-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow transition hover:text-destructive disabled:opacity-50"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          <span className="px-0.5 text-[10.5px] text-muted-foreground">
            <FileText className="mr-1 inline-block h-3 w-3 text-emerald-600" />
            CSV data parsed in your browser and sent as a table to {model}.
          </span>
        </div>
      )}
      {(hasFiles || filesUploading > 0) && (
        <div className="flex flex-col gap-1.5 px-1 pt-1">
          <div className="flex flex-wrap gap-2">
            {pendingFiles.map((file) => (
              <div
                key={file.id}
                className="group/file relative flex items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs"
                title={file.name}
              >
                <Code2 className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent-2)]" />
                <span className="max-w-[160px] truncate">{file.name}</span>
                <span className="text-muted-foreground">{formatFileBytes(file.bytes)}</span>
                <button
                  type="button"
                  onClick={() => onRemoveFile(file.id)}
                  aria-label="Remove file"
                  disabled={inputBlocked}
                  className="tap absolute -top-1.5 -right-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow transition hover:text-destructive disabled:opacity-50"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {filesUploading > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Uploading {filesUploading}…</span>
              </div>
            )}
          </div>
          <span className="px-0.5 text-[10.5px] text-muted-foreground">
            <Code2 className="mr-1 inline-block h-3 w-3 text-[var(--color-accent-2)]" />
            Available to the code sandbox — the model can read these by name with run_code.
          </span>
        </div>
      )}
      {imageError && (
        <div className="px-1 text-[11px] text-destructive">{imageError}</div>
      )}

      {micPreview && (
        <div
          ref={micPreviewRef}
          aria-live="polite"
          className="max-h-24 overflow-y-auto px-1 pt-0.5 text-[13px] italic leading-snug text-muted-foreground whitespace-pre-wrap sm:text-xs"
        >
          {micPreview}
        </div>
      )}

      {lockComposer && (
        <div className="mx-1 mb-1.5 flex items-center gap-2 rounded-lg border border-[color-mix(in_oklab,var(--color-accent)_32%,transparent)] bg-[color-mix(in_oklab,var(--color-accent)_8%,transparent)] px-3 py-2 text-[11.5px] font-medium text-[var(--color-accent)]">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span>Researching reports… reply unlocks when every report finishes (Stop above).</span>
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf,.csv,.tsv,text/csv"
          multiple
          className="hidden"
          onChange={async (e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length === 0) return;
            const pdfs = files.filter(
              (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name)
            );
            const csvFiles = files.filter(
              (f) => f.type === "text/csv" || /\.(csv|tsv)$/i.test(f.name)
            );
            const images = files.filter((f) => f.type.startsWith("image/"));
            if (pdfs.length > 0) await onAddPdfs(pdfs);
            if (csvFiles.length > 0) await onAddCsvs(csvFiles);
            if (images.length > 0) await onAddImages(images);
          }}
        />
        <input
          ref={sandboxFileInputRef}
          type="file"
          accept="*/*"
          multiple
          className="hidden"
          onChange={async (e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length > 0) await onAddFiles(files);
          }}
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="More composer options"
            disabled={inputBlocked}
            className={cn(
              "tap inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition",
              "hover:text-foreground data-popup-open:text-foreground",
              "disabled:pointer-events-none disabled:opacity-50"
            )}
          >
            <Plus className="h-5 w-5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[14rem]">
            <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
              <Paperclip className="h-4 w-4" />
              <span>
                {visionNative
                  ? "Attach photo, PDF, or CSV"
                  : "Attach photo, PDF, or CSV (described)"}
              </span>
            </DropdownMenuItem>
            {codeExec && (
              <DropdownMenuItem onClick={() => sandboxFileInputRef.current?.click()}>
                <Code2 className="h-4 w-4" />
                <span>Attach file for code (audio, video, …)</span>
              </DropdownMenuItem>
            )}
            {!micVisible && (
              <DropdownMenuItem onClick={() => setMicVisible(true)}>
                <Mic className="h-4 w-4" />
                <span>Dictate</span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {micVisible && (
          <ComposerMicButton
            disabled={inputBlocked}
            onPartial={handleMicPartial}
            onCommit={handleMicCommit}
          />
        )}

        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (canSubmit) onSend();
            }
          }}
          onPaste={async (e) => {
            if (inputBlocked) return;
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length === 0) return;
            const pdfs = files.filter(
              (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name)
            );
            const csvFiles = files.filter(
              (f) => f.type === "text/csv" || /\.(csv|tsv)$/i.test(f.name)
            );
            const images = files.filter((f) => f.type.startsWith("image/"));
            if (pdfs.length === 0 && csvFiles.length === 0 && images.length === 0) return;
            e.preventDefault();
            if (pdfs.length > 0) await onAddPdfs(pdfs);
            if (csvFiles.length > 0) await onAddCsvs(csvFiles);
            if (images.length > 0) await onAddImages(images);
          }}
          placeholder={
            pending && canQueue ? "Queue follow-up…" : placeholder
          }
          rows={1}
          className="min-w-0 min-h-[44px] max-h-[40vh] flex-1 resize-none overflow-y-auto bg-transparent py-2 text-base text-foreground outline-none placeholder:overflow-hidden placeholder:text-ellipsis placeholder:whitespace-nowrap placeholder:text-muted-foreground disabled:opacity-60 sm:text-sm"
          style={{ fieldSizing: "content" } as React.CSSProperties}
          disabled={inputBlocked}
        />
        {pending && (
          <Button
            type="button"
            onClick={onStop}
            variant="outline"
            size="icon-touch"
            aria-label="Stop generating"
            className="tap shrink-0 rounded-full hover:bg-destructive/10 hover:text-destructive"
          >
            <Square className="h-4 w-4 fill-current" />
          </Button>
        )}
        {(!pending || canQueue) && (
          <Button
            type="submit"
            disabled={!canSubmit}
            size="icon-touch"
            aria-label={pending ? "Queue follow-up message" : "Send message"}
            className="tap shrink-0 rounded-full"
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </form>
  );
});
