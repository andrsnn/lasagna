"use client";

// /admin/account-sync/chat/[id]?email=<email>
//
// Full-fidelity dump of one account-shared chat bundle. Reached by clicking
// a chat row on /admin/account-sync. Shows the chat row, every message, and
// a per-message size breakdown so you can find the message that's crashing a
// device — most often an image-heavy user turn whose inline base64 pushes the
// bundle past what a phone can hold in memory. Image dataUrls render as
// thumbnails (so you can see the offending image) and are truncated in the
// raw-JSON view for readability; "Copy full raw JSON" copies the untouched
// bundle.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
} from "lucide-react";
import { PaperCard } from "@/app/components/paper-card";
import { H1 } from "@/app/components/serif-heading";
import { Button } from "@/components/ui/button";

type MessageSize = {
  index: number;
  id: string;
  role: string;
  kind?: string;
  createdAt?: number;
  editedAt?: number;
  model?: string;
  hasError: boolean;
  errorPreview?: string;
  bytes: number;
  contentChars: number;
  thinkingChars: number;
  imageCount: number;
  imageBytes: number;
  pdfCount: number;
  csvCount: number;
  fileCount: number;
  artifactBytes: number;
  eventsBytes: number;
};

type ChatDump = {
  email: string;
  id: string;
  chat: Record<string, unknown> | null;
  messages: Array<Record<string, unknown>>;
  analysis: {
    totalBytes: number;
    chatRowBytes: number;
    messageCount: number;
    messageSizes: MessageSize[];
  };
};

// Bundles above this size are the ones that reliably crash mobile chat views.
const LARGE_BUNDLE_BYTES = 3 * 1024 * 1024;
const LARGE_MESSAGE_BYTES = 800 * 1024;

