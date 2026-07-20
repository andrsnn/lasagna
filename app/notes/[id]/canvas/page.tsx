"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Code,
  FileText,
  Loader2,
  MessageSquare,
  Pencil,
  Pin,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getPinnedNote,
  listChatsForNote,
  markChatViewed,
  newId,
  putChat,
  putMessage,
  putPinnedNote,
  type ArtifactFiles,
  type ChatTarget,
  type NoteComment,
  type ProposedVfs,
  type StoredChat,
  type StoredPinnedNote,
} from "@/app/db";
import type { Anchor } from "@/app/lib/annotations/anchor";
import {
  noteToCanvasBody,
  type NoteCanvasBody,
} from "@/app/lib/note-canvas/body";
import {
  buildCommentsPrompt,
  commentToSpan,
} from "@/app/lib/note-canvas/comments";
import { buildDiagramPrompt } from "@/app/lib/note-canvas/diagram";
import {
  applyCanvasResult,
  canRevertCanvas,
  convertNoteToHtml,
  revertCanvasNote,
} from "@/app/lib/note-canvas/persist";
import { markdownNoteToHtmlDocument } from "@/app/lib/note-canvas/to-html";
import { createChatFromPinnedNote } from "@/app/lib/seed-chat-from-pin";
import { buildExtraSystem } from "@/app/lib/extra-system";
import { Chat } from "@/app/components/chat";
import { NotePreviewWithRef } from "@/app/components/note-canvas/note-preview";
import { useSelectionAnchor } from "@/app/components/note-canvas/use-selection-anchor";
import { PaperCard } from "@/app/components/paper-card";
import { PaperPill } from "@/app/components/paper-pill";
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

const CANVAS_MOBILE_CHAT_HEADER_HOST_ID = "note-canvas-chat-header-host";

