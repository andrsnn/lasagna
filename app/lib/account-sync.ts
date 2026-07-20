// Client-side wiring for account-level sharing.
//
// Three responsibilities, all expressed through one per-type adapter table
// so adding a new entity is "add one entry to ADAPTERS" — no new
// HTTP routes, no new toggle function, no new merge logic to maintain in
// parallel. Each adapter teaches the generic code:
//
//   loadLocal(id)         → read the IDB row.
//   putLocal(row)         → write the IDB row (fires the save hook in db.ts).
//   getAccountShared(row) → which flag on the row signals "shared".
//   setShareFlags(row,on,now)
//                         → flip the share flags + bump updatedAt locally.
//   serializeForUpload(row)
//                         → wire shape (chat bundles its messages here).
//   applyRemote(remote)   → merge the server's row into IDB (chat also
//                           writes its messages).
//   idOf(row)             → row → string id.
//   remoteId(remote)      → wire payload → string id (chat lives on .chat.id).
//   remoteUpdatedAt(remote)
//                         → wire payload → updatedAt (for last-write-wins).
//
// The generic toggle / push / pull then never branches on type.

import {
  getApp,
  getChat,
  getDesigner,
  getPinnedNote,
  listChats,
  loadMessages,
  putApp,
  putChat,
  putDesigner,
  putMessage,
  putPinnedNote,
  registerAccountSyncHook,
  type AccountSyncEntity,
  type DesignerCommit,
  type StoredApp,
  type StoredChat,
  type StoredDesigner,
  type StoredMessage,
  type StoredPinnedNote,
} from "@/app/db";
import {
  fetchChatImagesBlob,
  fetchDesignerCommitBlob,
  fetchDesignerCurrentBlob,
  uploadChatImagesBlob,
  uploadDesignerBlobs,
} from "@/app/lib/account-blob-uploader";

type EntityType = AccountSyncEntity["type"];

type AccountChatBundle = {
  chat: StoredChat;
  messages: StoredMessage[];
  // Present when the chat's images were offloaded to Blob (bundle too big for
  // the 4.5 MB POST cap). Points at a `{ imageId: dataUrl }` map; wire message
  // images then carry `dataUrl: ""` and the receiver rehydrates from it.
  imagesBlobUrl?: string;
};

/**
 * Wire shape for designer push/pull. Heavy fields live in Vercel Blob now;
 * the row carries pointers (`filesBlobUrl`, `historyBlobs`) instead of
 * inline data. Legacy rows still carry inline `files`/`entry`/`history`
 * during the lazy migration window. Kept here (not imported from
 * server-side account-store.ts) to avoid pulling @upstash/redis into the
 * browser bundle.
 */
type AccountDesignerPayload = Omit<
  StoredDesigner,
  "files" | "entry" | "history"
> & {
  files?: StoredDesigner["files"];
  entry?: StoredDesigner["entry"];
  history?: StoredDesigner["history"];
  filesBlobUrl?: string;
  filesBlobVersion?: number;
  historyBlobs?: Record<string, string>;
};

type DesignerHistoryPageEntry =
  | { version: number; blobUrl: string }
  | { version: number; commit: DesignerCommit };

type AccountStateBundle = {
  designers: AccountDesignerPayload[];
  apps: StoredApp[];
  chats: AccountChatBundle[];
  notes: StoredPinnedNote[];
  serverNow: number;
};

/**
 * Per-entity glue. The generic code reads / writes through this; adding a
 * new entity = a new key on this object.
 */
type Adapter<Row, Remote> = {
  loadLocal: (id: string) => Promise<Row | undefined>;
  putLocal: (row: Row) => Promise<void>;
  getAccountShared: (row: Row) => boolean;
  setShareFlags: (row: Row, on: boolean, now: number) => Row;
  setLastSyncedAt: (row: Row, ms: number) => Row;
  serializeForUpload: (row: Row) => Promise<Remote>;
  applyRemote: (remote: Remote) => Promise<void>;
  idOf: (row: Row) => string;
  remoteId: (remote: Remote) => string;
  remoteUpdatedAt: (remote: Remote) => number;
};

type AdapterFor<T extends EntityType> =
  T extends "designer" ? Adapter<StoredDesigner, AccountDesignerPayload> :
  T extends "app" ? Adapter<StoredApp, StoredApp> :
  T extends "chat" ? Adapter<StoredChat, AccountChatBundle> :
  T extends "note" ? Adapter<StoredPinnedNote, StoredPinnedNote> :
  never;

function clearShareFlags<R extends {
  accountShared?: boolean;
  accountSharedAt?: number;
  lastSyncedAt?: number;
  updatedAt?: number;
  // Designer-only — harmless to clear on other rows that don't have them.
  filesBlobUrl?: string;
  filesBlobVersion?: number;
  historyBlobs?: Record<string, string>;
  // Chat-only image-offload pointers — likewise harmless elsewhere.
  imagesBlobUrl?: string;
  imagesBlobSig?: string;
}>(row: R, now: number): R {
  return {
    ...row,
    accountShared: false,
    accountSharedAt: undefined,
    lastSyncedAt: undefined,
    updatedAt: now,
    // Stale pointers would make uploadDesignerBlobs skip re-uploading on
    // re-enable; clear them so toggling sync back ON forces a full push.
    filesBlobUrl: undefined,
    filesBlobVersion: undefined,
    historyBlobs: undefined,
    // Same for the chat image blob: the server-side DELETE removes it, so a
    // re-share must re-upload rather than trust a now-dangling pointer.
    imagesBlobUrl: undefined,
    imagesBlobSig: undefined,
  };
}

function setShareOn<R extends {
  accountShared?: boolean;
  accountSharedAt?: number;
  updatedAt?: number;
}>(row: R, now: number): R {
  return {
    ...row,
    accountShared: true,
    accountSharedAt: row.accountSharedAt ?? now,
    updatedAt: now,
  };
}

