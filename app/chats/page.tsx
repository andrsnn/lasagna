"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Cloud, Plus, Search, X } from "lucide-react";
import {
  CHAT_TRASH_RETENTION_MS,
  archiveChat,
  autoArchiveExpiredChats,
  listApps,
  listArchivedChats,
  listChats,
  listDesigners,
  loadMessages,
  loadStreamingChatIds,
  newId,
  purgeArchivedChatsOlderThan,
  putChat,
  type StoredApp,
  type StoredChat,
  type StoredDesigner,
  type StoredMessage,
} from "@/app/db";
import { ChatTtlChip, readChatTtl } from "@/app/components/chat-ttl-chip";
import { CharacterAvatar } from "@/app/components/character-avatar";
import { buttonVariants } from "@/components/ui/button";
import { relativeTime } from "@/app/lib/visuals";
import { H1 } from "@/app/components/serif-heading";
import { TitleLogo } from "@/app/components/title-logo";
import { generateChatTitle, shouldGenerateChatTitle } from "@/app/lib/chat-title";
import { useDebouncedValue } from "@/app/lib/use-debounced-value";
import {
  ensureFreshChatIndex,
  useChatIndexStatus,
} from "@/app/lib/chat-index-store";
import { searchChatIndex } from "@/app/lib/chat-search";
import { subscribeAccountSyncPull } from "@/app/lib/account-sync";
import { confirm } from "@/app/components/confirm";
import { toast } from "@/app/components/toast";
import { ShareChatDialog } from "@/app/components/share-chat-dialog";
import { SortMenu, type SortOption } from "@/app/components/sort-menu";
import { useChatSort, type ChatSort } from "@/app/lib/sort-prefs";

