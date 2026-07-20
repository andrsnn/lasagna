"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Bookmark, Check, ChevronDown, Copy, DatabaseZap, ExternalLink, Eye, EyeOff, FileCode, History, Layers, Loader2, MessageSquare, Monitor, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ensureAppForDesigner,
  getApp,
  getDesigner,
  getPinnedNote,
  loadMessages,
  newId,
  putApp,
  putChat,
  putDesigner,
  listChatsForDesigner,
  WIDGET_PRESETS,
  type ArtifactFiles,
  type ChatTarget,
  type DesignerCommit,
  type ProposedVfs,
  type StoredApp,
  type StoredChat,
  type StoredDesigner,
  type StoredMessage,
  type StoredPinnedNote,
  type WidgetSize,
  type WidgetSizePreset,
} from "@/app/db";
import { ensureDesignerHistoryCommit, subscribeAccountSyncPull } from "@/app/lib/account-sync";
import { detectWidgetEntry, parseManifestFromVfs } from "@/app/lib/artifact/manifest";
import { DECLARED_DATA_UPGRADE_PROMPT } from "@/app/lib/artifact/upgrade-prompt";
import { vfsHash } from "@/app/lib/artifact/vfs";
import { generateChatTitle, shouldGenerateChatTitle } from "@/app/lib/chat-title";
import { BEST_FOR } from "@/app/models";
import { buildExtraSystem } from "@/app/lib/extra-system";
import { syncDesignerToSourceNote } from "@/app/lib/sync-source-note";
import { relativeTime } from "@/app/lib/visuals";
import { Chat } from "@/app/components/chat";
import { ArtifactFrame } from "@/app/components/artifact-frame";
import { DetailsPanel, type DetailsTab } from "@/app/components/details-panel";
import { FileEditor } from "@/app/components/file-editor";
import { LinkedNoteBanner } from "@/app/components/linked-note-banner";
import { PaperCard } from "@/app/components/paper-card";
import { PaperPill } from "@/app/components/paper-pill";
import { PinDialog } from "@/app/components/pin-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The commit message describing the current head version's files. Prefer the
 * stored `headCommitMessage`; for legacy rows saved before that field existed,
 * recover it from history — the old save path wrote the head's producing
 * summary onto the commit one version below it, so that entry holds the head's
 * true description. Used when demoting the head into history so each commit's
 * number, files, and message stay aligned.
 */
function headCommitMessageOf(designer: StoredDesigner): string | undefined {
  if (designer.headCommitMessage != null) return designer.headCommitMessage;
  return (designer.history ?? []).find((h) => h.version === designer.version - 1)
    ?.commitMessage;
}

