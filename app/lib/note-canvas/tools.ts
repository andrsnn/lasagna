// Server-side tool wiring for the pinned-note canvas. The canvas reuses
// the designer's VFS dispatcher (executeVfsTool) but with a restricted
// toolset — see NOTE_CANVAS_ALLOWED_TOOLS in app/lib/ollama/tools.ts for
// the enforcement; this module just exposes the Tool defs the LLM sees.
//
// Client code that just needs the body shape / size cap should import
// from `./body` instead — this file pulls in the ollama SDK which would
// bloat the client bundle.

import type { Tool } from "ollama";
import {
  EDIT_TOOL,
  FINISH_TOOL,
  MULTI_EDIT_TOOL,
  READ_TOOL,
  SCRIPT_TOOL,
  WRITE_TOOL,
} from "@/app/lib/ollama/tools";

/** Tools the model sees in canvas mode. Glob/Grep/LS/Delete/Build are off.
 *  Script is on — its proposed edits flow through applyEdit/writeFile and
 *  the dispatcher enforces single-file + selection constraints just like
 *  for Edit/MultiEdit/Write. */
export const NOTE_EDIT_TOOLS: Tool[] = [
  READ_TOOL,
  EDIT_TOOL,
  MULTI_EDIT_TOOL,
  WRITE_TOOL,
  SCRIPT_TOOL,
  FINISH_TOOL,
];

export const NOTE_EDIT_TOOL_NAMES = new Set([
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "Script",
  "Finish",
]);

// Re-export the client-safe helpers so server callers that already pull
// the tool defs don't need a second import line.
export {
  noteToCanvasBody,
  serializeSnapshot,
  type NoteCanvasBody,
  type NoteCanvasKind,
} from "./body";
