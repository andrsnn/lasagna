"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, FileCode, Loader2, Sparkles } from "lucide-react";
import { PaperCard } from "@/app/components/paper-card";
import { PaperPill } from "@/app/components/paper-pill";
import { H1 } from "@/app/components/serif-heading";
import { Button } from "@/components/ui/button";
import { gradientCss } from "@/app/lib/visuals";
import { importSharedApp } from "@/app/lib/import-share";
import type { SharedAppPayload } from "@/app/lib/share-store";

type FetchState =
  | { kind: "loading" }
  | { kind: "expired" }
  | { kind: "error"; message: string }
  | { kind: "ready"; payload: SharedAppPayload };

export function SharePageClient({
  token,
  initial,
}: {
  token: string;
  initial: SharedAppPayload | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<FetchState>(
    initial ? { kind: "ready", payload: initial } : { kind: "loading" }
  );
  const [now, setNow] = useState(() => Date.now());
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Re-fetch on mount even when we have server-rendered data: the page is
  // force-dynamic but a recipient who lingers can outlast the TTL between
  // initial render and clicking "Add". Confirming via fresh fetch keeps the
  // expiry countdown honest.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/share/${token}`, { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 410 || res.status === 404) {
          setState({ kind: "expired" });
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setState({
            kind: "error",
            message: body.error ?? `Server returned ${res.status}.`,
          });
          return;
        }
        const payload = (await res.json()) as SharedAppPayload;
        setState({ kind: "ready", payload });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load share.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const onAdd = useCallback(async () => {
    if (state.kind !== "ready") return;
    setImporting(true);
    setImportError(null);
    try {
      const { id } = await importSharedApp(state.payload);
      router.push(`/apps/${id}`);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to import app.");
      setImporting(false);
    }
  }, [router, state]);

  if (state.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (state.kind === "expired") {
    return (
      <CenteredCard>
        <H1>Link expired</H1>
        <p className="mt-2 text-sm text-muted-foreground">
          Share links last 7 days. Ask the sender to generate a new one.
        </p>
      </CenteredCard>
    );
  }

  if (state.kind === "error") {
    return (
      <CenteredCard>
        <H1>Couldn&apos;t load share</H1>
        <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
      </CenteredCard>
    );
  }

  const { payload } = state;
  const fileCount = Object.keys(payload.designer.files).length;
  const remainingMs = Math.max(0, payload.expiresAt - now);
  const expiresLabel = remainingMs <= 0 ? "expired" : `expires in ${formatRemaining(remainingMs)}`;
  const idbAvailable = typeof indexedDB !== "undefined";

  return (
    <div className="flex h-full flex-col safe-x">
      <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
        <PaperCard tone="raised" className="overflow-hidden">
          <div className="flex items-center gap-3 border-b border-border/60 px-5 py-4">
            <div
              className="h-12 w-12 shrink-0 rounded-xl border border-border"
              style={{ background: gradientCss(token) }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <H1 className="truncate text-xl">{payload.designer.name}</H1>
                <PaperPill tone="accent">Shared app</PaperPill>
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {fileCount} file{fileCount === 1 ? "" : "s"} · {payload.designer.entry} · {expiresLabel}
              </div>
            </div>
          </div>

          <div className="px-5 py-5">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              <Sparkles className="h-3 w-3" />
              Summary
            </div>
            <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
              {payload.summary}
            </p>

            {payload.app.state && Object.keys(payload.app.state).length > 0 ? (
              <div className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
                <FileCode className="h-3.5 w-3.5" />
                Includes the app&apos;s saved data.
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-2 border-t border-border/60 bg-muted/30 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[11px] text-muted-foreground">
              Adds a copy to your library. The original owner&apos;s app is unaffected.
            </p>
            <Button
              onClick={() => void onAdd()}
              disabled={!idbAvailable || importing || remainingMs <= 0}
              className="gap-1.5"
            >
              {importing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {importing ? "Adding…" : "Add to my apps"}
            </Button>
          </div>

          {!idbAvailable ? (
            <div className="border-t border-border/60 bg-[#fbe2c4] px-5 py-3 text-xs text-[#8a4a14] dark:bg-[#3a2410] dark:text-[#fbe2c4]">
              Your browser doesn&apos;t expose IndexedDB (private/incognito mode). Open this link in a regular window to import.
            </div>
          ) : null}

          {importError ? (
            <div className="border-t border-border/60 bg-destructive/10 px-5 py-3 text-xs text-destructive">
              {importError}
            </div>
          ) : null}
        </PaperCard>
      </div>
    </div>
  );
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-4">
      <PaperCard tone="raised" className="max-w-md p-8 text-center">
        {children}
      </PaperCard>
    </div>
  );
}

function formatRemaining(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
