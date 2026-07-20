// One endpoint serving the entire account-sharing surface, behind the proxy
// auth middleware:
//
//   GET    /api/account?since=<ms>          → incremental pull (returns
//                                              everything updated since `since`).
//   POST   /api/account body { type, payload }
//                                            → upsert one entity.
//   DELETE /api/account?type=<t>&id=<id>    → remove one entity (and, for
//                                              apps, deregister the central
//                                              schedule).
//
// All operations are scoped to the calling user's email — keys live under
// `account:{userEmail}:*` so two users physically cannot read each
// other's rows.

import {
  type AccountEntityType,
  type AccountPayload,
  claimLegacyAccountDataForAdmin,
  isAccountEntityType,
  isAccountStoreConfigured,
  listSince,
  remove as removeEntity,
  upsert,
} from "@/app/lib/account-store";
import {
  isScheduleStoreConfigured,
  unregisterApp,
} from "@/app/lib/schedule-store";
import { getCurrentUser } from "@/app/lib/current-user";
import { getAdminEmail } from "@/app/lib/user-store";
import {
  deleteChatBlobs,
  deleteDesignerBlobs,
  userHash,
} from "@/app/lib/blob-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET(req: Request) {
  if (!isAccountStoreConfigured()) return notConfigured();
  const user = await getCurrentUser(req);
  if (!user) return unauthorized();
  // Cheap call: it checks a single marker key and returns if migration is
  // already done. Running it on every admin request keeps the migration
  // self-healing without a deploy-time step.
  if (user.isAdmin && user.email === getAdminEmail()) {
    await claimLegacyAccountDataForAdmin(user.email).catch(() => {});
  }

  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since");
  const since = sinceParam ? Number.parseInt(sinceParam, 10) : 0;
  const safeSince = Number.isFinite(since) && since >= 0 ? since : 0;
  try {
    return Response.json(await listSince(user.email, safeSince), { status: 200 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Account fetch failed." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  if (!isAccountStoreConfigured()) return notConfigured();
  const user = await getCurrentUser(req);
  if (!user) return unauthorized();

  let body: { type?: unknown; payload?: unknown };
  try {
    body = (await req.json()) as { type?: unknown; payload?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const type = body.type;
  if (!isAccountEntityType(type)) {
    return Response.json(
      { error: `type must be one of designer|app|chat|note.` },
      { status: 400 }
    );
  }
  const payload = body.payload;
  if (!payload || typeof payload !== "object") {
    return Response.json({ error: "payload is required." }, { status: 400 });
  }
  // The id check happens against the right field per type — the chat payload
  // carries it on the nested chat row, everyone else on the top level.
  const id =
    type === "chat"
      ? (payload as { chat?: { id?: unknown } }).chat?.id
      : (payload as { id?: unknown }).id;
  if (typeof id !== "string" || !id) {
    return Response.json({ error: "payload is missing a valid id." }, { status: 400 });
  }
  try {
    const updatedAt = await upsert(
      user.email,
      type as AccountEntityType,
      payload as AccountPayload
    );
    return Response.json({ updatedAt }, { status: 200 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Upsert failed." },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  if (!isAccountStoreConfigured()) return notConfigured();
  const user = await getCurrentUser(req);
  if (!user) return unauthorized();

  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const id = url.searchParams.get("id");
  if (!isAccountEntityType(type)) {
    return Response.json(
      { error: `type must be one of designer|app|chat|note.` },
      { status: 400 }
    );
  }
  if (!id) {
    return Response.json({ error: "id query param required." }, { status: 400 });
  }
  try {
    await removeEntity(user.email, type, id);
    // App-only side effect: also free up the central schedule registry so the
    // cron sweep stops firing for an app that's now local-only.
    if (type === "app" && isScheduleStoreConfigured()) {
      await unregisterApp(id).catch(() => {});
    }
    // Designer side effect: wipe the user's blob namespace for this
    // designer (current.json + history/v*.json). Without this, toggling
    // "Sync to account" OFF leaves the heavy file bytes paid-for on the
    // account. Safe to call when the prefix is empty.
    if (type === "designer") {
      try {
        const hash = await userHash(user.email);
        await deleteDesignerBlobs(hash, id);
      } catch (err) {
        console.warn(
          `[account.DELETE] blob cleanup failed for designer ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    // Chat side effect: remove the offloaded image blob (images.json) so an
    // unshared chat doesn't leave its photos paid-for on the account. The full
    // images still live in the sender's IndexedDB, so nothing is lost.
    if (type === "chat") {
      try {
        const hash = await userHash(user.email);
        await deleteChatBlobs(hash, id);
      } catch (err) {
        console.warn(
          `[account.DELETE] blob cleanup failed for chat ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    return Response.json({ ok: true }, { status: 200 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Delete failed." },
      { status: 500 }
    );
  }
}
