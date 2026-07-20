"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, Share2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getPinnedNote, putPinnedNote, type StoredPinnedNote } from "@/app/db";
import { toast } from "@/app/components/toast";
import { Trash2 } from "lucide-react";

type Stage =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "ready"; url: string; title: string; summary: string; expiresAt: number }
  | { kind: "error"; message: string };

type ShareBody =
  | { kind: "html"; html: string }
  | { kind: "markdown"; markdown: string }
  | {
      kind: "snapshot";
      messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    };

// The notes index keeps Message + Artifact + Snapshot as independent fields on
// a single pin. The viewer needs ONE body kind, so we pick in this order:
// markdown → snapshot → html. That matches the UI weight on /notes — prose
// is the most common pin, the artifact iframe is the "expandable" extra.
function pickBody(note: StoredPinnedNote): ShareBody | null {
  if (note.messageMarkdown && note.messageMarkdown.trim()) {
    return { kind: "markdown", markdown: note.messageMarkdown };
  }
  if (note.chatSnapshot && note.chatSnapshot.messages.length > 0) {
    return {
      kind: "snapshot",
      messages: note.chatSnapshot.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };
  }
  if (note.artifactHtml && note.artifactHtml.trim()) {
    return { kind: "html", html: note.artifactHtml };
  }
  return null;
}

