"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getChat,
  getMessage,
  getPinnedNote,
  putChat,
  putMessage,
  type ArtifactFiles,
  type ChatTarget,
  type ProposedVfs,
  type StoredChat,
  type StoredMessage,
  type StoredPinnedNote,
} from "@/app/db";
import { buildExtraSystem } from "@/app/lib/extra-system";
import { Chat } from "@/app/components/chat";
import { PaperCard } from "@/app/components/paper-card";
import { PaperPill } from "@/app/components/paper-pill";
import { Button } from "@/components/ui/button";

const ARTIFACT_ENTRY = "index.html";

/** DOM id the mobile ChatHeader chip is portaled into so it sits with the
 *  page header instead of between the artifact iframe and the messages. */
const CANVAS_MOBILE_CHAT_HEADER_HOST_ID = "canvas-chat-header-host";

/**
 * Extract the live HTML body for an artifact-bearing assistant message.
 * Prefers the iterated VFS body when present (the canvas writes there); falls
 * back to the original proposedArtifact.html the bubble first rendered.
 */
function extractArtifactHtml(msg: StoredMessage | null | undefined): string | null {
  if (!msg) return null;
  const vfs = msg.proposedVfs;
  if (vfs && vfs.entry) {
    const body = vfs.files?.[vfs.entry];
    if (typeof body === "string" && body.length > 0) return body;
  }
  const html = msg.proposedArtifact?.html;
  if (typeof html === "string" && html.length > 0) return html;
  return null;
}

