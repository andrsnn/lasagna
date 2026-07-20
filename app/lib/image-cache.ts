"use client";

// Persists successfully-downloaded image bytes in IndexedDB keyed by URL so a
// proxied image (`/api/img`) that loads once keeps rendering for the life of
// the conversation (and beyond - IDB survives reloads) even if the upstream
// CDN or our edge cache later flakes. That flake is the motivating bug: a
// proxied <img> paints fine, then a re-request (scroll, re-decode, cache
// eviction) hits a transient upstream 404/timeout and the image "randomly
// breaks". Once we hold the bytes locally we serve them from a blob URL, which
// can never break.
//
// Lives in its own IndexedDB rather than the main "ollama-chat" one so we don't
// churn that DB's version + migration + account-sync chain for an unrelated,
// regenerable blob store. Browsers evict IDB under quota pressure on their own;
// we still apply a soft TTL + total-bytes cap so the cache doesn't drift to
// hundreds of megabytes. Mirrors app/lib/audio-cache.ts.

const DB_NAME = "ollama-image-cache";
const DB_VERSION = 1;
const STORE = "images";

const TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_BYTES = 200 * 1024 * 1024; // 200 MB total
const MAX_ENTRY_BYTES = 12 * 1024 * 1024; // skip caching a single huge image

type Entry = {
  url: string;
  blob: Blob;
  type: string;
  bytes: number;
  createdAt: number;
  expiresAt: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "url" });
        s.createIndex("createdAt", "createdAt");
        s.createIndex("expiresAt", "expiresAt");
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        try {
          db.close();
        } catch {}
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("image cache open failed"));
  });
  return dbPromise;
}

export async function getCachedImage(url: string): Promise<Blob | null> {
  try {
    const db = await openDB();
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(url);
      req.onsuccess = () => {
        const row = req.result as Entry | undefined;
        if (!row) return resolve(null);
        if (row.expiresAt && row.expiresAt < Date.now()) return resolve(null);
        resolve(row.blob);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function putCachedImage(url: string, blob: Blob): Promise<void> {
  if (!blob.size || blob.size > MAX_ENTRY_BYTES) return;
  try {
    const db = await openDB();
    const now = Date.now();
    const entry: Entry = {
      url,
      blob,
      type: blob.type,
      bytes: blob.size,
      createdAt: now,
      expiresAt: now + TTL_MS,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    // Best-effort prune; never let it block the render path.
    void prune();
  } catch {
    // Cache failures are non-fatal - the image already loaded from the network.
  }
}

// Walks the store once, drops expired rows, then evicts oldest until we're back
// under MAX_BYTES. Called fire-and-forget after writes.
async function prune(): Promise<void> {
  try {
    const db = await openDB();
    const rows: Entry[] = await new Promise((resolve, reject) => {
      const out: Entry[] = [];
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve(out);
        out.push(cur.value as Entry);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });

    const now = Date.now();
    const expired = rows.filter((r) => r.expiresAt && r.expiresAt < now);
    const live = rows.filter((r) => !(r.expiresAt && r.expiresAt < now));
    live.sort((a, b) => a.createdAt - b.createdAt);

    let total = live.reduce((n, r) => n + (r.bytes || 0), 0);
    const toEvict: string[] = expired.map((r) => r.url);
    while (total > MAX_BYTES && live.length) {
      const oldest = live.shift()!;
      toEvict.push(oldest.url);
      total -= oldest.bytes || 0;
    }
    if (!toEvict.length) return;

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const k of toEvict) store.delete(k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {}
}

export async function clearImageCache(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {}
}
