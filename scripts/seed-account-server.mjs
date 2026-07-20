// Seed the live demo account by writing directly into the server-side
// account-sync store (Upstash Redis). This sidesteps the race between client
// pushes and server pulls that was wiping the demo data.
//
// Run: node scripts/seed-account-server.mjs
// Requires .env.local with KV_REST_API_URL + KV_REST_API_TOKEN.

import { Redis } from "@upstash/redis";
import { config } from "dotenv";
import { writeFile } from "fs/promises";
import {
  EMAIL,
  NOW,
  MCRIB_FILES,
  PIPELINE_FILES,
  REVENUE_FILES,
  PORTFOLIO_FILES,
  UTAH_FILES,
  UPTIME_FILES,
  RESEARCH_FILES,
  MCRIB_STATE,
  PIPELINE_STATE,
  REVENUE_STATE,
  PORTFOLIO_STATE,
  UTAH_STATE,
  UPTIME_STATE,
  RESEARCH_STATE,
  CHATS,
  NOTES,
  id,
  makeChat,
} from "./seed-data.mjs";

config({ path: ".env.local" });

const SCOPE = EMAIL.trim().toLowerCase();
const PREFIX = `account:${SCOPE}:`;
const INDEX_KEY = `${PREFIX}index`;

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  console.error("Redis credentials missing");
  process.exit(1);
}

const redis = new Redis({ url, token });

function entityKey(type, entityId) {
  return `${PREFIX}${type}:${entityId}`;
}

function indexMember(type, entityId) {
  return `${type}:${entityId}`;
}

async function clearAccountStore() {
  const keys = await redis.keys(`${PREFIX}*`);
  if (keys && keys.length > 0) {
    await redis.del(...keys);
    console.log(`Cleared ${keys.length} key(s) under ${PREFIX}`);
  } else {
    console.log("No existing account-sync keys to clear.");
  }
}

async function upsert(type, payload) {
  const score = Date.now();
  let entityId;
  let updatedAt;
  if (type === "chat") {
    entityId = payload.chat.id;
    updatedAt = payload.chat.updatedAt;
  } else {
    entityId = payload.id;
    updatedAt = payload.updatedAt;
  }

  let toStore = payload;
  if (type === "designer") {
    // Keep files/entry inline; do NOT upload blobs. The demo apps are small
    // enough to fit in a single Redis value, and this avoids needing
    // BLOB_READ_WRITE_TOKEN in .env.local.
    const { history, ...rest } = payload;
    toStore = rest;
  }

  await redis.set(entityKey(type, entityId), JSON.stringify(toStore));
  await redis.zadd(INDEX_KEY, { score, member: indexMember(type, entityId) });
  return updatedAt ?? score;
}

