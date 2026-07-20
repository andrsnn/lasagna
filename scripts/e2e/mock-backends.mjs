// In-memory stand-ins for the two external services the platform needs, so
// the REAL app (next start), REAL build pipeline, REAL iframe runtime, and
// REAL Redis-staging data flow can run end-to-end in CI or a dev sandbox:
//
//   1. An Upstash-Redis REST shim (the @upstash/redis client speaks HTTP, so
//      an in-memory command evaluator is protocol-compatible). This is where
//      query streams and schedule results stage "in Redis" during the test -
//      the same temporary-server-copy -> sync-down-to-device flow production
//      uses.
//   2. A RunPod-style OpenAI chat endpoint (RUNPOD_API_BASE points here) that
//      returns canned structured events. POST /__control switches datasets
//      and adds artificial latency so tests can leave mid-flight and return.
//
// Usage: node scripts/e2e/mock-backends.mjs [redisPort] [llmPort]

import http from "node:http";

const REDIS_PORT = Number(process.argv[2] ?? 8199);
const LLM_PORT = Number(process.argv[3] ?? 8198);

// ---------------------------------------------------------------------------
// Upstash REST shim
// ---------------------------------------------------------------------------

/** key -> { v: value, exp: epochMs|null }. Values: string | list | set | hash | zset */
const store = new Map();

function now() {
  return Date.now();
}
function live(key) {
  const e = store.get(key);
  if (!e) return undefined;
  if (e.exp !== null && e.exp <= now()) {
    store.delete(key);
    return undefined;
  }
  return e;
}
function setEntry(key, v, exp = null) {
  store.set(key, { v, exp });
}

function glob(pattern) {
  const re = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
  return (s) => re.test(s);
}

