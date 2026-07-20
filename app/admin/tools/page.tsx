"use client";

// /admin/tools — debug surface for the LLM tool calls. Lets us run web_search,
// web_fetch, and image_search by hand and see the raw upstream payloads.
// image_search hits the Brave Images API directly; web_search / web_fetch
// hit Ollama.

import { useCallback, useState } from "react";
import { Copy, Loader2, Play, Image as ImageIcon, Search, Globe } from "lucide-react";
import { PaperCard } from "@/app/components/paper-card";
import { H1, H2 } from "@/app/components/serif-heading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type BraveImage = {
  url: string;
  source: string;
  title?: string;
  width?: number;
  height?: number;
  thumbnail?: string;
};

type WebSearchResponse = {
  tool: "web_search";
  args: Record<string, unknown>;
  durationMs: number;
  raw: unknown;
};

type WebFetchResponse = {
  tool: "web_fetch";
  args: Record<string, unknown>;
  durationMs: number;
  raw: unknown;
  contentLength: number;
  linksCount: number;
  contentLooksLikeHtml: boolean;
  contentPreview: string;
  contentTruncated: boolean;
  linksPreview: string[];
  linksTruncated: boolean;
};

type ImageSearchResponse = {
  tool: "image_search";
  args: Record<string, unknown>;
  durationMs: number;
  results: BraveImage[];
  counts: { results: number };
};

type ErrorResponse = { error: string; durationMs?: number };

type AnyResponse =
  | WebSearchResponse
  | WebFetchResponse
  | ImageSearchResponse
  | ErrorResponse;

type ToolName = "web_search" | "web_fetch" | "image_search";

function isError(r: AnyResponse | null): r is ErrorResponse {
  return !!r && "error" in r;
}

