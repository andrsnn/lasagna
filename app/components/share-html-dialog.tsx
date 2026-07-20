"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, Share2, Trash2 } from "lucide-react";
import { toast } from "@/app/components/toast";
import { upload } from "@vercel/blob/client";
import { getChat } from "@/app/db";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { composeArtifactSrcdoc } from "@/app/lib/artifact/compose";
import { newShareToken } from "@/app/lib/share-payload";

const TITLE_MAX = 120;
const SUMMARY_MAX = 600;

type Stage =
  | { kind: "draft"; title: string; summary: string }
  | { kind: "uploading" }
  | { kind: "ready"; url: string; title: string; summary: string; expiresAt: number }
  | { kind: "error"; message: string; title: string; summary: string };

export function ShareHtmlDialog({
  open,
  onClose,
  html,
  defaultSummary,
  chatId,
  appId,
}: {
  open: boolean;
  onClose: () => void;
  html: string;
  defaultSummary: string;
  /** Owning chat id. The dialog reads the chat's title to prefill the
   *  description — the chat title is the existing Gemma-generated summary
   *  ("Power BI pricing"), which is a much cleaner default than the
   *  assistant's commit-message prose that streams alongside the artifact. */
  chatId?: string;
  /** Optional: paired designer/app id. When present, the share is recorded
   *  against this app so the owner's live artifact frame can route
   *  artifact.shared.* to the same input pool viewers see. Free-form
   *  chat-mode HTML shares without one — that's fine, the share still
   *  works and viewers can still write to artifact.shared.*. */
  appId?: string;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "draft", title: "", summary: "" });
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(false);
  // When on, hand out the top-level (no-iframe) link so iOS Safari's "Full
  // Page" screenshot captures the whole scrollable artifact. The underlying
  // share is the same — only the URL we surface differs (a `/raw` suffix).
  const [screenshotMode, setScreenshotMode] = useState(false);

  const reset = useCallback(() => {
    setStage({ kind: "draft", title: "", summary: "" });
    setCopied(false);
    setScreenshotMode(false);
    setRevoking(false);
  }, []);

  // The link to actually copy / open / share, given the screenshot toggle.
  const activeUrl =
    stage.kind === "ready"
      ? screenshotMode
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
      const res = await fetch("/api/share-html-revoke", {
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

  // Track which (open, html, chatId, defaultSummary) tuple this draft was
  // seeded from. Without this guard, re-renders that flip `defaultSummary` to
  // a new identity-equal string would clobber the user's in-progress edits.
  const seededRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      seededRef.current = null;
      return;
    }
    const key = `${chatId ?? ""}::${html.length}::${defaultSummary}`;
    if (seededRef.current === key) return;
    seededRef.current = key;

    let cancelled = false;
    const initialTitle = extractTitleFromHtml(html);
    setStage({ kind: "draft", title: initialTitle, summary: defaultSummary });

    if (!chatId) return;
    (async () => {
      try {
        const chat = await getChat(chatId);
        if (cancelled) return;
        const chatSummary = chat?.title?.trim();
        if (chatSummary) {
          setStage((prev) =>
            prev.kind === "draft" && prev.summary === defaultSummary
              ? { ...prev, summary: chatSummary }
              : prev
          );
        }
      } catch {
        // Best-effort prefill — leave the existing draft as-is.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, html, chatId, defaultSummary]);

  const handleCreate = useCallback(async () => {
    if (stage.kind !== "draft" && stage.kind !== "error") return;
    const title = stage.title.trim().slice(0, TITLE_MAX);
    const summary = stage.summary.trim().slice(0, SUMMARY_MAX);
    setStage({ kind: "uploading" });
    try {
      // SDK injection happens client-side now (used to be server-side
      // before the move to blob storage) — the blob we upload is the
      // viewer-ready document. composeArtifactSrcdoc is idempotent so
      // designer-built HTML that already has the SDK passes through
      // cleanly.
      const composedHtml = composeArtifactSrcdoc(html);
      const token = newShareToken();
      const pathname = `share/html/${token}.json`;
      const blob = await upload(
        pathname,
        new Blob([JSON.stringify({ html: composedHtml })], {
          type: "application/json",
        }),
        {
          access: "private",
          contentType: "application/json",
          handleUploadUrl: "/api/share-blob-upload",
        }
      );

      const res = await fetch("/api/share-html", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          blobUrl: blob.url,
          title,
          summary,
          // Owner-side wiring for artifact.shared.* — see appId prop doc.
          ...(appId ? { appId } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        title?: string;
        summary?: string;
        expiresAt?: number;
        error?: string;
      };
      if (!res.ok || !body.url || !body.expiresAt) {
        setStage({
          kind: "error",
          message: body.error ?? `Server returned ${res.status}.`,
          title,
          summary,
        });
        return;
      }
      const fullUrl = `${window.location.origin}${body.url}`;
      setStage({
        kind: "ready",
        url: fullUrl,
        title: body.title ?? title ?? "Shared artifact",
        summary: body.summary ?? summary,
        expiresAt: body.expiresAt,
      });
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to create share link.",
        title,
        summary,
      });
    }
  }, [stage, html, appId]);

  const handleCopy = useCallback(async () => {
    if (stage.kind !== "ready") return;
    try {
      await navigator.clipboard.writeText(activeUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      const el = document.getElementById(
        "share-html-url-input"
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

  const draftTitle =
    stage.kind === "draft" || stage.kind === "error" ? stage.title : "";
  const draftSummary =
    stage.kind === "draft" || stage.kind === "error" ? stage.summary : "";
  const canSubmit =
    (stage.kind === "draft" || stage.kind === "error") &&
    stage.title.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? handleClose() : null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4" />
            Share artifact
          </DialogTitle>
        </DialogHeader>

        {(stage.kind === "draft" || stage.kind === "error") && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Anyone with this link can read the artifact for 7 days — no
              account needed. The title and description appear in iMessage,
              Slack, and other link previews.
            </p>
            <div>
              <label
                htmlFor="share-html-title-input"
                className="mb-1 block text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
              >
                Title
              </label>
              <Input
                id="share-html-title-input"
                value={draftTitle}
                maxLength={TITLE_MAX}
                onChange={(e) =>
                  setStage((prev) =>
                    prev.kind === "draft" || prev.kind === "error"
                      ? { ...prev, title: e.target.value }
                      : prev
                  )
                }
                placeholder="Shared artifact"
              />
            </div>
            <div>
              <label
                htmlFor="share-html-summary-input"
                className="mb-1 block text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
              >
                Description
              </label>
              <Textarea
                id="share-html-summary-input"
                value={draftSummary}
                maxLength={SUMMARY_MAX}
                rows={3}
                onChange={(e) =>
                  setStage((prev) =>
                    prev.kind === "draft" || prev.kind === "error"
                      ? { ...prev, summary: e.target.value }
                      : prev
                  )
                }
                placeholder="A short summary of what this artifact shows."
              />
              <div className="mt-1 text-right text-[10px] text-muted-foreground tabular-nums">
                {draftSummary.length}/{SUMMARY_MAX}
              </div>
            </div>
            {stage.kind === "error" && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {stage.message}
              </div>
            )}
          </div>
        )}

        {stage.kind === "uploading" && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Uploading artifact…
          </div>
        )}

        {stage.kind === "ready" && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Anyone with this link can read the artifact for 7 days — no
              account needed. If the artifact uses{" "}
              <code className="font-mono">artifact.shared.*</code>, viewers
              can also add and remove items in those collections.
            </p>
            <div>
              <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Link
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="share-html-url-input"
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
              <label className="mt-2 flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={screenshotMode}
                  onChange={(e) => {
                    setScreenshotMode(e.target.checked);
                    setCopied(false);
                  }}
                  className="mt-0.5"
                />
                <span className="text-muted-foreground">
                  <span className="font-medium text-foreground">
                    Full-page screenshot link
                  </span>
                  <span className="block">
                    Opens the artifact as a full page (no frame) so iOS Safari&apos;s
                    &ldquo;Full Page&rdquo; screenshot captures the whole thing.
                  </span>
                </span>
              </label>
              <div className="mt-1 text-[11px] text-muted-foreground">
                Expires {new Date(stage.expiresAt).toLocaleString()}.
              </div>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Preview
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

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {stage.kind === "ready" ? "Done" : "Cancel"}
          </Button>
          {(stage.kind === "draft" || stage.kind === "error") && (
            <Button
              onClick={() => void handleCreate()}
              disabled={!canSubmit}
              className="gap-1.5"
            >
              <Share2 className="h-3.5 w-3.5" />
              Create link
            </Button>
          )}
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

// Pure client-side `<title>` extractor. Mirrors extractHtmlTitle in
// app/lib/html-share-store.ts (server-only because that file imports
// @upstash/redis). Kept inline here so the dialog stays free of server
// imports.
function extractTitleFromHtml(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    const t = decodeBasicEntities(titleMatch[1]).replace(/\s+/g, " ").trim();
    if (t) return t.slice(0, TITLE_MAX);
  }
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match?.[1]) {
    const stripped = h1Match[1].replace(/<[^>]+>/g, "");
    const t = decodeBasicEntities(stripped).replace(/\s+/g, " ").trim();
    if (t) return t.slice(0, TITLE_MAX);
  }
  return "";
}

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
