// Verification for the widget design system (run: npx tsx scripts/verify-widget-ui.ts).
//
// 1. Token-drift guard: the --w-* color literals in WIDGET_TOKENS_CSS must match
//    the Soft Paper palette in app/globals.css — the LIGHT values against the
//    @theme block and the DARK values against the .dark block (the iframe can't
//    import the parent stylesheet, so the values are copied — this fails if they
//    drift). Fonts are intentionally NOT checked: the widget uses a self-contained
//    stack because the sandboxed iframe can't resolve the host's --font-serif-web.
// 2. Builds a sample widget that imports "@artifact/ui" through the REAL
//    pipeline and asserts: build ok, tokens injected, primitives bundled,
//    unused primitives tree-shaken.
// 3. Negative: a bogus bare import still fails with the existing clear error.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { buildArtifactWidget } from "@/app/lib/artifact/build";
import { WIDGET_TOKENS_CSS } from "@/app/lib/artifact/ui-runtime";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
// ---- 1. Token-drift guard ---------------------------------------------------

const css = readFileSync(path.join(root, "app/globals.css"), "utf8");

// Extract a `{ ... }`-delimited block starting at the first line that contains
// `marker`. Used to isolate the @theme (light) and .dark (dark) declarations.
function blockAfter(marker: string): string {
  const start = css.indexOf(marker);
  assert.ok(start >= 0, `globals.css is missing ${marker}`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("\n}", open));
}

const themeBlock = blockAfter("@theme");
const darkBlock = blockAfter(".dark {");

// Soft Paper color token in globals.css → widget token it must equal. Fonts and
// spacing are theme-independent and self-contained in the widget, so they're not
// part of the drift check.
const COLOR_MAP: Record<string, string> = {
  "--color-bg": "--w-bg",
  "--color-surface": "--w-surface",
  "--color-surface-2": "--w-surface-2",
  "--color-ink": "--w-ink",
  "--color-ink-soft": "--w-ink-soft",
  "--color-ink-dim": "--w-ink-dim",
  "--color-accent": "--w-accent",
  "--color-accent-2": "--w-accent-2",
  "--color-rule": "--w-rule",
};

function readToken(block: string, name: string, label: string): string {
  const m = block.match(new RegExp(name.replace(/[-]/g, "\\-") + "\\s*:\\s*([^;]+);"));
  assert.ok(m, `globals.css ${label} is missing ${name}`);
  return m![1].trim();
}

// The widget CSS emits each palette twice (light: :root + [theme="light"];
// dark: @media + [theme="dark"]). We only assert the value is PRESENT, since a
// value shared across both selectors appears more than once.
for (const [themeVar, widgetVar] of Object.entries(COLOR_MAP)) {
  const light = readToken(themeBlock, themeVar, "@theme");
  assert.ok(
    WIDGET_TOKENS_CSS.includes(`${widgetVar}: ${light};`),
    `Light token drift: ${widgetVar} must equal globals.css @theme ${themeVar} (${light})`
  );
  const dark = readToken(darkBlock, themeVar, ".dark");
  assert.ok(
    WIDGET_TOKENS_CSS.includes(`${widgetVar}: ${dark};`),
    `Dark token drift: ${widgetVar} must equal globals.css .dark ${themeVar} (${dark})`
  );
}
console.log(
  `✓ token-drift guard: ${Object.keys(COLOR_MAP).length} light + ${Object.keys(COLOR_MAP).length} dark tokens match globals.css`
);

// ---- 2. Sample widget through the real build pipeline -----------------------

const sampleWidget = `import { WidgetShell, Stat, Label, List, useArtifactState, useWidgetSize } from "@artifact/ui";

type Shape = { count: number; items: { id: string; name: string }[] };

export default function Widget() {
  const [data] = useArtifactState<Shape | null>("data", null);
  const size = useWidgetSize();
  if (!data) return <WidgetShell><Label>No data yet</Label></WidgetShell>;
  return (
    <WidgetShell>
      <Stat value={data.count} label="open items" />
      {size !== "S" && <List>{data.items.map((i) => <li key={i.id}>{i.name}</li>)}</List>}
    </WidgetShell>
  );
}
`;

const files = {
  "Widget.tsx": sampleWidget,
  "manifest.json": JSON.stringify({
    name: "Sample",
    params: [],
    widget: { entry: "Widget.tsx", defaultSize: "M", supportedSizes: ["S", "M", "L", "W"] },
  }),
};

const res = await buildArtifactWidget(files, {
  name: "Sample",
  params: [],
  widget: { entry: "Widget.tsx", defaultSize: "M", supportedSizes: ["S", "M", "L", "W"] },
});

assert.ok(res.ok, `widget build failed: ${!res.ok ? JSON.stringify(res.errors) : ""}`);
const html = (res as { html: string }).html;

// Tokens injected into the shell.
assert.ok(html.includes("--w-ink: #1a1814;"), "design tokens not injected into widget HTML");
assert.ok(html.includes(".w-stat"), "base widget classes not injected");
// Primitives that were imported are bundled in.
assert.ok(html.includes("w-stat") && html.includes("w-label"), "imported primitives missing from bundle");
// Tree-shaking: Pill was NOT imported, so its unique marker should be absent.
assert.ok(!html.includes("PILL_TONES"), "unused Pill primitive was not tree-shaken out");
console.log("✓ sample widget builds, tokens injected, primitives bundled, unused tree-shaken");

// ---- 3. Negative: bogus bare import still fails -----------------------------

const bad = await buildArtifactWidget(
  { "Widget.tsx": `import x from "totally-not-a-real-module";\nexport default function Widget() { return <div>{String(x)}</div>; }` },
  null
);
assert.ok(!bad.ok, "expected build to fail for a bogus bare import");
const errText = JSON.stringify((bad as { errors: unknown }).errors);
assert.ok(/totally-not-a-real-module|Cannot resolve/.test(errText), `unexpected error: ${errText}`);
console.log("✓ bogus bare import still rejected with a clear error");

console.log("\nAll widget design-system checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
