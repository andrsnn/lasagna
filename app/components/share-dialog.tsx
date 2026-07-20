"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  Globe,
  Loader2,
  Share2,
  Trash2,
} from "lucide-react";
import { upload } from "@vercel/blob/client";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { StoredApp, StoredDesigner } from "@/app/db";
import { setDesignerAppPairAccountShared } from "@/app/lib/account-sync";
import { toast } from "@/app/components/toast";
import { newShareToken, serializeForShare } from "@/app/lib/share-payload";
import { composeArtifactSrcdoc } from "@/app/lib/artifact/compose";

// Two flavours of share:
//   "live"   → builds the app to HTML and registers an HTML share. The link
//              runs the app live for anyone, no account needed (full power:
//              the public viewer can call the AI + network, rate-limited).
//   "import" → the original flow: a 7-day link that adds a *copy* of the app
//              to the recipient's own library.
type LinkKind = "live" | "import";

type Stage =
  | { kind: "idle" }
  | { kind: "working"; which: LinkKind }
  | {
      kind: "ready";
      which: LinkKind;
      url: string;
      expiresAt: number;
      summary?: string;
    }
  | { kind: "error"; message: string };

export function ShareDialog({
  open,
  onClose,
  onSyncChange,
  app,
  designer,
}: {
  open: boolean;
  onClose: () => void;
  onSyncChange?: () => void;
  app: StoredApp;
  designer: StoredDesigner;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [includeState, setIncludeState] = useState(false);
  const [copied, setCopied] = useState(false);
  // Live links only: hand out the top-level (no-iframe) URL so iOS Safari's
  // "Full Page" screenshot captures the whole scrollable artifact. Same share,
  // different surfaced URL (a `/raw` suffix).
  const [screenshotMode, setScreenshotMode] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [accountShared, setAccountShared] = useState<boolean>(
    !!app.accountShared
  );
  const [accountBusy, setAccountBusy] = useState(false);

  // Reflect the latest prop value when reopening the dialog — the parent may
  // have re-pulled from the account store between opens.
  useEffect(() => {
    setAccountShared(!!app.accountShared);
  }, [app.accountShared]);

  const handleToggleAccountShare = useCallback(
    async (next: boolean) => {
      setAccountBusy(true);
      const prev = accountShared;
      setAccountShared(next);
      try {
        await setDesignerAppPairAccountShared(app.id, next);
        onSyncChange?.();
      } catch {
        setAccountShared(prev);
        toast.error("Couldn't change account sync. Please try again.");
      } finally {
        setAccountBusy(false);
      }
    },
    [accountShared, app.id, onSyncChange]
  );

  const reset = useCallback(() => {
    setStage({ kind: "idle" });
    setCopied(false);
    setScreenshotMode(false);
    setRevoking(false);
  }, []);

  // Link to copy / open. Only live HTML links support the screenshot variant;
  // import links add a copy to the recipient's library and have no `/raw` view.
  const activeUrl =
    stage.kind === "ready"
      ? screenshotMode && stage.which === "live"
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
    // "live" links are HTML shares; "import" links are app shares.
    const endpoint =
      stage.which === "live" ? "/api/share-html-revoke" : "/api/share-revoke";
    setRevoking(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}.`);
      toast.success("Link revoked — it no longer works");
      reset();
    } catch {
      toast.error("Couldn't revoke the link. Please try again.");
      setRevoking(false);
    }
  }, [stage, revoking, reset]);

  // Live link: build the app to a viewer-ready HTML doc, upload it to blob,
  // then register an HTML share keyed to this app so artifact.shared.* (and
  // the owner's frame) route to the same pool. The recipient opens a running
  // app — no import, no account.
  const handleGenerateLive = useCallback(async () => {
    setStage({ kind: "working", which: "live" });
    try {
      const buildRes = await fetch("/api/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: designer.files,
          entry: designer.entry,
          target: "app",
        }),
      });
      const buildData = (await buildRes.json().catch(() => ({}))) as
        | { ok: true; html: string }
        | { ok: false; errors?: { message?: string }[] };
      if (!buildRes.ok || !buildData.ok) {
        const msg =
          (!buildData.ok && buildData.errors?.[0]?.message) ||
          `Build failed (${buildRes.status}).`;
        setStage({ kind: "error", message: msg });
        return;
      }

      // composeArtifactSrcdoc is idempotent — designer builds that already
      // carry the SDK pass through unchanged.
      const composedHtml = composeArtifactSrcdoc(buildData.html);
      const token = newShareToken();
      const pathname = `share/html/${token}.json`;
      const blob = await upload(
        pathname,
        new Blob(
          [JSON.stringify({ html: composedHtml, params: app.params ?? {} })],
          { type: "application/json" }
        ),
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
          title: app.name || designer.name,
          summary: designer.description ?? "",
          appId: app.id,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        expiresAt?: number;
        error?: string;
      };
      if (!res.ok || !body.url || !body.expiresAt) {
        setStage({
          kind: "error",
          message: body.error ?? `Server returned ${res.status}.`,
        });
        return;
      }
      setStage({
        kind: "ready",
        which: "live",
        url: `${window.location.origin}${body.url}`,
        expiresAt: body.expiresAt,
      });
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to create live link.",
      });
    }
  }, [app, designer]);

  // Import link: the original two-step flow. Serialize the designer + app,
  // upload to blob, register the app share; the recipient adds a copy to their
  // own library.
  const handleGenerateImport = useCallback(async () => {
    setStage({ kind: "working", which: "import" });
    try {
      const serialized = serializeForShare(designer, app, includeState);
      const token = newShareToken();
      const pathname = `share/app/${token}.json`;
      const blob = await upload(
        pathname,
        new Blob([JSON.stringify(serialized)], { type: "application/json" }),
        {
          access: "private",
          contentType: "application/json",
          handleUploadUrl: "/api/share-blob-upload",
        }
      );

      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, blobUrl: blob.url }),
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
      setStage({
        kind: "ready",
        which: "import",
        url: `${window.location.origin}${body.url}`,
        summary: body.summary,
        expiresAt: body.expiresAt,
      });
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to create share link.",
      });
    }
  }, [app, designer, includeState]);

  const handleCopy = useCallback(async () => {
    if (stage.kind !== "ready") return;
    try {
      await navigator.clipboard.writeText(activeUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard can fail in insecure contexts; fall back to selecting the input.
      const el = document.getElementById("share-url-input") as HTMLInputElement | null;
      el?.select();
    }
  }, [stage, activeUrl]);

  const working = stage.kind === "working";

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? handleClose() : null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4" />
            Share &ldquo;{app.name}&rdquo;
          </DialogTitle>
        </DialogHeader>

        {stage.kind === "idle" || stage.kind === "working" ? (
          <div className="flex flex-col gap-3">
            <label className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
              <input
                type="checkbox"
                checked={accountShared}
                onChange={(e) => void handleToggleAccountShare(e.target.checked)}
                disabled={accountBusy}
                className="mt-0.5"
              />
              <span>
                <span className="flex items-center gap-1.5 font-medium text-foreground">
                  <Cloud className="h-3.5 w-3.5" /> Sync to account
                </span>
                <span className="block text-muted-foreground">
                  Keep this app on every browser you sign in from, and run its
                  schedule centrally. Toggle off to remove the server copy.
                </span>
              </span>
            </label>

            <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Globe className="h-3.5 w-3.5" /> Live link
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Send a link that <strong>runs the app</strong> for anyone, for 7
                days — no account, no install. They can use it right away,
                including its AI features.
              </p>
              <Button
                onClick={() => void handleGenerateLive()}
                disabled={working}
                size="sm"
                className="mt-2 gap-1.5"
              >
                {working && stage.which === "live" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Globe className="h-3.5 w-3.5" />
                )}
                {working && stage.which === "live" ? "Building…" : "Create live link"}
              </Button>
            </div>

            <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Download className="h-3.5 w-3.5" /> Import link
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Send a 7-day link that adds an editable <strong>copy</strong> to
                the recipient&apos;s own library. The summary is generated by
                Gemma.
              </p>
              <label className="mt-2 flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={includeState}
                  onChange={(e) => setIncludeState(e.target.checked)}
                  disabled={working}
                  className="mt-0.5"
                />
                <span className="text-muted-foreground">
                  Include app data (saved entries, fetched results).
                </span>
              </label>
              <Button
                onClick={() => void handleGenerateImport()}
                disabled={working}
                size="sm"
                variant="outline"
                className="mt-2 gap-1.5"
              >
                {working && stage.which === "import" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {working && stage.which === "import"
                  ? "Summarizing with Gemma…"
                  : "Create import link"}
              </Button>
            </div>
          </div>
        ) : null}

        {stage.kind === "ready" ? (
          <div className="flex flex-col gap-3">
            <div>
              <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {stage.which === "live" ? "Live link" : "Import link"}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="share-url-input"
                  readOnly
                  value={activeUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="font-mono text-xs"
                />
                <Button variant="outline" size="sm" onClick={() => void handleCopy()} className="gap-1.5">
                  {copied ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              {stage.which === "live" && (
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
                      Opens the app as a full page (no frame) so iOS Safari&apos;s
                      &ldquo;Full Page&rdquo; screenshot captures the whole thing.
                    </span>
                  </span>
                </label>
              )}
              <div className="mt-1 text-[11px] text-muted-foreground">
                {stage.which === "live"
                  ? "Anyone with this link can use the app — no account needed. "
                  : "Adds a copy to the recipient's library. "}
                Expires {new Date(stage.expiresAt).toLocaleString()}.
              </div>
            </div>
            {stage.summary ? (
              <div>
                <div className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  Summary
                </div>
                <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap">
                  {stage.summary}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {stage.kind === "error" ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {stage.message}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={stage.kind === "ready" || stage.kind === "error" ? reset : handleClose}
            disabled={working}
          >
            {stage.kind === "ready" || stage.kind === "error" ? "Back" : "Cancel"}
          </Button>
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
          {stage.kind === "ready" && stage.which === "live" ? (
            <a
              href={activeUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ className: "gap-1.5" })}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </a>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