const CHAT_SORT_OPTIONS: ReadonlyArray<SortOption<ChatSort>> = [
  { value: "activity", label: "Last activity" },
  { value: "created", label: "Recently created" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Title (A–Z)" },
];

export default function ChatsIndex() {
  const router = useRouter();
  const [chats, setChats] = useState<StoredChat[]>([]);
  const [designers, setDesigners] = useState<StoredDesigner[]>([]);
  const [apps, setApps] = useState<StoredApp[]>([]);
  const [trashCount, setTrashCount] = useState(0);
  const [streamingIds, setStreamingIds] = useState<Set<string>>(() => new Set());
  const [hydrated, setHydrated] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useChatSort();
  const debouncedQuery = useDebouncedValue(query, 150);
  const indexStatus = useChatIndexStatus();
  // Chat targeted by the Share/sync dialog. Opened straight from the list row so
  // a chat that crashes when opened can still be synced to the account, shared
  // as a link, or exported as raw JSON — the dialog only reads messages, it
  // never mounts the (crashing) chat view.
  const [shareChat, setShareChat] = useState<StoredChat | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Re-fetched on focus / visibility-change so a chat that finished
    // streaming in another tab (or was open in the background) flips
    // from "Working" to "Ready" the moment the user comes back. We
    // pull chats + streaming-state together so updatedAt and the
    // status badge can never disagree.
    const refresh = async (opts: { withTrash?: boolean } = {}) => {
      try {
        const [c, s] = await Promise.all([listChats(), loadStreamingChatIds()]);
        if (cancelled) return;
        setChats(c);
        setStreamingIds(s);
        if (opts.withTrash) {
          const t = await listArchivedChats().catch(() => null);
          if (!cancelled && t) setTrashCount(t.length);
        }
      } catch (err) {
        console.error("refresh chats failed", err);
      }
    };
    (async () => {
      try {
        await autoArchiveExpiredChats();
      } catch (err) {
        console.error("auto-archive expired chats failed", err);
      }
      try {
        await purgeArchivedChatsOlderThan(Date.now() - CHAT_TRASH_RETENTION_MS);
      } catch (err) {
        console.error("purge archived chats failed", err);
      }
      try {
        const [c, d, a, t, s] = await Promise.all([
          listChats(),
          listDesigners(),
          listApps(),
          listArchivedChats(),
          loadStreamingChatIds(),
        ]);
        if (cancelled) return;
        setChats(c);
        setDesigners(d);
        setApps(a);
        setTrashCount(t.length);
        setStreamingIds(s);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    const onFocus = () => void refresh({ withTrash: true });
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh({ withTrash: true });
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribe = subscribeAccountSyncPull(() => {
      if (!cancelled) void refresh({ withTrash: true });
    });
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
    };
  }, []);

  const designerById = new Map(designers.map((d) => [d.id, d]));
  const appById = new Map(apps.map((a) => [a.id, a]));

  // Keep the persisted search index in sync with what's in IDB. Cheap
  // when nothing changed; runs a per-chat patch when chats were added,
  // updated, or deleted since the last visit.
  useEffect(() => {
    if (!hydrated) return;
    void ensureFreshChatIndex(chats);
  }, [hydrated, chats]);

  const trimmedQuery = debouncedQuery.trim();
  const isSearching = trimmedQuery.length > 0;

  const searchHits = useMemo(() => {
    if (!isSearching) return null;
    if (indexStatus.kind !== "ready") return null;
    return searchChatIndex(indexStatus.index, trimmedQuery, 50);
  }, [isSearching, trimmedQuery, indexStatus]);

  const chatById = useMemo(() => {
    const m = new Map<string, StoredChat>();
    for (const c of chats) m.set(c.id, c);
    return m;
  }, [chats]);

  // Applies to the plain (non-search) list only. When searching, rows keep the
  // index's relevance order — re-sorting there would bury the best matches.
  const sortedChats = useMemo(() => {
    const arr = [...chats];
    switch (sort) {
      case "created":
        arr.sort((a, b) => b.createdAt - a.createdAt);
        break;
      case "oldest":
        arr.sort((a, b) => a.createdAt - b.createdAt);
        break;
      case "name":
        arr.sort((a, b) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
        );
        break;
      default:
        // "activity" — newest touched first (matches listChats()'s default).
        arr.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return arr;
  }, [chats, sort]);

  type DisplayRow = { chat: StoredChat; preview?: string };
  const displayRows: DisplayRow[] = useMemo(() => {
    if (!isSearching) return sortedChats.map((chat) => ({ chat }));
    if (!searchHits) return [];
    const rows: DisplayRow[] = [];
    for (const hit of searchHits) {
      const chat = chatById.get(hit.chatId);
      if (!chat) continue;
      rows.push({ chat, preview: hit.preview || undefined });
    }
    return rows;
  }, [isSearching, searchHits, sortedChats, chatById]);

  const indexHint = (() => {
    if (!isSearching) return null;
    if (indexStatus.kind === "loading") {
      const verb = indexStatus.mode === "rebuild" ? "Rebuilding" : "Indexing";
      return `${verb} ${indexStatus.chatCount} chat${indexStatus.chatCount === 1 ? "" : "s"}…`;
    }
    if (indexStatus.kind === "error") return "Search index unavailable";
    if (indexStatus.kind === "ready") {
      const n = indexStatus.index.numChats;
      return `${displayRows.length} of ${n} chat${n === 1 ? "" : "s"}`;
    }
    return null;
  })();

  // Lazy auto-title: chats with placeholder titles never get renamed unless the
  // user re-opens them, so the list page kicks off generation in the background
  // for any stale entry. The lib coalesces concurrent calls per-chat and caps
  // global concurrency, so iterating the full list is safe.
  const titleAttempted = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    const candidates = chats.filter(
      (c) => shouldGenerateChatTitle(c) && !titleAttempted.current.has(c.id)
    );
    if (candidates.length === 0) return;
    void (async () => {
      for (const chat of candidates) {
        if (cancelled) return;
        titleAttempted.current.add(chat.id);
        const messages = await loadMessages(chat.id).catch(
          () => [] as StoredMessage[]
        );
        const hasFinishedAssistant = messages.some(
          (m) => m.role === "assistant" && !m.streamId && m.kind !== "summary" && m.content?.trim()
        );
        const hasUser = messages.some((m) => m.role === "user" && m.content?.trim());
        if (!hasFinishedAssistant || !hasUser) continue;
        const target = (() => {
          const t = chat.target;
          if (t?.kind === "designer") return { designer: designers.find((d) => d.id === t.id) };
          if (t?.kind === "app") return { app: apps.find((a) => a.id === t.id) };
          return {};
        })();
        void generateChatTitle(chat, messages, target).then((title) => {
          if (cancelled || !title) return;
          setChats((prev) =>
            prev.map((c) =>
              c.id === chat.id
                ? { ...c, title, titleSource: "gemma", titleUpdatedAt: Date.now() }
                : c
            )
          );
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrated, chats, designers, apps]);

  function newChat() {
    // Just navigate to a fresh id; the detail page lazily creates the chat
    // row if it doesn't exist. Avoids stranding the user on a clicked button
    // when IDB is slow/wedged/scoped-to-the-wrong-user, and makes the New
    // chat affordance behave like a plain Link (no async work in the click
    // handler that could swallow the event).
    const id = newId();
    router.push(`/chats/${id}`);
  }

  async function updateChatTtl(
    chat: StoredChat,
    patch: Pick<StoredChat, "ttlExpiresAt" | "ttlPausedRemainingMs" | "ttlDurationMs">
  ) {
    const next: StoredChat = { ...chat, ...patch };
    setChats((prev) => prev.map((x) => (x.id === chat.id ? next : x)));
    try {
      await putChat(next);
    } catch (err) {
      console.error("update chat ttl failed", err);
      const fresh = await listChats().catch(() => null);
      if (fresh) setChats(fresh);
    }
  }

  async function archiveChatRow(chat: StoredChat) {
    const ok = await confirm({
      title: "Move to trash?",
      body: `"${chat.title}" will be permanently deleted in 7 days. You can restore it from Trash before then.`,
      confirmLabel: "Move to trash",
      destructive: true,
    });
    if (!ok) return;
    setChats((prev) => prev.filter((x) => x.id !== chat.id));
    setTrashCount((n) => n + 1);
    try {
      await archiveChat(chat.id);
      toast.success("Moved to trash");
    } catch (err) {
      console.error("archive chat failed", err);
      const fresh = await listChats().catch(() => null);
      if (fresh) setChats(fresh);
      const freshTrash = await listArchivedChats().catch(() => null);
      if (freshTrash) setTrashCount(freshTrash.length);
      toast.error("Couldn't move the chat to trash. Please try again.");
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top safe-x sticky top-0 z-10 border-b border-border/60 bg-background/85 pt-3 pb-3 backdrop-blur">
        <div className="reader-col flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <H1><TitleLogo />Chats</H1>
            <div className="flex items-center gap-3">
              {!isSearching && chats.length > 1 && (
                <SortMenu
                  value={sort}
                  options={CHAT_SORT_OPTIONS}
                  onChange={setSort}
                />
              )}
              {trashCount > 0 && (
                <Link
                  href="/chats/trash"
                  className="tap reader-label hover:text-foreground"
                >
                  Trash ({trashCount})
                </Link>
              )}
              <button
                type="button"
                onClick={newChat}
                className={buttonVariants({ variant: "default", size: "sm" }) + " gap-1.5 rounded-full"}
              >
                <Plus className="h-3.5 w-3.5" />
                New chat
              </button>
            </div>
          </div>
          <div className="relative w-full">
            <Search className="pointer-events-none absolute top-1/2 left-0 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats…"
              aria-label="Search chats"
              className="h-9 w-full border-b border-border bg-transparent pr-8 pl-6 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="tap absolute top-1/2 right-0 -translate-y-1/2 rounded-md p-1 text-muted-foreground/70 hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="scroll-area safe-x min-h-0 flex-1 pb-16">
        <div className="reader-col pt-2 sm:pt-4">
          {indexHint && (
            <div className="mb-2 px-1 text-xs text-muted-foreground">{indexHint}</div>
          )}
          {hydrated && chats.length === 0 ? (
            <div className="reader-serif mt-12 flex flex-col items-center gap-4 text-center text-muted-foreground italic">
              <p>No chats yet — start one to ask the model anything, plan a new app, or just think out loud.</p>
              <button
                type="button"
                onClick={newChat}
                className={buttonVariants({ variant: "default" }) + " gap-1.5 rounded-full not-italic"}
              >
                <Plus className="h-3.5 w-3.5" />
                New chat
              </button>
            </div>
          ) : isSearching && displayRows.length === 0 && indexStatus.kind === "ready" ? (
            <div className="reader-serif mt-12 text-center text-muted-foreground italic">
              <p>No chats match &ldquo;{trimmedQuery}&rdquo;.</p>
            </div>
          ) : (
            <div className="flex flex-col">
              {displayRows.map(({ chat: c, preview }) => {
                const target = c.target;
                const linkedDesigner = target?.kind === "designer" ? designerById.get(target.id) : undefined;
                const linkedApp = target?.kind === "app" ? appById.get(target.id) : undefined;
                const noteId =
                  target?.kind === "note-canvas" ? target.noteId : c.canvasForNoteId;
                // Status badge:
                //   working — server is mid-stream on a message in this chat
                //   unread  — chat has new content since the user last opened it
                //   seen    — nothing to surface
                // `lastViewedAt ?? createdAt` keeps pre-feature chats from all
                // lighting up "unread" the first time the user lands here.
                const isStreaming = streamingIds.has(c.id);
                const viewedAt = c.lastViewedAt ?? c.createdAt;
                const status: "working" | "unread" | "seen" = isStreaming
                  ? "working"
                  : c.updatedAt > viewedAt
                    ? "unread"
                    : "seen";
                const defaultSubtitle =
                  target?.kind === "designer"
                    ? `Editing designer · ${linkedDesigner?.name ?? "(missing)"}`
                    : target?.kind === "app"
                      ? `Using app · ${linkedApp?.name ?? "(missing)"}`
                      : target?.kind === "note-canvas"
                        ? "Canvas · pinned note"
                        : "Free-form";
                const subtitle = preview ?? defaultSubtitle;
                // Canvas chats live behind /notes/[id]/canvas — route directly
                // there so the user gets the split-pane editor instead of the
                // generic chat viewer (which has no preview).
                const chatHref = noteId
                  ? `/notes/${noteId}/canvas?chat=${c.id}`
                  : `/chats/${c.id}`;
                return (
                  <div key={c.id} className="group relative">
                    <Link href={chatHref} className="tap reader-row block pr-36 transition hover:bg-secondary/20">
                      {/* .reader-row is unlayered CSS, so its display:block wins
                          over the flex utility on the Link itself — the flex
                          container has to be this inner div. */}
                      <div className="flex min-w-0 items-center gap-3">
                      <CharacterAvatar
                        id={noteId ?? c.id}
                        title={c.title}
                        className="h-11 w-11 shrink-0 overflow-hidden rounded-2xl"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <div title={c.title} className="reader-serif truncate text-[17px] text-foreground">{c.title}</div>
                          {status === "working" ? (
                            <span
                              className="reader-label inline-flex shrink-0 items-center gap-1.5 text-amber-600 dark:text-amber-400"
                              aria-label="Still working"
                              title="Still working"
                            >
                              <span className="relative inline-flex h-1.5 w-1.5">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500/60" />
                                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
                              </span>
                              Working
                            </span>
                          ) : status === "unread" ? (
                            <span
                              className="reader-label inline-flex shrink-0 items-center gap-1.5 text-emerald-700 dark:text-emerald-400"
                              aria-label="New since you last looked"
                              title="New since you last looked"
                            >
                              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                              Ready
                            </span>
                          ) : null}
                        </div>
                        <div className="reader-byline flex min-w-0 items-center gap-1.5">
                          <span title={subtitle} className="truncate">{subtitle}</span>
                          <span aria-hidden className="shrink-0 opacity-50">·</span>
                          <span className="shrink-0 font-mono tabular-nums not-italic">
                            {relativeTime(c.updatedAt)}
                          </span>
                        </div>
                      </div>
                      </div>
                    </Link>
                    {/* TTL chip lives outside the Link so its dropdown trigger
                        isn't a button nested inside an anchor (invalid HTML +
                        causes the click to also navigate in some browsers).
                        Hidden when no timer is set so the default "∞" state
                        doesn't crowd out the title — TTL can still be set from
                        inside the chat. */}
                    {readChatTtl(c).kind !== "off" && (
                      <div className="absolute top-1/2 right-[5.5rem] -translate-y-1/2">
                        <ChatTtlChip
                          chat={c}
                          compact
                          onChange={(patch) => updateChatTtl(c, patch)}
                        />
                      </div>
                    )}
                    {/* Row actions live outside the Link. Sync/share is always
                        shown (on mobile) so a chat that crashes on open can still
                        be synced to the account, shared as a link, or exported as
                        JSON; archive keeps its hover-reveal on desktop. */}
                    <div className="absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-1 focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
                      <button
                        type="button"
                        aria-label={`Sync or share chat "${c.title}"`}
                        title="Sync to account / share / export (works even if the chat won't open)"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setShareChat(c);
                        }}
                        className="tap rounded-md bg-background/80 p-1.5 text-muted-foreground/70 backdrop-blur-sm transition hover:bg-secondary hover:text-foreground"
                      >
                        <Cloud className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Archive chat "${c.title}"`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void archiveChatRow(c);
                        }}
                        className="tap rounded-md bg-background/80 p-1.5 text-muted-foreground/70 backdrop-blur-sm transition hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Archive className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {shareChat && (
        <ShareChatDialog
          open={!!shareChat}
          chat={shareChat}
          onClose={() => setShareChat(null)}
          onSyncChange={() => {
            void listChats()
              .then((c) => setChats(c))
              .catch(() => {});
          }}
        />
      )}
    </div>
  );
}
