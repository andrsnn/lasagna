"use client";

// /admin/runpod — debug surface for the RunPod Serverless integration. Sends
// a raw probe to the configured endpoint (bypassing the chat work loop and
// Redis stream) and surfaces every layer: the OpenAI-shape request body the
// app would send, the response status/headers, the raw stream events with
// timestamps, and the Ollama-shape parsed result. Use this when chat
// responses come back empty (0 tokens, no content) — the gap between "what
// RunPod sent" and "what the app extracted" shows up here.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Loader2, Play, ListChecks, Send, Radio } from "lucide-react";
import { PaperCard } from "@/app/components/paper-card";
import { H1, H2 } from "@/app/components/serif-heading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type ProbeAction = "list" | "chat" | "stream";

type RawEvent = { tMs: number; data: string; parsed?: unknown };

type RequestEcho = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

type ResponseEcho = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyText?: string;
  bodyTruncated?: boolean;
  bodyByteLength?: number;
  json?: unknown;
};

type ParsedStream = {
  ok: boolean;
  acc: {
    content: string;
    thinking: string;
    promptTokens: number;
    completionTokens: number;
    doneReason: string | null;
    toolCalls: Array<{ name: string; arguments: unknown }>;
    chunkCount: number;
    firstChunkMs: number | null;
    lastChunkMs: number | null;
  };
  error?: string;
};

type ProbeResponse =
  | {
      action: ProbeAction;
      ok?: boolean;
      request: RequestEcho;
      response?: ResponseEcho;
      events?: RawEvent[];
      parsedOllama?: unknown;
      parsedStream?: ParsedStream;
      timing?: { headersMs?: number; totalMs?: number };
      error?: string;
    }
  | { error: string };

function isError(r: ProbeResponse | null): r is { error: string } {
  return !!r && "error" in r && Object.keys(r).length === 1;
}

function copyText(value: unknown) {
  try {
    void navigator.clipboard.writeText(
      typeof value === "string" ? value : JSON.stringify(value, null, 2)
    );
  } catch {}
}

function CopyButton({ value, label = "Copy" }: { value: unknown; label?: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-7 gap-1 px-2 text-xs"
      onClick={() => copyText(value)}
    >
      <Copy className="h-3 w-3" />
      {label}
    </Button>
  );
}

function JsonPanel({ value, maxHeight = "60vh" }: { value: unknown; maxHeight?: string }) {
  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10">
        <CopyButton value={value} />
      </div>
      <pre
        className="overflow-auto rounded-md border border-border bg-muted/40 p-3 pr-24 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all"
        style={{ maxHeight }}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function TextPanel({ value, maxHeight = "40vh" }: { value: string; maxHeight?: string }) {
  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-10">
        <CopyButton value={value} />
      </div>
      <pre
        className="overflow-auto rounded-md border border-border bg-muted/40 p-3 pr-24 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all"
        style={{ maxHeight }}
      >
        {value || <span className="text-muted-foreground">(empty)</span>}
      </pre>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "ok" | "warn" | "bad" | "muted";
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-2 py-1 text-[11px]",
        tone === "ok" && "border-emerald-200 bg-emerald-50 text-emerald-800",
        tone === "warn" && "border-amber-200 bg-amber-50 text-amber-800",
        tone === "bad" && "border-rose-200 bg-rose-50 text-rose-800",
        (!tone || tone === "muted") &&
          "border-border bg-muted/40 text-muted-foreground"
      )}
    >
      <span className="font-medium uppercase tracking-wide">{label}</span>
      <span className="ml-1.5 font-mono tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function StatusPill({ resp }: { resp: ProbeResponse }) {
  if (isError(resp)) {
    return <Stat label="error" value={resp.error.slice(0, 60)} tone="bad" />;
  }
  if (resp.error) {
    return <Stat label="error" value={resp.error.slice(0, 60)} tone="bad" />;
  }
  const status = resp.response?.status ?? 0;
  const tone = status >= 200 && status < 300 ? "ok" : status > 0 ? "bad" : "warn";
  const code = status > 0 ? `${status} ${resp.response?.statusText ?? ""}`.trim() : "no response";
  return <Stat label="status" value={code} tone={tone} />;
}

const DEFAULT_PROMPT = "Say hi back in exactly five words.";

