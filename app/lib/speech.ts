"use client";

import { useEffect, useState } from "react";
import { getCachedAudio, putCachedAudio } from "./audio-cache";

// Strip markdown syntax that reads badly through TTS: code fences,
// link/image syntax, headings, emphasis, raw URLs, HTML tags.
export function stripForSpeech(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__|\*|_)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type SpeechStatus = "idle" | "loading" | "playing";
export type SpeechState = { id: string | null; status: SpeechStatus };

const DEFAULT_VOICE = "nova";

// Module-level singleton so any number of message rows share one playback
// state — clicking Speak on row B cancels row A's playback and flips A's
// menu back to "Speak" without each row tracking the other.
let state: SpeechState = { id: null, status: "idle" };
let abortCtrl: AbortController | null = null;

// Web Audio path (preferred for cached blobs): created lazily in a user
// gesture so iOS Safari associates the context with that gesture and
// allows playback. HTMLAudio + MediaSource covers the streaming path.
let audioCtx: AudioContext | null = null;
let activeSource: AudioBufferSourceNode | null = null;
let audioEl: HTMLAudioElement | null = null;
let audioUrl: string | null = null;
let activeMediaSource: MediaSource | null = null;

const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function setState(next: SpeechState) {
  state = next;
  // Any transition back to idle means playback is over — release the
  // MediaSession so the lock-screen "Now Playing" tile and its controls go
  // away instead of lingering as a paused phantom.
  if (next.status === "idle") clearMediaSession();
  notify();
}

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (audioCtx) return audioCtx;
  type Ctor = typeof AudioContext;
  const Ctx: Ctor | undefined =
    (window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
  if (!Ctx) return null;
  try {
    audioCtx = new Ctx();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

function stopActiveSource() {
  if (activeSource) {
    try {
      activeSource.onended = null;
      activeSource.stop();
    } catch {}
    try {
      activeSource.disconnect();
    } catch {}
    activeSource = null;
  }
}

function clearHtmlAudio() {
  if (audioEl) {
    try {
      audioEl.pause();
    } catch {}
    audioEl.onended = null;
    audioEl.onerror = null;
    audioEl = null;
  }
  if (audioUrl) {
    try {
      URL.revokeObjectURL(audioUrl);
    } catch {}
    audioUrl = null;
  }
  if (activeMediaSource) {
    try {
      if (activeMediaSource.readyState === "open") {
        activeMediaSource.endOfStream();
      }
    } catch {}
    activeMediaSource = null;
  }
}

function clearAudio() {
  stopActiveSource();
  clearHtmlAudio();
}

// Wire up the MediaSession so mobile OSes treat this as active media: they
// keep the audio session alive after the screen locks / the tab is
// backgrounded (instead of pausing it) and surface lock-screen + Control
// Center transport controls. The play/pause handlers drive the underlying
// <audio> element directly so a lock-screen pause resumes cleanly; stop tears
// everything down. No-op where MediaSession isn't available.
function applyMediaSession(text: string) {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try {
    const ms = navigator.mediaSession;
    if (typeof MediaMetadata !== "undefined") {
      const title = text.split(/\s+/).slice(0, 8).join(" ").slice(0, 120);
      ms.metadata = new MediaMetadata({
        title: title || "Spoken message",
        artist: "Spoken message",
      });
    }
    ms.playbackState = "playing";
    const set = (action: MediaSessionAction, handler: (() => void) | null) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {}
    };
    set("play", () => {
      if (audioEl) {
        void audioEl.play().catch(() => {});
        ms.playbackState = "playing";
      }
    });
    set("pause", () => {
      if (audioEl) {
        try {
          audioEl.pause();
        } catch {}
        ms.playbackState = "paused";
      }
    });
    set("stop", () => stopSpeaking());
  } catch {}
}

function clearMediaSession() {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try {
    const ms = navigator.mediaSession;
    ms.playbackState = "none";
    ms.metadata = null;
    for (const a of ["play", "pause", "stop"] as MediaSessionAction[]) {
      try {
        ms.setActionHandler(a, null);
      } catch {}
    }
  } catch {}
}

export function isSpeechSupported(): boolean {
  // We're supported whenever we're in a browser — we always have either
  // fetch + <Audio> for the backend path, or speechSynthesis for fallback.
  return typeof window !== "undefined";
}

function canStreamMpeg(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof MediaSource === "undefined") return false;
  try {
    return MediaSource.isTypeSupported("audio/mpeg");
  } catch {
    return false;
  }
}

