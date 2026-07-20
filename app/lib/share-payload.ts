// Pure payload-shaping for share links. Lives in its own file so the
// share dialog (browser) can import it without dragging the Redis client
// (server-only) into the bundle via share-store.ts.

import type {
  ArtifactFiles,
  ArtifactManifest,
  StoredApp,
  StoredDesigner,
} from "@/app/db";

/**
 * Allow-listed fields that travel over the wire for an app share. Adding
 * a new field to the IndexedDB schema does NOT auto-share it — opt in
 * here. Prevents accidental leakage of e.g. private notes or cached
 * build output.
 */
export type SharedDesigner = {
  name: string;
  description?: string;
  files: ArtifactFiles;
  entry: string;
  manifest: ArtifactManifest | null;
  version: number;
};

export type SharedApp = {
  name: string;
  params: Record<string, unknown>;
  model?: string;
  /** Only present if the owner ticked "Include app data" in the share dialog. */
  state?: Record<string, unknown>;
};

export type SharedAppPayload = {
  designer: SharedDesigner;
  app: SharedApp;
  summary: string;
  createdAt: number;
  expiresAt: number;
};

export function serializeForShare(
  designer: StoredDesigner,
  app: StoredApp,
  includeState: boolean
): { designer: SharedDesigner; app: SharedApp } {
  return {
    designer: {
      name: designer.name,
      description: designer.description,
      files: designer.files,
      entry: designer.entry,
      manifest: designer.manifest,
      version: designer.version,
    },
    app: {
      name: app.name,
      params: app.params ?? {},
      model: app.model,
      ...(includeState ? { state: app.state ?? {} } : {}),
    },
  };
}

export const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** 22 URL-safe base64 chars from 16 random bytes. */
export const SHARE_TOKEN_REGEX = /^[A-Za-z0-9_-]{22}$/;

function base64urlFromBytes(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 22 URL-safe base64 chars (~128 bits of entropy from 16 random bytes). */
export function newShareToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64urlFromBytes(bytes);
}
