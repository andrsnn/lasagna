// Font registry + preference model.
//
// The whole app cascades type off four CSS variables. Each one is an "aspect"
// the user can independently re-skin from the Preferences dialog:
//
//   --font-sans     Interface  (buttons, menus, nav, chat chrome)
//   --font-display  Headings   (page titles, section headings)
//   --font-reading  Reading    (messages, notes, the reader column)
//   --font-mono     Monospace  (code, ids, technical details)
//
// A preference is just an option id per aspect. We resolve the id to a
// font-family stack and write it onto <html> — once via the inline boot
// script (so there's no flash before hydration) and again whenever the user
// changes a choice. Stored per-device in localStorage, like the avatar style:
// font availability and taste legitimately differ between a phone and a
// laptop, and it's cosmetic, so it doesn't belong in the synced Settings row.
//
// This module is intentionally free of React and `next/font` imports so it can
// be pulled into both the server layout (for the boot script) and client
// components (for the picker) without dragging a client boundary along.

export type FontCategory = "sans" | "serif" | "mono";

export type FontOption = {
  id: string;
  label: string;
  category: FontCategory;
  /** Full CSS font-family value. Bundled faces reference a `next/font` var. */
  stack: string;
  /** One-line description shown under the option in the picker. */
  note: string;
  /**
   * Optical size multiplier, relative to the historical defaults (System Sans,
   * Source Serif, System Mono = 1). Two faces set at the same point size rarely
   * read at the same visual size - a tall x-height (Inter, Georgia) looks larger
   * than a bookish serif. This factor nudges each face back toward a common
   * apparent size so switching fonts doesn't jump the text. Applied as a
   * companion `--font-<aspect>-scale` CSS variable (see applyFontPrefs).
   * Omit (defaults to 1) for faces that already match the baseline.
   */
  sizeAdjust?: number;
};

// Platform fallbacks. Bundled faces stack in front of these so a missing
// download (or a slow first paint) still lands on something sensible.
const SYSTEM_SANS =
  'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif';
const SYSTEM_SERIF =
  '"Iowan Old Style", Georgia, Cambria, "Times New Roman", Times, serif';
const SYSTEM_MONO =
  'ui-monospace, Menlo, "SFMono-Regular", "Cascadia Code", Consolas, monospace';

export const FONT_OPTIONS: FontOption[] = [
  // --- Sans ---
  {
    id: "system-sans",
    label: "System Sans",
    category: "sans",
    stack: SYSTEM_SANS,
    note: "Your device's native UI font. Fastest, most familiar.",
  },
  {
    id: "inter",
    label: "Inter",
    category: "sans",
    stack: `var(--font-inter), ${SYSTEM_SANS}`,
    note: "Neutral, modern workhorse with a tall x-height.",
    // Tall x-height reads large; pull it back toward the system baseline.
    sizeAdjust: 0.96,
  },
  {
    id: "nunito",
    label: "Nunito Sans",
    category: "sans",
    stack: `var(--font-nunito), ${SYSTEM_SANS}`,
    note: "Soft, rounded, friendly humanist sans.",
    sizeAdjust: 0.97,
  },
  // --- Serif ---
  {
    id: "source-serif",
    label: "Source Serif",
    category: "serif",
    // Iowan Old Style ships on Apple platforms; Source Serif 4 catches
    // everything else. This is the historical default for headings + reading.
    stack: `"Iowan Old Style", var(--font-serif-web), ${SYSTEM_SERIF}`,
    note: "Warm, bookish serif. The original default.",
  },
  {
    id: "lora",
    label: "Lora",
    category: "serif",
    stack: `var(--font-lora), ${SYSTEM_SERIF}`,
    note: "Contemporary serif with calligraphic brushstrokes.",
    sizeAdjust: 0.97,
  },
  {
    id: "georgia",
    label: "Georgia",
    category: "serif",
    stack: SYSTEM_SERIF,
    note: "Classic system serif. No download.",
    // Georgia's large x-height runs noticeably bigger than Source Serif.
    sizeAdjust: 0.96,
  },
  // --- Mono ---
  {
    id: "system-mono",
    label: "System Mono",
    category: "mono",
    stack: SYSTEM_MONO,
    note: "Your device's native monospace. No download.",
  },
  {
    id: "jetbrains",
    label: "JetBrains Mono",
    category: "mono",
    stack: `var(--font-jetbrains), ${SYSTEM_MONO}`,
    note: "Code-friendly mono with generous spacing.",
    sizeAdjust: 0.95,
  },
];

export const FONT_OPTION_BY_ID: Map<string, FontOption> = new Map(
  FONT_OPTIONS.map((o) => [o.id, o])
);

export type FontAspectKey = "interface" | "headings" | "reading" | "mono";

export type FontAspect = {
  key: FontAspectKey;
  label: string;
  hint: string;
  /** CSS custom property this aspect drives. */
  cssVar: string;
  defaultId: string;
  /** Which option categories are offered for this aspect. */
  categories: FontCategory[];
};

