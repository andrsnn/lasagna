# Artifacts — Mocks Style Guide

## What this app is

**Artifacts** is a tool for building and running tiny AI-generated mini-apps ("artifacts"). The user describes what they want, an LLM produces an HTML document, and the user can save it as a template, configure parameters into instances, and chat to refine it.

Core flows we are mocking:

1. **Home / Desktop** — a feed of saved artifact instances + a way to spawn a new one
2. **Chat composer** — the conversation surface used to build or refine an artifact
3. **Artifact preview** — viewing/running a saved instance with its config side-by-side

The mocks are **single-screen, mobile-first** (390×844, iPhone-class). They render on desktop too, but the canvas is always a phone-sized viewport with rounded device chrome so each option looks like a phone screen.

## Universal rules — every mock MUST follow these

### Mobile-first layout

- **Viewport**: render inside a 390 × 844 phone frame, centered, with light off-canvas backdrop so the device shape pops.
- **Safe areas**: 44px reserved at top (status bar) and 34px at bottom (home indicator).
- **Tap targets**: minimum 44×44px. No tiny icon-only buttons crammed together.
- **Thumb zone**: primary actions (send, new, navigate) sit in the bottom 1/3 of the screen.
- **Bottom tab bar** for navigation across Home / Templates / Chats. Always visible, never disappears, with floating/translucent style.
- **No hover-only affordances**. Every action visible on touch.

### Accessibility / quality bars

- Body text ≥ 15px, UI labels ≥ 12px.
- Color contrast ≥ 4.5:1 for body text against its background.
- Focusable elements have a visible focus ring (2px outline).
- Use real-feeling content: instance names like "Daily AI Brief", "Habit tracker", "Tokyo trip board", "JIRA → Standup", "Recipe sketchpad". Not Lorem Ipsum.
- Show *state*: a streaming assistant message, a recent timestamp, a token meter, a tool call event. The mocks should look alive.

### Implementation rules

- One self-contained HTML file per mock under `./mocks/`. No external network calls, no external CSS/JS. Inline `<style>` and `<script>` only.
- System fonts only: `-apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif` — and `ui-monospace, Menlo` for mono.
- SVG icons inline (small, 18–22px). Do NOT use icon fonts or emoji as primary icons. Sparing use of emoji as content (👋, ✨) is fine.
- Use CSS custom properties for the design tokens of each direction so swapping is easy.
- No animation libraries; use `@keyframes` and `transition` only. Subtle motion on the streaming caret, send-button press, and bottom-sheet entry.
- Tailwind-like utility classes are NOT required — write plain CSS classes scoped to the file.

### Phone frame (use the same shell across all 3 mocks)

Wrap the screen in a div with rounded 50px corners, 12px bezel, a subtle drop shadow, and a centered notch/dynamic-island shape at the top. The frame itself is dark (`#1a1a1f`) regardless of the inside theme.

```html
<div class="phone">
  <div class="phone-frame">
    <div class="phone-island"></div>
    <div class="phone-screen">
      <!-- mock content -->
    </div>
  </div>
</div>
```

## What screens to produce

Each of the three visual directions below MUST be delivered as **one HTML file** showing the **Home / Desktop** screen, because that screen contains the most surface area (header, cards, empty state cues, bottom nav, FAB) and best shows off the visual language. File naming:

- `mocks/01-soft-paper.html` — Direction A
- `mocks/02-bento-os.html` — Direction B
- `mocks/03-vercel-clean.html` — Direction C

A 4th optional file can show the Chat surface in the chosen winner's style, but only after the user picks. For now: produce the three Home mocks.

The Home screen must include:

- Top bar with app name "Artifacts" and a small avatar/menu button on the right.
- A greeting or kicker line ("Good evening, Alex" or "5 live artifacts").
- A primary "New artifact" call-to-action that reads as the most important thing on the screen.
- A scrollable list/grid of 5–6 fake instances, each with: name, source template, last-run timestamp, a small color/visual signature, and a status dot if relevant.
- A "Recently chatted" or "Pinned templates" secondary row.
- Bottom tab bar: Desktop · Templates · Chats (3 items, current tab highlighted).
- At least one piece of *state* per card (last opened, "live", "needs config", token usage, etc.).

---

## Direction A — "Soft Paper" (warm light, editorial)

A reaction *against* the current dark-glass design. Cream paper background, real shadows, generous serif display headings paired with a clean sans body. Feels like reading a beautifully typeset notebook. Cards are warm off-white with soft drop shadows; accent is a single deep ink color.

### Tokens

```
--bg:        #f4efe6   /* warm cream */
--surface:   #fffdf7   /* card */
--surface-2: #ebe4d6
--ink:       #1a1814   /* near-black, warm */
--ink-soft:  #5a5347
--ink-dim:   #8a8273
--accent:    #c8412d   /* ink-red */
--accent-2:  #2d4a3e   /* forest, for secondary chips */
--rule:      #d8cfbe   /* hairline divider */
--shadow-1:  0 1px 2px rgba(40,30,15,0.05), 0 4px 12px rgba(40,30,15,0.06)
--shadow-2:  0 2px 4px rgba(40,30,15,0.08), 0 16px 40px -8px rgba(40,30,15,0.18)
--radius-sm: 10px
--radius-md: 16px
--radius-lg: 22px
```

### Typography

- Display: `"Times New Roman", "Iowan Old Style", Georgia, serif` — used for the app name, page heading, and card titles. Weight 400, slightly tight tracking.
- Body / UI: system sans (15px regular, 14px secondary).
- Numbers: tabular sans for stats and timestamps.

### Components

