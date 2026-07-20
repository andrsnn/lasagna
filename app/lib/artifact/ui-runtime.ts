// Widget design system delivered INTO the artifact iframe.
//
// Three exports, consumed by the build pipeline (app/lib/artifact/build.ts):
//
//   WIDGET_TOKENS_CSS  — CSS custom properties + base classes injected into the
//                        widget shell's <head>. Mirrors the Soft Paper palette in
//                        app/globals.css (the iframe is sandboxed and cannot
//                        import the parent stylesheet, so the values are copied;
//                        scripts/verify-widget-ui.ts guards against drift).
//                        Theme-aware: light + dark are both emitted so a widget
//                        stays readable whichever mode the host is in.
//
//   ARTIFACT_BASE_CSS  — themed default stylesheet injected into FULL apps (not
//                        widgets). Gives an otherwise-unstyled artifact the Soft
//                        Paper look (paper background, ink text, ink-red links,
//                        themed form controls) instead of raw browser defaults
//                        (blue links, blue checkboxes, black-on-white). Authored
//                        at zero specificity via :where() so any style the app
//                        writes itself wins.
//
//   ARTIFACT_UI_SOURCE — source of the virtual "@artifact/ui" module. The esbuild
//                        VFS resolver serves this when an artifact imports
//                        "@artifact/ui", so widgets/apps compose from the same
//                        primitives + hooks instead of re-deriving inline styles.
//                        It is tree-shaken: unused exports cost nothing.
//
// THEME SIGNAL — the sandboxed iframe can't read the host's `.dark` class, so the
// host reports the active theme two ways: `@media (prefers-color-scheme: dark)`
// (a zero-config fallback that already matches the app's default of following the
// OS) and an explicit `data-artifact-theme="light|dark"` attribute the SDK stamps
// on <html> from the init handshake / theme-changed message (covers a manual
// toggle that diverges from the OS). The attribute selector outranks the media
// query, so an explicit host choice always wins.
//
// Everything here is ADDITIVE. Existing artifacts that never reference the tokens
// or import "@artifact/ui" build and render exactly as before.

/** One resolved Soft Paper palette (colors only; typography/spacing are shared
 *  across themes). Light + dark mirror the `:root` / `.dark` blocks in
 *  app/globals.css. */
type Palette = {
  bg: string;
  surface: string;
  surface2: string;
  ink: string;
  inkSoft: string;
  inkDim: string;
  accent: string;
  accent2: string;
  rule: string;
};

const LIGHT_PALETTE: Palette = {
  bg: "#f4efe6",
  surface: "#fffdf7",
  surface2: "#ebe4d6",
  ink: "#1a1814",
  inkSoft: "#5a5347",
  inkDim: "#8a8273",
  accent: "#c8412d",
  accent2: "#2d4a3e",
  rule: "#d8cfbe",
};

const DARK_PALETTE: Palette = {
  bg: "#161412",
  surface: "#211e1a",
  surface2: "#2c2823",
  ink: "#f1ece2",
  inkSoft: "#c4baa6",
  inkDim: "#8a8273",
  accent: "#e07358",
  accent2: "#6fae93",
  rule: "#3a342c",
};

const FONT_DISPLAY = `"Iowan Old Style", "Times New Roman", Georgia, serif`;
const FONT_SANS = `ui-sans-serif, -apple-system, BlinkMacSystemFont, "Inter", system-ui, "Segoe UI", Roboto, sans-serif`;
const FONT_MONO = `ui-monospace, Menlo, "SFMono-Regular", monospace`;

/** Emit the `--w-*` color declarations for one palette (used four times below:
 *  light default, OS-dark fallback, explicit dark, explicit light). */
