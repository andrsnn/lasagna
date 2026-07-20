// Server-side artifact build pipeline.
//
// Takes a VFS (path → source content) and an entrypoint, runs esbuild to
// bundle TypeScript/React into a single ESM script, then composes the
// final iframe srcdoc by inlining the bundle into index.html, injecting
// any CSS files inline, and adding the artifact SDK script.
//
// `react`, `react-dom/client`, and `react/jsx-runtime` are marked external
// in the bundle and resolved at runtime via an <importmap> pointing at
// esm.sh. Doing it server-side via createRequire breaks on Vercel: Next
// inlines its own React into the server bundle and never traces
// `react-dom/client` (a client-only subpath) into the function payload.

import * as esbuild from "esbuild";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { SDK_INLINE_SCRIPT } from "./sdk-inline";
import { detectWidgetEntry, diagnoseManifest, parseManifestFromVfs } from "./manifest";
import {
  ARTIFACT_BASE_CSS_SENTINEL,
  ARTIFACT_BASE_CSS_TAG,
  ARTIFACT_UI_SOURCE,
  WIDGET_TOKENS_CSS,
} from "./ui-runtime";
import type { ArtifactFiles, ArtifactManifest, BuildIssue } from "@/app/db";

// Pinned to the React major used by the host (see package.json). esm.sh
// dedupes react-dom's react peer against the same major automatically.
const REACT_VERSION = "19";
const EXTERNAL_IMPORTS: Record<string, string> = {
  react: `https://esm.sh/react@${REACT_VERSION}`,
  "react/jsx-runtime": `https://esm.sh/react@${REACT_VERSION}/jsx-runtime`,
  "react/jsx-dev-runtime": `https://esm.sh/react@${REACT_VERSION}/jsx-dev-runtime`,
  "react-dom": `https://esm.sh/react-dom@${REACT_VERSION}`,
  "react-dom/client": `https://esm.sh/react-dom@${REACT_VERSION}/client`,
};
const EXTERNAL_NAMES = new Set(Object.keys(EXTERNAL_IMPORTS));

export type BuildSuccess = {
  ok: true;
  html: string;
  warnings: BuildIssue[];
  durationMs: number;
};

export type BuildError = {
  ok: false;
  errors: BuildIssue[];
  warnings: BuildIssue[];
  durationMs: number;
};

export type BuildResult = BuildSuccess | BuildError;

const VFS_NS = "vfs";
const ENTRY_PATH = "__artifact_entry__";

// Virtual module: `import { ... } from "@artifact/ui"` resolves to the widget
// design-system source (primitives + hooks) served from ui-runtime.ts. It is
// bundled + tree-shaken into the artifact like any local file.
const ARTIFACT_UI_SPECIFIER = "@artifact/ui";
const ARTIFACT_UI_NS = "artifact-ui";

/** Best-guess loader for esbuild based on file extension. */
function loaderFor(path: string): esbuild.Loader {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".ts")) return "ts";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "js";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  return "text";
}

/** Translate esbuild Message → our BuildIssue shape. */
function toIssue(m: esbuild.Message): BuildIssue {
  const loc = m.location;
  return {
    file: loc?.file ?? "<unknown>",
    line: loc?.line ?? 0,
    column: loc?.column ?? 0,
    message: m.text,
    snippet: loc?.lineText,
  };
}

/** Static path: legacy single-file index.html artifacts. Inject the SDK + the
 *  themed app defaults (a full-app surface, so it gets ARTIFACT_BASE_CSS). */
function composeStaticHtml(files: ArtifactFiles, entry: string): string {
  const html = files[entry] ?? "";
  return injectSdk(html);
}

const BUNDLEABLE_EXT_RE = /\.(tsx|ts|jsx|js|mjs)$/;
const DEFAULT_ENTRY_CANDIDATES = [
  "main.tsx",
  "main.ts",
  "main.jsx",
  "main.js",
  "index.tsx",
  "index.ts",
  "index.jsx",
  "index.js",
];

/**
 * Resolve the JS/TS file esbuild should bundle. The saved `entry` is sometimes
 * "index.html" (Convert-HTML-to-App preserves the shell as the entry), so when
 * it isn't directly bundleable we look at the <script src="..."> tag inside
 * index.html, then fall back to conventional entry names.
 */
