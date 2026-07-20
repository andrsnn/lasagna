export const meta = {
  name: 'publish-readiness',
  description:
    'Decide whether this repo is safe to publish publicly. Reviews the tree that would actually ship across nine dimensions (secrets, PII, personal/user data, internal URLs & infra, security misconfig, git-history hygiene, licensing, repo cleanliness, docs/comments), adversarially verifies each finding to kill false positives, and emits a single PASS/FAIL verdict with concrete next steps. Persists the report to .publish-readiness/.',
  whenToUse:
    'Before making a private repo public, and as the gate the publish script runs. Invoked by `npm run readiness` / `npm run publish:public`.',
  phases: [
    { title: 'Scope', detail: 'Gather the facts every reviewer needs: what ships, the private identifiers to hunt for, and history risks.' },
    { title: 'Scan', detail: 'One reviewer per dimension inspects the shipping tree in parallel.' },
    { title: 'Verify', detail: 'A skeptic tries to refute every blocker/warn finding so false positives never reach the report.' },
    { title: 'Report', detail: 'Synthesize a PASS/FAIL verdict with next steps and write it to .publish-readiness/.' },
  ],
}

// ── schemas ─────────────────────────────────────────────────────────────────
const SCOPE = {
  type: 'object',
  required: ['publishModel', 'identifiers', 'historyRisks', 'untrackedPersonal', 'trackedSummary'],
  properties: {
    publishModel: { type: 'string', description: 'How this repo is published (e.g. "squashed tracked-tree snapshot") and therefore what actually ships.' },
    identifiers: {
      type: 'object',
      description: 'The private identifiers reviewers must hunt for — derived at runtime, never hardcoded.',
      properties: {
        names: { type: 'array', items: { type: 'string' } },
        emails: { type: 'array', items: { type: 'string' } },
        usernames: { type: 'array', items: { type: 'string' } },
        homePaths: { type: 'array', items: { type: 'string' } },
        privateRepoSlugs: { type: 'array', items: { type: 'string' } },
      },
    },
    historyRisks: { type: 'array', items: { type: 'string' }, description: 'Sensitive files/strings ever committed (still in history).' },
    untrackedPersonal: { type: 'array', items: { type: 'string' }, description: 'Untracked working-tree paths that look like personal/user data.' },
    trackedSummary: { type: 'string', description: 'Short inventory of the tracked tree: languages, top-level dirs, config/infra files, docs.' },
  },
}

const FINDINGS = {
  type: 'object',
  required: ['category', 'findings'],
  properties: {
    category: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'title', 'file', 'evidence', 'why', 'remediation', 'autofixable'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'warn', 'info'] },
          title: { type: 'string' },
          file: { type: 'string', description: 'path[:line], or "(history)" / "(repo)" for non-file findings' },
          evidence: { type: 'string', description: 'The exact match — REDACT any actual secret to first/last few chars.' },
          why: { type: 'string', description: 'Why this is unsafe to publish.' },
          remediation: { type: 'string', description: 'The concrete action to make it safe.' },
          autofixable: { type: 'boolean', description: 'True only for mechanical redactions (paths, identifiers, gitignore/untrack). False for judgment calls.' },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['keep', 'reason'],
  properties: {
    keep: { type: 'boolean', description: 'False if this is a false positive / not actually a publish risk.' },
    severity: { type: 'string', enum: ['blocker', 'warn', 'info'], description: 'Corrected severity if the reviewer over/under-rated it.' },
    reason: { type: 'string' },
  },
}

const REPORT = {
  type: 'object',
  required: ['pass', 'summary', 'blockers', 'warnings', 'nextSteps'],
  properties: {
    pass: { type: 'boolean', description: 'PASS only if there are ZERO confirmed blockers.' },
    summary: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' }, description: 'Ordered, concrete actions to reach PASS.' },
  },
}

