// End-to-end test of the SCHEDULE pipeline - the path the interactive suite
// (v2-leave-return.mjs) doesn't cover, and where the production bugs lived:
// register -> stored task correctness -> server-side run -> result bridged
// into app state, plus the fossil pathology observed in production
// (pre-attestation registrations carrying a wrong model and a literal
// "{params.city}" prompt):
//
//   A1. A declared-cron app registers its schedule with the prompt
//       interpolated and the app's model, attested.
//   A2. "Run now" completes on the app's configured model and the result
//       reaches the app frame (bridge -> useArtifact).
//   B1. A planted fossil ({params.city} prompt) is REJECTED by the server
//       guard with an actionable error instead of running as junk.
//   B2. Opening an app whose schedule is an sdk-origin fossil (no manifest
//       schedule, so only the healer can fix it) corrects model + prompt.
//
// Run via scripts/e2e/run.sh (mocks + next server already up).

import { chromium } from "playwright-core";
import { shimEsmSh } from "./esm-shim.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3123";
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const TEMP_PASS = process.env.E2E_TEMP_PASS ?? "e2e-test-pass";
const CRON_APP = "e2e-sched-app";
const HEAL_APP = "e2e-heal-app";

let cookieHeader = "";
const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
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

const EVENT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    date: { type: "string" },
    venue: { type: "string" },
    url: { type: "string" },
    category: { enum: ["music", "other"] },
  },
  required: ["title", "date"],
};

function manifestFor(name, withCron) {
  return {
    name,
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
          refresh: withCron ? { user: true, schedule: "0 6 * * *" } : { user: true },
        },
      },
    },
    widget: { defaultSize: "M" },
  };
}

function filesFor(manifest) {
  return {
    "index.html": `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>`,
    "main.tsx": `import { createRoot } from "react-dom/client";\nimport App from "./App";\n(async () => { await window.artifact.ready(); createRoot(document.getElementById("root")!).render(<App />); })();`,
    "App.tsx": `import { useArtifact } from "@artifact/ui";\nexport default function App() {\n  const events = useArtifact<any[]>("events");\n  const rows = Array.isArray(events.data) ? events.data : [];\n  return (<div><div data-testid="status">{events.status}</div><div data-testid="count">{rows.length}</div><div data-testid="error">{events.error ?? ""}</div><button data-testid="refresh" onClick={events.refresh}>Refresh</button></div>);\n}`,
    "Widget.tsx": `import { useArtifact } from "@artifact/ui";\nexport default function Widget() {\n  const events = useArtifact<any[]>("events");\n  return <div data-testid="w-count">{Array.isArray(events.data) ? events.data.length : 0}</div>;\n}`,
    "manifest.json": JSON.stringify(manifest),
  };
}

