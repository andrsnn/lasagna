"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronRight, Cloud, Copy, Download, Loader2, Share2, Trash2 } from "lucide-react";
import { toast } from "@/app/components/toast";
import { downloadChat } from "@/app/lib/export-chat";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loadMessages, type StoredChat, type StoredMessage } from "@/app/db";
import { setChatAccountShared } from "@/app/lib/account-sync";

type Stage =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "ready"; url: string; summary: string; expiresAt: number }
  | { kind: "error"; message: string };

export function ShareChatDialog({
  open,
  onClose,
  onSyncChange,
  chat,
  targetName,
}: {
  open: boolean;
  onClose: () => void;
  onSyncChange?: () => void;
  chat: StoredChat;
  targetName?: string;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [includeImages, setIncludeImages] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [messages, setMessages] = useState<StoredMessage[] | null>(null);
  const [accountShared, setAccountShared] = useState<boolean>(
    !!chat.accountShared
  );
  const [accountBusy, setAccountBusy] = useState(false);
  // Advanced disclosure hides the debug JSON export behind a toggle so it
  // doesn't clutter the everyday share/sync flow.
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    setAccountShared(!!chat.accountShared);
  }, [chat.accountShared]);

  const handleToggleAccountShare = useCallback(
    async (next: boolean) => {
      setAccountBusy(true);
      const prev = accountShared;
      setAccountShared(next);
      try {
        await setChatAccountShared(chat.id, next);
        onSyncChange?.();
      } catch {
        setAccountShared(prev);
      } finally {
        setAccountBusy(false);
      }
    },
    [accountShared, chat.id, onSyncChange]
  );

  // Load the chat's messages from IDB only while the dialog is open. Reading
  // up front for every chat would balloon memory on long histories.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const all = await loadMessages(chat.id);
      if (!cancelled) setMessages(all);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, chat.id]);

  const reset = useCallback(() => {
    setStage({ kind: "idle" });
    setCopied(false);
    setRevoking(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const handleRevoke = useCallback(async () => {
    if (stage.kind !== "ready" || revoking) return;
    const token = stage.url.split("/").pop() ?? "";
    if (!token) return;
    setRevoking(true);
    try {
      const res = await fetch("/api/share-chat-revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}.`);
      toast.success("Link revoked — it no longer works");
      handleClose();
    } catch {
      toast.error("Couldn't revoke the link. Please try again.");
      setRevoking(false);
    }
  }, [stage, revoking, handleClose]);

  const handleGenerate = useCallback(async () => {
    if (!messages) return;
    setStage({ kind: "uploading" });
    try {
      const res = await fetch("/api/share-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat, messages, includeImages, targetName }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        summary?: string;
        expiresAt?: number;
        error?: string;
      };
      if (!res.ok || !body.url || !body.summary || !body.expiresAt) {
        setStage({
          kind: "error",
          message: body.error ?? `Server returned ${res.status}.`,
        });
        return;
      }
      const fullUrl = `${window.location.origin}${body.url}`;
      setStage({
        kind: "ready",
        url: fullUrl,
        summary: body.summary,
        expiresAt: body.expiresAt,
      });
    } catch (err) {
      setStage({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Failed to create share link.",
      });
    }
  }, [chat, messages, includeImages, targetName]);

  const handleCopy = useCallback(async () => {
    if (stage.kind !== "ready") return;
    try {
      await navigator.clipboard.writeText(stage.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      const el = document.getElementById(
        "share-chat-url-input"
      ) as HTMLInputElement | null;
      el?.select();
    }
  }, [stage]);

  const messageCount = messages?.filter(
    (m) => m.kind !== "summary" && !m.summarizedInto && m.role !== "system"
  ).length;
  const hasImages = !!messages?.some((m) => m.images && m.images.length > 0);

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? handleClose() : null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4" />
            Share &ldquo;{chat.title}&rdquo;
          </DialogTitle>
        </DialogHeader>

        {stage.kind === "idle" || stage.kind === "uploading" ? (
          <div className="flex flex-col gap-4">
            <section className="flex flex-col gap-1.5">
              <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Keep on your devices
              </div>
              <label className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
                <input
                  type="checkbox"
                  checked={accountShared}
                  onChange={(e) => void handleToggleAccountShare(e.target.checked)}
                  disabled={accountBusy}
                  className="mt-0.5"
                />
                <span className="flex-1">
                  <span className="flex items-center gap-1.5 font-medium text-foreground">
                    <Cloud className="h-3.5 w-3.5" /> Sync to account
                    {accountBusy ? (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                    ) : accountShared ? (
                      <span className="inline-flex items-center gap-0.5 rounded-sm bg-emerald-500/15 px-1 py-px text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                        <Check className="h-2.5 w-2.5" /> On
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-muted-foreground">
                    Saves instantly. Keep this chat on every browser you sign
                    in from — continue on desktop, pick back up on your phone.
                  </span>
                </span>
              </label>
              {/* Raw JSON export — a debugging escape hatch, tucked behind an
                  Advanced disclosure so it stays out of the everyday flow.
                  Downloads the full chat + messages verbatim (image blobs
                  elided) so a chat that crashes on open can still be inspected
                  on another device. */}
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
                className="inline-flex items-center gap-1 self-start text-[11px] text-muted-foreground transition hover:text-foreground"
              >
                <ChevronRight
                  className={`h-3 w-3 transition-transform ${showAdvanced ? "rotate-90" : ""}`}
                />
                Advanced
              </button>
              {showAdvanced ? (
                <button
                  type="button"
                  onClick={() => {
                    if (!messages) return;
                    downloadChat(chat, messages, "json");
                    toast.success("Downloaded chat JSON");
                  }}
                  disabled={messages == null}
                  className="inline-flex items-center gap-1.5 self-start rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition hover:text-foreground disabled:opacity-50"
                >
                  <Download className="h-3 w-3" />
                  Download raw data (JSON, for debugging)
                </button>
              ) : null}
            </section>

            <div className="flex items-center gap-2 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>

            <section className="flex flex-col gap-1.5">
              <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Send to someone else
              </div>
              <p className="text-xs text-muted-foreground">
                Create a 7-day import link. The summary is generated by Gemma
                and shown to the recipient. Press <span className="font-medium text-foreground">Generate link</span> below to create it.
              </p>
              {messages == null ? (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading messages…
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground">
                  {messageCount ?? 0} message{messageCount === 1 ? "" : "s"} will be shared.
                </div>
              )}
              {hasImages ? (
                <label className="mt-1 flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
                  <input
                    type="checkbox"
                    checked={includeImages}
                    onChange={(e) => setIncludeImages(e.target.checked)}
                    disabled={stage.kind === "uploading"}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-foreground">Include image attachments</span>
                    <span className="block text-muted-foreground">
                      Adds the photos you attached. Larger payload — may exceed the size limit.
                    </span>
                  </span>
                </label>
              ) : null}
            </section>
          </div>
        ) : null}

        {stage.kind === "ready" ? (
          <div className="flex flex-col gap-3">
            <div>
              <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Link
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="share-chat-url-input"
                  readOnly
                  value={stage.url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleCopy()}
                  className="gap-1.5"
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                Expires {new Date(stage.expiresAt).toLocaleTimeString()}.
              </div>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Summary
              </div>
              <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap">
                {stage.summary}
              </p>
            </div>
          </div>
        ) : null}

        {stage.kind === "error" ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {stage.message}
          </div>
        ) : null}

        <DialogFooter>
          {stage.kind === "ready" && (
            <Button
              variant="destructive"
              onClick={() => void handleRevoke()}
              disabled={revoking}
              className="gap-1.5 sm:mr-auto"
            >
              {revoking ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Revoke link
            </Button>
          )}
          {stage.kind === "ready" || stage.kind === "error" ? (
            <Button variant="outline" onClick={handleClose}>
              Done
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={handleClose}
              disabled={stage.kind === "uploading"}
            >
              Cancel
            </Button>
          )}
          {stage.kind !== "ready" ? (
            <Button
              onClick={() => void handleGenerate()}
              disabled={stage.kind === "uploading" || messages == null || (messageCount ?? 0) === 0}
              className="gap-1.5"
            >
              {stage.kind === "uploading" ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Summarizing with Gemma…
                </>
              ) : (
                <>
                  <Share2 className="h-3.5 w-3.5" />
                  {stage.kind === "error" ? "Try again" : "Generate link"}
                </>
              )}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
