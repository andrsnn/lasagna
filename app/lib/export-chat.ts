import type { StoredChat, StoredMessage } from "@/app/db";

export type ChatExportFormat = "markdown" | "text" | "json";

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return "";
  }
}

function roleLabel(role: StoredMessage["role"]): string {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "system") return "System";
  if (role === "tool") return "Tool";
  return role;
}

function isVisibleMessage(m: StoredMessage): boolean {
  // Skip rows that are subsumed into a later summary — the summary itself
  // already captures them, and emitting both would duplicate content.
  if (m.summarizedInto) return false;
  return true;
}

function attachmentLines(m: StoredMessage): string[] {
  const lines: string[] = [];
  if (m.images?.length) {
    for (const img of m.images) {
      const name = img.name?.trim() || "image";
      lines.push(`[image attached: ${name}${img.mime ? ` (${img.mime})` : ""}]`);
      if (img.description?.trim()) {
        lines.push(`  caption: ${img.description.trim()}`);
      }
    }
  }
  if (m.pdfs?.length) {
    for (const pdf of m.pdfs) {
      lines.push(
        `[pdf attached: ${pdf.name} · ${pdf.pageCount} page${pdf.pageCount === 1 ? "" : "s"}]`
      );
      if (pdf.excerpt?.trim()) {
        lines.push(`  excerpt: ${pdf.excerpt.trim()}`);
      }
    }
  }
  return lines;
}

export type BuildChatExportOptions = {
  includeThinking?: boolean;
};

export function buildChatMarkdown(
  chat: StoredChat,
  messages: StoredMessage[],
  opts: BuildChatExportOptions = {}
): string {
  const includeThinking = opts.includeThinking ?? false;
  const parts: string[] = [];
  parts.push(`# ${chat.title || "Untitled chat"}`);
  const meta: string[] = [];
  if (chat.createdAt) meta.push(`Created: ${formatTimestamp(chat.createdAt)}`);
  if (chat.updatedAt) meta.push(`Updated: ${formatTimestamp(chat.updatedAt)}`);
  if (chat.model) meta.push(`Model: ${chat.model}`);
  if (meta.length) parts.push(meta.map((l) => `_${l}_`).join("  \n"));

  for (const m of messages) {
    if (!isVisibleMessage(m)) continue;
    const header = `## ${roleLabel(m.role)}${m.model ? ` · ${m.model}` : ""}${
      m.createdAt ? ` · ${formatTimestamp(m.createdAt)}` : ""
    }`;
    parts.push(header);

    const attachments = attachmentLines(m);
    if (attachments.length) parts.push(attachments.join("\n"));

    if (includeThinking && m.thinking?.trim()) {
      parts.push("<details><summary>Thinking</summary>\n\n" + m.thinking.trim() + "\n\n</details>");
    }

    const content = m.content?.trim();
    if (content) parts.push(content);

    if (m.proposedArtifact?.html) {
      parts.push(
        "> _Artifact HTML omitted from text export — open the source chat to view the interactive artifact._"
      );
    }
    if (m.proposedVfs) {
      parts.push("> _Multi-file edit omitted from text export — open the source chat to view file changes._");
    }
    if (m.error) {
      parts.push(`> _Error: ${m.error}_`);
    }
  }

  return parts.join("\n\n") + "\n";
}

export function buildChatText(
  chat: StoredChat,
  messages: StoredMessage[],
  opts: BuildChatExportOptions = {}
): string {
  const includeThinking = opts.includeThinking ?? false;
  const lines: string[] = [];
  const title = chat.title || "Untitled chat";
  lines.push(title);
  lines.push("=".repeat(Math.max(3, Math.min(80, title.length))));
  if (chat.createdAt) lines.push(`Created: ${formatTimestamp(chat.createdAt)}`);
  if (chat.updatedAt) lines.push(`Updated: ${formatTimestamp(chat.updatedAt)}`);
  if (chat.model) lines.push(`Model: ${chat.model}`);
  lines.push("");

  for (const m of messages) {
    if (!isVisibleMessage(m)) continue;
    const header = `--- ${roleLabel(m.role)}${m.model ? ` · ${m.model}` : ""}${
      m.createdAt ? ` · ${formatTimestamp(m.createdAt)}` : ""
    } ---`;
    lines.push(header);

    for (const a of attachmentLines(m)) lines.push(a);

    if (includeThinking && m.thinking?.trim()) {
      lines.push("[thinking]");
      lines.push(m.thinking.trim());
      lines.push("[/thinking]");
    }

    const content = m.content?.trim();
    if (content) lines.push(content);

    if (m.proposedArtifact?.html) {
      lines.push("[artifact HTML omitted — open the source chat to view]");
    }
    if (m.proposedVfs) {
      lines.push("[multi-file edit omitted — open the source chat to view]");
    }
    if (m.error) {
      lines.push(`[error] ${m.error}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Full, verbatim dump of a chat + its messages as JSON — the "sync/debug"
 * export. Unlike the markdown/text builders (which are lossy and human-facing),
 * this preserves the raw message content, proposed artifacts/VFS edits, errors,
 * and metadata so a crash can be reproduced on another device (a laptop with
 * devtools) without opening the chat here — opening it is what breaks.
 *
 * Embedded base64 data: URIs (image/PDF blobs) are elided to a placeholder:
 * they bloat the file and re-risk the low-memory phone we're exporting FROM,
 * and they're never the cause of a render crash. Everything text stays intact.
 */
export function buildChatDebugJson(
  chat: StoredChat,
  messages: StoredMessage[]
): string {
  const payload = {
    _meta: {
      exportedAt: formatTimestamp(Date.now()),
      userAgent:
        typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      url: typeof location !== "undefined" ? location.href : undefined,
      messageCount: messages.length,
    },
    chat,
    messages,
  };
  const replacer = (_key: string, value: unknown) => {
    if (typeof value === "string" && value.startsWith("data:") && value.length > 256) {
      return `[data URI elided, ${value.length} chars]`;
    }
    return value;
  };
  return JSON.stringify(payload, replacer, 2);
}

function safeChatFilename(chat: StoredChat, ext: string): string {
  const base =
    (chat.title || "chat")
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80)
      .replace(/\s+/g, "_")
      .replace(/^[._]+|[._]+$/g, "") || "chat";
  return `${base}.${ext}`;
}

function triggerDownload(filename: string, mime: string, body: string): void {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadChat(
  chat: StoredChat,
  messages: StoredMessage[],
  format: ChatExportFormat,
  opts: BuildChatExportOptions = {}
): void {
  if (format === "markdown") {
    triggerDownload(
      safeChatFilename(chat, "md"),
      "text/markdown",
      buildChatMarkdown(chat, messages, opts)
    );
    return;
  }
  if (format === "json") {
    triggerDownload(
      safeChatFilename(chat, "json"),
      "application/json",
      buildChatDebugJson(chat, messages)
    );
    return;
  }
  triggerDownload(
    safeChatFilename(chat, "txt"),
    "text/plain",
    buildChatText(chat, messages, opts)
  );
}