function widgetColorVars(p: Palette): string {
  return [
    `  --w-bg: ${p.bg};`,
    `  --w-surface: ${p.surface};`,
    `  --w-surface-2: ${p.surface2};`,
    `  --w-ink: ${p.ink};`,
    `  --w-ink-soft: ${p.inkSoft};`,
    `  --w-ink-dim: ${p.inkDim};`,
    `  --w-accent: ${p.accent};`,
    `  --w-accent-2: ${p.accent2};`,
    `  --w-rule: ${p.rule};`,
  ].join("\n");
}

/**
 * Design tokens + base widget classes. The `--w-*` prefix avoids colliding with
 * any vars an existing widget already defines. Both themes are emitted; see the
 * THEME SIGNAL note above for how the active one is selected.
 */
export const WIDGET_TOKENS_CSS = /* css */ `
:root {
  color-scheme: light dark;
${widgetColorVars(LIGHT_PALETTE)}

  --w-font-display: ${FONT_DISPLAY};
  --w-font-sans: ${FONT_SANS};
  --w-font-mono: ${FONT_MONO};

  --w-space-1: 4px;
  --w-space-2: 8px;
  --w-space-3: 12px;
  --w-space-4: 16px;
  --w-space-5: 24px;
  --w-radius: 12px;

  --w-text-xs: 11px;
  --w-text-sm: 13px;
  --w-text-base: 15px;
  --w-text-lg: 20px;
  --w-text-xl: 28px;
  --w-text-2xl: 40px;
  --w-text-3xl: 56px;
}

/* Follow the OS when the host hasn't stamped an explicit theme (the app's own
   default is "match the OS", so this alone is correct for most users). */
@media (prefers-color-scheme: dark) {
  :root:not([data-artifact-theme="light"]) {
${widgetColorVars(DARK_PALETTE)}
  }
}

/* Explicit host theme (attribute selector outranks the media query above, so a
   manual toggle that diverges from the OS still wins). */
:root[data-artifact-theme="dark"] {
${widgetColorVars(DARK_PALETTE)}
}
:root[data-artifact-theme="light"] {
${widgetColorVars(LIGHT_PALETTE)}
}

.w-root {
  box-sizing: border-box;
  height: 100%;
  color: var(--w-ink);
  font-family: var(--w-font-sans);
  -webkit-font-smoothing: antialiased;
}
.w-root *, .w-root *::before, .w-root *::after { box-sizing: border-box; }

/* Hierarchy is weight + size + spacing, never faded text. A subdued label is
   small + uppercase + letter-spaced, NOT low-opacity. */
.w-label {
  margin: 0;
  font-size: var(--w-text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--w-ink-soft);
}
.w-stat {
  font-family: var(--w-font-display);
  font-weight: 600;
  line-height: 1;
  color: var(--w-accent);
  font-variant-numeric: tabular-nums;
}
.w-sub { margin: 0; font-size: var(--w-text-sm); color: var(--w-ink-soft); }
.w-row { display: flex; align-items: center; gap: var(--w-space-2); }
.w-list { display: flex; flex-direction: column; gap: var(--w-space-2); margin: 0; padding: 0; list-style: none; }
.w-list > li { display: flex; align-items: baseline; gap: var(--w-space-2); font-size: var(--w-text-sm); color: var(--w-ink); }
.w-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: var(--w-text-xs);
  font-weight: 600;
  background: var(--w-surface);
  border: 1px solid var(--w-rule);
  color: var(--w-ink);
  white-space: nowrap;
}
`;

/** Emit the `--artifact-*` color declarations for one palette. These vars back
 *  the base element rules below AND are available for an app to reference
 *  directly (e.g. `color: var(--artifact-ink)`). */
function appColorVars(p: Palette): string {
  return [
    `  --artifact-bg: ${p.bg};`,
    `  --artifact-surface: ${p.surface};`,
    `  --artifact-surface-2: ${p.surface2};`,
    `  --artifact-ink: ${p.ink};`,
    `  --artifact-ink-soft: ${p.inkSoft};`,
    `  --artifact-ink-dim: ${p.inkDim};`,
    `  --artifact-accent: ${p.accent};`,
    `  --artifact-accent-2: ${p.accent2};`,
    `  --artifact-border: ${p.rule};`,
  ].join("\n");
}

