export const runtime = "nodejs";
export const maxDuration = 30;

// Primary model: gpt-4o-mini-tts - markedly more natural prosody than tts-1
// and it accepts free-text style instructions, which is what makes voice
// mode sound like a conversation instead of a screen reader. If the account
// can't use it (or rejects a voice), we fall back to tts-1 transparently.
const PRIMARY_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const FALLBACK_MODEL = "tts-1";

// Input caps: tts-1 caps at 4096 chars; gpt-4o-mini-tts at ~2000 tokens.
// 4000 chars stays inside both for realistic English text.
const MAX_CHARS = 4000;

const DEFAULT_VOICE = "nova";
// Voices tts-1 understands (the classic six).
const CLASSIC_VOICES = new Set([
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
]);
// Everything gpt-4o-mini-tts accepts (classic six + the newer natural set).
const ALLOWED_VOICES = new Set([
  ...CLASSIC_VOICES,
  "ash",
  "ballad",
  "coral",
  "sage",
  "verse",
  "marin",
  "cedar",
]);

const DEFAULT_INSTRUCTIONS =
  "Speak naturally and conversationally, like talking with a friend: warm, relaxed pacing, light intonation. Do not sound like you are reading a document aloud.";

async function requestSpeech(
  key: string,
  model: string,
  voice: string,
  input: string,
  instructions?: string
): Promise<Response> {
  const body: Record<string, unknown> = {
    model,
    voice,
    input,
    response_format: "mp3",
  };
  // Only gpt-4o-* TTS models accept instructions; tts-1 rejects the field.
  if (instructions && model !== FALLBACK_MODEL) body.instructions = instructions;
  return fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export async function POST(req: Request) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return new Response("OPENAI_API_KEY not set", { status: 503 });
  }

  let body: { text?: string; voice?: string; instructions?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const text = (body.text ?? "").trim();
  if (!text) return new Response("text required", { status: 400 });

  const voice =
    body.voice && ALLOWED_VOICES.has(body.voice) ? body.voice : DEFAULT_VOICE;
  const instructions =
    typeof body.instructions === "string" && body.instructions.trim()
      ? body.instructions.trim().slice(0, 500)
      : DEFAULT_INSTRUCTIONS;
  const input = text.slice(0, MAX_CHARS);

  let r = await requestSpeech(key, PRIMARY_MODEL, voice, input, instructions);

  // 4xx from the primary model usually means the key lacks access to it or
  // the voice isn't supported there - retry once on tts-1 with a voice that
  // model understands, rather than surfacing a hard error to the client.
  if (!r.ok && r.status < 500 && PRIMARY_MODEL !== FALLBACK_MODEL) {
    const fallbackVoice = CLASSIC_VOICES.has(voice) ? voice : DEFAULT_VOICE;
    r = await requestSpeech(key, FALLBACK_MODEL, fallbackVoice, input);
  }

  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    return new Response(`openai ${r.status}: ${detail}`, { status: 502 });
  }

  return new Response(r.body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
