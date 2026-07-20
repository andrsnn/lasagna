// Advanced "agentic web" tools — gated behind the user's Advanced Web mode.
//
// These give the model capabilities far beyond web_search / web_fetch:
//   • browse_page   — a real headless Chromium that runs the page's JS, follows
//                     redirects, reads the rendered DOM, extracts links, and
//                     (for vision models) screenshots what it sees.
//   • http_request  — a raw HTTP client (the "curl" the user asked for): any
//                     method, custom headers, request body, sees status +
//                     response headers + body.
//   • run_command   — a tightly sandboxed shell: a pipeline of ALLOW-LISTED
//                     binaries (curl, wget, jq, …) exec'd with argv arrays —
//                     NO shell string, so pipes/redirects/`$()` are inert — and
//                     with the process env scrubbed so the model can never read
//                     OLLAMA_API_KEY, Redis creds, blob tokens, etc.
//
// Because Chromium and the shell binaries only exist in the Fly worker image
// (see worker/Dockerfile), the chat route forces requests onto the Fly worker
// whenever Advanced Web is enabled. When that infra is genuinely absent (local
// dev without CHROMIUM_PATH), the browser/shell tools fail with a clear message
// instead of crashing; http_request works anywhere.

import type { ToolExecResult } from "@/app/lib/ollama/tools";
import {
  defaultBrowserHeaders,
  randomBrowserUserAgent,
  randomChromiumUserAgent,
} from "@/app/lib/web/user-agent";

const MAX_TEXT_CHARS = 12_000;
const MAX_LINKS = 80;
const MAX_HTTP_BODY_CHARS = 16_000;
const MAX_CMD_OUTPUT = 12_000;
const NAV_TIMEOUT_MS = 30_000;
// After the initial navigation resolves we give late-loading content (and any
// JS bot-challenge) a short, bounded window to quiet down. This is best-effort:
// pages that never reach idle (long-poll/WebSocket apps, ad/analytics beacons,
// WAF interstitials) just hit this ceiling and we read whatever has rendered.
const SETTLE_TIMEOUT_MS = 8_000;
const HTTP_TIMEOUT_MS = 30_000;
const CMD_TIMEOUT_MS = 30_000;

export type AgenticToolOpts = {
  /** Adaptive cap inherited from the chat loop; trims large text payloads. */
  fetchCharLimit?: number;
  /** True when the active model can natively see images. Gates whether
   *  browse_page bothers to capture + return a screenshot. */
  vision?: boolean;
};

export const ADVANCED_WEB_TOOL_NAMES = new Set([
  "browse_page",
  "http_request",
  "run_command",
]);

function chromiumPath(): string {
  return process.env.CHROMIUM_PATH || "/usr/bin/chromium-browser";
}

// Cap concurrent headless-Chromium instances. Each one costs ~300–400MB, and
// Research Mode fans out sub-agents in parallel — without this, a few of them
// calling browse_page at once could OOM the Fly worker. Extra launches queue
// (FIFO) until a slot frees. Tunable via BROWSE_MAX_CONCURRENCY.
const MAX_CONCURRENT_BROWSERS = Math.max(
  1,
  Number(process.env.BROWSE_MAX_CONCURRENCY ?? 2)
);
let activeBrowsers = 0;
const browserWaiters: (() => void)[] = [];

function acquireBrowserSlot(): Promise<void> {
  if (activeBrowsers < MAX_CONCURRENT_BROWSERS) {
    activeBrowsers++;
    return Promise.resolve();
  }
  // Queue; the releaser hands its slot straight to us (count stays put).
  return new Promise<void>((resolve) => browserWaiters.push(resolve));
}

function releaseBrowserSlot(): void {
  const next = browserWaiters.shift();
  if (next) next();
  else activeBrowsers--;
}

function trunc(s: string, n: number): { text: string; truncated: boolean } {
  if (s.length <= n) return { text: s, truncated: false };
  return { text: s.slice(0, n) + "\n…[truncated]", truncated: true };
}

