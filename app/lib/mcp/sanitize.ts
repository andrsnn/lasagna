// Validation for MCP connector payloads arriving on the chat wire. Pure (no
// server deps) so it can be imported from the route and unit-reasoned about.
// The URL is NOT network-validated here - the SSRF/HTTPS guard runs in the MCP
// client just before the outbound fetch (assertSafeMcpUrl); this only shapes
// untrusted JSON into a well-typed connector list.

import type { McpRuntimeConnector, McpRuntimeTool } from "./shared";

const MAX_CONNECTORS = 20;
const MAX_TOOLS_PER_CONNECTOR = 200;

function asTool(raw: unknown): McpRuntimeTool | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) return null;
  return {
    name,
    description: typeof r.description === "string" ? r.description : undefined,
    inputSchema: r.inputSchema,
  };
}

/** Coerce an untrusted `body.connectors` value into a clean, bounded list of
 *  runtime connectors. Drops anything missing an id/url/tools. */
export function sanitizeConnectors(raw: unknown): McpRuntimeConnector[] {
  if (!Array.isArray(raw)) return [];
  const out: McpRuntimeConnector[] = [];
  for (const item of raw.slice(0, MAX_CONNECTORS)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const url = typeof r.url === "string" ? r.url.trim() : "";
    if (!id || !url) continue;
    const tools = Array.isArray(r.tools)
      ? r.tools
          .slice(0, MAX_TOOLS_PER_CONNECTOR)
          .map(asTool)
          .filter((t): t is McpRuntimeTool => t !== null)
      : [];
    if (tools.length === 0) continue; // nothing to expose to the model
    out.push({
      id,
      name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : "Connector",
      url,
      apiKey: typeof r.apiKey === "string" && r.apiKey.trim() ? r.apiKey.trim() : undefined,
      tools,
    });
  }
  return out;
}
