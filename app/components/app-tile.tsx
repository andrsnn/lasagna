"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { StoredApp, StoredDesigner } from "@/app/db";
import {
  gradientCss,
  monogramFor,
  patternDataUrl,
  relativeTime,
} from "@/app/lib/visuals";
import {
  generateTagline,
  resolveTaglineSync,
  shouldGenerateTagline,
} from "@/app/lib/app-summary";
import {
  generateName,
  isPlaceholderName,
  shouldGenerateName,
} from "@/app/lib/app-name";
import {
  generatePreview,
  resolvePreviewSync,
  shouldGeneratePreview,
} from "@/app/lib/app-preview";
import { useTilePreview } from "@/app/lib/tile-preview";
import { FRAME_NAMESPACE } from "@/app/lib/artifact/sdk-protocol";
import { cn } from "@/lib/utils";

const PREVIEW_SCALE = 0.28;
const GENERATE_DEBOUNCE_MS = 300;

export function AppTile({
  app,
  designer,
}: {
  app: StoredApp;
  designer?: StoredDesigner;
}) {
  // Local state so generated values upgrade in place without waiting for the
  // parent to reload from IndexedDB.
  const [name, setName] = useState(app.name);
  const [previewHtml, setPreviewHtml] = useState<string | null>(() =>
    resolvePreviewSync(app, designer)
  );

  useEffect(() => {
    setName(app.name);
  }, [app.name]);

  useEffect(() => {
    setPreviewHtml(resolvePreviewSync(app, designer));
  }, [app, designer]);

  const grad = gradientCss(app.id);
  const monogram = monogramFor(name);
  // Gemma preview wins; fall back to a real build if one was ever persisted.
  const effectivePreviewHtml = previewHtml ?? designer?.lastBuild?.html;
  const isGemmaPreview = !!previewHtml;
  const hasPreview =
    typeof effectivePreviewHtml === "string" && effectivePreviewHtml.length > 0;

  const { ref, visible, shouldMount } = useTilePreview<HTMLAnchorElement>(hasPreview);

  const initialResolution = resolveTaglineSync(app, designer);
  const [tagline, setTagline] = useState<string | null>(initialResolution.tagline);
  const [taglineSource, setTaglineSource] = useState(initialResolution.source);

  // Re-resolve synchronously when inputs change (e.g. designer loaded after mount).
  useEffect(() => {
    const r = resolveTaglineSync(app, designer);
    setTagline(r.tagline);
    setTaglineSource(r.source);
  }, [app, designer]);

  // Lazy Gemma generation, gated on visibility + debounced.
  useEffect(() => {
    if (!visible) return;
    if (!designer) return;
    if (!shouldGenerateTagline(app, designer)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      void generateTagline(app, designer).then((next) => {
        if (cancelled || !next) return;
        setTagline(next);
        setTaglineSource("gemma");
      });
    }, GENERATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [app, designer, visible]);

  // Lazy Gemma rename when the artifact is still using the placeholder.
  useEffect(() => {
    if (!visible) return;
    if (!designer) return;
    if (!shouldGenerateName(app, designer)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      void generateName(app, designer).then((next) => {
        if (cancelled || !next) return;
        setName(next);
      });
    }, GENERATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [app, designer, visible]);

  // Lazy Gemma preview generation.
  useEffect(() => {
    if (!visible) return;
    if (!designer) return;
    if (!shouldGeneratePreview(app, designer)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      void generatePreview(app, designer).then((next) => {
        if (cancelled || !next) return;
        setPreviewHtml(next);
      });
    }, GENERATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [app, designer, visible]);

  const paramSummary = Object.entries(app.params ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(" · ");

  return (
    <Link
      ref={ref}
      href={`/apps/${app.id}`}
      aria-label={`Open ${name}`}
      className={cn(
        "group/tile relative flex aspect-[5/3] flex-col overflow-hidden rounded-lg border border-border/80 bg-card transition",
        "hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      )}
    >
      <div
        className="relative h-[68%] w-full overflow-hidden"
        style={{ background: grad }}
      >
        {hasPreview && shouldMount ? (
          <PreviewIframe
            html={effectivePreviewHtml!}
            title={name}
            app={app}
            scriptsAllowed={!isGemmaPreview}
          />
        ) : (
          <FallbackHero monogram={monogram} />
        )}
        {/* soft top sheen + bottom fade for separation */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(to bottom, rgba(255,255,255,0.10), rgba(255,255,255,0) 35%, rgba(0,0,0,0) 60%, rgba(0,0,0,0.18))",
          }}
        />
        {/* hover lift */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-0 transition group-hover/tile:opacity-100"
          style={{
            background:
              "radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,0.18), rgba(255,255,255,0) 60%)",
          }}
        />
      </div>

      <div className="flex flex-1 items-center gap-2.5 border-t border-border/60 bg-card/90 px-3 py-2.5 backdrop-blur-sm">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border text-[11px] font-semibold tracking-tight text-white shadow-sm"
          style={{ background: grad }}
          aria-hidden
        >
          {monogram}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <div
              className={cn(
                "truncate text-sm font-semibold text-foreground",
                isPlaceholderName(name) && "italic text-muted-foreground"
              )}
            >
              {name}
            </div>
            <div className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
              {relativeTime(app.lastRunAt ?? app.updatedAt ?? app.createdAt)}
            </div>
          </div>
          <div className="mt-0.5 line-clamp-1 text-[11px] leading-snug text-muted-foreground">
            {tagline ? (
              tagline
            ) : paramSummary ? (
              paramSummary
            ) : taglineSource === null && shouldGenerateTagline(app, designer) ? (
              <span className="italic text-muted-foreground/60">
                {designer?.name ?? "…"}
              </span>
            ) : (
              <span className="italic text-muted-foreground/60">
                {designer?.name ?? "Unknown designer"}
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

function FallbackHero({ monogram }: { monogram: string }) {
  return (
    <div className="absolute inset-0">
      <div
        aria-hidden
        className="absolute inset-0 mix-blend-overlay opacity-40"
        style={{
          backgroundImage: patternDataUrl(),
          backgroundSize: "24px 24px",
        }}
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className="font-display text-5xl font-semibold tracking-tight text-white/90 drop-shadow-[0_2px_8px_rgba(0,0,0,0.25)] sm:text-6xl"
          aria-hidden
        >
          {monogram}
        </div>
      </div>
    </div>
  );
}

function PreviewIframe({
  html,
  title,
  app,
  scriptsAllowed,
}: {
  html: string;
  title: string;
  app: StoredApp;
  /** True when rendering a real artifact build that needs the SDK ready handshake. */
  scriptsAllowed: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Replies to the SDK's "ready" message so the artifact's
  // `await window.artifact.ready()` resolves and the page actually paints.
  // Gemma-generated previews are static — skip the listener entirely.
  useEffect(() => {
    if (!scriptsAllowed) return;
    function onMessage(event: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { ns?: string; payload?: { type?: string } } | null;
      if (!data || data.ns !== FRAME_NAMESPACE || !data.payload) return;
      if (data.payload.type !== "ready") return;
      try {
        frame.contentWindow?.postMessage(
          {
            ns: FRAME_NAMESPACE,
            payload: {
              type: "init",
              params: app.params ?? {},
              appId: app.id,
              state: app.state ?? {},
              defaultModel: app.model,
              defaultWebSearch: false,
            },
          },
          "*"
        );
      } catch {
        // ignore
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [app, scriptsAllowed]);

  // Container-relative scaling: the iframe is sized at 100/SCALE % of its
  // wrapper and then scaled down by SCALE, so it always exactly fills the
  // hero zone regardless of column width.
  const overSize = `${100 / PREVIEW_SCALE}%`;
  return (
    <div className="absolute inset-0 overflow-hidden">
      <iframe
        ref={iframeRef}
        title={`${title} preview`}
        srcDoc={html}
        sandbox={scriptsAllowed ? "allow-scripts" : ""}
        loading="lazy"
        aria-hidden
        tabIndex={-1}
        className="absolute left-0 top-0 origin-top-left border-0 bg-white"
        style={{
          width: overSize,
          height: overSize,
          transform: `scale(${PREVIEW_SCALE})`,
          pointerEvents: "none",
        }}
      />
      {/* Click-shield: ensures the parent <Link> always wins. */}
      <div aria-hidden className="absolute inset-0" />
    </div>
  );
}

export function NewArtifactTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group/new relative flex aspect-[5/3] flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl",
        "border border-dashed border-border bg-secondary/40 text-muted-foreground transition",
        "hover:border-foreground/20 hover:bg-secondary hover:text-foreground"
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-secondary transition group-hover/new:bg-primary group-hover/new:text-primary-foreground">
        <Plus className="h-5 w-5" />
      </div>
      <span className="text-sm font-medium">New artifact</span>
      <span className="px-6 text-center text-[11px] text-muted-foreground/70">
        Start a chat to design a fresh app.
      </span>
    </button>
  );
}