/**
 * Themed default stylesheet for FULL apps (not widgets — those get
 * WIDGET_TOKENS_CSS). Injected into the app iframe's <head> BEFORE the app's own
 * CSS so an otherwise-unstyled artifact inherits the Soft Paper look instead of
 * raw browser defaults (blue links, blue form controls, black-on-white).
 *
 * Every rule is written at ZERO specificity via `:where(...)`, so the moment the
 * app sets its own `body { background }`, `a { color }`, etc., that rule wins -
 * these are true defaults, not overrides. Theme selection matches the widget
 * tokens (see the THEME SIGNAL note at the top of this file).
 */
export const ARTIFACT_BASE_CSS = /* css */ `
:root {
  color-scheme: light;
${appColorVars(LIGHT_PALETTE)}
  --artifact-font-display: ${FONT_DISPLAY};
  --artifact-font-sans: ${FONT_SANS};
  --artifact-font-mono: ${FONT_MONO};
}
@media (prefers-color-scheme: dark) {
  :root:not([data-artifact-theme="light"]) {
    color-scheme: dark;
${appColorVars(DARK_PALETTE)}
  }
}
:root[data-artifact-theme="dark"] {
  color-scheme: dark;
${appColorVars(DARK_PALETTE)}
}
:root[data-artifact-theme="light"] {
  color-scheme: light;
${appColorVars(LIGHT_PALETTE)}
}

:where(html) {
  background: var(--artifact-bg);
  color: var(--artifact-ink);
  font-family: var(--artifact-font-sans);
  -webkit-text-size-adjust: 100%;
}
:where(body) {
  margin: 0;
  color: inherit;
  font-family: inherit;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
:where(h1, h2, h3, h4, h5, h6) {
  font-family: var(--artifact-font-display);
  color: var(--artifact-ink);
  line-height: 1.2;
}
:where(a) {
  color: var(--artifact-accent);
  text-decoration-color: color-mix(in oklab, var(--artifact-accent) 45%, transparent);
}
:where(a:hover) { text-decoration-color: currentColor; }
:where(button, input, select, textarea, optgroup) {
  font-family: inherit;
  font-size: inherit;
  color: inherit;
}
:where(input, textarea, select, button, [type="checkbox"], [type="radio"], [type="range"], progress) {
  accent-color: var(--artifact-accent);
}
:where(::placeholder) { color: var(--artifact-ink-dim); opacity: 1; }
:where(hr) { border: none; border-top: 1px solid var(--artifact-border); }
:where(:focus-visible) {
  outline: 2px solid color-mix(in oklab, var(--artifact-accent) 60%, transparent);
  outline-offset: 2px;
}
::selection { background: color-mix(in oklab, var(--artifact-accent) 22%, transparent); }
`;

/** Marker inside the injected base-CSS <style> so a second composition pass
 *  (e.g. composeArtifactSrcdoc when creating a share) detects and skips it. */
export const ARTIFACT_BASE_CSS_SENTINEL = "__artifact_base_css__";

/** The ready-to-inject <style> tag for ARTIFACT_BASE_CSS, sentinel-wrapped. */
export const ARTIFACT_BASE_CSS_TAG = `<style>/*${ARTIFACT_BASE_CSS_SENTINEL}*/${ARTIFACT_BASE_CSS}</style>`;

/**
 * Source of the virtual "@artifact/ui" module. Authored as TSX, compiled by
 * esbuild (tsx loader, jsx: automatic) when bundled into an artifact. Keep it
 * free of template literals / ${} so it survives being embedded in this file's
 * own template literal without escaping.
 */
