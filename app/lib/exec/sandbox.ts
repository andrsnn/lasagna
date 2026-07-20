// Code-execution sandbox — runs LLM-authored python/node in an isolated
// per-run workspace on the Fly worker, where the interpreters + ffmpeg + the
// common libs actually exist (see worker/Dockerfile). This is the heavier
// sibling of the Advanced Web `run_command` tool in app/lib/web/agentic.ts and
// borrows its hardening verbatim: spawn() with shell:false, a secret-scrubbed
// environment so the child can never read OLLAMA_API_KEY / Redis / Blob
// tokens, a wall-clock timeout with SIGKILL, and output caps.
//
// Beyond run_command it adds a real filesystem: input files the user attached
// are staged into the workspace by name, and any files the program writes are
// captured and delivered as downloadable outputs - via Blob when configured,
// else inline as data: URLs so they still reach the user (workspace.ts).
//
// Reached only via a dynamic import from executeTool() / executeCode(), so
// node:child_process + node:fs stay out of the Vercel client/edge bundle.

import type { ToolExecResult } from "@/app/lib/ollama/tools";
import type { AttachedFile } from "@/app/db";
import {
  cleanupWorkspace,
  collectOutputs,
  createWorkspace,
  type Workspace,
} from "@/app/lib/exec/workspace";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_STREAM_CHARS = 24_000;
const MAX_CODE_CHARS = 200_000;

// Bound concurrent interpreters so a research-style fan-out can't spawn a
// dozen ffmpeg jobs at once and OOM the VM. Mirrors agentic.ts's browser slot.
const MAX_CONCURRENT_RUNS = Math.max(
  1,
  Number(process.env.EXEC_MAX_CONCURRENCY ?? 2)
);
let activeRuns = 0;
const runWaiters: (() => void)[] = [];
function acquireRunSlot(): Promise<void> {
  if (activeRuns < MAX_CONCURRENT_RUNS) {
    activeRuns++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => runWaiters.push(resolve));
}
function releaseRunSlot(): void {
  const next = runWaiters.shift();
  if (next) next();
  else activeRuns--;
}

// Secret-scrubbed env — deliberately does NOT inherit process.env so the child
// can't read the worker's API keys / Redis / Blob tokens. Same posture as
// agentic.ts safeEnv(); PATH is kept so python3/node/ffmpeg resolve.
function safeEnv(): Record<string, string> {
  return {
    PATH:
      process.env.PATH ||
      "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    // Unbuffered python so partial output still shows up if we kill it.
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

type Language = "python" | "node";

function resolveInterpreter(language: Language): { bin: string; file: string } {
  if (language === "node") return { bin: "node", file: "main.js" };
  return { bin: process.env.PYTHON_BIN || "python3", file: "main.py" };
}

function trunc(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_STREAM_CHARS) return { text: s, truncated: false };
  return { text: s.slice(0, MAX_STREAM_CHARS) + "\n…[truncated]", truncated: true };
}

type SpawnResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
};

function spawnInterpreter(
  bin: string,
  file: string,
  cwd: string,
  stdin: string,
  timeoutMs: number
): Promise<SpawnResult> {
  return import("node:child_process").then(
    ({ spawn }) =>
      new Promise<SpawnResult>((resolve) => {
        let child: import("node:child_process").ChildProcessWithoutNullStreams;
        try {
          child = spawn(bin, [file], {
            cwd,
            // safeEnv() is intentionally a minimal, secret-free env. The repo
            // augments NodeJS.ProcessEnv to require app keys we withhold here,
            // so assert past it (same cast as agentic.ts).
            env: safeEnv() as unknown as NodeJS.ProcessEnv,
            stdio: ["pipe", "pipe", "pipe"],
          }) as import("node:child_process").ChildProcessWithoutNullStreams;
        } catch (err) {
          resolve({
            code: null,
            signal: null,
            stdout: "",
            stderr: "",
            timedOut: false,
            spawnError: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const cap = MAX_STREAM_CHARS * 2;
        child.stdout.on("data", (d: Buffer) => {
          if (stdout.length < cap) stdout += d.toString("utf8");
        });
        child.stderr.on("data", (d: Buffer) => {
          if (stderr.length < cap) stderr += d.toString("utf8");
        });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({
            code: null,
            signal: null,
            stdout,
            stderr,
            timedOut,
            spawnError: err instanceof Error ? err.message : String(err),
          });
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, stdout, stderr, timedOut });
        });
        if (stdin) {
          try {
            child.stdin.write(stdin);
          } catch {
            // ignore — a program that closed stdin early is fine
          }
        }
        try {
          child.stdin.end();
        } catch {
          // ignore
        }
      })
  );
}

