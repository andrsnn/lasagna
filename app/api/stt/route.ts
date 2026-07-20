export const runtime = "nodejs";
// Voice mode records in segments of a few minutes each; give the upstream
// transcription call plenty of wall clock to chew through one.
export const maxDuration = 300;

const MODEL = "gpt-4o-transcribe";

// Map a Blob MIME (or an incoming filename) to one of OpenAI's accepted
// extensions: mp3, mp4, mpeg, mpga, m4a, wav, webm, ogg, flac. Anything we
// don't recognize falls back to .webm — MediaRecorder's most common output.
function upstreamFilename(clientName: string | undefined, mime: string): string {
  if (clientName && /\.(mp3|mp4|m4a|mpeg|mpga|wav|webm|ogg|oga|flac)$/i.test(clientName)) {
    return clientName;
  }
  const m = (mime || "").toLowerCase();
  if (m.includes("mp4") || m.includes("aac") || m.includes("m4a")) return "recording.m4a";
  if (m.includes("ogg")) return "recording.ogg";
  if (m.includes("wav")) return "recording.wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "recording.mp3";
  if (m.includes("flac")) return "recording.flac";
  return "recording.webm";
}

export async function POST(req: Request) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return new Response("OPENAI_API_KEY not set", { status: 503 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response("expected multipart/form-data", { status: 400 });
  }

  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return new Response("audio required", { status: 400 });
  }
  const prompt = form.get("prompt");

  // OpenAI's transcription API sniffs the audio container from the filename
  // extension — it won't auto-detect from the blob's MIME type. MediaRecorder
  // produces webm/opus on Chrome/Firefox and mp4/aac on iOS WebKit, so a
  // hardcoded ".wav" filename ends in a 400 every time. Derive the extension
  // from whatever filename the client sent, falling back to the blob's MIME.
  const clientName =
    audio instanceof File && audio.name ? audio.name : undefined;
  const filename = upstreamFilename(clientName, audio.type);

  const upstream = new FormData();
  upstream.append("file", audio, filename);
  upstream.append("model", MODEL);
  upstream.append("response_format", "json");
  upstream.append("stream", "true");
  if (typeof prompt === "string" && prompt.trim()) {
    upstream.append("prompt", prompt.trim().slice(0, 1000));
  }

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: upstream,
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    console.error(
      `[stt] openai ${r.status} (file=${filename} mime=${audio.type || "?"} size=${audio.size}): ${detail.slice(0, 500)}`
    );
    return new Response(`openai ${r.status}: ${detail}`, { status: 502 });
  }

  console.log(
    `[stt] openai 200 (file=${filename} mime=${audio.type || "?"} size=${audio.size})`
  );

  // Tee the SSE stream: forward one branch to the client unchanged, drain the
  // other into Vercel logs so we can see what OpenAI actually said when the
  // UI dead-ends in "Didn't catch that". A 200 with an empty transcript is
  // indistinguishable from a routing bug from the browser side.
  if (!r.body) {
    return new Response("", {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
      },
    });
  }
  const [clientStream, logStream] = r.body.tee();
  void (async () => {
    try {
      const reader = logStream.getReader();
      const decoder = new TextDecoder();
      let raw = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
      }
      // Parse SSE accepting either \n\n or \r\n\r\n message boundaries — the
      // spec allows both, and our previous \n\n-only parser would silently
      // drop everything if OpenAI ever sent CRLF.
      const blocks = raw.split(/\r?\n\r?\n/);
      let finalText = "";
      let deltaCount = 0;
      const types: string[] = [];
      for (const block of blocks) {
        const dataLines: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        const payload = dataLines.join("\n");
        if (!payload || payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload) as {
            type?: string;
            delta?: string;
            text?: string;
          };
          if (evt.type) types.push(evt.type);
          if (evt.type === "transcript.text.delta") deltaCount++;
          else if (evt.type === "transcript.text.done" && typeof evt.text === "string") {
            finalText = evt.text;
          }
        } catch {}
      }
      const uniqueTypes = Array.from(new Set(types));
      console.log(
        `[stt] openai transcript: rawLen=${raw.length} deltas=${deltaCount} types=${JSON.stringify(uniqueTypes)} final=${JSON.stringify(finalText)}`
      );
      // If we didn't recognize any events, dump the first 400 chars of the
      // raw response so we can see what OpenAI actually sent.
      if (!finalText && deltaCount === 0) {
        console.log(`[stt] openai raw[0..400]=${JSON.stringify(raw.slice(0, 400))}`);
      }
    } catch (e) {
      console.error(`[stt] log-stream error`, e);
    }
  })();

  return new Response(clientStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
    },
  });
}