export const ARTIFACT_UI_SOURCE = /* tsx */ `
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

// The host injects window.artifact before any artifact code runs.
const A = () => (typeof window !== "undefined" ? window.artifact : undefined);

const PresetContext = createContext("M");

// ----- hooks -----------------------------------------------------------------

// Current widget size preset ("S" | "M" | "L" | "W"). "M" outside widget mode.
export function useWidgetSize() {
  const read = () => {
    const a = A();
    return (a && a.widgetSize && a.widgetSize.preset) || "M";
  };
  const [preset, setPreset] = useState(read);
  useEffect(() => {
    const a = A();
    if (!a || !a.onWidgetResize) return;
    a.onWidgetResize(() => setPreset(read()));
  }, []);
  return preset;
}

// Persistent, cross-frame-synced state. Reads the saved value on mount, keeps
// in sync when a sibling frame writes the same key, and persists on set.
// Replaces the hand-written state.get + onStateMerged dance.
export function useArtifactState(key, initial) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    let alive = true;
    const a = A();
    if (!a) return;
    a.state.get(key).then((saved) => {
      if (alive && saved !== undefined && saved !== null) setValue(saved);
    });
    a.onStateMerged((k, v) => {
      if (alive && k === key) setValue(v);
    });
    return () => { alive = false; };
  }, [key]);
  const set = useCallback((next) => {
    setValue((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      const a = A();
      if (a) a.state.set(key, resolved);
      return resolved;
    });
  }, [key]);
  return [value, set];
}

// Declared data (SDK v2): THE hook for entries declared in manifest.state.
// The host owns fetching, validation, identity merge, persistence, and the
// lastRefreshedAt clock; this hook only observes. Snapshot is a value, not an
// event stream - duplicate deliveries are unobservable, so there is nothing
// to get wrong about idempotency, registration timing, or first paint.
export function useArtifact(key) {
  const [snap, setSnap] = useState({ data: null, status: "idle", lastRefreshedAt: null, error: null });
  useEffect(() => {
    const a = A();
    if (!a || !a.entries) return;
    return a.entries.watch(key, setSnap);
  }, [key]);
  const refresh = useCallback(() => {
    const a = A();
    if (!a || !a.entries) return;
    // Surface rejection locally too: the host writes failures to the entry
    // meta (which the watcher above re-renders from), but if even that write
    // can't reach us the snapshot must still say SOMETHING - a refresh that
    // fails invisibly reads as "the button does nothing".
    a.entries.refresh(key).catch((e) => {
      setSnap((prev) => ({
        ...prev,
        status: "error",
        error: e && e.message ? e.message : String(e),
      }));
    });
  }, [key]);
  return {
    data: snap.data,
    status: snap.status,
    lastRefreshedAt: snap.lastRefreshedAt,
    error: snap.error,
    refresh,
  };
}

// Declared "value" entries: read/write a user-owned value with cross-frame
// sync. Sugar over useArtifactState with the same signature.
export function useArtifactValue(key, initial) {
  return useArtifactState(key, initial);
}

// Durable query: survives the user leaving mid-fetch. Restores the last result
// for instant first paint, repaints from onQueryResult (fresh OR recovered),
// persists every result, and stays idempotent. refresh() kicks a new run.
export function useArtifactTask(key, prompt, opts) {
  const ref = useRef(null);
  if (!ref.current) {
    const a = A();
    ref.current = a && a.task ? a.task(key, prompt, opts) : null;
  }
  const ctrl = ref.current;
  const [snap, setSnap] = useState(() => (ctrl ? ctrl.get() : { data: undefined, loading: false, error: null }));
  useEffect(() => {
    if (!ctrl) return;
    return ctrl.subscribe(setSnap);
  }, [ctrl]);
  return {
    data: snap.data,
    loading: snap.loading,
    error: snap.error,
    refresh: ctrl ? ctrl.refresh : () => {},
  };
}

// ----- primitives ------------------------------------------------------------

// Root wrapper for a widget. Reads the preset and shares it via context so
// children adapt without each widget re-branching on size.
export function WidgetShell({ children, padded = true, style }) {
  const preset = useWidgetSize();
  return (
    <PresetContext.Provider value={preset}>
      <div className="w-root" data-preset={preset} style={{ padding: padded ? "var(--w-space-4)" : 0, ...(style || {}) }}>
        {children}
      </div>
    </PresetContext.Provider>
  );
}

// Big-number + caption. The canonical glanceable widget unit. Scales with size.
export function Stat({ value, label, sub, accent = true, style }) {
  const preset = useContext(PresetContext);
  const valueSize = preset === "L" ? "var(--w-text-3xl)" : "var(--w-text-2xl)";
  return (
    <div style={style}>
      <div className="w-stat" style={{ fontSize: valueSize, color: accent ? "var(--w-accent)" : "var(--w-ink)" }}>{value}</div>
      {label ? <div className="w-label" style={{ marginTop: "var(--w-space-1)" }}>{label}</div> : null}
      {sub && preset !== "S" ? <div className="w-sub" style={{ marginTop: "var(--w-space-1)" }}>{sub}</div> : null}
    </div>
  );
}

export function Label({ children, style }) {
  return <div className="w-label" style={style}>{children}</div>;
}

export function Row({ children, justify, style }) {
  return <div className="w-row" style={{ justifyContent: justify, ...(style || {}) }}>{children}</div>;
}

export function List({ children, style }) {
  return <ul className="w-list" style={style}>{children}</ul>;
}

const PILL_TONES = { neutral: "var(--w-ink)", accent: "var(--w-accent)", forest: "var(--w-accent-2)" };
export function Pill({ children, tone = "neutral", style }) {
  return <span className="w-pill" style={{ color: PILL_TONES[tone] || PILL_TONES.neutral, ...(style || {}) }}>{children}</span>;
}
`;

