"use client";

import { useEffect, useRef, useState } from "react";
import { Info, Loader2 } from "lucide-react";
import { PaperCard } from "@/app/components/paper-card";
import { H1 } from "@/app/components/serif-heading";
import type { SharedHtmlPayload } from "@/app/lib/html-share-store";
import {
  FRAME_NAMESPACE,
  type FrameRequest,
  type FrameResponse,
  type HostMessage,
} from "@/app/lib/artifact/sdk-protocol";

type FetchState =
  | { kind: "loading" }
  | { kind: "expired" }
  | { kind: "error"; message: string }
  | { kind: "ready"; payload: SharedHtmlPayload };

export function ShareHtmlClient({
  token,
  initial,
}: {
  token: string;
  initial: SharedHtmlPayload | null;
}) {
  const [state, setState] = useState<FetchState>(
    initial ? { kind: "ready", payload: initial } : { kind: "loading" }
  );
  const [showInfo, setShowInfo] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Per-viewer state lives in this browser's localStorage, keyed by token, so
  // artifact.state.* persists across reloads of the shared link without ever
  // touching the owner's data. Mirrored in a ref so the message handler reads
  // the freshest value synchronously.
  const stateRef = useRef<Record<string, unknown>>({});
  // Param values the artifact was shared with (designer-paired app shares).
  // Held in a ref so the `ready` handshake can read them even though the
  // payload arrives asynchronously.
  const paramsRef = useRef<Record<string, unknown>>({});
  // Flips true once we've answered the iframe's first `ready` with an init.
  const handshakeRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/share/html/${token}`, { cache: "no-store" });
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
        const payload = (await res.json()) as SharedHtmlPayload;
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

  // Hydrate this viewer's saved state for the token from localStorage.
  useEffect(() => {
    stateRef.current = loadViewerState(token);
  }, [token]);

  // Keep the param snapshot current as the payload resolves. If the iframe
  // already handshook before the payload landed (rare — the page is
  // server-rendered with `initial`), push the params in after the fact so the
  // artifact's onParamsChanged fires with the real values.
  useEffect(() => {
    if (state.kind !== "ready") return;
    paramsRef.current = state.payload.params ?? {};
    if (handshakeRef.current) {
      iframeRef.current?.contentWindow?.postMessage(
        {
          ns: FRAME_NAMESPACE,
          payload: {
            type: "params-changed",
            params: paramsRef.current,
          } satisfies HostMessage,
        },
        "*"
      );
    }
  }, [state]);

  // Full-power SDK bridge for the public viewer. The authenticated app uses
  // ArtifactFrame; this mirrors the subset of that host's RPCs that a shared
  // link can safely serve to an anonymous viewer:
  //   ready          → init (resolves artifact.ready(); hands over params/state)
  //   query / fetch  → forward to the public, rate-limited /query and /fetch
  //                    endpoints (these spend the operator's quota — bounded
  //                    server-side per token + per IP)
  //   state.*        → per-viewer localStorage, keyed by token (never touches
  //                    the owner's data)
  //   shared.*       → forward to /api/share/html/[token]/inputs
  //   download / open-url / clipboard-write → handled locally (the viewer page
  //                    is same-origin so it can do what the sandboxed iframe
  //                    can't)
  //   schedule.*     → resolve null. Schedules are owner/server-bound (they
  //                    need an authenticated appId), so a viewer just sees the
  //                    "no run yet" state rather than an error.
  //   log            → console so artifact errors surface during dev
  useEffect(() => {
    function reply(res: FrameResponse) {
      iframeRef.current?.contentWindow?.postMessage(
        { ns: FRAME_NAMESPACE, payload: res },
        "*"
      );
    }
    function pushHost(msg: HostMessage) {
      iframeRef.current?.contentWindow?.postMessage(
        { ns: FRAME_NAMESPACE, payload: msg },
        "*"
      );
    }

    async function handleRpc(req: FrameRequest): Promise<unknown> {
      switch (req.type) {
        case "query": {
          const r = await fetch(`/api/share/html/${token}/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: req.prompt,
              schema: req.opts?.schema,
              model: req.opts?.model,
              webSearch: req.opts?.webSearch,
              system: req.opts?.system,
            }),
          });
          const json = await r.json().catch(() => ({}));
          if (!r.ok) {
            throw new Error(
              (json as { error?: string }).error ?? `query failed (${r.status})`
            );
          }
          return json;
        }
        case "fetch": {
          const r = await fetch(`/api/share/html/${token}/fetch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: req.url,
              method: req.init?.method,
              headers: req.init?.headers,
              body: req.init?.body,
            }),
          });
          const json = await r.json().catch(() => ({}));
          if (!r.ok) {
            throw new Error(
              (json as { error?: string }).error ?? `fetch failed (${r.status})`
            );
          }
          return json;
        }
        case "state.get": {
          return stateRef.current[req.key] ?? null;
        }
        case "state.set": {
          stateRef.current = { ...stateRef.current, [req.key]: req.value };
          saveViewerState(token, stateRef.current);
          return true;
        }
        case "download": {
          const filename = sanitizeFilename(req.filename);
          const mime = safeMime(req.mime);
          let payload: BlobPart;
          if (req.bytes instanceof Uint8Array) {
            const buf = new ArrayBuffer(req.bytes.byteLength);
            new Uint8Array(buf).set(req.bytes);
            payload = buf;
          } else if (typeof req.text === "string") {
            payload = req.text;
          } else {
            throw new Error("artifact.download: missing content");
          }
          triggerDownload(filename, mime, payload);
          return true;
        }
        case "open-url": {
          const u = allowedUrl(req.url);
          if (!u) throw new Error("artifact.openUrl: blocked URL protocol");
          const target = req.target === "_top" ? "_top" : "_blank";
          window.open(u.toString(), target, "noopener,noreferrer");
          return true;
        }
        case "clipboard-write": {
          await copyText(String(req.text ?? ""));
          return true;
        }
        case "shared.append":
        case "shared.list":
        case "shared.delete": {
          return forwardSharedRpc(token, req);
        }
        case "schedule.define":
        case "schedule.get":
        case "schedule.run": {
          // No server-side schedule for an anonymous share — surface the
          // "no run yet" snapshot rather than an error.
          return null;
        }
      }
      throw new Error(`${req.type} is not available in shared viewer mode.`);
    }

    function onMessage(event: MessageEvent) {
      const iframe = iframeRef.current;
      if (!iframe) return;
      if (event.source !== iframe.contentWindow) return;
      const data = event.data as
        | { ns?: string; payload?: FrameRequest }
        | null;
      if (!data || data.ns !== FRAME_NAMESPACE || !data.payload) return;
      const req = data.payload;

      if (req.type === "ready") {
        handshakeRef.current = true;
        pushHost({
          type: "init",
          params: paramsRef.current,
          appId: token,
          state: stateRef.current,
          shareToken: token,
          shareMode: "public",
        });
        return;
      }
      if (req.type === "log") {
        try {
          // eslint-disable-next-line no-console
          (console[req.level] ?? console.log).apply(console, req.args ?? []);
        } catch {}
        return;
      }

      if (!("id" in req)) return;
      void handleRpc(req).then(
        (result) => reply({ id: req.id, ok: true, result }),
        (err: unknown) =>
          reply({
            id: req.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
      );
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [token]);

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
          Shared artifacts last 7 days. Ask the sender to generate a new link.
        </p>
      </CenteredCard>
    );
  }

  if (state.kind === "error") {
    return (
      <CenteredCard>
        <H1>Couldn&apos;t load artifact</H1>
        <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
      </CenteredCard>
    );
  }

  const { payload } = state;
  const remainingMs = Math.max(0, payload.expiresAt - now);
  const expiresLabel =
    remainingMs <= 0 ? "expired" : `expires in ${formatRemaining(remainingMs)}`;

  return (
    <div
      className="fixed inset-0 z-0 flex flex-col bg-card"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <iframe
        ref={iframeRef}
        title={payload.title}
        srcDoc={payload.html}
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
        style={{
          bottom: "calc(env(safe-area-inset-bottom) + 0.75rem)",
        }}
      >
        <Info className="h-4 w-4" />
      </button>

      {showInfo && (
        <div
          className="fixed bottom-14 right-3 z-10 max-w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-card/95 p-3 text-xs shadow-lg backdrop-blur"
          style={{
            bottom: "calc(env(safe-area-inset-bottom) + 3.25rem)",
          }}
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

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-4">
      <PaperCard tone="raised" className="max-w-md p-8 text-center">
        {children}
      </PaperCard>
    </div>
  );
}

// Same code path as the owner's ArtifactFrame uses — both contexts go
// through the public /api/share/html/[token]/inputs endpoints, so semantics
// and error messages are identical between owner and viewer.
async function forwardSharedRpc(
  token: string,
  req: FrameRequest & {
    type: "shared.append" | "shared.list" | "shared.delete";
  }
): Promise<unknown> {
  const base = `/api/share/html/${encodeURIComponent(token)}/inputs`;
  if (req.type === "shared.list") {
    const r = await fetch(
      `${base}?collection=${encodeURIComponent(req.collection)}`,
      { method: "GET", cache: "no-store" }
    );
    const body = (await r.json().catch(() => ({}))) as {
      entries?: unknown;
      error?: string;
    };
    if (!r.ok) throw new Error(body.error ?? `shared.list failed (${r.status})`);
    return Array.isArray(body.entries) ? body.entries : [];
  }
  if (req.type === "shared.append") {
    const r = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collection: req.collection, value: req.value }),
    });
    const body = (await r.json().catch(() => ({}))) as {
      entry?: unknown;
      error?: string;
    };
    if (!r.ok) throw new Error(body.error ?? `shared.append failed (${r.status})`);
    return body.entry ?? null;
  }
  const r = await fetch(
    `${base}/${encodeURIComponent(req.entryId)}?collection=${encodeURIComponent(req.collection)}`,
    { method: "DELETE" }
  );
  const body = (await r.json().catch(() => ({}))) as {
    removed?: boolean;
    error?: string;
  };
  if (!r.ok) throw new Error(body.error ?? `shared.delete failed (${r.status})`);
  return body.removed === true;
}

// ----- Per-viewer state (localStorage, keyed by share token) -----

function viewerStateKey(token: string): string {
  return `artifact-share-state:${token}`;
}

function loadViewerState(token: string): Record<string, unknown> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(viewerStateKey(token));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function saveViewerState(token: string, state: Record<string, unknown>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(viewerStateKey(token), JSON.stringify(state));
  } catch {
    // Quota / serialization failure — the in-memory ref still serves reads
    // for the rest of the session.
  }
}

// ----- Host-side helpers for download / open-url / clipboard. These mirror
// the validation in app/components/artifact-frame.tsx so a shared artifact
// behaves identically to the owner's frame. -----

const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
const CLIPBOARD_MAX_CHARS = 2 * 1024 * 1024;
const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;

function sanitizeFilename(raw: string): string {
  const oneLine = String(raw ?? "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\\/]+/g, "_")
    .replace(/\.\.+/g, "_")
    .trim();
  if (!oneLine || oneLine === "_") return "download";
  if (oneLine.length <= 200) return oneLine;
  const dot = oneLine.lastIndexOf(".");
  if (dot < 0 || dot < oneLine.length - 16) return oneLine.slice(0, 200);
  const ext = oneLine.slice(dot);
  return oneLine.slice(0, 200 - ext.length) + ext;
}

function safeMime(raw: string | undefined): string {
  if (!raw) return "application/octet-stream";
  const trimmed = String(raw).trim();
  if (trimmed.length > 100 || !MIME_RE.test(trimmed)) return "application/octet-stream";
  return trimmed;
}

function allowedUrl(raw: string): URL | null {
  try {
    const u = new URL(String(raw));
    return ALLOWED_URL_PROTOCOLS.has(u.protocol) ? u : null;
  } catch {
    return null;
  }
}

function triggerDownload(filename: string, mime: string, payload: BlobPart): void {
  const size =
    payload instanceof ArrayBuffer
      ? payload.byteLength
      : typeof payload === "string"
        ? payload.length
        : 0;
  if (size > DOWNLOAD_MAX_BYTES) {
    throw new Error(`artifact.download: payload too large (max ${DOWNLOAD_MAX_BYTES} bytes)`);
  }
  const blob = new Blob([payload], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text: string): Promise<void> {
  if (text.length > CLIPBOARD_MAX_CHARS) {
    throw new Error("artifact.copyToClipboard: text too large");
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      ta.remove();
    }
  }
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
