# Job Search Tracker (example product app)

This is a **product app built ON the platform**, not platform code. It is the
job-search tool rebuilt as a regular artifact (it renders in the sandboxed
iframe and uses only the public artifact SDK), instead of being baked into the
generic Research template. See the repo's `CLAUDE.md` ("Platform vs product").

It lives here as a **reference + backup** on a branch. It is meant to be loaded
as an app via **Import** (home header) - it is not wired into the host build
(`examples` is excluded in `tsconfig.json`).

## What it does
- Add a company (+ optional role) → AI-researches it and fills the row
  (`what they do`, `why a fit`, `contact`, `link`, `open roles`, `stage`, `comp`).
- Per-row drawer: draft **outreach** and a **"why I want to work here"**, both
  editable and saved.
- **Fill gaps**: parallel `artifact.batchQuery` to complete empty cells.
- **Resume**: saved once in `artifact.state`, reused for every outreach.
- **Export**: `artifact.download` of the whole dataset.

## SDK primitives used
`artifact.ready`, `artifact.state.get/set`, `artifact.query({schema, webSearch})`,
`artifact.batchQuery`, `artifact.download`.

## Files
- `index.html` / `manifest.json` / `styles.css`
- `main.tsx` (entry) · `App.tsx` (orchestrator) · `types.ts` · `sdk.ts` (artifact wrappers + prompts)
- `components/Toolbar.tsx` · `components/CompanyTable.tsx` · `components/RowDrawer.tsx`

## How to load it
Build it into an app bundle and Import it (or use the host's Import button on the
home page). The bundle shape is `{ designer: { files, entry: "main.tsx", manifest }, app }`.