/**
 * Ambient typings for "@artifact/ui", appended to the artifact-sdk.d.ts starter
 * so the in-editor LLM tooling sees the primitive/hook surface. Types only —
 * never bundled into the runtime.
 */
export const ARTIFACT_UI_DTS = /* ts */ `
declare module "@artifact/ui" {
  import type { ReactNode, CSSProperties } from "react";
  export type WidgetPreset = "S" | "M" | "L" | "W";

  export type EntryStatus = "idle" | "refreshing" | "error";
  export type EntrySnapshot<T = unknown> = {
    data: T;
    status: EntryStatus;
    lastRefreshedAt: number | null;
    error: string | null;
    refresh: () => void;
  };

  export function useWidgetSize(): WidgetPreset;
  /** Observe a declared data entry (manifest.state key). The host fetches,
   *  validates, merges, and persists; this hook only renders. Use for every
   *  source-backed collection - do not hand-wire query/schedule/state. */
  export function useArtifact<T = unknown>(key: string): EntrySnapshot<T | null>;
  /** Read/write a declared "value" entry (user-owned UI state) with
   *  cross-frame sync. */
  export function useArtifactValue<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void];
  export function useArtifactState<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void];
  export function useArtifactTask<T = unknown>(
    key: string,
    prompt: string,
    opts?: Record<string, unknown>
  ): { data: T | undefined; loading: boolean; error: string | null; refresh: () => void };

  export function WidgetShell(props: { children?: ReactNode; padded?: boolean; style?: CSSProperties }): JSX.Element;
  export function Stat(props: { value: ReactNode; label?: ReactNode; sub?: ReactNode; accent?: boolean; style?: CSSProperties }): JSX.Element;
  export function Label(props: { children?: ReactNode; style?: CSSProperties }): JSX.Element;
  export function Row(props: { children?: ReactNode; justify?: string; style?: CSSProperties }): JSX.Element;
  export function List(props: { children?: ReactNode; style?: CSSProperties }): JSX.Element;
  export function Pill(props: { children?: ReactNode; tone?: "neutral" | "accent" | "forest"; style?: CSSProperties }): JSX.Element;
}
`;