// ── review dimensions ────────────────────────────────────────────────────────
// The nine concerns are grouped into four parallel reviewers (concurrency cap is
// ~6, so four run in a single wave) — each still reports per its sub-concerns.
const DIMENSIONS = [
  { key: 'secrets-pii-data', prompt:
    `Review three concerns and report a finding for each hit:
(a) SECRETS — hardcoded credentials in the shipping tree: API keys/tokens (OpenAI, Anthropic, GitHub, AWS AKIA, GCP AIza, Slack xox, Stripe, Fly), private keys, JWTs, connection strings with inline user:pass, webhook/signing/session secrets, and DANGEROUS FALLBACK defaults ("uses a predictable default if unset"). A value is a finding only if it's a REAL literal — not a placeholder (<...>, your-, process.env, example) and not merely code referencing a secret-named variable. Blocker for any real secret; REDACT the value in evidence.
(b) PII — the private names/emails/usernames from the identifiers above, phone numbers, addresses, personal handles/hostnames, and absolute local paths embedding a username (/Users/<name>, /Volumes/<name>, /home/<name>, C:\\Users\\<name>). Ignore placeholders (/Users/you, example.com, noreply). Blocker for a real personal name/email; warn for username-bearing paths.
(c) USER DATA — committed user-generated content, seed/fixture data from real records, .db/.sqlite dumps, logs with real emails/requests, screenshots/recordings showing real data, uploaded blobs/media in public/. TRACKED real data = blocker; the untracked candidates listed above won't ship (tracked-only publish) so note them as warn ("keep gitignored").` },
  { key: 'infra-security', prompt:
    `Review two concerns:
(a) INTERNAL URLS & INFRA — deployment URLs (*.vercel.app, *.fly.dev, custom domains), internal/admin endpoints, internal API bases, bucket/queue/app/org/project names and IDs (prj_, team_), internal tool bridges, and references back to the PRIVATE repo slugs above (must not appear in a public mirror). Warn mostly; blocker if it exposes a live internal control surface.
(b) SECURITY MISCONFIG (code) — routes public that shouldn't be (auth allowlists/bypasses), missing authz, debug/dev endpoints left on, disabled SSRF/TLS verification, wide-open CORS, eval/child_process on user input, backdoor/test accounts or seeded admin creds, insecure cookie flags, verbose error/stack-trace leakage. Blocker for an exploitable hole; warn for hardening gaps. Concrete remediation each.` },
  { key: 'history-licensing', prompt:
    `Review two concerns:
(a) GIT HISTORY — using the history risks above plus your own \`git log\` inspection: secrets/PII/data ever committed then removed, personal author identities, oversized blobs, commit messages naming internal systems/people/incidents. Publish squashes to one clean commit, so most history findings are WARN ("rotate any exposed credential; the mirror won't contain history") — but a STILL-VALID leaked credential in history is a BLOCKER (rotate before publishing).
(b) LICENSING — is there a LICENSE (absence = all-rights-reserved, usually unintended → warn)? copied third-party code without attribution / incompatible license? files marked CONFIDENTIAL/INTERNAL-ONLY? copyright headers with personal/employer info?` },
  { key: 'hygiene-docs', prompt:
    `Review two concerns:
(a) REPO HYGIENE — does .gitignore cover env/.vercel/local registries/caches/build output? scratch/ops scripts or internal strategy docs about to ship? is .env.example present and complete so an outsider can run it? does README work for an outsider (no private-resource refs)? do .github/workflows reference secrets/internal registries/self-hosted runners? is package.json correct (private flag, repository/author, name)?
(b) DOCS & COMMENTS — TODO/FIXME/HACK revealing vulnerabilities or internal reasoning, internal ticket/Slack/Jira links, coworkers'/customers' names, unreleased plans or internal-only context. Warn with a suggested edit.` },
]

// ── run ─────────────────────────────────────────────────────────────────────
phase('Scope')
const scope = await agent(
  `You are scoping a PUBLISH-READINESS review of the repo at the current working directory.
Gather the facts every downstream reviewer needs. Use Bash (git, grep, ls, whoami) and Read.

1. Determine the publish model: this repo is published as a SQUASHED snapshot of the git-TRACKED tree (no history, no untracked files). So "what ships" = \`git ls-files\`. State that.
2. Derive the private identifiers to hunt for — DO NOT invent, read them from the machine:
   - names/emails: \`git log --all --format='%an <%ae>' | sort -u\` plus \`git config user.name/user.email\`
   - usernames/homePaths: \`whoami\`, \`echo $HOME\`, and any /Users|/Volumes|/home paths in tracked files
   - privateRepoSlugs: \`git remote -v\` (the owner/name of origin)
3. historyRisks: run \`git log --all --diff-filter=A --name-only --pretty=format: -- '*.env' '.env.local' '*.env.local' '*.pem' '.vercel/*'\` and note anything sensitive ever committed.
4. untrackedPersonal: \`git ls-files --others --exclude-standard\` filtered to things that look like personal data/media (zip, mp4, mov, db, notes, _apps/, proof/).
5. trackedSummary: a short inventory of the tracked tree (top-level dirs, infra/config files, docs) — from \`git ls-files | sed 's:/.*::' | sort -u\` and a glance at the top level, NOT by reading files.
Run those specific commands, then return. Be quick (~10 tool calls); do not explore the tree file-by-file.`,
  { label: 'scope', model: 'sonnet', schema: SCOPE },
)

