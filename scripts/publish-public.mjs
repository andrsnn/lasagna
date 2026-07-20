#!/usr/bin/env node
/**
 * publish-public — mirror this private repo to its public counterpart.
 *
 * Safety model:
 *   1. GATE  — runs the AI publish-readiness workflow (scripts/publish-readiness.mjs).
 *              A FAIL aborts the publish. Bypass only with --no-gate (not advised).
 *   2. CLEAN — exports the git-TRACKED tree via `git archive HEAD` (no untracked
 *              personal files, no .git) and drops any configured excludes.
 *   3. SCAN  — a deterministic secret backstop scans the exported snapshot (the
 *              exact bytes about to ship). A hit aborts the publish. This is
 *              defense-in-depth under the AI gate, so a missed exclude or a fresh
 *              commit can't leak a hardcoded secret.
 *   4. SQUASH— commits that snapshot as a SINGLE orphan commit authored by a
 *              neutral identity, so no git history (which may hold old secrets or
 *              personal commit metadata) ever reaches the public repo.
 *   5. PUSH  — force-pushes that one commit to the public remote.
 *
 * If no public remote is configured (publish.config.json → publicRemote: null),
 * it runs the gate and then no-ops the upload — the artifacts case, until that
 * repo exists.
 *
 *   npm run publish:public              # gate, then publish
 *   npm run publish:public -- --dry-run # gate + build snapshot, print manifest, DON'T push
 *   npm run publish:public -- --no-gate # skip the readiness gate (dangerous)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const C = process.stdout.isTTY
  ? { red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m` }
  : new Proxy({}, { get: () => (s) => s });

const REPO = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: REPO, encoding: "utf8", ...opts }).trim();
const die = (m) => { console.error(C.red(`\n✖ ${m}\n`)); process.exit(1); };

// ── config ────────────────────────────────────────────────────────────────────
const cfgPath = join(REPO, "publish.config.json");
if (!existsSync(cfgPath)) die("publish.config.json not found at repo root.");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const {
  publicRemote = null,
  publishBranch = "main",
  commitAuthorName = "publish-bot",
  commitAuthorEmail = "publish-bot@users.noreply.github.com",
  commitMessage = "Publish snapshot",
  exclude = [],
} = cfg;

const repoName = REPO.split("/").pop();
const shortSha = sh("git", ["rev-parse", "--short", "HEAD"]);

console.log(C.bold(`\npublish-public — ${repoName} @ ${shortSha}\n`));

// ── 1. gate ───────────────────────────────────────────────────────────────────
if (!has("--no-gate")) {
  console.log(C.dim("Running the publish-readiness gate…"));
  const g = spawnSync("node", [join(REPO, "scripts", "publish-readiness.mjs")], { cwd: REPO, stdio: "inherit" });
  if (g.status !== 0) die(`Readiness gate did not PASS (exit ${g.status}). Publish aborted. Fix the blockers in .publish-readiness/report.md (or override with --no-gate).`);
  console.log(C.green("✓ Readiness gate passed.\n"));
} else {
  console.log(C.yellow("⚠ --no-gate: skipping the readiness gate.\n"));
}

// ── noop when there is no public repo yet (artifacts) ──────────────────────────
if (!publicRemote) {
  console.log(C.cyan("No public remote configured (publish.config.json → publicRemote: null)."));
  console.log(C.cyan("Scan complete; upload skipped (noop). Set publicRemote once the public repo exists.\n"));
  process.exit(0);
}

// Warn if HEAD isn't what's on disk — we publish HEAD, not the working tree.
const dirtyTracked = sh("git", ["status", "--porcelain", "--untracked-files=no"]);
if (dirtyTracked) console.log(C.yellow("⚠ Uncommitted changes to tracked files — the snapshot publishes HEAD, not your working tree.\n"));

// ── 2. clean export ────────────────────────────────────────────────────────────
// Prefer the external volume for scratch if it's mounted (this box's local disk
// runs near-full); otherwise the OS temp dir. The archive is tracked-files-only
// so it's small regardless.
function scratchBase() {
  const ext = "/Volumes/New Volume";
  try { accessSync(ext, constants.W_OK); return ext; } catch { return tmpdir(); }
}
const work = mkdtempSync(join(scratchBase(), `publish-${repoName}-`));
const cleanup = () => { try { rmSync(work, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);

// ── deterministic secret backstop ─────────────────────────────────────────────
// A last-line, fail-closed scan of the EXPORTED snapshot (post-exclude) for
// hardcoded secret literals. The AI readiness gate is the primary review; this
// is defense-in-depth that catches anything a missed exclude or a fresh commit
// slips through, checked against the exact bytes about to be pushed. Suppress a
// genuine false positive with a `publish-scan-ok` comment on the line.
const SECRET_RES = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/],
  ["api-key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/],
  ["aws-akid", /\bAKIA[0-9A-Z]{16}\b/],
  ["gcp-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["github-token", /\b(?:gh[posur]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["stripe-key", /\b[rs]k_live_[0-9a-zA-Z]{20,}\b/],
  ["fly-token", /\b(?:FlyV1 |fm[12]_)[A-Za-z0-9+/=_-]{20,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["db-url-creds", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@/"'`]+:[^\s@/"'`]+@[^\s"'`]+/],
];
const GENERIC_SECRET = /\b[A-Z0-9_]*(?:SECRET|_TOKEN|APIKEY|API_KEY|PASSWORD|PASSWD|PASS|ACCESS_KEY|CLIENT_SECRET|PRIVATE_KEY|AUTH_TOKEN)\b\s*[:=]\s*["'`]([^"'`]{10,})["'`]/gi;
const PLACEHOLDER = /(^|[^A-Za-z0-9])(x{3,}|your[-_ ]|<[^>]+>|\$\{|process\.env|import\.meta|example|placeholder|redacted|changeme|dummy|sample|todo|\.\.\.|test|fake|none|null|undefined)/i;
const looksSecret = (v) => v.length >= 12 && /^[A-Za-z0-9+/=_.\-]+$/.test(v) && /[A-Za-z]/.test(v) && /[0-9]/.test(v) && new Set(v).size >= 6 && !PLACEHOLDER.test(v);
const SCAN_SKIP = /\.(png|jpe?g|gif|webp|avif|ico|icns|pdf|mp4|mov|webm|mp3|wav|zip|gz|tgz|tar|woff2?|ttf|otf|eot|wasm|node|db|sqlite|bin|exe|dylib|so|heic)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const redactSecret = (s) => { s = String(s); return s.length <= 8 ? s[0] + "***" : s.slice(0, 3) + "***" + s.slice(-2); };

function walkFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, base, out);
    else out.push(p.slice(base.length + 1));
  }
  return out;
}

function scanSnapshotSecrets(dir) {
  const findings = [];
  for (const rel of walkFiles(dir)) {
    if (SCAN_SKIP.test(rel)) continue;
    const abs = join(dir, rel);
    let st; try { st = statSync(abs); } catch { continue; }
    if (st.size > 2 * 1024 * 1024) continue;
    let text; try { text = readFileSync(abs, "utf8"); } catch { continue; }
    if (text.includes("\u0000")) continue; // NUL byte -> binary, skip
    text.split("\n").forEach((line, i) => {
      if (/\bpublish-scan-ok\b/.test(line)) return;
      for (const [id, re] of SECRET_RES) { const m = line.match(re); if (m) findings.push({ rel, line: i + 1, id, snippet: redactSecret(m[0]) }); }
      for (const m of line.matchAll(GENERIC_SECRET)) if (looksSecret(m[1])) findings.push({ rel, line: i + 1, id: "hardcoded-secret", snippet: redactSecret(m[1]) });
    });
  }
  return findings;
}

// ── deterministic PII backstop ─────────────────────────────────────────────────
// Derive the publisher's PERSONAL identifiers at publish time from local git/env — the
// real name + emails (git config + all commit authors), the home-directory path, and the
// PRIVATE source repo slug — then fail-closed if any appear in the export. The AI readiness
// gate is the primary PII review, but it's skipped by --no-gate; this deterministic pass runs
// on EVERY publish so a --no-gate snapshot still can't ship personal info or the private slug.
// Derived at runtime (never a tracked deny-list) so the list itself can't leak.
function derivePiiDeny() {
  const q = (cmd, args) => { try { return execFileSync(cmd, args, { cwd: REPO, encoding: "utf8" }).trim(); } catch { return ""; } };
  const BOT = /^(claude|github|dependabot|renovate|snyk|greenkeeper|semantic-release|actions?|bot|web-flow|publish-bot)$|\[bot\]/i;
  const map = new Map(); // lowercased -> { s, why }
  const add = (s, why) => { s = (s || "").trim(); if (s.length >= 6 && !map.has(s.toLowerCase())) map.set(s.toLowerCase(), { s, why }); };
  // NAME: only the CURRENT publisher's real name. (Historical commit-author names are noisy —
  // they include tool/bot names like "Claude" that legitimately appear all over a codebase.)
  const name = q("git", ["config", "user.name"]);
  if (name && !BOT.test(name)) add(name, "your git author name");
  // EMAILS: current + all historical author emails — specific enough to be safe. Drop bot/noreply.
  for (const e of [q("git", ["config", "user.email"]), ...q("git", ["log", "--all", "--format=%ae"]).split("\n")]) {
    const v = e.trim();
    if (v && !/noreply|@example\.(com|org|net)|@test\.|users\.noreply|\[bot\]|dependabot|github-actions/i.test(v)) add(v, "a commit author email");
  }
  // PRIVATE source repo slug (owner/name) — must not appear in the public mirror.
  const m = q("git", ["remote", "get-url", "origin"]).match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (m) add(`${m[1]}/${m[2]}`, "the PRIVATE source repo slug");
  // Home-directory path bearing the real username (/Users/<name>, /home/<name>, …).
  const user = (process.env.HOME || "").split("/").filter(Boolean).pop() || "";
  if (user && !/^(you|user|me|home|root|example|username|runner|ubuntu|admin)$/i.test(user)) for (const b of ["/Users/", "/home/", "/var/home/"]) add(b + user, "your home-directory path");
  // never flag the INTENDED public identity
  for (const k of [...map.keys()]) { const v = map.get(k).s; if (v === commitAuthorName || v === commitAuthorEmail) map.delete(k); }
  return [...map.values()];
}

function scanSnapshotPii(dir, deny) {
  if (!deny.length) return [];
  const findings = [];
  for (const rel of walkFiles(dir)) {
    if (SCAN_SKIP.test(rel)) continue;
    const abs = join(dir, rel);
    let st; try { st = statSync(abs); } catch { continue; }
    if (st.size > 2 * 1024 * 1024) continue;
    let text; try { text = readFileSync(abs, "utf8"); } catch { continue; }
    if (text.includes(String.fromCharCode(0))) continue;
    text.split("\n").forEach((line, i) => {
      if (/\bpublish-scan-ok\b/.test(line)) return;
      const lc = line.toLowerCase();
      for (const d of deny) if (lc.includes(d.s.toLowerCase())) findings.push({ rel, line: i + 1, why: d.why, snippet: d.s });
    });
  }
  return findings;
}

try {
  console.log(C.dim(`Exporting tracked tree → ${work}`));
  // git archive → tar → extract: tracked content only, no .git, no untracked files.
  execFileSync("bash", ["-c", `git -C "${REPO}" archive --format=tar HEAD | tar -x -C "${work}"`], { stdio: "inherit" });

  for (const rel of exclude) {
    const p = join(work, rel);
    if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); console.log(C.dim(`  excluded: ${rel}`)); }
  }

  const manifest = execFileSync("bash", ["-c", `cd "${work}" && find . -type f | sed 's|^\\./||' | sort`], { encoding: "utf8" }).trim().split("\n");
  console.log(C.bold(`\nWould publish ${manifest.length} file(s) to ${C.cyan(publicRemote)} (branch ${publishBranch}):`));
  console.log(manifest.slice(0, 40).map((f) => "  " + f).join("\n") + (manifest.length > 40 ? C.dim(`\n  … +${manifest.length - 40} more`) : ""));

  // ── secret backstop: scan exactly what would ship, fail closed ───────────────
  const leaks = scanSnapshotSecrets(work);
  if (leaks.length) {
    console.error(C.red(`\n✖ Secret scan found ${leaks.length} likely secret(s) in the export — this is what would have shipped:`));
    for (const f of leaks.slice(0, 25)) console.error(C.red(`  ${f.rel}:${f.line}  ${f.id}  →  ${f.snippet}`));
    if (leaks.length > 25) console.error(C.dim(`  … +${leaks.length - 25} more`));
    console.error(C.dim(`\nRotate + remove the secret, add the file to publish.config.json "exclude", or mark a real false positive with a \`publish-scan-ok\` comment. Override with --no-secret-scan (not advised).`));
    if (!has("--no-secret-scan")) die("Secret backstop failed. Publish aborted.");
  } else {
    console.log(C.green(`✓ Secret backstop clean (${manifest.length} exported files scanned).`));
  }

  // ── PII backstop: fail closed if the publisher's identity or the private slug ships ──
  const piiDeny = derivePiiDeny();
  const piiHits = scanSnapshotPii(work, piiDeny);
  if (piiHits.length) {
    console.error(C.red(`\n✖ PII backstop found ${piiHits.length} personal/private identifier(s) in the export:`));
    for (const f of piiHits.slice(0, 25)) console.error(C.red(`  ${f.rel}:${f.line}  ${f.why}  →  ${f.snippet}`));
    if (piiHits.length > 25) console.error(C.dim(`  … +${piiHits.length - 25} more`));
    console.error(C.dim(`\nRedact/remove it, add the file to publish.config.json "exclude", or mark a real false positive with a \`publish-scan-ok\` comment. Override with --no-pii-scan (not advised).`));
    if (!has("--no-pii-scan")) die("PII backstop failed. Publish aborted.");
  } else {
    console.log(C.green(`✓ PII backstop clean (identity + private slug absent from the ${manifest.length} exported files).`));
  }

  if (has("--dry-run")) {
    console.log(C.yellow(`\n--dry-run: built the snapshot but not pushing. ${manifest.length} files staged in ${work}\n`));
    process.exit(0);
  }

  // ── 3. squash into a single orphan commit (neutral author, no history) ───────
  const env = { ...process.env, GIT_AUTHOR_NAME: commitAuthorName, GIT_AUTHOR_EMAIL: commitAuthorEmail, GIT_COMMITTER_NAME: commitAuthorName, GIT_COMMITTER_EMAIL: commitAuthorEmail };
  const g = (args) => execFileSync("git", args, { cwd: work, env, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  g(["init", "-q", "-b", publishBranch]);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", `${commitMessage}\n\nSquashed snapshot published by scripts/publish-public.mjs.\nGit history is intentionally omitted from the public mirror.`]);

  // ── 4. push, authenticated via the gh token (never written to disk) ──────────
  let token = "";
  try { token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim(); } catch {}
  if (!token) die("Could not get a GitHub token from `gh auth token`. Run `gh auth login` first.");
  const authRemote = publicRemote.replace(/^https:\/\//, `https://x-access-token:${token}@`);

  console.log(C.dim(`\nForce-pushing the snapshot to ${publicRemote} (${publishBranch})…`));
  // Larger post buffer + HTTP/1.1 avoids "RPC failed; HTTP 400 / unexpected
  // disconnect while reading sideband packet" on bigger snapshots over HTTPS.
  const push = spawnSync("git", ["-c", "http.postBuffer=524288000", "-c", "http.version=HTTP/1.1", "-C", work, "push", "--force", authRemote, `${publishBranch}:${publishBranch}`], { stdio: "inherit" });
  if (push.status !== 0) die("Push failed (see output above).");

  const httpUrl = publicRemote.replace(/\.git$/, "");
  console.log(C.green(`\n✓ Published ${manifest.length} files to ${httpUrl} (${publishBranch}) as a clean squashed snapshot.\n`));
} finally {
  cleanup();
}
