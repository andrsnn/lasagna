// Diagnostic: why doesn't the seeded app mount? Captures page console, iframe
// console, failed network requests, and a DOM snapshot.
import { chromium } from "playwright-core";
import { shimEsmSh } from "./esm-shim.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3123";
const APP_ID = "e2e-events-app";

const MANIFEST = {
  name: "E2E Events",
  description: "Declared-data end-to-end test app",
  params: [{ key: "city", type: "string", label: "City", default: "Chattanooga, TN" }],
  state: {
    events: {
      kind: "collection",
      schema: { type: "object", properties: { title: { type: "string" }, date: { type: "string" }, venue: { type: "string" } }, required: ["title", "date"] },
      identity: ["title", "date"],
      merge: "upsert",
      source: { type: "query", prompt: "List upcoming events in {params.city}.", webSearch: false, refresh: { user: true, schedule: "0 6 * * *" } },
    },
  },
  widget: { defaultSize: "M" },
};
const FILES = {
  "index.html": `<!doctype html>\n<html><head><meta charset="utf-8"><title>E2E Events</title></head>\n<body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>`,
  "main.tsx": `import { createRoot } from "react-dom/client";\nimport App from "./App";\n(async () => {\n  await window.artifact.ready();\n  createRoot(document.getElementById("root")!).render(<App />);\n})();`,
  "App.tsx": `import { useArtifact } from "@artifact/ui";\nexport default function App() {\n  const events = useArtifact<any[]>("events");\n  const rows = Array.isArray(events.data) ? events.data : [];\n  return (<div><div data-testid="count">{rows.length}</div><button data-testid="refresh" onClick={events.refresh}>Refresh</button></div>);\n}`,
  "Widget.tsx": `import { useArtifact } from "@artifact/ui";\nexport default function Widget() {\n  const events = useArtifact<any[]>("events");\n  return <div data-testid="w-count">{Array.isArray(events.data) ? events.data.length : 0}</div>;\n}`,
  "manifest.json": JSON.stringify(MANIFEST, null, 2),
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
await shimEsmSh(context);
const page = await context.newPage();

page.on("console", (m) => console.log(`[console:${m.type()}]`, m.text().slice(0, 300)));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("requestfailed", (r) => console.log("[reqfail]", r.url().slice(0, 120), r.failure()?.errorText));
page.on("response", (r) => {
  if (r.status() >= 400) console.log("[http", r.status() + "]", r.url().slice(0, 140));
});

const login = await page.request.post(`${BASE}/api/login`, {
  data: { email: "admin@example.com", password: "e2e-test-pass" },
});
console.log("login:", login.status());

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.evaluate(
  async ({ appId, files, manifest }) => {
    const open = () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("ollama-chat");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const db = await open();
    console.log("IDB name/version:", db.name, db.version, "stores:", [...db.objectStoreNames].join(","));
    const now = Date.now();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["designers", "apps"], "readwrite");
      tx.objectStore("designers").put({
        id: appId, name: manifest.name, description: manifest.description, files, entry: "main.tsx",
        manifest, status: "published", version: 1, history: [], createdAt: now, updatedAt: now,
      });
      tx.objectStore("apps").put({
        id: appId, name: manifest.name, params: { city: "Chattanooga, TN" }, model: "runpod:test-model",
        state: {}, widgetEnabled: true, widgetSize: "M", createdAt: now, updatedAt: now,
      });
      tx.oncomplete = () => resolve(null);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  },
  { appId: APP_ID, files: FILES, manifest: MANIFEST }
);
console.log("seeded, navigating to app page");
await page.goto(`${BASE}/apps/${APP_ID}`, { waitUntil: "networkidle" });
await page.waitForTimeout(15000);

console.log("--- page body text (first 600) ---");
console.log((await page.textContent("body"))?.replace(/\s+/g, " ").slice(0, 600));
const iframes = await page.locator("iframe").count();
console.log("iframe count:", iframes);
if (iframes > 0) {
  const srcdoc = await page.locator("iframe").first().getAttribute("srcdoc");
  console.log("iframe srcdoc length:", srcdoc?.length ?? 0, "head:", (srcdoc ?? "").slice(0, 200).replace(/\n/g, " "));
  try {
    const inner = await page.frameLocator("iframe").first().locator("body").innerHTML({ timeout: 5000 });
    console.log("iframe body innerHTML (first 400):", inner.replace(/\s+/g, " ").slice(0, 400));
  } catch (e) {
    console.log("iframe body read failed:", String(e).slice(0, 200));
  }
}
await page.screenshot({ path: "scripts/e2e/debug-mount.png", fullPage: false });
console.log("screenshot: scripts/e2e/debug-mount.png");
await browser.close();