function speakWithBrowserFallback(id: string, cleaned: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    setState({ id: null, status: "idle" });
    return;
  }
  try {
    window.speechSynthesis.cancel();
  } catch {}
  const u = new SpeechSynthesisUtterance(cleaned);
  u.rate = 1.0;
  u.pitch = 1.0;
  u.volume = 1.0;
  u.onend = () => {
    if (state.id === id) setState({ id: null, status: "idle" });
  };
  u.onerror = () => {
    if (state.id === id) setState({ id: null, status: "idle" });
  };
  setState({ id, status: "playing" });
  window.speechSynthesis.speak(u);
}

async function playWithWebAudio(
  id: string,
  ctx: AudioContext,
  ctrl: AbortController,
  blob: Blob
): Promise<boolean> {
  // Resume must happen on the gesture-attached call path. Safe to call even
  // when already running.
  try {
    if (ctx.state === "suspended") await ctx.resume();
  } catch {}

  const buf = await blob.arrayBuffer();
  if (abortCtrl !== ctrl || state.id !== id) return true;

  // decodeAudioData has both promise and callback forms; the promise form
  // isn't implemented on older Safari, so wrap it.
  const audioBuffer = await new Promise<AudioBuffer>((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(buf, resolve, reject);
      if (p && typeof (p as Promise<AudioBuffer>).then === "function") {
        (p as Promise<AudioBuffer>).then(resolve, reject);
      }
    } catch (e) {
      reject(e);
    }
  });
  if (abortCtrl !== ctrl || state.id !== id) return true;

  stopActiveSource();
  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(ctx.destination);
  src.onended = () => {
    if (activeSource === src) activeSource = null;
    if (state.id === id) setState({ id: null, status: "idle" });
  };
  activeSource = src;
  src.start();
  setState({ id, status: "playing" });
  return true;
}

async function playWithHtmlAudio(
  id: string,
  ctrl: AbortController,
  blob: Blob
): Promise<void> {
  const url = URL.createObjectURL(blob);
  const a = new Audio(url);
  a.volume = 1.0;
  audioEl = a;
  audioUrl = url;
  a.onended = () => {
    if (state.id === id) {
      clearAudio();
      setState({ id: null, status: "idle" });
    }
  };
  a.onerror = () => {
    if (state.id === id) {
      clearAudio();
      setState({ id: null, status: "idle" });
    }
  };
  await a.play();
  if (abortCtrl !== ctrl || state.id !== id) {
    clearAudio();
    return;
  }
  setState({ id, status: "playing" });
}

function waitForUpdateEnd(sb: SourceBuffer): Promise<void> {
  if (!sb.updating) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onEnd = () => {
      sb.removeEventListener("updateend", onEnd);
      sb.removeEventListener("error", onErr);
      resolve();
    };
    const onErr = () => {
      sb.removeEventListener("updateend", onEnd);
      sb.removeEventListener("error", onErr);
      reject(new Error("SourceBuffer error"));
    };
    sb.addEventListener("updateend", onEnd);
    sb.addEventListener("error", onErr);
  });
}