function resolveBundleEntry(
  entry: string,
  files: ArtifactFiles,
  indexHtml: string | null
): string | null {
  if (
    BUNDLEABLE_EXT_RE.test(entry) &&
    Object.prototype.hasOwnProperty.call(files, entry)
  ) {
    return entry;
  }
  if (indexHtml) {
    const scriptRe =
      /<script\b[^>]*\bsrc=["'](?!https?:|\/\/)([^"']+)["'][^>]*>/gi;
    for (const m of indexHtml.matchAll(scriptRe)) {
      const src = m[1].replace(/^\.\//, "").replace(/^\//, "");
      if (
        BUNDLEABLE_EXT_RE.test(src) &&
        Object.prototype.hasOwnProperty.call(files, src)
      ) {
        return src;
      }
    }
  }
  for (const name of DEFAULT_ENTRY_CANDIDATES) {
    if (Object.prototype.hasOwnProperty.call(files, name)) return name;
  }
  return null;
}

function injectSdk(html: string): string {
  // Strip the manifest <script> block from the runtime — it's metadata.
  let out = html.replace(
    /<script\b[^>]*type=["']application\/artifact-manifest["'][^>]*>[\s\S]*?<\/script>/gi,
    ""
  );
  const sdkTag = `<script>${SDK_INLINE_SCRIPT}</script>`;
  const baseTag = `<base target="_top">`;
  // Themed defaults first, so any <style>/<link> the document already carries
  // comes later in source order and wins (the base rules are 0-specificity
  // anyway). Skip if a prior pass already injected them.
  const baseCss = out.includes(ARTIFACT_BASE_CSS_SENTINEL) ? "" : ARTIFACT_BASE_CSS_TAG;
  const head = `${baseTag}${sdkTag}${baseCss}`;
  if (/<head\b[^>]*>/i.test(out)) {
    out = out.replace(/<head\b[^>]*>/i, (m) => `${m}${head}`);
  } else if (/<html\b[^>]*>/i.test(out)) {
    out = out.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  } else {
    out = `<!doctype html><html><head>${head}</head><body>${out}</body></html>`;
  }
  return out;
}

/** Custom esbuild plugin: resolve relative imports against the in-memory VFS. */
function vfsPlugin(files: ArtifactFiles, entry: string): esbuild.Plugin {
  // Pre-normalize: build a map from absolute "/path" form to file content.
  const abs: Record<string, string> = {};
  for (const [p, content] of Object.entries(files)) abs["/" + p] = content;

  return {
    name: "artifact-vfs",
    setup(build) {
      // Synthetic entry: the file the model named as `entry`.
      build.onResolve({ filter: new RegExp(`^${ENTRY_PATH}$`) }, () => ({
        path: "/" + entry,
        namespace: VFS_NS,
      }));

      // Imports happening inside files we own (the VFS namespace).
      build.onResolve({ filter: /.*/, namespace: VFS_NS }, (args) => {
        // The widget design system — served from ui-runtime.ts, not the VFS.
        if (args.path === ARTIFACT_UI_SPECIFIER) {
          return { path: ARTIFACT_UI_SPECIFIER, namespace: ARTIFACT_UI_NS };
        }

        // External URL imports (http/https) — explicit failure later.
        if (/^[a-z]+:/.test(args.path)) {
          return {
            errors: [{ text: `External URLs are not allowed in artifacts: ${args.path}` }],
          };
        }

        // Relative imports (./foo, ../bar) resolve within the VFS.
        if (args.path.startsWith(".") || args.path.startsWith("/")) {
          const importerDir = path.posix.dirname(args.importer);
          const target = args.path.startsWith(".")
            ? path.posix.resolve(importerDir, args.path)
            : args.path;
          const exts = ["", ".tsx", ".ts", ".jsx", ".js", ".css", ".json"];
          for (const ext of exts) {
            if (Object.prototype.hasOwnProperty.call(abs, target + ext)) {
              return { path: target + ext, namespace: VFS_NS };
            }
          }
          for (const ext of [".tsx", ".ts", ".jsx", ".js"]) {
            const candidate = target + "/index" + ext;
            if (Object.prototype.hasOwnProperty.call(abs, candidate)) {
              return { path: candidate, namespace: VFS_NS };
            }
          }
          return {
            errors: [{ text: `File not found in VFS: ${target.replace(/^\//, "")}` }],
          };
        }

        // Bare imports for react / react-dom / jsx-runtime are externalized;
        // the iframe HTML carries an <importmap> that points them at esm.sh.
        if (EXTERNAL_NAMES.has(args.path)) {
          return { path: args.path, external: true };
        }

        return {
          errors: [
            {
              text: `Cannot resolve module "${args.path}". Only "react", "react-dom/client", and relative imports from the VFS are available.`,
            },
          ],
        };
      });

      // Load file contents for paths in our namespace.
      build.onLoad({ filter: /.*/, namespace: VFS_NS }, (args) => {
        const content = abs[args.path];
        if (content === undefined) {
          return { errors: [{ text: `File not found in VFS: ${args.path.replace(/^\//, "")}` }] };
        }
        return { contents: content, loader: loaderFor(args.path) };
      });

      // Imports from inside the @artifact/ui module: it only pulls in react,
      // which externalizes through the same importmap as the rest of the bundle.
      build.onResolve({ filter: /.*/, namespace: ARTIFACT_UI_NS }, (args) => {
        if (EXTERNAL_NAMES.has(args.path)) return { path: args.path, external: true };
        return {
          errors: [{ text: `@artifact/ui cannot import "${args.path}".` }],
        };
      });

      // Serve the design-system source for the virtual @artifact/ui module.
      build.onLoad({ filter: /.*/, namespace: ARTIFACT_UI_NS }, () => ({
        contents: ARTIFACT_UI_SOURCE,
        loader: "tsx",
        resolveDir: "/",
      }));
    },
  };
}

type BuildOpts = {
  /**
   * Inject ARTIFACT_BASE_CSS (the themed Soft Paper app defaults) into the
   * composed <head>. True for full apps; false for widgets, whose shell already
   * carries WIDGET_TOKENS_CSS and owns its (transparent) chrome.
   */
  baseCss?: boolean;
};

/** Build a TS/React VFS into an iframe-ready HTML srcdoc. */
export async function buildArtifact(
  files: ArtifactFiles,
  entry: string,
  opts: BuildOpts = {}
): Promise<BuildResult> {
  const { baseCss = true } = opts;
  const start = performance.now();

  // Manifest issues fail the build so the LLM's tool loop fixes them the same
  // way it fixes esbuild errors (the system prompt tells it to retry on
  // failure). User-facing saves use the tolerant repairManifest() path so the
  // app keeps working even if the model gives up.
  const manifestIssues = diagnoseManifest(files, entry);
  if (manifestIssues.length > 0) {
    return {
      ok: false,
      errors: manifestIssues,
      warnings: [],
      durationMs: Math.round(performance.now() - start),
    };
  }

  // Static path: there's an index.html and there are no JS/TS files to
  // compile. We previously also took this path whenever `entry === "index.html"`,
  // but that quietly broke the "Convert HTML → App" flow: once the LLM added
  // main.tsx + App.tsx and rewrote index.html to reference them, the saved
  // `entry` was still "index.html", so builds dropped the new files and served
  // the HTML with a now-broken <script src="./main.tsx"> tag → blank iframe.
  const hasJsxOrTs = Object.keys(files).some((p) => /\.(tsx|ts|jsx)$/.test(p));
  const indexHtml = files["index.html"] ?? null;
  if (!hasJsxOrTs && indexHtml !== null) {
    return {
      ok: true,
      html: composeStaticHtml(files, "index.html"),
      warnings: [],
      durationMs: Math.round(performance.now() - start),
    };
  }

  // React / TypeScript path. The saved `entry` may still be "index.html"
  // (Convert-to-App leaves it that way) — pick the real JS entry from the
  // <script type="module"> tag in index.html, falling back to conventional
  // names. The resolved path is what esbuild bundles; index.html stays the
  // shell.
  const bundleEntry = resolveBundleEntry(entry, files, indexHtml);
  if (!bundleEntry) {
    return {
      ok: false,
      errors: [
        {
          file: entry,
          line: 0,
          column: 0,
          message:
            `Cannot build: entry "${entry}" is not a JS/TS file and no ` +
            `<script type="module" src="./..."> in index.html points to one. ` +
            `Add a script tag like <script type="module" src="./main.tsx"></script>, ` +
            `or rename the entry to a .tsx/.ts/.jsx/.js file.`,
        },
      ],
      warnings: [],
      durationMs: Math.round(performance.now() - start),
    };
  }

  let result: esbuild.BuildResult<{ write: false }>;
  try {
    result = await esbuild.build({
      entryPoints: [ENTRY_PATH],
      bundle: true,
      format: "esm",
      target: ["es2022"],
      jsx: "automatic",
      // The VFS plugin synthesizes the entry; everything else (react etc.)
      // resolves through node_modules of the host app.
      resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".css", ".json"],
      loader: { ".css": "text", ".html": "text" },
      plugins: [vfsPlugin(files, bundleEntry)],
      // Sourcemaps would be helpful for in-browser debugging but inline maps
      // bloat the iframe srcdoc 10x. Skip them for now; we can revisit behind a
      // flag if the artifacts get large enough that browser DevTools unwieldy.
      sourcemap: false,
      minify: false,
      write: false,
      logLevel: "silent",
      define: {
        "process.env.NODE_ENV": '"production"',
      },
      // esbuild needs a real cwd for module resolution to find node_modules;
      // process.cwd() in a Next.js server is the project root, which works.
    });
  } catch (err) {
    // BuildFailure carries esbuild errors/warnings.
    const failure = err as esbuild.BuildFailure;
    return {
      ok: false,
      errors: (failure.errors ?? []).map(toIssue),
      warnings: (failure.warnings ?? []).map(toIssue),
      durationMs: Math.round(performance.now() - start),
    };
  }

  const warnings = (result.warnings ?? []).map(toIssue);

  // esbuild emits one .js bundle (entry) and zero or more .css files.
  let bundleJs = "";
  const cssChunks: string[] = [];
  for (const out of result.outputFiles ?? []) {
    if (out.path.endsWith(".css")) cssChunks.push(out.text);
    else bundleJs += out.text;
  }

  // Pull the user's own CSS files from the VFS too — esbuild only emits CSS for
  // CSS that was `import`ed from JS. Linked-from-HTML CSS we must inline manually.
  for (const [p, content] of Object.entries(files)) {
    if (p.endsWith(".css") && !cssChunks.some((c) => c.includes(content))) {
      cssChunks.push(content);
    }
  }

  // Compose: take index.html (or synthesize one), strip <script src="./*"> and
  // <link rel="stylesheet" href="./*"> tags that point to VFS files, then
  // splice in the bundled JS + concatenated CSS.
  const shell =
    files["index.html"] ??
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Artifact</title></head><body><div id="root"></div></body></html>`;

  let composed = shell;

  // Remove the manifest script block (metadata only).
  composed = composed.replace(
    /<script\b[^>]*type=["']application\/artifact-manifest["'][^>]*>[\s\S]*?<\/script>/gi,
    ""
  );

  // Drop <link rel="stylesheet" href="./*"> tags — we inline them below.
  composed = composed.replace(
    /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["'](?!https?:|\/\/)[^"']*["'][^>]*\/?>/gi,
    ""
  );

  // Drop <script src="./*"> module tags pointing into the VFS — we inline the bundle.
  composed = composed.replace(
    /<script\b[^>]*\bsrc=["'](?!https?:|\/\/)[^"']*["'][^>]*>\s*<\/script>/gi,
    ""
  );

  // Build the head injection block: SDK script, base tag, importmap (must
  // appear before any module script that relies on it), inline CSS.
  const cssBlock = cssChunks.length ? `<style>${cssChunks.join("\n")}</style>` : "";
  const importMapBlock = `<script type="importmap">${JSON.stringify({
    imports: EXTERNAL_IMPORTS,
  })}</script>`;
  // Themed app defaults precede the app's own CSS so the app's styles win on
  // source order (the base rules are 0-specificity anyway). Widgets pass
  // baseCss: false — their shell already carries WIDGET_TOKENS_CSS.
  const baseCssBlock =
    baseCss && !composed.includes(ARTIFACT_BASE_CSS_SENTINEL) ? ARTIFACT_BASE_CSS_TAG : "";
  const sdkBlock = `<base target="_top"><script>${SDK_INLINE_SCRIPT}</script>${importMapBlock}${baseCssBlock}${cssBlock}`;

  if (/<head\b[^>]*>/i.test(composed)) {
    composed = composed.replace(/<head\b[^>]*>/i, (m) => `${m}${sdkBlock}`);
  } else if (/<html\b[^>]*>/i.test(composed)) {
    composed = composed.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${sdkBlock}</head>`);
  } else {
    composed = `<!doctype html><html><head>${sdkBlock}</head><body>${composed}</body></html>`;
  }

  // Inject bundle just before </body> so the DOM is ready when it executes.
  const bundleTag = `<script type="module">${bundleJs}</script>`;
  if (/<\/body>/i.test(composed)) {
    composed = composed.replace(/<\/body>/i, `${bundleTag}</body>`);
  } else {
    composed += bundleTag;
  }

  return {
    ok: true,
    html: composed,
    warnings,
    durationMs: Math.round(performance.now() - start),
  };
}

