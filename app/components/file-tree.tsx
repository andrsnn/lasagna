"use client";

import { useMemo } from "react";
import { ChevronRight, File, FolderClosed } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ArtifactFiles } from "@/app/db";

type Props = {
  files: ArtifactFiles;
  entry?: string;
  /** Path of the currently-selected file. */
  selected?: string;
  onSelect?: (path: string) => void;
  /** Optional set of paths recently touched by the assistant — gets a highlight badge. */
  touched?: Set<string>;
  className?: string;
};

type Node =
  | { kind: "file"; name: string; path: string }
  | { kind: "dir"; name: string; path: string; children: Node[] };

function buildTree(files: ArtifactFiles): Node[] {
  const root: Node[] = [];
  const dirIndex = new Map<string, Node[]>();
  dirIndex.set("", root);

  const paths = Object.keys(files).sort();
  for (const path of paths) {
    const parts = path.split("/");
    let parent = root;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i];
      prefix = prefix ? `${prefix}/${dir}` : dir;
      let existing = parent.find((n) => n.kind === "dir" && n.name === dir) as
        | (Node & { kind: "dir" })
        | undefined;
      if (!existing) {
        existing = { kind: "dir", name: dir, path: prefix, children: [] };
        parent.push(existing);
        dirIndex.set(prefix, existing.children);
      }
      parent = existing.children;
    }
    const fileName = parts[parts.length - 1];
    parent.push({ kind: "file", name: fileName, path });
  }

  // Sort: dirs first (alpha), then files (alpha).
  const sortNodes = (nodes: Node[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.kind === "dir") sortNodes(n.children);
  };
  sortNodes(root);
  return root;
}

export function FileTree({ files, entry, selected, onSelect, touched, className }: Props) {
  const tree = useMemo(() => buildTree(files), [files]);
  return (
    <div className={cn("flex flex-col gap-0.5 font-mono text-[12px]", className)}>
      {tree.map((node) => (
        <Branch
          key={node.path}
          node={node}
          depth={0}
          entry={entry}
          selected={selected}
          onSelect={onSelect}
          touched={touched}
        />
      ))}
    </div>
  );
}

function Branch({
  node,
  depth,
  entry,
  selected,
  onSelect,
  touched,
}: {
  node: Node;
  depth: number;
  entry?: string;
  selected?: string;
  onSelect?: (path: string) => void;
  touched?: Set<string>;
}) {
  if (node.kind === "dir") {
    return (
      <div>
        <div
          className="flex items-center gap-1 px-1 py-0.5 text-muted-foreground"
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          <ChevronRight className="h-3 w-3 rotate-90" />
          <FolderClosed className="h-3 w-3" />
          <span>{node.name}</span>
        </div>
        {node.children.map((child) => (
          <Branch
            key={child.path}
            node={child}
            depth={depth + 1}
            entry={entry}
            selected={selected}
            onSelect={onSelect}
            touched={touched}
          />
        ))}
      </div>
    );
  }
  const isSelected = selected === node.path;
  const isEntry = entry === node.path;
  const isTouched = touched?.has(node.path);
  return (
    <button
      type="button"
      onClick={() => onSelect?.(node.path)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition",
        isSelected
          ? "bg-primary/15 text-foreground"
          : "text-foreground/80 hover:bg-muted hover:text-foreground"
      )}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      <File className="h-3 w-3 shrink-0 opacity-70" />
      <span className="truncate">{node.name}</span>
      {isEntry && (
        <span className="ml-auto rounded bg-primary/20 px-1 py-px text-[9px] font-medium text-primary">
          entry
        </span>
      )}
      {isTouched && !isEntry && (
        <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-500" aria-label="recently edited" />
      )}
    </button>
  );
}
