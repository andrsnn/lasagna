"use client";

import { useEffect, useState } from "react";
import { Info, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PaperCard } from "@/app/components/paper-card";
import { H1 } from "@/app/components/serif-heading";
import { CodeBlock } from "@/app/components/code-block";
import type { SharedNotePayload } from "@/app/lib/note-share-store";

type FetchState =
  | { kind: "loading" }
  | { kind: "expired" }
  | { kind: "error"; message: string }
  | { kind: "ready"; payload: SharedNotePayload };

export function ShareNoteClient({
  token,
  initial,
}: {
  token: string;
  initial: SharedNotePayload | null;
}) {
  const [state, setState] = useState<FetchState>(
    initial ? { kind: "ready", payload: initial } : { kind: "loading" }
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/share/note/${token}`, { cache: "no-store" });
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
        const payload = (await res.json()) as SharedNotePayload;
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
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

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
          Shared notes last 7 days. Ask the sender to generate a new link.
        </p>
      </CenteredCard>
    );
  }

  if (state.kind === "error") {
    return (
      <CenteredCard>
        <H1>Couldn&apos;t load note</H1>
        <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
      </CenteredCard>
    );
  }

  const { payload } = state;

  // HTML bodies render full-bleed in a sandboxed iframe — same affordance as
  // the existing /share/html viewer so an artifact pinned as a note shows
  // identically once it's published.
  if (payload.body.kind === "html") {
    return <HtmlBody payload={payload} now={now} />;
  }

  return <ProseBody payload={payload} now={now} />;
}

function HtmlBody({
  payload,
  now,
}: {
  payload: SharedNotePayload;
  now: number;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const html = payload.body.kind === "html" ? payload.body.html : "";
  const remainingMs = Math.max(0, payload.expiresAt - now);
  const expiresLabel =
    remainingMs <= 0 ? "expired" : `expires in ${formatRemaining(remainingMs)}`;
  return (
    <div
      className="fixed inset-0 z-0 flex flex-col bg-card"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <iframe
        title={payload.title}
        srcDoc={html}
        sandbox="allow-scripts allow-forms allow-pointer-lock allow-popups"
        className="block min-h-0 w-full flex-1 border-0 bg-white"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      />
      <button
        type="button"
        onClick={() => setShowInfo((v) => !v)}
        aria-label={showInfo ? "Hide details" : "Show details"}
        title={showInfo ? "Hide details" : "Show details"}
        className="fixed bottom-3 right-3 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card/95 text-muted-foreground shadow-md backdrop-blur transition hover:text-foreground"
        style={{ bottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
      >
        <Info className="h-4 w-4" />
      </button>
      {showInfo && (
        <div
          className="fixed bottom-14 right-3 z-10 max-w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-card/95 p-3 text-xs shadow-lg backdrop-blur"
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 3.25rem)" }}
        >
          <div className="text-sm font-medium text-foreground">{payload.title}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">{expiresLabel}</div>
          {payload.summary && (
            <p className="mt-2 leading-relaxed text-foreground/80 whitespace-pre-wrap">
              {payload.summary}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ProseBody({
  payload,
  now,
}: {
  payload: SharedNotePayload;
  now: number;
}) {
  const remainingMs = Math.max(0, payload.expiresAt - now);
  const expiresLabel =
    remainingMs <= 0 ? "expired" : `expires in ${formatRemaining(remainingMs)}`;
  return (
    // The app shell wraps every page in `<main class="... overflow-hidden">`
    // with a fixed height, so this view must own its scroll region - a
    // `min-h-full` root would let long notes overflow and clip on mobile
    // (their bottom becomes unreachable). `h-full overflow-y-auto` makes the
    // note itself scroll.
    <div className="h-full overflow-y-auto bg-background">
      <div
        className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12"
        style={{
          paddingTop: "calc(env(safe-area-inset-top) + 2rem)",
          paddingBottom: "calc(env(safe-area-inset-bottom) + 4rem)",
        }}
      >
        <header className="mb-6 border-b border-border/60 pb-6">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Shared note
          </div>
          <H1 className="mt-1">{payload.title}</H1>
          {payload.summary && (
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {payload.summary}
            </p>
          )}
          <div className="mt-3 text-[11px] text-muted-foreground/80">
            {expiresLabel}
          </div>
        </header>

        {payload.body.kind === "markdown" && (
          <article className="note-prose prose prose-sm max-w-none break-words sm:prose-base">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>
              {payload.body.markdown}
            </ReactMarkdown>
          </article>
        )}

        {payload.body.kind === "snapshot" && (
          <div className="flex flex-col gap-4">
            {payload.body.messages.map((m, i) => (
              <PaperCard key={i} className="rounded-2xl p-4">
                <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {m.role}
                </div>
                <article className="note-prose prose prose-sm max-w-none break-words">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>
                    {m.content}
                  </ReactMarkdown>
                </article>
              </PaperCard>
            ))}
          </div>
        )}

        <footer className="mt-12 border-t border-border/60 pt-4 text-[11px] text-muted-foreground">
          Shared from Lasagna.
        </footer>
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
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
