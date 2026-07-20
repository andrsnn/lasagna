#!/usr/bin/env node
// End-to-end test for the OpenAI streaming transcription endpoint and our
// /api/stt proxy. Run with:
//
//   OPENAI_API_KEY=sk-... node scripts/test-stt.mjs path/to/audio.{webm,m4a,wav,mp3}
//
// Optional second arg is a /api/stt URL to also test the proxy round-trip:
//
//   OPENAI_API_KEY=sk-... STT_SESSION_COOKIE='session=...' \
//     node scripts/test-stt.mjs path/to/audio.webm \
//     https://your-app.vercel.app/api/stt
//
// Output mirrors what Vercel logs would show plus the raw bytes coming back
// so we can see exactly what SSE separator + event types OpenAI sends.

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Set OPENAI_API_KEY in env first.");
  process.exit(1);
}

const [, , audioPath, proxyUrl] = process.argv;
if (!audioPath) {
  console.error("Usage: node scripts/test-stt.mjs <audio-file> [proxy-url]");
  process.exit(1);
}

const buf = await readFile(audioPath);
const filename = basename(audioPath);
const ext = extname(filename).slice(1).toLowerCase();

const MIME_BY_EXT = {
  webm: "audio/webm",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  flac: "audio/flac",
};
const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";

console.log(`\n== Input ==`);
console.log(`file:     ${audioPath}`);
console.log(`size:     ${buf.byteLength} bytes`);
console.log(`mime:     ${mime}`);
console.log(`filename: ${filename}`);

async function postToOpenAI({ stream }) {
  const form = new FormData();
  form.append("file", new Blob([buf], { type: mime }), filename);
  form.append("model", "gpt-4o-transcribe");
  form.append("response_format", "json");
  if (stream) form.append("stream", "true");

  const t0 = Date.now();
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const elapsed = Date.now() - t0;

  console.log(`\n== OpenAI (stream=${stream}) ==`);
  console.log(`status:   ${res.status} (${elapsed}ms)`);
  console.log(`headers:  content-type=${res.headers.get("content-type")}`);

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.log(`error:    ${detail.slice(0, 1000)}`);
    return;
  }

  if (!stream) {
    const json = await res.json();
    console.log(`json:     ${JSON.stringify(json).slice(0, 500)}`);
    return;
  }

  // Stream branch: read raw bytes, show them, AND parse SSE events using
  // both \n\n and \r\n\r\n separators.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  console.log(`raw len:  ${raw.length}`);
  console.log(`raw[0..400]: ${JSON.stringify(raw.slice(0, 400))}`);

  // Detect which separator OpenAI used.
  const crlfBoundary = raw.includes("\r\n\r\n");
  const lfBoundary = raw.includes("\n\n");
  console.log(`separators: \\r\\n\\r\\n=${crlfBoundary} \\n\\n=${lfBoundary}`);

  // Robust SSE parse: split on either separator.
  const blocks = raw.split(/\r?\n\r?\n/);
  const events = [];
  for (const block of blocks) {
    const dataLines = [];
    let type = "message";
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      events.push({ kind: "done-marker" });
      continue;
    }
    try {
      const parsed = JSON.parse(data);
      events.push({ kind: parsed.type ?? type, parsed });
    } catch {
      events.push({ kind: "unparsed", data });
    }
  }
  console.log(`events:   ${events.length}`);
  for (const e of events.slice(0, 8)) {
    console.log(`  - ${e.kind}: ${JSON.stringify(e.parsed ?? e.data ?? "").slice(0, 200)}`);
  }
  if (events.length > 8) console.log(`  ... (${events.length - 8} more)`);

  const finalEvt = events.find((e) => e.kind === "transcript.text.done");
  const deltas = events.filter((e) => e.kind === "transcript.text.delta");
  console.log(`deltas:   ${deltas.length}`);
  console.log(`final:    ${finalEvt ? JSON.stringify(finalEvt.parsed.text) : "<none>"}`);
}

await postToOpenAI({ stream: false });
await postToOpenAI({ stream: true });

if (proxyUrl) {
  console.log(`\n== Proxy: ${proxyUrl} ==`);
  const form = new FormData();
  form.append("audio", new Blob([buf], { type: mime }), filename);
  const headers = {};
  if (process.env.STT_SESSION_COOKIE) headers.Cookie = process.env.STT_SESSION_COOKIE;
  const t0 = Date.now();
  const res = await fetch(proxyUrl, { method: "POST", body: form, headers });
  console.log(`status:   ${res.status} (${Date.now() - t0}ms)`);
  console.log(`headers:  content-type=${res.headers.get("content-type")}`);
  const raw = await res.text();
  console.log(`raw[0..600]: ${JSON.stringify(raw.slice(0, 600))}`);
}
