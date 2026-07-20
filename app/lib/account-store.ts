// Server-side account-level entity store. Per-user now: every key is
// prefixed with the owner's email-lowercase, so two users can't read
// each other's data even if a route forgets to filter.
//
// Layout under Upstash Redis:
//   account:{userId}:{type}:{id}  → JSON entity payload
//   account:{userId}:index        → ZSET, member = "${type}:${id}", score = server-stamped upsert time(ms)
//
// The sorted set lets `listSince(ts)` answer "what changed?" with a single
// ZRANGEBYSCORE before fanning out per-key GETs. The ZSET score uses the
// server clock so cross-client skew can't break the incremental-pull
// watermark. The row's own `updatedAt` is left alone — that's the
// user-visible activity timestamp the chats list sorts and labels by,
// and rewriting it here caused every push to echo back through the next
// pull as "just now", resorting the list and corrupting the dates.
//
// Legacy single-tenant layout (`account:{type}:{id}`, `account:index`) is
// claimed by the admin on first read via `claimLegacyAccountDataForAdmin`.
//
// Designer rows are special: the heavy parts (current VFS in `files`/`entry`,
// per-version history snapshots in `history[]`) live in Vercel Blob, not in
// Redis. The Redis row is a small ref — { filesBlobUrl, historyBlobs } — that
// points at blob URLs. Old inline-shaped rows are tolerated on read; they
// upgrade automatically on the next push from any client.

import { Redis } from "@upstash/redis";
import type {
  DesignerCommit,
  StoredApp,
  StoredChat,
  StoredDesigner,
  StoredMessage,
  StoredPinnedNote,
} from "@/app/db";

export const ACCOUNT_ENTITY_TYPES = [
  "designer",
  "app",
  "chat",
  "note",
] as const;

export type AccountEntityType = (typeof ACCOUNT_ENTITY_TYPES)[number];

export function isAccountEntityType(s: unknown): s is AccountEntityType {
  return typeof s === "string" && (ACCOUNT_ENTITY_TYPES as readonly string[]).includes(s);
}

export type AccountChatBundle = {
  chat: StoredChat;
  messages: StoredMessage[];
  /**
   * Set when the chat's images were offloaded to Blob to keep the sync bundle
   * under the 4.5 MB POST cap. Points at a `{ imageId: dataUrl }` map; the
   * bundle's message images then carry `dataUrl: ""` and the receiver
   * rehydrates them from this blob. Absent on small chats (images stay inline).
   */
  imagesBlobUrl?: string;
};

/**
 * Sync-only metadata fields layered onto the designer payload over the wire.
 * Heavy data (`files`, `entry`, `history[]`) moved out to Vercel Blob;
 * `filesBlobUrl` and `historyBlobs` are the pointers the client uses to
 * hydrate the IDB row. `filesBlobVersion` lets the client trust that the
 * pointed-to current.json matches `version` (defends against stale pointer
 * races where the Redis row updated but the blob URL didn't yet).
 */
export type DesignerSyncRefFields = {
  /** URL of `account/{userHash}/designer/{id}/current.json` — { files, entry, version }. */
  filesBlobUrl?: string;
  filesBlobVersion?: number;
  /** Map from commit `version` → blob URL of that commit's full VFS snapshot. */
  historyBlobs?: Record<string, string>;
};

/**
 * Wire shape for designer push and pull. Strips the heavy fields that now
 * live in blob storage; the client hydrates from `filesBlobUrl` /
 * `historyBlobs` on the receiving side. We also keep `files`/`entry`
 * optional so the legacy inline-shaped Redis rows still deserialize.
 */
export type AccountDesignerPayload = Omit<
  StoredDesigner,
  "files" | "entry" | "history"
> & {
  files?: StoredDesigner["files"];
  entry?: StoredDesigner["entry"];
  history?: StoredDesigner["history"];
} & DesignerSyncRefFields;

/**
 * Wire-format for entities. Designer travels as the ref shape; app/note
 * travel as their IDB shape; chats bundle their messages because a chat
 * without its messages is useless to the receiving device.
 */
export type AccountPayload<T extends AccountEntityType = AccountEntityType> =
  T extends "designer" ? AccountDesignerPayload :
  T extends "app" ? StoredApp :
  T extends "chat" ? AccountChatBundle :
  T extends "note" ? StoredPinnedNote :
  never;

export type AccountStateBundle = {
  designers: AccountDesignerPayload[];
  apps: StoredApp[];
  chats: AccountChatBundle[];
  notes: StoredPinnedNote[];
  serverNow: number;
};