const idBlock = JSON.stringify(scope.identifiers)
const ctx =
  `\n\nPUBLISH MODEL: ${scope.publishModel}\nPRIVATE IDENTIFIERS TO HUNT FOR: ${idBlock}\nHISTORY RISKS: ${JSON.stringify(scope.historyRisks)}\nUNTRACKED PERSONAL CANDIDATES: ${JSON.stringify(scope.untrackedPersonal)}\nTRACKED TREE: ${scope.trackedSummary}\n\nOnly the git-TRACKED tree ships. Report findings with redacted evidence, a clear why, a concrete remediation, and autofixable=true ONLY for mechanical redactions (paths, identifier strings, gitignore/untrack). Be precise — a false blocker wrongly fails the publish.\n\nWORK FAST AND BOUNDED — this is a time-boxed gate, not an exhaustive audit. Drive the review with a FEW targeted \`git grep -nIE '<pattern>'\` sweeps across the tracked tree (that is your primary tool), and open with Read ONLY the specific files a grep flags. Do NOT read the tree file-by-file, do NOT open node_modules/lockfiles/build output. Aim to finish within ~15 tool calls; if a sweep is clean, record no finding and move on.`

phase('Scan')
const scans = await parallel(
  DIMENSIONS.map((d) => () =>
    agent(`Review dimension: ${d.key}.\n${d.prompt}${ctx}`, { label: `scan:${d.key}`, phase: 'Scan', model: 'sonnet', schema: FINDINGS })),
)

// Flatten, keeping the dimension with each finding.
const allFindings = scans
  .filter(Boolean)
  .flatMap((s) => (s.findings || []).map((f) => ({ ...f, category: s.category })))

phase('Verify')
// Only BLOCKER candidates get the adversarial pass — they alone decide PASS/FAIL,
// and this keeps the gate fast (a clean repo has ~0). Warnings pass through
// unverified: they don't fail the gate, so a false-positive warning is cheap.
const verified = await pipeline(
  allFindings.filter((f) => f.severity === 'blocker'),
  (f) =>
    agent(
      `Adversarially verify this publish-readiness BLOCKER. Look at the actual file/evidence and try to REFUTE it — is it a placeholder, example, test fixture, already-public value, or a false positive? Set keep=false if it is not a genuine risk to publishing publicly. If it's real but over-rated, downgrade the severity to warn/info.\n\nFinding: ${JSON.stringify(f)}${ctx}`,
      { label: `verify:${f.category}`, phase: 'Verify', model: 'sonnet', schema: VERDICT },
    ).then((v) => ({ ...f, verify: v })),
)

const confirmed = verified
  .filter(Boolean)
  .filter((f) => f.verify?.keep !== false)
  .map((f) => ({ ...f, severity: f.verify?.severity || f.severity }))

const blockers = confirmed.filter((f) => f.severity === 'blocker')
// Warnings = original warns + any blocker the skeptic downgraded to warn.
const warnings = [
  ...allFindings.filter((f) => f.severity === 'warn'),
  ...confirmed.filter((f) => f.severity === 'warn'),
]
log(`Confirmed ${blockers.length} blocker(s); ${warnings.length} warning(s) from ${allFindings.length} raw finding(s).`)

phase('Report')
const report = await agent(
  `You are the final gate of a publish-readiness review. Decide PASS or FAIL and write the report.

PASS only if there are ZERO confirmed blockers. Warnings do not fail the gate but must be listed.

Confirmed BLOCKERS (${blockers.length}): ${JSON.stringify(blockers)}
Confirmed WARNINGS (${warnings.length}): ${JSON.stringify(warnings)}
Publish model: ${scope.publishModel}

Then, using the Write/Bash tools, PERSIST the report to the repo so the npm gate can read it:
  1. Create directory .publish-readiness/ (mkdir -p).
  2. Write .publish-readiness/latest.json — exactly: {"pass": <bool>, "generatedAt": "<ISO from \`date -u +%Y-%m-%dT%H:%M:%SZ\`>", "commit": "<git rev-parse --short HEAD>", "blockers": [<one string per blocker: "file — title — remediation">], "warnings": [<same shape>], "counts": {"blocker": N, "warn": N}}.
  3. Write .publish-readiness/findings.json — the full confirmed findings array (each: category, severity, title, file, evidence, why, remediation, autofixable). This drives the optional auto-fix step.
  4. Write .publish-readiness/report.md — a readable report: verdict banner (PASS ✅ / FAIL ❌), a table of blockers then warnings (file, issue, action), and an ordered "Next steps to reach PASS" list drawn from the blockers' remediations. If PASS, say so and list warnings as optional hardening.
Confirm all three files were written.

Finally, return the structured verdict (pass, summary, blockers as strings, warnings as strings, ordered nextSteps).`,
  { label: 'report', model: 'sonnet', schema: REPORT },
)

return report
