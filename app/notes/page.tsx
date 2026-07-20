"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  Check,
  Cloud,
  CloudOff,
  Copy,
  Download,
  Expand,
  Eye,
  EyeOff,
  LayoutGrid,
  Link2,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  MessagesSquare,
  Pencil,
  PenLine,
  Pin,
  Plus,
  Search,
  Share2,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createPortal } from "react-dom";
import {
  deletePinnedNote,
  getDesigner,
  listPinnedNotes,
  putPinnedNote,
  type StoredPinnedNote,
} from "@/app/db";
import { createDesignerAndChatFromHtml } from "@/app/lib/create";
import { createDesignerAndChatFromMarkdown } from "@/app/lib/create-from-markdown";
import { createChatFromPinnedNote } from "@/app/lib/seed-chat-from-pin";
import {
  setNoteAccountShared,
  subscribeAccountSyncPull,
} from "@/app/lib/account-sync";
import { PaperCard } from "@/app/components/paper-card";
import { PaperPill } from "@/app/components/paper-pill";
import { H1 } from "@/app/components/serif-heading";
import { TitleLogo } from "@/app/components/title-logo";
import { NewNoteDialog } from "@/app/components/new-note-dialog";
import { ImportDocumentDialog } from "@/app/components/import-document-dialog";
import { EditNoteDialog } from "@/app/components/edit-note-dialog";
import { ExportNoteDialog } from "@/app/components/export-note-dialog";
import { NoteReader } from "@/app/components/note-reader";
import { NoteViewer } from "@/app/components/note-viewer";
import { ShareNoteDialog } from "@/app/components/share-note-dialog";
import {
  CardActions,
  type CardActionItem,
} from "@/app/components/card-actions";
import { SortMenu, type SortOption } from "@/app/components/sort-menu";
import { Button } from "@/components/ui/button";
import { confirm } from "@/app/components/confirm";
import { toast } from "@/app/components/toast";
import { relativeTime } from "@/app/lib/visuals";
import { deriveNoteTitle, noteToPlainText, searchNotes } from "@/app/lib/note-title";
import { useNoteSort, type NoteSort } from "@/app/lib/sort-prefs";

const NOTE_SORT_OPTIONS: ReadonlyArray<SortOption<NoteSort>> = [
  { value: "edited", label: "Last edited" },
  { value: "created", label: "Recently created" },
];

