// GET /api/admin/account-sync/chat?email=<email>&id=<chatId>
//
// Full-fidelity dump of ONE account-shared chat bundle for debugging.
// Where /api/admin/account-sync returns a per-chat summary row, this
// returns the entire stored bundle (chat row + every message) plus a
// computed size breakdown so you can spot the message that's blowing up
// a device. The common failure mode this exists to catch: an image-heavy
// chat whose inline base64 `dataUrl`s push the bundle past what a phone
// can hold in memory, crashing the chat view on open.
//
// Auth: the proxy admin gate already blocks non-admins on /api/admin/*.

import {
  get as getAccountEntity,
  isAccountStoreConfigured,
  type AccountChatBundle,
} from "@/app/lib/account-store";
import type { StoredMessage } from "@/app/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MessageSize = {
  index: number;
  id: string;
  role: string;
  kind?: string;
  createdAt?: number;
  editedAt?: number;
  model?: string;
  hasError: boolean;
  errorPreview?: string;
  /** Full JSON byte size of the message row. */
  bytes: number;
  contentChars: number;
  thinkingChars: number;
  imageCount: number;
  imageBytes: number;
  pdfCount: number;
  csvCount: number;
  fileCount: number;
  /** Size of the assistant's proposed artifact / VFS payload, if any. */
  artifactBytes: number;
  eventsBytes: number;
};

function jsonBytes(value: unknown): number {
  if (value == null) return 0;
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function analyzeMessage(msg: StoredMessage, index: number): MessageSize {
  const images = Array.isArray(msg.images) ? msg.images : [];
  const imageBytes = images.reduce(
    (sum, img) =>
      sum + (typeof img.dataUrl === "string" ? img.dataUrl.length : 0),
    0
  );
  const artifactBytes =
    jsonBytes(msg.proposedVfs) +
    (msg.proposedArtifact?.html ? msg.proposedArtifact.html.length : 0);
  return {
    index,
    id: msg.id,
    role: msg.role,
    kind: msg.kind,
    createdAt: msg.createdAt,
    editedAt: msg.editedAt,
    model: msg.model,
    hasError: msg.error != null,
    errorPreview:
      typeof msg.error === "string" ? msg.error.slice(0, 300) : undefined,
    bytes: jsonBytes(msg),
    contentChars: typeof msg.content === "string" ? msg.content.length : 0,
    thinkingChars: typeof msg.thinking === "string" ? msg.thinking.length : 0,
    imageCount: images.length,
    imageBytes,
    pdfCount: Array.isArray(msg.pdfs) ? msg.pdfs.length : 0,
    csvCount: Array.isArray(msg.csvs) ? msg.csvs.length : 0,
    fileCount: Array.isArray(msg.files) ? msg.files.length : 0,
    artifactBytes,
    eventsBytes: jsonBytes(msg.events),
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
  const id = url.searchParams.get("id");
  if (!email || !id) {
    return Response.json(
      { error: "email and id are both required." },
      { status: 400 }
    );
  }

  const bundle = (await getAccountEntity(
    email,
    "chat",
    id
  )) as AccountChatBundle | null;
  if (!bundle) {
    return Response.json(
      { error: "No chat bundle stored under this account for that id." },
      { status: 404 }
    );
  }

  // Tolerate a legacy bare-chat row (no bundle nesting) so the tool never
  // 500s on a malformed value.
  const chat = bundle.chat ?? (bundle as unknown as { chat: undefined }).chat;
  const messages = Array.isArray(bundle.messages) ? bundle.messages : [];

  const messageSizes = messages
    .map((m, i) => analyzeMessage(m, i))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .map((m, i) => ({ ...m, index: i }));

  const chatRowBytes = jsonBytes(chat ?? bundle);
  const totalBytes = jsonBytes(bundle);

  return Response.json({
    email,
    id,
    chat: chat ?? null,
    messages,
    analysis: {
      totalBytes,
      chatRowBytes,
      messageCount: messages.length,
      messageSizes,
    },
  });
}
