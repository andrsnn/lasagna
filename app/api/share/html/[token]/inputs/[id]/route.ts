// Public DELETE of a single input entry. Wiki-mode: any viewer can delete
// any entry (per product decision). Risk contained by the same caps and TTL
// guarding append. See ../route.ts.
//
//   DELETE /api/share/html/[token]/inputs/[id]?collection=name

import {
  DELETE_RATE_PER_MINUTE,
  checkRateLimit,
  deleteInput,
  isShareInputStoreConfigured,
  isValidCollectionName,
} from "@/app/lib/share-input-store";
import {
  HTML_SHARE_TOKEN_REGEX,
  getHtmlShare,
} from "@/app/lib/html-share-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENTRY_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const ip = xff.split(",")[0]?.trim();
  return ip && ip.length > 0 ? ip : "anon";
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ token: string; id: string }> }
) {
  const { token, id } = await params;
  if (!HTML_SHARE_TOKEN_REGEX.test(token)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  if (!ENTRY_ID_REGEX.test(id)) {
    return Response.json({ error: "Invalid entry id." }, { status: 400 });
  }
  if (!isShareInputStoreConfigured()) {
    return Response.json(
      { error: "Shared inputs aren't configured on this server." },
      { status: 503 }
    );
  }
  const share = await getHtmlShare(token);
  if (!share) {
    return Response.json(
      { error: "This share link has expired or doesn't exist." },
      { status: 410 }
    );
  }

  const collection = new URL(req.url).searchParams.get("collection");
  if (!isValidCollectionName(collection)) {
    return Response.json(
      { error: "collection is required and must match [a-z0-9_-]{1,32}." },
      { status: 400 }
    );
  }

  const ip = clientIp(req);
  const limited = await checkRateLimit(token, ip, "delete", DELETE_RATE_PER_MINUTE);
  if (limited) {
    return Response.json(
      { error: "Too many deletions. Try again in a minute." },
      { status: 429 }
    );
  }

  try {
    const removed = await deleteInput(token, collection, id);
    return Response.json({ removed });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to delete." },
      { status: 500 }
    );
  }
}
