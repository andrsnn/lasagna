"use client";

// /admin/account-sync — debug the designer → blob → Redis pipeline.
//
// Type in a user's email, hit Inspect, and you see the Redis-side picture
// of their shared rows: which designers are in the new ref shape vs.
// still-inline legacy, what the blob URLs are, whether each blob is
// actually reachable from this server (HEAD probe), and which versions
// the history-blobs map covers.
//
// Use when a device-to-device sync isn't propagating. The common failure
// modes the tool calls out explicitly via per-row "warnings":
//
//   - row absent from Redis (the push never landed)
//   - row carries no filesBlobUrl AND no inline files (the push landed
//     malformed, e.g. the blob upload step failed midway)
//   - filesBlobVersion lags row.version (a stale pointer; readers hydrate
//     an older VFS than the dropdown says)
//   - filesBlobUrl returns non-2xx (e.g. blob was deleted out from under
//     the pointer; receivers can't hydrate)

import { useCallback, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Loader2, Search } from "lucide-react";
import { PaperCard } from "@/app/components/paper-card";
import { H1 } from "@/app/components/serif-heading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type BlobProbe = {
  url: string;
  status: number;
  ok: boolean;
  contentLength?: number | null;
  error?: string;
};

type DesignerInspection = {
  id: string;
  name: string;
  version: number;
  updatedAt?: number;
  lastSyncedAt?: number;
  accountShared: boolean;
  shape: "ref" | "legacy-inline" | "mixed" | "missing";
  hasInlineFiles: boolean;
  inlineHistoryCount: number;
  filesBlobUrl?: string;
  filesBlobVersion?: number;
  historyBlobVersionCount: number;
  historyBlobVersions: number[];
  indexScore?: number;
  filesBlobProbe?: BlobProbe;
  sampleHistoryBlobProbes?: BlobProbe[];
  warnings: string[];
};

type AppInspection = {
  id: string;
  name: string;
  updatedAt?: number;
  lastSyncedAt?: number;
  accountShared: boolean;
  indexScore?: number;
};

type ChatInspection = {
  id: string;
  name: string;
  updatedAt?: number;
  lastSyncedAt?: number;
  accountShared: boolean;
  messageCount: number;
  archived: boolean;
  indexScore?: number;
  warnings: string[];
};

type NoteInspection = {
  id: string;
  name: string;
  updatedAt?: number;
  lastSyncedAt?: number;
  accountShared: boolean;
  indexScore?: number;
};

type Inspection = {
  email: string;
  designers: DesignerInspection[];
  apps: AppInspection[];
  chats: ChatInspection[];
  notes: NoteInspection[];
  indexSize: number;
};

