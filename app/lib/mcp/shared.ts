// Shared, dependency-free MCP (Model Context Protocol) helpers.
//
// This module is imported from BOTH client components (the Preferences
// connectors tab, the composer sheet) and server code (the chat route/worker,
// the discovery endpoint). Keep it pure: no fetch, no node builtins, no React -
// just types and the wire-name derivation used to expose an MCP server's tools
// to the model.

/** One tool advertised by an MCP server (from tools/list). `inputSchema` is a
 *  JSON Schema for the tool's arguments - handed straight to the model as the
 *  tool's `parameters`. */
export type McpRuntimeTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

/** The slice of a connector the chat wire + worker need to call it: where the
 *  server is, how to authenticate, and which tools it exposes. Structurally a
 *  subset of the persisted `McpConnector` (app/db.ts) minus UI timestamps. */
export type McpRuntimeConnector = {
  id: string;
  name: string;
  url: string;
  apiKey?: string;
  tools: McpRuntimeTool[];
};

/** Prefix every MCP tool wire-name carries, so the chat dispatcher can tell an
 *  MCP call apart from a built-in tool (web_search, run_code, …) or a VFS tool
 *  by name alone. */
export const MCP_WIRE_PREFIX = "mcp_";

/** Collapse anything a model API might reject in a function name to `_`.
 *  Ollama/OpenAI-style tool names are effectively `[a-zA-Z0-9_-]`. */
function sanitizeNamePart(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Deterministic wire-name for one connector tool. Both the tool-list assembly
 * and the dispatch map are built by calling this with the same inputs, so they
 * always agree without threading a lookup table through the checkpoint. Kept
 * under the 64-char limit most tool-calling APIs impose: an 8-char connector-id
 * prefix (client ids are random, so this is collision-safe for the handful of
 * connectors a user configures) plus up to 40 chars of the tool name.
 */
export function mcpWireName(connectorId: string, toolName: string): string {
  const c = sanitizeNamePart(connectorId).slice(0, 8);
  const t = sanitizeNamePart(toolName).slice(0, 40);
  return `${MCP_WIRE_PREFIX}${c}_${t}`;
}

/** True when a tool name emitted by the model belongs to an MCP connector. */
export function isMcpWireName(name: string): boolean {
  return name.startsWith(MCP_WIRE_PREFIX);
}

/**
 * The connectors to send on a chat POST: the configured connectors filtered to
 * those currently toggled on, projected to the runtime shape (dropping UI-only
 * timestamps). Used at every send site so a chat only ships the connectors the
 * user enabled. `connectors` accepts the persisted `McpConnector` shape (extra
 * fields are ignored).
 */
export function activeConnectors(
  connectors: McpRuntimeConnector[] | undefined,
  enabledIds: string[] | undefined
): McpRuntimeConnector[] {
  if (!connectors?.length || !enabledIds?.length) return [];
  const on = new Set(enabledIds);
  return connectors
    .filter((c) => on.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      url: c.url,
      apiKey: c.apiKey,
      tools: c.tools,
    }));
}

/**
 * Coerce an untrusted client payload into well-formed runtime connectors,
 * dropping anything missing an id / name / url / tools array. Used at every
 * server entry point that accepts connectors from the wire (the query route,
 * the schedule register route) so a malformed payload can't crash the
 * executor's toolset assembly. This is a shape guard only — the MCP client's
 * assertSafeMcpUrl still enforces HTTPS + the SSRF allow-list at call time.
 */
export function sanitizeRuntimeConnectors(
  raw: unknown
): McpRuntimeConnector[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: McpRuntimeConnector[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    if (
      typeof o.id !== "string" ||
      typeof o.name !== "string" ||
      typeof o.url !== "string" ||
      !Array.isArray(o.tools)
    ) {
      continue;
    }
    out.push({
      id: o.id,
      name: o.name,
      url: o.url,
      apiKey: typeof o.apiKey === "string" ? o.apiKey : undefined,
      tools: o.tools as McpRuntimeTool[],
    });
  }
  return out.length ? out : undefined;
}
