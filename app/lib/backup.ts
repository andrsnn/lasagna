// Local IndexedDB backup / restore. No network — produces and consumes a
// .json.gz file the user keeps wherever they want (Drive, Dropbox, USB, …).
//
// Format invariants:
//   - magic field `format: "ollama-chat-backup"` distinguishes our blobs from
//     other gzipped JSON files the user might pick by mistake
//   - `formatVersion` is the bundle shape (bumped only if we change top-level
//     keys); `dbVersion` is the IDB schema the snapshot was taken against —
//     restoring an older dbVersion into a newer DB is allowed (read-time
//     migrations in db.ts handle row shape), restoring a NEWER bundle into an
//     older DB is refused.

import {
  BACKUP_DB_NAME,
  BACKUP_DB_VERSION,
  bulkRestore,
  exportAllStores,
  type BackupStores,
  type RestoreSummary,
} from "@/app/db";

export const BACKUP_FORMAT = "ollama-chat-backup" as const;
export const BACKUP_FORMAT_VERSION = 1 as const;

export type BackupBundle = {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  dbName: string;
  dbVersion: number;
  exportedAt: number;
  stores: BackupStores;
};

/** Snapshot the live IDB into a serializable bundle. */
export async function exportBundle(): Promise<BackupBundle> {
  const stores = await exportAllStores();
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    dbName: BACKUP_DB_NAME,
    dbVersion: BACKUP_DB_VERSION,
    exportedAt: Date.now(),
    stores,
  };
}

/** Stringify + gzip via the platform's CompressionStream — no JSZip dep. */
export async function serializeBundle(bundle: BackupBundle): Promise<Blob> {
  const json = JSON.stringify(bundle);
  const bytes = new TextEncoder().encode(json);
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  const compressed = await new Response(stream).blob();
  return new Blob([compressed], { type: "application/gzip" });
}

/** Inverse of serializeBundle. Throws if the file isn't one of our backups. */
export async function parseBundleFile(file: File): Promise<BackupBundle> {
  // We accept either gzipped or plain JSON — power users sometimes unzip first.
  const looksGzip =
    file.name.endsWith(".gz") || file.type === "application/gzip" || file.type === "application/x-gzip";

  let text: string;
  if (looksGzip) {
    const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
    text = await new Response(stream).text();
  } else {
    text = await file.text();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Not a valid backup file (JSON parse failed).");
  }
  return assertBundle(parsed);
}

function assertBundle(value: unknown): BackupBundle {
  if (!value || typeof value !== "object") {
    throw new Error("Not a valid backup file (empty or non-object payload).");
  }
  const v = value as Partial<BackupBundle>;
  if (v.format !== BACKUP_FORMAT) {
    throw new Error("Not an ollama-chat backup (missing format marker).");
  }
  if (v.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Backup format version ${String(v.formatVersion)} not supported by this app (expected ${BACKUP_FORMAT_VERSION}).`
    );
  }
  if (typeof v.dbVersion !== "number") {
    throw new Error("Backup file missing dbVersion.");
  }
  if (v.dbVersion > BACKUP_DB_VERSION) {
    throw new Error(
      `Backup is from a newer schema (v${v.dbVersion}) than this app supports (v${BACKUP_DB_VERSION}). Update the app and try again.`
    );
  }
  if (!v.stores || typeof v.stores !== "object") {
    throw new Error("Backup file missing stores section.");
  }
  const s = v.stores as Partial<BackupStores>;
  for (const key of ["messages", "chats", "designers", "apps", "archivedApps"] as const) {
    if (!Array.isArray(s[key])) {
      throw new Error(`Backup file missing ${key} array.`);
    }
  }
  // pinnedNotes was added in dbVersion 8. Older backups won't have it —
  // default to an empty array so the bundle type stays well-formed.
  if (!Array.isArray(s.pinnedNotes)) {
    s.pinnedNotes = [];
  }
  return value as BackupBundle;
}

/** Build a filename like artifacts-backup-20260510-143015.json.gz. */
export function backupFilename(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `artifacts-backup-${stamp}.json.gz`;
}

export type DownloadResult = {
  filename: string;
  bytes: number;
  exportedAt: number;
};

/** Snapshot, gzip, trigger a save dialog. Returns metadata for the UI caption. */
export async function downloadBackup(): Promise<DownloadResult> {
  const bundle = await exportBundle();
  const blob = await serializeBundle(bundle);
  const filename = backupFilename(new Date(bundle.exportedAt));
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke after the click; some browsers need a tick.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return { filename, bytes: blob.size, exportedAt: bundle.exportedAt };
}

/** Total row count across all keyed stores — for the confirm-dialog summary. */
export function bundleRowCount(bundle: BackupBundle): number {
  const s = bundle.stores;
  return (
    s.messages.length +
    s.chats.length +
    s.designers.length +
    s.apps.length +
    s.archivedApps.length +
    (s.pinnedNotes?.length ?? 0)
  );
}

export async function restoreBackup(
  bundle: BackupBundle,
  mode: "replace" | "merge"
): Promise<RestoreSummary> {
  return bulkRestore(bundle.stores, mode);
}

export type { RestoreSummary } from "@/app/db";
