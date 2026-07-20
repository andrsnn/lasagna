"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, MessagesSquare, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PaperCard } from "@/app/components/paper-card";
import { PaperPill } from "@/app/components/paper-pill";
import { H1 } from "@/app/components/serif-heading";
import { CodeBlock } from "@/app/components/code-block";
import { Button } from "@/components/ui/button";
import { gradientCss } from "@/app/lib/visuals";
import { importSharedChat } from "@/app/lib/import-share-chat";
import type {
  SharedChatMessage,
  SharedChatPayload,
} from "@/app/lib/chat-share-store";

type FetchState =
  | { kind: "loading" }
  | { kind: "expired" }
  | { kind: "error"; message: string }
  | { kind: "ready"; payload: SharedChatPayload };

export function ShareChatPageClient({
  token,
  initial,
}: {
  token: string;
  initial: SharedChatPayload | null;
}) {
  const router = useRouter();
  const [state, setState] = useState<FetchState>(
    initial ? { kind: "ready", payload: initial } : { kind: "loading" }
  );
  const [now, setNow] = useState(() => Date.now());
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Re-fetch on mount even when we have server-rendered data — the page is
  // force-dynamic but a recipient who lingers can outlast the TTL between
  // initial render and clicking "Add". Confirming via fresh fetch keeps the
  // expiry countdown honest.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/share/chat/${token}`, { cache: "no-store" });
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
        const payload = (await res.json()) as SharedChatPayload;
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
      const { id } = await importSharedChat(state.payload);
      router.push(`/chats/${id}`);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to import chat.");
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
  const remainingMs = Math.max(0, payload.expiresAt - now);
  const expiresLabel = remainingMs <= 0 ? "expired" : `expires in ${formatRemaining(remainingMs)}`;
  const idbAvailable = typeof indexedDB !== "undefined";
  const messageCount = payload.messages.length;
  const kindLabel =
    payload.chat.kind === "designer-edit"
      ? "Designer chat"
      : payload.chat.kind === "app-setup"
      ? "App setup chat"
      : "Free-form chat";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto safe-x">
      <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
        <PaperCard tone="raised" className="overflow-hidden">
          <div className="flex items-center gap-3 border-b border-border/60 px-5 py-4">
            <div
              className="h-12 w-12 shrink-0 rounded-xl border border-border"
              style={{ background: gradientCss(token) }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <H1 className="truncate text-xl">{payload.chat.title}</H1>
                <PaperPill tone="accent">Shared chat</PaperPill>
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {messageCount} message{messageCount === 1 ? "" : "s"} · {kindLabel}
                {payload.chat.targetName ? ` · ${payload.chat.targetName}` : ""} · {expiresLabel}
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
          </div>

          <div className="border-t border-border/60 px-5 py-5">
            <div className="mb-3 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              <MessagesSquare className="h-3 w-3" />
              Transcript
            </div>
            <div className="flex flex-col gap-3">
              {payload.messages.map((m, i) => (
                <Bubble key={i} message={m} />
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t border-border/60 bg-muted/30 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[11px] text-muted-foreground">
              Adds a copy to your chats. The original sender&apos;s chat is unaffected.
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
              {importing ? "Adding…" : "Add to my chats"}
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

function Bubble({ message }: { message: SharedChatMessage }) {
  const isUser = message.role === "user";
  const align = isUser ? "items-end" : "items-start";
  const bg = isUser
    ? "bg-primary/10 text-foreground border-primary/25"
    : "bg-muted/40 text-foreground border-border/60";
  const roleLabel = isUser ? "You" : message.role === "assistant" ? "Assistant" : message.role;

  return (
    <div className={`flex flex-col gap-1 ${align}`}>
      <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {roleLabel}
        {message.model ? ` · ${message.model}` : ""}
      </div>
      <div
        className={`max-w-[90%] rounded-2xl border px-3.5 py-2.5 text-sm leading-relaxed ${bg}`}
      >
        {message.images && message.images.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {message.images.map((img) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={img.id}
                src={img.dataUrl}
                alt={img.name ?? ""}
                className="max-h-48 rounded-md border border-border bg-background object-cover"
              />
            ))}
          </div>
        ) : null}
        {message.content ? (
          <div className="prose prose-sm max-w-none break-words">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>{message.content}</ReactMarkdown>
          </div>
        ) : null}
        {message.error ? (
          <div className="mt-1 text-xs text-destructive">{message.error}</div>
        ) : null}
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
