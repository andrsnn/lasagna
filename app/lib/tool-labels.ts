import {
  AlertCircle,
  BookOpen,
  Check,
  Eye,
  FileText,
  FilePlus,
  FolderTree,
  Globe,
  Image as ImageIcon,
  Link as LinkIcon,
  Loader2,
  Pencil,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";

type ToolArgs = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

const filePathOf = (args: ToolArgs): string | null =>
  str(args.file_path) ?? str(args.path) ?? null;

const baseName = (p: string): string => {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
};

const titleCase = (s: string): string =>
  s
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";

export type ToolPresentation = {
  /** Verb for in-flight pill, e.g. "Reading App.tsx". No trailing ellipsis. */
  verb: string;
  /** Past-tense for completed Activity rows, e.g. "Looked at App.tsx". */
  past: string;
  /** Optional secondary detail (file path, query, host) for Activity rows. */
  detail: string | null;
  /** Lucide icon component. */
  icon: LucideIcon;
};

export function toolPresentation(name: string, args: ToolArgs = {}): ToolPresentation {
  switch (name) {
    case "Read": {
      const fp = filePathOf(args);
      const f = fp ? baseName(fp) : null;
      return {
        verb: f ? `Reading ${f}` : "Reading file",
        past: f ? `Looked at ${f}` : "Read a file",
        detail: fp,
        icon: FileText,
      };
    }
    case "Write": {
      const fp = filePathOf(args);
      const f = fp ? baseName(fp) : null;
      return {
        verb: f ? `Writing ${f}` : "Writing file",
        past: f ? `Wrote ${f}` : "Wrote a file",
        detail: fp,
        icon: FilePlus,
      };
    }
    case "Edit":
    case "MultiEdit": {
      const fp = filePathOf(args);
      const f = fp ? baseName(fp) : null;
      return {
        verb: f ? `Editing ${f}` : "Editing file",
        past: f ? `Edited ${f}` : "Edited a file",
        detail: fp,
        icon: Pencil,
      };
    }
    case "Delete": {
      const fp = filePathOf(args);
      const f = fp ? baseName(fp) : null;
      return {
        verb: f ? `Deleting ${f}` : "Deleting file",
        past: f ? `Deleted ${f}` : "Deleted a file",
        detail: fp,
        icon: Wrench,
      };
    }
    case "LS": {
      const path = str(args.path);
      return {
        verb: "Listing files",
        past: "Listed files",
        detail: path,
        icon: FolderTree,
      };
    }
    case "Glob": {
      const pattern = str(args.pattern);
      return {
        verb: "Finding files",
        past: "Found files",
        detail: pattern,
        icon: Search,
      };
    }
    case "Grep": {
      const pattern = str(args.pattern);
      return {
        verb: "Searching code",
        past: "Searched code",
        detail: pattern,
        icon: Search,
      };
    }
    case "Bash": {
      const cmd = str(args.command);
      const detail = cmd ? truncate(cmd, 60) : null;
      return {
        verb: "Running command",
        past: "Ran command",
        detail,
        icon: Terminal,
      };
    }
    case "web_search": {
      const q = str(args.query);
      return {
        verb: q ? `Searching the web for “${truncate(q, 40)}”` : "Searching the web",
        past: "Searched the web",
        detail: q ? `“${q}”` : null,
        icon: Globe,
      };
    }
    case "web_fetch": {
      const url = str(args.url);
      return {
        verb: url ? `Fetching ${hostOf(url)}` : "Fetching page",
        past: "Fetched page",
        detail: url,
        icon: LinkIcon,
      };
    }
    case "browse_page": {
      const url = str(args.url);
      return {
        verb: url ? `Browsing ${hostOf(url)}` : "Browsing page",
        past: "Browsed page",
        detail: url,
        icon: Globe,
      };
    }
    case "http_request": {
      const url = str(args.url);
      const method = str(args.method);
      return {
        verb: url ? `${(method ?? "GET").toUpperCase()} ${hostOf(url)}` : "HTTP request",
        past: "Made HTTP request",
        detail: url,
        icon: LinkIcon,
      };
    }
    case "run_command": {
      const cmds = Array.isArray(args.commands)
        ? (args.commands as Array<{ cmd?: unknown }>)
            .map((c) => (c && typeof c.cmd === "string" ? c.cmd : null))
            .filter((c): c is string => !!c)
        : [];
      const pipe = cmds.join(" | ");
      return {
        verb: pipe ? `Running ${truncate(pipe, 40)}` : "Running command",
        past: "Ran command",
        detail: pipe || null,
        icon: Terminal,
      };
    }
    case "compaction": {
      const folded =
        typeof args.messagesFolded === "number" ? args.messagesFolded : 0;
      return {
        verb: "Compacting context",
        past:
          folded > 0
            ? `Compacted ${folded} earlier ${folded === 1 ? "round" : "rounds"} to save context`
            : "Compacted context",
        detail:
          typeof args.tokensBefore === "number" &&
          typeof args.tokensAfter === "number"
            ? `${Math.round((args.tokensBefore as number) / 1000)}k → ${Math.round(
                (args.tokensAfter as number) / 1000
              )}k tokens`
            : null,
        icon: Sparkles,
      };
    }
    case "describe_image": {
      const img = str(args.image);
      const describer = str(args.describer);
      return {
        verb: "Looking at the image",
        past: "Described image",
        detail: img && describer ? `${img} via ${describer}` : (img ?? describer),
        icon: Eye,
      };
    }
    case "image_native": {
      const count = typeof args.count === "number" ? args.count : 0;
      const noun = count === 1 ? "image" : "images";
      return {
        verb: count > 0 ? `Sending ${count} ${noun} directly` : "Sending image directly",
        past: count > 0 ? `Sent ${count} ${noun} natively` : "Sent image natively",
        detail: null,
        icon: ImageIcon,
      };
    }
    case "attach_csv": {
      const csvName = str(args.name);
      const csvRows = typeof args.rows === "number" ? args.rows : 0;
      const csvCols = typeof args.columns === "number" ? args.columns : 0;
      return {
        verb: csvName ? `Attaching ${csvName}` : "Attaching CSV",
        past: csvName ? `Attached ${csvName}` : "Attached CSV",
        detail: csvRows > 0 ? `${csvRows} rows, ${csvCols} columns` : null,
        icon: FileText,
      };
    }
    case "attach_pdf": {
      const pdfName = str(args.name);
      return {
        verb: pdfName ? `Attaching ${pdfName}` : "Attaching PDF",
        past: pdfName ? `Attached ${pdfName}` : "Attached PDF",
        detail: null,
        icon: FileText,
      };
    }
    case "image_describe_mode": {
      const count = typeof args.count === "number" ? args.count : 0;
      const noun = count === 1 ? "image" : "images";
      return {
        verb: count > 0 ? `Describing ${count} ${noun} first` : "Describing image first",
        past: count > 0 ? `Described ${count} ${noun} then sent text` : "Described image then sent text",
        detail: null,
        icon: ImageIcon,
      };
    }
    default: {
      // Novel mode timeline events. Names follow novel:<stage> or
      // novel:chapter:<id>[:<subevent>] from app/api/chat/novel/orchestrator.ts.
      if (name.startsWith("novel:")) return novelPresentation(name, args);
      const friendly = titleCase(name);
      const keys = Object.keys(args);
      return {
        verb: friendly,
        past: friendly,
        detail: keys.length > 0 ? keys.join(", ") : null,
        icon: Wrench,
      };
    }
  }
}

function novelPresentation(name: string, args: ToolArgs): ToolPresentation {
  if (name === "novel:outline") {
    const length = str(args.length);
    return {
      verb: "Outlining the novel",
      past: "Outlined the novel",
      detail: length ? `length: ${length}` : null,
      icon: BookOpen,
    };
  }
  if (name === "novel:assemble") {
    return {
      verb: "Assembling the novel",
      past: "Assembled the novel",
      detail: null,
      icon: BookOpen,
    };
  }
  if (name === "novel:error") {
    return {
      verb: "Novel orchestration failed",
      past: "Novel orchestration failed",
      detail: null,
      icon: AlertCircle,
    };
  }
  // Chapter events: novel:chapter:c3 or novel:chapter:c3:web_search
  const chapterMatch = name.match(/^novel:chapter:(c\d+)(?::(.+))?$/);
  if (chapterMatch) {
    const [, chapterId, subEvent] = chapterMatch;
    const num = chapterId.slice(1); // "c3" → "3"
    if (subEvent === "web_search") {
      const q = str(args.query);
      return {
        verb: q ? `Searching for chapter ${num}: “${truncate(q, 32)}”` : `Searching for chapter ${num}`,
        past: "Searched the web",
        detail: q ? `“${q}”` : null,
        icon: Globe,
      };
    }
    const titleArg = str(args.title);
    return {
      verb: titleArg ? `Writing chapter ${num} — ${titleArg}` : `Writing chapter ${num}`,
      past: titleArg ? `Wrote chapter ${num} — ${titleArg}` : `Wrote chapter ${num}`,
      detail: null,
      icon: BookOpen,
    };
  }
  const friendly = titleCase(name.replace(/^novel:/, ""));
  return {
    verb: friendly,
    past: friendly,
    detail: null,
    icon: BookOpen,
  };
}

export { Loader2, Sparkles, AlertCircle, Check };
