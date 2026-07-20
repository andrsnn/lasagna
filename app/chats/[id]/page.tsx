"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArrowLeft, AudioLines, Check, CornerUpLeft, Download, GitFork, HeartHandshake, Loader2, Send, Share2 } from "lucide-react";
import {
  archiveChat,
  getApp,
  getChat,
  getDesigner,
  getPinnedNote,
  loadMessages,
  markChatViewed,
  newChatTtl,
  putChat,
  putDesigner,
  type ProposedVfs,
  type StoredApp,
  type StoredChat,
  type StoredDesigner,
  type StoredMessage,
  type StoredPinnedNote,
} from "@/app/db";
import { buildExtraSystem } from "@/app/lib/extra-system";
import { sendToAppNotes } from "@/app/lib/send-to-notes";
import { Chat } from "@/app/components/chat";
import { CardActions } from "@/app/components/card-actions";
import { Button } from "@/components/ui/button";
import { PaperPill } from "@/app/components/paper-pill";
import { PinDialog } from "@/app/components/pin-dialog";
import { ShareChatDialog } from "@/app/components/share-chat-dialog";
import { ExportChatDialog } from "@/app/components/export-chat-dialog";
import { parseManifestFromVfs } from "@/app/lib/artifact/manifest";
import { createDesignerAndChatFromHtml } from "@/app/lib/create";
import { generateChatTitle, shouldGenerateChatTitle } from "@/app/lib/chat-title";
import { syncDesignerToSourceNote } from "@/app/lib/sync-source-note";
import { forkChat } from "@/app/lib/fork-chat";
import { dbg, installGlobalHandlers } from "@/app/lib/debug-log";
import { ChatTtlChip } from "@/app/components/chat-ttl-chip";
import { confirm } from "@/app/components/confirm";
import { toast } from "@/app/components/toast";

