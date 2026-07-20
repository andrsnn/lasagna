"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowUp,
  Highlighter,
  Loader2,
  NotebookPen,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  DEFAULT_SETTINGS,
  getChat,
  getPinnedNote,
  loadMessages,
  loadSettings,
  newId,
  putChat,
  putMessage,
  type MessageHighlight,
  type Settings,
  type StoredChat,
  type StoredMessage,
  type StoredPinnedNote,
} from "@/app/db";
import {
  catalogEntry,
  DEFAULT_MODEL,
  THERAPY_RECOMMENDED_MODEL,
  type CloudModel,
} from "@/app/models";
import { consumeDeltasOnly } from "@/app/lib/consume-deltas";
import {
  injectSentinels,
  resolveHighlightRanges,
  selectionToAnchor,
  type Anchor,
} from "@/app/lib/annotations/anchor";
import { rehypeHighlights } from "@/app/lib/annotations/rehype-highlights";
import { buildExtraSystem } from "@/app/lib/extra-system";
import { appendClip, syncSessionNote } from "@/app/lib/therapy/notes";
import { Button } from "@/components/ui/button";

type Status = "idle" | "thinking";

// Layered on top of the `therapist` persona prompt (appended last on the
// server, so it wins over generic formatting guidance). The transcript is
// rendered as long-form serif prose, so steer away from chat-style structure.
// The anti-formula rules target observed failure modes in BOTH directions:
// replies that inventory the user's story back at them, narrate their own
// technique, recycle stock validations, and close every turn with a
// question — but also terse, passive acknowledgments that leave the user
// doing all the work (live feedback). Length should go to exploration.
const THERAPIST_MODE_ADDENDUM =
  "You are in a quiet, distraction-free therapy space rendered as long-form text. " +
  "Replies should be unhurried and substantive — usually three to five short paragraphs that explore what the user said from more than one angle: the feeling underneath it, the thought or belief attached to it, the pattern or theme it connects to, what it might mean. Spend that length on exploration, never on recapping their story or stacking validation, and never compress down to a bare two-line acknowledgment. " +
  "Write in plain, warm prose; avoid bullet lists, headings, bold text, and emoji unless the user asks for structure. " +
  "Never narrate your own technique ('I want to pause here', 'I want to name something', 'I want to be honest with you', 'I want to be careful with this'); just say the thing. " +
  "Avoid stock validations and therapist-speak tics ('that's not nothing', 'that's not a small thing', 'that tracks', 'that landed with me', 'I hear you') — vary your language, and let warmth come from close attention to specifics rather than declarations of warmth or intimacy. " +
  "Don't end every reply with a question — end some on a statement that gives the user something to sit with. When you do ask, one clear question is enough.";

// Warm clay wash for saved highlights — matches the reading surface rather
// than the yellow research marks used in the regular chat view.
const MARK_CLASS =
  "rounded-[2px] bg-[#b4654a]/25 px-0.5 text-inherit dark:bg-[#8a4b34]/45";

function displayable(m: StoredMessage): boolean {
  if (m.error) return false;
  if (m.kind === "summary") return false;
  if (m.streamId) return false;
  return !!m.content?.trim();
}

/** Plain-text body with saved highlights wrapped in <mark> — for user turns,
 *  which render as raw text rather than markdown. */
function PlainWithHighlights({
  content,
  highlights,
}: {
  content: string;
  highlights?: MessageHighlight[];
}) {
  const ranges = highlights?.length
    ? resolveHighlightRanges(content, highlights)
    : [];
  if (ranges.length === 0) return <>{content}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) parts.push(content.slice(cursor, r.start));
    parts.push(
      <mark key={r.id} className={MARK_CLASS}>
        {content.slice(r.start, r.end)}
      </mark>
    );
    cursor = r.end;
  }
  if (cursor < content.length) parts.push(content.slice(cursor));
  return <>{parts}</>;
}

const markdownComponents = {
  mark: ({ children }: { children?: React.ReactNode }) => (
    <mark className={MARK_CLASS}>{children}</mark>
  ),
};

type PendingClip = {
  messageId: string;
  anchor: Anchor;
  /** Content-space coordinates inside the scroll container. */
  top: number;
  left: number;
};