async function seedApp(page, appId, manifest) {
  await page.evaluate(
    async ({ appId, files, manifest }) => {
      const open = () =>
        new Promise((res, rej) => {
          const r = indexedDB.open("ollama-chat");
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      const db = await open();
      const now = Date.now();
      await new Promise((res, rej) => {
        const tx = db.transaction(["designers", "apps"], "readwrite");
        tx.objectStore("designers").put({
          id: appId, name: manifest.name, files, entry: "main.tsx", manifest,
          status: "published", version: 1, history: [], createdAt: now, updatedAt: now,
        });
        tx.objectStore("apps").put({
          // params:{} on purpose - apps are created empty and the "city"
          // default lives ONLY in the manifest. If the prompt's {params.city}
          // isn't resolved from that default, the stored prompt keeps the
          // literal placeholder and scans return nothing (the production bug).
          id: appId, name: manifest.name, params: {},
          model: "runpod:test-model", state: {}, widgetEnabled: false,
          createdAt: now, updatedAt: now,
        });
        tx.oncomplete = () => res(null);
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    },
    { appId, files: filesFor(manifest), manifest }
  );
}

async function getSnapshot(page, appId) {
  const r = await page.request.get(`${BASE}/api/schedules/${appId}`, { headers: { cookie: cookieHeader } });
  if (r.status() === 404) return null;
  if (!r.ok()) throw new Error(`snapshot GET ${r.status()}`);
  return r.json();
}

async function pollSnapshot(page, appId, predicate, label, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    last = await getSnapshot(page, appId).catch(() => null);
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label}: timed out. last=${JSON.stringify(last)?.slice(0, 300)}`);
}

async function runNow(page, appId) {
  // 409 = another run holds the lock (e.g. a catch-up) - wait and retry.
  for (let i = 0; i < 20; i++) {
    const r = await page.request.post(`${BASE}/api/schedules/${appId}/run`, { headers: { cookie: cookieHeader } });
    if (r.ok()) return;
    if (r.status() !== 409) throw new Error(`run POST ${r.status()}: ${await r.text()}`);
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error("run POST kept returning 409");
}

async function main() {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
  await shimEsmSh(context);
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));

  const login = await page.request.post(`${BASE}/api/login`, {
    data: { email: ADMIN_EMAIL, password: TEMP_PASS },
  });
  if (!login.ok()) throw new Error(`login failed: ${login.status()}`);
  // The session cookies are Secure; Chromium's browser stack accepts them on
  // 127.0.0.1 (trustworthy origin) but the Node-side request jar drops them,
  // so page.request calls would 401. Carry them explicitly.
  cookieHeader = (await login.headersArray())
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value.split(";")[0])
    .join("; ");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await seedApp(page, CRON_APP, manifestFor("E2E Sched", true));
  // HEAL_APP declares a cron too (like the production Concert Calendar): a
  // fossil gets planted on it, then opening the app must fully heal it.
  await seedApp(page, HEAL_APP, manifestFor("E2E Heal", true));


  // Read app.state.<key> length from the device store. The schedule pipeline's
  // durable output is app.state (the bridge writes there); the iframe DOM
  // rendering it is a separate, flaky-under-load concern covered by the
  // interactive suite - so schedule assertions poll STATE, not the iframe.
  async function pollStateEvents(page, appId, min, label, timeoutMs = 90_000) {
    const until = Date.now() + timeoutMs;
    let last;
    while (Date.now() < until) {
      last = await page
        .evaluate(async (id) => {
          const db = await new Promise((res) => {
            const q = indexedDB.open("ollama-chat");
            q.onsuccess = () => res(q.result);
          });
          const a = await new Promise((res) => {
            const q = db.transaction("apps").objectStore("apps").get(id);
            q.onsuccess = () => res(q.result);
          });
          db.close();
          const ev = a?.state?.events;
          return Array.isArray(ev) ? ev.length : -1;
        }, appId)
        .catch(() => -1);
      if (last >= min) return last;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`${label}: app.state.events length stayed ${last} (want >= ${min})`);
  }

  // Mount the app frame so its on-mount effects (schedule register / heal /
  // bridge) fire. Effects run whether or not the count element paints, so we
  // don't gate on the iframe DOM - we give the build+mount a moment, then let
  // the caller assert on the durable surface (API snapshot or app.state).
  async function mountApp(appId) {
    await page.goto(`${BASE}/apps/${appId}`, { waitUntil: "networkidle" });
    await page.locator("iframe").first().waitFor({ timeout: 60_000 }).catch(() => {});
  }

  // === A1: declared-cron registration is interpolated + attested ==========
  await check("declared cron registers with interpolated prompt and the app's model", async () => {
    await mountApp(CRON_APP);
    const snap = await pollSnapshot(page, CRON_APP, (s) => !!s?.task, "registration");
    if (/\{params\./.test(snap.task.prompt)) throw new Error(`placeholder stored: ${snap.task.prompt}`);
    if (!snap.task.prompt.includes("Chattanooga, TN")) throw new Error(`prompt not interpolated: ${snap.task.prompt}`);
    if (snap.task.model !== "runpod:test-model") throw new Error(`model stored as ${snap.task.model}`);
    return `stored: model=${snap.task.model}`;
  });

  // === A2: Run now -> completes on the app's model -> result reaches state =
  await check("Run now completes on the configured model and data reaches app.state", async () => {
    await runNow(page, CRON_APP);
    const snap = await pollSnapshot(
      page, CRON_APP,
      (s) => s.status === "complete" || s.status === "error",
      "run settle", 90_000
    );
    if (snap.status !== "complete") throw new Error(`run ${snap.status}: ${snap.error}`);
    const run = snap.history?.[0];
    if (run?.modelUsed !== "runpod:test-model") {
      throw new Error(`ran on ${run?.modelUsed ?? "unknown"} instead of runpod:test-model`);
    }
    if (!Array.isArray(snap.result) || snap.result.length < 2) {
      throw new Error(`result not the expected array: ${JSON.stringify(snap.result)?.slice(0, 120)}`);
    }
    // Reload the app: the frame's snapshot fetch bridges the result into
    // app.state (the durable surface useArtifact reads).
    await mountApp(CRON_APP);
    const n = await pollStateEvents(page, CRON_APP, 2, "A2 bridge");
    return `run on runpod:test-model, ${n} records bridged into app.state`;
  });

  // === B: plant the production fossil on the no-manifest-schedule app =====
  // sdk-origin, wrong model, literal {params.city} - exactly the observed bug.
  await check("fossil planted (wrong model + literal {params.city})", async () => {
    const r = await page.request.post(`${BASE}/api/schedules/register`, {
      headers: { cookie: cookieHeader },
      data: {
        appId: HEAL_APP,
        schedule: {
          cron: "0 6 * * *",
          type: "query",
          prompt: "List upcoming events in {params.city}.",
          model: "fossil-wrong-model",
        },
        origin: "sdk",
        modelResolved: true, // emulate the pre-fix era: the bad value IS stored
      },
    });
    if (!r.ok()) throw new Error(`plant failed ${r.status()}`);
    const snap = await getSnapshot(page, HEAL_APP);
    if (snap?.task?.model !== "fossil-wrong-model") throw new Error("fossil model not stored");
    if (!/\{params\.city\}/.test(snap.task.prompt)) throw new Error("fossil prompt not stored");
  });

  // === B1: server guard fails the fossil run with an actionable error =====
  await check("server guard rejects a run whose prompt still holds {params.*}", async () => {
    await runNow(page, HEAL_APP);
    const snap = await pollSnapshot(
      page, HEAL_APP,
      (s) => s.status === "complete" || s.status === "error",
      "fossil run settle", 90_000
    );
    if (snap.status !== "error") throw new Error(`fossil run ${snap.status} - guard missed it`);
    if (!/placeholders/i.test(snap.error ?? "")) throw new Error(`unhelpful error: ${snap.error}`);
    return `failed fast: "${(snap.error ?? "").slice(0, 60)}..."`;
  });

  // === B2: opening the app heals the fossil (model + prompt + schema) =====
  await check("opening the app heals the fossil (model + interpolated prompt + schema)", async () => {
    await mountApp(HEAL_APP);
    const snap = await pollSnapshot(
      page, HEAL_APP,
      (s) =>
        s?.task?.model === "runpod:test-model" &&
        !/\{params\./.test(s?.task?.prompt ?? "") &&
        s?.task?.schema != null,
      "heal", 60_000
    );
    // The param default (manifest-only, app.params was {}) must be substituted.
    if (!snap.task.prompt.includes("Chattanooga, TN")) throw new Error(`prompt: ${snap.task.prompt}`);
    return "healed to the app's model, real city in prompt, schema restored";
  });

  // === B3: the healed schedule now runs to completion ======================
  await check("healed schedule runs to completion with results", async () => {
    await page.goto(`${BASE}/manage`, { waitUntil: "networkidle" }); // no frames racing the lock
    await runNow(page, HEAL_APP);
    const snap = await pollSnapshot(
      page, HEAL_APP,
      (s) => (s.status === "complete" || s.status === "error") && s.runAt != null && !/placeholders/i.test(s.error ?? ""),
      "healed run settle", 90_000
    );
    if (snap.status !== "complete") throw new Error(`healed run ${snap.status}: ${snap.error}`);
    if (!Array.isArray(snap.result) || snap.result.length < 2) {
      throw new Error(`no results: ${JSON.stringify(snap.result)?.slice(0, 120)}`);
    }
  });

  // === C: top-level manifest.schedule prompt is interpolated too ==========
  // The declared-entry path (A/B) interpolated; the top-level schedule path
  // was the hole that re-stored a raw {params.city} on every mount and fought
  // the healer. This seeds an app with a top-level manifest.schedule and
  // asserts the registered prompt has the manifest param default substituted.
  await check("top-level manifest.schedule registers with an interpolated prompt", async () => {
    const TOP_APP = "e2e-topsched-app";
    const topManifest = {
      name: "E2E TopSched",
      params: [{ key: "city", type: "string", label: "City", default: "Chattanooga, TN" }],
      schedule: {
        cron: "0 6 * * *",
        type: "query",
        prompt: "List upcoming events in {params.city}.",
        schema: { type: "array", items: EVENT_SCHEMA },
      },
      state: {
        events: {
          kind: "collection",
          schema: EVENT_SCHEMA,
          identity: ["title", "date"],
          merge: "upsert",
          source: { type: "query", prompt: "unused", refresh: { user: true } },
        },
      },
      widget: { defaultSize: "M" },
    };
    await seedApp(page, TOP_APP, topManifest);
    await mountApp(TOP_APP);
    const snap = await pollSnapshot(page, TOP_APP, (s) => !!s?.task, "top-level registration");
    if (/\{params\./.test(snap.task.prompt)) throw new Error(`placeholder stored: ${snap.task.prompt}`);
    if (!snap.task.prompt.includes("Chattanooga, TN")) throw new Error(`not interpolated: ${snap.task.prompt}`);
    if (snap.task.model !== "runpod:test-model") throw new Error(`model: ${snap.task.model}`);
    return "top-level prompt interpolated + model app-first";
  });

  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} schedule checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("schedule e2e driver crashed:", e);
  process.exit(1);
});
