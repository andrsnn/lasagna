import type { Tool } from "ollama";
import { ollamaClient } from "./client";
import { braveImageSearchValidated } from "@/app/lib/brave/images";
import {
  applyEdit,
  applyMultiEdit,
  changesFromDiff,
  formatLineNumbered,
  globMatch,
  grep as grepVfs,
  listChildren,
  readFile,
  writeFile,
  deleteFile,
} from "@/app/lib/artifact/vfs";
import type { ArtifactFiles, AttachedFile, BuildIssue, FileChange } from "@/app/db";
import { buildArtifact, formatIssue } from "@/app/lib/artifact/build";
import { executeScript, type ScriptEditOp } from "@/app/lib/artifact/script";
import { unifiedDiff } from "@/app/lib/artifact/diff";

export const MAX_TOOL_ROUNDS = 500;
export const MAX_VFS_ROUNDS = 500;
export const MAX_FETCH_CHARS = 8000;

export const WEB_SEARCH_TOOL: Tool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for current information. Use when the user asks about recent events, fast-moving facts, or anything beyond your training data.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        max_results: {
          type: "integer",
          description: "Max number of results to return (default 5, max 10)",
        },
      },
      required: ["query"],
    },
  },
};

export const IMAGE_SEARCH_TOOL: Tool = {
  type: "function",
  function: {
    name: "image_search",
    description:
      "Search the web for images. Returns an array of {url, source, title, alt?, width?, height?}. Use when the user asks to see photos, pictures, or images of something. The returned URLs are pre-validated to load — embed them directly; do NOT call web_fetch on them to verify, and do NOT re-run image_search with a similar query if the embedded images look broken to you (you cannot actually see the rendered artifact). Embed as markdown ![alt](url) inline, or as <img src='...' loading='lazy'> inside an artifact. Always credit the source page when reasonable.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to find images of." },
        max_results: {
          type: "integer",
          description: "Max number of images to return (default 6, max 10).",
        },
      },
      required: ["query"],
    },
  },
};

export const WEB_FETCH_TOOL: Tool = {
  type: "function",
  function: {
    name: "web_fetch",
    description:
      "Fetch a single web page by URL and return its content. Useful after web_search to read a specific result in detail.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },
};

// ---------- Advanced Web tools (gated behind the user's "Advanced Web" mode) ----------
//
// Far more capable — and more dangerous — than web_search/web_fetch, so they
// only load when the user explicitly flips the mode on. Implementations live in
// app/lib/web/agentic.ts and are pulled in via a *dynamic* import from
// executeTool() below, which keeps puppeteer-core / node:child_process out of
// the static module graph (and therefore out of the Vercel function bundle).
// In production these run on the Fly worker, where Chromium and the shell
// binaries actually exist (the chat route forces Fly routing when the mode is
// on). See worker/Dockerfile.

export const BROWSE_PAGE_TOOL: Tool = {
  type: "function",
  function: {
    name: "browse_page",
    description:
      "Open a URL in a real headless browser (Chromium) that runs the page's JavaScript, then return the fully-rendered visible text, the final URL after redirects, the page title, and the on-page links as {text, href}. Use this instead of web_fetch when a site is JavaScript-heavy, behind a client-side render, or when web_fetch came back empty/garbled. To crawl, call this on a page, then follow the returned hrefs with more browse_page/http_request calls. Set screenshot=true (vision models only) to also capture what the page looks like.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http(s) URL to open." },
        wait_ms: {
          type: "integer",
          description:
            "Extra milliseconds to wait after load for late content (0–15000). Use for slow SPAs.",
        },
        screenshot: {
          type: "boolean",
          description:
            "Capture a screenshot of the rendered page and attach it for vision-capable models to see. Ignored on non-vision models.",
        },
      },
      required: ["url"],
    },
  },
};

export const HTTP_REQUEST_TOOL: Tool = {
  type: "function",
  function: {
    name: "http_request",
    description:
      "Make a raw HTTP request to any http(s) URL — the programmatic equivalent of curl. Choose the method, set request headers, send a body. Returns the response status, response headers, content-type, and body (truncated to fit context). Use this to hit JSON/REST APIs, RSS/sitemap/ICS feeds, or endpoints a normal page fetch wouldn't reach. For human-readable pages that need JS, prefer browse_page.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http(s) URL to request." },
        method: {
          type: "string",
          description: "HTTP method: GET (default), POST, PUT, PATCH, DELETE, HEAD, OPTIONS.",
        },
        headers: {
          type: "object",
          description: "Request headers as a flat string→string object.",
        },
        body: {
          type: "string",
          description: "Request body for POST/PUT/PATCH. A JSON value is stringified automatically.",
        },
      },
      required: ["url"],
    },
  },
};

export const RUN_COMMAND_TOOL: Tool = {
  type: "function",
  function: {
    name: "run_command",
    description:
      "Run a pipeline of allow-listed command-line tools and get the final stdout. Express chaining as an explicit pipeline array — the stdout of each stage is piped to the stdin of the next (like a Unix pipe), e.g. curl a URL then jq the JSON. There is NO shell: each stage runs as a binary with an argv array, so pipes/redirects/`$()`/`;` inside an argument do nothing. Allowed binaries: curl, wget, jq, head, tail, wc, sort, uniq, cut, grep, sed, awk, tr, nl, rev, base64, cat, echo, date. The environment is scrubbed of all secrets.",
    parameters: {
      type: "object",
      properties: {
        commands: {
          type: "array",
          description:
            "Pipeline stages, executed left→right with stdout piped to the next stage's stdin.",
          items: {
            type: "object",
            properties: {
              cmd: { type: "string", description: "Allow-listed binary name, e.g. 'curl' or 'jq'." },
              args: {
                type: "array",
                items: { type: "string" },
                description: "Arguments passed verbatim to the binary (each a separate argv entry).",
              },
            },
            required: ["cmd"],
          },
        },
        stdin: {
          type: "string",
          description: "Optional initial stdin piped into the first stage.",
        },
      },
      required: ["commands"],
    },
  },
};