const PREFIX = "account";
const LEGACY_INDEX_KEY = `${PREFIX}:index`;
const LEGACY_MIGRATION_MARKER = `${PREFIX}:migration:done`;

let cached: Redis | null = null;
let cachedError: Error | null = null;

function readRedisCreds(): { url?: string; token?: string } {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    token:
      process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  };
}

export function isAccountStoreConfigured(): boolean {
  const { url, token } = readRedisCreds();
  return !!(url && token);
}

function getRedis(): Redis {
  if (cached) return cached;
  if (cachedError) throw cachedError;
  const { url, token } = readRedisCreds();
  if (!url || !token) {
    cachedError = new Error(
      "Account sharing needs Redis credentials. Provision an Upstash Redis (or Vercel KV) " +
        "database and expose either UPSTASH_REDIS_REST_URL+UPSTASH_REDIS_REST_TOKEN or " +
        "KV_REST_API_URL+KV_REST_API_TOKEN to the project."
    );
    throw cachedError;
  }
  cached = new Redis({ url, token });
  return cached;
}

function userScope(userId: string): string {
  // Lowercased emails are safe as Redis key components (`@` and `.` are
  // fine); we don't escape further to keep keys grep-friendly in the
  // admin Redis browser.
  return userId.toLowerCase();
}

function entityKey(userId: string, type: AccountEntityType, id: string): string {
  return `${PREFIX}:${userScope(userId)}:${type}:${id}`;
}

function userIndexKey(userId: string): string {
  return `${PREFIX}:${userScope(userId)}:index`;
}

function indexMember(type: AccountEntityType, id: string): string {
  return `${type}:${id}`;
}

function parseJsonOrObject<T>(raw: T | string | null): T | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return raw;
}

/**
 * Pull the id off the entity payload. For chats the id lives on the nested
 * chat row, not the top-level bundle.
 */
function payloadId(type: AccountEntityType, payload: AccountPayload): string {
  if (type === "chat") return (payload as AccountChatBundle).chat.id;
  return (payload as { id: string }).id;
}

/**
 * Pull the row's own updatedAt off the payload — the inner chat row for
 * chats, the top-level for everything else. Returns null if it's missing
 * or non-finite; the caller falls back to the server clock.
 */
