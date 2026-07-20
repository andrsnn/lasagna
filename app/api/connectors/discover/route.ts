// Discovery endpoint for custom MCP connectors. The Preferences "Connectors"
// tab posts a { url, apiKey } here; we run the MCP initialize → tools/list
// handshake server-side (the browser can't: MCP servers rarely send CORS
// headers, and we don't want the API key bouncing through client-side fetch
// logging) and return the discovered tool list. The client then persists the
// connector + its tools in the local Settings singleton.

import { discoverConnector, McpError } from "@/app/lib/mcp/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  url?: string;
  apiKey?: string;
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  const apiKey =
    typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : undefined;

  if (!url) {
    return Response.json({ error: "A server URL is required." }, { status: 400 });
  }

  try {
    const { tools } = await discoverConnector({ url, apiKey });
    if (tools.length === 0) {
      return Response.json(
        {
          error:
            "Connected, but the server advertised no tools. Check that this is a tools-capable MCP endpoint.",
        },
        { status: 422 }
      );
    }
    return Response.json({ tools });
  } catch (err) {
    // McpError carries a user-facing message (bad key, unreachable, non-MCP
    // endpoint, blocked address). Anything else is unexpected - keep it terse.
    const message =
      err instanceof McpError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Failed to reach the MCP server.";
    return Response.json({ error: message }, { status: 502 });
  }
}
