#!/usr/bin/env node
/**
 * publish-readiness — the npm entrypoint for the AI publish-readiness gate.
 *
 * It launches Claude headlessly to run the `.claude/workflows/publish-readiness.js`
 * workflow, which reviews the shipping tree across nine dimensions (secrets, PII,
 * personal/user data, internal URLs, security misconfig, git history, licensing,
 * repo hygiene, docs) and writes a PASS/FAIL verdict + report into
 * `.publish-readiness/`. This runner reads that verdict and turns it into an exit
 * code so it can gate `npm run publish:public` and CI.
 *
 *   npm run readiness          # audit → print report → exit 0 (PASS) / 1 (FAIL)
 *   npm run readiness -- --json
 *   npm run readiness:fix      # after auditing, auto-apply the mechanical fixes and open a PR
 *
 * Exit codes: 0 = PASS, 1 = FAIL (blockers), 2 = the gate itself could not run
 * (fail-closed — never let an errored scan look like a pass).
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };

const REPO = (() => {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(); }
  catch { return process.cwd(); }
})();
const OUT_DIR = join(REPO, ".publish-readiness");
const LATEST = join(OUT_DIR, "latest.json");
const REPORT = join(OUT_DIR, "report.md");
const TIMEOUT_MS = Number(opt("--timeout", "1200")) * 1000; // 20 min default
const MODEL = opt("--model", "sonnet"); // orchestrator model; workflow agents also run on sonnet

const C = process.stdout.isTTY
  ? { red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` }
  : new Proxy({}, { get: () => (s) => s });

function runClaude(prompt, label) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--permission-mode", "bypassPermissions", "--output-format", "json"];
    if (MODEL) args.push("--model", MODEL);
    console.error(C.dim(`\n▶ ${label} (headless Claude, up to ${TIMEOUT_MS / 60000} min)…\n`));
    // The workflow runs as a background task inside this nested Claude; without
    // this the nested session terminates it at its 600s print-mode ceiling before
    // the verdict is written. 0 = wait indefinitely (our own TIMEOUT_MS is the cap).
    const env = { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" };
    const child = spawn("claude", args, { cwd: REPO, env, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { console.error(C.red(`\n${label}: timed out — killing.`)); child.kill("SIGKILL"); }, TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); console.error(C.red(`${label}: could not launch claude (${e.message})`)); resolve({ ok: false }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, out }); });
  });
}

function fail(code, msg) { console.error(C.red(`\n✖ ${msg}\n`)); process.exit(code); }

// ── audit ───────────────────────────────────────────────────────────────────
// Start from a clean slate so a stale report can never be mistaken for this run.
if (existsSync(LATEST)) rmSync(LATEST, { force: true });

// Default: a single comprehensive review agent — one lightweight context, which
// is fast and reliable. --deep instead runs the multi-agent .claude/workflows
// version (parallel reviewers + adversarial verify); heavier, needs the headroom.
const DEEP = has("--deep");

const WORKFLOW_PROMPT =
  `Run this repository's publish-readiness gate. Invoke it via the Workflow tool, SYNCHRONOUSLY: Workflow({ name: "publish-readiness", run_in_background: false }). Do NOT perform the review yourself. It writes .publish-readiness/latest.json + findings.json + report.md and returns a PASS/FAIL verdict. When it finishes, print "READINESS: PASS" or "READINESS: FAIL (<n> blockers)".`;

const SINGLE_PROMPT =
  `You are the PUBLISH-READINESS gate for the git repository at the current working directory. Decide whether it is SAFE to publish publicly, and write the verdict. Be AI-driven — judge each hit, don't just pattern-match.

WHAT SHIPS: this repo is published as a squashed snapshot of the git-TRACKED tree only (no history, no untracked files). So review \`git ls-files\`. History and untracked files are secondary (noted below).

STEP 1 — SCOPE (a few bounded commands, don't read the tree file-by-file):
  - Private identifiers to hunt for: \`git log --all --format='%an <%ae>' | sort -u\`, \`git config user.name\`/\`user.email\`, \`whoami\`, \`echo $HOME\`, \`git remote -v\` (origin owner/slug).
  - History risks: \`git log --all --diff-filter=A --name-only --pretty=format: -- '*.env' '.env.local' '*.env.local' '*.pem' '.vercel/*'\`.
  - Untracked personal data: \`git ls-files --others --exclude-standard\` filtered to zip/mp4/mov/db/notes/_apps/proof.

STEP 2 — REVIEW the tracked tree across NINE dimensions. Drive this with a FEW targeted \`git grep -nIE '<pattern>'\` sweeps and open (Read) ONLY files a sweep flags. Do NOT read node_modules/lockfiles/build output.
  1. SECRETS — real hardcoded credentials (API keys/tokens: OpenAI sk-, Anthropic sk-ant-, GitHub gh[posur]_, AWS AKIA, GCP AIza, Slack xox, Stripe, Fly; private keys; JWTs; connection strings with inline user:pass; webhook/signing/session secrets; dangerous fallback defaults). A value counts only if it's a REAL literal — not a placeholder (<...>, your-, process.env, example) and not code referencing a secret-named var. BLOCKER. Redact the value in evidence.
  2. PII — the private names/emails/usernames from step 1, phones, addresses, personal handles/hostnames, and absolute local paths embedding a username (/Users/<name>, /Volumes/<name>, /home/<name>, C:\\Users\\<name>). Ignore placeholders (/Users/you, example.com, noreply). BLOCKER for a real personal name/email; WARN for username-bearing paths.
  3. USER DATA — committed user-generated content, seed/fixture data from real records, .db/.sqlite dumps, logs with real emails/requests, screenshots/recordings of real data, uploaded blobs in public/. TRACKED real data = BLOCKER; untracked candidates = WARN ("keep gitignored").
  4. INTERNAL URLS & INFRA — deployment URLs (*.vercel.app, *.fly.dev, custom domains), internal/admin endpoints, bucket/queue/org/project IDs (prj_, team_), and references back to the PRIVATE repo slug (must not appear in a public mirror). WARN, or BLOCKER if it exposes a live control surface.
  5. SECURITY MISCONFIG — public routes that shouldn't be (auth allowlists/bypass), missing authz, debug endpoints, disabled SSRF/TLS checks, wide-open CORS, eval/child_process on user input, backdoor/test accounts, insecure cookie flags, verbose error leakage. BLOCKER for an exploitable hole; WARN for hardening gaps.
  6. GIT HISTORY — using the history risks from step 1: since publish squashes history, findings are WARN with remediation "rotate any exposed credential; the mirror won't contain history" — but a still-valid leaked credential is a BLOCKER (rotate first).
  7. LICENSING — missing LICENSE (WARN), copied third-party code without attribution/incompatible license, CONFIDENTIAL/INTERNAL-ONLY markers.
  8. REPO HYGIENE — .gitignore covers env/.vercel/registries/caches/build output? scratch/ops scripts or internal strategy docs about to ship? .env.example present & complete? README works for an outsider? .github/workflows leak secrets/internal registries? package.json correct?
  9. DOCS & COMMENTS — TODO/FIXME/HACK revealing vulns or internal reasoning, internal ticket/Slack links, coworkers'/customers' names, unreleased plans.

STEP 3 — SELF-VERIFY every BLOCKER candidate before finalizing: re-open the file and confirm it is a genuine risk, not a placeholder/example/test-fixture/already-public value. Drop or downgrade false positives. A false blocker wrongly fails the publish.

STEP 4 — WRITE the verdict (use Bash mkdir + Write). PASS only if ZERO confirmed blockers.
  - \`.publish-readiness/latest.json\`: {"pass": <bool>, "generatedAt": "<date -u +%Y-%m-%dT%H:%M:%SZ>", "commit": "<git rev-parse --short HEAD>", "blockers": [<"file — title — remediation">...], "warnings": [<same>...], "counts": {"blocker": N, "warn": N}}
  - \`.publish-readiness/findings.json\`: the full findings array (each: category, severity blocker|warn|info, title, file, evidence, why, remediation, autofixable — autofixable=true ONLY for mechanical redactions: paths, identifier strings, gitignore/untrack).
  - \`.publish-readiness/report.md\`: verdict banner (PASS ✅ / FAIL ❌), a table of blockers then warnings (file, issue, action), and an ordered "Next steps to reach PASS" list from the blockers' remediations. If PASS, list warnings as optional hardening.
  Confirm all three were written, then print "READINESS: PASS" or "READINESS: FAIL (<n> blockers)".`;

const res = await runClaude(DEEP ? WORKFLOW_PROMPT : SINGLE_PROMPT, DEEP ? "publish-readiness (deep workflow)" : "publish-readiness audit");
if (!res.ok) fail(2, "The readiness gate did not complete (see output above). Failing closed.");
if (!existsSync(LATEST)) fail(2, "Workflow finished but wrote no verdict (.publish-readiness/latest.json missing). Failing closed.");

let verdict;
try { verdict = JSON.parse(readFileSync(LATEST, "utf8")); }
catch (e) { fail(2, `Could not parse .publish-readiness/latest.json (${e.message}). Failing closed.`); }

if (has("--json")) { console.log(JSON.stringify(verdict, null, 2)); }
else if (existsSync(REPORT)) { console.log("\n" + readFileSync(REPORT, "utf8")); }
else {
  console.log(C.bold(`\nPublish readiness: ${verdict.pass ? C.green("PASS ✅") : C.red("FAIL ❌")}`));
  for (const b of verdict.blockers || []) console.log(C.red(`  ✖ ${b}`));
  for (const w of verdict.warnings || []) console.log(C.yellow(`  ⚠ ${w}`));
}

const counts = verdict.counts || {};
console.log(C.bold(`\n${verdict.pass ? C.green("PASS") : C.red("FAIL")} · ${counts.blocker ?? (verdict.blockers || []).length} blocker(s) · ${counts.warn ?? (verdict.warnings || []).length} warning(s)`));
console.log(C.dim(`Full report: ${REPORT.replace(REPO + "/", "")}\n`));

// ── optional fix + PR ─────────────────────────────────────────────────────────
if (has("--fix")) {
  const fixPrompt =
    `Read .publish-readiness/findings.json in this repo. For EVERY finding with "autofixable": true, apply its mechanical remediation across the git-tracked tree (redact absolute local paths to /Users/you etc., replace personal identifier strings with neutral placeholders, add missing .gitignore entries, \`git rm --cached\` any sensitive tracked file). Do NOT touch findings where autofixable is false — those need human judgment; leave them for the report.

Then, if you changed anything: create branch chore/publish-readiness-fixes, commit with message "chore(security): publish-readiness auto-fixes", push with --force-with-lease, and open a PR with \`gh pr create --fill\`. Print the PR URL. If nothing was autofixable, say so and make no commits.`;
  const fx = await runClaude(fixPrompt, "auto-fix + PR");
  if (!fx.ok) console.error(C.yellow("Auto-fix step did not complete cleanly — review manually."));
}

process.exit(verdict.pass ? 0 : 1);