async function runTool(
  tool: ToolName,
  args: Record<string, unknown>
): Promise<AnyResponse> {
  const res = await fetch("/api/admin/tools/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  const body = (await res.json()) as AnyResponse;
  if (!res.ok && !("error" in body)) {
    return { error: `HTTP ${res.status}` } as ErrorResponse;
  }
  return body;
}

function copyJson(value: unknown) {
  try {
    void navigator.clipboard.writeText(JSON.stringify(value, null, 2));
  } catch {
    // ignore — older browsers
  }
}

function proxied(url: string): string {
  return `/api/img?u=${encodeURIComponent(url)}`;
}

function RawPanel({ value }: { value: unknown }) {
  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        className="absolute right-2 top-2 z-10 h-7 gap-1 px-2 text-xs"
        onClick={() => copyJson(value)}
      >
        <Copy className="h-3 w-3" />
        Copy JSON
      </Button>
      <pre className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted/40 p-3 pr-24 font-mono text-[11px] leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: "ok" | "warn" | "muted" }) {
  return (
    <div
      className={cn(
        "rounded-md border px-2 py-1 text-[11px]",
        tone === "ok" && "border-emerald-200 bg-emerald-50 text-emerald-800",
        tone === "warn" && "border-amber-200 bg-amber-50 text-amber-800",
        (!tone || tone === "muted") && "border-border bg-muted/40 text-muted-foreground"
      )}
    >
      <span className="font-medium uppercase tracking-wide">{label}</span>
      <span className="ml-1.5 font-mono tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function Thumb({ img }: { img: BraveImage }) {
  // Prefer Brave's CDN thumbnail when available — it loads instantly without
  // hot-link issues. The full-resolution `img.url` is what the model would
  // actually embed.
  const previewSrc = img.thumbnail ?? proxied(img.url);
  const dims =
    img.width && img.height ? `${img.width}×${img.height}` : null;
  return (
    <a
      href={img.source || img.url}
      target="_blank"
      rel="noreferrer"
      className="group block overflow-hidden rounded-md border border-border bg-muted/40"
      title={img.url}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={previewSrc}
        alt={img.title ?? ""}
        loading="lazy"
        className="h-24 w-full object-cover transition group-hover:opacity-80"
      />
      <div className="space-y-0.5 px-1.5 py-1 text-[10px] text-muted-foreground">
        {img.title ? (
          <div className="truncate font-medium text-foreground">{img.title}</div>
        ) : null}
        <div className="truncate font-mono">{img.url}</div>
        {dims ? <div className="font-mono">{dims}</div> : null}
      </div>
    </a>
  );
}

function ToolSection({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <PaperCard tone="raised" className="p-5">
      <div className="mb-3 flex items-start gap-2.5">
        <div className="mt-0.5 text-muted-foreground">{icon}</div>
        <div className="flex-1">
          <H2>{title}</H2>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </PaperCard>
  );
}

function ResultHeader({ durationMs, response }: { durationMs?: number; response: unknown }) {
  return (
    <div className="flex items-center gap-2">
      {durationMs != null ? (
        <span className="rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[11px] tabular-nums text-muted-foreground">
          {durationMs}ms
        </span>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className="h-7 gap-1 px-2 text-xs"
        onClick={() => copyJson(response)}
      >
        <Copy className="h-3 w-3" />
        Copy full response
      </Button>
    </div>
  );
}

export default function ToolsAdminPage() {
  // Local state per tool so a slow image_search doesn't block running web_fetch.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMax, setSearchMax] = useState("5");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchResp, setSearchResp] = useState<AnyResponse | null>(null);

  const [fetchUrl, setFetchUrl] = useState("");
  const [fetchBusy, setFetchBusy] = useState(false);
  const [fetchResp, setFetchResp] = useState<AnyResponse | null>(null);

  const [imgQuery, setImgQuery] = useState("");
  const [imgMax, setImgMax] = useState("6");
  const [imgBusy, setImgBusy] = useState(false);
  const [imgResp, setImgResp] = useState<AnyResponse | null>(null);

  const submit = useCallback(
    async (
      tool: ToolName,
      args: Record<string, unknown>,
      setBusy: (b: boolean) => void,
      setResp: (r: AnyResponse | null) => void
    ) => {
      setBusy(true);
      setResp(null);
      try {
        const r = await runTool(tool, args);
        setResp(r);
      } catch (err) {
        setResp({ error: err instanceof Error ? err.message : "Request failed." });
      } finally {
        setBusy(false);
      }
    },
    []
  );

  return (
    <div className="scroll-area safe-x h-full">
      <div className="mx-auto max-w-5xl px-4 pt-6 pb-16 space-y-6">
        <header>
        <H1>Tool debug</H1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Run the LLM&rsquo;s web tools by hand and inspect the raw upstream
          payloads. <code className="font-mono">image_search</code> hits the
          Brave Images API directly; <code className="font-mono">web_search</code>{" "}
          and <code className="font-mono">web_fetch</code> hit Ollama.
        </p>
      </header>

      {/* web_search */}
      <ToolSection
        icon={<Search className="h-4 w-4" />}
        title="web_search"
        description="Calls ollama.webSearch directly. Returns the raw response untouched."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(
              "web_search",
              { query: searchQuery, max_results: Number(searchMax) || 5 },
              setSearchBusy,
              setSearchResp
            );
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="min-w-0 flex-1">
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              query
            </label>
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="vizcaya village night market miami"
              required
            />
          </div>
          <div className="w-24">
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              max
            </label>
            <Input
              type="number"
              min={1}
              max={10}
              value={searchMax}
              onChange={(e) => setSearchMax(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={searchBusy || !searchQuery.trim()} className="gap-1.5">
            {searchBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Run
          </Button>
        </form>
        {searchResp ? (
          <div className="mt-4 space-y-2">
            <ResultHeader
              durationMs={(searchResp as WebSearchResponse).durationMs}
              response={searchResp}
            />
            {isError(searchResp) ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {searchResp.error}
              </div>
            ) : (
              <RawPanel value={searchResp} />
            )}
          </div>
        ) : null}
      </ToolSection>

      {/* web_fetch */}
      <ToolSection
        icon={<Globe className="h-4 w-4" />}
        title="web_fetch"
        description="Calls ollama.webFetch directly. Surfaces content length, links count, and an HTML-vs-markdown sniff."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit("web_fetch", { url: fetchUrl }, setFetchBusy, setFetchResp);
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="min-w-0 flex-1">
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              url
            </label>
            <Input
              value={fetchUrl}
              onChange={(e) => setFetchUrl(e.target.value)}
              placeholder="https://en.wikipedia.org/wiki/Cat"
              required
            />
          </div>
          <Button type="submit" disabled={fetchBusy || !fetchUrl.trim()} className="gap-1.5">
            {fetchBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Run
          </Button>
        </form>
        {fetchResp ? (
          <div className="mt-4 space-y-3">
            <ResultHeader
              durationMs={(fetchResp as WebFetchResponse).durationMs}
              response={fetchResp}
            />
            {isError(fetchResp) ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {fetchResp.error}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  <Stat
                    label="content"
                    value={`${(fetchResp as WebFetchResponse).contentLength}c`}
                  />
                  <Stat
                    label="links"
                    value={(fetchResp as WebFetchResponse).linksCount}
                  />
                  <Stat
                    label="html?"
                    value={(fetchResp as WebFetchResponse).contentLooksLikeHtml ? "yes" : "no"}
                    tone={
                      (fetchResp as WebFetchResponse).contentLooksLikeHtml
                        ? "warn"
                        : "muted"
                    }
                  />
                </div>
                <RawPanel value={fetchResp} />
              </>
            )}
          </div>
        ) : null}
      </ToolSection>

      {/* image_search */}
      <ToolSection
        icon={<ImageIcon className="h-4 w-4" />}
        title="image_search"
        description="Calls the Brave Search Images API and returns ranked image results. Requires BRAVE_SEARCH_API_KEY in the environment."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(
              "image_search",
              { query: imgQuery, max_results: Number(imgMax) || 6 },
              setImgBusy,
              setImgResp
            );
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="min-w-0 flex-1">
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              query
            </label>
            <Input
              value={imgQuery}
              onChange={(e) => setImgQuery(e.target.value)}
              placeholder="vizcaya village night market miami"
              required
            />
          </div>
          <div className="w-24">
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              max
            </label>
            <Input
              type="number"
              min={1}
              max={10}
              value={imgMax}
              onChange={(e) => setImgMax(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={imgBusy || !imgQuery.trim()} className="gap-1.5">
            {imgBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Run
          </Button>
        </form>

        {imgResp ? (
          <div className="mt-4 space-y-4">
            <ResultHeader
              durationMs={(imgResp as ImageSearchResponse).durationMs}
              response={imgResp}
            />
            {isError(imgResp) ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {imgResp.error}
              </div>
            ) : (
              <ImageSearchView resp={imgResp as ImageSearchResponse} />
            )}
          </div>
        ) : null}
      </ToolSection>
      </div>
    </div>
  );
}

function ImageSearchView({ resp }: { resp: ImageSearchResponse }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        <Stat
          label="results"
          value={resp.counts.results}
          tone={resp.counts.results > 0 ? "ok" : "warn"}
        />
      </div>

      {resp.results.length > 0 ? (
        <div>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            brave images (what image_search would return, raw URLs)
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {resp.results.map((img) => (
              <Thumb key={`brave-${img.url}`} img={img} />
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Brave returned no images for this query.
        </div>
      )}

      <details className="rounded-md border border-border">
        <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
          full raw response
        </summary>
        <div className="border-t border-border p-3">
          <RawPanel value={resp} />
        </div>
      </details>
    </div>
  );
}
