"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, RotateCcw, Trash2 } from "lucide-react";
import {
  CHAT_TRASH_RETENTION_MS,
  deleteChat,
  listArchivedChats,
  purgeArchivedChatsOlderThan,
  restoreChat,
  type StoredChat,
} from "@/app/db";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/app/lib/visuals";
import { CharacterAvatar } from "@/app/components/character-avatar";
import { PaperCard } from "@/app/components/paper-card";
import { H1 } from "@/app/components/serif-heading";
import { confirm } from "@/app/components/confirm";
import { toast } from "@/app/components/toast";

const DAY_MS = 24 * 60 * 60 * 1000;

function purgesIn(archivedAt: number): string {
  const remaining = archivedAt + CHAT_TRASH_RETENTION_MS - Date.now();
  if (remaining <= 0) return "purges any moment";
  const days = Math.ceil(remaining / DAY_MS);
  if (days <= 1) {
    const hours = Math.max(1, Math.ceil(remaining / (60 * 60 * 1000)));
    return `purges in ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `purges in ${days} day${days === 1 ? "" : "s"}`;
}

export default function ChatsTrash() {
  const [archived, setArchived] = useState<StoredChat[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        await purgeArchivedChatsOlderThan(Date.now() - CHAT_TRASH_RETENTION_MS);
      } catch (err) {
        console.error("purge archived chats failed", err);
      }
      try {
        setArchived(await listArchivedChats());
      } finally {
        setHydrated(true);
      }
    })();
  }, []);

  async function onRestore(chat: StoredChat) {
    setArchived((prev) => prev.filter((c) => c.id !== chat.id));
    try {
      await restoreChat(chat.id);
    } catch (err) {
      console.error("restore chat failed", err);
      const fresh = await listArchivedChats().catch(() => null);
      if (fresh) setArchived(fresh);
    }
  }

  async function onDeleteNow(chat: StoredChat) {
    const ok = await confirm({
      title: "Delete permanently?",
      body: `"${chat.title}" and all of its messages will be removed. This cannot be undone.`,
      confirmLabel: "Delete forever",
      destructive: true,
    });
    if (!ok) return;
    setArchived((prev) => prev.filter((c) => c.id !== chat.id));
    try {
      await deleteChat(chat.id);
      toast.success("Chat deleted");
    } catch (err) {
      console.error("delete chat failed", err);
      const fresh = await listArchivedChats().catch(() => null);
      if (fresh) setArchived(fresh);
      toast.error("Couldn't delete the chat. Please try again.");
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top safe-x sticky top-0 z-10 border-b border-border/60 bg-background/85 pt-3 pb-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 sm:flex-row sm:items-end sm:justify-between sm:px-6">
          <div className="flex min-w-0 items-start gap-2">
            <Link
              href="/chats"
              aria-label="Back to chats"
              className="tap inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-foreground hover:bg-muted"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="min-w-0">
              <H1>Trash</H1>
              <p className="mt-1 text-sm text-muted-foreground">
                Archived chats are kept for 7 days, then permanently deleted.
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="scroll-area safe-x flex-1 pb-6">
        <div className="mx-auto w-full max-w-3xl px-4 pt-4 sm:px-6 sm:pt-6">
          {hydrated && archived.length === 0 ? (
            <PaperCard className="mt-6 flex flex-col items-center gap-2 rounded-3xl p-10 text-center text-sm text-muted-foreground">
              <p>Trash is empty.</p>
            </PaperCard>
          ) : (
            <div className="flex flex-col gap-2">
              {archived.map((c) => {
                const swatchId =
                  c.target?.kind === "designer" || c.target?.kind === "app"
                    ? c.target.id
                    : c.target?.kind === "note-canvas"
                      ? c.target.noteId
                      : c.id;
                const archivedAt = c.archivedAt ?? Date.now();
                return (
                  <PaperCard
                    key={c.id}
                    className="flex min-h-[60px] items-center gap-3 rounded-2xl p-3"
                  >
                    <CharacterAvatar
                      id={swatchId}
                      title={c.title}
                      className="h-10 w-10 shrink-0 overflow-hidden rounded-xl border border-border opacity-70"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-medium">{c.title}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        Archived {relativeTime(archivedAt)} · {purgesIn(archivedAt)}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void onRestore(c)}
                      className="gap-1.5"
                      aria-label={`Restore chat "${c.title}"`}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Restore</span>
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void onDeleteNow(c)}
                      className="gap-1.5"
                      aria-label={`Permanently delete chat "${c.title}"`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Delete now</span>
                    </Button>
                  </PaperCard>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
