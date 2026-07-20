// GET /api/admin/account-sync?email=<email>[&id=<designerId>]
//
// Admin debug tool for the account-sync + blob pipeline. Returns the
// Redis-side picture of one user's shared rows + (for designers) the
// reachability of each blob URL. Use when a designer's edits aren't
// propagating between devices and you want to know whether:
//
//   - the row even made it to Redis (push failed silently?),
//   - the row carries the new ref shape (filesBlobUrl + historyBlobs) or
//     still has inline files (legacy / pre-blob),
//   - each blob URL on the row is fetchable (the receiver's pull does
//     this; if a blob 404s, every pulling device shows stale data),
//   - the index ZSET score (server upsert time) is recent.
//
// Auth: the proxy admin gate already blocks non-admins on /api/admin/*.

import { Redis } from "@upstash/redis";
import { head } from "@vercel/blob";
import { isAccountStoreConfigured } from "@/app/lib/account-store";
import type {
  StoredApp,
  StoredChat,
  StoredMessage,
  StoredPinnedNote,
} from "@/app/db";

type AccountChatBundle = { chat: StoredChat; messages: StoredMessage[] };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DesignerRefShape = {
  id?: string;
  name?: string;
  version?: number;
  updatedAt?: number;
  lastSyncedAt?: number;
  accountShared?: boolean;
  files?: unknown;
  entry?: unknown;
  history?: unknown[];
  filesBlobUrl?: string;
  filesBlobVersion?: number;
  historyBlobs?: Record<string, string>;
};

type BlobProbe = {
  url: string;
  status: number;
  ok: boolean;
  contentLength?: number | null;
  error?: string;
};

type DesignerInspection = {
  id: string;
  name: string;
  version: number;
  updatedAt?: number;
  lastSyncedAt?: number;
  accountShared: boolean;
  shape: "ref" | "legacy-inline" | "mixed" | "missing";
  hasInlineFiles: boolean;
  inlineHistoryCount: number;
  filesBlobUrl?: string;
  filesBlobVersion?: number;
  historyBlobVersionCount: number;
  historyBlobVersions: number[];
  indexScore?: number;
  filesBlobProbe?: BlobProbe;
  sampleHistoryBlobProbes?: BlobProbe[];
  warnings: string[];
};

type AppInspection = {
  id: string;
  name: string;
  version?: number;
  updatedAt?: number;
  lastSyncedAt?: number;
  accountShared: boolean;
  indexScore?: number;
};

type ChatInspection = {
  id: string;
  name: string;
  updatedAt?: number;
  lastSyncedAt?: number;
  accountShared: boolean;
  messageCount: number;
  archived: boolean;
  indexScore?: number;
  warnings: string[];
};

type NoteInspection = {
  id: string;
  name: string;
  updatedAt?: number;
  lastSyncedAt?: number;
  accountShared: boolean;
  indexScore?: number;
};

type Response = {
  email: string;
  designers: DesignerInspection[];
  apps: AppInspection[];
  chats: ChatInspection[];
  notes: NoteInspection[];
  indexSize: number;
};

function readRedisCreds(): { url?: string; token?: string } {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    token:
      process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  };
}

let cached: Redis | null = null;
function getRedis(): Redis {
  if (cached) return cached;
  const { url, token } = readRedisCreds();
  if (!url || !token) throw new Error("Redis not configured");
  cached = new Redis({ url, token });
  return cached;
}

function userScope(email: string): string {
  return email.trim().toLowerCase();
}

