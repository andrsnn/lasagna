// Paginated history for one account-shared designer.
//
//   GET /api/account/designer-history?id=<designerId>&before=<version>&limit=<n>
//
// The main /api/account pull strips `history` from the designer payload
// because the full edit log blows past Upstash's per-value cap once an app
// accumulates many versions. Clients catch up history in small pages
// through this endpoint instead: pass `before=0` for the newest page,
// then feed the returned `nextBefore` back in until it's absent.
//
// Response shape changed when history snapshots moved to Vercel Blob.
// Each entry is now either a blob-URL pointer `{ version, blobUrl }`
// (current path — the client fetches the snapshot from the blob CDN
// directly) or a legacy inline commit `{ version, commit }` (rows that
// haven't been migrated yet). The client handles both.

import {
  getDesignerHistoryPage,
  isAccountStoreConfigured,
} from "@/app/lib/account-store";
import { getCurrentUser } from "@/app/lib/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;

function notConfigured() {
  return Response.json(
    {
      error:
        "Account sharing isn't configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    },
    { status: 503 }
  );
}

function unauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function parseIntParam(raw: string | null, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function GET(req: Request) {
  if (!isAccountStoreConfigured()) return notConfigured();
  const user = await getCurrentUser(req);
  if (!user) return unauthorized();

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return Response.json({ error: "id is required." }, { status: 400 });
  }
  const before = parseIntParam(url.searchParams.get("before"), 0);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseIntParam(url.searchParams.get("limit"), DEFAULT_LIMIT))
  );

  try {
    const page = await getDesignerHistoryPage(user.email, id, before, limit);
    // Back-compat alias: older clients (in caches / older bundles still in
    // the field) expect `commits: DesignerCommit[]`. New clients read
    // `entries`. We compute `commits` only for the legacy-inline entries
    // — pointer entries are skipped because pre-blob clients couldn't
    // hydrate them anyway, and emitting half a page would be worse than
    // none. The new client always uses `entries` when present.
    const commits = page.entries
      .map((e) => ("commit" in e ? e.commit : null))
      .filter((c): c is NonNullable<typeof c> => c != null);
    return Response.json(
      {
        entries: page.entries,
        commits,
        ...(page.nextBefore != null ? { nextBefore: page.nextBefore } : {}),
      },
      { status: 200 }
    );
  } catch (err) {
    return Response.json(
      {
        error:
          err instanceof Error ? err.message : "Designer history fetch failed.",
      },
      { status: 500 }
    );
  }
}