- **Cards** are off-white rectangles with `--shadow-1`, 1px hairline at `--rule`, radius 16px. On press they lift to `--shadow-2`.
- **Primary button** is solid `--accent` (ink-red) with cream text, radius 999px, 14px label.
- **Bottom nav** is a floating cream pill with `--shadow-2`, sitting 16px above the home indicator. Active tab is the only one with the accent color.
- **Avatar/visual signature**: a small (40×40) hand-drawn-feeling glyph block — gradient between two warm colors, with a 1px ink border.
- **No glassmorphism, no blur, no neon.** This is the antidote to the current look.

---

## Direction B — "Bento OS" (dark, dense, iOS-inspired)

A Concorde-style dashboard. Dark blue-black background, but instead of a single content river it uses a **bento-grid** of differently-sized cards (2-up, 1-up, full-width) showing instances at varying prominence — like the iOS 18 home screen meets a Things 3 list. Vibrant accent, glassy but *crisp* (low blur, high saturation), with a strong typographic hierarchy.

### Tokens

```
--bg:        #0a0d12
--bg-2:      #11151c   /* card base */
--surface:   #161b24
--surface-2: #1c2230
--line:      rgba(255,255,255,0.06)
--line-2:    rgba(255,255,255,0.10)
--ink:       #f1f3f7
--ink-soft:  #aab2c0
--ink-dim:   #6b7382
--accent:    #5b8cff   /* electric blue */
--accent-2:  #ffb454   /* warm amber for "live" status */
--accent-3:  #59e3a7   /* mint for "ok" */
--accent-4:  #ff6b8b   /* coral for warnings */
--radius-sm: 12px
--radius-md: 18px
--radius-lg: 24px
--radius-xl: 28px
```

### Typography

- All system sans, no serif.
- App name and big numbers in 28–32px **800 weight** with `-0.02em` tracking.
- Card titles in 17px 600 weight.
- Labels in 11px **uppercase** with `0.08em` letter-spacing for kicker rows.

### Components

- **Bento grid**: 2-column, 12px gap. Cards have varied heights (1×1, 2×1, 1×2). Each card has its own background tint (subtle gradient using one of the accents at 8% opacity) so the grid feels colorful, not monotone.
- **Status dots** (live = `--accent-2`, ok = `--accent-3`, warn = `--accent-4`) are 8px and pulse subtly.
- **New-artifact card** is a full-width hero tile at the top with a gradient background (`--accent` → `--accent-3`) and the prompt input embedded directly: "Describe an artifact…".
- **Bottom nav** is a translucent 60px-tall bar with `backdrop-filter: blur(20px)`, but only along the bottom safe area — the rest of the page is solid.
- **No aurora blobs, no decorative blurs in the background.** The color comes from the cards themselves.

---

## Direction C — "Vercel Clean" (monochrome, minimal, content-first)

The Linear / shadcn / Vercel-dashboard aesthetic. Near-black canvas, a single neutral gray scale, a thin accent-only-when-needed (electric green or pure white for primary). Tight typography, hairline borders, no shadows, no gradients in the chrome — only in the artifact thumbnails. Think: a beautifully typeset terminal.

### Tokens

```
--bg:        #0a0a0a
--surface:   #111111
--surface-2: #161616
--surface-3: #1d1d1d
--line:      #232323
--line-2:    #2e2e2e
--ink:       #ededed
--ink-soft:  #a1a1a1
--ink-dim:   #707070
--accent:    #00d26a   /* signal green, used sparingly */
--accent-bg: rgba(0,210,106,0.10)
--radius-sm: 6px
--radius-md: 10px
--radius-lg: 14px
```

### Typography

- All `system-ui` sans. Page heading 22px 600. Card title 15px 500. Body 14px 400. Mono-numbers (Menlo) for timestamps and token counts.
- Use a **single accent green** only for: primary CTA, active nav item, "live" indicator.
- All other UI elements are gradations of gray.

### Components

- **List, not grid.** Vertical stack of full-width rows, 64–80px tall, each row separated by a 1px `--line` divider (no rounded card per row — it's one continuous list inside one card). Rows have a 32×32 colored square thumbnail on the left, title + meta on the right, and a chevron on the far right.
- **Primary action**: a fixed bottom-right circular FAB (56×56) in `--accent` with a + glyph. The FAB has a subtle scale-on-press, no other ornament.
- **Bottom nav**: thin (50px), full-bleed, `--surface` background with a 1px top border. Active tab gets the accent color and a 2px top inset bar; others are dim gray. No icons-only — show **icon + label** at 11px.
- **No glass, no blur, no shadows on chrome.** The only "color" is the accent green and the artifact thumbnails. The visual interest comes from typography and density.
- The artifact thumbnail squares can use vibrant gradients (these are previews of the user's apps, so they get a pass to be colorful inside their 32px footprint).

---

## Don'ts (apply to all three)

- **Don't reproduce the current design.** No purple→blue aurora gradient backgrounds, no `accent-gradient` violet→blue button, no glass everywhere. Each direction is intentionally a different aesthetic family.
- **Don't use stock SaaS illustrations or 3D blobs.** SVG glyphs and color blocks only.
- **Don't pad with whitespace at the expense of information density** — the home screen should feel *full* of the user's stuff, not empty.
- **Don't show desktop-only patterns** (sidebar, multi-pane, hover menus). This is mobile.
- **Don't use emoji as button icons** — content-level emoji is fine but not for nav/actions.

## Output

Three HTML files, each with a phone-frame mock of the Home screen. Saved at:

- `mocks/01-soft-paper.html`
- `mocks/02-bento-os.html`
- `mocks/03-vercel-clean.html`

Each gets a screenshot saved next to it (PNG, same basename).
