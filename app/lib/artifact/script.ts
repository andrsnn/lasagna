// Read-only JS sandbox over the artifact VFS. The model writes a one-shot
// transformation, the sandbox runs it, and the model declares its
// intended mutations via `propose.edit / write / delete(...)`. The
// dispatcher then applies that plan through the SAME `applyEdit` /
// `writeFile` / `deleteFile` machinery MultiEdit uses — so the Read-
// before-Edit invariant, the canvas single-file constraint, and the
// selection-pin constraint all stay in force. Script is just a smarter
// way to produce the edit list.
//
// Sandbox surface (deliberately small, all read-only):
//   read(path) -> string | null
//   list() -> string[]                    sorted, every path in the VFS
//   exists(path) -> boolean
//   console.log/warn/error/info(...)      captured to stdout
//   propose.edit(path, old_string, new_string, opts?)   queue an Edit
//   propose.write(path, content)                        queue a Write
//   propose.delete(path)                                queue a Delete
//
// Standard ECMAScript globals (JSON, Math, Array, String, Number,
// RegExp, Set, Map, Date, Error, Promise, Symbol) come for free from
// vm.createContext. Node-isms (require, process, fs, Buffer,
// setTimeout, setImmediate, child_process) are NOT exposed.

import vm from "node:vm";
import type { ArtifactFiles } from "@/app/db";
import { readFile } from "./vfs";

const TIMEOUT_MS = 5000;
const MAX_STDOUT = 8 * 1024;
const MAX_SOURCE = 100 * 1024;
const MAX_PLAN_OPS = 500;

export type ScriptEditOp =
  | {
      kind: "edit";
      path: string;
      old_string: string;
      new_string: string;
      replace_all: boolean;
    }
  | { kind: "write"; path: string; content: string }
  | { kind: "delete"; path: string };

export type ScriptResult =
  | {
      ok: true;
      plan: ScriptEditOp[];
      stdout: string;
      returnValue: string;
      durationMs: number;
    }
  | {
      ok: false;
      error: string;
      stdout: string;
      durationMs: number;
    };

export function executeScript(
  files: ArtifactFiles,
  code: string
): ScriptResult {
  const t0 = Date.now();

  if (typeof code !== "string" || code.length === 0) {
    return { ok: false, error: "code is required", stdout: "", durationMs: 0 };
  }
  if (code.length > MAX_SOURCE) {
    return {
      ok: false,
      error: `script too large (${code.length} > ${MAX_SOURCE} chars)`,
      stdout: "",
      durationMs: 0,
    };
  }

  let stdout = "";
  const plan: ScriptEditOp[] = [];

  const log = (...args: unknown[]) => {
    if (stdout.length >= MAX_STDOUT) return;
    const line = args.map(stringify).join(" ");
    stdout += line + "\n";
    if (stdout.length > MAX_STDOUT) {
      stdout = stdout.slice(0, MAX_STDOUT) + "\n…[truncated]";
    }
  };

  const guardOp = () => {
    if (plan.length >= MAX_PLAN_OPS) {
      throw new RangeError(
        `propose: edit plan exceeds ${MAX_PLAN_OPS} ops — collapse into fewer ops or split the script.`
      );
    }
  };

  const propose = {
    edit(
      path: unknown,
      oldString: unknown,
      newString: unknown,
      opts?: unknown
    ): void {
      guardOp();
      assertPath(path, "propose.edit");
      if (typeof oldString !== "string") {
        throw new TypeError(
          "propose.edit(path, old_string, new_string): old_string must be a string"
        );
      }
      if (typeof newString !== "string") {
        throw new TypeError(
          "propose.edit(path, old_string, new_string): new_string must be a string"
        );
      }
      const replaceAll =
        opts && typeof opts === "object" && "replace_all" in opts
          ? Boolean((opts as { replace_all?: unknown }).replace_all)
          : false;
      plan.push({
        kind: "edit",
        path: path as string,
        old_string: oldString,
        new_string: newString,
        replace_all: replaceAll,
      });
    },
    write(path: unknown, content: unknown): void {
      guardOp();
      assertPath(path, "propose.write");
      if (typeof content !== "string") {
        throw new TypeError(
          "propose.write(path, content): content must be a string. JSON.stringify your value first if needed."
        );
      }
      plan.push({ kind: "write", path: path as string, content });
    },
    delete(path: unknown): void {
      guardOp();
      assertPath(path, "propose.delete");
      plan.push({ kind: "delete", path: path as string });
    },
  };

  // A fresh context. node:vm seeds only the ECMAScript built-ins
  // (Object, Array, JSON, Math, RegExp, Set, Map, Date, Error, etc.) —
  // no `require`, `process`, `Buffer`, `setTimeout`, or globalThis access
  // to our process. The exposed API is exactly the four read functions
  // plus `propose.*`.
  const sandbox = vm.createContext({
    read(path: unknown): string | null {
      assertPath(path, "read");
      return readFile(files, path as string);
    },
    list(): string[] {
      return Object.keys(files).sort();
    },
    exists(path: unknown): boolean {
      return (
        typeof path === "string" &&
        Object.prototype.hasOwnProperty.call(files, path)
      );
    },
    propose,
    console: {
      log,
      warn: log,
      error: log,
      info: log,
      debug: log,
    },
  });

  let returnValue: unknown;
  try {
    returnValue = vm.runInContext(code, sandbox, {
      timeout: TIMEOUT_MS,
      filename: "script.js",
      displayErrors: true,
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      stdout,
      durationMs: Date.now() - t0,
    };
  }

  return {
    ok: true,
    plan,
    stdout,
    returnValue: stringify(returnValue),
    durationMs: Date.now() - t0,
  };
}

function assertPath(path: unknown, fn: string): asserts path is string {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError(`${fn}(path): path must be a non-empty string`);
  }
}

function stringify(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint")
    return String(v);
  if (typeof v === "function") return `[Function${v.name ? ": " + v.name : ""}]`;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