/**
 * Centralized last-write-wins guard shared by every adapter's `applyRemote`.
 * Returns true when the incoming remote row must NOT overwrite the local copy.
 *
 * Local is preserved when either:
 *   - it is strictly newer than remote (`localAt > remoteAt`), or
 *   - it carries unsynced local edits the server hasn't acknowledged yet
 *     (`updatedAt > lastSyncedAt`). `upsert` echoes the pushed `updatedAt`
 *     back and the client stamps it onto `lastSyncedAt`, so once a row is in
 *     sync the two are equal; `updatedAt > lastSyncedAt` therefore means
 *     "edited since our last confirmed push." A pull must never silently
 *     revert those edits - that's the "Save version then it reverts" bug -
 *     even when a stale tab or an older client re-pushed the old body with a
 *     fresher timestamp. The `onSave` hook pushes the local edit
 *     authoritatively; durable cross-client conflict resolution is a
 *     server-side concern handled separately.
 *
 * Clean rows (`updatedAt === lastSyncedAt`) still accept a newer remote, so
 * normal multi-device sync keeps working.
 *
 * `dirtyBeatsNewerRemote` controls whether the unsynced-edit clause beats a
 * STRICTLY NEWER remote. True (designers/chats/notes) keeps the original
 * intent — losing a local code/version edit is costly, and the reported revert
 * came from a stale tab re-pushing old content with a fresher timestamp. False
 * (apps) is required because an app's `updatedAt` bumps on every
 * `artifact.state.set`, widget resize, and Control Center toggle, so an
 * actively-used app is almost always "dirty"; keeping the broad clause made it
 * refuse EVERY newer remote forever — the "app sync stopped working" bug. Apps
 * fall back to pure timestamp last-write-wins (a same-timestamp tie still keeps
 * local edits).
 */
function localWinsOverRemote(
  local:
    | { updatedAt?: number; createdAt?: number; lastSyncedAt?: number }
    | undefined,
  remoteAt: number,
  dirtyBeatsNewerRemote = true
): boolean {
  if (!local) return false;
  const localAt = local.updatedAt ?? local.createdAt ?? 0;
  if (localAt > remoteAt) return true;
  const dirty = (local.updatedAt ?? 0) > (local.lastSyncedAt ?? 0);
  if (!dirty) return false;
  // Local has unsynced edits and the remote is newer-or-equal. Keep local
  // always for the protected entities; for apps keep it only on an exact tie
  // so a genuinely newer remote still syncs.
  return dirtyBeatsNewerRemote ? true : localAt === remoteAt;
}

const designerAdapter: Adapter<StoredDesigner, AccountDesignerPayload> = {
  loadLocal: (id) => getDesigner(id),
  putLocal: (row) => putDesigner(row),
  getAccountShared: (row) => !!row.accountShared,
  setShareFlags: (row, on, now) =>
    on ? setShareOn(row, now) : clearShareFlags(row, now),
  setLastSyncedAt: (row, ms) => ({ ...row, lastSyncedAt: ms }),
  // Hosts the only side effect in this adapter: blob uploads. We mutate
  // `row` to stamp the resulting URLs so the caller's subsequent
  // `setLastSyncedAt` putLocal also persists them — without that, the
  // local IDB row never learns its own blob pointers and `uploadDesignerBlobs`
  // re-uploads every commit on the next save.
  serializeForUpload: async (row) => {
    const result = await uploadDesignerBlobs(row);
    row.filesBlobUrl = result.filesBlobUrl;
    row.filesBlobVersion = result.filesBlobVersion;
    row.historyBlobs = result.historyBlobs;
    // Wire payload is the small ref shape: metadata + pointers, no heavy
    // bytes. Server reads files/history from the blobs we just uploaded.
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      manifest: row.manifest,
      status: row.status,
      version: row.version,
      notes: row.notes,
      notesUpdatedAt: row.notesUpdatedAt,
      sourceChatId: row.sourceChatId,
      sourceNoteId: row.sourceNoteId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      accountShared: row.accountShared,
      accountSharedAt: row.accountSharedAt,
      lastSyncedAt: row.lastSyncedAt,
      headCommitMessage: row.headCommitMessage,
      checkpointLabels: row.checkpointLabels,
      stateSnapshots: row.stateSnapshots,
      filesBlobUrl: result.filesBlobUrl,
      filesBlobVersion: result.filesBlobVersion,
      historyBlobs: result.historyBlobs,
    };
  },
  applyRemote: async (remote) => {
    const local = await getDesigner(remote.id);
    if (localWinsOverRemote(local, remote.updatedAt ?? 0)) return;

    // Hydrate `files` and `entry` for the IDB row. New ref-shaped remotes
    // point at a current.json blob; we fetch it. Legacy inline-shaped
    // remotes carry `files`/`entry` directly. If the blob fetch fails
    // (e.g. network), fall back to the local copy — better to keep the
    // old VFS than blank the iframe.
    let files = remote.files;
    let entry = remote.entry;
    if (remote.filesBlobUrl) {
      const current = await fetchDesignerCurrentBlob(remote.filesBlobUrl);
      if (current) {
        files = current.files;
        entry = current.entry;
      } else {
        files = local?.files ?? files;
        entry = local?.entry ?? entry;
      }
    }
    // First-time receivers with no local copy and an unfetchable blob
    // can't usefully apply this row — bail and let the next pull retry.
    if (!files || !entry) return;

    await putDesigner({
      ...remote,
      files,
      entry,
      // Cached build output is regenerable and not shared over the wire;
      // preserve any local copy so we don't pay to rebuild after a pull.
      lastBuild: local?.lastBuild,
      lastWidgetBuild: local?.lastWidgetBuild,
      // Server doesn't ship `history[]` inline (stripped to fit Upstash's
      // 1 MB value cap). Keep whatever the receiving device already has;
      // catchUpDesignerHistory fills in remaining versions from blob.
      history: local?.history,
      checkpointLabels: remote.checkpointLabels ?? local?.checkpointLabels,
      stateSnapshots: remote.stateSnapshots ?? local?.stateSnapshots,
      lastSyncedAt: remote.updatedAt,
    });
    // Don't await: the iframe should mount on the new code immediately;
    // history pages stream in afterwards so the version dropdown can fill
    // out without blocking the pull.
    void catchUpDesignerHistory(remote.id, remote.version);
    // Bookmarks sync their metadata (checkpointLabels / stateSnapshots)
    // eagerly inside the designer payload, but the snapshot each one points
    // at rides the lazy, newest-first history catch-up above — so an old
    // bookmark can show in the panel while its Restore still 404s for a
    // while. Pull those specific snapshots straight away (one targeted
    // request per bookmark) so Restore is ready by the time it's tapped.
    void prefetchBookmarkedCommits(
      remote.id,
      remote.checkpointLabels,
      remote.version
    );
  },
  idOf: (row) => row.id,
  remoteId: (remote) => remote.id,
  remoteUpdatedAt: (remote) => remote.updatedAt ?? 0,
};