export default function AccountSyncChatDumpPage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const id = params.id;
  const email = search.get("email") ?? "";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ChatDump | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/account-sync/chat?email=${encodeURIComponent(email)}&id=${encodeURIComponent(id)}`,
          { cache: "no-store" }
        );
        const body = (await res.json()) as ChatDump | { error: string };
        if (cancelled) return;
        if (!res.ok || "error" in body) {
          setError(
            "error" in body ? body.error : `Server returned ${res.status}`
          );
          return;
        }
        setData(body);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Load failed.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email, id]);

  const title =
    (data?.chat?.title as string | undefined) || "(untitled chat)";
  const messagesById = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>();
    for (const m of data?.messages ?? []) {
      map.set(m.id as string, m);
    }
    return map;
  }, [data]);

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <div>
        <Link
          href="/admin/account-sync"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to account sync
        </Link>
      </div>

      <header className="flex flex-col gap-1">
        <H1>{title}</H1>
        <p className="font-mono text-[11px] text-muted-foreground">{id}</p>
        <p className="text-xs text-muted-foreground">{email}</p>
      </header>

      {loading && (
        <PaperCard className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading full chat bundle…
        </PaperCard>
      )}

      {error && (
        <PaperCard className="p-4">
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        </PaperCard>
      )}

      {data && (
        <>
          <SummaryCard data={data} />
          <CopyBundleCard data={data} />
          <ChatRowCard chat={data.chat} />

          <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Messages ({data.analysis.messageCount})
          </div>
          {data.analysis.messageSizes.map((m) => (
            <MessageCard
              key={m.id}
              size={m}
              raw={messagesById.get(m.id)}
            />
          ))}
        </>
      )}
    </div>
  );
}

function SummaryCard({ data }: { data: ChatDump }) {
  const { totalBytes, chatRowBytes, messageSizes } = data.analysis;
  const largeBundle = totalBytes >= LARGE_BUNDLE_BYTES;
  const biggest = messageSizes.reduce<MessageSize | null>(
    (max, m) => (max == null || m.bytes > max.bytes ? m : max),
    null
  );
  const totalImageBytes = messageSizes.reduce((s, m) => s + m.imageBytes, 0);
  return (
    <PaperCard className="p-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
        <Stat
          label="Total bundle"
          value={fmtBytes(totalBytes)}
          danger={largeBundle}
        />
        <Stat label="Chat row" value={fmtBytes(chatRowBytes)} />
        <Stat label="Messages" value={String(data.analysis.messageCount)} />
        <Stat
          label="Image bytes"
          value={fmtBytes(totalImageBytes)}
          danger={totalImageBytes >= LARGE_BUNDLE_BYTES}
        />
      </div>
      {biggest && (
        <div className="mt-3 text-[11px] text-muted-foreground">
          Largest message: <span className="text-foreground">#{biggest.index}</span>{" "}
          ({biggest.role}) at {fmtBytes(biggest.bytes)}
          {biggest.imageCount > 0 &&
            ` · ${biggest.imageCount} image${biggest.imageCount === 1 ? "" : "s"}`}
          .
        </div>
      )}
      {largeBundle && (
        <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
          This bundle is {fmtBytes(totalBytes)}. Bundles this large — usually
          from inline base64 image data — can exhaust memory and crash the chat
          view on mobile when the whole transcript hydrates at once.
        </div>
      )}
    </PaperCard>
  );
}

function CopyBundleCard({ data }: { data: ChatDump }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    const full = JSON.stringify(
      { chat: data.chat, messages: data.messages },
      null,
      2
    );
    void navigator.clipboard
      .writeText(full)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [data]);
  return (
    <div>
      <Button variant="outline" size="sm" onClick={onCopy} className="gap-1.5">
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        {copied ? "Copied" : "Copy full raw JSON"}
      </Button>
    </div>
  );
}

function ChatRowCard({ chat }: { chat: Record<string, unknown> | null }) {
  const [open, setOpen] = useState(false);
  return (
    <PaperCard className="p-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 text-left"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="text-sm font-medium">Chat row</span>
      </button>
      {open && (
        <pre className="mt-3 max-h-[28rem] overflow-auto rounded-md bg-muted/50 p-3 font-mono text-[10px] leading-relaxed">
          {JSON.stringify(sanitizeForDisplay(chat), null, 2)}
        </pre>
      )}
    </PaperCard>
  );
}

function MessageCard({
  size,
  raw,
}: {
  size: MessageSize;
  raw?: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const large = size.bytes >= LARGE_MESSAGE_BYTES;
  const images = Array.isArray(raw?.images)
    ? (raw!.images as Array<Record<string, unknown>>)
    : [];
  return (
    <PaperCard className={large ? "p-4 ring-1 ring-amber-500/40" : "p-4"}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-start gap-2 text-left"
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <span className="text-sm font-medium">
              #{size.index} · {size.role}
            </span>
            {size.kind && (
              <span className="text-[11px] text-muted-foreground">
                {size.kind}
              </span>
            )}
            <span
              className={`text-[11px] ${large ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
            >
              {fmtBytes(size.bytes)}
            </span>
            {size.hasError && (
              <span className="text-[11px] text-destructive">error</span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {size.imageCount > 0 && (
              <Badge
                danger={size.imageBytes >= LARGE_MESSAGE_BYTES}
                text={`${size.imageCount} img · ${fmtBytes(size.imageBytes)}`}
              />
            )}
            {size.pdfCount > 0 && <Badge text={`${size.pdfCount} pdf`} />}
            {size.csvCount > 0 && <Badge text={`${size.csvCount} csv`} />}
            {size.fileCount > 0 && <Badge text={`${size.fileCount} file`} />}
            {size.contentChars > 0 && (
              <Badge text={`content ${fmtChars(size.contentChars)}`} />
            )}
            {size.thinkingChars > 0 && (
              <Badge text={`thinking ${fmtChars(size.thinkingChars)}`} />
            )}
            {size.artifactBytes > 0 && (
              <Badge text={`artifact ${fmtBytes(size.artifactBytes)}`} />
            )}
            {size.eventsBytes > 0 && (
              <Badge text={`events ${fmtBytes(size.eventsBytes)}`} />
            )}
          </div>
          <div className="mt-1 font-mono text-[10px] text-muted-foreground">
            {size.id}
            {size.createdAt ? ` · ${new Date(size.createdAt).toLocaleString()}` : ""}
          </div>
        </div>
      </button>

      {open && (
        <div className="mt-3 space-y-3 border-t border-border/40 pt-3">
          {size.hasError && size.errorPreview && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
              {size.errorPreview}
            </div>
          )}
          {images.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Image previews
              </div>
              <div className="flex flex-wrap gap-2">
                {images.map((img, i) => {
                  const dataUrl =
                    typeof img.dataUrl === "string" ? img.dataUrl : "";
                  if (!dataUrl.startsWith("data:image")) return null;
                  return (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={(img.id as string) ?? i}
                      src={dataUrl}
                      alt={(img.name as string) ?? `image ${i}`}
                      className="h-24 w-24 rounded-md border border-border/40 object-cover"
                    />
                  );
                })}
              </div>
            </div>
          )}
          <div>
            <div className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Raw JSON
            </div>
            <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted/50 p-3 font-mono text-[10px] leading-relaxed">
              {JSON.stringify(sanitizeForDisplay(raw), null, 2)}
            </pre>
          </div>
        </div>
      )}
    </PaperCard>
  );
}

function Stat({
  label,
  value,
  danger,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={`text-sm ${danger ? "font-semibold text-amber-600 dark:text-amber-400" : "text-foreground"}`}
      >
        {value}
      </span>
    </div>
  );
}

function Badge({ text, danger }: { text: string; danger?: boolean }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] ${
        danger
          ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
          : "bg-muted text-muted-foreground"
      }`}
    >
      {text}
    </span>
  );
}

/**
 * Deep-clone a value for the pretty-printed raw view, truncating long strings
 * (mainly base64 `dataUrl`s, which can be megabytes) so the DOM stays
 * responsive. The untruncated payload is still available via "Copy full raw
 * JSON". Guards against cycles defensively though stored rows are plain trees.
 */
const MAX_STRING_DISPLAY = 400;
function sanitizeForDisplay(value: unknown, seen = new WeakSet()): unknown {
  if (typeof value === "string") {
    if (value.length <= MAX_STRING_DISPLAY) return value;
    return `${value.slice(0, 120)}…[truncated, ${value.length} chars]`;
  }
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeForDisplay(v, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = sanitizeForDisplay(v, seen);
  }
  return out;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtChars(n: number): string {
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(1)}k chars`;
}
