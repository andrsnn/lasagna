// Minimal server-side MCP (Model Context Protocol) client over the
// "Streamable HTTP" transport (the modern single-endpoint POST transport;
// https://modelcontextprotocol.io/specification). Enough to point the chat at
// a remote custom connector: initialize a session, list its tools, and call
// them. No SDK dependency - MCP is just JSON-RPC 2.0 over HTTP, so a bare
// `fetch` client keeps this out of the Vercel bundle weight and works on both
// the Vercel and Fly runtimes (pure outbound HTTP).
//
// We deliberately support ONLY remote HTTP MCP servers reachable with a URL +
// bearer token. stdio / local-process servers would need the Fly worker and a
// child process; that's out of scope for the "basic API key MCP" connector.

import type { Tool } from "ollama";
import type { McpRuntimeTool, McpRuntimeConnector } from "./shared";
import { mcpWireName } from "./shared";
import type { ToolExecResult } from "@/app/lib/ollama/tools";
import { isHostnameSafe } from "@/app/lib/safe-proxy";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "artifacts", version: "1.0.0" };
const DEFAULT_TIMEOUT_MS = 30_000;

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class McpError extends Error {}

/**
 * Validate an MCP endpoint URL before we ever fetch it: HTTPS only (a bearer
 * token must never cross plaintext), and the host must not resolve to a
 * private/loopback/link-local address (SSRF guard, shared with the artifact
 * proxy). Localhost http is allowed only outside production so a developer can
 * point at a local MCP server. Returns the parsed URL or throws McpError.
 */
export async function assertSafeMcpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpError("Enter a valid URL (including https://).");
  }
  const isLocalDev =
    process.env.NODE_ENV !== "production" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalDev) {
    throw new McpError("Only https:// MCP server URLs are allowed.");
  }
  if (!isLocalDev) {
    const safe = await isHostnameSafe(url.hostname);
    if (!safe.ok) throw new McpError(safe.reason);
  }
  return url;
}

/** Extract the JSON-RPC response from an HTTP response that is either a single
 *  `application/json` body or a `text/event-stream` (SSE) carrying the response
 *  as one or more `data:` events. We scan events for the first well-formed
 *  JSON-RPC message that has a `result` or `error` (i.e. a response, not a
 *  server-initiated notification). */
async function readJsonRpc(res: Response): Promise<JsonRpcResponse | null> {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!text.trim()) return null;

  if (ct.includes("text/event-stream")) {
    // Parse SSE: events separated by blank lines; `data:` lines concatenated.
    for (const block of text.split(/\r?\n\r?\n/)) {
      const dataLines = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (dataLines.length === 0) continue;
      const payload = dataLines.join("\n");
      try {
        const msg = JSON.parse(payload) as JsonRpcResponse;
        if (msg && (("result" in msg) || ("error" in msg))) return msg;
      } catch {
        // not a JSON-RPC data event - keep scanning
      }
    }
    return null;
  }

  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    throw new McpError(`MCP server returned non-JSON response: ${text.slice(0, 200)}`);
  }
}

/**
 * One MCP session against a single server URL. Lazily runs the
 * initialize → notifications/initialized handshake on first use, then reuses
 * the negotiated `Mcp-Session-Id` (when the server issues one) for subsequent
 * requests. Create one per connector per chat turn and reuse across tool calls;
 * a fresh worker (after a handoff) just makes a new session.
 */
export class McpSession {
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized: Promise<void> | null = null;

  constructor(opts: { url: string; apiKey?: string; timeoutMs?: number }) {
    this.url = opts.url;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      // Streamable HTTP servers may reply with either shape; advertise both.
      accept: "application/json, text/event-stream",
      ...extra,
    };
    if (this.apiKey) h["authorization"] = `Bearer ${this.apiKey}`;
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  private safeUrl: Promise<URL> | null = null;