function makeChatTitle(designerName: string): string {
  const stamp = new Date().toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Edit · ${designerName} · ${stamp}`;
}

export default function DesignerDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [designer, setDesigner] = useState<StoredDesigner | null>(null);
  const [app, setApp] = useState<StoredApp | null>(null);
  const [chats, setChats] = useState<StoredChat[]>([]);
  const [chat, setChat] = useState<StoredChat | null>(null);
  const [sourceNote, setSourceNote] = useState<StoredPinnedNote | null>(null);
  /**
   * Hydrated pinned-note rows for the active chat's `attachedPinIds`. Drives
   * the chip strip in <Chat> and feeds buildExtraSystem so the model sees
   * the pin contents as supplementary research. Refreshed whenever the
   * active chat changes or its pin list changes.
   */
  const [attachedPins, setAttachedPins] = useState<StoredPinnedNote[]>([]);
  /**
   * Non-blocking status for the background `/api/notes` refresh kicked off
   * by onNewChat. "idle" by default; "running" while the LLM call is in
   * flight (shows a chip in the header); "failed" surfaces a Retry chip.
   */
  const [notesStatus, setNotesStatus] = useState<"idle" | "running" | "failed">("idle");
  /**
   * Snapshot of the inputs to the last failed refresh so a Retry chip can
   * re-run against the *original* chat history, not the new chat's empty
   * one. Null whenever notesStatus !== "failed".
   */
  const lastFailedRefreshRef = useRef<{ priorChatId: string; designer: StoredDesigner } | null>(null);
  const [hydrated, setHydrated] = useState(false);
  /**
   * Set when reload() fails (e.g. IndexedDB `openDB()` rejects because another
   * open tab still holds the DB at a prior version). Without this the page sat
   * on its loading spinner forever — the rejection was swallowed by the
   * `void reload()` caller and `hydrated` never flipped. Surface it instead so
   * the user gets the actionable message and a Retry rather than a dead screen.
   */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  /** Guard against double-firing the new-chat handler. */
  const newChatBusyRef = useRef(false);
  /**
   * Cleared on unmount so the background notes-refresh callbacks bail out
   * without calling setDesigner on an unmounted tree.
   */
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  /** Live preview state: a streaming VFS the chat pushes while the model edits. */
  const [pendingFiles, setPendingFiles] = useState<ArtifactFiles | null>(null);
  const [pendingEntry, setPendingEntry] = useState<string | null>(null);
  /** Currently-selected file in the file tree (read-only viewer). */
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  /** Runtime error captured from the preview iframe; forwarded to Chat for auto-fix. */
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  /** Mobile-only: which panel is visible. Desktop shows all three at once. */
  const [mobileTab, setMobileTab] = useState<"chat" | "preview" | "details">("chat");
  /** Preview pane sub-mode: render the full app or the widget. */
  const [previewMode, setPreviewMode] = useState<"app" | "widget">("app");
  /** One-shot prefill for the chat input from ?prefill= (e.g. "+ Widget" CTA on /apps/[id]). */
  const searchParams = useSearchParams();
  /** ?upgrade=1 (the app page's Update banner / Settings "Update app" row):
   *  auto-send the declared-data migration prompt in this chat, on a model the
   *  platform trusts for agentic edits - the user never has to know either
   *  detail exists. */
  const upgradeRequested = searchParams?.get("upgrade") === "1";
  const [prefillMessage, setPrefillMessage] = useState<string | null>(() => {
    if (upgradeRequested) return DECLARED_DATA_UPGRADE_PROMPT;
    const v = searchParams?.get("prefill");
    return v ? v : null;
  });
  // From the "describe an app" launcher: send the prefilled description right
  // away so the assistant starts building, instead of parking it in the box.
  // Also set by the header's one-time "Update" action, which drops the
  // declared-data migration prompt straight into this chat.
  const [autoSendPrefill, setAutoSendPrefill] = useState<boolean>(
    () => searchParams?.get("autosend") === "1" || upgradeRequested
  );
  /** Model override applied when the prefill is consumed. The update run must
   *  not depend on whatever model the user last chatted with - some narrate
   *  instead of editing. */
  const [prefillModel, setPrefillModel] = useState<string | null>(() =>
    upgradeRequested ? BEST_FOR.agentic : null
  );
  /** Sub-tab inside the Details panel — Activity (formerly inline tool events) or Files. */
  const [detailsTab, setDetailsTab] = useState<DetailsTab>("files");
  const [pinTarget, setPinTarget] = useState<
    | { messageId: string; html?: string; summary?: string; markdown?: string }
    | null
  >(null);
  /** When the user taps "View details" on a chat message, scroll the matching turn into view. */
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const [fileCopied, setFileCopied] = useState(false);
  const [fileEditorOpen, setFileEditorOpen] = useState(false);
  /** Mirrored from <Chat>; powers the Activity feed without a second IDB subscription. */
  const [messagesForActivity, setMessagesForActivity] = useState<StoredMessage[]>([]);

  // Auto-title for designer-edit chats: replace the placeholder
  // "Edit · …" title with a Gemma summary once the first assistant turn lands.
  const titleAttemptedChatRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chat) return;
    if (!shouldGenerateChatTitle(chat)) return;
    if (titleAttemptedChatRef.current === chat.id) return;
    const hasFinishedAssistant = messagesForActivity.some(
      (m) => m.role === "assistant" && !m.streamId && m.kind !== "summary" && m.content?.trim()
    );
    const hasUser = messagesForActivity.some((m) => m.role === "user" && m.content?.trim());
    if (!hasFinishedAssistant || !hasUser) return;
    titleAttemptedChatRef.current = chat.id;
    const target = { designer: designer ?? undefined, app: app ?? undefined };
    void generateChatTitle(chat, messagesForActivity, target).then((title) => {
      if (!title) return;
      setChat((c) =>
        c && c.id === chat.id
          ? { ...c, title, titleSource: "gemma", titleUpdatedAt: Date.now() }
          : c
      );
      setChats((prev) =>
        prev.map((c) =>
          c.id === chat.id
            ? { ...c, title, titleSource: "gemma", titleUpdatedAt: Date.now() }
            : c
        )
      );
    });
  }, [chat, messagesForActivity, designer, app]);

  const handleOpenDetails = useCallback((messageId: string) => {
    setDetailsTab("activity");
    setHighlightMessageId(messageId);
    setMobileTab("details");
  }, []);

  // Clear the highlight after the scroll has had time to land so a re-tap on
  // the same chip re-triggers scrollIntoView.
  useEffect(() => {
    if (!highlightMessageId) return;
    const t = setTimeout(() => setHighlightMessageId(null), 1200);
    return () => clearTimeout(t);
  }, [highlightMessageId]);

  // Hydrate attached pinned notes whenever the active chat or its pin list
  // changes. Each pin id maps to one fetch; missing pins (deleted) are
  // silently dropped from the chip strip and the system-prompt block.
  useEffect(() => {
    const ids = chat?.attachedPinIds ?? [];
    if (ids.length === 0) {
      setAttachedPins([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const rows = await Promise.all(ids.map((id) => getPinnedNote(id).catch(() => undefined)));
      if (cancelled) return;
      setAttachedPins(rows.filter((r): r is StoredPinnedNote => !!r));
    })();
    return () => {
      cancelled = true;
    };
  }, [chat?.id, chat?.attachedPinIds]);

  const extraSystem = useMemo(
    () => buildExtraSystem(designer?.notes, attachedPins),
    [designer?.notes, attachedPins]
  );

  const reload = useCallback(async () => {
    try {
      const d = await getDesigner(id);
      if (!d) {
        setHydrated(true);
        return;
      }
      setDesigner(d);

      // Multi-chat: list every edit-mode chat for this designer, newest first.
      // Default to resuming the most recent chat. If none exist, create one.
      const designerChats = await listChatsForDesigner(id);
      let activeChat = designerChats[0];
      if (!activeChat) {
        const target: ChatTarget = { kind: "designer", id, mode: "edit" };
        activeChat = {
          id: newId(),
          title: makeChatTitle(d.name),
          titleSource: "default",
          target,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await putChat(activeChat);
        designerChats.unshift(activeChat);
      }
      setChats(designerChats);
      setChat((prev) => {
        // Preserve user's selected chat across reload() calls (e.g. after save)
        // when that chat is still in the list. Otherwise default to newest.
        if (prev && designerChats.some((c) => c.id === prev.id)) return prev;
        return activeChat;
      });

      // 1:1 invariant: ensure the paired app exists, then use the REAL app row
      // for the preview. State writes from the preview are real, persistent
      // writes — there is no separate "preview state" anymore.
      const a = await ensureAppForDesigner(d.id, d.name);
      setApp(a);

      // Surface the "this editor saves back to a pinned note" link when the
      // designer was promoted from /notes. Matches the banner on /apps/[id].
      if (d.sourceNoteId) {
        const note = await getPinnedNote(d.sourceNoteId).catch(() => undefined);
        setSourceNote(note ?? null);
      } else {
        setSourceNote(null);
      }

      setLoadError(null);
    } catch (err) {
      // A rejected DB op (commonly openDB() blocked by another open tab that
      // still holds the prior schema version - e.g. a tab running a generation
      // task) must not leave the page spinning forever. Record the message and
      // fall through to hydrated so the error UI with a Retry renders.
      setLoadError(err instanceof Error ? err.message : "Failed to load this app.");
    } finally {
      setHydrated(true);
    }
  }, [id]);

  useEffect(() => {
    void reload();
    const unsubscribe = subscribeAccountSyncPull((ev) => {
      if (ev.designers.includes(id) || ev.apps.includes(id)) {
        void reload();
      }
    });
    return unsubscribe;
  }, [reload, id]);

  // Refresh the app row from disk (e.g. after the iframe writes state) so the
  // preview re-renders with the latest persisted state without a full reload.
  const refreshApp = useCallback(async () => {
    const a = await getApp(id);
    if (a) setApp(a);
  }, [id]);

  // Legacy single-file save path: the assistant produced one HTML document via
  // the <artifact> sentinel-tag flow.
  const onSaveHtml = useCallback(
    async (html: string, summary: string) => {
      if (!designer) return;
      const nextFiles = { ...designer.files, "index.html": html };
      const nextEntry = "index.html";
      const parsed = parseManifestFromVfs(nextFiles, nextEntry);
      const priorCommit: DesignerCommit = {
        version: designer.version,
        files: designer.files,
        entry: designer.entry,
        savedAt: designer.updatedAt,
        commitMessage: headCommitMessageOf(designer),
        hash: vfsHash(designer.files, designer.entry),
      };
      const next: StoredDesigner = {
        ...designer,
        files: nextFiles,
        entry: nextEntry,
        lastBuild: undefined,
        lastWidgetBuild: undefined,
        manifest: parsed.manifest,
        name: parsed.manifest?.name ?? designer.name,
        description: parsed.manifest?.description ?? summary.slice(0, 200),
        version: designer.version + 1,
        history: [...(designer.history ?? []), priorCommit],
        headCommitMessage: summary.slice(0, 240),
        updatedAt: Date.now(),
      };
      await putDesigner(next);
      setDesigner(next);
      setReloadKey((k) => k + 1);
      void syncDesignerToSourceNote(next);
    },
    [designer]
  );

  // New multi-file save path: the assistant produced a VFS via tool calls.
  const onSaveVfs = useCallback(
    async (proposed: ProposedVfs) => {
      if (!designer) return;
      const parsed = parseManifestFromVfs(proposed.files, proposed.entry);
      const priorCommit: DesignerCommit = {
        version: designer.version,
        files: designer.files,
        entry: designer.entry,
        savedAt: designer.updatedAt,
        commitMessage: headCommitMessageOf(designer),
        hash: vfsHash(designer.files, designer.entry),
      };
      const next: StoredDesigner = {
        ...designer,
        files: proposed.files,
        entry: proposed.entry,
        lastBuild: undefined,
        lastWidgetBuild: undefined,
        manifest: parsed.manifest,
        name: parsed.manifest?.name ?? designer.name,
        description: parsed.manifest?.description ?? proposed.summary.slice(0, 200),
        version: designer.version + 1,
        history: [...(designer.history ?? []), priorCommit],
        headCommitMessage: proposed.summary.slice(0, 240),
        updatedAt: Date.now(),
      };
      await putDesigner(next);
      setDesigner(next);
      setReloadKey((k) => k + 1);
      void syncDesignerToSourceNote(next);
      setPendingFiles(null);
      setPendingEntry(null);
      // App state is intentionally untouched — designer code edits never
      // mutate app.state. The new code reads from the existing state.
    },
    [designer]
  );

  const handlePendingVfs = useCallback((files: ArtifactFiles | null, entry: string | null) => {
    setPendingFiles(files);
    setPendingEntry(entry);
  }, []);

  const onRevertToVersion = useCallback(
    async (version: number, restoreState?: boolean) => {
      if (!designer) return;
      if (version === designer.version) return;
      // Account-synced devices receive the designer row without inline history
      // (it streams in lazily and can lag or fail), so the commit for this
      // bookmark may not be in the local copy yet. Fetch it on demand before
      // giving up — otherwise Restore is a silent no-op.
      let history = designer.history ?? [];
      let snapshot = history.find((h) => h.version === version);
      if (!snapshot) {
        const fetched = await ensureDesignerHistoryCommit(designer.id, version);
        if (fetched) {
          snapshot = fetched;
          // Fold the fetched commit into our working history so the
          // putDesigner(next) below doesn't clobber what we just persisted.
          if (!history.some((h) => h.version === fetched.version)) {
            history = [...history, fetched].sort((a, b) => a.version - b.version);
          }
        }
      }
      if (!snapshot) {
        throw new Error(
          `Couldn't restore v${version} — its snapshot isn't available on this device yet. If you just signed in, give history a moment to sync and try again.`
        );
      }
      const parsed = parseManifestFromVfs(snapshot.files, snapshot.entry);
      const priorCommit: DesignerCommit = {
        version: designer.version,
        files: designer.files,
        entry: designer.entry,
        savedAt: designer.updatedAt,
        commitMessage: headCommitMessageOf(designer),
        hash: vfsHash(designer.files, designer.entry),
      };

      const snapshots = { ...(designer.stateSnapshots ?? {}) };
      if (app?.state && Object.keys(app.state).length > 0) {
        snapshots[String(designer.version)] = { ...app.state };
      }

      const next: StoredDesigner = {
        ...designer,
        files: snapshot.files,
        entry: snapshot.entry,
        lastBuild: undefined,
        lastWidgetBuild: undefined,
        manifest: parsed.manifest,
        name: parsed.manifest?.name ?? designer.name,
        description: parsed.manifest?.description ?? designer.description,
        version: designer.version + 1,
        history: [...history, priorCommit],
        headCommitMessage: `Restored v${version}`,
        stateSnapshots: snapshots,
        updatedAt: Date.now(),
      };
      await putDesigner(next);
      setDesigner(next);

      if (restoreState && app) {
        const stateSnap = (designer.stateSnapshots ?? {})[String(version)];
        if (stateSnap) {
          const restoredApp: StoredApp = { ...app, state: { ...stateSnap }, updatedAt: Date.now() };
          await putApp(restoredApp);
          setApp(restoredApp);
        }
      }

      setReloadKey((k) => k + 1);
      void syncDesignerToSourceNote(next);
      setPendingFiles(null);
      setPendingEntry(null);
    },
    [designer, app]
  );

  const onSetCheckpointLabel = useCallback(
    async (version: number, label: string | null) => {
      if (!designer) return;
      const labels = { ...(designer.checkpointLabels ?? {}) };
      const snapshots = { ...(designer.stateSnapshots ?? {}) };
      if (label) {
        labels[String(version)] = label;
        if (app?.state && Object.keys(app.state).length > 0) {
          snapshots[String(version)] = { ...app.state };
        }
      } else {
        delete labels[String(version)];
        delete snapshots[String(version)];
      }
      const next: StoredDesigner = { ...designer, checkpointLabels: labels, stateSnapshots: snapshots, updatedAt: Date.now() };
      await putDesigner(next);
      setDesigner(next);
    },
    [designer, app]
  );

  const handleLog = useCallback((level: "log" | "warn" | "error", args: unknown[]) => {
    if (level === "error") {
      const text = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join("\n");
      setRuntimeError(text);
    }
  }, []);

  const handleStateChange = useCallback(() => {
    // The iframe just wrote state. Refresh our local app row so the next
    // remount picks up the persisted value (debounced inside artifact-frame).
    void refreshApp();
  }, [refreshApp]);

  const onSelectChat = useCallback(
    (chatId: string) => {
      const next = chats.find((c) => c.id === chatId);
      if (next) setChat(next);
    },
    [chats]
  );

  /**
   * Background notes refresh — called fire-and-forget by onNewChat. Runs the
   * `/api/notes` LLM call against the just-finished chat + recent commits,
   * persists the merged notes onto the designer, and only updates React state
   * if the page is still mounted *and* the designer hasn't changed underneath
   * us. The IDB write always lands so a remount picks up fresh notes.
   */
  const refreshNotesInBackground = useCallback(
    async (priorChatId: string, designerSnapshot: StoredDesigner) => {
      setNotesStatus("running");
      lastFailedRefreshRef.current = null;
      try {
        const prior = await loadMessages(priorChatId);
        // Empty chats have nothing to distill — drop straight back to idle.
        if (prior.length === 0) {
          if (isMountedRef.current) setNotesStatus("idle");
          return;
        }
        const chatMessages = prior
          .filter((m) => !m.summarizedInto && !m.error)
          .map((m) => ({ role: m.role, content: m.content }));
        const recentCommits = (designerSnapshot.history ?? [])
          .slice(-5)
          .reverse()
          .map((h) => ({
            version: h.version,
            commitMessage: h.commitMessage,
            savedAt: h.savedAt,
          }));
        const res = await fetch("/api/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            designerName: designerSnapshot.name,
            designerDescription: designerSnapshot.description,
            currentNotes: designerSnapshot.notes,
            recentCommits,
            chatMessages,
          }),
        });
        if (!res.ok) throw new Error(`notes endpoint ${res.status}`);
        const { notes } = (await res.json()) as { notes?: string };
        if (!notes || !notes.trim()) {
          if (isMountedRef.current) setNotesStatus("idle");
          return;
        }
        // Re-read in case the editor saved a new commit during the round-trip
        // — preserve everything except notes/notesUpdatedAt.
        const fresh = (await getDesigner(designerSnapshot.id)) ?? designerSnapshot;
        const withNotes: StoredDesigner = {
          ...fresh,
          notes: notes.trim(),
          notesUpdatedAt: Date.now(),
          updatedAt: Date.now(),
        };
        await putDesigner(withNotes);
        // Only update React state if we're still on the same designer.
        if (isMountedRef.current) {
          setDesigner((d) => (d && d.id === designerSnapshot.id ? withNotes : d));
          setNotesStatus("idle");
        }
      } catch (err) {
        console.warn("notes refresh failed", err);
        if (isMountedRef.current) {
          lastFailedRefreshRef.current = { priorChatId, designer: designerSnapshot };
          setNotesStatus("failed");
        }
      }
    },
    []
  );


  /**
   * Apply attached-pin changes to the active chat row. Persists to IDB so
   * the picker, the system-prompt build, and a page reload all stay in
   * sync. Used by the composer paperclip flow in <Chat>.
   */
  const onChangeAttachedPins = useCallback(
    async (nextIds: string[]) => {
      if (!chat) return;
      const updated: StoredChat = {
        ...chat,
        attachedPinIds: nextIds.length > 0 ? nextIds : undefined,
        updatedAt: Date.now(),
      };
      setChat(updated);
      setChats((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      await putChat(updated);
    },
    [chat]
  );

  /**
   * End the current chat and open a fresh one. The new chat opens immediately;
   * the notes-refresh runs in the background.
   *
   * Notes are distilled by `/api/notes` (a non-streaming LLM round-trip that
   * can take several seconds). Blocking the new-chat button on that call —
   * the previous behavior — made iterating on an artifact feel jittery: every
   * "+ New chat" click stalled the composer for ~5–15s. Now the chat is
   * created synchronously and the notes update fires-and-forgets, surfacing
   * as a small "Updating notes…" chip in the header.
   *
   * Tradeoff: if the user sends a message before notes resolve, the first
   * turn uses the previous notes. Subsequent turns auto-pick up the refreshed
   * notes because <Chat> re-renders on setDesigner(withNotes). Acceptable —
   * notes describe the project, not the immediate task.
   */
  const onNewChat = useCallback(async () => {
    if (!designer || !chat) return;
    if (newChatBusyRef.current) return;
    newChatBusyRef.current = true;

    // 1. Snapshot prior chat id + designer state for the background refresh.
    //    Captured here so a concurrent reload() can't move the goalposts.
    const priorChatId = chat.id;
    const designerSnapshot: StoredDesigner = designer;

    // 2. Create + select the fresh chat immediately. This is the synchronous
    //    happy path the user sees.
    const target: ChatTarget = { kind: "designer", id: designer.id, mode: "edit" };
    const fresh: StoredChat = {
      id: newId(),
      title: makeChatTitle(designer.name),
      titleSource: "default",
      target,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    try {
      await putChat(fresh);
    } finally {
      // Release the re-entrancy guard the moment the synchronous work is done;
      // background refresh has its own lifecycle and shouldn't block clicking
      // "New chat" again.
      newChatBusyRef.current = false;
    }
    setChats((prev) => [fresh, ...prev]);
    setChat(fresh);

    // 3. Fire-and-forget notes refresh. No awaits in the caller's chain.
    void refreshNotesInBackground(priorChatId, designerSnapshot);
  }, [designer, chat, refreshNotesInBackground]);

  const togglePublish = useCallback(async () => {
    if (!designer) return;
    if (!designer.manifest) return;
    const next: StoredDesigner = {
      ...designer,
      status: designer.status === "published" ? "draft" : "published",
      updatedAt: Date.now(),
    };
    await putDesigner(next);
    setDesigner(next);
  }, [designer]);

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="safe-top flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-muted-foreground">{loadError}</p>
        <div className="flex gap-2">
          <Button
            onClick={() => {
              setHydrated(false);
              setLoadError(null);
              void reload();
            }}
          >
            Retry
          </Button>
          <Button variant="outline" onClick={() => router.push("/designer")}>
            Back to apps
          </Button>
        </div>
      </div>
    );
  }

  if (!designer) {
    return (
      <div className="safe-top flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-muted-foreground">App not found.</p>
        <Button variant="outline" onClick={() => router.push("/designer")}>
          Back to apps
        </Button>
      </div>
    );
  }

  const fileCount = Object.keys(pendingFiles ?? designer.files).length;

  // Widget detection runs against the live VFS (pending or persisted) so the
  // App/Widget toggle appears the moment the assistant writes Widget.tsx.
  const hasWidget =
    detectWidgetEntry(pendingFiles ?? designer.files, designer.manifest) !== null;
  const widgetPreset: WidgetSizePreset =
    app?.widgetSize ?? designer.manifest?.widget?.defaultSize ?? "M";
  const widgetSizeForPreview: WidgetSize = (() => {
    const meta = WIDGET_PRESETS[widgetPreset];
    const box = widgetPreviewBox(widgetPreset);
    return { preset: widgetPreset, cols: meta.cols, rows: meta.rows, w: box.width, h: box.height };
  })();

  async function setWidgetPresetForApp(preset: WidgetSizePreset) {
    if (!app) return;
    const now = Date.now();
    const next: StoredApp = { ...app, widgetSize: preset, widgetUpdatedAt: now, updatedAt: now };
    setApp(next);
    await putApp(next).catch(() => {});
  }

  async function setWidgetEnabledForApp(enabled: boolean) {
    if (!app) return;
    const next: StoredApp = { ...app, widgetEnabled: enabled, updatedAt: Date.now() };
    setApp(next);
    await putApp(next).catch(() => {});
  }

  // One-time declared-data migration, offered while the manifest has no
  // "state" block (a successful upgrade retires the button by itself).
  // Research apps are native views and don't need it.
  const isResearchApp =
    Array.isArray(app?.state?.columns) &&
    typeof app?.state?.query === "string" &&
    Array.isArray(app?.state?.records);
  const showUpgradeAction = !designer.manifest?.state && !isResearchApp;
  function startDeclaredDataUpgrade() {
    setPrefillMessage(DECLARED_DATA_UPGRADE_PROMPT);
    setPrefillModel(BEST_FOR.agentic);
    setAutoSendPrefill(true);
    setMobileTab("chat");
  }

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border/60 bg-background/85 px-2 pt-2 pb-2 backdrop-blur sm:gap-3 sm:px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          <Button
            size="icon-touch"
            variant="ghost"
            onClick={() => router.push("/designer")}
            aria-label="Back"
            className="tap shrink-0"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 title={designer.name} className="truncate font-[family-name:var(--font-display)] text-lg tracking-tight sm:text-xl">{designer.name}</h1>
              {designer.status === "published" ? (
                <PaperPill tone="success">{designer.status}</PaperPill>
              ) : (
                <PaperPill tone="neutral">{designer.status}</PaperPill>
              )}
              <VersionHistoryDropdown designer={designer} app={app} onRevert={onRevertToVersion} onSetLabel={onSetCheckpointLabel} />
            </div>
            {designer.description && (
              <div title={designer.description} className="reader-byline hidden truncate text-xs sm:block">{designer.description}</div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3 sm:gap-4">
          {showUpgradeAction && (
            <button
              type="button"
              onClick={startDeclaredDataUpgrade}
              title="Apply the latest platform improvements to this app. Runs right here in the chat; your data and settings are kept."
              className="tap reader-label inline-flex items-center gap-1 hover:text-foreground"
            >
              <DatabaseZap className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Update</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => void togglePublish()}
            disabled={!designer.manifest}
            className="tap reader-label hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
          >
            <span className="hidden sm:inline">{designer.status === "published" ? "Unpublish" : "Publish"}</span>
            <span className="sm:hidden">{designer.status === "published" ? "Draft" : "Pub"}</span>
          </button>
          <button
            type="button"
            onClick={() => router.push(`/apps/${designer.id}`)}
            className="tap reader-label inline-flex items-center gap-1 text-foreground hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Open app</span>
          </button>
        </div>

        <div className="w-full basis-full lg:hidden">
          <SectionDropdown tab={mobileTab} onTab={setMobileTab} fileCount={fileCount} />
        </div>
      </header>

      {sourceNote && (
        <LinkedNoteBanner
          note={sourceNote}
          onOpen={() => router.push("/notes")}
        />
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 px-2 pt-2 pb-2 sm:gap-4 sm:px-4 lg:grid-cols-[200px_minmax(0,1fr)_440px] lg:grid-rows-[minmax(0,1fr)]">
        <PaperCard
          className={cn(
            "min-h-0 flex-col overflow-hidden lg:order-1 lg:flex",
            mobileTab === "details" ? "flex" : "hidden"
          )}
        >
          <DetailsPanel
            activeTab={detailsTab}
            onTab={setDetailsTab}
            messages={messagesForActivity}
            highlightMessageId={highlightMessageId}
            files={pendingFiles ?? designer.files}
            entry={pendingEntry ?? designer.entry}
            selectedPath={selectedPath ?? undefined}
            onSelectFile={(path) => {
              setSelectedPath(path);
              setMobileTab("preview");
            }}
            fileCount={fileCount}
            designer={designer}
            onRevert={onRevertToVersion}
            onSetLabel={onSetCheckpointLabel}
          />
        </PaperCard>

        <PaperCard
          className={cn(
            "min-h-0 flex-col overflow-hidden lg:order-2 lg:flex",
            mobileTab === "preview" ? "flex" : "hidden"
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
            {selectedPath ? (
              <span className="truncate font-mono text-[11px]">{selectedPath}</span>
            ) : (
              <span className="reader-label truncate">Preview · {designer.name}</span>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setFileEditorOpen(true)}
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                title="Manually edit the app's files (paste code in)"
              >
                <FileCode className="h-3 w-3" />
                Edit files
              </button>
              {!selectedPath && hasWidget && (
                <PreviewModeToggle mode={previewMode} onChange={setPreviewMode} />
              )}
              {!selectedPath && previewMode === "widget" && hasWidget && app && (
                <WidgetSizePicker
                  value={widgetPreset}
                  options={
                    designer.manifest?.widget?.supportedSizes ??
                    (["S", "M", "L", "W"] as WidgetSizePreset[])
                  }
                  onChange={(p) => void setWidgetPresetForApp(p)}
                />
              )}
              {!selectedPath && previewMode === "widget" && hasWidget && app && (
                <HomeVisibilityToggle
                  enabled={app.widgetEnabled !== false}
                  onChange={(v) => void setWidgetEnabledForApp(v)}
                />
              )}
              {!selectedPath && app && (
                <Link
                  href={`/apps/${app.id}`}
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open
                </Link>
              )}
              {selectedPath && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      const content = (pendingFiles ?? designer.files)[selectedPath] ?? "";
                      navigator.clipboard.writeText(content).then(() => {
                        setFileCopied(true);
                        setTimeout(() => setFileCopied(false), 1500);
                      });
                    }}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    title="Copy file contents"
                  >
                    {fileCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedPath(null)}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    Back to preview
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-hidden">
            {selectedPath ? (
              <pre className="h-full w-full min-w-0 overflow-auto p-4 font-mono text-xs leading-relaxed text-foreground sm:text-[11.5px]">
                {(pendingFiles ?? designer.files)[selectedPath] ?? ""}
              </pre>
            ) : previewMode === "widget" && hasWidget && app ? (
              <div className="grid h-full place-items-center p-6">
                <div
                  className="overflow-hidden rounded-lg border border-border/70"
                  style={widgetPreviewBox(widgetPreset)}
                >
                  <ArtifactFrame
                    designer={designer}
                    app={app}
                    widget={{ size: widgetSizeForPreview }}
                    pendingFiles={pendingFiles}
                    pendingEntry={pendingEntry}
                    reloadKey={reloadKey}
                    defaultModel={app.model ?? undefined}
                    onLog={handleLog}
                    onStateChange={handleStateChange}
                    className="h-full w-full border-0"
                  />
                </div>
              </div>
            ) : previewMode === "widget" && !hasWidget ? (
              <div className="grid h-full place-items-center text-center text-sm text-muted-foreground">
                <div className="max-w-xs px-4">
                  <p>This artifact has no widget yet.</p>
                  <p className="mt-1 text-xs">
                    In the chat, ask the assistant to <em>“add a widget”</em>.
                  </p>
                </div>
              </div>
            ) : (
              app && (
                <ArtifactFrame
                  designer={designer}
                  app={app}
                  pendingFiles={pendingFiles}
                  pendingEntry={pendingEntry}
                  reloadKey={reloadKey}
                  defaultModel={app.model ?? undefined}
                  onLog={handleLog}
                  onStateChange={handleStateChange}
                  className="h-full w-full border-0"
                />
              )
            )}
          </div>
        </PaperCard>

        {chat && (
          <section
            className={cn(
              "min-h-0 flex-col lg:order-3 lg:flex",
              mobileTab === "chat" ? "flex" : "hidden"
            )}
          >
            <Chat
              chatId={chat.id}
              target={chat.target}
              onSaveHtml={onSaveHtml}
              onSaveVfs={onSaveVfs}
              templateFiles={designer.files}
              templateEntry={designer.entry}
              templateVersion={designer.version}
              onRevertToVersion={onRevertToVersion}
              onPendingVfs={handlePendingVfs}
              runtimeError={runtimeError ?? undefined}
              onRuntimeErrorConsumed={() => setRuntimeError(null)}
              extraSystem={extraSystem}
              attachedPins={attachedPins}
              onChangeAttachedPins={onChangeAttachedPins}
              chats={chats}
              onSelectChat={onSelectChat}
              onNewChat={onNewChat}
              newChatBusy={notesStatus === "running"}
              onOpenDetails={handleOpenDetails}
              onMessagesChange={setMessagesForActivity}
              onPinArtifact={({ messageId, html, summary }) =>
                setPinTarget({ messageId, html, summary })
              }
              onPinMessage={({ messageId, markdown }) =>
                setPinTarget({ messageId, markdown })
              }
              prefillInput={prefillMessage}
              autoSendPrefill={autoSendPrefill}
              prefillModel={prefillModel}
              onPrefillConsumed={() => {
                setPrefillMessage(null);
                // One-shot in both mechanisms: clear the autosend flag and
                // model override so a later prefill must set them again, and
                // drop ?prefill / ?autosend / ?upgrade from the URL so a
                // reload doesn't re-send.
                setAutoSendPrefill(false);
                setPrefillModel(null);
                if (
                  searchParams?.get("prefill") ||
                  searchParams?.get("autosend") ||
                  searchParams?.get("upgrade")
                ) {
                  router.replace(`/designer/${designer.id}`);
                }
              }}
            />
          </section>
        )}
      </div>

      <PinDialog
        open={!!pinTarget}
        onClose={() => setPinTarget(null)}
        artifactHtml={pinTarget?.html}
        messageMarkdown={pinTarget?.markdown}
        chatId={chat?.id}
        chatTitle={chat?.title}
        messageId={pinTarget?.messageId}
        summary={pinTarget?.summary}
        loadMessagesForSnapshot={
          chat ? () => loadMessages(chat.id) : undefined
        }
        sourcePinId={chat?.sourcePinId}
      />

      <FileEditor
        open={fileEditorOpen}
        onClose={() => setFileEditorOpen(false)}
        files={designer.files}
        entry={designer.entry}
        onSave={(files, entry) =>
          onSaveVfs({ files, entry, summary: "Manual file edit", ops: [] })
        }
      />
    </div>
  );
}

const SECTION_ITEMS: {
  id: "chat" | "preview" | "details";
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
}[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "preview", label: "Preview", icon: Monitor },
  { id: "details", label: "Details", icon: Layers },
];

function SectionDropdown({
  tab,
  onTab,
  fileCount,
}: {
  tab: "chat" | "preview" | "details";
  onTab: (t: "chat" | "preview" | "details") => void;
  fileCount: number;
}) {
  const current = SECTION_ITEMS.find((i) => i.id === tab) ?? SECTION_ITEMS[0];
  const CurrentIcon = current.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="tap inline-flex w-full items-center justify-between rounded-lg border border-border/70 px-3 py-2 text-sm font-medium text-foreground hover:border-foreground/30"
        aria-label="Switch section"
      >
        <span className="inline-flex items-center gap-2">
          <CurrentIcon className="h-4 w-4" strokeWidth={2.2} />
          {current.label}
          {current.id === "details" && fileCount > 0 && (
            <span className="rounded-full bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
              {fileCount}
            </span>
          )}
        </span>
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[var(--anchor-width)]">
        {SECTION_ITEMS.map(({ id, label, icon: Icon }) => (
          <DropdownMenuItem key={id} onClick={() => onTab(id)} className="gap-2">
            <Icon className="h-4 w-4" strokeWidth={id === tab ? 2.4 : 2} />
            <span className={cn("flex-1", id === tab && "font-semibold text-primary")}>{label}</span>
            {id === "details" && fileCount > 0 && (
              <span className="rounded-full bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
                {fileCount}
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Designer-preview viewport box for widget mode. Pixel sizes mirror the home
// board cells at desktop column width so the user sees what the dashboard
// will render. Heights match grid auto-rows in app/globals.css.
function widgetPreviewBox(preset: WidgetSizePreset): { width: number; height: number } {
  switch (preset) {
    case "S": return { width: 200, height: 200 };
    case "M": return { width: 420, height: 200 };
    case "L": return { width: 420, height: 420 };
    case "W": return { width: 860, height: 200 };
  }
}

function PreviewModeToggle({
  mode,
  onChange,
}: {
  mode: "app" | "widget";
  onChange: (m: "app" | "widget") => void;
}) {
  return (
    <div className="inline-flex items-center gap-2">
      {(["app", "widget"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={cn(
            "tap reader-label transition",
            mode === m
              ? "text-foreground underline underline-offset-4"
              : "hover:text-foreground"
          )}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

/**
 * Explicit on/off control for whether this app's widget appears on the Home
 * board. Shown alongside the widget preview so the toggle sits right next to
 * what it affects. Filled = on the board, muted = hidden.
 */
function HomeVisibilityToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      aria-pressed={enabled}
      title={enabled ? "Showing on the Home board — click to hide" : "Hidden from the Home board — click to show"}
      className={cn(
        "tap reader-label inline-flex items-center gap-1 transition",
        enabled ? "text-foreground" : "hover:text-foreground"
      )}
    >
      {enabled ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
      {enabled ? "On Home" : "Off Home"}
    </button>
  );
}

function WidgetSizePicker({
  value,
  options,
  onChange,
}: {
  value: WidgetSizePreset;
  options: WidgetSizePreset[];
  onChange: (p: WidgetSizePreset) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1.5">
      {options.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={cn(
            "tap reader-label px-0.5 transition",
            value === p
              ? "text-foreground underline underline-offset-4"
              : "hover:text-foreground"
          )}
          title={WIDGET_PRESETS[p].label}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

/**
 * Compact "v{N}" pill that opens a menu of prior designer versions. Each row
 * shows the version number, when it was saved, and the assistant's edit
 * summary (already captured into `DesignerCommit.commitMessage` at save
 * time — no extra LLM round-trip). Picking a version raises a confirm
 * dialog before calling `onRevert`, which treats the rollback as a forward
 * save so the current head stays in history and the revert itself is
 * undoable.
 */
function VersionHistoryDropdown({
  designer,
  app,
  onRevert,
  onSetLabel,
}: {
  designer: StoredDesigner;
  app: StoredApp | null;
  onRevert: (version: number, restoreState?: boolean) => Promise<void>;
  onSetLabel: (version: number, label: string | null) => Promise<void>;
}) {
  const history = useMemo(
    () => [...(designer.history ?? [])].sort((a, b) => b.version - a.version),
    [designer.history]
  );
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<DesignerCommit | null>(null);
  const [pending, setPending] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreState, setRestoreState] = useState(false);
  const [editingVersion, setEditingVersion] = useState<number | null>(null);
  const [labelInput, setLabelInput] = useState("");
  const labels = designer.checkpointLabels ?? {};
  const stateSnapshots = designer.stateSnapshots ?? {};
  const currentLabel = labels[String(designer.version)];

  const onPick = useCallback((commit: DesignerCommit) => {
    setOpen(false);
    setTarget(commit);
    setRestoreError(null);
    setRestoreState(!!stateSnapshots[String(commit.version)]);
  }, [stateSnapshots]);

  const onConfirm = useCallback(async () => {
    if (!target) return;
    setPending(true);
    setRestoreError(null);
    try {
      await onRevert(target.version, restoreState);
      setTarget(null);
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : "Restore failed. Try again.");
    } finally {
      setPending(false);
    }
  }, [target, onRevert, restoreState]);

  const startEditing = useCallback(
    (version: number) => {
      setLabelInput(labels[String(version)] ?? "");
      setEditingVersion(version);
    },
    [labels]
  );

  const saveLabel = useCallback(async () => {
    if (editingVersion == null) return;
    const trimmed = labelInput.trim();
    await onSetLabel(editingVersion, trimmed || null);
    setEditingVersion(null);
    setLabelInput("");
  }, [editingVersion, labelInput, onSetLabel]);

  const removeLabel = useCallback(
    async (version: number) => {
      await onSetLabel(version, null);
      if (editingVersion === version) {
        setEditingVersion(null);
        setLabelInput("");
      }
    },
    [onSetLabel, editingVersion]
  );

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          className="tap inline-flex shrink-0 items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Version history"
          title="Version history"
        >
          {currentLabel ? (
            <Bookmark className="h-3 w-3 fill-current text-amber-500" strokeWidth={2.2} />
          ) : (
            <History className="h-3 w-3" strokeWidth={2.2} />
          )}
          v{designer.version}
          <ChevronDown className="h-3 w-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80 p-0">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-foreground">Version history</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {history.length} prior
            </span>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {/* Current version */}
            <div className="px-3 py-2">
              <div className="flex items-center justify-between gap-2 text-sm">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="font-mono text-foreground">v{designer.version}</span>
                  {currentLabel && (
                    <span className="truncate text-xs font-medium text-amber-500">
                      · {currentLabel}
                    </span>
                  )}
                  {stateSnapshots[String(designer.version)] && (
                    <DatabaseZap className="h-3 w-3 shrink-0 text-sky-500" />
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (editingVersion === designer.version) {
                        setEditingVersion(null);
                      } else {
                        startEditing(designer.version);
                      }
                    }}
                    className="rounded p-0.5 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                    title={currentLabel ? "Edit checkpoint name" : "Save checkpoint"}
                  >
                    <Bookmark
                      className={cn(
                        "h-3.5 w-3.5",
                        currentLabel && "fill-current text-amber-500"
                      )}
                    />
                  </button>
                  <span className="text-[11px] text-muted-foreground">current</span>
                </div>
              </div>
              {headCommitMessageOf(designer) && (
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                  {headCommitMessageOf(designer)}
                </p>
              )}
              {editingVersion === designer.version && (
                <div className="mt-1.5 flex items-center gap-1 rounded-md border border-border bg-secondary/30 px-2 py-1">
                  <input
                    autoFocus
                    value={labelInput}
                    onChange={(e) => setLabelInput(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") void saveLabel();
                      if (e.key === "Escape") setEditingVersion(null);
                    }}
                    placeholder="Name this checkpoint…"
                    className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
                    maxLength={60}
                  />
                  <button
                    type="button"
                    onClick={() => void saveLabel()}
                    className="rounded p-0.5 text-muted-foreground transition hover:text-foreground"
                    title="Save"
                  >
                    <Check className="h-3 w-3" />
                  </button>
                  {currentLabel && (
                    <button
                      type="button"
                      onClick={() => void removeLabel(designer.version)}
                      className="rounded p-0.5 text-muted-foreground transition hover:text-destructive"
                      title="Remove label"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* History */}
            {history.length === 0 ? (
              <div className="border-t border-border/60 px-3 py-3 text-xs text-muted-foreground">
                No earlier versions yet. Edits will accumulate here as the
                assistant saves changes.
              </div>
            ) : (
              history.map((h) => {
                const hLabel = labels[String(h.version)];
                const hSnap = !!stateSnapshots[String(h.version)];
                return (
                  <div
                    key={h.version}
                    className="group cursor-pointer border-t border-border/60 transition hover:bg-secondary/50"
                    onClick={() => onPick(h)}
                  >
                    <div className="w-full px-3 py-2 text-left">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          {hLabel && (
                            <Bookmark className="h-3 w-3 shrink-0 fill-current text-amber-500" />
                          )}
                          <span className="font-mono text-sm text-foreground">
                            v{h.version}
                          </span>
                          {hLabel && (
                            <span className="truncate text-xs font-medium text-amber-500">
                              {hLabel}
                            </span>
                          )}
                          {hSnap && (
                            <DatabaseZap className="h-3 w-3 shrink-0 text-sky-500" />
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (editingVersion === h.version) {
                                setEditingVersion(null);
                              } else {
                                startEditing(h.version);
                              }
                            }}
                            className={cn(
                              "rounded p-0.5 transition",
                              hLabel
                                ? "text-amber-500 hover:text-amber-400"
                                : "text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                            )}
                            title={hLabel ? "Edit checkpoint name" : "Name this version"}
                          >
                            <Bookmark
                              className={cn("h-3 w-3", hLabel && "fill-current")}
                            />
                          </button>
                          <span className="text-[11px] text-muted-foreground">
                            {relativeTime(h.savedAt)}
                          </span>
                        </div>
                      </div>
                      {h.commitMessage ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {h.commitMessage}
                        </p>
                      ) : (
                        <p className="mt-0.5 text-xs italic text-muted-foreground/70">
                          (no description)
                        </p>
                      )}
                      <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground opacity-0 transition group-hover:opacity-100">
                        <Undo2 className="h-3 w-3" />
                        Restore
                      </span>
                    </div>
                    {editingVersion === h.version && (
                      <div
                        className="flex items-center gap-1 border-t border-border/40 bg-secondary/20 px-3 py-1.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          autoFocus
                          value={labelInput}
                          onChange={(e) => setLabelInput(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") void saveLabel();
                            if (e.key === "Escape") setEditingVersion(null);
                          }}
                          placeholder="Name this checkpoint…"
                          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
                          maxLength={60}
                        />
                        <button
                          type="button"
                          onClick={() => void saveLabel()}
                          className="rounded p-0.5 text-muted-foreground transition hover:text-foreground"
                          title="Save"
                        >
                          <Check className="h-3 w-3" />
                        </button>
                        {hLabel && (
                          <button
                            type="button"
                            onClick={() => void removeLabel(h.version)}
                            className="rounded p-0.5 text-muted-foreground transition hover:text-destructive"
                            title="Remove label"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={!!target}
        onOpenChange={(o) => {
          if (!o && !pending) setTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Restore v{target?.version}?</DialogTitle>
            <DialogDescription>
              Designer files snap back to v{target?.version}.
              {target && stateSnapshots[String(target.version)]
                ? " A data snapshot is available for this version."
                : " Your app’s saved data (state) isn’t touched."}{" "}
              The restore lands as a new version, so your
              current v{designer.version} stays in history and the rollback itself
              is undoable.
            </DialogDescription>
          </DialogHeader>
          {target?.commitMessage && (
            <div className="border-l-2 border-border pl-3 text-xs italic text-muted-foreground">
              {target.commitMessage}
            </div>
          )}
          {target && stateSnapshots[String(target.version)] && (
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2.5">
              <input
                type="checkbox"
                checked={restoreState}
                onChange={(e) => setRestoreState(e.target.checked)}
                className="accent-sky-500"
              />
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <DatabaseZap className="h-3.5 w-3.5 shrink-0 text-sky-500" />
                <span className="text-xs text-foreground">
                  Also restore app data to this checkpoint
                </span>
              </div>
            </label>
          )}
          {restoreError && (
            <p className="text-xs text-destructive">{restoreError}</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTarget(null)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button onClick={() => void onConfirm()} disabled={pending}>
              {pending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <>
                  <Undo2 className="h-3 w-3" />
                  Restore v{target?.version}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