function payloadUpdatedAt(
  type: AccountEntityType,
  payload: AccountPayload
): number | null {
  const raw =
    type === "chat"
      ? (payload as AccountChatBundle).chat.updatedAt
      : (payload as { updatedAt?: number }).updatedAt;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

export async function upsert<T extends AccountEntityType>(
  userId: string,
  type: T,
  payload: AccountPayload<T>
): Promise<number> {
  const redis = getRedis();
  // ZSET score is server-clock so cross-client skew can't poison the
  // incremental-pull watermark. The row's updatedAt is preserved as the
  // client sent it — that's the user-visible activity time.
  const score = Date.now();
  const id = payloadId(type, payload);

  // Designer-specific: never persist `history[]` in the Redis row (it's
  // what blew us past the 1 MB cap in the first place). Per-version
  // snapshots live in blob storage. Also merge `historyBlobs` with what's
  // already on the server so a push that only knows about new commits
  // doesn't drop older blob pointers; and if the row was previously inline
  // (legacy) and the incoming push doesn't carry a `filesBlobUrl`, keep
  // the inline `files`/`entry` so we don't lose the current VFS during
  // half-migrated states.
  let toStore: unknown = payload;
  if (type === "designer") {
    const incoming = payload as AccountDesignerPayload;
    const existing = (await redis.get<AccountDesignerPayload | string>(
      entityKey(userId, "designer", id)
    )) as AccountDesignerPayload | string | null;
    const existingObj = parseJsonOrObject<AccountDesignerPayload>(existing);
    const mergedHistoryBlobs: Record<string, string> = {
      ...(existingObj?.historyBlobs ?? {}),
      ...(incoming.historyBlobs ?? {}),
    };
    const next: AccountDesignerPayload = { ...incoming, history: undefined };
    if (Object.keys(mergedHistoryBlobs).length > 0) {
      next.historyBlobs = mergedHistoryBlobs;
    }
    // If the incoming push uses the new ref shape, strip the inline VFS
    // (defensive — clients shouldn't send both). If it's a legacy inline
    // push, keep files/entry inline; the next ref-shaped push migrates it.
    if (next.filesBlobUrl) {
      next.files = undefined;
      next.entry = undefined;
    }
    toStore = next;
  }

  await redis.set(entityKey(userId, type, id), JSON.stringify(toStore));
  await redis.zadd(userIndexKey(userId), {
    score,
    member: indexMember(type, id),
  });
  // Return the row's own updatedAt so the client can stamp lastSyncedAt
  // against the activity time, keeping reconcileSharedChatGap's
  // (maxMessageCreatedAt > lastSyncedAt) comparison meaningful. Fall back
  // to the server score on the (unexpected) payload-missing-updatedAt
  // path.
  return payloadUpdatedAt(type, payload) ?? score;
}

export async function remove(
  userId: string,
  type: AccountEntityType,
  id: string
): Promise<void> {
  const redis = getRedis();
  await Promise.all([
    redis.del(entityKey(userId, type, id)),
    redis.zrem(userIndexKey(userId), indexMember(type, id)),
  ]);
}

export async function get<T extends AccountEntityType>(
  userId: string,
  type: T,
  id: string
): Promise<AccountPayload<T> | null> {
  const redis = getRedis();
  const raw = await redis.get<AccountPayload<T> | string>(
    entityKey(userId, type, id)
  );
  return parseJsonOrObject<AccountPayload<T>>(raw);
}

/**
 * Returns every entity whose server-stamped updatedAt is strictly greater
 * than `since`, scoped to a single user. Pass `0` for a full snapshot.
 * Includes a `serverNow` timestamp the client should use as its next
 * watermark — avoids skew issues if clients have drifted clocks.
 */
export async function listSince(
  userId: string,
  since: number
): Promise<AccountStateBundle> {
  const redis = getRedis();
  const now = Date.now();
  // ZRANGEBYSCORE with `(since` to keep it exclusive — clients pass back
  // whatever serverNow they last received, and we don't re-deliver rows
  // already at exactly that mark. The literal-template typing of the
  // Upstash client requires the exclusive form to be `(${number}`.
  const min: `(${number}` | "-inf" =
    since > 0 ? (`(${since}` as `(${number}`) : "-inf";
  const members =
    (await redis.zrange<string[]>(userIndexKey(userId), min, "+inf", {
      byScore: true,
    })) ?? [];

  const designers: AccountDesignerPayload[] = [];
  const apps: StoredApp[] = [];
  const chats: AccountChatBundle[] = [];
  const notes: StoredPinnedNote[] = [];

  if (members.length === 0) {
    return { designers, apps, chats, notes, serverNow: now };
  }

  const fetches = members.map(async (member) => {
    const idx = member.indexOf(":");
    if (idx < 0) return;
    const type = member.slice(0, idx);
    const id = member.slice(idx + 1);
    if (!isAccountEntityType(type) || !id) return;
    const value = await get(userId, type, id);
    if (!value) return;
    switch (type) {
      case "designer": {
        // Strip `history` here — it's a per-version full file snapshot that
        // by ~v100 makes the designer payload exceed Vercel's response and
        // Upstash's value cap. New ref-shaped rows also carry no `files` /
        // `entry` inline (those live in the blob pointed to by
        // `filesBlobUrl`); legacy inline-shaped rows still have them, and
        // we leave them inline so the receiving device keeps working until
        // its next save migrates the row to ref shape.
        const d = value as AccountDesignerPayload;
        const stripped: AccountDesignerPayload = {
          ...d,
          history: undefined,
        };
        // If we have a blob pointer for the current VFS, drop the inline
        // copy (defensive — newly-written rows already lack it, but legacy
        // rows might carry both during upgrade). The client hydrates from
        // filesBlobUrl.
        if (stripped.filesBlobUrl) {
          stripped.files = undefined;
          stripped.entry = undefined;
        }
        designers.push(stripped);
        return;
      }
      case "app":
        apps.push(value as StoredApp);
        return;
      case "chat":
        chats.push(value as AccountChatBundle);
        return;
      case "note":
        notes.push(value as StoredPinnedNote);
        return;
    }
  });
  await Promise.all(fetches);

  return { designers, apps, chats, notes, serverNow: now };
}

/**
 * One commit page entry. Either carries the snapshot inline (legacy
 * inline-shaped Redis rows) or just the blob URL the client must fetch
 * to hydrate it. The client tolerates both shapes.
 */
export type DesignerHistoryPageEntry =
  | { version: number; blobUrl: string }
  | { version: number; commit: DesignerCommit };

/**
 * Paginated history page for one designer. Returns up to `limit` entries
 * whose `version` is strictly less than `beforeVersion` (pass `0` to start
 * from the newest). Entries come back newest-first to match the
 * VersionHistoryDropdown's display order. `nextBefore` carries the
 * lowest version returned when the page is full — clients pass it back to
 * fetch the next chunk; absent means there are no older versions left.
 *
 * For ref-shaped rows (the new path) each entry is a `{ version, blobUrl }`
 * pointer the client fetches directly from the blob CDN. For legacy
 * inline-shaped rows the entry is `{ version, commit }`. The function
 * picks per-row at read time so the two shapes coexist during migration.
 */
export async function getDesignerHistoryPage(
  userId: string,
  designerId: string,
  beforeVersion: number,
  limit: number
): Promise<{ entries: DesignerHistoryPageEntry[]; nextBefore?: number }> {
  const value = await get(userId, "designer", designerId);
  if (!value) return { entries: [] };
  const designer = value as AccountDesignerPayload;

  // New ref-shaped path: enumerate versions from `historyBlobs`, return
  // pointers. The history blobs map's keys are stringified versions.
  const historyBlobs = designer.historyBlobs ?? null;
  if (historyBlobs) {
    const versions = Object.keys(historyBlobs)
      .map((k) => Number.parseInt(k, 10))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => b - a);
    const filtered =
      beforeVersion > 0 ? versions.filter((v) => v < beforeVersion) : versions;
    const chunk = filtered.slice(0, Math.max(1, limit));
    const entries: DesignerHistoryPageEntry[] = chunk.map((v) => ({
      version: v,
      blobUrl: historyBlobs[String(v)],
    }));
    const hitLimit = chunk.length === limit && filtered.length > chunk.length;
    const nextBefore = hitLimit ? chunk[chunk.length - 1] : undefined;
    return { entries, ...(nextBefore != null ? { nextBefore } : {}) };
  }

  // Legacy inline path: read commits from the row's `history[]` array.
  const all = (designer.history ?? [])
    .slice()
    .sort((a, b) => b.version - a.version);
  const filtered =
    beforeVersion > 0 ? all.filter((h) => h.version < beforeVersion) : all;
  const chunk = filtered.slice(0, Math.max(1, limit));
  const entries: DesignerHistoryPageEntry[] = chunk.map((c) => ({
    version: c.version,
    commit: c,
  }));
  const hitLimit = chunk.length === limit && filtered.length > chunk.length;
  const nextBefore = hitLimit ? chunk[chunk.length - 1].version : undefined;
  return { entries, ...(nextBefore != null ? { nextBefore } : {}) };
}