export default function NotesIndex() {
  const router = useRouter();
  const [notes, setNotes] = useState<StoredPinnedNote[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [expandedNote, setExpandedNote] = useState<StoredPinnedNote | null>(null);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<StoredPinnedNote | null>(null);
  const [exportingNote, setExportingNote] = useState<StoredPinnedNote | null>(null);
  const [readingNote, setReadingNote] = useState<StoredPinnedNote | null>(null);
  const [viewingNote, setViewingNote] = useState<StoredPinnedNote | null>(null);
  const [sharingNote, setSharingNote] = useState<StoredPinnedNote | null>(null);
  const [convertingNoteId, setConvertingNoteId] = useState<string | null>(null);
  const [sort, setSort] = useNoteSort();
  const [query, setQuery] = useState("");

  const sortedNotes = useMemo(() => {
    const arr = [...notes];
    if (sort === "created") {
      arr.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      arr.sort(
        (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)
      );
    }
    return arr;
  }, [notes, sort]);

  const filteredNotes = useMemo(
    () => searchNotes(sortedNotes, query),
    [sortedNotes, query]
  );

  // "Edit in chat" on a pinned HTML artifact: spin up (or reuse) a designer
  // wired back to this note via sourceNoteId, then drop the user straight into
  // the chat editor. We deliberately skip the /apps/[id] interstitial — for a
  // static HTML pin the app view is a render-only mirror of the editor's
  // preview pane, and routing through it forced a second "Edit in chat" tap.
  // Every save in the designer rewrites this note's artifactHtml and refreshes
  // any live public share link (see syncDesignerToSourceNote).
  const onConvert = useCallback(
    async (note: StoredPinnedNote) => {
      if (!note.artifactHtml || convertingNoteId === note.id) return;
      if (note.convertedDesignerId) {
        const existing = await getDesigner(note.convertedDesignerId).catch(
          () => undefined
        );
        if (existing) {
          router.push(`/designer/${existing.id}`);
          return;
        }
      }
      setConvertingNoteId(note.id);
      try {
        const { designer } = await createDesignerAndChatFromHtml(
          note.artifactHtml,
          note.summary ?? note.title ?? "",
          { sourceNoteId: note.id, title: note.title }
        );
        const updated: StoredPinnedNote = {
          ...note,
          convertedDesignerId: designer.id,
          updatedAt: Date.now(),
        };
        await putPinnedNote(updated);
        setNotes((prev) =>
          prev.map((n) => (n.id === updated.id ? updated : n))
        );
        router.push(`/designer/${designer.id}`);
      } finally {
        setConvertingNoteId(null);
      }
    },
    [convertingNoteId, router]
  );

  // Turn a message/markdown note into an app (designer) from the Notes list.
  // This is the deliberate, explicit conversion point. It used to live as an
  // "Open as app" button inside the note-edit canvas, where a stray tap during
  // editing converted the note by accident; moving it here (a distinct step,
  // one level removed from editing) makes turning a note into an app an
  // intentional choice. Reuses an existing linked app when present.
  const onPromoteToApp = useCallback(
    async (note: StoredPinnedNote) => {
      if (!note.messageMarkdown || convertingNoteId === note.id) return;
      if (note.convertedDesignerId) {
        const existing = await getDesigner(note.convertedDesignerId).catch(
          () => undefined
        );
        if (existing) {
          router.push(`/designer/${existing.id}`);
          return;
        }
      }
      setConvertingNoteId(note.id);
      try {
        const { designer } = await createDesignerAndChatFromMarkdown(
          note.messageMarkdown,
          note.summary ?? note.title ?? "",
          { sourceNoteId: note.id, title: note.title }
        );
        const updated: StoredPinnedNote = {
          ...note,
          convertedDesignerId: designer.id,
          updatedAt: Date.now(),
        };
        await putPinnedNote(updated);
        setNotes((prev) =>
          prev.map((n) => (n.id === updated.id ? updated : n))
        );
        router.push(`/designer/${designer.id}`);
      } finally {
        setConvertingNoteId(null);
      }
    },
    [convertingNoteId, router]
  );

  // Seed a fresh free-form chat from the note's content and drop the user
  // straight into it. Distinct from "Open canvas" (which edits the note in
  // place) — this just injects a copy of the note as the opening assistant
  // turn so the user can riff on it without touching the original.
  const onNewChat = useCallback(
    async (note: StoredPinnedNote) => {
      const { chatId } = await createChatFromPinnedNote(note);
      router.push(`/chats/${chatId}`);
    },
    [router]
  );

  // Start a fresh chat that *references* the note read-only, the same way
  // attaching a note when creating a chat does. Unlike "New chat" (which
  // seeds an editable copy of the body), this pins the note as attached
  // context - the model reads it but never edits the original.
  const onReferenceInChat = useCallback(
    async (note: StoredPinnedNote) => {
      const { chatId } = await createChatFromPinnedNote(note, {
        attachAsReference: true,
      });
      router.push(`/chats/${chatId}`);
    },
    [router]
  );

  useEffect(() => {
    let cancelled = false;
    function load() {
      listPinnedNotes()
        .then((all) => {
          if (cancelled) return;
          setNotes(all);
          setHydrated(true);
        })
        .catch(() => {
          if (!cancelled) setHydrated(true);
        });
    }
    load();
    const unsubscribe = subscribeAccountSyncPull(() => {
      if (!cancelled) load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const removeNote = useCallback(async (note: StoredPinnedNote) => {
    const ok = await confirm({
      title: "Unpin this note?",
      body: "This removes the note from your scratchpad. It can't be undone.",
      confirmLabel: "Unpin",
      destructive: true,
    });
    if (!ok) return;
    setNotes((prev) => prev.filter((n) => n.id !== note.id));
    try {
      await deletePinnedNote(note.id);
      toast.success("Note unpinned");
    } catch (err) {
      console.error("delete pinned note failed", err);
      const fresh = await listPinnedNotes().catch(() => null);
      if (fresh) setNotes(fresh);
      toast.error("Couldn't unpin the note. Please try again.");
    }
  }, []);

  useEffect(() => {
    if (!expandedNote) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpandedNote(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [expandedNote]);

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top safe-x sticky top-0 z-10 border-b border-border/60 bg-background/85 pt-3 pb-3 backdrop-blur">
        <div className="reader-col flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <H1><TitleLogo />Notes</H1>
            <div className="flex items-center gap-3">
              <SortMenu
                value={sort}
                options={NOTE_SORT_OPTIONS}
                onChange={setSort}
              />
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                className="tap reader-label inline-flex items-center gap-1 hover:text-foreground"
              >
                <Upload className="h-3.5 w-3.5" />
                Import
              </button>
              <button
                type="button"
                onClick={() => setNewNoteOpen(true)}
                className="tap reader-label inline-flex items-center gap-1 hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                New note
              </button>
            </div>
          </div>
          {notes.length > 0 && (
            <div className="relative w-full">
              <Search className="pointer-events-none absolute top-1/2 left-0 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search notes…"
                aria-label="Search notes"
                className="h-9 w-full border-b border-border bg-transparent pl-6 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30"
              />
            </div>
          )}
        </div>
      </header>

      <div className="scroll-area safe-x min-h-0 flex-1 pb-24">
        <div className="reader-col pt-2 sm:pt-4">
          {!hydrated ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : sortedNotes.length === 0 ? (
            <div className="reader-serif mt-12 flex flex-col items-center gap-3 text-center text-muted-foreground italic">
              <p>
                No pinned notes yet. Tap the Pin icon on any chat artifact or
                assistant message to save it here for later — or use New note
                above to write one.
              </p>
            </div>
          ) : filteredNotes.length === 0 ? (
            <div className="reader-serif mt-12 flex flex-col items-center gap-3 text-center text-muted-foreground italic">
              <p>No notes match “{query}”.</p>
              <Button variant="outline" size="sm" onClick={() => setQuery("")} className="rounded-full not-italic">
                Clear search
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredNotes.map((n) => (
                <NoteCard
                  key={n.id}
                  note={n}
                  onUnpin={() => void removeNote(n)}
                  onEdit={() => setEditingNote(n)}
                  onExport={() => setExportingNote(n)}
                  onShare={() => setSharingNote(n)}
                  onRead={() => setReadingNote(n)}
                  onView={() => setViewingNote(n)}
                  onExpand={() => setExpandedNote(n)}
                  onConvert={() => void onConvert(n)}
                  onPromoteToApp={() => void onPromoteToApp(n)}
                  onOpenCanvas={() => router.push(`/notes/${n.id}/canvas`)}
                  onNewChat={() => void onNewChat(n)}
                  onReferenceInChat={() => void onReferenceInChat(n)}
                  converting={convertingNoteId === n.id}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {expandedNote && typeof document !== "undefined"
        ? createPortal(
            <HtmlFullscreen
              html={expandedNote.artifactHtml ?? ""}
              title={deriveNoteTitle(expandedNote)}
              note={expandedNote}
              converting={convertingNoteId === expandedNote.id}
              onConvert={() => void onConvert(expandedNote)}
              onClose={() => setExpandedNote(null)}
            />,
            document.body
          )
        : null}

      {readingNote && typeof document !== "undefined"
        ? createPortal(
            <NoteReader
              note={readingNote}
              onClose={() => setReadingNote(null)}
            />,
            document.body
          )
        : null}

      {viewingNote && typeof document !== "undefined"
        ? createPortal(
            <NoteViewer
              note={viewingNote}
              onClose={() => setViewingNote(null)}
            />,
            document.body
          )
        : null}

      <NewNoteDialog
        open={newNoteOpen}
        onClose={() => setNewNoteOpen(false)}
        onCreated={(note) => setNotes((prev) => [note, ...prev])}
      />

      <ImportDocumentDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onCreated={(note) => setNotes((prev) => [note, ...prev])}
      />

      <EditNoteDialog
        open={!!editingNote}
        note={editingNote}
        onClose={() => setEditingNote(null)}
        onSaved={(updated) =>
          setNotes((prev) =>
            prev.map((n) => (n.id === updated.id ? updated : n))
          )
        }
      />

      <ExportNoteDialog
        open={!!exportingNote}
        note={exportingNote}
        onClose={() => setExportingNote(null)}
      />

      <ShareNoteDialog
        open={!!sharingNote}
        note={sharingNote}
        onClose={() => setSharingNote(null)}
      />
    </div>
  );
}

function NoteCard({
  note,
  onUnpin,
  onEdit,
  onExport,
  onShare,
  onRead,
  onView,
  onExpand,
  onConvert,
  onPromoteToApp,
  onOpenCanvas,
  onNewChat,
  onReferenceInChat,
  converting,
}: {
  note: StoredPinnedNote;
  onUnpin: () => void;
  onEdit: () => void;
  onExport: () => void;
  onShare: () => void;
  onRead: () => void;
  onView: () => void;
  onExpand: () => void;
  onConvert: () => void;
  onPromoteToApp: () => void;
  onOpenCanvas: () => void;
  onNewChat: () => void;
  onReferenceInChat: () => void;
  converting: boolean;
}) {
  const hasArtifact = !!note.artifactHtml;
  const hasMessage = !!note.messageMarkdown;
  const hasSnapshot = !!note.chatSnapshot;
  const hasChatLink = note.linkToChat && note.chatId;
  const linkedAppId = note.convertedDesignerId;
  const noteTitle = deriveNoteTitle(note);

  const display = note.viewConfig?.display ?? "compact";
  const [revealed, setRevealed] = useState(display !== "hidden");
  const showBody = display !== "hidden" || revealed;
  const compact = display === "compact";

  const [copied, setCopied] = useState(false);
  const copyNote = useCallback(async () => {
    const text = noteToPlainText(note);
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
  }, [note]);

  // Optimistic toggle: flip the icon immediately, kick off the network write,
  // revert on failure. The shared library handles IDB and the account API.
  const [accountShared, setAccountShared] = useState<boolean>(
    !!note.accountShared
  );
  const [accountBusy, setAccountBusy] = useState(false);
  useEffect(() => {
    setAccountShared(!!note.accountShared);
  }, [note.accountShared]);
  const toggleAccountShared = async () => {
    if (accountBusy) return;
    const next = !accountShared;
    setAccountBusy(true);
    setAccountShared(next);
    try {
      await setNoteAccountShared(note.id, next);
      toast.success(next ? "Note syncing to your account" : "Stopped syncing note");
    } catch {
      setAccountShared(!next);
      toast.error("Couldn't change account sync. Please try again.");
    } finally {
      setAccountBusy(false);
    }
  };

  return (
    <PaperCard className="overflow-hidden rounded-lg p-0">
      <div className="flex items-center gap-3 border-b border-border/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {hasArtifact && <PaperPill tone="neutral">Artifact</PaperPill>}
            {hasMessage && <PaperPill tone="neutral">Message</PaperPill>}
            {hasSnapshot && <PaperPill tone="neutral">Chat copy</PaperPill>}
            {hasChatLink && <PaperPill tone="neutral">Link</PaperPill>}
            {linkedAppId && <PaperPill tone="neutral">Linked app</PaperPill>}
            {display === "compact" && <PaperPill tone="neutral">Compact</PaperPill>}
            {display === "hidden" && <PaperPill tone="neutral">Hidden</PaperPill>}
          </div>
          <div title={noteTitle} className="reader-serif mt-0.5 truncate text-[17px] text-foreground">
            {noteTitle}
          </div>
          <div
            title={note.chatTitle ? `From “${note.chatTitle}”` : "Pinned note"}
            className="reader-byline mt-0.5 truncate"
          >
            {note.chatTitle ? `From “${note.chatTitle}”` : "Pinned note"}
            <span className="font-mono tabular-nums not-italic"> · {relativeTime(note.createdAt)}</span>
          </div>
        </div>
        <NoteCardActions
          hasArtifact={hasArtifact}
          hasMessage={hasMessage}
          hasChatLink={!!hasChatLink}
          chatId={note.chatId}
          linkedAppId={linkedAppId}
          converting={converting}
          onConvert={onConvert}
          onPromoteToApp={onPromoteToApp}
          onOpenCanvas={onOpenCanvas}
          onNewChat={onNewChat}
          onReferenceInChat={onReferenceInChat}
          isHiddenDisplay={display === "hidden"}
          revealed={revealed}
          onToggleRevealed={() => setRevealed((v) => !v)}
          copied={copied}
          onCopy={() => void copyNote()}
          onRead={onRead}
          onView={onView}
          onEdit={onEdit}
          onExport={onExport}
          onShare={onShare}
          accountShared={accountShared}
          accountBusy={accountBusy}
          onToggleAccountShared={() => void toggleAccountShared()}
          onUnpin={onUnpin}
        />
      </div>

      {hasArtifact && showBody && (
        <div>
          <button
            type="button"
            onClick={onExpand}
            className="block w-full text-left"
            aria-label="Open fullscreen preview"
            title="Tap to open fullscreen"
          >
            <iframe
              title="Pinned artifact preview"
              srcDoc={note.artifactHtml}
              sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups"
              className={
                compact
                  ? "pointer-events-none block h-[140px] w-full border-0 bg-white"
                  : "pointer-events-none block h-[min(50svh,420px)] min-h-[280px] w-full border-0 bg-white"
              }
            />
          </button>
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
            <span className="reader-label">Artifact</span>
            {linkedAppId && (
              <span className="text-muted-foreground/80">
                · iterations in the linked app update this note
              </span>
            )}
            <button
              type="button"
              onClick={onExpand}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 transition hover:text-foreground"
            >
              <Maximize2 className="h-3 w-3" />
              Open
            </button>
          </div>
        </div>
      )}

      {hasMessage && showBody && (
        <div className={"border-b border-border/60 " + (compact ? "px-3 py-1.5" : "px-3 py-2")}>
          <div className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            {note.chatId ? "Message" : "Note"}
          </div>
          <div
            className={
              "note-prose prose prose-sm max-w-none break-words" +
              (compact ? " line-clamp-3" : "")
            }
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {note.messageMarkdown ?? ""}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {hasSnapshot && showBody && (
        <ChatSnapshot snapshot={note.chatSnapshot!} />
      )}
    </PaperCard>
  );
}

function ChatSnapshot({
  snapshot,
}: {
  snapshot: NonNullable<StoredPinnedNote["chatSnapshot"]>;
}) {
  const [open, setOpen] = useState(false);
  const messageCount = snapshot.messages.length;

  return (
    <div className="border-b border-border/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px]"
      >
        <span className="font-medium text-foreground">Chat copy</span>
        <span className="font-mono text-muted-foreground">
          · {messageCount} message{messageCount === 1 ? "" : "s"}
        </span>
        <span className="ml-auto text-muted-foreground">
          {open ? "Hide" : "Show"}
        </span>
      </button>
      {open && (
        <div className="border-t border-border/60 bg-muted/30 px-3 py-2">
          <div className="flex flex-col gap-2 text-xs">
            {snapshot.messages.map((m, i) => (
              <div key={i} className="flex flex-col gap-0.5">
                <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {m.role}
                </div>
                <div className="whitespace-pre-wrap break-words text-foreground/90">
                  {m.content}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NoteCardActions({
  hasArtifact,
  hasMessage,
  hasChatLink,
  chatId,
  linkedAppId,
  converting,
  onConvert,
  onPromoteToApp,
  onOpenCanvas,
  onNewChat,
  onReferenceInChat,
  isHiddenDisplay,
  revealed,
  onToggleRevealed,
  copied,
  onCopy,
  onRead,
  onView,
  onEdit,
  onExport,
  onShare,
  accountShared,
  accountBusy,
  onToggleAccountShared,
  onUnpin,
}: {
  hasArtifact: boolean;
  hasMessage: boolean;
  hasChatLink: boolean;
  chatId?: string;
  linkedAppId?: string;
  converting: boolean;
  onConvert: () => void;
  onPromoteToApp: () => void;
  onOpenCanvas: () => void;
  onNewChat: () => void;
  onReferenceInChat: () => void;
  isHiddenDisplay: boolean;
  revealed: boolean;
  onToggleRevealed: () => void;
  copied: boolean;
  onCopy: () => void;
  onRead: () => void;
  onView: () => void;
  onEdit: () => void;
  onExport: () => void;
  onShare: () => void;
  accountShared: boolean;
  accountBusy: boolean;
  onToggleAccountShared: () => void;
  onUnpin: () => void;
}) {
  const syncIcon = accountBusy ? (
    <Loader2 className="h-4 w-4 animate-spin" />
  ) : accountShared ? (
    <Cloud className="h-4 w-4" />
  ) : (
    <CloudOff className="h-4 w-4" />
  );

  const actions: CardActionItem[] = [
    {
      key: "view",
      label: "View note",
      ariaLabel: "Open the full note in its native style",
      icon: Expand,
      onSelect: onView,
    },
    {
      key: "canvas",
      label: "Open canvas",
      ariaLabel: "Open the canvas editor — chat with the AI while it edits the note live",
      icon: Pencil,
      onSelect: onOpenCanvas,
    },
    {
      key: "read",
      label: "Read",
      ariaLabel: "Open in distraction-free reader",
      icon: BookOpen,
      onSelect: onRead,
    },
    {
      key: "edit",
      label: "Quick edit",
      ariaLabel: "Edit note title and body in a dialog",
      icon: PenLine,
      onSelect: onEdit,
    },
    {
      key: "copy",
      label: copied ? "Copied" : "Copy note",
      icon: copied ? <Check className="h-4 w-4 text-emerald-600" /> : Copy,
      onSelect: onCopy,
      active: copied,
    },
    {
      key: "link",
      label: "Open source chat",
      icon: Link2,
      href: hasChatLink && chatId ? `/chats/${chatId}` : undefined,
      hidden: !hasChatLink,
    },
    {
      key: "newChat",
      label: "New chat",
      ariaLabel:
        "Start a new chat seeded with a copy of this note's content",
      icon: MessageSquarePlus,
      onSelect: onNewChat,
    },
    {
      key: "referenceChat",
      label: "Reference in new chat",
      ariaLabel:
        "Start a new chat that references this note read-only, without editing it",
      icon: MessagesSquare,
      onSelect: onReferenceInChat,
    },
    {
      key: "convert",
      label: "Edit in chat",
      ariaLabel:
        "Edit this artifact in the AI chat — your changes save back to this note",
      icon: converting ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        Wand2
      ),
      onSelect: onConvert,
      hidden: !hasArtifact,
      disabled: converting,
    },
    {
      key: "promoteApp",
      label: "Turn into app",
      ariaLabel:
        "Turn this note into an editable app - its content seeds a new app you can build on",
      icon: converting ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        LayoutGrid
      ),
      onSelect: onPromoteToApp,
      // Message/markdown notes only (artifacts use "Edit in chat"). Hidden once
      // a linked app exists - "Open as app" below covers that case.
      hidden: !hasMessage || !!linkedAppId,
      disabled: converting,
    },
    {
      key: "openApp",
      label: "Open as app",
      ariaLabel: "Open the linked app view (renders the artifact full-screen)",
      icon: LayoutGrid,
      href: linkedAppId ? `/apps/${linkedAppId}` : undefined,
      hidden: !linkedAppId,
    },
    {
      key: "hide",
      label: revealed ? "Hide body" : "Show body",
      icon: revealed ? EyeOff : Eye,
      onSelect: onToggleRevealed,
      hidden: !isHiddenDisplay,
      pressed: revealed,
    },
    {
      key: "download",
      label: "Export",
      ariaLabel: "Export note",
      icon: Download,
      onSelect: onExport,
    },
    {
      key: "share",
      label: "Share public link (7 days)",
      ariaLabel: "Share a public link to this note",
      icon: Share2,
      onSelect: onShare,
    },
    {
      key: "sync",
      label: accountShared ? "Stop syncing to account" : "Sync to account",
      icon: syncIcon,
      onSelect: onToggleAccountShared,
      disabled: accountBusy,
      pressed: accountShared,
      active: accountShared,
    },
    {
      key: "delete",
      label: "Unpin note",
      icon: Trash2,
      onSelect: onUnpin,
      destructive: true,
    },
  ];

  return (
    <CardActions
      actions={actions}
      primaryKeys={
        hasArtifact ? ["view", "canvas", "share"] : ["view", "canvas", "copy"]
      }
    />
  );
}

function HtmlFullscreen({
  html,
  title,
  note,
  converting,
  onConvert,
  onClose,
}: {
  html: string;
  title?: string;
  note: StoredPinnedNote;
  converting: boolean;
  onConvert: () => void;
  onClose: () => void;
}) {
  const hasArtifact = !!note.artifactHtml;
  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-card"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Pinned artifact fullscreen preview"
    >
      <div className="flex items-center gap-2 border-b border-border bg-card/95 px-3 py-2 text-[11px] text-muted-foreground backdrop-blur">
        <Pin className="h-3 w-3 text-primary/80" />
        <span className="font-medium text-foreground">
          {title ?? "Pinned artifact"}
        </span>
        {hasArtifact && (
          <Button
            type="button"
            size="sm"
            onClick={onConvert}
            disabled={converting}
            className="ml-auto gap-1.5"
            title="Open this artifact in the AI chat — your changes save back to this note"
          >
            {converting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wand2 className="h-3.5 w-3.5" />
            )}
            Edit in chat
          </Button>
        )}
        <button
          type="button"
          onClick={onClose}
          className={
            (hasArtifact ? "" : "ml-auto ") +
            "inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition hover:text-foreground"
          }
          aria-label="Close fullscreen preview"
          title="Close (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <iframe
        title="Pinned artifact preview"
        srcDoc={html}
        sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups"
        className="block min-h-0 w-full flex-1 border-0 bg-white"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      />
    </div>
  );
}