/** The full Advanced-Web toolset, pushed into the model's tool list when the
 *  user has the mode enabled. */
export const ADVANCED_WEB_TOOLS: Tool[] = [
  BROWSE_PAGE_TOOL,
  HTTP_REQUEST_TOOL,
  RUN_COMMAND_TOOL,
];

export const ADVANCED_WEB_TOOL_NAMES = new Set([
  "browse_page",
  "http_request",
  "run_command",
]);

// ---------- Code Execution Sandbox tool (gated behind the user's "Code Execution" mode) ----------
//
// Runs real python/node in an isolated per-run workspace on the Fly worker.
// Like the Advanced Web tools, the interpreters + ffmpeg only exist in the Fly
// image, so enabling this forces Fly routing. Implementation lives in
// app/lib/exec/sandbox.ts, pulled in via a dynamic import from executeTool()
// so node:child_process / node:fs stay out of the Vercel bundle.

export const RUN_CODE_TOOL: Tool = {
  type: "function",
  function: {
    name: "run_code",
    description:
      "Run a short program in an isolated sandbox to accomplish a task: convert or speed up an uploaded audio/video file (ffmpeg is installed), transform/analyze data, render an image/chart, scrape a page, or anything else code can do. Choose language 'python' or 'node'. The program runs with a fresh empty working directory as its CWD. Files the user attached and named in input_files are placed in that directory - read them by their plain filename (e.g. open('clip.mp3','rb')). This INCLUDES images the user pasted or dragged into the chat: each is listed as a `[File - <name>, ...]` line next to their message, so open that file here to work on the real pixels (crop, recolor, remove/transparent background, etc.) instead of telling the user to re-upload it. ANY file your program writes into the working directory is AUTOMATICALLY captured and delivered to the user as a download - that is the ONLY step needed to give them the file. Just write your result to a clearly-named output file (e.g. 'output.png'). Do NOT upload it to a file host or image host, do NOT search for a file-sharing/hosting service, and do NOT paste base64 or a data: URL into your reply - the user already has the file the instant your program writes it. To show a produced image inline in your reply, embed it in markdown with the BARE output filename as the URL - ![result](output.png) - and the app resolves it to the real link; never invent a URL, host, or path. You get stdout, stderr and the exit code back; on a non-zero exit, read stderr and try again. Pre-installed: python3 with numpy/pillow/requests, node, and ffmpeg. The network is available (you may fetch URLs/scrape). You CANNOT install packages (no pip/npm install). The environment holds no secrets.",
    parameters: {
      type: "object",
      properties: {
        language: {
          type: "string",
          enum: ["python", "node"],
          description: "Which interpreter to run the code with.",
        },
        code: {
          type: "string",
          description:
            "The complete program source. It runs as a single file with the workspace as CWD.",
        },
        stdin: {
          type: "string",
          description: "Optional text piped to the program's standard input.",
        },
        input_files: {
          type: "array",
          items: { type: "string" },
          description:
            "Filenames of user-attached files to stage into the working directory for this run. Use the exact names shown in the conversation (e.g. ['clip.mp3']).",
        },
        timeout_ms: {
          type: "integer",
          description:
            "Optional wall-clock limit in ms (default 60000, max 120000). Raise it for heavy media conversions.",
        },
      },
      required: ["language", "code"],
    },
  },
};

/** The code-exec toolset, pushed into the model's tool list when the user has
 *  Code Execution mode enabled. */
export const CODE_EXEC_TOOLS: Tool[] = [RUN_CODE_TOOL];

export const CODE_EXEC_TOOL_NAMES = new Set(["run_code"]);

/**
 * Terminal "delivery" tool used in artifact-edit mode. The model is told to
 * call this exactly once with the complete artifact HTML — analogous to
 * ChatGPT Canvas's `canmore.create_textdoc`. The server doesn't execute it;
 * the call IS the result.
 */
export const PRODUCE_ARTIFACT_TOOL: Tool = {
  type: "function",
  function: {
    name: "produce_artifact",
    description:
      "Deliver the final artifact. Call this EXACTLY ONCE when you've designed the HTML mini-app the user asked for. Do not call any other tool after this one. After this call, you are done — do not write more content.",
    parameters: {
      type: "object",
      properties: {
        html: {
          type: "string",
          description:
            "A complete <!doctype html> document for the artifact. MUST contain a <script type=\"application/artifact-manifest\"> JSON block declaring name, description, and params. Use vanilla CSS + JS, no external imports. Use window.artifact (params, ready, onRefresh, query, fetch, state) to read params and fetch data at runtime.",
        },
        summary: {
          type: "string",
          description:
            "A 1-2 sentence summary of what this artifact does, shown to the user above the saved version.",
        },
      },
      required: ["html", "summary"],
    },
  },
};

export const PRODUCE_ARTIFACT_NAME = "produce_artifact";

type SearchResultItem = { title?: string; url?: string; content?: string };
type SearchResult = { results?: SearchResultItem[] };