/** Format a BuildIssue as a single-line `file:line:col message` for tool results. */
export function formatIssue(issue: BuildIssue): string {
  const loc = `${issue.file}:${issue.line}:${issue.column}`;
  return `${loc}  ${issue.message}`;
}

const WIDGET_HARNESS_PATH = "__widget_entry__.tsx";

/**
 * Synthesized mount harness injected at the VFS root. Imports the user's
 * default-exported widget component and renders it into the transparent
 * shell html below. The path stem is derived from `widgetEntry` minus its
 * extension; esbuild's resolver finds the original .tsx/.ts/.jsx/.js.
 */
function makeWidgetHarness(widgetEntry: string): string {
  const stem = widgetEntry.replace(/\.(tsx|ts|jsx|js)$/, "");
  // Relative-import form so the existing VFS plugin resolves it. Sits at
  // root (`__widget_entry__.tsx`), so `./Widget` → `/Widget.tsx` etc.
  const importPath = `./${stem}`;
  return [
    `import { createRoot } from "react-dom/client";`,
    `import Widget from ${JSON.stringify(importPath)};`,
    ``,
    `await window.artifact.ready();`,
    `const __widgetContainer = document.getElementById("root");`,
    `if (__widgetContainer) createRoot(__widgetContainer).render(<Widget />);`,
    ``,
  ].join("\n");
}