async function probeBlob(url: string): Promise<BlobProbe> {
  try {
    const meta = await head(url);
    return {
      url,
      status: 200,
      ok: true,
      contentLength: meta.size ?? null,
    };
  } catch (err) {
    return {
      url,
      status: 0,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function inspectDesigner(
  redis: Redis,
  email: string,
  id: string,
  indexScore: number | undefined,
  deep: boolean
): Promise<DesignerInspection> {
  const key = `account:${userScope(email)}:designer:${id}`;
  const raw = await redis.get<DesignerRefShape | string>(key);
  if (raw == null) {
    return {
      id,
      name: "(missing)",
      version: 0,
      accountShared: false,
      shape: "missing",
      hasInlineFiles: false,
      inlineHistoryCount: 0,
      historyBlobVersionCount: 0,
      historyBlobVersions: [],
      indexScore,
      warnings: ["Row absent from Redis even though the index references it."],
    };
  }
  const designer: DesignerRefShape =
    typeof raw === "string" ? (JSON.parse(raw) as DesignerRefShape) : raw;

  const hasInlineFiles =
    designer.files != null && typeof designer.files === "object";
  const inlineHistoryCount = Array.isArray(designer.history)
    ? designer.history.length
    : 0;
  const historyBlobs = designer.historyBlobs ?? {};
  const historyBlobVersions = Object.keys(historyBlobs)
    .map((k) => Number.parseInt(k, 10))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);

  let shape: DesignerInspection["shape"];
  if (designer.filesBlobUrl && !hasInlineFiles && inlineHistoryCount === 0) {
    shape = "ref";
  } else if (
    !designer.filesBlobUrl &&
    hasInlineFiles &&
    Object.keys(historyBlobs).length === 0
  ) {
    shape = "legacy-inline";
  } else {
    shape = "mixed";
  }

  const warnings: string[] = [];
  if (designer.filesBlobUrl && designer.filesBlobVersion !== designer.version) {
    warnings.push(
      `filesBlobVersion (${designer.filesBlobVersion}) lags row version (${designer.version}). Reader will hydrate stale VFS until next push.`
    );
  }
  if (designer.filesBlobUrl && hasInlineFiles) {
    warnings.push(
      "Row has BOTH filesBlobUrl AND inline files — the next ref-shaped push should clean this up."
    );
  }
  if (designer.accountShared && !designer.filesBlobUrl && !hasInlineFiles) {
    warnings.push(
      "Row is account-shared but has no VFS source (no filesBlobUrl, no inline files). Pulls return undefined files."
    );
  }
  if (
    designer.version != null &&
    historyBlobVersions.length > 0 &&
    historyBlobVersions[historyBlobVersions.length - 1] < designer.version - 1
  ) {
    warnings.push(
      `Top history blob version (${historyBlobVersions[historyBlobVersions.length - 1]}) is more than one behind row version (${designer.version}). Some commits never made it to blob.`
    );
  }

  let filesBlobProbe: BlobProbe | undefined;
  let sampleHistoryBlobProbes: BlobProbe[] | undefined;
  if (deep && designer.filesBlobUrl) {
    filesBlobProbe = await probeBlob(designer.filesBlobUrl);
    if (!filesBlobProbe.ok) {
      warnings.push(
        `filesBlobUrl returned ${filesBlobProbe.status}. Pulls won't be able to hydrate the current VFS.`
      );
    }
  }
  if (deep && historyBlobVersions.length > 0) {
    // Probe the three newest commit blobs — full sweep would hammer the CDN
    // at v500+ and the newest are the ones the receiver fetches first.
    const sampleVersions = historyBlobVersions.slice(-3);
    sampleHistoryBlobProbes = await Promise.all(
      sampleVersions.map((v) => probeBlob(historyBlobs[String(v)]))
    );
    for (const p of sampleHistoryBlobProbes) {
      if (!p.ok) {
        warnings.push(
          `History blob ${p.url} returned ${p.status}. The corresponding version is missing from the version dropdown on receiver devices.`
        );
      }
    }
  }

  return {
    id,
    name: designer.name ?? "(unnamed)",
    version: designer.version ?? 0,
    updatedAt: designer.updatedAt,
    lastSyncedAt: designer.lastSyncedAt,
    accountShared: !!designer.accountShared,
    shape,
    hasInlineFiles,
    inlineHistoryCount,
    filesBlobUrl: designer.filesBlobUrl,
    filesBlobVersion: designer.filesBlobVersion,
    historyBlobVersionCount: historyBlobVersions.length,
    historyBlobVersions,
    indexScore,
    filesBlobProbe,
    sampleHistoryBlobProbes,
    warnings,
  };
}

async function inspectApp(
  redis: Redis,
  email: string,
  id: string,
  indexScore: number | undefined
): Promise<AppInspection | null> {
  const key = `account:${userScope(email)}:app:${id}`;
  const raw = await redis.get<StoredApp | string>(key);
  if (raw == null) return null;
  const app: StoredApp = typeof raw === "string" ? JSON.parse(raw) : raw;
  return {
    id,
    name: app.name ?? "(unnamed)",
    updatedAt: app.updatedAt,
    lastSyncedAt: app.lastSyncedAt,
    accountShared: !!app.accountShared,
    indexScore,
  };
}

async function inspectChat(
  redis: Redis,
  email: string,
  id: string,
  indexScore: number | undefined
): Promise<ChatInspection> {
  const key = `account:${userScope(email)}:chat:${id}`;
  const raw = await redis.get<AccountChatBundle | string>(key);
  if (raw == null) {
    return {
      id,
      name: "(missing)",
      accountShared: false,
      messageCount: 0,
      archived: false,
      indexScore,
      warnings: ["Row absent from Redis even though the index references it."],
    };
  }
  // Chats are stored as a bundle: { chat, messages }. A malformed row (or a
  // legacy bare chat) may lack the nesting; tolerate both so the tool never
  // throws on inspect.
  const bundle: AccountChatBundle =
    typeof raw === "string" ? (JSON.parse(raw) as AccountChatBundle) : raw;
  const chat = bundle.chat ?? (bundle as unknown as StoredChat);
  const messages = Array.isArray(bundle.messages) ? bundle.messages : [];

  const warnings: string[] = [];
  if (chat.accountShared && messages.length === 0) {
    warnings.push(
      "Chat is account-shared but its bundle carries no messages. Receiving devices get an empty transcript."
    );
  }
  if (
    chat.updatedAt != null &&
    chat.lastSyncedAt != null &&
    chat.updatedAt > chat.lastSyncedAt
  ) {
    warnings.push(
      `Row updatedAt (${chat.updatedAt}) is ahead of lastSyncedAt (${chat.lastSyncedAt}). The sender had unsynced local edits when this row was written.`
    );
  }

  return {
    id,
    name: chat.title || "(untitled chat)",
    updatedAt: chat.updatedAt,
    lastSyncedAt: chat.lastSyncedAt,
    accountShared: !!chat.accountShared,
    messageCount: messages.length,
    archived: chat.archivedAt != null,
    indexScore,
    warnings,
  };
}

async function inspectNote(
  redis: Redis,
  email: string,
  id: string,
  indexScore: number | undefined
): Promise<NoteInspection | null> {
  const key = `account:${userScope(email)}:note:${id}`;
  const raw = await redis.get<StoredPinnedNote | string>(key);
  if (raw == null) return null;
  const note: StoredPinnedNote =
    typeof raw === "string" ? JSON.parse(raw) : raw;
  return {
    id,
    name: note.title || "(untitled note)",
    updatedAt: note.updatedAt ?? note.createdAt,
    lastSyncedAt: note.lastSyncedAt,
    accountShared: !!note.accountShared,
    indexScore,
  };
}

export async function GET(req: Request) {
  if (!isAccountStoreConfigured()) {
    return Response.json(
      { error: "Account store not configured." },
      { status: 503 }
    );
  }
  const url = new URL(req.url);
  const email = url.searchParams.get("email");
  if (!email) {
    return Response.json({ error: "email is required." }, { status: 400 });
  }
  const onlyId = url.searchParams.get("id"); // optional: narrow to one designer
  const deep = url.searchParams.get("deep") !== "0"; // blob probes on by default

  const redis = getRedis();
  const indexKey = `account:${userScope(email)}:index`;
  // ZRANGE … WITHSCORES interleaves member, score, member, score, …
  const rawMembers =
    (await redis.zrange<string[]>(indexKey, "-inf", "+inf", {
      byScore: true,
      withScores: true,
    })) ?? [];

  const designerEntries: { id: string; score?: number }[] = [];
  const appEntries: { id: string; score?: number }[] = [];
  const chatEntries: { id: string; score?: number }[] = [];
  const noteEntries: { id: string; score?: number }[] = [];
  for (let i = 0; i < rawMembers.length; i += 2) {
    const member = rawMembers[i];
    const scoreStr = rawMembers[i + 1];
    const score = Number(scoreStr);
    const colonIdx = member.indexOf(":");
    if (colonIdx < 0) continue;
    const type = member.slice(0, colonIdx);
    const id = member.slice(colonIdx + 1);
    if (onlyId && id !== onlyId) continue;
    const entry = { id, score: Number.isFinite(score) ? score : undefined };
    if (type === "designer") designerEntries.push(entry);
    else if (type === "app") appEntries.push(entry);
    else if (type === "chat") chatEntries.push(entry);
    else if (type === "note") noteEntries.push(entry);
  }

  const [designers, apps, chats, notes] = await Promise.all([
    Promise.all(
      designerEntries.map((e) =>
        inspectDesigner(redis, email, e.id, e.score, deep)
      )
    ),
    Promise.all(
      appEntries.map((e) => inspectApp(redis, email, e.id, e.score))
    ),
    Promise.all(
      chatEntries.map((e) => inspectChat(redis, email, e.id, e.score))
    ),
    Promise.all(
      noteEntries.map((e) => inspectNote(redis, email, e.id, e.score))
    ),
  ]);

  const out: Response = {
    email,
    designers,
    apps: apps.filter((a): a is AppInspection => a != null),
    chats,
    notes: notes.filter((n): n is NoteInspection => n != null),
    indexSize: rawMembers.length / 2,
  };
  return Response.json(out);
}