export function summarizeSearch(result: unknown): string {
  if (!result || typeof result !== "object") return "no results";
  const r = result as SearchResult;
  const count = r.results?.length ?? 0;
  const hosts = new Set<string>();
  for (const item of r.results ?? []) {
    if (typeof item.url === "string") {
      try {
        hosts.add(new URL(item.url).host);
      } catch {
        // ignore
      }
    }
  }
  return `${count} result${count === 1 ? "" : "s"}${
    hosts.size ? ` from ${hosts.size} site${hosts.size === 1 ? "" : "s"}` : ""
  }`;
}

export function summarizeImageSearch(result: unknown): string {
  if (!result || typeof result !== "object") return "no images";
  const r = result as { results?: Array<{ source?: string }> };
  const items = r.results ?? [];
  const sites = new Set<string>();
  for (const it of items) {
    if (typeof it.source === "string") {
      try {
        sites.add(new URL(it.source).host);
      } catch {
        // ignore
      }
    }
  }
  return `${items.length} image${items.length === 1 ? "" : "s"}${
    sites.size ? ` from ${sites.size} site${sites.size === 1 ? "" : "s"}` : ""
  }`;
}

export function summarizeFetch(result: unknown): string {
  if (!result || typeof result !== "object") return "fetched";
  const r = result as { title?: string; content?: string };
  const len = r.content?.length ?? 0;
  return r.title ? `“${r.title}” (${len} chars)` : `${len} chars`;
}

// ---------- VFS tools (Claude-Code-style) ----------
//
// Names + schemas mirror the official Claude Code reference:
// https://code.claude.com/docs/en/tools-reference. We omit Bash (no shell
// inside a sandboxed iframe), NotebookEdit/NotebookRead (no notebooks), and
// expose the remaining tools that make sense for editing a small project.

export const READ_TOOL: Tool = {
  type: "function",
  function: {
    name: "Read",
    description:
      "Read a file from the artifact's virtual filesystem. Output is line-numbered (cat -n style); use offset/limit to page large files. ALWAYS Read a file before Editing it so your old_string matches verbatim.",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Path within the VFS, no leading slash (e.g. 'App.tsx' or 'components/Button.tsx').",
        },
        offset: {
          type: "integer",
          description: "1-based line number to start from. Defaults to 1.",
        },
        limit: {
          type: "integer",
          description: "Number of lines to return. Defaults to 2000.",
        },
      },
      required: ["file_path"],
    },
  },
};

export const WRITE_TOOL: Tool = {
  type: "function",
  function: {
    name: "Write",
    description:
      "Create a new file or overwrite an existing file completely. Prefer Edit for partial changes — Write is for new files or full rewrites only.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        content: { type: "string", description: "Full file contents." },
      },
      required: ["file_path", "content"],
    },
  },
};

export const EDIT_TOOL: Tool = {
  type: "function",
  function: {
    name: "Edit",
    description:
      "Replace exactly one occurrence of old_string with new_string in the named file. old_string must appear verbatim and uniquely; pass replace_all=true to replace every occurrence. You MUST Read the file in this conversation before editing it.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string", description: "Exact substring to replace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: {
          type: "boolean",
          description: "Replace every occurrence (default false).",
        },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
};

export const MULTI_EDIT_TOOL: Tool = {
  type: "function",
  function: {
    name: "MultiEdit",
    description:
      "Atomically apply a sequence of Edit operations to a single file. All edits succeed or all fail; the file is left unchanged on any failure.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        edits: {
          type: "array",
          description: "Sequence of edits to apply in order.",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string" },
              new_string: { type: "string" },
              replace_all: { type: "boolean" },
            },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["file_path", "edits"],
    },
  },
};

export const GLOB_TOOL: Tool = {
  type: "function",
  function: {
    name: "Glob",
    description:
      "Find files matching a glob pattern (supports *, **, ?). Returns matching paths sorted alphabetically.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. '**/*.tsx' or 'components/*.ts'." },
        path: { type: "string", description: "Optional directory to search under." },
      },
      required: ["pattern"],
    },
  },
};

export const GREP_TOOL: Tool = {
  type: "function",
  function: {
    name: "Grep",
    description:
      "Search file contents for a regex pattern. Returns matching lines as file:line: text. Use the include glob to limit to certain file types.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "Optional path to restrict the search to." },
        include: {
          type: "string",
          description: "Optional glob like '**/*.tsx' to filter which files are searched.",
        },
      },
      required: ["pattern"],
    },
  },
};

export const LS_TOOL: Tool = {
  type: "function",
  function: {
    name: "LS",
    description:
      "List the immediate children (files and subdirs) of a directory in the VFS. Use this to discover what files exist before reading them.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory to list. Pass an empty string to list the project root.",
        },
      },
      required: ["path"],
    },
  },
};