export default function ChatDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [chat, setChat] = useState<StoredChat | null>(null);
  const [target, setTarget] = useState<{
    designer?: StoredDesigner;
    app?: StoredApp;
  }>({});
  const [hydrated, setHydrated] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [forking, setForking] = useState(false);
  const [forkSourceTitle, setForkSourceTitle] = useState<string | null>(null);
  const [pinTarget, setPinTarget] = useState<
    | { messageId: string; html?: string; summary?: string; markdown?: string }
    | null
  >(null);
  /** When chat.researchFor is set, the originating designer for the banner. */
  const [researchTarget, setResearchTarget] = useState<StoredDesigner | null>(null);
  /** Send-to-notes state for the research banner. "idle" | "sending" | "sent" | "error". */
  const [sendState, setSendState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [sendError, setSendError] = useState<string | null>(null);
  const [attachedPins, setAttachedPins] = useState<StoredPinnedNote[]>([]);

  useEffect(() => {
    installGlobalHandlers();
    dbg("chatpage.mount", { id });
    // Post-paint marker: if the trail ends without this line, the tab died
    // DURING render (the OOM crash) rather than after a clean load.
    const paintTimer = setTimeout(() => dbg("chatpage.settled"), 1500);
    let cancelled = false;
    (async () => {
      let c = await getChat(id);
      dbg("chatpage.getChat", { found: !!c });
      if (!c) {
        // The chats index "New chat" button navigates here straight away
        // (without a preceding putChat), so the row may not exist yet.
        // Lazily create a placeholder free-form chat for this id.
        const now = Date.now();
        const fresh: StoredChat = {
          id,
          title: "New chat",
          titleSource: "default",
          createdAt: now,
          updatedAt: now,
          ...newChatTtl(now),
        };
        try {
          await putChat(fresh);
          c = fresh;
        } catch (err) {
          console.error("auto-create chat failed", err);
          if (!cancelled) setHydrated(true);
          return;
        }
      }
      let designer: StoredDesigner | undefined;
      let app: StoredApp | undefined;
      // Note-canvas chats live behind /notes/[noteId]/canvas — the generic
      // chat viewer has no preview pane and no save-back-to-note plumbing,
      // so a user who lands here through an old link gets bounced over.
      if (c.target?.kind === "note-canvas") {
        if (!cancelled) {
          router.replace(`/notes/${c.target.noteId}/canvas?chat=${c.id}`);
        }
        return;
      }
      if (c.target?.kind === "designer") {
        designer = await getDesigner(c.target.id);
      } else if (c.target?.kind === "app") {
        // 1:1 invariant: app and designer share the same id.
        app = await getApp(c.target.id);
        if (app) designer = await getDesigner(app.id);
      }
      if (cancelled) return;
      dbg("chatpage.hydrated", {
        chatId: c.id,
        title: c.title,
        target: c.target?.kind,
        shared: !!c.accountShared,
      });
      setChat(c);
      setTarget({ designer, app });
      setHydrated(true);
      if (c.forkedFromChatId) {
        const source = await getChat(c.forkedFromChatId);
        if (cancelled) return;
        setForkSourceTitle(source?.title ?? null);
      } else {
        setForkSourceTitle(null);
      }
      if (c.researchFor) {
        const rd = await getDesigner(c.researchFor);
        if (cancelled) return;
        setResearchTarget(rd ?? null);
      } else {
        setResearchTarget(null);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(paintTimer);
    };
  }, [id]);

  // Stamp the chat as "seen" so it stops showing the Ready badge on the
  // chats list. We stamp on entry AND on every exit/visibility-hide so a
  // stream that finishes while the user is still here doesn't immediately
  // light up "unread" the moment they navigate back.
  useEffect(() => {
    void markChatViewed(id);
    const stamp = () => void markChatViewed(id);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stamp();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", stamp);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", stamp);
      stamp();
    };
  }, [id]);

  // Hydrate attached pinned notes whenever the chat's pin list changes.
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

  // For a target=designer or target=app chat we already inject designer.notes;
  // here we also weave in any attached pin contents. For free-form/research
  // chats designer.notes isn't applicable, but attached pins still are.
  const extraSystem = useMemo(
    () => buildExtraSystem(target.designer?.notes, attachedPins, chat?.sessionMemoryNoteId),
    [target.designer?.notes, attachedPins, chat?.sessionMemoryNoteId]
  );

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

  /**
   * Pre-targeted Send-to-notes for the research banner. The target is fixed
   * to `chat.researchFor`, so no picker — one click distills the whole chat
   * into that designer's notes and navigates back. The background notes
   * refresh lives inside sendToAppNotes; this handler only manages the
   * banner's three-state UI (idle / sending / sent | error).
   */
  const onSendResearchToNotes = useCallback(async () => {
    if (!chat || !researchTarget || sendState === "sending") return;
    setSendState("sending");
    setSendError(null);
    try {
      const messages = await loadMessages(chat.id);
      if (messages.length === 0) {
        setSendState("error");
        setSendError("Nothing in this chat yet.");
        return;
      }
      const result = await sendToAppNotes(researchTarget.id, {
        kind: "chat",
        messages: messages
          .filter((m) => !m.summarizedInto && !m.error && m.content?.trim())
          .map((m) => ({ role: m.role, content: m.content })),
      });
      if (!result.ok) {
        setSendState("error");
        setSendError(result.error);
        return;
      }
      setSendState("sent");
      // Brief success flash, then bounce back to the designer.
      setTimeout(() => {
        router.push(`/designer/${researchTarget.id}`);
      }, 700);
    } catch (err) {
      setSendState("error");
      setSendError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [chat, researchTarget, sendState, router]);

  const onSaveHtml = useCallback(
    async (html: string, summary: string) => {
      if (!target.designer) return;
      const nextFiles = { ...target.designer.files, "index.html": html };
      const nextEntry = "index.html";
      const parsed = parseManifestFromVfs(nextFiles, nextEntry);
      const next: StoredDesigner = {
        ...target.designer,
        files: nextFiles,
        entry: nextEntry,
        lastBuild: undefined,
        manifest: parsed.manifest,
        name: parsed.manifest?.name ?? target.designer.name,
        description: parsed.manifest?.description ?? summary.slice(0, 200),
        version: target.designer.version + 1,
        history: [
          ...(target.designer.history ?? []),
          {
            version: target.designer.version,
            files: target.designer.files,
            entry: target.designer.entry,
            savedAt: target.designer.updatedAt,
          },
        ],
        updatedAt: Date.now(),
      };
      await putDesigner(next);
      setTarget((t) => ({ ...t, designer: next }));
      void syncDesignerToSourceNote(next);
    },
    [target.designer]
  );

  const onSaveVfs = useCallback(
    async (proposed: ProposedVfs) => {
      if (!target.designer) return;
      const parsed = parseManifestFromVfs(proposed.files, proposed.entry);
      const next: StoredDesigner = {
        ...target.designer,
        files: proposed.files,
        entry: proposed.entry,
        lastBuild: undefined,
        manifest: parsed.manifest,
        name: parsed.manifest?.name ?? target.designer.name,
        description: parsed.manifest?.description ?? proposed.summary.slice(0, 200),
        version: target.designer.version + 1,
        history: [
          ...(target.designer.history ?? []),
          {
            version: target.designer.version,
            files: target.designer.files,
            entry: target.designer.entry,
            savedAt: target.designer.updatedAt,
          },
        ],
        updatedAt: Date.now(),
      };
      await putDesigner(next);
      setTarget((t) => ({ ...t, designer: next }));
      void syncDesignerToSourceNote(next);
    },
    [target.designer]
  );

  // Free-form chat only: promote an inline HTML artifact into a fresh
  // designer + paired app and route the user there to keep iterating with the
  // full vfs-edit toolchain. The current chat is left untouched; the inline
  // artifact card swaps to a "Saved as designer · open" link.
  const onConvertArtifact = useCallback(
    async (html: string, summary: string) => {
      const { designer } = await createDesignerAndChatFromHtml(html, summary);
      router.push(`/designer/${designer.id}`);
      return { designerId: designer.id };
    },
    [router]
  );

  // App state is intentionally untouched here — revert is forward-only on
  // designer code; app.state survives every revert.
  const onRevertToVersion = useCallback(
    async (version: number) => {
      const d = target.designer;
      if (!d) return;
      if (version === d.version) return;
      const snapshot = (d.history ?? []).find((h) => h.version === version);
      if (!snapshot) return;
      const parsed = parseManifestFromVfs(snapshot.files, snapshot.entry);
      const next: StoredDesigner = {
        ...d,
        files: snapshot.files,
        entry: snapshot.entry,
        lastBuild: undefined,
        lastWidgetBuild: undefined,
        manifest: parsed.manifest,
        name: parsed.manifest?.name ?? d.name,
        description: parsed.manifest?.description ?? d.description,
        version: d.version + 1,
        history: [
          ...(d.history ?? []),
          {
            version: d.version,
            files: d.files,
            entry: d.entry,
            savedAt: d.updatedAt,
          },
        ],
        updatedAt: Date.now(),
      };
      await putDesigner(next);
      setTarget((prev) => ({ ...prev, designer: next }));
      void syncDesignerToSourceNote(next);
    },
    [target.designer]
  );

  const renameTitle = useCallback(
    async (title: string) => {
      if (!chat) return;
      const next: StoredChat = {
        ...chat,
        title,
        titleSource: "user",
        titleUpdatedAt: Date.now(),
        updatedAt: Date.now(),
      };
      await putChat(next);
      setChat(next);
    },
    [chat]
  );

  // Auto-title: when the first complete assistant reply lands and the chat is
  // still using a placeholder, ask Gemma for a 3-6 word topic summary.
  const [chatMessages, setChatMessages] = useState<StoredMessage[]>([]);
  const titleAttemptedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chat) return;
    if (!shouldGenerateChatTitle(chat)) return;
    if (titleAttemptedRef.current === chat.id) return;
    const hasFinishedAssistant = chatMessages.some(
      (m) => m.role === "assistant" && !m.streamId && m.kind !== "summary" && m.content?.trim()
    );
    const hasUser = chatMessages.some((m) => m.role === "user" && m.content?.trim());
    if (!hasFinishedAssistant || !hasUser) return;
    titleAttemptedRef.current = chat.id;
    void generateChatTitle(chat, chatMessages, target).then((title) => {
      if (!title) return;
      setChat((c) =>
        c && c.id === chat.id
          ? { ...c, title, titleSource: "gemma", titleUpdatedAt: Date.now() }
          : c
      );
    });
  }, [chat, chatMessages, target]);

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (!chat) {
    return (
      <div className="safe-top flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-muted-foreground">Chat not found.</p>
        <Button variant="outline" onClick={() => router.push("/chats")}>
          Back to chats
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top sticky top-0 z-10 flex items-center gap-2 border-b border-border/60 bg-background/85 px-2 pt-2 pb-2 backdrop-blur sm:gap-3 sm:px-3">
        <Button
          size="icon-touch"
          variant="ghost"
          onClick={() => router.push("/chats")}
          aria-label="Back"
          className="tap shrink-0"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <input
            value={chat.title}
            onChange={(e) =>
              setChat((c) => (c ? { ...c, title: e.target.value } : c))
            }
            onBlur={(e) => void renameTitle(e.target.value.trim() || "Untitled chat")}
            className="reader-serif w-full truncate bg-transparent text-base outline-none sm:text-lg"
          />
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {chat.target?.kind === "designer" && target.designer && (
              <PaperPill tone="neutral">Designer · {target.designer.name}</PaperPill>
            )}
            {chat.target?.kind === "app" && target.app && (
              <PaperPill tone="neutral">App · {target.app.name}</PaperPill>
            )}
            {!chat.target && (
              <span className="text-muted-foreground">Free-form chat</span>
            )}
            <ChatTtlChip
              chat={chat}
              onChange={async (patch) => {
                if (!chat) return;
                const next: StoredChat = { ...chat, ...patch };
                setChat(next);
                try {
                  await putChat(next);
                } catch (err) {
                  console.error("update chat ttl failed", err);
                }
              }}
            />
          </div>
        </div>
        <CardActions
          primaryKeys={["voice", "therapist", "share"]}
          actions={[
            {
              key: "voice",
              label: "Voice mode",
              icon: AudioLines,
              href: `/chats/${chat.id}/voice`,
            },
            {
              key: "therapist",
              label: "Therapist mode",
              icon: HeartHandshake,
              href: `/chats/${chat.id}/therapist`,
            },
            {
              key: "share",
              label: "Share",
              icon: Share2,
              onSelect: () => setShareOpen(true),
            },
            {
              key: "export",
              label: "Export",
              icon: Download,
              onSelect: () => setExportOpen(true),
            },
            {
              key: "fork",
              label: forking ? "Forking…" : "Fork chat",
              icon: forking ? <Loader2 className="h-4 w-4 animate-spin" /> : GitFork,
              disabled: forking,
              onSelect: async () => {
                if (!chat || forking) return;
                setForking(true);
                try {
                  const { id: forkedId } = await forkChat(chat.id);
                  router.push(`/chats/${forkedId}`);
                } catch (err) {
                  console.error("fork chat failed", err);
                  toast.error(
                    err instanceof Error ? err.message : "Failed to fork chat."
                  );
                  setForking(false);
                }
              },
            },
            {
              key: "archive",
              label: "Move to trash",
              icon: Archive,
              destructive: true,
              onSelect: async () => {
                if (!chat) return;
                const ok = await confirm({
                  title: "Move to trash?",
                  body: `"${chat.title}" will be permanently deleted in 7 days. You can restore it from Trash before then.`,
                  confirmLabel: "Move to trash",
                  destructive: true,
                });
                if (!ok) return;
                try {
                  await archiveChat(chat.id);
                } catch (err) {
                  console.error("archive chat failed", err);
                  toast.error("Couldn't move the chat to trash. Please try again.");
                  return;
                }
                toast.success("Moved to trash");
                router.push("/chats");
              },
            },
          ]}
        />
      </header>

      {chat.researchFor && researchTarget && (
        <div className="flex w-full flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs">
          <button
            type="button"
            onClick={() => router.push(`/designer/${researchTarget.id}`)}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            title="Back to designer"
          >
            <CornerUpLeft className="h-3.5 w-3.5" />
            <span>Back</span>
          </button>
          <span className="text-muted-foreground">
            Researching for{" "}
            <span className="font-medium text-foreground">{researchTarget.name}</span>
          </span>
          <div className="ml-auto flex items-center gap-2">
            {sendState === "error" && sendError && (
              <span className="text-[11px] text-destructive">{sendError}</span>
            )}
            <Button
              size="sm"
              variant={sendState === "sent" ? "outline" : "default"}
              onClick={() => void onSendResearchToNotes()}
              disabled={sendState === "sending" || sendState === "sent"}
              className="gap-1.5"
              title="Distill this chat into the designer's notes file and return."
            >
              {sendState === "sending" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : sendState === "sent" ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              <span>
                {sendState === "sending"
                  ? "Sending…"
                  : sendState === "sent"
                    ? "Sent — returning"
                    : "Send to notes"}
              </span>
            </Button>
          </div>
        </div>
      )}

      {chat.parentChatId && (
        <button
          type="button"
          onClick={() => router.push(`/chats/${chat.parentChatId}`)}
          className="flex w-full items-center gap-2 border-b border-border/60 px-3 py-1.5 text-left text-xs text-muted-foreground transition hover:text-foreground"
        >
          <CornerUpLeft className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            Researching:&nbsp;
            <span className="italic text-foreground">
              {(chat.parentSelection?.text ?? "").slice(0, 120)}
              {(chat.parentSelection?.text ?? "").length > 120 ? "…" : ""}
            </span>
          </span>
        </button>
      )}

      {chat.forkedFromChatId && (
        forkSourceTitle ? (
          <button
            type="button"
            onClick={() => router.push(`/chats/${chat.forkedFromChatId}`)}
            className="flex w-full items-center gap-2 border-b border-border/60 px-3 py-1.5 text-left text-xs text-muted-foreground transition hover:text-foreground"
          >
            <GitFork className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              Forked from:&nbsp;
              <span className="italic text-foreground">{forkSourceTitle}</span>
            </span>
          </button>
        ) : (
          <div className="flex w-full items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
            <GitFork className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Forked from a chat that is no longer available.</span>
          </div>
        )
      )}

      <ShareChatDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        onSyncChange={async () => {
          const c = await getChat(id);
          if (c) setChat(c);
        }}
        chat={chat}
        targetName={target.designer?.name ?? target.app?.name}
      />

      <ExportChatDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        chat={chat}
      />

      <PinDialog
        open={!!pinTarget}
        onClose={() => setPinTarget(null)}
        artifactHtml={pinTarget?.html}
        messageMarkdown={pinTarget?.markdown}
        chatId={chat.id}
        chatTitle={chat.title}
        messageId={pinTarget?.messageId}
        summary={pinTarget?.summary}
        loadMessagesForSnapshot={() => loadMessages(chat.id)}
        sourcePinId={chat.sourcePinId}
      />

      <div className="mx-auto flex w-full max-w-5xl min-h-0 flex-1 flex-col px-3 pt-2 sm:px-4">
        <Chat
          // Remount on chat change. App Router soft navigations between
          // /chats/A and /chats/B (back/forward history jumps, fork's
          // router.push) reuse this page component, and an unkeyed <Chat>
          // would carry chat A's messages state, live SSE consumer, and
          // in-flight streamId into chat B — the send/queue path would then
          // route B's input into A's stream and persist A's turns under B.
          key={chat.id}
          chatId={chat.id}
          target={chat.target}
          onSaveHtml={chat.target?.kind === "designer" ? onSaveHtml : undefined}
          onConvertArtifact={!chat.target ? onConvertArtifact : undefined}
          onPinArtifact={({ messageId, html, summary }) =>
            setPinTarget({ messageId, html, summary })
          }
          onPinMessage={({ messageId, markdown }) =>
            setPinTarget({ messageId, markdown })
          }
          onSaveVfs={chat.target?.kind === "designer" ? onSaveVfs : undefined}
          templateFiles={chat.target?.kind === "designer" ? target.designer?.files : undefined}
          templateEntry={chat.target?.kind === "designer" ? target.designer?.entry : undefined}
          templateVersion={chat.target?.kind === "designer" ? target.designer?.version : undefined}
          onRevertToVersion={chat.target?.kind === "designer" ? onRevertToVersion : undefined}
          extraSystem={extraSystem}
          attachedPins={attachedPins}
          onChangeAttachedPins={onChangeAttachedPins}
          sessionMemoryNoteId={chat.sessionMemoryNoteId}
          onSessionMemoryNoteId={onSessionMemoryNoteId}
          onMessagesChange={setChatMessages}
          className="flex-1 min-h-0"
        />
      </div>
    </div>
  );
}