function exec(cmd) {
  const [op0, ...args] = cmd;
  const op = String(op0).toUpperCase();
  switch (op) {
    case "SET": {
      const [key, value, ...opts] = args;
      let exp = null;
      let nx = false;
      let xx = false;
      for (let i = 0; i < opts.length; i++) {
        const o = String(opts[i]).toUpperCase();
        if (o === "EX") exp = now() + Number(opts[++i]) * 1000;
        else if (o === "PX") exp = now() + Number(opts[++i]);
        else if (o === "EXAT") exp = Number(opts[++i]) * 1000;
        else if (o === "NX") nx = true;
        else if (o === "XX") xx = true;
        else if (o === "KEEPTTL") exp = live(key)?.exp ?? null;
      }
      const exists = live(key) !== undefined;
      if ((nx && exists) || (xx && !exists)) return null;
      setEntry(key, String(value), exp);
      return "OK";
    }
    case "GET": {
      const e = live(args[0]);
      return e === undefined ? null : e.v;
    }
    case "MGET":
      return args.map((k) => (live(k) === undefined ? null : live(k).v));
    case "DEL":
    case "UNLINK": {
      let n = 0;
      for (const k of args) if (store.delete(k)) n++;
      return n;
    }
    case "EXISTS": {
      let n = 0;
      for (const k of args) if (live(k) !== undefined) n++;
      return n;
    }
    case "EXPIRE": {
      const e = live(args[0]);
      if (!e) return 0;
      e.exp = now() + Number(args[1]) * 1000;
      return 1;
    }
    case "PERSIST": {
      const e = live(args[0]);
      if (!e || e.exp === null) return 0;
      e.exp = null;
      return 1;
    }
    case "TTL": {
      const e = live(args[0]);
      if (!e) return -2;
      if (e.exp === null) return -1;
      return Math.max(0, Math.ceil((e.exp - now()) / 1000));
    }
    case "PTTL": {
      const e = live(args[0]);
      if (!e) return -2;
      if (e.exp === null) return -1;
      return Math.max(0, e.exp - now());
    }
    case "INCR":
    case "INCRBY": {
      const by = op === "INCR" ? 1 : Number(args[1]);
      const e = live(args[0]);
      const next = (e ? Number(e.v) : 0) + by;
      setEntry(args[0], String(next), e?.exp ?? null);
      return next;
    }
    case "TYPE": {
      const e = live(args[0]);
      if (!e) return "none";
      if (typeof e.v === "string") return "string";
      if (Array.isArray(e.v)) return "list";
      if (e.v instanceof Set) return "set";
      if (e.v instanceof Map) return e.v.__zset ? "zset" : "hash";
      return "string";
    }
    case "LPUSH":
    case "RPUSH": {
      const e = live(args[0]) ?? { v: [], exp: null };
      if (!Array.isArray(e.v)) throw new Error("WRONGTYPE");
      const items = args.slice(1).map(String);
      if (op === "LPUSH") e.v.unshift(...items.reverse());
      else e.v.push(...items);
      store.set(args[0], e);
      return e.v.length;
    }
    case "LRANGE": {
      const e = live(args[0]);
      if (!e) return [];
      const list = e.v;
      let start = Number(args[1]);
      let stop = Number(args[2]);
      if (start < 0) start = Math.max(0, list.length + start);
      if (stop < 0) stop = list.length + stop;
      return list.slice(start, stop + 1);
    }
    case "LTRIM": {
      const e = live(args[0]);
      if (e) {
        const list = e.v;
        let start = Number(args[1]);
        let stop = Number(args[2]);
        if (start < 0) start = Math.max(0, list.length + start);
        if (stop < 0) stop = list.length + stop;
        e.v = list.slice(start, stop + 1);
      }
      return "OK";
    }
    case "LLEN": {
      const e = live(args[0]);
      return e ? e.v.length : 0;
    }
    case "SADD": {
      const e = live(args[0]) ?? { v: new Set(), exp: null };
      let n = 0;
      for (const m of args.slice(1).map(String)) {
        if (!e.v.has(m)) {
          e.v.add(m);
          n++;
        }
      }
      store.set(args[0], e);
      return n;
    }
    case "SREM": {
      const e = live(args[0]);
      if (!e) return 0;
      let n = 0;
      for (const m of args.slice(1).map(String)) if (e.v.delete(m)) n++;
      return n;
    }
    case "SMEMBERS": {
      const e = live(args[0]);
      return e ? [...e.v] : [];
    }
    case "SISMEMBER": {
      const e = live(args[0]);
      return e && e.v.has(String(args[1])) ? 1 : 0;
    }
    case "SCARD": {
      const e = live(args[0]);
      return e ? e.v.size : 0;
    }
    case "HSET": {
      const e = live(args[0]) ?? { v: new Map(), exp: null };
      let n = 0;
      for (let i = 1; i < args.length; i += 2) {
        if (!e.v.has(String(args[i]))) n++;
        e.v.set(String(args[i]), String(args[i + 1]));
      }
      store.set(args[0], e);
      return n;
    }
    case "HGET": {
      const e = live(args[0]);
      return e ? (e.v.get(String(args[1])) ?? null) : null;
    }
    case "HGETALL": {
      const e = live(args[0]);
      if (!e) return null;
      const flat = [];
      for (const [k, v] of e.v) flat.push(k, v);
      return flat;
    }
    case "HDEL": {
      const e = live(args[0]);
      if (!e) return 0;
      let n = 0;
      for (const f of args.slice(1)) if (e.v.delete(String(f))) n++;
      return n;
    }
    case "HLEN": {
      const e = live(args[0]);
      return e ? e.v.size : 0;
    }
    case "ZADD": {
      const e = live(args[0]) ?? { v: Object.assign(new Map(), { __zset: true }), exp: null };
      let n = 0;
      for (let i = 1; i < args.length; i += 2) {
        const member = String(args[i + 1]);
        if (!e.v.has(member)) n++;
        e.v.set(member, Number(args[i]));
      }
      store.set(args[0], e);
      return n;
    }
    case "ZCARD": {
      const e = live(args[0]);
      return e ? e.v.size : 0;
    }
    case "ZREM": {
      const e = live(args[0]);
      if (!e) return 0;
      let n = 0;
      for (const m of args.slice(1)) if (e.v.delete(String(m))) n++;
      return n;
    }
    case "ZRANGE": {
      const e = live(args[0]);
      if (!e) return [];
      const sorted = [...e.v.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
      let start = Number(args[1]);
      let stop = Number(args[2]);
      if (start < 0) start = Math.max(0, sorted.length + start);
      if (stop < 0) stop = sorted.length + stop;
      return sorted.slice(start, stop + 1);
    }
    case "ZREMRANGEBYRANK": {
      const e = live(args[0]);
      if (!e) return 0;
      const sorted = [...e.v.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
      let start = Number(args[1]);
      let stop = Number(args[2]);
      if (start < 0) start = Math.max(0, sorted.length + start);
      if (stop < 0) stop = sorted.length + stop;
      const doomed = sorted.slice(start, stop + 1);
      for (const m of doomed) e.v.delete(m);
      return doomed.length;
    }
    case "SCAN": {
      // Single-pass cursor: return everything on cursor 0.
      const opts = args.slice(1).map(String);
      let match = "*";
      for (let i = 0; i < opts.length; i++) {
        if (opts[i].toUpperCase() === "MATCH") match = opts[i + 1];
      }
      const test = glob(match);
      const keys = [...store.keys()].filter((k) => live(k) !== undefined && test(k));
      return ["0", keys];
    }
    case "KEYS": {
      const test = glob(String(args[0]));
      return [...store.keys()].filter((k) => live(k) !== undefined && test(k));
    }
    case "PING":
      return "PONG";
    default:
      throw new Error(`shim: unsupported command ${op}`);
  }
}

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}
/** Base64-encode string results (client decodes everything except "OK"). */
function encodeResult(r) {
  if (r === null || r === undefined) return null;
  if (typeof r === "number") return r;
  if (typeof r === "string") return r === "OK" ? "OK" : b64(r);
  if (Array.isArray(r)) return r.map(encodeResult);
  return r;
}

const redisServer = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const respond = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  try {
    const url = new URL(req.url, "http://x");
    const parsed = body ? JSON.parse(body) : [];
    if (url.pathname === "/pipeline" || url.pathname === "/multi-exec") {
      const results = parsed.map((cmd) => {
        try {
          return { result: encodeResult(exec(cmd)) };
        } catch (e) {
          return { error: String(e.message ?? e) };
        }
      });
      return respond(200, results);
    }
    // Single command: POST / with a JSON array.
    return respond(200, { result: encodeResult(exec(parsed)) });
  } catch (e) {
    return respond(400, { error: String(e?.message ?? e) });
  }
});