function makeDesigner(name, description, files, entry) {
  return {
    id: id(),
    name,
    description,
    files,
    entry,
    manifest: JSON.parse(files["manifest.json"]),
    status: "published",
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeApp(designer, state, widgetSize, widgetOrder, extra = {}) {
  return {
    id: designer.id,
    name: designer.name,
    params: {},
    model: extra.model || "gemma4:31b",
    state,
    widgetEnabled: true,
    widgetSize,
    widgetOrder,
    widgetUpdatedAt: NOW,
    appEnabled: true,
    lastRunAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

async function seed() {
  await clearAccountStore();

  const appsSeed = [
    {
      name: "Project Pipeline",
      description: "Live project stages and health at a glance.",
      files: PIPELINE_FILES,
      state: PIPELINE_STATE,
      widgetSize: "M",
      widgetOrder: 200,
    },
    {
      name: "Revenue Dashboard",
      description: "Monthly recurring revenue, growth, and 6-month trend.",
      files: REVENUE_FILES,
      state: REVENUE_STATE,
      widgetSize: "M",
      widgetOrder: 300,
    },
    {
      name: "Investment Portfolio",
      description: "Live portfolio value, today's P&L, and top mover.",
      files: PORTFOLIO_FILES,
      state: PORTFOLIO_STATE,
      widgetSize: "M",
      widgetOrder: 400,
    },
    {
      name: "Utah Places to See",
      description: "Nearby Utah attractions sorted by category and rating.",
      files: UTAH_FILES,
      state: UTAH_STATE,
      widgetSize: "M",
      widgetOrder: 500,
    },
    {
      name: "Uptime Monitor",
      description: "Service health and 30-day uptime at a glance.",
      files: UPTIME_FILES,
      state: UPTIME_STATE,
      widgetSize: "M",
      widgetOrder: 550,
    },
    {
      name: "LLM Release Tracker",
      description: "Open-weight LLM releases with org, params, context, and benchmark badges.",
      files: RESEARCH_FILES,
      state: RESEARCH_STATE,
      widgetSize: "W",
      widgetOrder: 600,
      extra: { model: "minimax-m3" },
    },
  ].map((s) => {
    const designer = makeDesigner(s.name, s.description, s.files, "main.tsx");
    const app = makeApp(designer, s.state, s.widgetSize, s.widgetOrder, s.extra ?? {});
    return { designer, app };
  });

  const mcribDesigner = {
    id: id(),
    name: "McRib Tracker",
    description: "Track McRib availability by US market with a live home widget.",
    files: MCRIB_FILES,
    entry: "main.tsx",
    manifest: JSON.parse(MCRIB_FILES["manifest.json"]),
    status: "published",
    version: 2,
    history: [],
    headCommitMessage: "Style status cards and seed market data",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const mcribApp = {
    id: mcribDesigner.id,
    name: "McRib Tracker",
    params: {},
    model: "gemma4:31b",
    state: MCRIB_STATE,
    widgetEnabled: true,
    widgetSize: "M",
    widgetOrder: 100,
    widgetUpdatedAt: NOW,
    appEnabled: true,
    lastRunAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };

  const allDesigners = [mcribDesigner, ...appsSeed.map((s) => s.designer)];
  const allApps = [mcribApp, ...appsSeed.map((s) => s.app)];

  // Helper maps for wiring chats to their originating apps.
  const designerByName = new Map(allDesigners.map((d) => [d.name, d]));
  const appByName = new Map(allApps.map((a) => [a.name, a]));

  // Mark every seeded row as account-shared so the cloud toggle reads "syncing".
  for (const d of allDesigners) {
    d.accountShared = true;
    d.accountSharedAt = NOW;
  }
  for (const a of allApps) {
    a.accountShared = true;
    a.accountSharedAt = NOW;
  }

  // Wire up a couple of seeded chats to their originating designers so the
  // chats list shows "Editing designer ..." instead of every row reading
  // "Free-form".
  const wiredChats = CHATS.map((bundle) => ({ ...bundle }));
  for (const bundle of wiredChats) {
    bundle.chat.accountShared = true;
    bundle.chat.accountSharedAt = NOW;
    if (bundle.chat.title === "Build a project pipeline widget") {
      bundle.chat.target = { kind: "designer", id: designerByName.get("Project Pipeline")?.id };
    } else if (bundle.chat.title === "Revenue dashboard mockup") {
      bundle.chat.target = { kind: "designer", id: designerByName.get("Revenue Dashboard")?.id };
    }
  }

  // Add a research-mode chat: launched from the LLM Release Tracker app, with
  // a structured research result so it renders as a real research session.
  const llmDesigner = designerByName.get("LLM Release Tracker");
  const researchChat = makeChat({
    title: "Research: open-weight LLM leaderboard",
    model: "minimax-m3",
    ttl: true,
    seen: true,
  });
  researchChat.chat.researchFor = llmDesigner?.id;
  researchChat.chat.accountShared = true;
  researchChat.chat.accountSharedAt = NOW;
  const researchAssistantMsg = {
    id: id(),
    chatId: researchChat.chat.id,
    role: "assistant",
    content:
      "I ran research mode across the open-weight LLM landscape. Here's the structured leaderboard for July 2026:",
    model: "minimax-m3",
    createdAt: researchChat.chat.createdAt + 5 * 60 * 1000,
    kind: "research-result",
    researchResult: {
      query: "Open-weight LLM leaderboard July 2026",
      status: "complete",
      schema: { type: "object" },
      columns: [
        { key: "model", label: "Model", type: "string" },
        { key: "org", label: "Org", type: "string" },
        { key: "params", label: "Params", type: "string" },
        { key: "context", label: "Context", type: "string" },
        { key: "badge", label: "Badge", type: "string" },
      ],
      records: [
        { id: "glm-5.2", fields: { model: "GLM-5.2", org: "Zhipu AI", params: "1M ctx", context: "1M", badge: "Long context" } },
        { id: "kimi-k2.7", fields: { model: "Kimi K2.7", org: "Moonshot", params: "1T MoE", context: "256k", badge: "Frontier" } },
        { id: "deepseek-v4-pro", fields: { model: "DeepSeek V4 Pro", org: "DeepSeek", params: "1.6T/49B", context: "1M", badge: "Frontier" } },
        { id: "qwen3.5-397b", fields: { model: "Qwen3.5 397B", org: "Alibaba", params: "397B/17B", context: "256k", badge: "Efficient" } },
        { id: "gpt-oss-120b", fields: { model: "GPT-OSS 120B", org: "OpenAI", params: "120B", context: "128k", badge: "Open weights" } },
      ],
      runs: [
        {
          at: researchChat.chat.createdAt + 5 * 60 * 1000,
          query: "Open-weight LLM leaderboard July 2026",
          status: "complete",
          addedIds: ["glm-5.2", "kimi-k2.7", "deepseek-v4-pro", "qwen3.5-397b", "gpt-oss-120b"],
        },
      ],
    },
  };
  researchChat.messages.push(researchAssistantMsg);

  // Replace the auto-created "Default chat" with a lived-in scratchpad so the
  // chats list never shows the placeholder title. Timestamped slightly ahead so
  // the server copy wins over any locally-created default row on first sync.
  const defaultChat = makeChat({
    title: "General scratchpad",
    model: "kimi-k2.6",
    ttl: false,
    seen: true,
  });
  defaultChat.chat.id = "default";
  defaultChat.chat.updatedAt = NOW + 60 * 60 * 1000;
  defaultChat.chat.accountShared = true;
  defaultChat.chat.accountSharedAt = NOW;
  defaultChat.messages = [
    {
      id: id(),
      chatId: "default",
      role: "user",
      content: "Keep a running list of quick ideas and links here.",
      model: "kimi-k2.6",
      createdAt: defaultChat.chat.createdAt + 60 * 1000,
    },
    {
      id: id(),
      chatId: "default",
      role: "assistant",
      content: "Got it. I'll keep this thread as a lightweight scratchpad - short brainstorms, snippets, and reminders. Just drop things in and I'll organize them on request.",
      model: "kimi-k2.6",
      createdAt: defaultChat.chat.createdAt + 2 * 60 * 1000,
    },
  ];

  const seededChats = [...wiredChats, researchChat, defaultChat];

  // Mark all notes as account-shared so the cloud toggle reads "syncing".
  for (const n of NOTES) {
    n.accountShared = true;
    n.accountSharedAt = NOW;
  }

  for (const d of allDesigners) {
    await upsert("designer", d);
  }
  for (const a of allApps) {
    await upsert("app", a);
  }
  for (const { chat, messages } of seededChats) {
    await upsert("chat", { chat, messages });
  }
  for (const n of NOTES) {
    await upsert("note", n);
  }

  const ids = {
    mcrib: mcribApp.id,
    pipeline: appsSeed.find((s) => s.app.name === "Project Pipeline")?.app.id,
    revenue: appsSeed.find((s) => s.app.name === "Revenue Dashboard")?.app.id,
    portfolio: appsSeed.find((s) => s.app.name === "Investment Portfolio")?.app.id,
    utah: appsSeed.find((s) => s.app.name === "Utah Places to See")?.app.id,
    uptime: appsSeed.find((s) => s.app.name === "Uptime Monitor")?.app.id,
    llm: appsSeed.find((s) => s.app.name === "LLM Release Tracker")?.app.id,
    chatPipeline: seededChats.find((c) => c.chat.title === "Build a project pipeline widget")?.chat.id,
    chatRevenue: seededChats.find((c) => c.chat.title === "Revenue dashboard mockup")?.chat.id,
    chatResearch: researchChat.chat.id,
    noteBirthday: NOTES.find((n) => n.title === "Birthday card - Maya")?.id,
    noteResearch: NOTES.find((n) => n.title === "Deep research: open-weight LLM landscape")?.id,
  };
  await writeFile("demo-ids.json", JSON.stringify(ids, null, 2));

  console.log("Seeded account store for", SCOPE);
  console.log("  designers:", allDesigners.length);
  console.log("  apps:", allApps.length);
  console.log("  chats:", seededChats.length);
  console.log("  notes:", NOTES.length);
  console.log("  ids written to demo-ids.json");
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