// Play /api/tts as bytes arrive: tee the response, feed one branch into a
// MediaSource SourceBuffer for immediate playback, accumulate the other for
// the IndexedDB cache write. Returns once playback has started (or throws
// if MSE setup / first append failed before we got there).
async function playWithMediaSource(
  id: string,
  ctrl: AbortController,
  voice: string,
  cleaned: string,
  res: Response
): Promise<void> {
  if (!res.body) throw new Error("no body");
  const [playStream, cacheStream] = res.body.tee();

  const ms = new MediaSource();
  const url = URL.createObjectURL(ms);
  activeMediaSource = ms;
  const a = new Audio();
  a.src = url;
  a.volume = 1.0;
  audioEl = a;
  audioUrl = url;
  a.onended = () => {
    if (state.id === id) {
      clearAudio();
      setState({ id: null, status: "idle" });
    }
  };
  a.onerror = () => {
    if (state.id === id) {
      clearAudio();
      setState({ id: null, status: "idle" });
    }
  };
  // Kick playback inside the gesture path so iOS unlocks audio. Element
  // will buffer until the SourceBuffer has data.
  void a.play().catch(() => {});

  const sb: SourceBuffer = await new Promise((resolve, reject) => {
    const onOpen = () => {
      ms.removeEventListener("sourceopen", onOpen);
      try {
        const buf = ms.addSourceBuffer("audio/mpeg");
        resolve(buf);
      } catch (e) {
        reject(e);
      }
    };
    ms.addEventListener("sourceopen", onOpen);
  });

  // Pump chunks into the SourceBuffer.
  const pumpPlay = (async () => {
    const reader = playStream.getReader();
    try {
      while (true) {
        if (ctrl.signal.aborted || state.id !== id) return;
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        await waitForUpdateEnd(sb);
        if (ctrl.signal.aborted || state.id !== id) return;
        try {
          sb.appendBuffer(value);
        } catch {
          return;
        }
      }
      await waitForUpdateEnd(sb);
      if (ctrl.signal.aborted || state.id !== id) return;
      try {
        if (ms.readyState === "open") ms.endOfStream();
      } catch {}
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  })();

  // Drain the cache branch in parallel; only write if we read the whole body
  // cleanly so we never poison the cache with a partial blob.
  const pumpCache = (async () => {
    const reader = cacheStream.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } catch {
      return;
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
    if (ctrl.signal.aborted) return;
    const blob = new Blob(chunks as BlobPart[], { type: "audio/mpeg" });
    void putCachedAudio(voice, cleaned, blob);
  })();

  // Flip to "playing" as soon as we've handed the SourceBuffer to the
  // element — the audio tag will start producing sound once the first
  // appendBuffer lands, which races pumpPlay above.
  if (abortCtrl === ctrl && state.id === id) {
    setState({ id, status: "playing" });
  }

  // Don't block on pumpCache; surface pumpPlay errors so the caller can
  // fall back.
  await pumpPlay;
  // Best-effort wait so the cache write fires in the background.
  void pumpCache;
}

// Per-request input cap for the TTS route. Kept well under the models' hard
// limits (tts-1 ~4096 chars; gpt-4o-mini-tts truncates long inputs, cutting
// audio off partway) so every chunk synthesizes in full. Long messages are
// split across several requests and the resulting MP3s concatenated.
const MAX_TTS_CHARS = 1800;

// Split cleaned speech text into chunks that each stay under MAX_TTS_CHARS,
// preferring sentence/paragraph boundaries so the seams between concatenated
// audio land on natural pauses. Hard-splits an oversized single sentence at
// whitespace as a last resort.
export function splitIntoTtsChunks(text: string, max = MAX_TTS_CHARS): string[] {
  if (text.length <= max) return text ? [text] : [];
  const pieces = text.match(/[^.!?…\n]+[.!?…]*\s*|\n+/g) ?? [text];
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = "";
  };
  for (const piece of pieces) {
    if (piece.length > max) {
      flush();
      let rest = piece;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(" ", max);
        if (cut <= 0) cut = max;
        const seg = rest.slice(0, cut).trim();
        if (seg) chunks.push(seg);
        rest = rest.slice(cut);
      }
      cur = rest;
      continue;
    }
    if (cur.length + piece.length > max) flush();
    cur += piece;
  }
  flush();
  return chunks;
}