// ---------- designer history catch-up ----------
//
// `listSince` returns designers without `history` inline (full-VFS edit
// log; pushes the payload over Upstash's per-value cap once it
// accumulates). This loop fetches the missing snapshots in pages of
// version pointers from /api/account/designer-history. New rows ship
// each version as a `{ version, blobUrl }` pointer the client downloads
// from the Vercel Blob CDN in parallel — bypassing the function response
// cap entirely. Legacy rows that haven't migrated yet still travel
// inline as `{ version, commit }`, which we apply as-is.

const HISTORY_PAGE_LIMIT = 10;
const HISTORY_BLOB_FETCH_CONCURRENCY = 8;
const inFlightHistoryCatchup = new Set<string>();

async function fetchHistoryPage(
  designerId: string,
  before: number,
  limit: number
): Promise<
  | { kind: "ok"; entries: DesignerHistoryPageEntry[]; nextBefore?: number }
  | { kind: "error" }
> {
  try {
    const res = await fetch(
      `/api/account/designer-history?id=${encodeURIComponent(designerId)}` +
        `&before=${before}&limit=${limit}`
    );
    if (!res.ok) return { kind: "error" };
    const page = (await res.json()) as {
      entries?: DesignerHistoryPageEntry[];
      commits?: DesignerCommit[];
      nextBefore?: number;
    };
    // Prefer the new `entries` shape (blob URL pointers + inline);
    // fall back to legacy `commits` (all inline) for back-compat with
    // older deploys.
    const entries: DesignerHistoryPageEntry[] = page.entries
      ? page.entries
      : (page.commits ?? []).map((c) => ({ version: c.version, commit: c }));
    return { kind: "ok", entries, nextBefore: page.nextBefore };
  } catch {
    return { kind: "error" };
  }
}

/**
 * Resolve a page of history entries into concrete DesignerCommits, fetching
 * blob URLs in parallel with a small concurrency cap so we don't open a
 * connection per commit at v500+.
 */
async function resolveHistoryEntries(
  entries: DesignerHistoryPageEntry[]
): Promise<DesignerCommit[]> {
  const out: DesignerCommit[] = [];
  for (let i = 0; i < entries.length; i += HISTORY_BLOB_FETCH_CONCURRENCY) {
    const batch = entries.slice(i, i + HISTORY_BLOB_FETCH_CONCURRENCY);
    const resolved = await Promise.all(
      batch.map(async (entry) => {
        if ("commit" in entry) return entry.commit;
        const commit = await fetchDesignerCommitBlob(entry.blobUrl);
        return commit;
      })
    );
    for (const c of resolved) if (c) out.push(c);
  }
  return out;
}

async function catchUpDesignerHistory(
  designerId: string,
  currentVersion: number
): Promise<void> {
  if (typeof window === "undefined") return;
  // Single in-flight loop per designer — a foreground pull and the
  // post-applyRemote background kick can race otherwise, double-fetching
  // every page.
  if (inFlightHistoryCatchup.has(designerId)) return;
  inFlightHistoryCatchup.add(designerId);
  try {
    let before = currentVersion;
    while (before > 0) {
      const local = await getDesigner(designerId);
      if (!local) return;
      const localVersions = new Set((local.history ?? []).map((h) => h.version));
      const lowestLocal =
        localVersions.size > 0
          ? Math.min(...Array.from(localVersions))
          : currentVersion;
      const fetchBefore = Math.min(before, lowestLocal);

      const page = await fetchHistoryPage(
        designerId,
        fetchBefore,
        HISTORY_PAGE_LIMIT
      );
      if (page.kind === "error") return;

      // Filter to versions we don't already have locally — saves blob
      // fetches on a re-entered loop.
      const missing = page.entries.filter((e) => !localVersions.has(e.version));
      const incoming =
        missing.length > 0 ? await resolveHistoryEntries(missing) : [];

      if (incoming.length === 0 && page.nextBefore == null) return;
      if (incoming.length > 0) {
        const merged = [...(local.history ?? []), ...incoming].sort(
          (a, b) => a.version - b.version
        );
        await putDesigner({ ...local, history: merged }).catch(() => {});
        emitPullCompleted({
          designers: [designerId],
          apps: [],
          chats: [],
          notes: [],
        });
      }
      if (page.nextBefore == null) return;
      before = page.nextBefore;
    }
  } finally {
    inFlightHistoryCatchup.delete(designerId);
  }
}

/**
 * Fetch a single history commit on demand when the local IDB copy is missing
 * it. Account-synced devices receive the designer row without inline
 * `history` (stripped to fit Upstash's per-value cap) and stream the edit log
 * in lazily via catchUpDesignerHistory — which can still be incomplete if a
 * pull is in flight or a page fetch failed. A bookmark Restore targets one
 * specific version, so rather than wait for the full catch-up we ask the
 * server for the page just above the target (newest-first ordering puts the
 * target first when it exists), persist the resolved commit into local
 * history so the next restore is instant, and return it.
 *
 * Returns null when the version can't be retrieved (sync not configured,
 * offline, or the version genuinely isn't on the server).
 */
