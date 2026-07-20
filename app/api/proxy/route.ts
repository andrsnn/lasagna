// Authenticated artifact proxy used by `artifact.fetch()` from the owner's
// live frame. The SSRF guards + body/time caps live in app/lib/safe-proxy.ts
// so the public shared-viewer proxy (`/api/share/html/[token]/fetch`) shares
// the identical protections.

import { runSafeProxy } from "@/app/lib/safe-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { httpStatus, payload } = await runSafeProxy(body as Record<string, unknown>);
  return Response.json(payload, { status: httpStatus });
}