// `min-height: 100%` keeps short widgets filling the tile (the host's scroll
// container is the same size as the iframe, so a body that's exactly 100% has
// no overflow and is non-scrollable). Body height grows past 100% when the
// widget has more content than fits, and we post the natural scrollHeight so
// the host can size the iframe element to match and let its own overflow-y
// drive the scroll. The host owns the scrollbar (iframe pointer-events: none)
// so users can pan/wheel without the iframe swallowing taps meant for "open".
const WIDGET_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Widget</title>
    <style>
      html, body { margin: 0; background: transparent; }
      html { height: 100%; }
      body { min-height: 100%; font-family: ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
      #root { min-height: 100%; }
${WIDGET_TOKENS_CSS}    </style>
    <script>
      (function () {
        var NS = "__artifact_v1__";
        var lastH = -1;
        function post() {
          var h = Math.ceil(document.body.scrollHeight);
          if (h === lastH) return;
          lastH = h;
          try {
            window.parent.postMessage(
              { ns: NS, payload: { type: "widget-content-height", height: h } },
              "*"
            );
          } catch (e) {}
        }
        function start() {
          post();
          if (typeof ResizeObserver !== "undefined") {
            new ResizeObserver(post).observe(document.body);
          }
        }
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", start);
        } else {
          start();
        }
      })();
    </script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