export type RunCodeArgs = {
  language?: unknown;
  code?: unknown;
  stdin?: unknown;
  input_files?: unknown;
  timeout_ms?: unknown;
};

/** A file whose bytes we already hold in memory this turn (an image the user
 *  pasted/dragged, carried inline on the message as base64). Staged into the
 *  workspace DIRECTLY from these bytes, so it works even when Blob storage is
 *  unconfigured or the upstream upload failed - the durable fix for pasted
 *  images being invisible to run_code. */
export type InlineInputFile = {
  /** Filename the program sees + the model references in input_files. */
  name: string;
  /** File contents, base64-encoded (no data: prefix). */
  base64: string;
  contentType: string;
};

export type RunCodeContext = {
  /** Files available this session (user uploads + earlier outputs), matched by
   *  name against input_files. Blob-backed (staged by download). */
  available: AttachedFile[];
  /** Files whose bytes are already in memory (pasted images). Matched by name
   *  against input_files and staged without any Blob round-trip. */
  inlineFiles?: InlineInputFile[];
  /** Namespace for staging inputs + storing produced outputs. Optional: inline
   *  inputs don't need it; only Blob-backed I/O (downloads/output uploads) does. */
  userHash?: string;
  /** Stable id used to group a session's run workspaces under tmp. */
  sessionId: string;
};

/**
 * Run one program. Returns the standard ToolExecResult plus a `files` array of
 * any outputs the run produced (delivered via Blob when available, else inline
 * as a data: URL; ready to surface to the user and re-feed to the next turn).
 */