async function fetchTtsBlob(
  voice: string,
  input: string,
  signal?: AbortSignal
): Promise<Blob> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: input, voice }),
    signal,
  });
  if (!res.ok) throw new Error(`tts ${res.status}`);
  return res.blob();
}

// Produce the complete spoken audio for a message as a single MP3 blob. Short
// messages are one request; long ones are chunked, fetched in parallel, and
// concatenated (OpenAI returns raw MP3 frames, which join cleanly). Reads and
// populates the same IndexedDB cache as playback, keyed by the whole message.
async function synthesizeSpeech(
  voice: string,
  cleaned: string,
  signal?: AbortSignal
): Promise<Blob> {
  const cached = await getCachedAudio(voice, cleaned);
  if (cached) return cached;

  const chunks = splitIntoTtsChunks(cleaned);
  let blob: Blob;
  if (chunks.length <= 1) {
    blob = await fetchTtsBlob(voice, chunks[0] ?? cleaned, signal);
  } else {
    // Fetch in parallel; Promise.all preserves order for concatenation.
    const parts = await Promise.all(
      chunks.map((c) => fetchTtsBlob(voice, c, signal))
    );
    blob = new Blob(parts, { type: "audio/mpeg" });
  }
  void putCachedAudio(voice, cleaned, blob);
  return blob;
}

export function speakMessage(id: string, text: string) {
  if (!isSpeechSupported()) return;
  const cleaned = stripForSpeech(text);
  if (!cleaned) return;

  // Cancel any prior playback / abort any in-flight fetch.
  stopSpeaking();

  setState({ id, status: "loading" });

  // Claim the MediaSession up front (inside the user gesture) so the OS keeps
  // the audio session alive through a screen lock and shows transport controls
  // once the <audio> element starts producing sound.
  applyMediaSession(cleaned);

  // Touch the AudioContext synchronously inside the user gesture so iOS
  // unlocks playback for the cache-hit Web Audio path. The streaming path
  // unlocks via audio.play() instead.
  const ctx = getAudioContext();
  if (ctx) {
    try {
      void ctx.resume();
    } catch {}
  }

  const ctrl = new AbortController();
  abortCtrl = ctrl;
  const voice = DEFAULT_VOICE;

  (async () => {
    try {
      const cached = await getCachedAudio(voice, cleaned);
      if (abortCtrl !== ctrl || state.id !== id) return;

      if (cached) {
        // Cache hit: play the known-good blob through an <audio> element so
        // playback survives the screen locking / the tab being backgrounded.
        // (Web Audio's AudioContext gets suspended by the OS on lock, which
        // cuts the reading off; HTMLAudio + MediaSession keeps going.) Fall
        // back to Web Audio, then the browser synth, if the element can't
        // play the blob.
        try {
          await playWithHtmlAudio(id, ctrl, cached);
          return;
        } catch {
          clearAudio();
          if (abortCtrl !== ctrl || state.id !== id) return;
        }
        if (ctx) {
          try {
            await playWithWebAudio(id, ctx, ctrl, cached);
            return;
          } catch {
            // Fall through to the browser synth.
          }
        }
        if (state.id === id) speakWithBrowserFallback(id, cleaned);
        return;
      }

      // Long message: synthesize the whole thing across several requests and
      // concatenate, so playback isn't cut off at the per-request input limit.
      // Play the combined blob through <audio> (streaming a stitched blob
      // isn't possible, but it's complete and survives a screen lock).
      if (splitIntoTtsChunks(cleaned).length > 1) {
        const blob = await synthesizeSpeech(voice, cleaned, ctrl.signal);
        if (abortCtrl !== ctrl || state.id !== id) return;
        try {
          await playWithHtmlAudio(id, ctrl, blob);
          return;
        } catch {
          clearAudio();
          if (abortCtrl !== ctrl || state.id !== id) return;
        }
        if (ctx) {
          try {
            await playWithWebAudio(id, ctx, ctrl, blob);
            return;
          } catch {
            // Fall through to the browser synth.
          }
        }
        if (state.id === id) speakWithBrowserFallback(id, cleaned);
        return;
      }

      // Cache miss (short message): hit the route and stream as bytes arrive.
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: cleaned, voice }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`tts ${res.status}`);
      if (abortCtrl !== ctrl || state.id !== id) return;

      if (canStreamMpeg() && res.body) {
        try {
          await playWithMediaSource(id, ctrl, voice, cleaned, res);
          return;
        } catch {
          // MSE path bailed (codec mismatch, append failure). Fall through to
          // the legacy buffered path using whatever body is left. We can't
          // re-read this response, so request again under the same controller.
          clearAudio();
          if (abortCtrl !== ctrl || state.id !== id) return;
        }
      }

      // No MSE support (Safari iOS) or MSE failed: buffer the whole body
      // first, then play through the existing fallback chain.
      const fallbackRes =
        res.bodyUsed || res.body?.locked
          ? await fetch("/api/tts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: cleaned, voice }),
              signal: ctrl.signal,
            })
          : res;
      if (!fallbackRes.ok) throw new Error(`tts ${fallbackRes.status}`);
      const blob = await fallbackRes.blob();
      if (abortCtrl !== ctrl || state.id !== id) return;
      // Fire-and-forget — must not delay playback.
      void putCachedAudio(voice, cleaned, blob);

      // Prefer HTMLAudio here too so the buffered fallback keeps playing when
      // the screen locks; Web Audio and the browser synth are last resorts.
      try {
        await playWithHtmlAudio(id, ctrl, blob);
        return;
      } catch {
        clearAudio();
        if (abortCtrl !== ctrl || state.id !== id) return;
      }
      if (ctx) {
        try {
          await playWithWebAudio(id, ctx, ctrl, blob);
          return;
        } catch {
          // Fall through to the browser synth.
        }
      }
      if (state.id === id) speakWithBrowserFallback(id, cleaned);
    } catch (err: unknown) {
      // User-initiated stop already moved us to idle; don't fall back.
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (abortCtrl !== ctrl || state.id !== id) return;
      speakWithBrowserFallback(id, cleaned);
    }
  })();
}