/**
 * Build the widget bundle for an artifact. Resolves the widget entry via
 * `detectWidgetEntry`, injects a synthesized mount harness + transparent
 * index.html shell, then runs the standard `buildArtifact` pipeline.
 *
 * The user's full-app `index.html` is intentionally OVERWRITTEN with the
 * transparent shell so the widget's host cell owns its chrome (border,
 * shadow, background). CSS imported from JS still applies.
 */
export async function buildArtifactWidget(
  files: ArtifactFiles,
  manifest: ArtifactManifest | null
): Promise<BuildResult> {
  const widgetEntry = detectWidgetEntry(files, manifest);
  if (!widgetEntry) {
    return {
      ok: false,
      errors: [
        {
          file: "<widget>",
          line: 0,
          column: 0,
          message:
            "No widget defined. Add a default-exported `Widget.tsx` at the VFS root, or declare `manifest.widget.entry`.",
        },
      ],
      warnings: [],
      durationMs: 0,
    };
  }
  const widgetFiles: ArtifactFiles = {
    ...files,
    [WIDGET_HARNESS_PATH]: makeWidgetHarness(widgetEntry),
    "index.html": WIDGET_INDEX_HTML,
  };
  // baseCss: false — the widget shell (WIDGET_INDEX_HTML) already carries
  // WIDGET_TOKENS_CSS and stays transparent so the host cell owns the chrome.
  return buildArtifact(widgetFiles, WIDGET_HARNESS_PATH, { baseCss: false });
}

/**
 * Convenience: parse the manifest from `files` first and dispatch. Used by
 * /api/build when `target === "widget"`.
 */
export async function buildArtifactWidgetFromVfs(
  files: ArtifactFiles,
  appEntry: string
): Promise<BuildResult> {
  const { manifest } = parseManifestFromVfs(files, appEntry);
  return buildArtifactWidget(files, manifest);
}