export async function ensureDesignerHistoryCommit(
  designerId: string,
  version: number
): Promise<DesignerCommit | null> {
  if (typeof window === "undefined") return null;
  const local = await getDesigner(designerId);
  if (!local) return null;
  const existing = (local.history ?? []).find((h) => h.version === version);
  if (existing) return existing;

  const page = await fetchHistoryPage(designerId, version + 1, HISTORY_PAGE_LIMIT);
  if (page.kind === "error") return null;
  const wanted = page.entries.find((e) => e.version === version);
  if (!wanted) return null;
  const resolved = await resolveHistoryEntries([wanted]);
  const commit = resolved.find((c) => c.version === version) ?? null;
  if (!commit) return null;

  // Persist into local history so future restores (and the version dropdown)
  // don't re-fetch. Re-read first to merge with any concurrent catch-up write.
  const cur = await getDesigner(designerId);
  if (cur && !(cur.history ?? []).some((h) => h.version === version)) {
    const merged = [...(cur.history ?? []), commit].sort(
      (a, b) => a.version - b.version
    );
    await putDesigner({ ...cur, history: merged }).catch(() => {});
  }
  return commit;
}

/**
 * Warm the local history cache for every bookmarked version right after a
 * pull, so a Restore tapped seconds later finds its snapshot already in IDB
 * instead of erroring with "hasn't synced yet". Each call to
 * `ensureDesignerHistoryCommit` short-circuits when the commit is already
 * local, so this is cheap on repeat pulls. The head version is skipped — it's
 * never restorable (Restore no-ops on the current version) and isn't a prior
 * commit. Best-effort: failures are swallowed; the click-time on-demand fetch
 * remains the backstop.
 */
async function prefetchBookmarkedCommits(
  designerId: string,
  checkpointLabels: Record<string, string> | undefined,
  currentVersion: number
): Promise<void> {
  if (typeof window === "undefined" || !checkpointLabels) return;
  const versions = Object.keys(checkpointLabels)
    .map((k) => Number.parseInt(k, 10))
    .filter((v) => Number.isFinite(v) && v !== currentVersion);
  let fetchedAny = false;
  for (const v of versions) {
    const local = await getDesigner(designerId);
    if (!local) return;
    if ((local.history ?? []).some((h) => h.version === v)) continue;
    const commit = await ensureDesignerHistoryCommit(designerId, v).catch(
      () => null
    );
    if (commit) fetchedAny = true;
  }
  // Nudge the open designer view to re-read so the freshly-warmed versions
  // surface in the dropdown without waiting for the next poll.
  if (fetchedAny) {
    emitPullCompleted({
      designers: [designerId],
      apps: [],
      chats: [],
      notes: [],
    });
  }
}

const appAdapter: Adapter<StoredApp, StoredApp> = {
  loadLocal: (id) => getApp(id),
  putLocal: (row) => putApp(row),
  getAccountShared: (row) => !!row.accountShared,
  setShareFlags: (row, on, now) =>
    on ? setShareOn(row, now) : clearShareFlags(row, now),
  setLastSyncedAt: (row, ms) => ({ ...row, lastSyncedAt: ms }),
  serializeForUpload: async (row) => row,
  applyRemote: async (remote) => {
    const local = await getApp(remote.id);
    // Apps bump updatedAt on every state write/toggle, so the unsynced-edit
    // clause must NOT block a newer remote (else a dirty app never re-syncs).
    if (localWinsOverRemote(local, remote.updatedAt ?? 0, false)) return;
    await putApp({ ...remote, lastSyncedAt: remote.updatedAt });
  },
  idOf: (row) => row.id,
  remoteId: (remote) => remote.id,
  remoteUpdatedAt: (remote) => remote.updatedAt ?? 0,
};

// A shared chat's inline base64 images can push the sync bundle past Vercel's
// 4.5 MB POST cap, silently 413'ing the push. Above this size we offload the
// image bytes to Blob (see serializeForUpload). 3.5 MB leaves margin for the
// `{ type, payload }` wrapper, headers, and UTF-16→bytes slack.
const CHAT_INLINE_BUDGET_BYTES = 3.5 * 1024 * 1024;

const chatAdapter: Adapter<StoredChat, AccountChatBundle> = {
  loadLocal: (id) => getChat(id),
  putLocal: (row) => putChat(row),
  getAccountShared: (row) => !!row.accountShared,
  setShareFlags: (row, on, now) =>
    on ? setShareOn(row, now) : clearShareFlags(row, now),
  setLastSyncedAt: (row, ms) => ({ ...row, lastSyncedAt: ms }),
  // Hosts this adapter's only side effect: offloading image bytes to Blob when
  // the bundle is too big. We mutate `row` to stamp the resulting pointer so
  // the caller's follow-up setLastSyncedAt putLocal persists it (mirrors
  // designerAdapter) and the next push reuses the blob instead of re-uploading.
  serializeForUpload: async (row) => {
    const messages = await loadMessages(row.id);
    // Small chats keep images inline — unchanged behavior, no blob, no cost.
    if (JSON.stringify(messages).length <= CHAT_INLINE_BUDGET_BYTES) {
      return { chat: row, messages };
    }
    // Collect every image's dataUrl keyed by image id.
    const imageMap: Record<string, string> = {};
    for (const m of messages) {
      for (const im of m.images ?? []) {
        if (im.dataUrl) imageMap[im.id] = im.dataUrl;
      }
    }
    const ids = Object.keys(imageMap);
    // Oversized but not from images (huge text / proposedVfs): nothing to
    // offload, so ship inline and let the push fail loudly as before rather
    // than pretend we fixed it.
    if (ids.length === 0) return { chat: row, messages };

    // Images are immutable once attached, so the sorted id set is a stable
    // signature: an unchanged set means the already-uploaded blob is still
    // current and we can skip re-uploading its bytes.
    const sig = ids.slice().sort().join(",");
    let imagesBlobUrl = row.imagesBlobUrl;
    if (!imagesBlobUrl || row.imagesBlobSig !== sig) {
      imagesBlobUrl = await uploadChatImagesBlob(row.id, imageMap);
      row.imagesBlobUrl = imagesBlobUrl;
      row.imagesBlobSig = sig;
    }
    // Wire messages keep image metadata (id/mime/name/bytes) but drop the
    // heavy dataUrl bytes — the receiver rehydrates them from imagesBlobUrl.
    const wireMessages = messages.map((m) =>
      m.images && m.images.length > 0
        ? { ...m, images: m.images.map((im) => ({ ...im, dataUrl: "" })) }
        : m
    );
    return { chat: row, messages: wireMessages, imagesBlobUrl };
  },
  applyRemote: async (remote) => {
    const local = await getChat(remote.chat.id);
    if (localWinsOverRemote(local, remote.chat.updatedAt ?? 0)) return;

    // Rehydrate offloaded images: the wire carries `dataUrl: ""` plus an
    // imagesBlobUrl map. Fetch it once and refill each image's dataUrl by id.
    // Fall back to this device's local copy of the image (it may already have
    // the bytes) so a failed blob fetch doesn't blank a photo.
    let messages = remote.messages;
    if (remote.imagesBlobUrl) {
      const map = await fetchChatImagesBlob(remote.imagesBlobUrl);
      const localImagesByMsg = new Map<string, StoredMessage["images"]>();
      if (local) {
        for (const m of await loadMessages(remote.chat.id)) {
          if (m.images?.length) localImagesByMsg.set(m.id, m.images);
        }
      }
      messages = remote.messages.map((m) => {
        if (!m.images || m.images.length === 0) return m;
        const localImgs = localImagesByMsg.get(m.id) ?? [];
        return {
          ...m,
          images: m.images.map((im) => {
            if (im.dataUrl) return im;
            const fromBlob = map?.[im.id];
            const fromLocal = localImgs.find((li) => li.id === im.id)?.dataUrl;
            return { ...im, dataUrl: fromBlob ?? fromLocal ?? "" };
          }),
        };
      });
    }

    await putChat({ ...remote.chat, lastSyncedAt: remote.chat.updatedAt });
    for (const msg of messages) await putMessage(msg);
  },
  idOf: (row) => row.id,
  remoteId: (remote) => remote.chat.id,
  remoteUpdatedAt: (remote) => remote.chat.updatedAt ?? 0,
};