export default function ChatArtifactCanvasPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: chatId } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const messageId = searchParams?.get("messageId") ?? null;

  const [chat, setChat] = useState<StoredChat | null>(null);
  const [sourceMsg, setSourceMsg] = useState<StoredMessage | null>(null);
  const [attachedPins, setAttachedPins] = useState<StoredPinnedNote[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  /** While the assistant streams an edit, render this body in the preview. */
  const [pendingHtml, setPendingHtml] = useState<string | null>(null);

  /**
   * Mobile-only: messages drawer collapsed by default so the canvas owns the
   * viewport. Auto-opens on send so the streaming reply is visible. Manual
   * toggles are sticky for ~1s so the next message doesn't undo a deliberate
   * collapse. Mirrors the note-canvas page.
   */
  const [messagesOpen, setMessagesOpen] = useState(false);
  const lastUserToggleRef = useRef(0);
  const prevMsgCountRef = useRef(0);
  const [isLg, setIsLg] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    setIsLg(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsLg(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Bootstrap: load chat + source message. If either is missing, bounce.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!messageId) {
          setBootstrapError("Missing messageId.");
          setHydrated(true);
          return;
        }
        const c = await getChat(chatId);
        if (cancelled) return;
        if (!c) {
          setBootstrapError("Chat not found.");
          setHydrated(true);
          return;
        }
        const m = await getMessage(messageId);
        if (cancelled) return;
        if (!m || m.chatId !== chatId) {
          setBootstrapError("Message not found.");
          setHydrated(true);
          return;
        }
        if (!extractArtifactHtml(m)) {
          setBootstrapError("This message has no artifact to edit.");
          setHydrated(true);
          return;
        }
        setChat(c);
        setSourceMsg(m);
      } catch (err) {
        if (cancelled) return;
        setBootstrapError(
          err instanceof Error ? err.message : "Failed to load canvas."
        );
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId, messageId]);

  // Hydrate attached pinned notes (mirrors /chats/[id]) so the model sees the
  // same supplementary context here as in the originating chat.
  useEffect(() => {
    const ids = chat?.attachedPinIds ?? [];
    if (ids.length === 0) {
      setAttachedPins([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const rows = await Promise.all(
        ids.map((pid) => getPinnedNote(pid).catch(() => undefined))
      );
      if (cancelled) return;
      setAttachedPins(rows.filter((r): r is StoredPinnedNote => !!r));
    })();
    return () => {
      cancelled = true;
    };
  }, [chat?.id, chat?.attachedPinIds]);

  const onChangeAttachedPins = useCallback(
    async (nextIds: string[]) => {
      if (!chat) return;
      const clearMemory =
        chat.sessionMemoryNoteId && !nextIds.includes(chat.sessionMemoryNoteId);
      const updated: StoredChat = {
        ...chat,
        attachedPinIds: nextIds.length > 0 ? nextIds : undefined,
        ...(clearMemory ? { sessionMemoryNoteId: undefined } : {}),
        updatedAt: Date.now(),
      };
      setChat(updated);
      await putChat(updated);
    },
    [chat]
  );

  const onSessionMemoryNoteId = useCallback(
    async (noteId: string | undefined) => {
      if (!chat) return;
      // Designating a memory note also attaches it in the same update —
      // buildExtraSystem only injects memory pins that are in attachedPins,
      // and the strip only renders the memory chip for attached pins.
      const attach =
        noteId && !(chat.attachedPinIds ?? []).includes(noteId)
          ? { attachedPinIds: [...(chat.attachedPinIds ?? []), noteId] }
          : {};
      const updated: StoredChat = {
        ...chat,
        ...attach,
        sessionMemoryNoteId: noteId,
        updatedAt: Date.now(),
      };
      setChat(updated);
      await putChat(updated);
    },
    [chat]
  );

  const extraSystem = useMemo(
    () => buildExtraSystem(undefined, attachedPins, chat?.sessionMemoryNoteId),
    [attachedPins, chat?.sessionMemoryNoteId]
  );

  // Latest source HTML — read once on bootstrap and re-derived after each
  // save. Streamed edits land in `pendingHtml` for live preview.
  const sourceHtml = useMemo(() => extractArtifactHtml(sourceMsg), [sourceMsg]);
  const liveHtml = pendingHtml ?? sourceHtml ?? "";

  // Single-file VFS handed to <Chat>. Same shape note-canvas uses.
  const templateFiles: ArtifactFiles | undefined = sourceHtml
    ? { [ARTIFACT_ENTRY]: sourceHtml }
    : undefined;
  const templateEntry = sourceHtml ? ARTIFACT_ENTRY : undefined;

  // Transient target — never persisted on the chat row. Tells <Chat> to route
  // sends through responseFormat: "artifact-edit" and tells wireContentFor to
  // strip prior `<artifact>` bodies from history (the bug-fix that makes the
  // model actually call Edit / MultiEdit tools instead of dumping prose).
  const target: ChatTarget | undefined = useMemo(
    () =>
      sourceMsg
        ? {
            kind: "chat-artifact-canvas",
            chatId,
            messageId: sourceMsg.id,
            mode: "edit",
          }
        : undefined,
    [chatId, sourceMsg]
  );

  // Live preview hook: receive the streaming VFS from Chat and route the
  // single file's content into pendingHtml. We deliberately do NOT clear
  // pendingHtml when Chat signals stream-end — the auto-save handler clears it
  // after the new body has landed on the source message, so the preview
  // transitions straight from streamed → saved without a flash of stale HTML.
  const handlePendingVfs = useCallback(
    (files: ArtifactFiles | null, _entry: string | null) => {
      if (!files) return;
      const next = files[ARTIFACT_ENTRY];
      if (typeof next === "string") setPendingHtml(next);
    },
    []
  );

  // Persist the assistant's final edit back onto the SOURCE message. Updates
  // proposedVfs (where new canvas turns land their authoritative state) AND
  // proposedArtifact.html (so legacy artifact-card rendering paths show the
  // new body when the user navigates back to /chats/[id]).
  const onSaveVfs = useCallback(
    async (proposed: ProposedVfs) => {
      if (!sourceMsg) return;
      const html = proposed.files?.[proposed.entry];
      if (typeof html !== "string") return;
      const fresh = await getMessage(sourceMsg.id);
      if (!fresh) return;
      const next: StoredMessage = {
        ...fresh,
        // Stamp editedAt so account-sync's chat-touch bumps chat.updatedAt
        // for this in-place edit. Without it the save lands in IDB but the
        // chat stays "clean", and the next pull reverts it on refresh.
        editedAt: Date.now(),
        proposedArtifact: fresh.proposedArtifact
          ? { ...fresh.proposedArtifact, html, streaming: false }
          : fresh.proposedArtifact,
        proposedVfs: {
          files: { [ARTIFACT_ENTRY]: html },
          entry: ARTIFACT_ENTRY,
          summary: proposed.summary ?? fresh.proposedVfs?.summary ?? "",
          ops: proposed.ops ?? [],
          build: proposed.build,
          streaming: false,
        },
      };
      await putMessage(next);
      setSourceMsg(next);
      setPendingHtml(null);
    },
    [sourceMsg]
  );

  // Resync from IDB when Chat's "Revert to here" rolls our source message
  // back. Chat has already written the restored body; we just need to pull
  // it into local state so the iframe preview snaps back without a reload.
  const onRevertInlineArtifact = useCallback(
    (sourceMessageId: string) => {
      if (!sourceMsg || sourceMessageId !== sourceMsg.id) return;
      void getMessage(sourceMessageId).then((fresh) => {
        if (!fresh) return;
        setSourceMsg(fresh);
        setPendingHtml(null);
      });
    },
    [sourceMsg]
  );

  // ---------- render ----------

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (bootstrapError || !chat || !sourceMsg || !sourceHtml) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted-foreground">
        <p>{bootstrapError ?? "Artifact not found."}</p>
        <Button size="sm" onClick={() => router.push(`/chats/${chatId}`)}>
          Back to chat
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top safe-x sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border/60 bg-background/85 px-3 py-2 backdrop-blur sm:px-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(`/chats/${chatId}`)}
          className="gap-1.5"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Back to chat</span>
        </Button>
        <PaperPill tone="neutral" className="shrink-0">
          Canvas
        </PaperPill>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {chat.title || "Artifact"}
        </h1>
        {/* Mobile chat header (model · tokens · …) is portaled here so it sits
            with the page header instead of between the artifact iframe and the
            messages. Empty on sm+ since the desktop ChatHeader renders inline. */}
        <div id={CANVAS_MOBILE_CHAT_HEADER_HOST_ID} className="basis-full sm:hidden" />
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-2 pt-2 pb-2 sm:gap-4 sm:px-4 lg:grid lg:grid-cols-[minmax(0,1fr)_440px] lg:grid-rows-[minmax(0,1fr)]">
        <PaperCard
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-initial",
            // Mobile, edit mode: the preview is redundant with the chat below
            // and only squishes both into slivers. Hide it while the messages
            // drawer is open so the chat owns the viewport; collapsing the
            // drawer ("Hide messages") brings the preview back full-height.
            !isLg && messagesOpen && "hidden"
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground">
            <span className="truncate font-mono">{ARTIFACT_ENTRY}</span>
            {pendingHtml !== null && (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <Loader2 className="h-3 w-3 animate-spin" />
                streaming
              </span>
            )}
          </div>
          <iframe
            title="Artifact preview"
            srcDoc={liveHtml}
            sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups"
            className="block min-h-0 w-full flex-1 border-0 bg-white"
          />
        </PaperCard>

        <section
          className={cn(
            "flex min-h-0 flex-col lg:flex-initial",
            // Mobile: take the whole viewport when open (preview is hidden),
            // collapse to the composer + "show messages" pill when closed.
            !isLg && (messagesOpen ? "flex-1" : "shrink-0")
          )}
        >
          <Chat
            chatId={chat.id}
            target={target}
            templateFiles={templateFiles}
            templateEntry={templateEntry}
            onPendingVfs={handlePendingVfs}
            onSaveVfs={onSaveVfs}
            onRevertInlineArtifact={onRevertInlineArtifact}
            extraSystem={extraSystem}
            attachedPins={attachedPins}
            onChangeAttachedPins={onChangeAttachedPins}
            sessionMemoryNoteId={chat.sessionMemoryNoteId}
            onSessionMemoryNoteId={onSessionMemoryNoteId}
            messagesCollapsed={!isLg && !messagesOpen}
            onToggleMessages={() => {
              setMessagesOpen((v) => !v);
              lastUserToggleRef.current = Date.now();
            }}
            dockClassName={
              isLg
                ? undefined
                : "safe-x gap-1.5 border-t border-border bg-background/95 px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur"
            }
            mobileHeaderHostId={CANVAS_MOBILE_CHAT_HEADER_HOST_ID}
            onMessagesChange={(msgs) => {
              if (
                !isLg &&
                msgs.length > prevMsgCountRef.current &&
                Date.now() - lastUserToggleRef.current > 1000
              ) {
                setMessagesOpen(true);
              }
              prevMsgCountRef.current = msgs.length;
            }}
            placeholder="Edit this artifact…"
          />
        </section>
      </div>
    </div>
  );
}