export function ShareNoteDialog({
  open,
  onClose,
  note,
}: {
  open: boolean;
  onClose: () => void;
  note: StoredPinnedNote | null;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(false);
  // When on, hand out the top-level (no-iframe) `/raw` link so the recipient can
  // print / Save as PDF and iOS Safari's "Full Page" screenshot captures the
  // whole note. Only meaningful for HTML-bodied notes — the underlying share is
  // the same, only the surfaced URL differs.
  const [fullPageMode, setFullPageMode] = useState(false);

  // Whether the note we're sharing resolves to an HTML body. The full-page link
  // only renders something for HTML notes, so we hide the toggle otherwise.
  const isHtmlBody = !!note && pickBody(note)?.kind === "html";

  const reset = useCallback(() => {
    setStage({ kind: "idle" });
    setCopied(false);
    setFullPageMode(false);
    setRevoking(false);
  }, []);

  // The link to actually copy / open / share, given the full-page toggle.
  const activeUrl =
    stage.kind === "ready"
      ? fullPageMode
        ? `${stage.url}/raw`
        : stage.url
      : "";

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
      const res = await fetch("/api/share-note-revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}.`);
      if (note) {
        const fresh = await getPinnedNote(note.id).catch(() => undefined);
        if (fresh) {
          await putPinnedNote({
            ...fresh,
            shareToken: undefined,
            shareTokenExpiresAt: undefined,
            updatedAt: Date.now(),
          }).catch(() => {});
        }
      }
      toast.success("Link revoked — it no longer works");
      handleClose();
    } catch {
      toast.error("Couldn't revoke the link. Please try again.");
      setRevoking(false);
    }
  }, [stage, revoking, note, handleClose]);

  // Kick off the upload as soon as the dialog opens — the user already
  // confirmed by clicking Share.
  useEffect(() => {
    if (!open || !note) return;
    const body = pickBody(note);
    if (!body) {
      setStage({
        kind: "error",
        message: "This note has no content to share yet. Add text or an artifact and try again.",
      });
      return;
    }
    let cancelled = false;
    setStage({ kind: "uploading" });
    (async () => {
      try {
        // If the note already has a live share token, ask the server to
        // republish under the same key so the URL the recipient already
        // holds keeps working and updates to reflect the latest content.
        const now = Date.now();
        const reuseToken =
          note.shareToken &&
          note.shareTokenExpiresAt &&
          note.shareTokenExpiresAt > now
            ? note.shareToken
            : undefined;
        const res = await fetch("/api/share-note", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: note.title,
            summary: note.summary,
            body,
            reuseToken,
          }),
        });
        const resBody = (await res.json().catch(() => ({}))) as {
          token?: string;
          url?: string;
          title?: string;
          summary?: string;
          expiresAt?: number;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !resBody.url || !resBody.expiresAt) {
          setStage({
            kind: "error",
            message: resBody.error ?? `Server returned ${res.status}.`,
          });
          return;
        }
        // Persist the (refreshed) token on the note so future shares — and
        // designer write-backs from a linked app — find it.
        if (resBody.token) {
          const fresh = await getPinnedNote(note.id).catch(() => undefined);
          if (fresh) {
            await putPinnedNote({
              ...fresh,
              shareToken: resBody.token,
              shareTokenExpiresAt: resBody.expiresAt,
              updatedAt: Date.now(),
            }).catch(() => {});
          }
        }
        const fullUrl = `${window.location.origin}${resBody.url}`;
        setStage({
          kind: "ready",
          url: fullUrl,
          title: resBody.title ?? "Shared note",
          summary: resBody.summary ?? "",
          expiresAt: resBody.expiresAt,
        });
      } catch (err) {
        if (cancelled) return;
        setStage({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to create share link.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, note]);

  const handleCopy = useCallback(async () => {
    if (stage.kind !== "ready") return;
    try {
      await navigator.clipboard.writeText(activeUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      const el = document.getElementById(
        "share-note-url-input"
      ) as HTMLInputElement | null;
      el?.select();
    }
  }, [stage, activeUrl]);

  const handleNativeShare = useCallback(async () => {
    if (stage.kind !== "ready") return;
    if (typeof navigator === "undefined" || !navigator.share) return;
    try {
      await navigator.share({
        title: stage.title,
        text: stage.summary || stage.title,
        url: activeUrl,
      });
    } catch {
      // user cancelled / unsupported — fall through silently
    }
  }, [stage, activeUrl]);

  const canNativeShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? handleClose() : null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4" />
            Share note
          </DialogTitle>
        </DialogHeader>

        {stage.kind === "uploading" && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Uploading note…
          </div>
        )}

        {stage.kind === "ready" && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Anyone with this link can read the note for 7 days — no
              account needed.
            </p>
            <div>
              <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Link
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="share-note-url-input"
                  readOnly
                  value={activeUrl}
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
              {isHtmlBody && (
                <label className="mt-2 flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={fullPageMode}
                    onChange={(e) => {
                      setFullPageMode(e.target.checked);
                      setCopied(false);
                    }}
                    className="mt-0.5"
                  />
                  <span className="text-muted-foreground">
                    <span className="font-medium text-foreground">
                      Full-page link
                    </span>
                    <span className="block">
                      Opens the note as a full page (no frame) so printing /
                      Save as PDF and iOS Safari&apos;s &ldquo;Full Page&rdquo;
                      screenshot capture the whole thing.
                    </span>
                  </span>
                </label>
              )}
              <div className="mt-1 text-[11px] text-muted-foreground">
                Expires {new Date(stage.expiresAt).toLocaleString()}.
              </div>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Preview title
              </div>
              <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed">
                <span className="font-medium text-foreground">{stage.title}</span>
                {stage.summary && (
                  <>
                    <br />
                    <span className="text-muted-foreground">{stage.summary}</span>
                  </>
                )}
              </p>
            </div>
          </div>
        )}

        {stage.kind === "error" && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {stage.message}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {stage.kind === "ready" ? "Done" : "Cancel"}
          </Button>
          {stage.kind === "ready" && (
            <>
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
              {canNativeShare && (
                <Button
                  variant="outline"
                  onClick={() => void handleNativeShare()}
                  className="gap-1.5"
                >
                  <Share2 className="h-3.5 w-3.5" />
                  Share…
                </Button>
              )}
              <a
                href={activeUrl}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ className: "gap-1.5" })}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open
              </a>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