  private async post(body: unknown): Promise<Response> {
    // Validate (HTTPS + SSRF guard) once, before the first outbound request.
    if (!this.safeUrl) this.safeUrl = assertSafeMcpUrl(this.url);
    await this.safeUrl;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Run a JSON-RPC request and return its `result`, throwing on transport,
   *  HTTP, or JSON-RPC errors. */
  private async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    let res: Response;
    try {
      res = await this.post({ jsonrpc: "2.0", id, method, params });
    } catch (err) {
      if (err instanceof McpError) throw err; // URL/SSRF guard message - pass through
      if (err instanceof Error && err.name === "AbortError") {
        throw new McpError(`MCP request "${method}" timed out after ${this.timeoutMs}ms`);
      }
      throw new McpError(
        `MCP request "${method}" failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // Capture a server-issued session id from the initialize response so later
    // calls can carry it.
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (res.status === 401 || res.status === 403) {
      throw new McpError(
        "MCP server rejected the API key (unauthorized). Double-check the key and URL."
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new McpError(
        `MCP server returned HTTP ${res.status} for "${method}"${body ? `: ${body.slice(0, 200)}` : ""}`
      );
    }
    const msg = await readJsonRpc(res);
    if (!msg) throw new McpError(`MCP server returned an empty response for "${method}"`);
    if (msg.error) {
      throw new McpError(`MCP error (${msg.error.code}): ${msg.error.message}`);
    }
    return msg.result;
  }

  /** Fire-and-forget notification (no id, no response body expected). */
  private async notify(method: string, params?: unknown): Promise<void> {
    try {
      await this.post({ jsonrpc: "2.0", method, params });
    } catch {
      // Notifications are best-effort; a failure here shouldn't abort the flow.
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        });
        await this.notify("notifications/initialized");
      })();
    }
    return this.initialized;
  }

  /** Discover the tools this server exposes. */
  async listTools(): Promise<{ serverName?: string; tools: McpRuntimeTool[] }> {
    await this.ensureInitialized();
    const result = (await this.request("tools/list", {})) as {
      tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>;
    };
    const tools: McpRuntimeTool[] = [];
    for (const t of result?.tools ?? []) {
      if (!t || typeof t.name !== "string" || !t.name) continue;
      tools.push({
        name: t.name,
        description: typeof t.description === "string" ? t.description : undefined,
        inputSchema: t.inputSchema,
      });
    }
    return { tools };
  }

  /** Call one tool and return its content flattened to text. */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    await this.ensureInitialized();
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
      isError?: boolean;
      structuredContent?: unknown;
    };
    return {
      text: flattenContent(result),
      isError: result?.isError === true,
    };
  }
}

/** Turn an MCP tools/call result's `content` blocks into a single string the
 *  model can read. Text blocks are concatenated; non-text blocks (images,
 *  resources) are summarized, and any structuredContent is appended as JSON. */
function flattenContent(result: {
  content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
}): string {
  const parts: string[] = [];
  for (const block of result?.content ?? []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "resource" && block.resource && typeof block.resource === "object") {
      const r = block.resource as { text?: string; uri?: string };
      if (typeof r.text === "string") parts.push(r.text);
      else if (typeof r.uri === "string") parts.push(`[resource ${r.uri}]`);
    } else if (block.type) {
      parts.push(`[${block.type} content]`);
    }
  }
  let out = parts.join("\n").trim();
  if (!out && result?.structuredContent !== undefined) {
    try {
      out = JSON.stringify(result.structuredContent);
    } catch {
      /* ignore */
    }
  }
  return out || "(the tool returned no content)";
}

/** One-shot discovery used by the /api/connectors/discover endpoint. */
export async function discoverConnector(opts: {
  url: string;
  apiKey?: string;
}): Promise<{ tools: McpRuntimeTool[] }> {
  const session = new McpSession(opts);
  return session.listTools();
}

/** One resolved MCP tool call target: the connector that owns it plus the
 *  original (un-namespaced) tool name to pass to tools/call. */
export type McpDispatchEntry = { connector: McpRuntimeConnector; toolName: string };

/** Everything a tool loop needs to expose a set of connectors' tools to a
 *  model and route the model's calls back to the right server:
 *  - `tools`: model-facing tool defs (namespaced wire-names) to append to the
 *    request's tool list;
 *  - `dispatch`: wire-name → { connector, toolName } for routing a call;
 *  - `getSession`: lazily opens and reuses one MCP session per connector. */
export type McpToolset = {
  tools: Tool[];
  dispatch: Map<string, McpDispatchEntry>;
  getSession: (connector: McpRuntimeConnector) => McpSession;
};

/**
 * Build the model-facing toolset for a set of MCP connectors. Shared by the
 * chat tool loop (app/api/chat/work.ts) and the artifact source/query executor
 * (app/lib/executors.ts) so both derive wire-names, tool schemas, and dispatch
 * the exact same way — the tool-list assembly and the dispatch map are built
 * from the same `mcpWireName`, so they always agree. Sessions are opened lazily
 * (one per connector) and reused across calls; a connector advertising no tools
 * contributes nothing.
 */
export function buildMcpToolset(
  connectors: McpRuntimeConnector[] | undefined
): McpToolset {
  const dispatch = new Map<string, McpDispatchEntry>();
  const tools: Tool[] = [];
  for (const connector of connectors ?? []) {
    for (const tool of connector.tools) {
      const wireName = mcpWireName(connector.id, tool.name);
      if (dispatch.has(wireName)) continue; // first tool wins on a rare collision
      dispatch.set(wireName, { connector, toolName: tool.name });
      const params =
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? (tool.inputSchema as Tool["function"]["parameters"])
          : { type: "object", properties: {} };
      tools.push({
        type: "function",
        function: {
          name: wireName,
          description:
            (tool.description ? `${tool.description}\n\n` : "") +
            `(Provided by the "${connector.name}" connector.)`,
          parameters: params,
        },
      });
    }
  }
  const sessions = new Map<string, McpSession>();
  const getSession = (connector: McpRuntimeConnector): McpSession => {
    let s = sessions.get(connector.id);
    if (!s) {
      s = new McpSession({ url: connector.url, apiKey: connector.apiKey });
      sessions.set(connector.id, s);
    }
    return s;
  };
  return { tools, dispatch, getSession };
}

/**
 * Execute one MCP tool call and adapt the result to the chat loop's
 * `ToolExecResult` contract (the same shape web_search / run_code return), so
 * the dispatcher in work.ts can treat it like any other tool.
 */
export async function executeMcpTool(
  session: McpSession,
  connector: McpRuntimeConnector,
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolExecResult> {
  try {
    const { text, isError } = await session.callTool(toolName, args);
    if (isError) {
      return { ok: false, error: text };
    }
    const chars = text.length;
    return {
      ok: true,
      result: text,
      summary: `${connector.name} · ${toolName} · ${chars} char${chars === 1 ? "" : "s"}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "MCP tool call failed",
    };
  }
}
