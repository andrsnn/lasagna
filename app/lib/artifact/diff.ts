// Tiny unified-diff generator over text. Used to show the model what
// actually changed after a Write / Edit / MultiEdit / Script call,
// instead of just "+N -M lines". A short diff snippet beats a count
// because the model can verify its intent landed correctly without
// re-Reading the file.
//
// Implementation: Hirschberg-style LCS on line arrays for small files
// (under a few thousand lines). Anything larger falls back to a
// no-context "rewrite" diff so we never spend unbounded time.

const LCS_LINE_CAP = 4000; // skip real LCS over a file with more than this
const CONTEXT = 2;         // lines of context above/below a hunk
const MAX_DIFF_CHARS = 1500;

/**
 * Return a unified-diff string for `before` vs `after`. Empty string
 * means the inputs were identical. Caps at MAX_DIFF_CHARS and appends
 * a truncation marker. Both sides may end with or without a trailing
 * newline; the format follows GNU `diff -u` (line context only).
 */
export function unifiedDiff(before: string, after: string): string {
  if (before === after) return "";
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");

  // Drop the synthetic empty last element when the input ends with \n,
  // so deleting the final newline of an N-line file isn't reported as
  // "-empty +empty".
  if (before.endsWith("\n")) a.pop();
  if (after.endsWith("\n")) b.pop();

  if (a.length + b.length > LCS_LINE_CAP * 2) {
    return rewriteDiff(a, b);
  }

  const ops = lcsDiff(a, b);
  return formatHunks(a, b, ops);
}

// ---------- LCS ----------

type Op = { tag: "eq" | "del" | "add"; ai: number; bi: number };

function lcsDiff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = length of LCS of a[0..i) and b[0..j)
  const dp: Int32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    const row = dp[i];
    const prev = dp[i - 1];
    for (let j = 1; j <= m; j++) {
      if (ai === b[j - 1]) row[j] = prev[j - 1] + 1;
      else row[j] = row[j - 1] > prev[j] ? row[j - 1] : prev[j];
    }
  }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ tag: "eq", ai: i - 1, bi: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ tag: "del", ai: i - 1, bi: j });
      i--;
    } else {
      ops.push({ tag: "add", ai: i, bi: j - 1 });
      j--;
    }
  }
  while (i > 0) {
    ops.push({ tag: "del", ai: i - 1, bi: j });
    i--;
  }
  while (j > 0) {
    ops.push({ tag: "add", ai: i, bi: j - 1 });
    j--;
  }
  ops.reverse();
  return ops;
}

// ---------- hunk formatter ----------

function formatHunks(a: string[], b: string[], ops: Op[]): string {
  // Walk the op stream, group runs of non-eq ops into hunks padded with
  // `CONTEXT` eq lines on each side.
  const hunks: string[] = [];
  let i = 0;
  while (i < ops.length) {
    // Skip leading equals beyond context window.
    if (ops[i].tag === "eq") {
      i++;
      continue;
    }
    // Found a change; back up CONTEXT eq lines.
    let start = i;
    let eqBack = 0;
    while (start > 0 && ops[start - 1].tag === "eq" && eqBack < CONTEXT) {
      start--;
      eqBack++;
    }
    // Extend through changes; allow up to CONTEXT consecutive eq lines
    // inside a hunk (merge close changes).
    let end = i;
    while (end < ops.length) {
      if (ops[end].tag !== "eq") {
        end++;
        continue;
      }
      // Look ahead for more changes within 2*CONTEXT.
      let look = end;
      let eqRun = 0;
      while (look < ops.length && ops[look].tag === "eq") {
        eqRun++;
        look++;
      }
      if (look < ops.length && eqRun <= CONTEXT * 2) {
        end = look;
      } else {
        // Trail off; include up to CONTEXT eq lines at the tail.
        end += Math.min(CONTEXT, eqRun);
        break;
      }
    }
    if (end > ops.length) end = ops.length;

    // Compute hunk header from first/last op offsets.
    const firstA = ops[start].ai + (ops[start].tag === "add" ? 1 : 1);
    const firstB = ops[start].bi + (ops[start].tag === "del" ? 1 : 1);
    let aCount = 0;
    let bCount = 0;
    const lines: string[] = [];
    for (let k = start; k < end; k++) {
      const op = ops[k];
      if (op.tag === "eq") {
        lines.push(" " + a[op.ai]);
        aCount++;
        bCount++;
      } else if (op.tag === "del") {
        lines.push("-" + a[op.ai]);
        aCount++;
      } else {
        lines.push("+" + b[op.bi]);
        bCount++;
      }
    }
    hunks.push(
      `@@ -${firstA},${aCount} +${firstB},${bCount} @@\n` + lines.join("\n")
    );
    i = end;
  }

  let out = hunks.join("\n");
  if (out.length > MAX_DIFF_CHARS) {
    out = out.slice(0, MAX_DIFF_CHARS) + "\n…[diff truncated]";
  }
  return out;
}

function rewriteDiff(a: string[], b: string[]): string {
  // Fallback for very large files: emit a single full-replace hunk,
  // capped immediately. The model still gets the signal that the file
  // was rewritten.
  const head = `@@ -1,${a.length} +1,${b.length} @@`;
  const sampleA = a.slice(0, 5).map((l) => "-" + l).join("\n");
  const sampleB = b.slice(0, 5).map((l) => "+" + l).join("\n");
  return `${head}\n${sampleA}\n${sampleB}\n…[large file rewritten]`;
}