// ---------------------------------------------------------------------------
// browse_page — headless Chromium
// ---------------------------------------------------------------------------

type BrowseArgs = {
  url?: unknown;
  wait_ms?: unknown;
  screenshot?: unknown;
};

async function browsePage(
  args: BrowseArgs,
  opts: AgenticToolOpts
): Promise<ToolExecResult> {
  const url = String(args.url ?? "").trim();
  if (!url) return { ok: false, error: "url is required." };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `Invalid URL: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// URLs can be browsed." };
  }
  const extraWait = Math.min(
    15_000,
    Math.max(0, Number(args.wait_ms ?? 0) || 0)
  );
  // Only spend the time/tokens on a screenshot when the model can actually
  // see it AND the caller asked for one.
  const wantShot = opts.vision === true && args.screenshot === true;
  const textCap = Math.min(MAX_TEXT_CHARS, opts.fetchCharLimit ?? MAX_TEXT_CHARS);

  let puppeteer: typeof import("puppeteer-core").default;
  try {
    puppeteer = (await import("puppeteer-core")).default;
  } catch (err) {
    return {
      ok: false,
      error: `puppeteer-core unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  await acquireBrowserSlot();

  let browser: import("puppeteer-core").Browser | null = null;
  try {
    browser = await puppeteer.launch({
      executablePath: chromiumPath(),
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
      ],
    });
  } catch (err) {
    releaseBrowserSlot();
    return {
      ok: false,
      error:
        `Could not launch headless Chromium (${err instanceof Error ? err.message : String(err)}). ` +
        "browse_page only works where Chromium is installed — that's the Fly worker in production " +
        "(enabling Advanced Web routes you there), or local dev with CHROMIUM_PATH set.",
    };
  }

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 1400, deviceScaleFactor: 1 });
    // Rotate a current Chromium-family UA (the engine really is Chromium, so a
    // Firefox/Safari UA would mismatch the Sec-CH-UA hints Chromium sends). A
    // fixed UA is itself a fingerprint some anti-bot layers blocklist; rotating
    // over real, current strings reads as ordinary human traffic.
    await page.setUserAgent(randomChromiumUserAgent());
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    // Hide the automation tell: headless Chromium sets navigator.webdriver,
    // which bot-detection scripts read first. Delete it before any page JS runs.
    try {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
    } catch {
      // Non-fatal: if the CDP hook can't be installed, proceed without it.
    }
    // Navigate on `domcontentloaded` rather than `networkidle2`. Idle-based
    // waits never resolve on pages that keep the network busy — infinite-scroll
    // feeds, long-poll/WebSocket apps, analytics beacons, and bot-challenge
    // interstitials (e.g. AWS WAF's empty 202 + JS challenge). Those used to
    // throw a navigation TimeoutError and fail the whole call, returning
    // nothing. With `domcontentloaded` the goto resolves as soon as the
    // document is parsed; we then settle and read whatever rendered.
    let resp: import("puppeteer-core").HTTPResponse | null = null;
    let navTimedOut = false;
    try {
      resp = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
    } catch (err) {
      // A navigation timeout is recoverable: the page has usually rendered
      // something usable by now, so note it and extract the DOM below instead
      // of aborting. Non-timeout errors (DNS, connection refused, …) are real
      // failures and still propagate to the catch block.
      const isTimeout =
        err instanceof Error && /timeout/i.test(`${err.name} ${err.message}`);
      if (!isTimeout) throw err;
      navTimedOut = true;
    }

    // Best-effort settle so client-rendered content and JS challenges have a
    // bounded chance to finish, without blocking on full network idle.
    try {
      await page.waitForNetworkIdle({
        idleTime: 500,
        concurrency: 2,
        timeout: SETTLE_TIMEOUT_MS,
      });
    } catch {
      // Never settled within the ceiling — read what's there regardless.
    }
    if (extraWait > 0) {
      await new Promise((r) => setTimeout(r, extraWait));
    }

    const title = await page.title();
    const finalUrl = page.url();
    const status = resp?.status() ?? null;

    const rawText: string = await page.evaluate(() => {
      const body = document.body;
      return body ? (body.innerText || "").replace(/\n{3,}/g, "\n\n").trim() : "";
    });

    const links: { text: string; href: string }[] = await page.evaluate(
      (cap) => {
        const out: { text: string; href: string }[] = [];
        const seen = new Set<string>();
        const anchors = Array.from(document.querySelectorAll("a[href]"));
        for (const a of anchors) {
          const el = a as HTMLAnchorElement;
          const href = el.href; // absolute, resolved by the browser
          if (!href || !/^https?:/i.test(href)) continue;
          if (seen.has(href)) continue;
          seen.add(href);
          const text = (el.textContent || "").replace(/\s+/g, " ").trim();
          out.push({ text: text.slice(0, 120), href });
          if (out.length >= cap) break;
        }
        return out;
      },
      MAX_LINKS
    );

    let screenshot: string | undefined;
    if (wantShot) {
      try {
        const buf = await page.screenshot({
          type: "jpeg",
          quality: 55,
          fullPage: false,
        });
        screenshot = Buffer.from(buf).toString("base64");
        // ~1.3MB base64 ceiling so a giant capture can't blow the wire.
        if (screenshot.length > 1_800_000) screenshot = undefined;
      } catch {
        screenshot = undefined;
      }
    }

    const { text, truncated } = trunc(rawText, textCap);
    const result = {
      finalUrl,
      title,
      status,
      text,
      links,
      ...(navTimedOut
        ? {
            note:
              "Navigation didn't finish loading within the timeout (common for " +
              "bot-challenge pages, infinite feeds, or long-lived connections). " +
              "The content below is whatever had rendered by then and may be " +
              "partial or a challenge interstitial.",
          }
        : {}),
      ...(wantShot
        ? { screenshot: screenshot ? "captured (attached to this turn)" : "capture failed" }
        : {}),
    };
    const summary = `${title ? `“${title.slice(0, 50)}” · ` : ""}${text.length} chars · ${links.length} links${screenshot ? " · screenshot" : ""}${navTimedOut ? " · partial (nav timeout)" : ""}`;
    return {
      ok: true,
      result,
      summary,
      truncated,
      ...(screenshot ? { images: [screenshot] } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      error: `browse_page failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try {
      await browser.close();
    } catch {
      // best-effort
    }
    releaseBrowserSlot();
  }
}

// ---------------------------------------------------------------------------
// http_request — raw HTTP client (curl-equivalent)
// ---------------------------------------------------------------------------

type HttpArgs = {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
};

async function httpRequest(
  args: HttpArgs,
  opts: AgenticToolOpts
): Promise<ToolExecResult> {
  const url = String(args.url ?? "").trim();
  if (!url) return { ok: false, error: "url is required." };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `Invalid URL: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// URLs are allowed." };
  }
  const method = String(args.method ?? "GET").toUpperCase();
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) {
    return { ok: false, error: `Unsupported method: ${method}` };
  }
  const headers: Record<string, string> = {};
  if (args.headers && typeof args.headers === "object") {
    for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = v;
      else if (v != null) headers[k] = String(v);
    }
  }
  // Make the request look like a real browser unless the caller already set
  // these. Node's fetch sends no User-Agent by default, which many sites treat
  // as a bot (blocked / stale / error page). Merge defaults UNDER the caller's
  // headers - an explicit User-Agent (or any header) the model passed always
  // wins. Case-insensitive so a caller's "User-Agent" isn't shadowed by our
  // lowercase "user-agent".
  const present = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(defaultBrowserHeaders())) {
    if (!present.has(k)) headers[k] = v;
  }
  const body =
    typeof args.body === "string"
      ? args.body
      : args.body != null
        ? JSON.stringify(args.body)
        : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      redirect: "follow",
      signal: controller.signal,
    });
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      resHeaders[key] = value;
    });
    const raw = await res.text();
    const cap = Math.min(
      MAX_HTTP_BODY_CHARS,
      opts.fetchCharLimit ?? MAX_HTTP_BODY_CHARS
    );
    const { text, truncated } = trunc(raw, cap);
    const result = {
      status: res.status,
      statusText: res.statusText,
      finalUrl: res.url,
      ok: res.ok,
      contentType: res.headers.get("content-type") ?? null,
      headers: resHeaders,
      body: text,
    };
    return {
      ok: true,
      result,
      summary: `${res.status} ${res.statusText} · ${raw.length} bytes`,
      truncated,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? `http_request timed out after ${HTTP_TIMEOUT_MS}ms.`
        : `http_request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// run_command — sandboxed pipeline of allow-listed binaries
// ---------------------------------------------------------------------------

// Web/data-shaped binaries only. NO interpreters (sh/bash/python/node), NO
// filesystem mutators. Each is exec'd via spawn() with shell:false, so an
// argument like "; rm -rf /" is passed verbatim to the binary as one arg and
// does nothing. Chaining is expressed as an explicit pipeline (stdout → stdin),
// never as a shell string.
const COMMAND_ALLOWLIST = new Set([
  "curl",
  "wget",
  "jq",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "cut",
  "grep",
  "sed",
  "awk",
  "tr",
  "nl",
  "rev",
  "base64",
  "cat",
  "echo",
  "date",
]);

// Scrubbed environment — deliberately does NOT inherit process.env so the
// child can't read secrets the worker holds (API keys, Redis/blob tokens).
function safeEnv(): Record<string, string> {
  return {
    PATH:
      process.env.PATH ||
      "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

type Stage = { cmd: string; args: string[] };

// curl and wget announce themselves ("curl/8.x", "Wget/1.x") - an instant bot
// tell that gets requests blocked or served stale error pages. When the model
// didn't already set a UA (via -A/-U/--user-agent, or a -H/--header User-Agent),
// prepend a realistic rotating browser UA so a plain `curl <url>` still looks
// like a human visit. An explicit UA the model passed is left untouched.
function withBrowserUserAgent(stage: Stage): Stage {
  if (stage.cmd !== "curl" && stage.cmd !== "wget") return stage;
  // Short UA flag differs: curl uses -A (its -u is auth), wget uses -U.
  const shortFlag = stage.cmd === "curl" ? "-a" : "-u";
  const hasUa = stage.args.some((a) => {
    const s = a.toLowerCase();
    return (
      s === shortFlag ||
      s === "--user-agent" ||
      s.startsWith("--user-agent=") ||
      s.startsWith("user-agent:") || // curl:  -H "User-Agent: ..."
      s.startsWith("--header=user-agent") // wget: --header=User-Agent:...
    );
  });
  if (hasUa) return stage;
  const ua = randomBrowserUserAgent();
  const flag = stage.cmd === "curl" ? "-A" : "-U";
  return { ...stage, args: [flag, ua, ...stage.args] };
}

function spawnStage(
  stage: Stage,
  input: string
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return import("node:child_process").then(
    ({ spawn }) =>
      new Promise((resolve) => {
        let child: import("node:child_process").ChildProcessWithoutNullStreams;
        try {
          child = spawn(stage.cmd, stage.args, {
            // Cast: safeEnv() is deliberately a minimal, secret-free env. The
            // repo augments NodeJS.ProcessEnv to require app keys we
            // intentionally withhold from the child, so assert past it.
            env: safeEnv() as unknown as NodeJS.ProcessEnv,
            stdio: ["pipe", "pipe", "pipe"],
          }) as import("node:child_process").ChildProcessWithoutNullStreams;
        } catch (err) {
          resolve({
            code: null,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
            timedOut: false,
          });
          return;
        }
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const cap = MAX_CMD_OUTPUT * 2;
        child.stdout.on("data", (d: Buffer) => {
          if (stdout.length < cap) stdout += d.toString("utf8");
        });
        child.stderr.on("data", (d: Buffer) => {
          if (stderr.length < cap) stderr += d.toString("utf8");
        });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, CMD_TIMEOUT_MS);
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({ code: null, stdout, stderr: stderr || String(err), timedOut });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr, timedOut });
        });
        if (input) {
          child.stdin.write(input);
        }
        child.stdin.end();
      })
  );
}

type RunArgs = {
  commands?: unknown;
  stdin?: unknown;
};

function parseStages(raw: unknown): Stage[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "commands must be a non-empty array of {cmd, args} stages." };
  }
  if (raw.length > 6) {
    return { error: "Pipeline is limited to 6 stages." };
  }
  const stages: Stage[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") {
      return { error: "Each stage must be an object {cmd, args}." };
    }
    const cmd = String((r as { cmd?: unknown }).cmd ?? "").trim();
    if (!cmd) return { error: "Each stage needs a non-empty cmd." };
    if (!COMMAND_ALLOWLIST.has(cmd)) {
      return {
        error: `Command "${cmd}" is not allow-listed. Allowed: ${[...COMMAND_ALLOWLIST].join(", ")}.`,
      };
    }
    const argv = (r as { args?: unknown }).args;
    const argList = Array.isArray(argv) ? argv.map((a) => String(a)) : [];
    stages.push({ cmd, args: argList });
  }
  return stages;
}

async function runCommand(args: RunArgs): Promise<ToolExecResult> {
  const stages = parseStages(args.commands);
  if (!Array.isArray(stages)) return { ok: false, error: stages.error };

  let input = typeof args.stdin === "string" ? args.stdin : "";
  const trace: { cmd: string; args: string[]; code: number | null; stderr?: string }[] = [];
  for (let i = 0; i < stages.length; i++) {
    const stage = withBrowserUserAgent(stages[i]);
    let res;
    try {
      res = await spawnStage(stage, input);
    } catch (err) {
      return {
        ok: false,
        error: `Stage ${i + 1} (${stage.cmd}) failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    trace.push({
      cmd: stage.cmd,
      args: stage.args,
      code: res.code,
      ...(res.stderr ? { stderr: res.stderr.slice(0, 800) } : {}),
    });
    if (res.timedOut) {
      return {
        ok: false,
        error: `Stage ${i + 1} (${stage.cmd}) timed out after ${CMD_TIMEOUT_MS}ms.`,
      };
    }
    // A non-zero exit stops the pipeline (like `set -o pipefail`).
    if (res.code !== 0) {
      return {
        ok: true,
        result: {
          ok: false,
          failedStage: i + 1,
          trace,
          stderr: res.stderr.slice(0, 2000),
          stdout: res.stdout.slice(0, 2000),
        },
        summary: `${stage.cmd} exited ${res.code}`,
      };
    }
    input = res.stdout;
  }

  const { text, truncated } = trunc(input, MAX_CMD_OUTPUT);
  return {
    ok: true,
    result: { ok: true, trace, stdout: text },
    summary: `pipeline of ${stages.length} · ${input.length} bytes out`,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export async function executeAgenticTool(
  name: string,
  args: Record<string, unknown>,
  opts: AgenticToolOpts = {}
): Promise<ToolExecResult> {
  switch (name) {
    case "browse_page":
      return browsePage(args as BrowseArgs, opts);
    case "http_request":
      return httpRequest(args as HttpArgs, opts);
    case "run_command":
      return runCommand(args as RunArgs);
    default:
      return { ok: false, error: `Unknown advanced web tool: ${name}` };
  }
}