export const FONT_ASPECTS: FontAspect[] = [
  {
    key: "interface",
    label: "Interface",
    hint: "Buttons, menus, navigation, and chat chrome.",
    cssVar: "--font-sans",
    defaultId: "system-sans",
    categories: ["sans", "serif"],
  },
  {
    key: "headings",
    label: "Headings",
    hint: "Page titles and section headings.",
    cssVar: "--font-display",
    defaultId: "source-serif",
    categories: ["serif", "sans"],
  },
  {
    key: "reading",
    label: "Reading",
    hint: "Long-form text: messages, notes, and the reader.",
    cssVar: "--font-reading",
    defaultId: "source-serif",
    categories: ["serif", "sans"],
  },
  {
    key: "mono",
    label: "Monospace",
    hint: "Code blocks, ids, and technical details.",
    cssVar: "--font-mono",
    defaultId: "system-mono",
    categories: ["mono"],
  },
];

export type FontPrefs = Record<FontAspectKey, string>;

export const DEFAULT_FONT_PREFS: FontPrefs = Object.fromEntries(
  FONT_ASPECTS.map((a) => [a.key, a.defaultId])
) as FontPrefs;

export const FONT_PREFS_STORAGE_KEY = "fonts.prefs";

/** Resolve an option id to a font-family stack, falling back to the default. */
export function fontStackFor(id: string, defaultId: string): string {
  const opt = FONT_OPTION_BY_ID.get(id) ?? FONT_OPTION_BY_ID.get(defaultId);
  return opt ? opt.stack : "";
}

/** Resolve an option id to its optical size multiplier (1 = baseline). */
export function fontScaleFor(id: string, defaultId: string): number {
  const opt = FONT_OPTION_BY_ID.get(id) ?? FONT_OPTION_BY_ID.get(defaultId);
  return opt?.sizeAdjust ?? 1;
}

/** CSS variable that carries an aspect's optical size multiplier. */
export function scaleVarFor(cssVar: string): string {
  return `${cssVar}-scale`;
}

/** Coerce arbitrary parsed JSON into a valid, fully-populated prefs object. */
export function normalizeFontPrefs(raw: unknown): FontPrefs {
  const next: FontPrefs = { ...DEFAULT_FONT_PREFS };
  if (!raw || typeof raw !== "object") return next;
  const obj = raw as Record<string, unknown>;
  for (const aspect of FONT_ASPECTS) {
    const candidate = obj[aspect.key];
    const opt =
      typeof candidate === "string" ? FONT_OPTION_BY_ID.get(candidate) : undefined;
    // Only accept ids whose category the aspect actually offers, so a stale or
    // hand-edited value can't drop a mono face onto a heading.
    if (opt && aspect.categories.includes(opt.category)) {
      next[aspect.key] = opt.id;
    }
  }
  return next;
}

/** Read + normalize the stored prefs. Safe to call on the server. */
export function readStoredFontPrefs(): FontPrefs {
  if (typeof window === "undefined") return { ...DEFAULT_FONT_PREFS };
  try {
    const raw = window.localStorage.getItem(FONT_PREFS_STORAGE_KEY);
    return normalizeFontPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_FONT_PREFS };
  }
}

/** Write each aspect's resolved stack + size scale onto the document root. */
export function applyFontPrefs(prefs: FontPrefs): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const aspect of FONT_ASPECTS) {
    const id = prefs[aspect.key];
    const stack = fontStackFor(id, aspect.defaultId);
    if (stack) root.style.setProperty(aspect.cssVar, stack);
    const scale = fontScaleFor(id, aspect.defaultId);
    root.style.setProperty(scaleVarFor(aspect.cssVar), String(scale));
  }
}

// Inline <head> script that applies the saved font prefs before React
// hydrates, mirroring the theme boot script. Generated from the registry so
// the id→stack map and aspect→var map never drift from the source of truth.
const FONT_STACKS_JSON = JSON.stringify(
  Object.fromEntries(FONT_OPTIONS.map((o) => [o.id, o.stack]))
);
const FONT_SCALES_JSON = JSON.stringify(
  Object.fromEntries(FONT_OPTIONS.map((o) => [o.id, o.sizeAdjust ?? 1]))
);
const FONT_ASPECTS_JSON = JSON.stringify(
  FONT_ASPECTS.map((a) => ({ v: a.cssVar, d: a.defaultId, k: a.key }))
);

export const fontBootScript = `try{var P={};try{P=JSON.parse(localStorage.getItem('${FONT_PREFS_STORAGE_KEY}')||'{}')||{}}catch(e){}var S=${FONT_STACKS_JSON},Z=${FONT_SCALES_JSON},A=${FONT_ASPECTS_JSON},r=document.documentElement;for(var i=0;i<A.length;i++){var a=A[i],id=P[a.k]||a.d,s=S[id]||S[a.d];if(s)r.style.setProperty(a.v,s);var z=Z[id];if(z==null)z=Z[a.d];if(z!=null)r.style.setProperty(a.v+'-scale',String(z));}}catch(e){}`;
