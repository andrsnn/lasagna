"use client";

// Promote a pinned markdown note into a designer + paired app + edit chat.
// Used by the canvas page's "Open as app" button. Mirrors
// `createDesignerAndChatFromHtml` so the designer's existing
// `sourceNoteId` write-back keeps working.

import {
  newId,
  putApp,
  putChat,
  putDesigner,
  putMessage,
  type ArtifactFiles,
  type ArtifactManifest,
  type StoredApp,
  type StoredChat,
  type StoredDesigner,
  type StoredMessage,
} from "@/app/db";

/**
 * Minimal HTML scaffold for promoted markdown. Renders the raw markdown
 * inside a styled `<pre>` block — readable on the cream-paper theme out of
 * the gate. The user iterates with the assistant in the designer to turn
 * this into a real layout (headings, sections, components); the
 * designer's VFS toolset handles that natively.
 *
 * We deliberately don't import a markdown→HTML parser here. (a) That'd
 * bundle a parser into the client just for promotion; (b) the assistant is
 * about to rewrite the file anyway — the goal is to give it raw material,
 * not finished output.
 */
function htmlScaffoldForMarkdown(title: string, markdown: string): string {
  const escaped = markdown.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"
  );
  const escapedTitle = title.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"
  );
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapedTitle || "Untitled"}</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      padding: 2.5rem clamp(1rem, 6vw, 4rem);
      background: #fffdf7;
      color: #1f1c17;
      font: 16px/1.6 ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif;
      max-width: 760px;
      margin-inline: auto;
    }
    h1 { font-size: 1.8rem; margin: 0 0 1.25rem; color: #2d4a3e; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      font-family: inherit;
      font-size: 1rem;
      line-height: 1.6;
      margin: 0;
    }
  </style>
</head>
<body>
  ${escapedTitle ? `<h1>${escapedTitle}</h1>` : ""}
  <pre>${escaped}</pre>
</body>
</html>
`;
}

/**
 * Seed a designer + paired app + edit chat from a pinned markdown note. The
 * designer carries `sourceNoteId` so designer saves stream the new HTML back
 * to the note via `syncDesignerToSourceNote`. The seed assistant message
 * tells the user the body is loaded as a static scaffold and invites them
 * to ask for a real layout.
 */
export async function createDesignerAndChatFromMarkdown(
  markdown: string,
  summary: string,
  options: { sourceNoteId: string; title?: string }
): Promise<{ designer: StoredDesigner; app: StoredApp; chat: StoredChat }> {
  const now = Date.now();
  const id = newId();
  const chatId = newId();
  const titleSeed =
    options.title?.trim() ||
    summary.split(/\r?\n/)[0]?.trim().slice(0, 60) ||
    "Untitled note";
  const html = htmlScaffoldForMarkdown(titleSeed, markdown);
  const files: ArtifactFiles = { "index.html": html };
  const entry = "index.html";
  const manifest: ArtifactManifest = {
    name: titleSeed,
    description: summary.slice(0, 200) || undefined,
    params: [],
  };
  const designer: StoredDesigner = {
    id,
    name: titleSeed,
    description: summary.slice(0, 200) || undefined,
    files,
    entry,
    manifest,
    status: "draft",
    version: 1,
    history: [],
    sourceChatId: chatId,
    sourceNoteId: options.sourceNoteId,
    createdAt: now,
    updatedAt: now,
  };
  const app: StoredApp = {
    id,
    name: titleSeed,
    params: {},
    state: {},
    lastRunAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const chat: StoredChat = {
    id: chatId,
    title: `Edit · ${titleSeed}`,
    titleSource: "default",
    target: { kind: "designer", id, mode: "edit" },
    createdAt: now,
    updatedAt: now,
  };
  await putDesigner(designer);
  await putApp(app);
  await putChat(chat);

  const intro: StoredMessage = {
    id: newId(),
    chatId,
    role: "assistant",
    content:
      `Loaded **${titleSeed}** from your pinned note as a static HTML scaffold. ` +
      `Ask me to add layout, sections, or interactivity — every save writes the ` +
      `new \`index.html\` back to the note.`,
    createdAt: now,
  };
  await putMessage(intro);

  return { designer, app, chat };
}