export const DELETE_TOOL: Tool = {
  type: "function",
  function: {
    name: "Delete",
    description: "Remove a file from the artifact's virtual filesystem.",
    parameters: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
};

export const SCRIPT_TOOL: Tool = {
  type: "function",
  function: {
    name: "Script",
    description:
      "Run a JavaScript snippet against the VFS in a single tool call. Use this when the task is semantic and would take many sequential Edit/Grep/Read rounds otherwise — deduplicate an array, rename every export, transform a JSON shape, batch-rewrite a list of files. Beats looping.\n\nThe sandbox is READ-ONLY for files. To change files, queue your intent with `propose.*` and the system will apply the plan through the same trusted path MultiEdit uses (with diff reporting + Read-before-Edit guarantees + canvas / selection constraints all preserved). If any proposed op fails, NONE are applied — the plan is atomic.\n\nSandbox API (call as plain functions):\n  read(path) -> string | null                       read a file's text\n  list() -> string[]                                sorted list of every file path\n  exists(path) -> boolean\n  console.log/warn/error(...)                       captured into stdout, returned to you\n  propose.edit(path, old_string, new_string, {replace_all?: boolean})   queue an Edit\n  propose.write(path, content)                                          queue a Write (create or overwrite)\n  propose.delete(path)                                                  queue a Delete\n\nStandard ECMAScript globals are available: JSON, Math, Array, String, Number, RegExp, Set, Map, Date, Error, Promise, Symbol, etc. NOT available: require, process, fs, Buffer, setTimeout, setImmediate, network, anything else. 5-second wall-clock timeout, 500-op plan cap. The script's final expression value is returned to you as `returnValue`, so feel free to end with a count or short summary.\n\nThe result includes per-file unified-diff snippets for everything that changed, so you can verify your intent landed correctly without a follow-up Read.\n\nExample — dedupe an array literal in a data file:\n  const src = read(\"src/data/games.js\");\n  const m = src.match(/export const GAMES = (\\[[\\s\\S]*?\\]);?\\s*$/);\n  const arr = JSON.parse(m[1]);\n  const seen = new Set();\n  const out = arr.filter(g => seen.has(g.id) ? false : (seen.add(g.id), true));\n  propose.edit(\"src/data/games.js\", m[1], JSON.stringify(out, null, 2));\n  console.log(`removed ${arr.length - out.length} dupes`);\n  out.length;",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript source to execute in the sandbox.",
        },
        description: {
          type: "string",
          description:
            "Short (5-10 word) description of what the script does, for UI display.",
        },
      },
      required: ["code"],
    },
  },
};

export const BUILD_TOOL: Tool = {
  type: "function",
  function: {
    name: "Build",
    description:
      "Compile the artifact end-to-end. Returns ok:true on success, or a list of structured errors {file,line,column,message} on failure. ALWAYS call Build before Finish; if it fails, fix the errors and Build again until it passes.",
    parameters: { type: "object", properties: {} },
  },
};

export const FINISH_TOOL: Tool = {
  type: "function",
  function: {
    name: "Finish",
    description:
      "Call once everything compiles. Provide a 1-2 sentence summary of the change. Do not call any other tool after this one.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Brief summary of what changed in this turn." },
      },
      required: ["summary"],
    },
  },
};

export const VFS_TOOL_NAMES = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Script",
  "Glob",
  "Grep",
  "LS",
  "Delete",
  "Build",
  "Finish",
]);

export const VFS_TOOLS: Tool[] = [
  READ_TOOL,
  WRITE_TOOL,
  EDIT_TOOL,
  MULTI_EDIT_TOOL,
  SCRIPT_TOOL,
  GLOB_TOOL,
  GREP_TOOL,
  LS_TOOL,
  DELETE_TOOL,
  BUILD_TOOL,
  FINISH_TOOL,
];

// ---------- VFS dispatcher ----------

/** Mutable handle to the in-memory VFS for one chat turn. */
export type VfsContext = {
  files: ArtifactFiles;
  entry: string;
  /** Set when the model called Read on this path; we use it to enforce "Read before Edit". */
  readPaths: Set<string>;
  /** Append-only list of changes the assistant produced this turn. */
  changes: FileChange[];
  /** Last build outcome so client can show a build pill. */
  lastBuild?:
    | { ok: true; durationMs: number; warnings: BuildIssue[] }
    | { ok: false; durationMs: number; errors: BuildIssue[]; warnings: BuildIssue[] };
  /**
   * "vfs" = full designer toolset. "note-canvas" = pinned-note canvas: the
   * dispatcher rejects any tool outside NOTE_CANVAS_ALLOWED_TOOLS, requires
   * every file_path to equal `entry`, and (when `selection` is set) forces
   * Edit/MultiEdit to operate on the highlighted slice.
   */
  mode?: "vfs" | "note-canvas";
  /**
   * Note-canvas only. The user-pinned highlight at send time. When set, an
   * Edit's `old_string` must be a substring of the slice
   * `entry.slice(startOffset, endOffset)`; MultiEdit's first edit is checked
   * against the slice, and subsequent edits operate on the live (mutated)
   * file. The protection is: the model can't "interpret" the highlight as
   * a wider region than the user actually selected.
   */
  selection?: {
    text: string;
    startOffset: number;
    endOffset: number;
    occurrenceIndex: number;
  };
};

/** Tools allowed when `ctx.mode === "note-canvas"`. Script is included
 *  because its mutations flow through the same applyEdit / writeFile /
 *  deleteFile path as Edit/MultiEdit/Write — so the single-file +
 *  selection-pin invariants land identically. The dispatcher rejects
 *  any propose.* op targeting a path other than ctx.entry. */
export const NOTE_CANVAS_ALLOWED_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Script",
  "Finish",
]);

export type VfsToolEvent =
  | { kind: "file_changed"; path: string; op: "write" | "edit" | "delete"; content?: string }
  | { kind: "build_result"; ok: boolean; durationMs: number; errors?: BuildIssue[]; warnings?: BuildIssue[] }
  | { kind: "finish"; summary: string };

export type VfsExecResult =
  | { ok: true; summary: string; result: unknown; events?: VfsToolEvent[] }
  | { ok: false; error: string };

/**
 * Reject Edit/MultiEdit calls whose `old_string` isn't contained inside the
 * user's pinned slice. Cheap textual check: we don't try to re-anchor — the
 * slice is what the user highlighted, and the model is told to replace text
 * inside it. If the model passes something wider, that's a "widening" attempt
 * we refuse.
 */