export default function RunpodAdminPage() {
  const [endpointId, setEndpointId] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [maxTokens, setMaxTokens] = useState("128");
  const [temperature, setTemperature] = useState("0.7");
  const [busy, setBusy] = useState<ProbeAction | null>(null);
  const [resp, setResp] = useState<ProbeResponse | null>(null);
  const [models, setModels] = useState<string[] | null>(null);

  // Persist last-used inputs in localStorage so reloading the page keeps
  // your debug session in place.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("admin:runpod:inputs");
      if (raw) {
        const v = JSON.parse(raw) as {
          endpointId?: string;
          model?: string;
          prompt?: string;
          maxTokens?: string;
          temperature?: string;
        };
        if (v.endpointId) setEndpointId(v.endpointId);
        if (v.model) setModel(v.model);
        if (v.prompt) setPrompt(v.prompt);
        if (v.maxTokens) setMaxTokens(v.maxTokens);
        if (v.temperature) setTemperature(v.temperature);
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        "admin:runpod:inputs",
        JSON.stringify({ endpointId, model, prompt, maxTokens, temperature })
      );
    } catch {}
  }, [endpointId, model, prompt, maxTokens, temperature]);

  const send = useCallback(
    async (action: ProbeAction) => {
      setBusy(action);
      setResp(null);
      try {
        const opts: Record<string, number> = {};
        const mt = Number(maxTokens);
        if (Number.isFinite(mt) && mt > 0) opts.num_predict = mt;
        const tp = Number(temperature);
        if (Number.isFinite(tp)) opts.temperature = tp;

        const payload: Record<string, unknown> = { action };
        if (endpointId.trim()) payload.endpointId = endpointId.trim();
        if (action !== "list") {
          if (!model.trim()) {
            setResp({ error: "Model is required for chat/stream." });
            setBusy(null);
            return;
          }
          payload.model = model.trim();
          payload.prompt = prompt;
          if (Object.keys(opts).length > 0) payload.options = opts;
        }
        const res = await fetch("/api/admin/runpod/probe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = (await res.json()) as ProbeResponse;
        if (!res.ok && !("error" in body) && !(body as { request?: unknown }).request) {
          setResp({ error: `HTTP ${res.status}` });
        } else {
          setResp(body);
          if (action === "list" && !("error" in body)) {
            const json = body.response?.json as
              | { data?: Array<{ id: string }> }
              | undefined;
            if (json?.data) setModels(json.data.map((m) => m.id));
          }
        }
      } catch (err) {
        setResp({ error: err instanceof Error ? err.message : "Request failed." });
      } finally {
        setBusy(null);
      }
    },
    [endpointId, model, prompt, maxTokens, temperature]
  );

  const diagnostics = useMemo(() => {
    if (!resp || isError(resp)) return null;
    if (resp.action === "list") return null;
    const out: Array<{ label: string; tone: "ok" | "warn" | "bad" | "muted"; hint?: string }> = [];

    // The model field may be sent bare (`default`) or prefixed (`runpod:default`).
    // The probe always strips the prefix, so check the raw user input here.
    const sentModel = (resp.request.body as { model?: string } | undefined)?.model ?? "";
    const isPlaceholderModel = sentModel === "default";

    const status = resp.response?.status ?? 0;
    if (status === 0) {
      out.push({ label: "no response", tone: "bad", hint: "fetch never completed (network error)" });
    } else if (status === 401 || status === 403) {
      out.push({ label: `${status} unauthorized`, tone: "bad", hint: "RUNPOD_API_KEY may be wrong" });
    } else if (status === 404 && isPlaceholderModel) {
      out.push({
        label: "404 placeholder",
        tone: "bad",
        hint: "you sent model=\"default\" — the worker forwards that to local Ollama which 404s. Click 'List models' and pick a real id.",
      });
    } else if (status === 404) {
      out.push({ label: "404", tone: "bad", hint: "endpoint id wrong, model not loaded, or worker doesn't expose /openai/v1" });
    } else if (status === 408 || status === 504) {
      out.push({ label: `${status} timeout`, tone: "warn", hint: "cold start or worker stuck" });
    } else if (status === 429) {
      out.push({ label: "429", tone: "warn", hint: "rate limited or queue full" });
    } else if (status >= 500) {
      out.push({ label: `${status} upstream`, tone: "bad" });
    }

    if (resp.action === "stream" && resp.parsedStream) {
      const acc = resp.parsedStream.acc;
      if (acc.chunkCount === 0) {
        out.push({ label: "0 chunks", tone: "bad", hint: "stream opened but yielded nothing" });
      }
      if (acc.content.length === 0 && acc.thinking.length === 0 && acc.toolCalls.length === 0) {
        out.push({
          label: "no content",
          tone: "bad",
          hint: "stream produced no assistant text — explains 'Hi' getting empty replies",
        });
      }
      if (acc.promptTokens === 0 && acc.completionTokens === 0) {
        out.push({
          label: "0 tokens",
          tone: "warn",
          hint: "no usage block — worker may not honor stream_options.include_usage",
        });
      }
      if (!resp.parsedStream.ok && resp.parsedStream.error) {
        out.push({ label: "parse error", tone: "bad", hint: resp.parsedStream.error });
      }
    }

    if (resp.action === "chat" && resp.parsedOllama) {
      const po = resp.parsedOllama as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      if (!po.message?.content) {
        out.push({ label: "no content", tone: "bad", hint: "non-stream response had empty assistant message" });
      }
      if ((po.prompt_eval_count ?? 0) === 0 && (po.eval_count ?? 0) === 0) {
        out.push({ label: "0 tokens", tone: "warn", hint: "response carried no usage block" });
      }
    }

    if (out.length === 0) out.push({ label: "looks healthy", tone: "ok" });
    return out;
  }, [resp]);

  return (
    <div className="scroll-area safe-x h-full">
      <div className="mx-auto max-w-5xl space-y-6 px-4 pt-6 pb-16">
        <header>
          <H1>RunPod debug</H1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Send a raw probe to the configured RunPod endpoint and inspect every
            layer of the exchange. The probe bypasses the chat work loop and
            Redis stream — you see the literal HTTP request, response headers,
            raw SSE events, and the Ollama-shape parsed result. Use this when
            chat replies come back empty. Start with <em>List models</em> — if
            the worker only shows <span className="font-mono">default</span>,
            its model hasn&rsquo;t pulled yet and any chat will 404.
          </p>
        </header>

        <PaperCard tone="raised" className="p-5">
          <div className="mb-3 flex items-start gap-2.5">
            <div className="mt-0.5 text-muted-foreground">
              <Radio className="h-4 w-4" />
            </div>
            <div className="flex-1">
              <H2>Probe</H2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                <code className="font-mono">RUNPOD_API_KEY</code> is read from the
                server. Endpoint id falls back to{" "}
                <code className="font-mono">RUNPOD_ENDPOINT_ID</code> when empty.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                endpoint id (override)
              </label>
              <Input
                value={endpointId}
                onChange={(e) => setEndpointId(e.target.value)}
                placeholder="(leave empty to use RUNPOD_ENDPOINT_ID)"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                model
              </label>
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="e.g. llama-3.1-8b-instruct"
              />
              {model.trim() === "default" ? (
                <div className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                  <span className="font-mono">default</span> is the placeholder
                  the picker shows before models load. Workers using
                  OllamaOpenAiEngine 404 on it. Click <em>List models</em> and
                  pick a real id.
                </div>
              ) : null}
              {models && models.length > 0 ? (
                <>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {models.slice(0, 12).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setModel(m)}
                        className={cn(
                          "rounded-md border px-1.5 py-0.5 font-mono text-[10px] hover:bg-muted",
                          m === "default"
                            ? "border-amber-200 bg-amber-50 text-amber-800"
                            : "border-border bg-muted/40 text-muted-foreground"
                        )}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  {models.includes("default") && models.some((m) => m !== "default") ? (
                    <div className="mt-1 text-[11px] text-amber-800">
                      Worker advertises both <span className="font-mono">default</span>{" "}
                      and real model ids — pick a real one; <span className="font-mono">default</span>{" "}
                      will 404.
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                prompt (sent as a single user message)
              </label>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                max_tokens (num_predict)
              </label>
              <Input
                type="number"
                min={1}
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                temperature
              </label>
              <Input
                type="number"
                step="0.1"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => void send("list")}
              disabled={busy != null}
              variant="outline"
              className="gap-1.5"
            >
              {busy === "list" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ListChecks className="h-3.5 w-3.5" />
              )}
              List models
            </Button>
            <Button
              type="button"
              onClick={() => void send("chat")}
              disabled={busy != null}
              variant="outline"
              className="gap-1.5"
            >
              {busy === "chat" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Send (non-stream)
            </Button>
            <Button
              type="button"
              onClick={() => void send("stream")}
              disabled={busy != null}
              className="gap-1.5"
            >
              {busy === "stream" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Send (stream)
            </Button>
          </div>
        </PaperCard>

        {resp ? <ResultView resp={resp} diagnostics={diagnostics} /> : null}
      </div>
    </div>
  );
}

function ResultView({
  resp,
  diagnostics,
}: {
  resp: ProbeResponse;
  diagnostics: Array<{ label: string; tone: "ok" | "warn" | "bad" | "muted"; hint?: string }> | null;
}) {
  if (isError(resp)) {
    return (
      <PaperCard tone="raised" className="p-5">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {resp.error}
        </div>
      </PaperCard>
    );
  }

  const action = resp.action;
  const totalMs = resp.timing?.totalMs;
  const headersMs = resp.timing?.headersMs;

  return (
    <PaperCard tone="raised" className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Stat label="action" value={action} />
        <StatusPill resp={resp} />
        {totalMs != null ? <Stat label="total" value={`${totalMs}ms`} /> : null}
        {headersMs != null ? <Stat label="headers" value={`${headersMs}ms`} /> : null}
        {resp.action === "stream" && resp.parsedStream ? (
          <>
            <Stat label="chunks" value={resp.parsedStream.acc.chunkCount} />
            <Stat
              label="prompt tok"
              value={resp.parsedStream.acc.promptTokens}
              tone={resp.parsedStream.acc.promptTokens === 0 ? "warn" : "ok"}
            />
            <Stat
              label="comp tok"
              value={resp.parsedStream.acc.completionTokens}
              tone={resp.parsedStream.acc.completionTokens === 0 ? "warn" : "ok"}
            />
            {resp.parsedStream.acc.firstChunkMs != null ? (
              <Stat label="ttfb" value={`${resp.parsedStream.acc.firstChunkMs}ms`} />
            ) : null}
          </>
        ) : null}
        {resp.response?.bodyByteLength != null ? (
          <Stat label="body" value={`${resp.response.bodyByteLength}b`} />
        ) : null}
      </div>

      {diagnostics ? (
        <div className="space-y-1">
          {diagnostics.map((d, i) => (
            <div
              key={i}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2 py-1 text-xs",
                d.tone === "ok" && "border-emerald-200 bg-emerald-50 text-emerald-800",
                d.tone === "warn" && "border-amber-200 bg-amber-50 text-amber-800",
                d.tone === "bad" && "border-rose-200 bg-rose-50 text-rose-800",
                d.tone === "muted" && "border-border bg-muted/40 text-muted-foreground"
              )}
            >
              <span className="font-medium uppercase tracking-wide">{d.label}</span>
              {d.hint ? <span className="text-foreground/80">— {d.hint}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {resp.error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {resp.error}
        </div>
      ) : null}

      <Section title="Request" subtitle={`${resp.request.method} ${resp.request.url}`}>
        <div className="space-y-2">
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              headers (Authorization redacted)
            </div>
            <JsonPanel value={resp.request.headers} maxHeight="20vh" />
          </div>
          {resp.request.body !== undefined ? (
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                body
              </div>
              <JsonPanel value={resp.request.body} />
            </div>
          ) : null}
        </div>
      </Section>

      {resp.response ? (
        <Section
          title="Response"
          subtitle={`${resp.response.status} ${resp.response.statusText}`}
        >
          <div className="space-y-2">
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                headers
              </div>
              <JsonPanel value={resp.response.headers} maxHeight="20vh" />
            </div>
            {resp.response.json !== undefined && resp.response.json !== null ? (
              <div>
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  body (parsed JSON)
                </div>
                <JsonPanel value={resp.response.json} />
              </div>
            ) : resp.response.bodyText != null ? (
              <div>
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  body (raw text{resp.response.bodyTruncated ? ", truncated" : ""})
                </div>
                <TextPanel value={resp.response.bodyText} />
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}

      {resp.events && resp.events.length > 0 ? (
        <Section
          title="SSE events"
          subtitle={`${resp.events.length} event${resp.events.length === 1 ? "" : "s"} captured`}
        >
          <EventsTable events={resp.events} />
        </Section>
      ) : resp.action === "stream" && resp.events ? (
        <Section title="SSE events" subtitle="0 events captured">
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            The stream produced no SSE records. The worker may have closed the
            connection before emitting any data, or the response wasn&rsquo;t
            event-stream encoded.
          </div>
        </Section>
      ) : null}

      {resp.parsedStream ? (
        <Section title="Parsed (Ollama-shape)" subtitle="what the chat work loop would see">
          <JsonPanel value={resp.parsedStream} />
        </Section>
      ) : null}

      {resp.parsedOllama ? (
        <Section title="Parsed (Ollama-shape)" subtitle="non-stream ChatResponse">
          <JsonPanel value={resp.parsedOllama} />
        </Section>
      ) : null}
    </PaperCard>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <details open className="rounded-lg border border-border bg-card/40">
      <summary className="cursor-pointer px-3 py-2">
        <span className="text-sm font-medium text-foreground">{title}</span>
        {subtitle ? (
          <span className="ml-2 font-mono text-[11px] text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </summary>
      <div className="border-t border-border p-3">{children}</div>
    </details>
  );
}

function EventsTable({ events }: { events: RawEvent[] }) {
  const fullText = useMemo(
    () => events.map((e) => `[${e.tMs}ms] ${e.data}`).join("\n"),
    [events]
  );
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <CopyButton value={fullText} label="Copy event log" />
      </div>
      <div className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted/40">
        <table className="w-full font-mono text-[11px]">
          <thead className="sticky top-0 bg-muted/80 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-16 px-2 py-1.5">t (ms)</th>
              <th className="px-2 py-1.5">data</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e, i) => {
              const isDone = e.data === "[DONE]";
              const isOther = e.data.startsWith("<");
              const delta =
                e.parsed &&
                typeof e.parsed === "object" &&
                "choices" in (e.parsed as object)
                  ? extractDelta(e.parsed)
                  : null;
              return (
                <tr
                  key={i}
                  className={cn(
                    "border-t border-border/60 align-top",
                    isDone && "bg-emerald-50/60",
                    isOther && "bg-amber-50/60"
                  )}
                >
                  <td className="px-2 py-1 tabular-nums text-muted-foreground">
                    {e.tMs}
                  </td>
                  <td className="px-2 py-1 break-all">
                    {delta ? (
                      <div className="space-y-0.5">
                        {delta.content ? (
                          <div>
                            <span className="text-muted-foreground">delta.content:</span>{" "}
                            <span className="text-foreground">
                              {JSON.stringify(delta.content)}
                            </span>
                          </div>
                        ) : null}
                        {delta.thinking ? (
                          <div>
                            <span className="text-muted-foreground">reasoning:</span>{" "}
                            <span className="text-foreground">
                              {JSON.stringify(delta.thinking)}
                            </span>
                          </div>
                        ) : null}
                        {delta.toolCallSummary ? (
                          <div>
                            <span className="text-muted-foreground">tool_calls:</span>{" "}
                            <span className="text-foreground">{delta.toolCallSummary}</span>
                          </div>
                        ) : null}
                        {delta.finishReason ? (
                          <div>
                            <span className="text-muted-foreground">finish_reason:</span>{" "}
                            <span className="text-foreground">{delta.finishReason}</span>
                          </div>
                        ) : null}
                        {delta.usage ? (
                          <div>
                            <span className="text-muted-foreground">usage:</span>{" "}
                            <span className="text-foreground">{delta.usage}</span>
                          </div>
                        ) : null}
                        {!delta.content &&
                        !delta.thinking &&
                        !delta.toolCallSummary &&
                        !delta.finishReason &&
                        !delta.usage ? (
                          <div className="text-muted-foreground">{e.data}</div>
                        ) : null}
                      </div>
                    ) : (
                      <span className={isOther ? "text-amber-800" : ""}>{e.data}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function extractDelta(parsed: unknown): {
  content?: string;
  thinking?: string;
  toolCallSummary?: string;
  finishReason?: string;
  usage?: string;
} | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as {
    choices?: Array<{
      delta?: {
        content?: unknown;
        reasoning_content?: unknown;
        tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }>;
      };
      finish_reason?: unknown;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const choice = p.choices?.[0];
  const delta = choice?.delta;
  let toolCallSummary: string | undefined;
  if (Array.isArray(delta?.tool_calls) && delta!.tool_calls.length > 0) {
    toolCallSummary = delta!.tool_calls
      .map((tc) => {
        const args = tc.function?.arguments ?? "";
        const name = tc.function?.name ?? "";
        const argsPreview = args.length > 40 ? args.slice(0, 40) + "…" : args;
        return `[${tc.index ?? "?"}] ${name}(${argsPreview})`;
      })
      .join(", ");
  }
  return {
    content: typeof delta?.content === "string" ? (delta!.content as string) : undefined,
    thinking:
      typeof delta?.reasoning_content === "string"
        ? (delta!.reasoning_content as string)
        : undefined,
    toolCallSummary,
    finishReason:
      typeof choice?.finish_reason === "string" ? (choice!.finish_reason as string) : undefined,
    usage: p.usage
      ? `prompt=${p.usage.prompt_tokens ?? "?"} completion=${
          p.usage.completion_tokens ?? "?"
        } total=${p.usage.total_tokens ?? "?"}`
      : undefined,
  };
}
