"use client";

// Shared pieces of the OpenAI speech-to-text pipeline, used by both the
// composer dictation hook (use-openai-stt.ts) and the hands-free voice
// session (app/lib/voice/use-voice-session.ts).

// Phrases the model leaks through whenever the audio is silent or non-speech.
// Drop them if they're the only thing in the transcript.
const HALLUCINATION_PHRASES = new Set([
  "you",
  "bye",
  "bye.",
  "thanks",
  "thank you",
  "thanks for watching",
  "thanks for watching!",
  "thank you for watching",
  "thank you for watching.",
  "thank you.",
  "subtitles by the amara.org community",
  ".",
  "!",
  "?",
]);

export function cleanTranscript(raw: string): string {
  let t = raw
    .replace(/[\[(][^\])]*[\])]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // A word repeated 3+ times in a row is virtually always a hallucination loop
  // on silence. Drop the loop rather than collapsing - collapsing would leave
  // a stray "you" that the user didn't say.
  t = t.replace(/\b(\w+)(?:\s+\1\b){2,}/gi, "").replace(/\s+/g, " ").trim();
  const normalized = t.toLowerCase().replace(/[.!?,]+$/, "").trim();
  if (!normalized) return "";
  if (HALLUCINATION_PHRASES.has(normalized)) return "";
  return t;
}

// Parse the SSE stream from /api/stt and surface token deltas as they arrive.
// OpenAI emits events like:
//   data: {"type":"transcript.text.delta","delta":"hello"}
//   data: {"type":"transcript.text.done","text":"hello world"}
//   data: [DONE]
export async function streamTranscript(
  res: Response,
  signal: AbortSignal,
  onDelta: (text: string) => void
): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let liveText = "";
  let finalText = "";

  // SSE message boundaries can be either \n\n or \r\n\r\n per spec - handle
  // both, otherwise a CRLF-using upstream silently produces empty transcripts.
  const boundary = /\r?\n\r?\n/;
  const lineSplit = /\r?\n/;
  try {
    while (true) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let match: RegExpExecArray | null;
      while ((match = boundary.exec(buffer)) !== null) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        for (const line of raw.split(lineSplit)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let evt: { type?: string; delta?: string; text?: string };
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          if (evt.type === "transcript.text.delta" && typeof evt.delta === "string") {
            liveText += evt.delta;
            onDelta(liveText);
          } else if (
            evt.type === "transcript.text.done" &&
            typeof evt.text === "string"
          ) {
            finalText = evt.text;
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  return finalText || liveText;
}

// Pick a MediaRecorder MIME type the current browser will actually produce.
// Chrome/Firefox prefer webm/opus; iOS WebKit (Safari and iOS Chrome) only
// supports MP4/AAC. OpenAI's transcription endpoint accepts both.
export function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {}
  }
  return undefined;
}

export function filenameFor(mime: string): string {
  if (mime.includes("mp4")) return "recording.m4a";
  if (mime.includes("ogg")) return "recording.ogg";
  return "recording.webm";
}