export async function runCode(
  args: RunCodeArgs,
  ctx: RunCodeContext
): Promise<ToolExecResult> {
  const languageRaw = String(args.language ?? "python").toLowerCase();
  const language: Language = languageRaw === "node" || languageRaw === "javascript"
    ? "node"
    : "python";
  const code = typeof args.code === "string" ? args.code : "";
  if (!code.trim()) return { ok: false, error: "code is required." };
  if (code.length > MAX_CODE_CHARS) {
    return { ok: false, error: `code exceeds ${MAX_CODE_CHARS} chars.` };
  }
  const stdin = typeof args.stdin === "string" ? args.stdin : "";
  const requested = Array.isArray(args.input_files)
    ? args.input_files.map((f) => String(f)).filter(Boolean)
    : [];
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1000, Number(args.timeout_ms ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)
  );

  const { bin, file } = resolveInterpreter(language);

  await acquireRunSlot();
  let ws: Workspace | null = null;
  try {
    ws = await createWorkspace({
      sessionId: ctx.sessionId,
      available: ctx.available,
      inlineFiles: ctx.inlineFiles,
      requested,
    });
    await writeFile(join(ws.dir, file), code, "utf8");

    const missing = ws.inputs.filter((i) => !i.staged).map((i) => i.name);

    const res = await spawnInterpreter(bin, file, ws.dir, stdin, timeoutMs);

    if (res.spawnError) {
      const enoent = /ENOENT/.test(res.spawnError);
      return {
        ok: false,
        error: enoent
          ? `The ${language} interpreter isn't available here. Code execution only runs on the Fly worker (where python3/node/ffmpeg are installed). Enabling Code Execution routes you there in production; this message means the sandbox infra is absent (e.g. local dev).`
          : `Failed to start ${language}: ${res.spawnError}`,
      };
    }
    if (res.timedOut) {
      return {
        ok: false,
        error: `Execution timed out after ${timeoutMs}ms and was killed. Make the program faster or raise timeout_ms (max ${MAX_TIMEOUT_MS}).`,
      };
    }

    // Capture files the program produced. collectOutputs delivers each via Blob
    // when a namespace is available, else inline as a data: URL (so a produced
    // image renders + downloads with NO Blob and NO external host), and reports
    // any it couldn't deliver so we can tell the model honestly rather than the
    // file silently vanishing - which is what made it hunt for a file host.
    const collected = await collectOutputs(ws, {
      userHash: ctx.userHash,
      programFiles: [file],
    });
    const outputs = collected.files;

    const stdoutT = trunc(res.stdout);
    const stderrT = trunc(res.stderr);
    const exitCode = res.code ?? (res.signal ? -1 : null);

    const result = {
      language,
      exitCode,
      stdout: stdoutT.text,
      stderr: stderrT.text,
      ...(missing.length ? { missing_input_files: missing } : {}),
      output_files: [
        ...outputs.map((o) => ({
          name: o.name,
          bytes: o.bytes,
          contentType: o.contentType,
          // The model gets the name + a note; the actual download URL is surfaced
          // to the user out-of-band so a large URL doesn't bloat the tool result.
          // For images we additionally tell the model how to show them inline:
          // embed with the BARE filename as the src and the app rewrites it to the
          // real URL (see resolveProducedImageSrc in chat.tsx). Without this the
          // model invents a URL/host that doesn't resolve and the image looks broken.
          note: o.contentType.startsWith("image/")
            ? `Already delivered to the user as a download - do NOT upload it to a host, search for a file-sharing service, or emit a data URL. To show it inline in your reply, embed it in markdown using the bare filename as the URL - ![${o.name}](${o.name}) - and the app resolves it to the real image. Do not guess a URL, host, or path; use only the filename.`
            : "Already delivered to the user as a download - do NOT upload, host, or re-share it, and do NOT search for a file host; just reference it by name in your reply.",
        })),
        // Files we genuinely could not return. Tell the model so it can be
        // honest with the user instead of inventing a host / claiming success.
        ...collected.undelivered.map((u) => ({
          name: u.name,
          bytes: u.bytes,
          contentType: u.contentType,
          note: `NOT delivered - ${u.reason}. Tell the user this file could not be returned; do NOT upload it to an external host.`,
        })),
      ],
    };

    // Non-zero exits are surfaced as ok:true with stderr in `result` (not as a
    // tool error) so the model can read the trace and fix its code — same
    // convention as run_command.
    const summaryBits = [
      `${language} exited ${exitCode}`,
      outputs.length ? `${outputs.length} file${outputs.length > 1 ? "s" : ""}` : null,
      stdoutT.text ? `${res.stdout.length}b stdout` : null,
    ].filter(Boolean);

    return {
      ok: true,
      result,
      summary: summaryBits.join(" · "),
      truncated: stdoutT.truncated || stderrT.truncated,
      files: outputs,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Sandbox error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (ws) await cleanupWorkspace(ws);
    releaseRunSlot();
  }
}

/** Dispatcher mirroring executeAgenticTool — keeps the tool-name switch in one
 *  place so executeTool() just forwards. */
export async function executeCodeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: RunCodeContext
): Promise<ToolExecResult> {
  switch (name) {
    case "run_code":
      return runCode(args as RunCodeArgs, ctx);
    default:
      return { ok: false, error: `Unknown code-exec tool: ${name}` };
  }
}
