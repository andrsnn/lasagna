// End-to-end test of the declared-data (SDK v2) pipeline in the REAL runtime:
// real next server, real esbuild artifact build, real sandboxed iframes, real
// Redis staging (in-memory Upstash shim), mock LLM. Verifies the flows users
// actually exercise on a phone:
//
//   1. Interactive refresh: a button INSIDE the artifact calls
//      entries.refresh(); the host runs the source, merges, persists.
//   2. Widget/app consistency: the home-board widget and the full app view
//      render the same records from the same state store.
//   3. Leave-and-return: user starts a refresh, navigates away mid-flight,
//      the run finishes server-side into Redis, and the next mount syncs it
//      down into the device store (recovery sweep -> entry).
//   4. Merge semantics live: a second batch with a re-cased duplicate, a
//      blank venue, and a filler row upserts cleanly (no dupes, no clobber,
//      filler dropped).
//   5. "Last refreshed" reflects reality on the app header.
//
// Prereqs: `npm run build` done; mock-backends.mjs running; next started with
// the env below. Or just run scripts/e2e/run.sh which orchestrates all of it.

import { chromium } from "playwright-core";
import { shimEsmSh } from "./esm-shim.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3123";
const LLM_CONTROL = process.env.E2E_LLM_CONTROL ?? "http://127.0.0.1:8198/__control";
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const TEMP_PASS = process.env.E2E_TEMP_PASS ?? "e2e-test-pass";
const APP_ID = "e2e-events-app";

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === "string" ? detail : "");
  } catch (e) {
    record(name, false, String(e?.message ?? e));
  }
}

async function setLlm(patch) {
  const r = await fetch(LLM_CONTROL, { method: "POST", body: JSON.stringify(patch) });
  if (!r.ok) throw new Error(`llm control failed ${r.status}`);
}

// ---------------------------------------------------------------------------
// The test artifact: a real VFS app using useArtifact in App.tsx + Widget.tsx.
// ---------------------------------------------------------------------------

const EVENT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    date: { type: "string" },
    venue: { type: "string" },
    url: { type: "string" },
    category: { enum: ["music", "other"] },
  },
  required: ["title", "date"],
};

const MANIFEST = {
  name: "E2E Events",
  description: "Declared-data end-to-end test app",
  params: [{ key: "city", type: "string", label: "City", default: "Chattanooga, TN" }],
  state: {
    events: {
      kind: "collection",
      schema: EVENT_SCHEMA,
      identity: ["title", "date"],
      merge: "upsert",
      source: {
        type: "query",
        prompt: "List upcoming events in {params.city}.",
        webSearch: false,
        refresh: { user: true },
      },
    },
  },
  widget: { defaultSize: "M" },
};

const FILES = {
  "index.html": `<!doctype html>
<html><head><meta charset="utf-8"><title>E2E Events</title></head>
<body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>`,
  "main.tsx": `import { createRoot } from "react-dom/client";
import App from "./App";
(async () => {
  await window.artifact.ready();
  createRoot(document.getElementById("root")!).render(<App />);
})();`,
  "App.tsx": `import { useArtifact } from "@artifact/ui";
export default function App() {
  const events = useArtifact<any[]>("events");
  const rows = Array.isArray(events.data) ? events.data : [];
  return (
    <div style={{ padding: 16 }}>
      <h1>E2E Events</h1>
      <div data-testid="status">{events.status}</div>
      <div data-testid="count">{rows.length}</div>
      <div data-testid="refreshed">{events.lastRefreshedAt ? "yes" : "never"}</div>
      <ul data-testid="list">
        {rows.map((e, i) => (
          <li key={i} data-testid="row">{e.title} | {e.venue || "-"} | {e.url || "-"}</li>
        ))}
      </ul>
      <button type="button" data-testid="refresh" onClick={events.refresh}>Refresh</button>
    </div>
  );
}`,
  "Widget.tsx": `import { useArtifact } from "@artifact/ui";
export default function Widget() {
  const events = useArtifact<any[]>("events");
  const rows = Array.isArray(events.data) ? events.data : [];
  return (
    <div className="w-root" style={{ padding: 8 }}>
      <div data-testid="w-count">{rows.length}</div>
      <ul>{rows.map((e, i) => (<li key={i}>{e.title}</li>))}</ul>
    </div>
  );
}`,
  "manifest.json": JSON.stringify(MANIFEST, null, 2),
};

// ---------------------------------------------------------------------------