export default function TherapistMode({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: chatId } = use(params);
  const router = useRouter();

  const [status, setStatus] = useState<Status>("idle");
  const [chat, setChat] = useState<StoredChat | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyReason, setBusyReason] = useState<string | null>(null);

  const [pendingClip, setPendingClip] = useState<PendingClip | null>(null);
  // Model nudge: therapist mode has no picker, so when the chat is pinned to
  // a model that isn't the EQ-leading recommendation (and the recommendation
  // is actually available on the account), offer a one-tap switch.
  const [recommendedAvailable, setRecommendedAvailable] = useState(false);
  const [modelHintDismissed, setModelHintDismissed] = useState(false);
  const [justClipped, setJustClipped] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesSyncing, setNotesSyncing] = useState(false);
  const [panelNotes, setPanelNotes] = useState<{
    session: StoredPinnedNote | null;
    clips: StoredPinnedNote | null;
  } | null>(null);

  const settingsRef = useRef<Settings>({ ...DEFAULT_SETTINGS });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Abort the in-flight chat round if the user exits the page.
  const inflightCtrlRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<StoredMessage[]>([]);
  messagesRef.current = messages;
  const noteSyncInFlightRef = useRef(false);

  // Mount: load chat + settings + history.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [c, s, msgs] = await Promise.all([
          getChat(chatId),
          loadSettings(),
          loadMessages(chatId),
        ]);
        if (cancelled) return;
        settingsRef.current = s;
        setChat(c ?? null);
        const inflight = msgs.some((m) => m.role === "assistant" && m.streamId);
        if (inflight) {
          setBusyReason("Previous reply still streaming — wait a moment.");
        }
        setMessages(msgs.filter(displayable));
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  // Final cleanup: abort the in-flight call.
  useEffect(() => {
    return () => {
      inflightCtrlRef.current?.abort();
    };
  }, []);

  // Check whether the recommended model is actually available on this
  // account before offering the switch. Failure just hides the hint.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/models");
        if (!res.ok) return;
        const data = (await res.json()) as { available?: CloudModel[] };
        if (cancelled) return;
        setRecommendedAvailable(
          (data.available ?? []).some((m) => m.id === THERAPY_RECOMMENDED_MODEL)
        );
      } catch {
        // Quiet — the hint is a nicety, not a feature.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const switchToRecommendedModel = useCallback(async () => {
    const c = (await getChat(chatId)) ?? chat;
    if (!c) return;
    const updated: StoredChat = {
      ...c,
      model: THERAPY_RECOMMENDED_MODEL,
      updatedAt: Date.now(),
    };
    await putChat(updated);
    setChat(updated);
  }, [chat, chatId]);

  // Keep the latest exchange in view as text streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingText, status]);

  // Selection → floating "Save to notes" pill. Re-derived (debounced) on
  // every selection change; positioned in the scroll container's content
  // space so it stays glued to the passage while the page scrolls.
  useEffect(() => {
    let timer: number | undefined;
    const update = () => {
      const scrollEl = scrollRef.current;
      const sel = window.getSelection();
      if (!scrollEl || !sel || sel.isCollapsed || sel.rangeCount === 0) {
        setPendingClip(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const el =
        container instanceof Element ? container : container.parentElement;
      const sectionEl = el?.closest<HTMLElement>("[data-msg-id]") ?? null;
      if (!sectionEl || !scrollEl.contains(sectionEl)) {
        setPendingClip(null);
        return;
      }
      const msgId = sectionEl.dataset.msgId!;
      const msg = messagesRef.current.find((m) => m.id === msgId);
      if (!msg) {
        setPendingClip(null);
        return;
      }
      const anchor = selectionToAnchor(sectionEl, msg.content);
      if (!anchor) {
        setPendingClip(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const cRect = scrollEl.getBoundingClientRect();
      setPendingClip({
        messageId: msgId,
        anchor,
        top: rect.top - cRect.top + scrollEl.scrollTop - 10,
        left: Math.min(
          Math.max(rect.left + rect.width / 2 - cRect.left, 72),
          cRect.width - 72
        ),
      });
    };
    const onSelectionChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(update, 120);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, []);

  // Persist the highlight on the message (renders the warm <mark> in the
  // transcript) and clip the passage into the chat's "Saved passages" note.
  const saveClip = useCallback(async () => {
    const pending = pendingClip;
    if (!pending) return;
    setPendingClip(null);
    window.getSelection()?.removeAllRanges();
    const msg = messagesRef.current.find((m) => m.id === pending.messageId);
    if (!msg) return;
    const highlight: MessageHighlight = {
      id: newId(),
      ...pending.anchor,
      createdAt: Date.now(),
    };
    const updated: StoredMessage = {
      ...msg,
      highlights: [...(msg.highlights ?? []), highlight],
    };
    await putMessage(updated);
    setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
    setJustClipped(true);
    window.setTimeout(() => setJustClipped(false), 1600);
    try {
      await appendClip(chatId, pending.anchor.selectedText);
      const c = await getChat(chatId);
      if (c) setChat(c);
    } catch {
      // Highlight persisted; note append is best-effort.
    }
  }, [chatId, pendingClip]);

  // Background session-notes refresh after each completed exchange. Quiet by
  // design: failures are swallowed (the next exchange retries) and the only
  // surface is a soft pulse on the notebook icon.
  const queueNotesSync = useCallback(
    (model: string) => {
      if (noteSyncInFlightRef.current) return;
      noteSyncInFlightRef.current = true;
      setNotesSyncing(true);
      void (async () => {
        try {
          const all = await loadMessages(chatId);
          const wire = all
            .filter(
              (m) =>
                !m.summarizedInto &&
                !m.error &&
                m.kind !== "summary" &&
                !!m.content?.trim()
            )
            .map((m) => ({ role: m.role, content: m.content }));
          if (wire.length < 2) return;
          await syncSessionNote({
            chatId,
            messages: wire,
            model,
            runpodEndpointId: settingsRef.current.runpodEndpointId,
          });
          const c = await getChat(chatId);
          if (c) setChat(c);
        } catch {
          // Quiet — retried after the next exchange.
        } finally {
          noteSyncInFlightRef.current = false;
          setNotesSyncing(false);
        }
      })();
    },
    [chatId]
  );

  // Hydrate the notes panel each time it opens.
  useEffect(() => {
    if (!notesOpen) return;
    let cancelled = false;
    void (async () => {
      const c = await getChat(chatId);
      const [session, clips] = await Promise.all([
        c?.sessionMemoryNoteId
          ? getPinnedNote(c.sessionMemoryNoteId)
          : Promise.resolve(undefined),
        c?.therapyClipsNoteId
          ? getPinnedNote(c.therapyClipsNoteId)
          : Promise.resolve(undefined),
      ]);
      if (cancelled) return;
      setPanelNotes({ session: session ?? null, clips: clips ?? null });
    })();
    return () => {
      cancelled = true;
    };
  }, [notesOpen, chatId, notesSyncing]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || status === "thinking" || busyReason) return;
    setError(null);
    setInput("");
    setStatus("thinking");
    const ctrl = new AbortController();
    inflightCtrlRef.current = ctrl;
    try {
      const prior = await loadMessages(chatId);
      const wirePayload = prior
        .filter((m) => !m.summarizedInto && !m.error && m.kind !== "summary")
        .map((m) => ({ role: m.role, content: m.content }));
      wirePayload.push({ role: "user", content: text });

      // Persist the user's turn before the fetch so an aborted or failed
      // request doesn't lose what they typed.
      const userMsg: StoredMessage = {
        id: newId(),
        chatId,
        role: "user",
        content: text,
        createdAt: Date.now(),
      };
      await putMessage(userMsg);
      setMessages((prev) => [...prev, userMsg]);

      const s = settingsRef.current;
      const model = chat?.model ?? s.defaultModel ?? DEFAULT_MODEL;

      // Weave in the between-sessions context: the AI-maintained session
      // notes (as <session_memory>) and the user's saved passages (as an
      // attached note) so the therapist picks up where things left off.
      const liveChat = await getChat(chatId);
      const contextPins: StoredPinnedNote[] = [];
      if (liveChat?.therapyClipsNoteId) {
        const n = await getPinnedNote(liveChat.therapyClipsNoteId);
        if (n) contextPins.push(n);
      }
      if (liveChat?.sessionMemoryNoteId) {
        const n = await getPinnedNote(liveChat.sessionMemoryNoteId);
        if (n) contextPins.push(n);
      }
      const extra = buildExtraSystem(
        undefined,
        contextPins,
        liveChat?.sessionMemoryNoteId
      );
      const system = extra
        ? `${THERAPIST_MODE_ADDENDUM}\n\n${extra}`
        : THERAPIST_MODE_ADDENDUM;

      // Therapist mode pins its persona and keeps tools off for a calm,
      // search-free exchange — settings persona/research flags don't apply.
      const postBody: Record<string, unknown> = {
        model,
        messages: wirePayload,
        responseFormat: "chat",
        chatPersonaId: "therapist",
        system,
        webSearch: false,
        imageSearch: false,
        research: false,
      };
      if (s.runpodEndpointId) postBody.runpodEndpointId = s.runpodEndpointId;

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(postBody),
        signal: ctrl.signal,
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (res.status === 503) {
        throw new Error(
          "Therapist mode needs server stream storage configured (UPSTASH_REDIS_REST_URL)."
        );
      }
      if (!res.ok) {
        const detail = await res
          .json()
          .catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(detail.error ?? `HTTP ${res.status}`);
      }
      const handshake = (await res.json()) as { streamId?: string };
      if (!handshake.streamId) throw new Error("Server did not return a streamId.");

      const full = await consumeDeltasOnly(
        handshake.streamId,
        ctrl.signal,
        (sofar) => setStreamingText(sofar)
      );
      if (!full.trim()) throw new Error("Empty response.");

      const assistantMsg: StoredMessage = {
        id: newId(),
        chatId,
        role: "assistant",
        content: full,
        createdAt: Date.now(),
        model,
      };
      await putMessage(assistantMsg);
      setMessages((prev) => [...prev, assistantMsg]);
      setStatus("idle");
      queueNotesSync(model);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Page exit; don't surface.
        return;
      }
      const message = err instanceof Error ? err.message : "Request failed";
      setError(message);
      setStatus("idle");
    } finally {
      setStreamingText("");
      if (inflightCtrlRef.current === ctrl) inflightCtrlRef.current = null;
    }
  }, [busyReason, chat?.model, chatId, input, queueNotesSync, status]);

  const onExit = useCallback(() => {
    inflightCtrlRef.current?.abort();
    router.push(`/chats/${chatId}`);
  }, [chatId, router]);

  const canSend = !!input.trim() && status !== "thinking" && !busyReason;

  const activeModel = hydrated
    ? chat?.model ?? settingsRef.current.defaultModel ?? DEFAULT_MODEL
    : null;
  const showModelHint =
    !!activeModel &&
    activeModel !== THERAPY_RECOMMENDED_MODEL &&
    recommendedAvailable &&
    !modelHintDismissed;
  const recommendedLabel =
    catalogEntry(THERAPY_RECOMMENDED_MODEL)?.label ?? THERAPY_RECOMMENDED_MODEL;

  return (
    <div className="safe-top safe-bottom fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <header className="flex items-center justify-between px-4 pt-3 pb-2">
        <Button
          variant="ghost"
          size="icon-touch"
          onClick={onExit}
          aria-label="Exit therapist mode"
        >
          <ArrowLeft className="h-6 w-6" />
        </Button>
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Therapist
        </div>
        <Button
          variant="ghost"
          size="icon-touch"
          onClick={() => setNotesOpen((v) => !v)}
          aria-label={notesOpen ? "Close session notes" : "Open session notes"}
          aria-pressed={notesOpen}
        >
          {notesOpen ? (
            <X className="h-5 w-5" />
          ) : (
            <NotebookPen
              className={
                notesSyncing
                  ? "h-5 w-5 animate-pulse text-muted-foreground"
                  : "h-5 w-5 text-muted-foreground"
              }
            />
          )}
        </Button>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="relative h-full overflow-y-auto">
          {!hydrated ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <article
              className="note-reader prose mx-auto w-full break-words px-5 py-8 sm:px-8"
              data-size="md"
              data-width="medium"
            >
              {chat?.title ? (
                <p className="note-reader-byline">{chat.title}</p>
              ) : null}
              {messages.length === 0 && !streamingText && status === "idle" ? (
                <p className="text-muted-foreground italic">
                  Whenever you&apos;re ready.
                </p>
              ) : null}
              <div className="flex flex-col gap-6">
                {messages.map((m) =>
                  m.role === "user" ? (
                    <section
                      key={m.id}
                      data-msg-id={m.id}
                      className="flex flex-col gap-1"
                    >
                      <div className="note-reader-role">You</div>
                      <p className="my-0 whitespace-pre-wrap text-foreground/80">
                        <PlainWithHighlights
                          content={m.content}
                          highlights={m.highlights}
                        />
                      </p>
                    </section>
                  ) : (
                    <section key={m.id} data-msg-id={m.id}>
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeHighlights]}
                        components={markdownComponents}
                      >
                        {injectSentinels(m.content, m.highlights ?? [])}
                      </ReactMarkdown>
                    </section>
                  )
                )}
                {status === "thinking" ? (
                  streamingText ? (
                    <section>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {streamingText}
                      </ReactMarkdown>
                    </section>
                  ) : (
                    <p className="animate-pulse text-muted-foreground italic">
                      Taking that in…
                    </p>
                  )
                ) : null}
              </div>
            </article>
          )}

          {pendingClip ? (
            <div
              className="absolute z-20 -translate-x-1/2 -translate-y-full"
              style={{ top: pendingClip.top, left: pendingClip.left }}
            >
              <button
                type="button"
                // Keep the selection alive through the click.
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => void saveClip()}
                className="flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-md transition-colors hover:bg-muted"
              >
                <Highlighter className="h-3.5 w-3.5" />
                Save to notes
              </button>
            </div>
          ) : null}

          {justClipped ? (
            <div className="pointer-events-none fixed bottom-24 left-1/2 z-20 -translate-x-1/2 rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground shadow-md">
              Saved to your notes
            </div>
          ) : null}
        </div>

        {notesOpen ? (
          <div className="absolute inset-0 z-30 overflow-y-auto bg-background">
            <article
              className="note-reader prose mx-auto w-full break-words px-5 py-8 sm:px-8"
              data-size="md"
              data-width="medium"
            >
              <p className="note-reader-byline">Between sessions</p>
              <h2>Session notes</h2>
              {panelNotes?.session?.messageMarkdown?.trim() ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {panelNotes.session.messageMarkdown}
                </ReactMarkdown>
              ) : (
                <p className="text-muted-foreground italic">
                  Nothing here yet — notes gather quietly as you talk, so the
                  conversation can pick up where it left off.
                </p>
              )}
              <h2>Saved passages</h2>
              {panelNotes?.clips?.messageMarkdown?.trim() ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {panelNotes.clips.messageMarkdown}
                </ReactMarkdown>
              ) : (
                <p className="text-muted-foreground italic">
                  Select any passage in the conversation and tap “Save to
                  notes” to keep it here.
                </p>
              )}
            </article>
          </div>
        ) : null}
      </div>

      <footer className="border-t border-border px-4 py-3">
        {showModelHint ? (
          <div className="mx-auto mb-2 flex w-full max-w-[46rem] items-center gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">
              {recommendedLabel} is the most emotionally attuned model offered
              here — a better fit for this space.
            </span>
            <button
              type="button"
              onClick={() => void switchToRecommendedModel()}
              className="shrink-0 rounded-full border border-border px-2.5 py-0.5 font-medium text-foreground transition-colors hover:bg-muted"
            >
              Use it
            </button>
            <button
              type="button"
              onClick={() => setModelHintDismissed(true)}
              aria-label="Dismiss model suggestion"
              className="tap inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        <form
          className="mx-auto flex w-full max-w-[46rem] items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (canSend) void send();
              }
            }}
            placeholder="What's on your mind?"
            rows={1}
            enterKeyHint="send"
            className="min-w-0 min-h-[44px] max-h-[40vh] flex-1 resize-none overflow-y-auto bg-transparent py-2 text-base text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
            style={{ fieldSizing: "content" } as React.CSSProperties}
            disabled={!hydrated || !!busyReason}
          />
          <Button
            type="submit"
            size="icon-touch"
            disabled={!canSend}
            aria-label="Send"
            className="rounded-full"
          >
            {status === "thinking" ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <ArrowUp className="h-5 w-5" />
            )}
          </Button>
        </form>
        {error || busyReason ? (
          <div className="mx-auto mt-2 w-full max-w-[46rem] text-sm">
            {error ? (
              <span className="text-destructive">{error}</span>
            ) : (
              <span className="text-muted-foreground">{busyReason}</span>
            )}
          </div>
        ) : null}
      </footer>
    </div>
  );
}