const noteAdapter: Adapter<StoredPinnedNote, StoredPinnedNote> = {
  loadLocal: (id) => getPinnedNote(id),
  putLocal: (row) => putPinnedNote(row),
  getAccountShared: (row) => !!row.accountShared,
  setShareFlags: (row, on, now) =>
    on ? setShareOn(row, now) : clearShareFlags(row, now),
  setLastSyncedAt: (row, ms) => ({ ...row, lastSyncedAt: ms }),
  serializeForUpload: async (row) => row,
  applyRemote: async (remote) => {
    const local = await getPinnedNote(remote.id);
    const remoteAt = remote.updatedAt ?? remote.createdAt;
    if (localWinsOverRemote(local, remoteAt)) return;
    await putPinnedNote({ ...remote, lastSyncedAt: remoteAt });
  },
  idOf: (row) => row.id,
  remoteId: (remote) => remote.id,
  remoteUpdatedAt: (remote) => remote.updatedAt ?? remote.createdAt,
};

const ADAPTERS = {
  designer: designerAdapter,
  app: appAdapter,
  chat: chatAdapter,
  note: noteAdapter,
} as const;

function adapterFor<T extends EntityType>(type: T): AdapterFor<T> {
  return ADAPTERS[type] as unknown as AdapterFor<T>;
}

// ---------- watermark for incremental pulls ----------

const WATERMARK_KEY = "artifacts.account.lastSyncedAt";

function readWatermark(): number {
  if (typeof window === "undefined") return 0;
  try {
    const v = window.localStorage.getItem(WATERMARK_KEY);
    if (!v) return 0;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeWatermark(ms: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WATERMARK_KEY, String(ms));
  } catch {
    // localStorage may be disabled (private browsing); next pull resends
    // since=0 which is correct, just bigger.
  }
}

// ---------- HTTP helpers (single endpoint) ----------

