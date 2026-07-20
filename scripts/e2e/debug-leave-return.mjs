// Focused diagnostic for the leave-and-return scenario: watches IndexedDB,
// entry meta, and the iframe DOM second-by-second so we can see exactly where
// a recovered result stalls.
import { chromium } from "playwright-core";
import { shimEsmSh } from "./esm-shim.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3123";
const LLM_CONTROL = process.env.E2E_LLM_CONTROL ?? "http://127.0.0.1:8198/__control";
const APP_ID = "e2e-events-app";
const t0 = Date.now();
const ts = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function probe(page) {
  return page.evaluate(async () => {
    const open = () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("ollama-chat");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const db = await open();
    const get = (store, key) =>
      new Promise((resolve) => {
        try {
          const r = db.transaction(store).objectStore(store).get(key);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      });
    const app = await get("apps", "e2e-events-app");
    const designer = await get("designers", "e2e-events-app");
    const pendings = await new Promise((resolve) => {
      const r = db.transaction("pendingQueries").objectStore("pendingQueries").getAll();
      r.onsuccess = () => resolve(r.result ?? []);
      r.onerror = () => resolve([]);
    });
    db.close();
    const events = app?.state?.events;
    const meta = app?.state?.__artifact_entry_meta__?.events;
    let frameCount = null;
    const iframe = document.querySelector("iframe");
    try {
      frameCount = iframe?.contentDocument?.querySelector('[data-testid="count"]')?.textContent ?? "n/a";
    } catch {
      frameCount = "x-origin";
    }
    return {
      idbEvents: Array.isArray(events) ? events.length : events === undefined ? "unset" : "?",
      titles: Array.isArray(events) ? events.map((e) => String(e.title).slice(0, 28)) : [],
      manifestIdentity: designer?.manifest?.state?.events?.identity ?? "MISSING",
      meta: meta ? `${meta.status}${meta.scheduleRunAt ? "+sched" : ""}` : "none",
      lastRunAt: app?.lastRunAt ?? null,
      pendings: pendings.map((p) => `${p.key}=>${p.streamId}`),
      frameCount,
    };
  });
}

const REDIS = "http://127.0.0.1:8199";
function b64dec(v) {
  if (typeof v === "string" && v !== "OK") {
    try { return Buffer.from(v, "base64").toString("utf8"); } catch { return v; }
  }
  if (Array.isArray(v)) return v.map(b64dec);
  return v;
}
async function redisCmd(cmd) {
  const r = await fetch(REDIS, { method: "POST", body: JSON.stringify(cmd) });
  const j = await r.json();
  return b64dec(j.result);
}
async function dumpStream(streamId) {
  if (!streamId) return "no-stream";
  const keys = await redisCmd(["KEYS", `*${streamId}*`]);
  const out = {};
  for (const k of keys ?? []) {
    const type = await redisCmd(["TYPE", k]);
    if (type === "list") {
      const len = await redisCmd(["LLEN", k]);
      const last = await redisCmd(["LRANGE", k, "-1", "-1"]);
      out[k] = `list(${len}) last=${String(last?.[0] ?? "").slice(0, 80)}`;
    } else {
      const v = await redisCmd(["GET", k]);
      out[k] = String(v ?? "").slice(0, 80);
    }
  }
  return out;
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
await shimEsmSh(context);
const page = await context.newPage();
page.on("pageerror", (e) => console.log(ts(), "[pageerror]", e.message.slice(0, 200)));

await page.request.post(`${BASE}/api/login`, { data: { email: "admin@example.com", password: "e2e-test-pass" } });
await fetch(LLM_CONTROL, { method: "POST", body: JSON.stringify({ batch: 1, delayMs: 0 }) });

// Seed (fresh browser profile each run, so seed every time).
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
const MANIFEST = {
  name: "E2E Events",
  params: [{ key: "city", type: "string", label: "City", default: "Chattanooga, TN" }],
  state: {
    events: {
      kind: "collection",
      schema: { type: "object", properties: { title: { type: "string" }, date: { type: "string" }, venue: { type: "string" }, url: { type: "string" } }, required: ["title", "date"] },
      identity: ["title", "date"],
      merge: "upsert",
      source: { type: "query", prompt: "List upcoming events in {params.city}.", webSearch: false, refresh: { user: true, schedule: "0 6 * * *" } },
    },
  },
  widget: { defaultSize: "M" },
};
const FILES = {
  "index.html": `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>`,
  "main.tsx": `import { createRoot } from "react-dom/client";\nimport App from "./App";\n(async () => { await window.artifact.ready(); createRoot(document.getElementById("root")!).render(<App />); })();`,
  "App.tsx": `import { useArtifact } from "@artifact/ui";\nexport default function App() {\n  const events = useArtifact<any[]>("events");\n  const rows = Array.isArray(events.data) ? events.data : [];\n  return (<div><div data-testid="status">{events.status}</div><div data-testid="count">{rows.length}</div><button data-testid="refresh" onClick={events.refresh}>Refresh</button></div>);\n}`,
  "Widget.tsx": `import { useArtifact } from "@artifact/ui";\nexport default function Widget() {\n  const events = useArtifact<any[]>("events");\n  return <div data-testid="w-count">{Array.isArray(events.data) ? events.data.length : 0}</div>;\n}`,
  "manifest.json": JSON.stringify(MANIFEST),
};
await page.evaluate(
  async ({ appId, files, manifest }) => {
    const open = () => new Promise((res, rej) => { const r = indexedDB.open("ollama-chat"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const db = await open();
    const now = Date.now();
    await new Promise((res, rej) => {
      const tx = db.transaction(["designers", "apps"], "readwrite");
      tx.objectStore("designers").put({ id: appId, name: manifest.name, files, entry: "main.tsx", manifest, status: "published", version: 1, history: [], createdAt: now, updatedAt: now });
      tx.objectStore("apps").put({ id: appId, name: manifest.name, params: { city: "Chattanooga, TN" }, model: "runpod:test-model", state: {}, widgetEnabled: true, widgetSize: "M", createdAt: now, updatedAt: now });
      tx.oncomplete = () => res(null); tx.onerror = () => rej(tx.error);
    });
    db.close();
  },
  { appId: APP_ID, files: FILES, manifest: MANIFEST }
);

// Prime: one fast interactive refresh (batch 1) so we start from 2 records.
await page.goto(`${BASE}/apps/${APP_ID}`, { waitUntil: "networkidle" });
const frame = () => page.frameLocator("iframe").first();
await frame().getByTestId("refresh").waitFor({ timeout: 60_000 });
await frame().getByTestId("refresh").click();
await frame().getByTestId("count").filter({ hasText: "2" }).waitFor({ timeout: 30_000 });
console.log(ts(), "primed with batch 1:", JSON.stringify(await probe(page)));

// Slow batch 2, tap refresh, leave immediately.
await fetch(LLM_CONTROL, { method: "POST", body: JSON.stringify({ batch: 2, delayMs: 8000 }) });
await frame().getByTestId("refresh").click();
await frame().getByTestId("status").filter({ hasText: "refreshing" }).waitFor({ timeout: 10_000 });
console.log(ts(), "refresh started:", JSON.stringify(await probe(page)));
const preLeave = await probe(page);
const streamId = String(preLeave.pendings[0] ?? "").split("=>")[1];
console.log(ts(), "streamId:", streamId);
await page.goto(`${BASE}/manage`, { waitUntil: "networkidle" });
console.log(ts(), "left to /manage");
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(2000);
  console.log(ts(), "on /manage:", JSON.stringify(await probe(page)));
  console.log(ts(), "redis:", JSON.stringify(await dumpStream(streamId)));
}

// Return and watch all layers, reading the iframe the way the suite does.
await page.goto(`${BASE}/apps/${APP_ID}`, { waitUntil: "networkidle" });
console.log(ts(), "returned to app");
for (let i = 0; i < 10; i++) {
  const nFrames = await page.locator("iframe").count();
  let shown = "?";
  try {
    shown = await frame().getByTestId("count").textContent({ timeout: 2000 });
  } catch {
    shown = "no-count-el";
  }
  let status = "?";
  try {
    status = await frame().getByTestId("status").textContent({ timeout: 1000 });
  } catch {}
  console.log(ts(), `back: iframes=${nFrames} shown=${shown} status=${status}`, JSON.stringify(await probe(page)));
  if (shown === "3") break;
  await page.waitForTimeout(3000);
}

// Widget on home.
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
console.log(ts(), "on home");
for (let i = 0; i < 8; i++) {
  const nFrames = await page.locator("iframe").count();
  let w = "?";
  try {
    w = await frame().getByTestId("w-count").textContent({ timeout: 2000 });
  } catch {
    w = "no-w-count";
  }
  console.log(ts(), `home: iframes=${nFrames} w-count=${w}`);
  if (w === "3") break;
  await page.waitForTimeout(3000);
}
await browser.close();
