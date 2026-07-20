// Local stand-ins for the esm.sh React modules the artifact import map
// references. Sandboxed CI environments often can't reach esm.sh; this module
// builds ESM bundles from node_modules once and exposes a Playwright route
// handler that fulfills https://esm.sh/* requests with them.
//
// The tricky part is keeping ONE React instance across bundles (hooks break
// otherwise) when react-dom/jsx-runtime are CJS and `require("react")` can't
// be externalized into ESM output. Scheme:
//   - The `react` shim bundles React fully and publishes its namespace on
//     globalThis.__E2E_REACT__ as it evaluates.
//   - Every other shim starts with a bare `import "react"` (left external, so
//     the page's import map resolves it and React evaluates FIRST), and an
//     esbuild plugin rewrites internal require-calls of "react" to a stub
//     that reads the global.
import { build } from "esbuild";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ENTRIES = [
  { match: /^https:\/\/esm\.sh\/react@[^/]+$/, entry: "react", root: true },
  { match: /^https:\/\/esm\.sh\/react@[^/]+\/jsx-runtime$/, entry: "react/jsx-runtime" },
  { match: /^https:\/\/esm\.sh\/react@[^/]+\/jsx-dev-runtime$/, entry: "react/jsx-dev-runtime" },
  { match: /^https:\/\/esm\.sh\/react-dom@[^/]+$/, entry: "react-dom" },
  { match: /^https:\/\/esm\.sh\/react-dom@[^/]+\/client$/, entry: "react-dom/client" },
];

// Rewrites require("react") inside CJS deps to a global-reading stub, while
// leaving import-statements of "react" external for the page's import map.
const reactGlobalPlugin = {
  name: "react-global",
  setup(b) {
    b.onResolve({ filter: /^react$/ }, (args) => {
      if (args.kind === "require-call") {
        return { path: "react-global-stub", namespace: "react-stub" };
      }
      return { path: "react", external: true };
    });
    b.onLoad({ filter: /^react-global-stub$/, namespace: "react-stub" }, () => ({
      contents: "module.exports = globalThis.__E2E_REACT__;",
      loader: "js",
    }));
  },
};

const cache = new Map();

async function bundle(entry, root) {
  if (cache.has(entry)) return cache.get(entry);
  // Browsers link named ESM imports statically, so the shim must DECLARE each
  // export: enumerate the real module's keys in node and emit explicit consts.
  const mod = require(entry);
  const names = Object.keys(mod).filter(
    (k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== "default"
  );
  const wrapper = [
    root ? "" : `import "react";`, // force React to evaluate first
    `import m from ${JSON.stringify(entry)};`,
    root ? "globalThis.__E2E_REACT__ = m;" : "",
    `export default m;`,
    ...names.map((n) => `export const ${n} = m[${JSON.stringify(n)}];`),
  ].join("\n");
  const out = await build({
    stdin: { contents: wrapper, resolveDir: process.cwd() },
    bundle: true,
    format: "esm",
    platform: "browser",
    plugins: root ? [] : [reactGlobalPlugin],
    write: false,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const code = out.outputFiles[0].text;
  cache.set(entry, code);
  return code;
}

/** Install the esm.sh interception on a Playwright BrowserContext. */
export async function shimEsmSh(context) {
  await context.route("https://esm.sh/**", async (route) => {
    const url = route.request().url();
    const hit = ENTRIES.find((e) => e.match.test(url));
    if (!hit) return route.fulfill({ status: 404, body: `no shim for ${url}` });
    const code = await bundle(hit.entry, hit.root === true);
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
      body: code,
    });
  });
}