/**
 * One-time migration: before the multi-user upgrade, account rows lived
 * at `account:{type}:{id}` with a single global `account:index` ZSET.
 * Move every legacy row under the admin's namespace so their pre-upgrade
 * account-shared data isn't orphaned.
 *
 * Idempotent — a `account:migration:done` marker key prevents re-runs.
 * Cheap to call on every admin pull: the marker check is one Redis GET.
 */
export async function claimLegacyAccountDataForAdmin(adminEmail: string): Promise<void> {
  const redis = getRedis();
  const marker = await redis.get<unknown>(LEGACY_MIGRATION_MARKER);
  if (marker != null) return;

  const legacyMembers =
    (await redis.zrange<string[]>(LEGACY_INDEX_KEY, "-inf", "+inf", {
      byScore: true,
      withScores: true,
    })) ?? [];

  if (legacyMembers.length > 0) {
    // ZRANGE … WITHSCORES interleaves member, score, member, score, …
    for (let i = 0; i < legacyMembers.length; i += 2) {
      const member = legacyMembers[i];
      const scoreStr = legacyMembers[i + 1];
      const score = Number(scoreStr);
      if (!member || !Number.isFinite(score)) continue;
      const idx = member.indexOf(":");
      if (idx < 0) continue;
      const type = member.slice(0, idx);
      const id = member.slice(idx + 1);
      if (!isAccountEntityType(type) || !id) continue;
      const legacyKey = `${PREFIX}:${type}:${id}`;
      const value = await redis.get<unknown>(legacyKey);
      if (value == null) continue;
      // Write to the admin-scoped key only if it's not already there —
      // never overwrite anything the admin has since created post-upgrade.
      const newKey = entityKey(adminEmail, type as AccountEntityType, id);
      const exists = await redis.get<unknown>(newKey);
      if (exists == null) {
        await redis.set(
          newKey,
          typeof value === "string" ? value : JSON.stringify(value)
        );
        await redis.zadd(userIndexKey(adminEmail), {
          score,
          member: indexMember(type as AccountEntityType, id),
        });
      }
      await redis.del(legacyKey);
    }
    await redis.del(LEGACY_INDEX_KEY);
  }

  await redis.set(LEGACY_MIGRATION_MARKER, Date.now());
}