async function main() {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
  // Sandboxed CI can't reach esm.sh; serve the import-map React modules from
  // local bundles so the artifact iframes can boot.
  await shimEsmSh(context);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  // --- login (admin bootstrap path: ADMIN_EMAIL + TEMP_PASS) ---------------
  const login = await page.request.post(`${BASE}/api/login`, {
    data: { email: ADMIN_EMAIL, password: TEMP_PASS },
  });
  if (!login.ok()) throw new Error(`login failed: ${login.status()} ${await login.text()}`);

  // --- boot the app shell once so IndexedDB stores exist -------------------
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

  // --- seed the test designer+app straight into the device store -----------
  await page.evaluate(
    async ({ appId, files, manifest }) => {
      const open = () =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open("ollama-chat");
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      const db = await open();
      const now = Date.now();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(["designers", "apps"], "readwrite");
        tx.objectStore("designers").put({
          id: appId,
          name: manifest.name,
          description: manifest.description,
          files,
          entry: "main.tsx",
          manifest,
          status: "published",
          version: 1,
          history: [],
          createdAt: now,
          updatedAt: now,
        });
        tx.objectStore("apps").put({
          id: appId,
          name: manifest.name,
          params: { city: "Chattanooga, TN" },
          model: "runpod:test-model",
          state: {},
          widgetEnabled: true,
          widgetSize: "M",
          createdAt: now,
          updatedAt: now,
        });
        tx.oncomplete = () => resolve(null);
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { appId: APP_ID, files: FILES, manifest: MANIFEST }
  );

  const appFrame = () => page.frameLocator("iframe").first();

  // ==========================================================================
  // Scenario 1: interactive refresh from a button INSIDE the artifact.
  // ==========================================================================
  await setLlm({ batch: 1, delayMs: 0 });
  await page.goto(`${BASE}/apps/${APP_ID}`, { waitUntil: "networkidle" });

  await check("app builds and mounts with empty declared entry", async () => {
    await appFrame().getByTestId("count").waitFor({ timeout: 120_000 });
    const count = await appFrame().getByTestId("count").textContent();
    if (count !== "0") throw new Error(`expected 0 rows on first paint, got ${count}`);
    return "first paint renders empty state, no auto-fetch";
  });

  await check("in-app button -> entries.refresh -> host runs source -> rows render", async () => {
    await appFrame().getByTestId("refresh").click();
    await appFrame().getByTestId("count").filter({ hasText: "2" }).waitFor({ timeout: 120_000 });
    const rows = await appFrame().getByTestId("row").allTextContents();
    if (!rows.some((r) => r.includes("Yellow Racket Records"))) {
      throw new Error(`batch 1 rows missing: ${rows.join(" // ")}`);
    }
    return `2 rows landed: ${rows[0]}`;
  });

  await check("entry meta: lastRefreshedAt set, status idle", async () => {
    const refreshed = await appFrame().getByTestId("refreshed").textContent();
    const status = await appFrame().getByTestId("status").textContent();
    if (refreshed !== "yes") throw new Error(`lastRefreshedAt not set (${refreshed})`);
    if (status !== "idle") throw new Error(`status ${status}`);
  });

  await check("app header 'Last refreshed' is not 'never'", async () => {
    const header = await page.textContent("body");
    if (/Last refreshed\s*never/i.test(header ?? "")) {
      throw new Error("host header still says Last refreshed never");
    }
  });

  // ==========================================================================
  // Scenario 2: the home-board widget renders the SAME data.
  // ==========================================================================
  await check("widget on home board shows the same records", async () => {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    const wcount = appFrame().getByTestId("w-count");
    await wcount.filter({ hasText: "2" }).waitFor({ timeout: 120_000 });
    return "widget count matches app count (2)";
  });

  // ==========================================================================
  // Scenario 3: leave mid-flight; result stages in Redis; returns to device.
  // ==========================================================================
  await check("leave-and-return: refresh started, user leaves, result lands on return", async () => {
    await setLlm({ batch: 2, delayMs: 8000 });
    await page.goto(`${BASE}/apps/${APP_ID}`, { waitUntil: "networkidle" });
    await appFrame().getByTestId("refresh").waitFor({ timeout: 120_000 });
    await appFrame().getByTestId("refresh").click();
    // Confirm the run actually started (status flips to refreshing).
    await appFrame().getByTestId("status").filter({ hasText: "refreshing" }).waitFor({ timeout: 10_000 });
    // "Lock the phone": leave immediately, long before the 8s LLM finishes.
    await page.goto(`${BASE}/manage`, { waitUntil: "networkidle" });
    // Server keeps working; result lands in the Redis stream store.
    await new Promise((r) => setTimeout(r, 11_000));
    // Return. Mount-time recovery sweep resumes the stream and lands the entry.
    await page.goto(`${BASE}/apps/${APP_ID}`, { waitUntil: "networkidle" });
    await appFrame().getByTestId("count").filter({ hasText: "3" }).waitFor({ timeout: 120_000 });
    const rows = await appFrame().getByTestId("row").allTextContents();
    return `3 rows after return: ${rows.join(" // ")}`;
  });

  await check("merge semantics: dedupe by identity, blank never clobbers, no ghost rows", async () => {
    const rows = await appFrame().getByTestId("row").allTextContents();
    const jack = rows.filter((r) => /Jack White/i.test(r));
    if (jack.length !== 1) throw new Error(`expected 1 Jack White row, got ${jack.length}`);
    if (!/Yellow Racket Records/.test(jack[0])) throw new Error(`blank venue clobbered: ${jack[0]}`);
    if (!/example\.com\/jack/.test(jack[0])) throw new Error(`new url field not merged: ${jack[0]}`);
    if (rows.length !== 3) throw new Error(`expected exactly 3 rows, got ${rows.length}`);
    if (!rows.some((r) => /Remi Goode/.test(r))) throw new Error("new event missing");
    if (!rows.some((r) => /Gooda Cheese/.test(r))) throw new Error("batch-1 event lost");
  });

  await check("status returned to idle after recovery (no stuck 'refreshing')", async () => {
    const status = await appFrame().getByTestId("status").textContent();
    if (status !== "idle") throw new Error(`status ${status}`);
  });

  // ==========================================================================
  // Scenario 4: widget reflects the merged data set too.
  // ==========================================================================
  await check("widget picks up merged records after return", async () => {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await appFrame().getByTestId("w-count").filter({ hasText: "3" }).waitFor({ timeout: 120_000 });
  });

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error("E2E driver crashed:", e);
  process.exit(1);
});
