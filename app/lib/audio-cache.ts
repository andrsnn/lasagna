"use client";

// Stores OpenAI TTS MP3 blobs keyed by (voice, text) so the same message
// doesn't roundtrip to OpenAI on every Speak. Lives in its own IndexedDB
// rather than the main "ollama-chat" one so we don't churn that DB's
// version + migrations + account-sync chain for an unrelated, regenerable
// blob store. Browsers evict IDB under quota pressure on their own; we
// still apply a soft TTL + total-bytes cap so the cache doesn't drift to
// hundreds of megabytes of one-off readings.

const DB_NAME = "ollama-audio-cache";
const DB_VERSION = 1;
const STORE = "audio";

const TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

type Entry = {
  key: string;
  blob: Blob;
  voice: string;
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
        const s = db.createObjectStore(STORE, { keyPath: "key" });
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
    req.onerror = () => reject(req.error ?? new Error("audio cache open failed"));
  });
  return dbPromise;
}

// SHA-256 of "voice|text" — bounded length, content-addressed, collision-safe
// enough for a local cache. Falls back to a plain hash if SubtleCrypto is
// unavailable (rare in modern browsers but cheap to guard).
async function hashKey(voice: string, text: string): Promise<string> {
  const raw = `${voice}|${text}`;
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const bytes = new TextEncoder().encode(raw);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const arr = Array.from(new Uint8Array(digest));
    return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0;
  return `f_${(h >>> 0).toString(16)}_${raw.length}`;
}

export async function getCachedAudio(
  voice: string,
  text: string
): Promise<Blob | null> {
  try {
    const db = await openDB();
    const key = await hashKey(voice, text);
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
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

export async function putCachedAudio(
  voice: string,
  text: string,
  blob: Blob
): Promise<void> {
  try {
    const db = await openDB();
    const key = await hashKey(voice, text);
    const now = Date.now();
    const entry: Entry = {
      key,
      blob,
      voice,
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
    // Best-effort prune; never let it block playback path.
    void prune();
  } catch {
    // Cache failures are non-fatal — playback already happened from the network.
  }
}

// Walks the store once, drops expired rows, then evicts oldest until we're
// back under MAX_BYTES. Cheap because rows are small (one mp3 per row) and
// the store is local; called fire-and-forget after writes.
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
    const toEvict: string[] = expired.map((r) => r.key);
    while (total > MAX_BYTES && live.length) {
      const oldest = live.shift()!;
      toEvict.push(oldest.key);
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

export async function clearAudioCache(): Promise<void> {
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