function checkSelectionConstraint(
  ctx: VfsContext,
  name: string,
  args: Record<string, unknown>
): VfsExecResult {
  const sel = ctx.selection!;
  const body = ctx.files[ctx.entry] ?? "";
  const slice = body.slice(sel.startOffset, sel.endOffset);
  // The slice is the authoritative scope for this turn. If the original
  // anchor has drifted (the model already edited the body once mid-turn),
  // fall back to a substring search for the selection text — same logic as
  // `reanchor` in app/lib/annotations/anchor.ts.
  const effectiveSlice =
    slice === sel.text || slice.includes(sel.text) ? slice : sel.text;

  const check = (oldStr: string): VfsExecResult => {
    if (!oldStr) {
      return { ok: false, error: "old_string is empty." };
    }
    if (!effectiveSlice.includes(oldStr)) {
      return {
        ok: false,
        error:
          "old_string is outside the user's highlighted selection. " +
          "Pass a substring of the highlighted passage, or ask the user to widen the selection.",
      };
    }
    return { ok: true, summary: "", result: undefined };
  };

  if (name === "Edit") {
    return check(String(args.old_string ?? ""));
  }
  // MultiEdit: only the first edit must originate inside the slice; later
  // edits operate on the result of earlier edits, which may already differ
  // from the original slice. This lets the model do "find phrase X, replace
  // it, then fix capitalization" within one MultiEdit call.
  const edits = Array.isArray(args.edits) ? (args.edits as Array<Record<string, unknown>>) : [];
  if (edits.length === 0) {
    return { ok: false, error: "edits[] must be non-empty." };
  }
  return check(String(edits[0].old_string ?? ""));
}

function recordChange(ctx: VfsContext, path: string, op: "write" | "edit" | "delete", before: ArtifactFiles) {
  const changes = changesFromDiff(before, ctx.files);
  for (const c of changes) {
    if (c.path === path) {
      ctx.changes.push(c);
      return c;
    }
  }
  // Fallback: append a bare change marker if the diff didn't pick anything up.
  const fallback: FileChange = { path, op };
  ctx.changes.push(fallback);
  return fallback;
}

