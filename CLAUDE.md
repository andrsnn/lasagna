# Project guidance

## Writing style

- Never use em dashes (—). Always use a regular hyphen (-) instead.

## Mobile scrolling (every new full-page view MUST scroll)

This app is used heavily on phones, and long views that silently clip their
bottom content are a recurring bug. Whenever you add or edit a full-page view,
verify it scrolls on a short (mobile) viewport before you're done.

The trap: the app shell and several section layouts give the page a fixed
height and wrap children in a NON-scrolling container. For example
`app/admin/layout.tsx` renders `<div className="min-h-0 flex-1 overflow-hidden">`
around every admin page - so each page is responsible for its OWN scroll region.
A page whose root is just `mx-auto max-w-2xl px-4` looks fine until its content
exceeds the viewport, then the overflow is clipped and the bottom is
unreachable.

Rules:
- A full-page view's scroll root must carry `h-full` + `overflow-y-auto` (see
  `app/admin/accounts/page.tsx` / `app/admin/errors/page.tsx` for the pattern:
  `mx-auto flex h-full max-w-* flex-col overflow-y-auto p-4`). Don't rely on the
  document/body scrolling - a parent with `overflow-hidden` and a fixed height
  will swallow it.
- Add bottom padding (e.g. `pb-16`) so the last element clears the fixed bottom
  nav (`app/components/bottom-nav.tsx`) and the iOS home indicator.
- When a container is `flex-1 overflow-hidden`, pair it with `min-h-0` so the
  scroll child can actually shrink and scroll.
- Verify on a narrow, short viewport: the last section must be reachable.

## Platform vs product (DO NOT overfit)

This repo is a **platform** for building apps, not a single product. The codebase
implements generic, domain-agnostic capabilities; specific products are built ON
the platform by users prompting the model in the app builder (the artifact SDK +
codegen flow), and persist as per-app data/artifacts - NOT as edits to this repo.

Rules:
- **Never bake a specific use case into a generic surface.** The "Research" app
  (`app/components/research-app-view.tsx`, `app/api/research/structured/*`) is a
  generic table of `{query, columns, records}` shared by EVERY research app. Do
  not add job-search (resume/outreach/"why I want to work here"), CRM, sales, or
  any other domain feature to it. If a change only makes sense for one domain,
  it does not belong in platform code.
- **Product asks → build them as an artifact app**, by prompting the model
  through the builder to generate/modify the app's code using the artifact SDK
  (`artifact.query({schema, webSearch})`, `artifact.state`, `artifact.download`,
  `artifact.defineSchedule`, `artifact.task`, ...). Per-app data lives in
  `app.state`; product code lives in the app's designer files, not this repo.
- **Only modify platform code to add GENERIC capability** - something that helps
  many/all apps regardless of subject (e.g. a new SDK primitive, a generic table
  op, the build/share pipeline). When in doubt, ask: "would a totally different
  research app (recipes, competitors, papers) want this?" If no, it's a product
  feature - don't put it here.
- A user request like "add outreach to my company list" is a request to build a
  PRODUCT on the platform (prompt the model to generate it), not to hardcode it
  into the generic template.