async function postUpsert(
  type: EntityType,
  payload: unknown
): Promise<number | null> {
  try {
    const res = await fetch("/api/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });
    if (!res.ok) {
      console.warn("[account-sync] push failed", type, res.status);
      return null;
    }
    const data = (await res.json().catch(() => ({}))) as { updatedAt?: number };
    return typeof data.updatedAt === "number" ? data.updatedAt : null;
  } catch (err) {
    console.warn("[account-sync] push error", type, err);
    return null;
  }
}

async function deleteRemote(type: EntityType, id: string): Promise<void> {
  try {
    await fetch(
      `/api/account?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  } catch (err) {
    console.warn("[account-sync] delete error", type, id, err);
  }
}

// ---------- echo suppression ----------
//
// Every successful push is followed by a `lastSyncedAt`-stamp write that goes
// through put*, which re-enters the same `onSave` hook. Without a guard, the
// stamp's hook fire sees `accountShared: true` and pushes again — forever.
// `applyRemote` (incremental pull) has the same shape: it writes the remote
// row through put*, which would echo right back to the server.
//
// `updatedAt` only changes on a real user edit (every call site sets
// `updatedAt: Date.now()`), so remembering the last `updatedAt` we either
// pushed or pulled lets us cheaply tell "this hook fire is just our own
// stamp / pull echo" from "this is a new edit".

const lastSyncedRowUpdatedAt = new Map<string, number>();

function rowKey(type: EntityType, id: string): string {
  return `${type}:${id}`;
}

function rememberSynced(type: EntityType, id: string, updatedAt: number): void {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return;
  lastSyncedRowUpdatedAt.set(rowKey(type, id), updatedAt);
}

// ---------- toggle ----------

/**
 * Single toggle handler used by every UI surface. Adapter-driven, so no
 * branching on type lives here.
 */
export async function setAccountShared(
  type: EntityType,
  id: string,
  on: boolean
): Promise<void> {
  // The adapter map is indexed correctly at runtime; TS can't narrow the
  // discriminated union from a string key, so we type-erase. Mismatches
  // are impossible here — the table is exhaustive by EntityType.
  const adapter = adapterFor(type) as unknown as Adapter<unknown, unknown>;
  const existing = await adapter.loadLocal(id);
  if (!existing) return;
  const now = Date.now();

  if (on) {
    const next = adapter.setShareFlags(existing, true, now);
    await adapter.putLocal(next);
    // The local flag is now set. The server push may fail (e.g. blob
    // upload error after unsync/resync) — catch so the toggle sticks
    // locally and the onSave hook retries on the next edit.
    try {
      const wire = await adapter.serializeForUpload(next);
      const updatedAt = await postUpsert(type, wire);
      if (updatedAt) {
        // Remember BEFORE the stamp write so its hook fire short-circuits
        // instead of triggering another push.
        rememberSynced(type, id, (next as { updatedAt?: number }).updatedAt ?? 0);
        await adapter.putLocal(adapter.setLastSyncedAt(next, updatedAt));
      }
    } catch (err) {
      console.warn("[account-sync] initial push after toggle-on failed; will retry on next save", type, id, err);
    }
    // App-only: also kick the central schedule registration. Without this,
    // the cron sweep won't pick the app up until the iframe reloads.
    if (type === "app") {
      const designer = await getDesigner(id);
      const schedule = designer?.manifest?.schedule;
      if (schedule) {
        try {
          await fetch("/api/schedules/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ appId: id, schedule, origin: "manifest" }),
          });
        } catch {
          // Iframe mount will retry.
        }
      }
    }
  } else {
    await deleteRemote(type, id);
    await adapter.putLocal(adapter.setShareFlags(existing, false, now));
  }
}

/**
 * Designers and apps pair 1:1. Toggling either turns both on or off so the
 * receiving device always gets a runnable artifact.
 */
export async function setDesignerAppPairAccountShared(
  id: string,
  on: boolean
): Promise<void> {
  await setAccountShared("designer", id, on);
  await setAccountShared("app", id, on);
}

// Thin per-type wrappers preserved so call sites read naturally and so
// future ergonomic changes (e.g. confirm dialogs on toggle-off) have a
// dedicated seam.
export const setChatAccountShared = (id: string, on: boolean) =>
  setAccountShared("chat", id, on);
export const setNoteAccountShared = (id: string, on: boolean) =>
  setAccountShared("note", id, on);

// ---------- pull ----------

/**
 * Fetch every account-shared entity changed since the watermark, then defer
 * to each adapter's applyRemote for last-write-wins merge.
 */
export async function pullAccountState(): Promise<number> {
  if (typeof window === "undefined") return 0;
  const since = readWatermark();
  let bundle: AccountStateBundle;
  try {
    const res = await fetch(`/api/account?since=${since}`);
    if (!res.ok) {
      // 503 (not configured) is a normal no-op; 401 happens on /login pages
      // before the user signs in. Don't spam the console for either.
      if (res.status !== 503 && res.status !== 401) {
        console.warn("[account-sync] pull failed", res.status);
      }
      return since;
    }
    bundle = (await res.json()) as AccountStateBundle;
  } catch (err) {
    console.warn("[account-sync] pull error", err);
    return since;
  }

  // Remember each pulled version BEFORE applying — applyRemote writes the
  // row through put*, which fires onSave; without this, every pulled row
  // would immediately echo back to the server.
  for (const r of bundle.designers) rememberSynced("designer", r.id, r.updatedAt ?? 0);
  for (const r of bundle.apps) rememberSynced("app", r.id, r.updatedAt ?? 0);
  for (const r of bundle.chats)
    rememberSynced("chat", r.chat.id, r.chat.updatedAt ?? 0);
  for (const r of bundle.notes)
    rememberSynced("note", r.id, r.updatedAt ?? r.createdAt ?? 0);

  await Promise.all([
    ...bundle.designers.map((r) => designerAdapter.applyRemote(r)),
    ...bundle.apps.map((r) => appAdapter.applyRemote(r)),
    ...bundle.chats.map((r) => chatAdapter.applyRemote(r)),
    ...bundle.notes.map((r) => noteAdapter.applyRemote(r)),
  ]);

  writeWatermark(bundle.serverNow);
  emitPullCompleted({
    designers: bundle.designers.map((r) => r.id),
    apps: bundle.apps.map((r) => r.id),
    chats: bundle.chats.map((r) => r.chat.id),
    notes: bundle.notes.map((r) => r.id),
  });
  return bundle.serverNow;
}

// ---------- pull-completed subscribers ----------
//
// Pages that read from IDB on mount stay stale forever unless something tells
// them a pull just merged new rows. Subscribers fire once per pull with the
// ids that changed; an empty pull still fires (with empty arrays) so callers
// that want to react to "we just checked, you're up to date" can.

export type AccountSyncPullEvent = {
  designers: string[];
  apps: string[];
  chats: string[];
  notes: string[];
};

const pullListeners = new Set<(ev: AccountSyncPullEvent) => void>();

export function subscribeAccountSyncPull(
  listener: (ev: AccountSyncPullEvent) => void
): () => void {
  pullListeners.add(listener);
  return () => {
    pullListeners.delete(listener);
  };
}

function emitPullCompleted(ev: AccountSyncPullEvent): void {
  for (const fn of pullListeners) {
    try {
      fn(ev);
    } catch (err) {
      console.warn("[account-sync] pull listener threw", err);
    }
  }
}

// ---------- save / delete hook (registered into db.ts) ----------

function onSave(entity: AccountSyncEntity): void {
  // Same type-erasure trick — the table is exhaustive over AccountSyncEntity.
  const adapter = adapterFor(entity.type) as unknown as Adapter<
    unknown,
    unknown
  >;
  // The hook fires on every put*, but we only push rows the user opted in.
  if (!adapter.getAccountShared(entity.row)) return;
  const id = adapter.idOf(entity.row);
  const rowUpdatedAt = (entity.row as { updatedAt?: number }).updatedAt ?? 0;
  // Echo guard — see the lastSyncedRowUpdatedAt comment above.
  if (
    rowUpdatedAt > 0 &&
    lastSyncedRowUpdatedAt.get(rowKey(entity.type, id)) === rowUpdatedAt
  ) {
    return;
  }
  void (async () => {
    try {
      const wire = await adapter.serializeForUpload(entity.row);
      const updatedAt = await postUpsert(entity.type, wire);
      if (updatedAt) {
        // Remember BEFORE the stamp write so its hook fire short-circuits.
        rememberSynced(entity.type, id, rowUpdatedAt);
        // Re-read from IDB instead of using the stale entity.row — a newer
        // edit may have landed while the push was in flight (blob upload is
        // slow). Writing entity.row back would overwrite the newer version.
        // Spread entity.row underneath so sync-only metadata stamped by
        // serializeForUpload (e.g. blob pointers) is preserved when the
        // fresh row doesn't carry them yet.
        const fresh = await adapter.loadLocal(id);
        if (fresh) {
          const merged = Object.assign({}, entity.row, fresh);
          const stamped = adapter.setLastSyncedAt(merged, updatedAt);
          await adapter.putLocal(stamped).catch(() => {});
        }
      }
    } catch (err) {
      // Blob upload failures (network blip, BLOB_READ_WRITE_TOKEN absent
      // locally, etc.) land here. Logged but not surfaced: the next save
      // retries. A persistent failure keeps the local IDB authoritative,
      // matching the pre-blob behavior where push errors were also silent.
      console.warn("[account-sync] save hook push failed", entity.type, id, err);
    }
  })();
}

function onDelete(type: EntityType, id: string): void {
  // Best-effort. We don't gate on the row's accountShared because the
  // local row is already gone — just fire DELETE and let the server no-op
  // if it never had a copy.
  void deleteRemote(type, id);
}

// ---------- message-save → chat re-push ----------
//
// A chat is pushed as a bundle (chat row + all its messages), and the only
// hook fire is from putChat. So writing new messages alone leaves the
// server's copy stale forever — fine for unshared chats, broken for shared
// ones. We catch every putMessage here, debounce per chat, and on flush
// bump chat.updatedAt + putChat so the normal push path picks it up. The
// debounce is what keeps streaming-rate writes from each spawning a push.

const MESSAGE_TOUCH_DEBOUNCE_MS = 1500;
const pendingChatTouchTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function flushChatTouch(chatId: string): Promise<void> {
  const chat = await getChat(chatId);
  if (!chat) return;
  if (!chat.accountShared) return;
  // Derive updatedAt from the newest message's createdAt rather than
  // Date.now(). The chats list sorts and labels by updatedAt, so stamping
  // it to "now" on every message write bubbled every account-shared chat
  // to the top and made each one read "seconds ago" — including ones the
  // user hadn't touched, because applyRemote's putMessage loop on a pull
  // schedules a touch on the receiving device too. Using the message's own
  // timestamp still bumps updatedAt for a real new message (passing the
  // receiver's last-write-wins guard) but produces no change on the pure
  // mirror path, since the receiver's chat row was just set to that same
  // updatedAt by applyRemote.
  // Factor in `editedAt` as well as `createdAt`: an in-place edit (e.g. a
  // canvas "Save version" rewriting the source artifact message) adds no new
  // row, so a createdAt-only max would never move and the edit would never
  // reach the server - then the next pull reverts it. editedAt bumps the
  // chat exactly for those in-place edits while still no-op'ing on the pure
  // mirror path (applyRemote writes the same editedAt the sender computed,
  // so the receiver's max matches its just-set updatedAt).
  const messages = await loadMessages(chatId);
  let maxActivityAt = chat.updatedAt ?? 0;
  for (const m of messages) {
    if (m.createdAt > maxActivityAt) maxActivityAt = m.createdAt;
    if (m.editedAt && m.editedAt > maxActivityAt) maxActivityAt = m.editedAt;
  }
  if (maxActivityAt === (chat.updatedAt ?? 0)) return;
  const next: StoredChat = { ...chat, updatedAt: maxActivityAt };
  await putChat(next);
}

function scheduleChatTouch(chatId: string): void {
  const existing = pendingChatTouchTimers.get(chatId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    pendingChatTouchTimers.delete(chatId);
    void flushChatTouch(chatId);
  }, MESSAGE_TOUCH_DEBOUNCE_MS);
  pendingChatTouchTimers.set(chatId, t);
}

function flushAllPendingChatTouches(): void {
  if (pendingChatTouchTimers.size === 0) return;
  const ids = Array.from(pendingChatTouchTimers.keys());
  for (const [, timer] of pendingChatTouchTimers) clearTimeout(timer);
  pendingChatTouchTimers.clear();
  for (const id of ids) void flushChatTouch(id);
}

function onMessageSave(chatId: string): void {
  if (!chatId) return;
  scheduleChatTouch(chatId);
}

// ---------- one-shot gap reconcile ----------
//
// The onMessageSave hook only catches putMessage calls that happen after
// startAccountSync has wired the hook. Anything written before that — most
// importantly, every message added during the window between the bug
// shipping and this fix landing — sits in IDB with no event to drive a
// push. Walk every account-shared chat once at startup, compare its
// messages' createdAt against chat.lastSyncedAt (server-stamped after each
// successful push), and schedule a touch for any chat whose bundle is
// newer than what the server has. False positives just cost one redundant
// push; missing a real gap leaves the user's devices out of sync forever.

async function reconcileSharedChatGap(): Promise<void> {
  const chats = await listChats().catch(() => [] as StoredChat[]);
  for (const chat of chats) {
    if (!chat.accountShared) continue;
    const messages = await loadMessages(chat.id).catch(() => [] as StoredMessage[]);
    if (messages.length === 0) continue;
    const lastSyncedAt = chat.lastSyncedAt ?? 0;
    let maxActivityAt = 0;
    for (const m of messages) {
      if (m.createdAt > maxActivityAt) maxActivityAt = m.createdAt;
      if (m.editedAt && m.editedAt > maxActivityAt) maxActivityAt = m.editedAt;
    }
    if (maxActivityAt > lastSyncedAt) {
      scheduleChatTouch(chat.id);
    }
  }
}

// ---------- heal chats that never landed on the server ----------
//
// reconcileSharedChatGap schedules a touch, but flushChatTouch only re-pushes
// when the newest message is NEWER than chat.updatedAt — so a shared chat that
// 413'd on its very first push (an oversized image chat, before the Blob
// offload existed) is never retried: its updatedAt already covers its
// messages, so the touch no-ops and lastSyncedAt stays 0 forever. Walk the
// shared chats once at startup and force one push for any whose lastSyncedAt
// lags its activity. serializeForUpload now offloads images to Blob, so the
// previously-too-big push succeeds. Idempotent: after success lastSyncedAt
// catches up to the activity time and the chat is skipped next run.
async function healUnsyncedSharedChats(): Promise<void> {
  const chats = await listChats().catch(() => [] as StoredChat[]);
  for (const chat of chats) {
    if (!chat.accountShared) continue;
    const messages = await loadMessages(chat.id).catch(
      () => [] as StoredMessage[]
    );
    if (messages.length === 0) continue;
    let maxActivityAt = chat.updatedAt ?? 0;
    for (const m of messages) {
      if (m.createdAt > maxActivityAt) maxActivityAt = m.createdAt;
      if (m.editedAt && m.editedAt > maxActivityAt) maxActivityAt = m.editedAt;
    }
    if ((chat.lastSyncedAt ?? 0) >= maxActivityAt) continue;
    // Keep updatedAt in step with activity so lastSyncedAt (server-stamped to
    // the pushed updatedAt) fully covers it and this doesn't re-fire forever.
    const rowToPush: StoredChat =
      maxActivityAt > (chat.updatedAt ?? 0)
        ? { ...chat, updatedAt: maxActivityAt }
        : chat;
    try {
      const wire = await chatAdapter.serializeForUpload(rowToPush);
      const updatedAt = await postUpsert("chat", wire);
      if (updatedAt) {
        rememberSynced("chat", chat.id, rowToPush.updatedAt ?? 0);
        // rowToPush was mutated with imagesBlobUrl/sig by serializeForUpload;
        // persist that alongside lastSyncedAt so the next push skips re-upload.
        await putChat(chatAdapter.setLastSyncedAt(rowToPush, updatedAt)).catch(
          () => {}
        );
      }
    } catch (err) {
      console.warn("[account-sync] heal push failed", chat.id, err);
    }
  }
}

// ---------- one-time chat timestamp repair ----------
//
// Two compounding bugs poisoned chat.updatedAt: (a) flushChatTouch
// stamped Date.now() on every applyRemote-driven message write, and
// (b) the server's upsert overwrote the row's updatedAt with its own
// Date.now() — so even a correctly-set client value got rewritten on
// every push and echoed back as "just now" on the next pull. With both
// fixed, walk every account-shared chat once per device and pull
// updatedAt back to the highest legitimate activity timestamp
// (createdAt, titleUpdatedAt, accountSharedAt, newest message
// createdAt). putChat fires the normal push hook, so the corrected
// value now actually sticks on the server.
//
// The flag version is bumped to v2 so devices that already ran the
// futile v1 pass (back when the server clobbered our writes) repair
// again against the fixed server.

const TIMESTAMP_REPAIR_FLAG = "artifacts.chat.timestampRepair.v2";

function isTimestampRepairDone(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(TIMESTAMP_REPAIR_FLAG) != null;
  } catch {
    return true;
  }
}

function markTimestampRepairDone(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TIMESTAMP_REPAIR_FLAG, String(Date.now()));
  } catch {
    // Re-running the repair is safe — it's a no-op once timestamps are
    // already at their correct values.
  }
}

async function repairChatTimestamps(): Promise<void> {
  if (isTimestampRepairDone()) return;
  try {
    const chats = await listChats().catch(() => [] as StoredChat[]);
    for (const chat of chats) {
      if (!chat.accountShared) continue;
      const messages = await loadMessages(chat.id).catch(
        () => [] as StoredMessage[]
      );
      let maxMessageActivityAt = 0;
      for (const m of messages) {
        if (m.createdAt > maxMessageActivityAt) maxMessageActivityAt = m.createdAt;
        if (m.editedAt && m.editedAt > maxMessageActivityAt)
          maxMessageActivityAt = m.editedAt;
      }
      // Every candidate here is a real, user-visible event. lastViewedAt is
      // deliberately excluded — opening a chat must not bump its "X ago".
      const correct = Math.max(
        chat.createdAt,
        chat.titleUpdatedAt ?? 0,
        chat.accountSharedAt ?? 0,
        maxMessageActivityAt
      );
      if (correct > 0 && correct < chat.updatedAt) {
        await putChat({ ...chat, updatedAt: correct }).catch(() => {});
      }
    }
  } finally {
    markTimestampRepairDone();
  }
}

// ---------- periodic refresh ----------

const PULL_INTERVAL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let hookRegistered = false;

function ensureHook(): void {
  if (hookRegistered) return;
  hookRegistered = true;
  registerAccountSyncHook({ onSave, onDelete, onMessageSave });
}

/**
 * Kick off a single pull immediately, then keep pulling every 60s while the
 * tab is in the foreground. Idempotent — safe to call from multiple mounts.
 */
export function startAccountSync(): () => void {
  if (typeof window === "undefined") return () => {};
  ensureHook();
  if (timer != null) return () => {};
  // Initial pull first, then sweep for shared chats whose local messages
  // are ahead of the server (the "gap" left by every putMessage that
  // happened before this hook existed). Reconcile after pull so we don't
  // push stale local copies of chats the server already has newer
  // versions of.
  void pullAccountState()
    .then(() => reconcileSharedChatGap())
    .then(() => healUnsyncedSharedChats())
    .then(() => repairChatTimestamps());
  timer = setInterval(() => {
    if (document.visibilityState === "visible") void pullAccountState();
  }, PULL_INTERVAL_MS);
  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      void pullAccountState();
    } else {
      // The tab is going away; don't wait out the message-touch debounce or
      // the chat-bundle push could be lost if the user never comes back.
      flushAllPendingChatTouches();
    }
  };
  const onPageHide = () => flushAllPendingChatTouches();
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  return () => {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
  };
}