export async function executeVfsTool(
  name: string,
  args: Record<string, unknown>,
  ctx: VfsContext
): Promise<VfsExecResult> {
  // Note-canvas: enforce the tool allowlist + single-file invariant up front
  // so a misbehaving model can't run Build (esbuild on markdown), Delete
  // (empty `files`), or write a sibling file we'd then persist back to the
  // note. The prompt also warns the model, but never trust the prompt.
  if (ctx.mode === "note-canvas") {
    if (!NOTE_CANVAS_ALLOWED_TOOLS.has(name)) {
      return {
        ok: false,
        error: `Tool ${name} is not available in canvas mode. Use Read, Edit, MultiEdit, Write, or Finish.`,
      };
    }
    const filePath = typeof args.file_path === "string" ? (args.file_path as string) : "";
    if (filePath && filePath !== ctx.entry) {
      return {
        ok: false,
        error: `Canvas mode edits only ${ctx.entry}; got file_path="${filePath}".`,
      };
    }
  }

  // Note-canvas with a pinned selection: the model's Edit must stay inside
  // the highlighted slice. We let the model's `old_string` be anything that
  // substring-matches the slice; the actual replacement runs against the
  // full file via `applyEdit` (which finds the first match), but the slice
  // check rejects "the model widened the scope" before any state changes.
  if (
    ctx.mode === "note-canvas" &&
    ctx.selection &&
    (name === "Edit" || name === "MultiEdit")
  ) {
    const sliceCheck = checkSelectionConstraint(ctx, name, args);
    if (!sliceCheck.ok) return sliceCheck;
  }

  try {
    switch (name) {
      case "Read": {
        const filePath = String(args.file_path ?? "");
        const offset = Number.isFinite(args.offset) ? Number(args.offset) : 1;
        const limit = Number.isFinite(args.limit) ? Number(args.limit) : 2000;
        const content = readFile(ctx.files, filePath);
        if (content === null) {
          return { ok: false, error: `File not found: ${filePath}. Use LS or Glob to discover paths.` };
        }
        ctx.readPaths.add(filePath);
        const view = formatLineNumbered(content, offset, limit);
        const totalLines = content.split("\n").length;
        const summary = `Read ${filePath} (${totalLines} lines)`;
        return { ok: true, summary, result: view };
      }

      case "Write": {
        const filePath = String(args.file_path ?? "");
        const content = String(args.content ?? "");
        if (!filePath) return { ok: false, error: "file_path required" };
        const before = ctx.files;
        ctx.files = writeFile(ctx.files, filePath, content);
        ctx.readPaths.add(filePath);
        const op = Object.prototype.hasOwnProperty.call(before, filePath) ? "edit" : "write";
        recordChange(ctx, filePath, op, before);
        return {
          ok: true,
          summary: op === "write" ? `Created ${filePath}` : `Wrote ${filePath}`,
          result: { ok: true },
          events: [{ kind: "file_changed", path: filePath, op: "write", content }],
        };
      }

      case "Edit": {
        const filePath = String(args.file_path ?? "");
        const oldStr = String(args.old_string ?? "");
        const newStr = String(args.new_string ?? "");
        const replaceAll = args.replace_all === true;
        if (!filePath) return { ok: false, error: "file_path required" };
        if (!ctx.readPaths.has(filePath)) {
          return {
            ok: false,
            error: `You must Read ${filePath} in this conversation before Editing it. Call Read first.`,
          };
        }
        const before = ctx.files;
        const r = applyEdit(ctx.files, filePath, oldStr, newStr, replaceAll);
        if (!r.ok) return { ok: false, error: r.error.message };
        ctx.files = r.files;
        const change = recordChange(ctx, filePath, "edit", before);
        const delta =
          change.addedLines || change.removedLines
            ? ` (+${change.addedLines ?? 0} -${change.removedLines ?? 0})`
            : "";
        return {
          ok: true,
          summary: `Edited ${filePath}${delta}`,
          result: { ok: true },
          events: [{ kind: "file_changed", path: filePath, op: "edit", content: ctx.files[filePath] }],
        };
      }

      case "MultiEdit": {
        const filePath = String(args.file_path ?? "");
        const edits = Array.isArray(args.edits) ? (args.edits as Array<Record<string, unknown>>) : [];
        if (!filePath) return { ok: false, error: "file_path required" };
        if (!ctx.readPaths.has(filePath)) {
          return {
            ok: false,
            error: `You must Read ${filePath} in this conversation before Editing it.`,
          };
        }
        const normalized = edits.map((e) => ({
          old_string: String(e.old_string ?? ""),
          new_string: String(e.new_string ?? ""),
          replace_all: e.replace_all === true,
        }));
        const before = ctx.files;
        const r = applyMultiEdit(ctx.files, filePath, normalized);
        if (!r.ok) return { ok: false, error: `${r.error.message} (edit #${r.index + 1})` };
        ctx.files = r.files;
        const change = recordChange(ctx, filePath, "edit", before);
        const delta =
          change.addedLines || change.removedLines
            ? ` (+${change.addedLines ?? 0} -${change.removedLines ?? 0})`
            : "";
        return {
          ok: true,
          summary: `MultiEdit ${filePath} · ${normalized.length} edits${delta}`,
          result: { ok: true },
          events: [{ kind: "file_changed", path: filePath, op: "edit", content: ctx.files[filePath] }],
        };
      }

      case "Script": {
        const code = String(args.code ?? "");
        if (!code) return { ok: false, error: "code required" };
        const r = executeScript(ctx.files, code);
        if (!r.ok) {
          const detail = r.stdout
            ? `${r.error}\n--- console ---\n${r.stdout}`
            : r.error;
          return { ok: false, error: detail };
        }

        // Apply the proposed plan through the trusted Edit / Write /
        // Delete code paths so canvas single-file + selection-pin
        // guards land identically to MultiEdit. Atomic: any failure
        // aborts the whole plan and rolls back to ctx.files.
        const before = ctx.files;
        let cur = ctx.files;
        const appliedFiles = new Set<string>();

        for (let i = 0; i < r.plan.length; i++) {
          const op = r.plan[i];

          // Canvas: every op must target the entry file.
          if (ctx.mode === "note-canvas" && op.path !== ctx.entry) {
            return {
              ok: false,
              error: `Script proposed an edit to "${op.path}" (op #${i + 1}) but canvas mode only edits "${ctx.entry}". Restrict your propose.* calls to the entry file.`,
            };
          }

          // Canvas + pinned selection: edit ops must originate inside
          // the slice, same rule as MultiEdit's first-edit check.
          if (
            ctx.mode === "note-canvas" &&
            ctx.selection &&
            op.kind === "edit" &&
            i === 0
          ) {
            const sliceCheck = checkSelectionConstraint(
              { ...ctx, files: cur } as VfsContext,
              "Edit",
              { old_string: op.old_string }
            );
            if (!sliceCheck.ok) return sliceCheck;
          }

          if (op.kind === "edit") {
            const er = applyEdit(
              cur,
              op.path,
              op.old_string,
              op.new_string,
              op.replace_all
            );
            if (!er.ok) {
              return {
                ok: false,
                error: `Script op #${i + 1} (edit ${op.path}): ${er.error.message}`,
              };
            }
            cur = er.files;
            appliedFiles.add(op.path);
          } else if (op.kind === "write") {
            cur = writeFile(cur, op.path, op.content);
            appliedFiles.add(op.path);
          } else {
            // delete
            if (!Object.prototype.hasOwnProperty.call(cur, op.path)) {
              return {
                ok: false,
                error: `Script op #${i + 1} (delete ${op.path}): file not found`,
              };
            }
            cur = deleteFile(cur, op.path);
            appliedFiles.add(op.path);
          }
        }

        ctx.files = cur;
        // The script reads + writes inside the sandbox. Any path the
        // script touched is by-definition fresher than what the model
        // would Read — mark it as Read so subsequent Edits don't trip
        // the Read-before-Edit gate for busywork.
        for (const p of appliedFiles) ctx.readPaths.add(p);
        const changes = changesFromDiff(before, cur);
        for (const c of changes) ctx.changes.push(c);

        // Per-file unified-diff snippets so the model SEES what landed,
        // not just a line count. Cap aggregate so we don't blow the
        // token budget on a multi-file rewrite.
        const DIFF_BUDGET = 4000;
        const diffs: Record<string, string> = {};
        let diffBytes = 0;
        for (const c of changes) {
          if (diffBytes >= DIFF_BUDGET) break;
          const beforeText = before[c.path] ?? "";
          const afterText = cur[c.path] ?? "";
          const d = unifiedDiff(beforeText, afterText);
          if (d) {
            const room = DIFF_BUDGET - diffBytes;
            diffs[c.path] = d.length > room ? d.slice(0, room) + "\n…[diff truncated]" : d;
            diffBytes += diffs[c.path].length;
          }
        }
        const result = {
          durationMs: r.durationMs,
          stdout: r.stdout,
          returnValue: r.returnValue,
          opsApplied: r.plan.length,
          ...(changes.length > 0
            ? {
                changedFiles: changes.map((c) => ({
                  path: c.path,
                  op: c.op,
                  addedLines: c.addedLines ?? 0,
                  removedLines: c.removedLines ?? 0,
                })),
                diffs,
              }
            : {}),
        };

        let summary: string;
        if (changes.length > 0) {
          summary = `Script · ${changes.length} file${changes.length === 1 ? "" : "s"} · ${r.plan.length} op${r.plan.length === 1 ? "" : "s"} · ${r.durationMs}ms`;
        } else if (r.plan.length > 0) {
          summary = `Script · ${r.plan.length} op${r.plan.length === 1 ? "" : "s"} (no-op) · ${r.durationMs}ms`;
        } else {
          const firstLine = r.stdout.split("\n").find((l) => l.trim() !== "") ?? "";
          summary = firstLine
            ? `Script · ${firstLine.slice(0, 60)} · ${r.durationMs}ms`
            : `Script · read-only · ${r.durationMs}ms`;
        }

        const events: VfsToolEvent[] = changes.map((c) => ({
          kind: "file_changed" as const,
          path: c.path,
          op: c.op,
          content: c.op === "delete" ? undefined : cur[c.path],
        }));
        return { ok: true, summary, result, events };
      }

      case "Glob": {
        const pattern = String(args.pattern ?? "");
        const path = typeof args.path === "string" ? (args.path as string) : undefined;
        if (!pattern) return { ok: false, error: "pattern required" };
        const hits = globMatch(ctx.files, pattern, path);
        return {
          ok: true,
          summary: `Glob ${pattern} · ${hits.length} match${hits.length === 1 ? "" : "es"}`,
          result: hits,
        };
      }

      case "Grep": {
        const pattern = String(args.pattern ?? "");
        const path = typeof args.path === "string" ? (args.path as string) : undefined;
        const include = typeof args.include === "string" ? (args.include as string) : undefined;
        if (!pattern) return { ok: false, error: "pattern required" };
        let re: RegExp;
        try {
          re = new RegExp(pattern);
        } catch (err) {
          return { ok: false, error: `Invalid regex: ${err instanceof Error ? err.message : String(err)}` };
        }
        const subset = path
          ? Object.fromEntries(Object.entries(ctx.files).filter(([k]) => k.startsWith(path)))
          : ctx.files;
        const hits = grepVfs(subset, re, { include, maxHits: 200 });
        const formatted = hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n");
        return {
          ok: true,
          summary: `Grep /${pattern}/ · ${hits.length} hit${hits.length === 1 ? "" : "s"}`,
          result: formatted || "(no matches)",
        };
      }

      case "LS": {
        const path = typeof args.path === "string" ? (args.path as string) : "";
        const entries = listChildren(ctx.files, path);
        return {
          ok: true,
          summary: `LS ${path || "/"} · ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
          result: entries,
        };
      }

      case "Delete": {
        const filePath = String(args.file_path ?? "");
        if (!filePath) return { ok: false, error: "file_path required" };
        if (!Object.prototype.hasOwnProperty.call(ctx.files, filePath)) {
          return { ok: false, error: `File not found: ${filePath}` };
        }
        const before = ctx.files;
        ctx.files = deleteFile(ctx.files, filePath);
        recordChange(ctx, filePath, "delete", before);
        return {
          ok: true,
          summary: `Deleted ${filePath}`,
          result: { ok: true },
          events: [{ kind: "file_changed", path: filePath, op: "delete" }],
        };
      }

      case "Build": {
        const built = await buildArtifact(ctx.files, ctx.entry);
        if (built.ok) {
          ctx.lastBuild = { ok: true, durationMs: built.durationMs, warnings: built.warnings };
          const summary =
            built.warnings.length > 0
              ? `Build OK · ${built.durationMs}ms · ${built.warnings.length} warning${built.warnings.length === 1 ? "" : "s"}`
              : `Build OK · ${built.durationMs}ms`;
          return {
            ok: true,
            summary,
            result: { ok: true, durationMs: built.durationMs, warnings: built.warnings.map(formatIssue) },
            events: [
              {
                kind: "build_result",
                ok: true,
                durationMs: built.durationMs,
                warnings: built.warnings,
              },
            ],
          };
        }
        ctx.lastBuild = {
          ok: false,
          durationMs: built.durationMs,
          errors: built.errors,
          warnings: built.warnings,
        };
        const summary = `Build failed · ${built.errors.length} error${built.errors.length === 1 ? "" : "s"}`;
        return {
          ok: true,
          summary,
          result: {
            ok: false,
            errors: built.errors.map(formatIssue),
            warnings: built.warnings.map(formatIssue),
          },
          events: [
            {
              kind: "build_result",
              ok: false,
              durationMs: built.durationMs,
              errors: built.errors,
              warnings: built.warnings,
            },
          ],
        };
      }

      case "Finish": {
        const summary = String(args.summary ?? "").trim() || "Done.";
        return {
          ok: true,
          summary: `Finish · "${summary.slice(0, 80)}${summary.length > 80 ? "…" : ""}"`,
          result: { summary },
          events: [{ kind: "finish", summary }],
        };
      }

      default:
        return { ok: false, error: `Unknown VFS tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------- shared web tool exec result ----------

export type ToolExecResult =
  | {
      ok: true;
      result: unknown;
      summary?: string;
      truncated?: boolean;
      /** Base64-encoded images (e.g. a browse_page screenshot) to attach to
       *  the tool result so vision-capable models can see them. */
      images?: string[];
      /** Files a sandbox run produced (run_code). Uploaded to Blob already;
       *  the chat loop surfaces them to the user as downloads and persists
       *  them on the assistant message. */
      files?: AttachedFile[];
    }
  | { ok: false; error: string };

/**
 * Rewrite an external image URL to flow through our /api/img proxy. Required
 * because the artifact iframe is sandboxed (opaque origin, srcdoc) and many
 * image CDNs block hot-linking — a direct `<img src=https://example.com/…>`
 * shows the broken-image glyph the user is seeing. The proxy serves the bytes
 * back from our own host with permissive CORS + a long cache. We need an
 * absolute URL because the iframe's base is `about:srcdoc`, where relative
 * paths don't resolve to anything useful.
 */
function proxyImageUrl(rawUrl: string, publicOrigin: string | undefined): string {
  if (!publicOrigin) return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") return rawUrl;
  } catch {
    return rawUrl;
  }
  return `${publicOrigin.replace(/\/+$/, "")}/api/img?u=${encodeURIComponent(rawUrl)}`;
}

export type ExecuteToolOpts = {
  /**
   * Public origin of this deployment (e.g. https://example.vercel.app), used
   * to construct absolute proxy URLs in image_search results. Derived from the
   * incoming request in the chat route. Falls back to no rewriting when
   * unavailable (local dev without a forwarded host header).
   */
  publicOrigin?: string;
  /** True when the active model can natively see images. Threaded to
   *  browse_page so it only captures + returns a screenshot when the model
   *  can actually use it. */
  vision?: boolean;
  /** Context for the code-execution sandbox (run_code). Present only when Code
   *  Execution mode is on; carries the files available this session, the
   *  user's blob namespace, and a session id for grouping run workspaces. */
  codeExec?: {
    available: AttachedFile[];
    /** Pasted-image bytes staged into the sandbox without a Blob round-trip. */
    inlineFiles?: { name: string; base64: string; contentType: string }[];
    /** Absent when Blob/auth didn't resolve a namespace; inline inputs still
     *  stage, only Blob-backed I/O (downloads / output uploads) needs it. */
    userHash?: string;
    sessionId: string;
  };
};

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  /** Adaptive cap: when set, web_fetch results are truncated to fit the remaining budget. */
  fetchCharLimit: number = MAX_FETCH_CHARS,
  opts: ExecuteToolOpts = {}
): Promise<ToolExecResult> {
  const ollama = ollamaClient();
  try {
    if (name === "web_search") {
      const query = String(args.query ?? "");
      const maxRaw = Number(args.max_results ?? args.maxResults);
      const maxResults = Number.isFinite(maxRaw)
        ? Math.min(10, Math.max(1, Math.trunc(maxRaw)))
        : undefined;
      const result = await ollama.webSearch({ query, maxResults });
      return { ok: true, result, summary: summarizeSearch(result) };
    }
    if (name === "web_fetch") {
      const url = String(args.url ?? "");
      const fetched = await ollama.webFetch({ url });
      let truncated = false;
      if (fetched.content && fetched.content.length > fetchCharLimit) {
        fetched.content = fetched.content.slice(0, fetchCharLimit) + "\n…[truncated]";
        truncated = true;
      }
      return { ok: true, result: fetched, summary: summarizeFetch(fetched), truncated };
    }
    if (name === "image_search") {
      const query = String(args.query ?? "");
      const maxRaw = Number(args.max_results ?? args.maxResults);
      const maxResults = Number.isFinite(maxRaw)
        ? Math.min(10, Math.max(1, Math.trunc(maxRaw)))
        : 6;
      // braveImageSearchValidated over-fetches from Brave and filters out
      // dead URLs before we ever hand them to the model — without this, the
      // model sees broken images in the artifact and spirals into dozens of
      // re-searches and web_fetches trying to verify URLs by hand. When the
      // original full-res URL is dead, it falls back to Brave's CDN
      // thumbnail (smaller but reliably reachable) so a search rarely
      // returns zero results.
      const images = await braveImageSearchValidated({ query, maxResults });
      type Item = {
        url: string;
        source: string;
        title?: string;
        width?: number;
        height?: number;
      };
      const seen = new Set<string>();
      const collected: Item[] = [];
      for (const img of images) {
        if (collected.length >= maxResults) break;
        if (seen.has(img.finalUrl)) continue;
        seen.add(img.finalUrl);
        collected.push({
          url: proxyImageUrl(img.finalUrl, opts.publicOrigin),
          source: img.source,
          title: img.title,
          width: img.width,
          height: img.height,
        });
      }
      const result = { query, results: collected };
      return { ok: true, result, summary: summarizeImageSearch(result) };
    }
    if (ADVANCED_WEB_TOOL_NAMES.has(name)) {
      // Lazy import keeps puppeteer-core / node:child_process out of the
      // static graph (and the Vercel bundle); these only run in the Fly
      // worker in production.
      const { executeAgenticTool } = await import("@/app/lib/web/agentic");
      return executeAgenticTool(name, args, {
        fetchCharLimit,
        vision: opts.vision,
      });
    }
    if (CODE_EXEC_TOOL_NAMES.has(name)) {
      if (!opts.codeExec) {
        return {
          ok: false,
          error:
            "Code execution context is unavailable for this request. Enable Code Execution mode and retry.",
        };
      }
      // Lazy import keeps node:child_process / node:fs out of the Vercel
      // bundle; the sandbox only runs in the Fly worker in production.
      const { executeCodeTool } = await import("@/app/lib/exec/sandbox");
      return executeCodeTool(name, args, opts.codeExec);
    }
    return { ok: false, error: `Unknown tool ${name}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Tool execution failed" };
  }
}