export default function AccountSyncAdminPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Inspection | null>(null);

  const handleInspect = useCallback(async () => {
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/account-sync?email=${encodeURIComponent(email.trim())}`,
        { cache: "no-store" }
      );
      const body = (await res.json()) as Inspection | { error: string };
      if (!res.ok || "error" in body) {
        setError("error" in body ? body.error : `Server returned ${res.status}`);
        return;
      }
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Inspect failed.");
    } finally {
      setLoading(false);
    }
  }, [email]);

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <H1>Account sync</H1>
        <p className="text-sm text-muted-foreground">
          Inspect a user&rsquo;s account-shared designers, apps, chats, and
          notes in Redis + Vercel Blob. The tool flags ref/legacy shape, stale
          pointer versions, missing blobs, empty chat bundles, and stranded
          rows.
        </p>
      </header>

      <PaperCard className="p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label
              htmlFor="email-input"
              className="mb-1 block text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
            >
              User email
            </label>
            <Input
              id="email-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleInspect();
              }}
              placeholder="user@example.com"
              autoComplete="off"
            />
          </div>
          <Button
            onClick={() => void handleInspect()}
            disabled={loading || !email.trim()}
            className="gap-1.5"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            Inspect
          </Button>
        </div>
        {error && (
          <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
      </PaperCard>

      {data && (
        <>
          <PaperCard className="p-4">
            <div className="text-sm">
              <div className="font-medium">{data.email}</div>
              <div className="text-xs text-muted-foreground">
                {data.indexSize} entries in account index ·{" "}
                {data.designers.length} designers · {data.apps.length} apps ·{" "}
                {data.chats.length} chats · {data.notes.length} notes
              </div>
            </div>
          </PaperCard>

          {data.designers.length === 0 && (
            <PaperCard className="p-4 text-xs text-muted-foreground">
              No designers in this account&rsquo;s shared index.
            </PaperCard>
          )}

          {data.designers.map((d) => (
            <DesignerCard key={d.id} d={d} />
          ))}

          {data.apps.length > 0 && (
            <PaperCard className="p-4">
              <div className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Apps ({data.apps.length})
              </div>
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="pb-1 pr-3 font-normal">Name</th>
                    <th className="pb-1 pr-3 font-normal">ID</th>
                    <th className="pb-1 pr-3 font-normal">Shared</th>
                    <th className="pb-1 pr-3 font-normal">Last synced</th>
                    <th className="pb-1 pr-3 font-normal">Index score</th>
                  </tr>
                </thead>
                <tbody>
                  {data.apps.map((a) => (
                    <tr key={a.id} className="border-t border-border/40">
                      <td className="py-1.5 pr-3">{a.name}</td>
                      <td className="py-1.5 pr-3 font-mono text-[10px]">{a.id}</td>
                      <td className="py-1.5 pr-3">
                        {a.accountShared ? "✓" : "—"}
                      </td>
                      <td className="py-1.5 pr-3">{fmtTime(a.lastSyncedAt)}</td>
                      <td className="py-1.5 pr-3">{fmtTime(a.indexScore)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </PaperCard>
          )}

          {data.chats.length > 0 && (
            <PaperCard className="p-4">
              <div className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Chats ({data.chats.length})
              </div>
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="pb-1 pr-3 font-normal">Title</th>
                    <th className="pb-1 pr-3 font-normal">ID</th>
                    <th className="pb-1 pr-3 font-normal">Shared</th>
                    <th className="pb-1 pr-3 font-normal">Msgs</th>
                    <th className="pb-1 pr-3 font-normal">Updated</th>
                    <th className="pb-1 pr-3 font-normal">Index score</th>
                  </tr>
                </thead>
                <tbody>
                  {data.chats.map((c) => (
                    <tr
                      key={c.id}
                      className="border-t border-border/40 align-top"
                    >
                      <td className="py-1.5 pr-3">
                        <div className="flex items-center gap-1.5">
                          <Link
                            href={`/admin/account-sync/chat/${encodeURIComponent(c.id)}?email=${encodeURIComponent(data.email)}`}
                            className="font-medium text-foreground underline decoration-border/60 underline-offset-2 hover:decoration-foreground"
                          >
                            {c.name}
                          </Link>
                          {c.archived && (
                            <span className="text-[10px] text-muted-foreground">
                              (trashed)
                            </span>
                          )}
                        </div>
                        {c.warnings.length > 0 && (
                          <ul className="mt-0.5 space-y-0.5 text-[10px] text-destructive">
                            {c.warnings.map((w, i) => (
                              <li key={i}>• {w}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-[10px]">{c.id}</td>
                      <td className="py-1.5 pr-3">
                        {c.accountShared ? "✓" : "—"}
                      </td>
                      <td
                        className={`py-1.5 pr-3 ${c.messageCount === 0 ? "text-destructive" : ""}`}
                      >
                        {c.messageCount}
                      </td>
                      <td className="py-1.5 pr-3">{fmtTime(c.updatedAt)}</td>
                      <td className="py-1.5 pr-3">{fmtTime(c.indexScore)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </PaperCard>
          )}

          {data.notes.length > 0 && (
            <PaperCard className="p-4">
              <div className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Notes ({data.notes.length})
              </div>
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="pb-1 pr-3 font-normal">Title</th>
                    <th className="pb-1 pr-3 font-normal">ID</th>
                    <th className="pb-1 pr-3 font-normal">Shared</th>
                    <th className="pb-1 pr-3 font-normal">Updated</th>
                    <th className="pb-1 pr-3 font-normal">Index score</th>
                  </tr>
                </thead>
                <tbody>
                  {data.notes.map((n) => (
                    <tr key={n.id} className="border-t border-border/40">
                      <td className="py-1.5 pr-3">{n.name}</td>
                      <td className="py-1.5 pr-3 font-mono text-[10px]">{n.id}</td>
                      <td className="py-1.5 pr-3">
                        {n.accountShared ? "✓" : "—"}
                      </td>
                      <td className="py-1.5 pr-3">{fmtTime(n.updatedAt)}</td>
                      <td className="py-1.5 pr-3">{fmtTime(n.indexScore)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </PaperCard>
          )}
        </>
      )}
    </div>
  );
}

function DesignerCard({ d }: { d: DesignerInspection }) {
  const [open, setOpen] = useState(d.warnings.length > 0);
  const shapeColor =
    d.shape === "ref"
      ? "text-emerald-600"
      : d.shape === "legacy-inline"
        ? "text-amber-600"
        : d.shape === "mixed"
          ? "text-amber-600"
          : "text-destructive";
  return (
    <PaperCard className="p-4">
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
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <div className="text-sm font-medium">{d.name}</div>
            <div className="text-xs text-muted-foreground">v{d.version}</div>
            <div className={`text-xs ${shapeColor}`}>{d.shape}</div>
            {d.warnings.length > 0 && (
              <div className="text-xs text-destructive">
                {d.warnings.length} warning{d.warnings.length === 1 ? "" : "s"}
              </div>
            )}
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            {d.id}
          </div>
        </div>
      </button>

      {open && (
        <div className="mt-3 space-y-3 border-t border-border/40 pt-3 text-xs">
          {d.warnings.length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2">
              <div className="mb-1 font-medium text-destructive">Warnings</div>
              <ul className="space-y-1 text-destructive">
                {d.warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <Field label="Shared" value={d.accountShared ? "yes" : "no"} />
            <Field label="Shape" value={d.shape} />
            <Field label="Row updatedAt" value={fmtTime(d.updatedAt)} />
            <Field label="Row lastSyncedAt" value={fmtTime(d.lastSyncedAt)} />
            <Field label="Index score" value={fmtTime(d.indexScore)} />
            <Field label="Inline files" value={d.hasInlineFiles ? "yes" : "no"} />
            <Field
              label="Inline history"
              value={`${d.inlineHistoryCount} commit(s)`}
            />
            <Field
              label="filesBlobVersion"
              value={d.filesBlobVersion?.toString() ?? "—"}
            />
            <Field
              label="History blobs"
              value={`${d.historyBlobVersionCount} version(s)`}
            />
            {d.historyBlobVersions.length > 0 && (
              <Field
                label="Version range"
                value={`v${d.historyBlobVersions[0]} – v${d.historyBlobVersions[d.historyBlobVersions.length - 1]}`}
              />
            )}
          </div>

          {d.filesBlobUrl && (
            <div>
              <div className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Current VFS blob
              </div>
              <BlobLine probe={d.filesBlobProbe} fallbackUrl={d.filesBlobUrl} />
            </div>
          )}

          {d.sampleHistoryBlobProbes && d.sampleHistoryBlobProbes.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                History blob probes (newest 3)
              </div>
              <div className="space-y-1">
                {d.sampleHistoryBlobProbes.map((p, i) => (
                  <BlobLine key={i} probe={p} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </PaperCard>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="truncate text-foreground">{value}</span>
    </div>
  );
}

function BlobLine({
  probe,
  fallbackUrl,
}: {
  probe?: BlobProbe;
  fallbackUrl?: string;
}) {
  if (!probe && fallbackUrl) {
    return (
      <div className="break-all font-mono text-[10px] text-muted-foreground">
        {fallbackUrl}
      </div>
    );
  }
  if (!probe) return null;
  const color = probe.ok ? "text-emerald-600" : "text-destructive";
  return (
    <div className="space-y-0.5">
      <div className="break-all font-mono text-[10px] text-muted-foreground">
        {probe.url}
      </div>
      <div className={`text-[10px] ${color}`}>
        {probe.ok
          ? `200 · ${fmtBytes(probe.contentLength)}`
          : probe.error
            ? `error: ${probe.error}`
            : `HTTP ${probe.status}`}
      </div>
    </div>
  );
}

function fmtTime(ms?: number): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  return d.toLocaleString();
}

function fmtBytes(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