export default function NoteCanvasPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: noteId } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryChatId = searchParams?.get("chat") ?? null;

  const [note, setNote] = useState<StoredPinnedNote | null>(null);
  const [chats, setChats] = useState<StoredChat[]>([]);
  const [chat, setChat] = useState<StoredChat | null>(null);
  const [attachedPins, setAttachedPins] = useState<StoredPinnedNote[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  // Highlight → pin/research dialog state. Anchor is captured separately by
  // useSelectionAnchor; these snapshot the selected text at the moment the
  // user clicks an action so closing the dialog (which collapses the live
  // selection) doesn't lose the source passage.
  const [pinDraft, setPinDraft] = useState<{ text: string; title: string; summary: string } | null>(null);
  const [researchDraft, setResearchDraft] = useState<{ text: string; prompt: string } | null>(null);
  // Highlight → Comment dialog. Snapshots the full anchor (not just the text)
  // so the comment can re-anchor + render as a mark after the body drifts.
  const [commentDraft, setCommentDraft] = useState<{ anchor: Anchor; body: string } | null>(null);
  // One-shot prompt handed to <Chat> (via prefill + autoSend) to action all
  // outstanding comments in a single note-edit pass.
  const [applyPrompt, setApplyPrompt] = useState<string | null>(null);
  // True between kicking off an Apply-comments send and its save landing, so
  // onSaveVfs knows to clear the actioned comments once the edit persists.
  const applyingCommentsRef = useRef(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** While the assistant streams an edit, render this body in the preview. */
  const [pendingBody, setPendingBody] = useState<string | null>(null);
  /**
   * Mobile-only: which pane owns the viewport - the chat composer or the note
   * preview. Desktop shows both side by side (this is ignored there). Mirrors
   * the designer's Chat/Preview section switch so previewing an in-progress
   * edit works the same way it does in app-edit mode. Manual `editing` forces
   * the preview regardless.
   */
  const [mobileView, setMobileView] = useState<"chat" | "note">("chat");
  const [convertOpen, setConvertOpen] = useState(false);
  const [converting, setConverting] = useState(false);
  /** Manual-edit mode: swaps the preview pane for a raw textarea. */
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  /**
   * Mobile-only: messages drawer is collapsed by default so the canvas owns
   * the viewport and only the sticky composer + selection chip are visible.
   * Auto-opens on send so the user sees the streaming reply. Manual toggles
   * are sticky for ~1s (debounced via lastUserToggleRef) so the next message
   * doesn't fight a deliberate collapse.
   */
  const [messagesOpen, setMessagesOpen] = useState(false);
  const lastUserToggleRef = useRef(0);
  const prevMsgCountRef = useRef(0);
  /**
   * `lg+` breakpoint detection. Mirrors `lg:` Tailwind queries elsewhere on
   * the page (≥1024px). Desktop never collapses messages; mobile uses the
   * dock layout with the compact ChatHeaderMobile pill on top so model /
   * mode / preferences stay reachable from the bottom sheet.
   */
  const [isLg, setIsLg] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    setIsLg(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsLg(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Canvas content derived from the latest note row. `null` means the note's
  // contents don't fit the canvas (empty note or unknown shape).
  const canvasBody: NoteCanvasBody | null = useMemo(
    () => (note ? noteToCanvasBody(note) : null),
    [note]
  );

  // Resolve / create the canvas chat for this note. Resolution order:
  //   1. `?chat=<id>` from the URL                    (deep link / fresh chat)
  //   2. Most recent chat from listChatsForNote       (resume)
  //   3. Create a fresh canvas chat                   (first visit)
  // On (3) we replace the URL with the new id so refresh + back/forward
  // continue to land on the same conversation.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const n = await getPinnedNote(noteId);
        if (cancelled) return;
        if (!n) {
          setBootstrapError("Note not found.");
          setHydrated(true);
          return;
        }
        setNote(n);

        const all = await listChatsForNote(noteId);
        if (cancelled) return;
        setChats(all);

        let active: StoredChat | null = null;
        if (queryChatId) {
          active = all.find((c) => c.id === queryChatId) ?? null;
        }
        if (!active) active = all[0] ?? null;
        if (!active) {
          // First-visit bootstrap: seed a canvas chat back-pointed at this
          // note. seedAs:"none" → no intro bubble; the body is already in
          // the preview pane next to the composer.
          const target: ChatTarget = {
            kind: "note-canvas",
            noteId,
            mode: "edit",
          };
          const { chatId: freshId } = await createChatFromPinnedNote(n, {
            target,
            seedAs: "none",
            title: `Canvas · ${n.title ?? n.summary?.slice(0, 40) ?? "Note"}`,
          });
          const refreshed = await listChatsForNote(noteId);
          if (cancelled) return;
          setChats(refreshed);
          active = refreshed.find((c) => c.id === freshId) ?? null;
        }
        setChat(active);
        // Reflect the active chat in the URL so reload returns to it.
        if (active && active.id !== queryChatId) {
          const next = new URLSearchParams(searchParams?.toString() ?? "");
          next.set("chat", active.id);
          router.replace(`/notes/${noteId}/canvas?${next.toString()}`);
        }
      } catch (err) {
        if (cancelled) return;
        setBootstrapError(err instanceof Error ? err.message : "Failed to load canvas.");
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId, queryChatId, router, searchParams]);

  // Stamp the canvas chat as "seen" so it stops showing the Ready badge
  // on the chats list. Same shape as the /chats/[id] effect; keyed on the
  // active chat id so a picker switch re-stamps the newly active chat.
  useEffect(() => {
    const chatId = chat?.id;
    if (!chatId) return;
    void markChatViewed(chatId);
    const stamp = () => void markChatViewed(chatId);
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
  }, [chat?.id]);

  // Hydrate the attached pinned notes for this canvas chat whenever the
  // chat's pin list changes. Mirrors the pattern in /chats/[id] and
  // /designer/[id] so attach/remove flows are consistent across surfaces.
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
      const updated: StoredChat = {
        ...chat,
        attachedPinIds: nextIds.length > 0 ? nextIds : undefined,
        updatedAt: Date.now(),
      };
      setChat(updated);
      await putChat(updated);
    },
    [chat]
  );

  // Canvas chats don't carry designer.notes — only attached pins feed
  // extraSystem here. Same wire shape as the chat/designer pages so the
  // server prompt assembly is uniform.
  const extraSystem = useMemo(
    () => buildExtraSystem(undefined, attachedPins),
    [attachedPins]
  );

  // Selection capture lives on the live body the user sees: the pending
  // stream when present, otherwise the persisted body. Re-keys whenever
  // either changes — that way a selection captured before a stream is
  // invalidated automatically as soon as the assistant rewrites the span.
  const liveBody = pendingBody ?? canvasBody?.body ?? "";
  const {
    rootRef: previewRef,
    anchor,
    clear: clearSelection,
    error: selectionError,
    isSelecting,
  } = useSelectionAnchor<HTMLDivElement>(liveBody);

  // Highlight → Pin: snapshot the selected passage and open a small dialog
  // for an optional title/summary. The dialog owns the inputs; submitting
  // creates a fresh StoredPinnedNote whose body IS the highlighted text.
  const onSelectionPin = useCallback(() => {
    if (!anchor) return;
    setPinDraft({ text: anchor.selectedText, title: "", summary: "" });
    setActionError(null);
  }, [anchor]);

  // Highlight → Research: snapshot the selected passage and open a small
  // dialog for the research question. On submit we POST /api/annotate and
  // route the user into a fresh child chat seeded with the Q/A pair (same
  // shape as the chat-bubble "Research this…" flow in MessageBubble).
  const onSelectionResearch = useCallback(() => {
    if (!anchor) return;
    setResearchDraft({ text: anchor.selectedText, prompt: "" });
    setActionError(null);
  }, [anchor]);

  // Persisted review comments on this note. Rendered as highlights in the
  // preview and actioned in one pass via "Apply comments".
  const comments = useMemo<NoteComment[]>(() => note?.comments ?? [], [note?.comments]);
  const commentSpans = useMemo(() => comments.map(commentToSpan), [comments]);

  // Highlight → Comment: snapshot the anchor and open the add-comment dialog.
  const onSelectionComment = useCallback(() => {
    if (!anchor) return;
    setCommentDraft({ anchor, body: "" });
    setActionError(null);
  }, [anchor]);

  // Highlight → Diagram: ask the assistant to draw a small diagram of the
  // highlighted passage and insert it next to that passage. We hand the request
  // in as a one-shot auto-sent prompt (same channel as Apply comments) rather
  // than scoping it to the selection — a diagram is an insertion, so the edit
  // has to reach just outside the highlighted span. Clearing the selection
  // first prevents the "<selection>" wrapper from constraining the edit.
  const onSelectionDiagram = useCallback(() => {
    if (!anchor || canvasBody?.kind === "snapshot") return;
    const selectedText = anchor.selectedText;
    clearSelection();
    setApplyPrompt(buildDiagramPrompt(selectedText));
  }, [anchor, canvasBody?.kind, clearSelection]);

  // Persist a comments-array change onto the note (add / delete / clear).
  const persistComments = useCallback(
    async (next: NoteComment[]) => {
      if (!note) return;
      const updated: StoredPinnedNote = {
        ...note,
        comments: next.length > 0 ? next : undefined,
        updatedAt: Date.now(),
      };
      setNote(updated);
      await putPinnedNote(updated);
    },
    [note]
  );

  const submitComment = useCallback(async () => {
    if (!commentDraft) return;
    const body = commentDraft.body.trim();
    if (!body) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const comment: NoteComment = {
        id: newId(),
        selectedText: commentDraft.anchor.selectedText,
        sourceText: commentDraft.anchor.sourceText,
        startOffset: commentDraft.anchor.startOffset,
        endOffset: commentDraft.anchor.endOffset,
        occurrenceIndex: commentDraft.anchor.occurrenceIndex,
        body,
        createdAt: Date.now(),
      };
      await persistComments([...comments, comment]);
      setCommentDraft(null);
      clearSelection();
      setToast("Comment added");
      setTimeout(() => setToast(null), 1600);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to add comment.");
    } finally {
      setActionBusy(false);
    }
  }, [commentDraft, comments, persistComments, clearSelection]);

  const deleteComment = useCallback(
    (id: string) => {
      void persistComments(comments.filter((c) => c.id !== id));
    },
    [comments, persistComments]
  );

  // Hand the assembled comments prompt to <Chat> to run as a normal note-edit
  // turn. onSaveVfs clears the comments once the resulting edit persists.
  const applyComments = useCallback(() => {
    if (comments.length === 0 || canvasBody?.kind === "snapshot") return;
    // Drop any lingering highlight so the apply-edit isn't scoped to a single
    // selection — comments span the whole document.
    clearSelection();
    applyingCommentsRef.current = true;
    setApplyPrompt(buildCommentsPrompt(comments));
  }, [comments, canvasBody?.kind, clearSelection]);

  const submitPin = useCallback(async () => {
    if (!pinDraft) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const now = Date.now();
      const title = pinDraft.title.trim();
      const summary = pinDraft.summary.trim();
      const noteRow: StoredPinnedNote = {
        id: newId(),
        createdAt: now,
        updatedAt: now,
        title: title || undefined,
        summary: summary || undefined,
        messageMarkdown: pinDraft.text,
      };
      await putPinnedNote(noteRow);
      setPinDraft(null);
      clearSelection();
      setToast("Pinned to notes");
      setTimeout(() => setToast(null), 1800);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to pin note.");
    } finally {
      setActionBusy(false);
    }
  }, [pinDraft, clearSelection]);

  const submitResearch = useCallback(async () => {
    if (!researchDraft || !chat) return;
    const prompt = researchDraft.prompt.trim();
    if (!prompt) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/annotate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedText: researchDraft.text, prompt }),
      });
      const data = (await res.json()) as { result?: string; error?: string };
      if (!res.ok || !data.result) {
        throw new Error(data.error ?? `Research failed (${res.status})`);
      }
      // Seed a child chat with the Q/A pair, back-pointed at the canvas
      // chat. parentSelection drives the back-link banner the chats page
      // already renders for highlight-spawned research conversations.
      const childChatId = newId();
      const tStamp = Date.now();
      const quoted = `> ${researchDraft.text.replace(/\n/g, "\n> ")}\n\n${prompt}`;
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
        content: data.result,
        createdAt: tStamp + 1,
        model: "gemma4:31b",
      });
      await putChat({
        id: childChatId,
        title: prompt.length > 60 ? prompt.slice(0, 60).trim() + "…" : prompt,
        titleSource: "default",
        createdAt: tStamp,
        updatedAt: tStamp,
        parentChatId: chat.id,
        parentSelection: { text: researchDraft.text },
      });
      setResearchDraft(null);
      clearSelection();
      router.push(`/chats/${childChatId}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Research failed.");
    } finally {
      setActionBusy(false);
    }
  }, [researchDraft, chat, clearSelection, router]);

  // Build the single-file VFS we hand to the Chat component as
  // templateFiles. Recomputed when the body changes so the next send
  // reflects any local edits. Snapshot notes are read-only in v1: we
  // skip the VFS wiring so responseFormatFor falls back to "chat" and the
  // assistant talks about the transcript rather than attempting (and
  // silently failing) to edit it.
  const isSnapshotKind = canvasBody?.kind === "snapshot";
  const templateFiles: ArtifactFiles | undefined =
    canvasBody && !isSnapshotKind ? { [canvasBody.entry]: canvasBody.body } : undefined;
  const templateEntry = isSnapshotKind ? undefined : canvasBody?.entry;

  // Live preview hook: receive the streaming VFS from Chat and route the
  // single file's content into pendingBody. We deliberately do NOT clear
  // pendingBody when Chat signals stream-end (`files === null`) — clearing
  // here would briefly fall back to the OLD persisted body for the window
  // between vfs_final and the auto-save's IDB write, which reads as "edits
  // discarded". Auto-save / manual save handlers clear pendingBody after
  // the new content has landed in `note` (canvasBody recomputes from it),
  // so the preview transitions straight from streamed → saved with no flash
  // of stale content. If the stream aborts without ever firing vfs_final,
  // the partially-streamed pendingBody persists until the next send
  // overwrites it via a fresh file_changed event — acceptable, since the
  // user can either re-send or click away.
  const handlePendingVfs = useCallback(
    (files: ArtifactFiles | null, _entry: string | null) => {
      if (!canvasBody) return;
      if (!files) return;
      const next = files[canvasBody.entry];
      if (typeof next === "string") setPendingBody(next);
    },
    [canvasBody]
  );

  // Persist the assistant's final edit back onto the note. Runs after the
  // stream ends (Chat fires onSaveVfs with the finalized proposedVfs).
  const onSaveVfs = useCallback(
    async (proposed: ProposedVfs): Promise<boolean> => {
      if (!note || !canvasBody) return false;
      // Consume the apply-comments flag up front so it never leaks into a
      // later unrelated edit, regardless of which branch we return through.
      const wasApplyingComments = applyingCommentsRef.current;
      applyingCommentsRef.current = false;
      const outcome = await applyCanvasResult({
        note,
        files: proposed.files,
        entry: canvasBody.entry,
        kind: canvasBody.kind,
      });
      // Clear the streamed preview either way; canvasBody recomputes from
      // `note` once we setNote below.
      setPendingBody(null);
      if (outcome.ok) {
        // If this edit was an "Apply comments" run, the comments have now been
        // actioned into the saved body — drop them (and persist the cleared
        // list) so they don't linger as stale marks over rewritten text.
        if (wasApplyingComments && outcome.note.comments?.length) {
          const cleared: StoredPinnedNote = {
            ...outcome.note,
            comments: undefined,
            updatedAt: Date.now(),
          };
          setNote(cleared);
          void putPinnedNote(cleared);
          setToast("Applied comments");
          setTimeout(() => setToast(null), 1800);
          return true;
        }
        setNote(outcome.note);
        return true;
      }
      // The edit would have blanked the note (empty/truncated result). Keep the
      // previous version and tell the user instead of silently destroying it.
      if (outcome.reason === "empty") {
        setToast("Edit came back empty — kept your previous note. Try again.");
        setTimeout(() => setToast(null), 3000);
        return false;
      }
      // "noop" means the body already matches disk - the version is, for the
      // user's purposes, saved. Only a "missing" note (deleted) is a real
      // failure that must NOT mark the card saved, so the Save button stays
      // live and a press can still override.
      return outcome.reason === "noop";
    },
    [note, canvasBody]
  );

  // Manual editing: drop the user straight into a textarea over the raw body.
  // We seed the draft from `canvasBody.body` (the persisted version) rather
  // than `liveBody` — entering edit mode while the assistant is streaming
  // would otherwise capture a half-streamed body, which is rarely what the
  // user wants. Streaming locks the Edit button anyway, but this is the
  // belt-and-braces version.
  const startEditing = useCallback(() => {
    if (!canvasBody || isSnapshotKind) return;
    setDraftBody(canvasBody.body);
    setEditError(null);
    setEditing(true);
  }, [canvasBody, isSnapshotKind]);

  const cancelEditing = useCallback(() => {
    setEditing(false);
    setDraftBody("");
    setEditError(null);
  }, []);

  // Persist a manual edit through the same `applyCanvasResult` path the
  // assistant uses — gets us the stale-write guard, share republish, and
  // markdown-vs-html field routing for free.
  const saveEdit = useCallback(async () => {
    if (!note || !canvasBody || isSnapshotKind) return;
    setEditSaving(true);
    setEditError(null);
    try {
      const outcome = await applyCanvasResult({
        note,
        files: { [canvasBody.entry]: draftBody },
        entry: canvasBody.entry,
        kind: canvasBody.kind,
      });
      if (outcome.ok) {
        setNote(outcome.note);
        setEditing(false);
        setToast("Saved");
        setTimeout(() => setToast(null), 1500);
      } else if (outcome.reason === "missing") {
        setEditError("Note no longer exists.");
      } else if (outcome.reason === "empty") {
        setEditError("Refused to save — that would empty the note.");
      } else {
        // noop — body matches what's already saved; just exit edit mode.
        setEditing(false);
      }
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save edit.");
    } finally {
      setEditSaving(false);
    }
  }, [note, canvasBody, isSnapshotKind, draftBody]);

  // One-step Revert: swap the stashed previous body back in. Available after any
  // canvas edit (manual or assistant), so a bad/blank edit is recoverable.
  const revertNote = useCallback(async () => {
    if (!note || !canvasBody || isSnapshotKind) return;
    const outcome = await revertCanvasNote(note.id, canvasBody.kind);
    if (outcome.ok) {
      setNote(outcome.note);
      setPendingBody(null);
      setToast("Reverted to previous version");
      setTimeout(() => setToast(null), 1500);
    }
  }, [note, canvasBody, isSnapshotKind]);

  // Convert a markdown note into an HTML note so it can be styled directly with
  // CSS (markdown has no font/color/layout controls). Renders the current body
  // through the same markdown pipeline, wraps it in an editable HTML document,
  // and flips the note's kind. The original markdown is kept as a recovery copy.
  const onConvertToHtml = useCallback(async () => {
    if (!note || !canvasBody || canvasBody.kind !== "markdown" || converting) return;
    setConverting(true);
    try {
      const htmlDoc = markdownNoteToHtmlDocument(canvasBody.body);
      const outcome = await convertNoteToHtml(note.id, htmlDoc);
      if (outcome.ok) {
        setNote(outcome.note);
        setConvertOpen(false);
        setToast("Converted to HTML — edit the styles freely");
        setTimeout(() => setToast(null), 2200);
      }
    } finally {
      setConverting(false);
    }
  }, [note, canvasBody, converting]);

  // Fork a snapshot note → a fresh markdown note + canvas chat. Lets the
  // user iterate on the transcript without risking the original snapshot.
  const onForkSnapshot = useCallback(async () => {
    if (!note || !canvasBody || canvasBody.kind !== "snapshot") return;
    const now = Date.now();
    const fork: StoredPinnedNote = {
      id: newId(),
      createdAt: now,
      updatedAt: now,
      title: note.title ? `${note.title} · forked` : "Forked transcript",
      summary: note.summary,
      messageMarkdown: canvasBody.body,
    };
    await putPinnedNote(fork);
    router.push(`/notes/${fork.id}/canvas`);
  }, [note, canvasBody, router]);

  const onSelectChat = useCallback(
    (nextId: string) => {
      const next = chats.find((c) => c.id === nextId);
      if (!next) return;
      setChat(next);
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.set("chat", nextId);
      router.replace(`/notes/${noteId}/canvas?${params.toString()}`);
    },
    [chats, noteId, router, searchParams]
  );

  const onNewChat = useCallback(async () => {
    if (!note) return;
    const target: ChatTarget = { kind: "note-canvas", noteId, mode: "edit" };
    const { chatId: freshId } = await createChatFromPinnedNote(note, {
      target,
      seedAs: "none",
      title: `Canvas · ${note.title ?? note.summary?.slice(0, 40) ?? "Note"}`,
    });
    const refreshed = await listChatsForNote(noteId);
    setChats(refreshed);
    const active = refreshed.find((c) => c.id === freshId);
    if (active) setChat(active);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("chat", freshId);
    router.replace(`/notes/${noteId}/canvas?${params.toString()}`);
  }, [note, noteId, router, searchParams]);

  // ---------- render ----------

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (bootstrapError || !note) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted-foreground">
        <p>{bootstrapError ?? "Note not found."}</p>
        <Button size="sm" onClick={() => router.push("/notes")}>
          Back to notes
        </Button>
      </div>
    );
  }

  // Empty-note bootstrap: the note has neither body nor snapshot. Surface a
  // friendly empty state instead of dropping the user into a chat with no
  // target.
  if (!canvasBody) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted-foreground">
        <p>This note has nothing to edit yet.</p>
        <Button size="sm" onClick={() => router.push("/notes")}>
          Back to notes
        </Button>
      </div>
    );
  }

  const isSnapshot = isSnapshotKind;
  const titleLabel = note.title ?? note.summary?.slice(0, 60) ?? "Untitled note";
  // Mobile pane arbitration (desktop shows both, so these only bite below lg).
  // Manual editing always forces the preview so the textarea is reachable.
  const showPreviewMobile = editing || mobileView === "note";
  const showChatMobile = !editing && mobileView === "chat";

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top safe-x sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border/60 bg-background/85 px-3 py-2 backdrop-blur sm:px-4">
        {/* Back/exit. On mobile this is the only way off the canvas (the global
            BottomNav hides on /canvas), so the hit area has to clear the 44px
            HIG minimum — a bare 14px icon tucked under the browser address bar
            is effectively untappable. The negative margin + padding grows the
            touch target without shifting the icon's visual position. */}
        <button
          type="button"
          onClick={() => router.push("/notes")}
          aria-label="Back to notes"
          className="tap reader-label -ml-2 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 px-2 hover:text-foreground sm:min-w-0"
        >
          <ArrowLeft className="h-5 w-5 sm:h-3.5 sm:w-3.5" />
          <span className="hidden sm:inline">Notes</span>
        </button>
        <PaperPill tone="neutral" className="shrink-0">
          Canvas
        </PaperPill>
        <h1 className="min-w-0 flex-1 truncate font-[family-name:var(--font-display)] text-base tracking-tight text-foreground">
          {titleLabel}
        </h1>

        {/* Mobile-only manual-edit entry point. The desktop preview pane carries
            its own Pencil "Edit" button, but that whole pane is hidden below lg
            (the chat owns the phone viewport), so without this the only way to
            edit on mobile is to instruct the AI. Tapping this enters edit mode,
            which reveals the editor card and hands it the viewport. */}
        {!isSnapshot && !editing && (
          <button
            type="button"
            onClick={startEditing}
            className="tap reader-label inline-flex min-h-11 items-center gap-1 px-1 hover:text-foreground lg:hidden"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </button>
        )}
        {!isSnapshot && !editing && canvasBody.kind === "markdown" && (
          <button
            type="button"
            onClick={() => setConvertOpen(true)}
            className="tap reader-label inline-flex min-h-11 items-center gap-1 px-1 hover:text-foreground"
          >
            <Code className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Convert to HTML</span>
            <span className="sm:hidden">HTML</span>
          </button>
        )}
        {/* Snapshots (read-only transcripts) fork into an editable markdown
            note. Turning a note into an app now lives back on the Notes list
            (a deliberate step) so it can't be triggered by a stray tap here
            mid-edit. */}
        {isSnapshot && (
          <button
            type="button"
            onClick={() => void onForkSnapshot()}
            className="tap reader-label inline-flex min-h-11 items-center gap-1 px-1 hover:text-foreground"
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Fork as markdown</span>
            <span className="sm:hidden">Fork</span>
          </button>
        )}
        {/* Mobile-only view switcher: flip the phone viewport between the chat
            composer and a live preview of the note being edited. Mirrors the
            designer's Chat/Preview section dropdown. Hidden while manually
            editing (the editor already owns the viewport). */}
        {!editing && (
          <div className="w-full basis-full lg:hidden">
            <CanvasViewDropdown view={mobileView} onView={setMobileView} />
          </div>
        )}
        {/* Mobile chat header (model · tokens · …) is portaled here so it sits
            with the page header instead of between the artifact preview and the
            messages. Empty on sm+ since the desktop ChatHeader renders inline.
            Hidden when the note preview owns the viewport - the model picker
            belongs with the composer, not the reader. */}
        <div
          id={CANVAS_MOBILE_CHAT_HEADER_HOST_ID}
          className={cn(
            "basis-full lg:hidden",
            (editing || mobileView === "note") && "hidden"
          )}
        />
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-2 pt-2 pb-2 sm:gap-4 sm:px-4 lg:grid lg:grid-cols-[minmax(0,1fr)_440px] lg:grid-rows-[minmax(0,1fr)]">
        <PaperCard
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-initial",
            // On mobile the chat owns the viewport by default; the "Note" view
            // switch (or entering manual-edit mode) hands it to this preview so
            // you can read the edit without leaving the canvas. Always visible
            // from lg up.
            !showPreviewMobile && "max-lg:hidden"
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
            <span className="truncate font-mono text-[11px]">{canvasBody.entry}</span>
            <div className="flex items-center gap-3">
              {pendingBody !== null && (
                <span className="reader-byline inline-flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  streaming
                </span>
              )}
              {!isSnapshot &&
                (editing ? (
                  <>
                    <button
                      type="button"
                      className="tap reader-label inline-flex items-center gap-1 hover:text-foreground disabled:opacity-40"
                      onClick={cancelEditing}
                      disabled={editSaving}
                    >
                      <X className="h-3.5 w-3.5" />
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="tap reader-label inline-flex items-center gap-1 text-foreground disabled:opacity-40"
                      onClick={() => void saveEdit()}
                      disabled={editSaving}
                    >
                      {editSaving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      Save
                    </button>
                  </>
                ) : (
                  <>
                    {note && canRevertCanvas(note, canvasBody.kind) && (
                      <button
                        type="button"
                        className="tap reader-label inline-flex items-center gap-1 hover:text-foreground disabled:opacity-40"
                        onClick={() => void revertNote()}
                        disabled={pendingBody !== null}
                        title="Undo the last edit (restore the previous version)"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Revert
                      </button>
                    )}
                    <button
                      type="button"
                      className="tap reader-label inline-flex items-center gap-1 hover:text-foreground disabled:opacity-40"
                      onClick={startEditing}
                      disabled={pendingBody !== null}
                      title={
                        pendingBody !== null
                          ? "Wait for the assistant to finish"
                          : "Edit this note manually"
                      }
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </button>
                  </>
                ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {editing ? (
              <textarea
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void saveEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEditing();
                  }
                }}
                disabled={editSaving}
                autoFocus
                spellCheck
                placeholder={
                  canvasBody.kind === "html"
                    ? "<html>…</html>"
                    : "Markdown supported. ⌘↵ to save, Esc to cancel."
                }
                className="h-full w-full resize-none border-0 bg-transparent px-6 py-6 font-mono text-sm leading-relaxed text-foreground outline-none sm:px-10 sm:py-8"
              />
            ) : (
              <NotePreviewWithRef
                ref={previewRef}
                kind={canvasBody.kind}
                body={liveBody}
                // Suppress the amber overlay <mark> while a selection is being
                // dragged: injecting it re-renders the prose and detaches the
                // live selection, making the highlight jump to the line above.
                // The native selection shows during the drag; the overlay takes
                // over once the selection settles (isSelecting flips false).
                anchor={isSelecting ? null : anchor}
                comments={commentSpans}
                readOnly={isSnapshot}
              />
            )}
          </div>
          {!editing && comments.length > 0 && (
            <CommentsPanel
              comments={comments}
              busy={pendingBody !== null}
              canApply={!isSnapshot}
              onApply={applyComments}
              onDelete={deleteComment}
            />
          )}
          {editError && (
            <div className="border-t border-destructive/40 bg-destructive/10 px-4 py-2 text-[11px] text-destructive">
              {editError}
            </div>
          )}
          {!editing && selectionError && (
            <div className="border-t border-border/60 bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
              {selectionError}
            </div>
          )}
        </PaperCard>

        {chat && (
          <section
            className={cn(
              "flex min-h-0 flex-1 flex-col lg:flex-initial",
              // On mobile, yield the viewport to the preview when the user
              // switches to the "Note" view or enters manual-edit mode. The
              // chat stays mounted (just hidden) so its state and the portaled
              // mobile header survive the toggle.
              !showChatMobile && "max-lg:hidden"
            )}
          >
            <Chat
              // Remount when the ?chat= switcher changes chats — otherwise
              // the previous chat's messages state and live stream survive
              // into the next one and cross-write (see /chats/[id]).
              key={chat.id}
              chatId={chat.id}
              target={chat.target}
              templateFiles={templateFiles}
              templateEntry={templateEntry}
              onPendingVfs={handlePendingVfs}
              onSaveVfs={isSnapshot ? undefined : onSaveVfs}
              chats={chats}
              onSelectChat={onSelectChat}
              onNewChat={() => void onNewChat()}
              selectionAnchor={anchor ?? null}
              onSelectionConsumed={clearSelection}
              onSelectionPin={onSelectionPin}
              onSelectionResearch={onSelectionResearch}
              onSelectionComment={isSnapshot ? undefined : onSelectionComment}
              onSelectionDiagram={isSnapshot ? undefined : onSelectionDiagram}
              // Apply-comments hands a prompt here and auto-sends it as a
              // note-edit turn; onPrefillConsumed clears so the next apply
              // re-arms (Chat resets its one-shot guard when prefill goes null).
              prefillInput={applyPrompt}
              autoSendPrefill
              onPrefillConsumed={() => setApplyPrompt(null)}
              extraSystem={extraSystem}
              attachedPins={attachedPins}
              onChangeAttachedPins={onChangeAttachedPins}
              messagesCollapsed={false}
              onToggleMessages={
                isLg
                  ? () => {
                      setMessagesOpen((v) => !v);
                      lastUserToggleRef.current = Date.now();
                    }
                  : undefined
              }
              dockClassName={
                isLg
                  ? undefined
                  : "safe-x gap-1.5 border-t border-border bg-background/95 px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur"
              }
              // On desktop, render the chat header (model picker + token meter)
              // inline so it's visible. On mobile, portal it into the page-header
              // host above. Previously it always portaled into an sm:hidden host,
              // so the model picker was invisible on desktop.
              mobileHeaderHostId={isLg ? undefined : CANVAS_MOBILE_CHAT_HEADER_HOST_ID}
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
              placeholder={
                isSnapshot
                  ? "Read-only — fork to edit"
                  : anchor
                    ? "Edit the highlighted text…"
                    : "Edit this note…"
              }
            />
          </section>
        )}
      </div>

      <Dialog
        open={!!pinDraft}
        onOpenChange={(o) => {
          if (!o) {
            setPinDraft(null);
            setActionError(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Pin highlight as note</DialogTitle>
            <DialogDescription>
              Saved as a standalone note. The highlighted passage is preserved verbatim.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="reader-serif line-clamp-3 border-l-2 border-amber-400/70 pl-3 text-xs italic text-foreground">
              {pinDraft?.text}
            </div>
            <input
              autoFocus
              value={pinDraft?.title ?? ""}
              onChange={(e) =>
                setPinDraft((p) => (p ? { ...p, title: e.target.value } : p))
              }
              placeholder="Title (optional)"
              className="w-full border-0 border-b border-border/70 bg-transparent px-0 py-1.5 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-foreground/40"
            />
            <textarea
              value={pinDraft?.summary ?? ""}
              onChange={(e) =>
                setPinDraft((p) => (p ? { ...p, summary: e.target.value } : p))
              }
              placeholder="Summary (optional)"
              rows={2}
              className="w-full resize-none border-0 border-b border-border/70 bg-transparent px-0 py-1.5 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-foreground/40"
            />
            {actionError && (
              <p className="text-xs text-destructive">{actionError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPinDraft(null)}
              disabled={actionBusy}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={actionBusy}
              onClick={() => void submitPin()}
            >
              {actionBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <>
                  <Pin className="h-3.5 w-3.5" />
                  <span className="ml-1">Pin</span>
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!researchDraft}
        onOpenChange={(o) => {
          if (!o) {
            setResearchDraft(null);
            setActionError(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Research highlight</DialogTitle>
            <DialogDescription>
              Routes through the research model and opens the answer in a fresh chat.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="reader-serif line-clamp-3 border-l-2 border-amber-400/70 pl-3 text-xs italic text-foreground">
              {researchDraft?.text}
            </div>
            <textarea
              autoFocus
              value={researchDraft?.prompt ?? ""}
              onChange={(e) =>
                setResearchDraft((r) =>
                  r ? { ...r, prompt: e.target.value } : r
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submitResearch();
                }
              }}
              placeholder="What about this? (⌘↵ to send)"
              rows={3}
              className="w-full resize-none border-0 border-b border-border/70 bg-transparent px-0 py-1.5 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-foreground/40"
            />
            {actionError && (
              <p className="text-xs text-destructive">{actionError}</p>
            )}
            <p className="reader-byline text-[11px]">
              Opens a new chat with the result. You can keep researching there.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setResearchDraft(null)}
              disabled={actionBusy}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={actionBusy || !researchDraft?.prompt.trim()}
              onClick={() => void submitResearch()}
            >
              {actionBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <>
                  <Search className="h-3.5 w-3.5" />
                  <span className="ml-1">Research</span>
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!commentDraft}
        onOpenChange={(o) => {
          if (!o) {
            setCommentDraft(null);
            setActionError(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Comment on highlight</DialogTitle>
            <DialogDescription>
              Leave a note on this passage. Add as many as you like, then apply them
              all at once with the assistant.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="reader-serif line-clamp-3 border-l-2 border-sky-400/70 pl-3 text-xs italic text-foreground">
              {commentDraft?.anchor.selectedText}
            </div>
            <textarea
              autoFocus
              value={commentDraft?.body ?? ""}
              onChange={(e) =>
                setCommentDraft((c) => (c ? { ...c, body: e.target.value } : c))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submitComment();
                }
              }}
              placeholder="What should change here? (⌘↵ to add)"
              rows={3}
              className="w-full resize-none border-0 border-b border-border/70 bg-transparent px-0 py-1.5 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-foreground/40"
            />
            {actionError && (
              <p className="text-xs text-destructive">{actionError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCommentDraft(null)}
              disabled={actionBusy}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={actionBusy || !commentDraft?.body.trim()}
              onClick={() => void submitComment()}
            >
              {actionBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <>
                  <MessageSquare className="h-3.5 w-3.5" />
                  <span className="ml-1">Add comment</span>
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={convertOpen}
        onOpenChange={(o) => {
          if (!o) setConvertOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Convert to HTML?</DialogTitle>
            <DialogDescription>
              Markdown has no styling controls. Converting turns this note into an
              HTML document you (or the assistant) can style directly with CSS -
              fonts, colors, and layout. Markdown editing is replaced by HTML
              editing; your current markdown is kept as a recovery copy.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConvertOpen(false)}
              disabled={converting}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={converting} onClick={() => void onConvertToHtml()}>
              {converting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <>
                  <Code className="h-3.5 w-3.5" />
                  <span className="ml-1">Convert</span>
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {toast && (
        <div className="fixed bottom-20 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-xs text-foreground">
          <Check className="h-3.5 w-3.5 text-primary" />
          {toast}
        </div>
      )}
    </div>
  );
}

const CANVAS_VIEW_ITEMS: {
  id: "chat" | "note";
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
}[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "note", label: "Note", icon: FileText },
];

/**
 * Mobile-only Chat/Note switcher for the canvas. A note-edit analogue of the
 * designer's SectionDropdown so previewing an in-progress edit is one tap
 * away instead of a back-then-expand round trip. Hidden on lg+ (both panes
 * render side by side there).
 */
function CanvasViewDropdown({
  view,
  onView,
}: {
  view: "chat" | "note";
  onView: (v: "chat" | "note") => void;
}) {
  const current = CANVAS_VIEW_ITEMS.find((i) => i.id === view) ?? CANVAS_VIEW_ITEMS[0];
  const CurrentIcon = current.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="tap inline-flex w-full items-center justify-between rounded-lg border border-border/70 px-3 py-2 text-sm font-medium text-foreground hover:border-foreground/30"
        aria-label="Switch view"
      >
        <span className="inline-flex items-center gap-2">
          <CurrentIcon className="h-4 w-4" strokeWidth={2.2} />
          {current.label}
        </span>
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[var(--anchor-width)]">
        {CANVAS_VIEW_ITEMS.map(({ id, label, icon: Icon }) => (
          <DropdownMenuItem key={id} onClick={() => onView(id)} className="gap-2">
            <Icon className="h-4 w-4" strokeWidth={id === view ? 2.4 : 2} />
            <span className={cn("flex-1", id === view && "font-semibold text-primary")}>
              {label}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Footer panel under the preview listing the outstanding review comments. Each
 * row shows the quoted passage + the comment, with a delete affordance. The
 * header carries the "Apply comments" action that hands all of them to the
 * assistant in one edit pass. Disabled while an edit streams, and for
 * read-only snapshot notes (which must be forked before they can be edited).
 */
function CommentsPanel({
  comments,
  busy,
  canApply,
  onApply,
  onDelete,
}: {
  comments: NoteComment[];
  busy: boolean;
  canApply: boolean;
  onApply: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="border-t border-border/60 bg-muted/20">
      <div className="flex items-center justify-between gap-2 px-4 py-2">
        <span className="reader-label inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <MessageSquare className="h-3.5 w-3.5" />
          {comments.length} comment{comments.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={onApply}
          disabled={busy || !canApply}
          title={
            !canApply
              ? "Fork this note to markdown to apply comments"
              : busy
                ? "Wait for the assistant to finish"
                : "Ask the assistant to action every comment"
          }
          className="tap inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] text-primary transition hover:bg-primary/20 disabled:opacity-40"
        >
          <Wand2 className="h-3.5 w-3.5" />
          Apply comment{comments.length === 1 ? "" : "s"}
        </button>
      </div>
      <ul className="max-h-40 overflow-auto px-4 pb-3">
        {comments.map((c) => (
          <li
            key={c.id}
            className="group flex items-start gap-2 border-t border-border/40 py-2 first:border-t-0"
          >
            <div className="min-w-0 flex-1">
              <p className="reader-serif line-clamp-1 text-[11px] italic text-muted-foreground">
                “{c.selectedText.replace(/\s+/g, " ").trim()}”
              </p>
              <p className="mt-0.5 break-words text-xs text-foreground">{c.body}</p>
            </div>
            <button
              type="button"
              onClick={() => onDelete(c.id)}
              aria-label="Delete comment"
              className="tap shrink-0 rounded-md p-1 text-muted-foreground/60 transition hover:bg-muted hover:text-foreground"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