// Derive a friendly download filename from the message's spoken text: first
// handful of words, punctuation stripped, hyphenated. Empty text falls back
// to a generic name so we always produce a valid file.
function filenameFromText(cleaned: string): string {
  const base = cleaned
    .split(/\s+/)
    .slice(0, 6)
    .join(" ")
    .replace(/[^\p{L}\p{N} _-]+/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return base || "speech";
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const name = filename.toLowerCase().endsWith(".mp3")
    ? filename
    : `${filename}.mp3`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after the browser has had a chance to start the download.
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }, 10_000);
}

// Fetch a message's spoken audio and save it as an .mp3 the user can keep and
// play offline (e.g. as a ringtone or alarm sound). Reuses the same TTS route
// and IndexedDB cache as playback, so a message that's already been spoken
// downloads instantly. Runs independently of playback state, so a download can
// proceed while something else is being read aloud. Resolves true on success;
// throws on network / route failure so callers can surface an error.
export async function downloadSpeech(
  text: string,
  filename?: string
): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const cleaned = stripForSpeech(text);
  if (!cleaned) return false;

  // Chunks long messages and concatenates so the saved file is the full
  // reading, not just the first ~4000 characters. Reuses the playback cache.
  const blob = await synthesizeSpeech(DEFAULT_VOICE, cleaned);

  const name = filename?.trim() || filenameFromText(cleaned);
  triggerBlobDownload(blob, name);
  return true;
}

export function stopSpeaking() {
  if (typeof window === "undefined") return;
  if (abortCtrl) {
    try {
      abortCtrl.abort();
    } catch {}
    abortCtrl = null;
  }
  clearAudio();
  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }
  if (state.status !== "idle") setState({ id: null, status: "idle" });
}

export function useSpeechState(): SpeechState {
  const [s, setS] = useState<SpeechState>(state);
  useEffect(() => {
    const l = () => setS(state);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return s;
}

export function useSpeakingMessageId(): string | null {
  return useSpeechState().id;
}