// ---------------------------------------------------------------------------
// RunPod-style OpenAI mock
// ---------------------------------------------------------------------------

// Two distinguishable datasets. Batch 2 intentionally repeats the Jack White
// event with different casing/punctuation and a blank venue (dedupe +
// fill-blanks must handle it) and brings one genuinely new event. NOTE: the
// mock emulates a schema-COMPLIANT model - identity fields (title/date) are
// always present and non-empty, because the platform hardens them to required
// in the query schema and a real model's repair loop enforces that. The
// drop-identity-less-rows backstop is unit-covered in the merge exercises.
const BATCH_1 = [
  { title: "Jack White - Frozen Charlotte Early Listening Party", date: "2099-07-08", venue: "Yellow Racket Records", category: "music" },
  { title: "Gooda Cheese w/ The Revolt", date: "2099-07-08", venue: "The Spot", category: "music" },
];
const BATCH_2 = [
  { title: "Jack White — Frozen Charlotte EARLY Listening Party!", date: "2099-07-08", venue: "", url: "https://example.com/jack", category: "music" },
  { title: "Remi Goode - Intimate Alt-Folk Performance", date: "2099-07-09", venue: "The Woodshop Listening Room", category: "music" },
];

const control = { delayMs: 0, batch: 1, calls: 0 };

const llmServer = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const respond = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__control") {
    const patch = body ? JSON.parse(body) : {};
    Object.assign(control, patch);
    return respond(200, { ok: true, control });
  }
  if (url.pathname.endsWith("/models")) {
    return respond(200, { object: "list", data: [{ id: "test-model", object: "model" }] });
  }
  if (url.pathname.endsWith("/chat/completions")) {
    control.calls++;
    if (control.delayMs > 0) await new Promise((r) => setTimeout(r, control.delayMs));
    const events = control.batch >= 2 ? BATCH_2 : BATCH_1;
    return respond(200, {
      id: `chatcmpl-mock-${control.calls}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "test-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: JSON.stringify(events) },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 },
    });
  }
  return respond(404, { error: `mock: no route ${url.pathname}` });
});

redisServer.listen(REDIS_PORT, () => console.log(`[mock] upstash shim on :${REDIS_PORT}`));
llmServer.listen(LLM_PORT, () => console.log(`[mock] llm mock on :${LLM_PORT}`));
