"use client";

// Ordered text-to-speech playback queue for hands-free voice mode.
//
// Chunks of assistant text are enqueued as the model streams; each chunk is
// synthesized via /api/tts (with the IndexedDB audio cache in front) and
// played back-to-back on a single shared <audio> element. The next chunk's
// synthesis request is issued while the current one plays, so playback is
// gapless in practice and the first chunk starts long before the model has
// finished generating.
//
// One <audio> element is reused for every chunk because iOS only unlocks
// playback for elements that have played inside a user gesture - prime()
// plays a tiny silent clip during the "start conversation" tap, and all
// subsequent programmatic plays on the same element are then allowed.

import { getCachedAudio, putCachedAudio } from "@/app/lib/audio-cache";

// 8-bit PCM mono WAV, 8 samples of silence - the smallest thing that
// reliably "counts" as playback for the autoplay unlock.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAgD4AAIA+AAABAAgAZGF0YQgAAACAgICAgICAgA==";

// Cache-key namespace: bump when the TTS model/route output changes so stale
// tts-1 blobs aren't replayed for a voice that now maps to a different model.
const CACHE_PREFIX = "v2";

// How many chunks ahead of the playhead we synthesize concurrently.
const PREFETCH = 2;

export type TtsQueueEvents = {
  /** First audible chunk of the current utterance actually started playing. */
  onSpeakStart?: () => void;
  /** finish() was called and every queued chunk has finished playing. */
  onDrained?: () => void;
  /** A chunk failed to synthesize or play (queue skips it and continues). */
  onError?: (message: string) => void;
};

export type TtsQueue = {
  /** Unlock audio playback. MUST be called inside a user gesture. */
  prime(): void;
  /** Re-read the rate getter and apply it to the currently playing chunk. */
  applyRate(): void;
  /** Reset per-utterance state; call before enqueueing a new reply. */
  begin(): void;
  /** Add a chunk of already speech-stripped text. */
  enqueue(text: string): void;
  /** No more chunks for this utterance; onDrained fires when playback ends. */
  finish(): void;
  /** Hard-stop: abort synthesis, silence playback, clear the queue. */
  stop(): void;
  /** stop() plus release the audio element. */
  dispose(): void;
  /** True if any chunk of the current utterance is queued or playing. */
  isActive(): boolean;
};

type Item = { text: string; blob?: Promise<Blob> };

async function synthesize(
  text: string,
  voice: string,
  signal: AbortSignal
): Promise<Blob> {
  const cacheVoice = `${CACHE_PREFIX}:${voice}`;
  const cached = await getCachedAudio(cacheVoice, text);
  if (cached) return cached;
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`tts ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ""}`);
  }
  const blob = await res.blob();
  void putCachedAudio(cacheVoice, text, blob);
  return blob;
}

export function createTtsQueue(
  getVoice: () => string,
  events: TtsQueueEvents = {},
  // Playback speed (1 = normal). Read per chunk and re-applied live via
  // applyRate(); pitch is preserved by the browser (preservesPitch).
  getRate: () => number = () => 1
): TtsQueue {
  let audio: HTMLAudioElement | null = null;
  let items: Item[] = [];
  let finished = false;
  let startedThisUtterance = false;
  let pumping = false;
  // Bumped by stop(); every await inside pump() re-checks it and bails when
  // it no longer matches, which is what makes interruption instant.
  let gen = 0;
  let wake: (() => void) | null = null;
  const ctrls = new Set<AbortController>();
  let currentUrl: string | null = null;

  function el(): HTMLAudioElement {
    if (!audio) {
      audio = new Audio();
      audio.preload = "auto";
      // Default true in modern browsers; set explicitly (plus the WebKit
      // legacy alias) so 2x sounds faster, not higher-pitched.
      try {
        audio.preservesPitch = true;
        (audio as HTMLAudioElement & { webkitPreservesPitch?: boolean })
          .webkitPreservesPitch = true;
      } catch {}
    }
    return audio;
  }

  function applyRate() {
    if (!audio) return;
    const rate = Math.min(4, Math.max(0.25, getRate() || 1));
    try {
      // Loading a new src resets playbackRate to defaultPlaybackRate, so a
      // per-chunk queue must set both.
      audio.defaultPlaybackRate = rate;
      audio.playbackRate = rate;
    } catch {}
  }

  function revokeUrl() {
    if (currentUrl) {
      try {
        URL.revokeObjectURL(currentUrl);
      } catch {}
      currentUrl = null;
    }
  }

  function ensurePrefetch() {
    const g = gen;
    for (let i = 0; i < Math.min(PREFETCH, items.length); i++) {
      const it = items[i];
      if (it.blob) continue;
      const ctrl = new AbortController();
      ctrls.add(ctrl);
      it.blob = synthesize(it.text, getVoice(), ctrl.signal).finally(() => {
        ctrls.delete(ctrl);
      });
      // Swallow here so an early rejection (before pump awaits it) doesn't
      // surface as an unhandled rejection; pump still sees it via it.blob.
      it.blob.catch(() => {});
      if (g !== gen) return;
    }
  }

  function wakePump() {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    } else if (!pumping) {
      void pump();
    }
  }

  async function playBlob(blob: Blob, myGen: number): Promise<void> {
    const a = el();
    revokeUrl();
    const url = URL.createObjectURL(blob);
    currentUrl = url;
    a.src = url;
    applyRate();
    await a.play();
    if (gen !== myGen) return;
    if (!startedThisUtterance) {
      startedThisUtterance = true;
      events.onSpeakStart?.();
    }
    await new Promise<void>((resolve) => {
      const settle = () => {
        a.removeEventListener("ended", settle);
        a.removeEventListener("error", settle);
        a.removeEventListener("pause", settle);
        resolve();
      };
      a.addEventListener("ended", settle);
      a.addEventListener("error", settle);
      // stop() interrupts via pause(); natural completion fires "ended"
      // without a "pause" event, so this only trips on interruption.
      a.addEventListener("pause", settle);
    });
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    const myGen = gen;
    try {
      while (true) {
        if (gen !== myGen) return;
        if (items.length === 0) {
          if (finished) {
            events.onDrained?.();
            return;
          }
          await new Promise<void>((r) => {
            wake = r;
          });
          continue;
        }
        ensurePrefetch();
        const it = items[0];
        let blob: Blob;
        try {
          blob = await it.blob!;
        } catch (err) {
          if (gen !== myGen) return;
          items.shift();
          if (!(err instanceof DOMException && err.name === "AbortError")) {
            events.onError?.(err instanceof Error ? err.message : "TTS failed");
          }
          continue;
        }
        if (gen !== myGen) return;
        try {
          await playBlob(blob, myGen);
        } catch {
          if (gen !== myGen) return;
          events.onError?.("Audio playback failed.");
        }
        if (gen !== myGen) return;
        items.shift();
      }
    } finally {
      if (gen === myGen) pumping = false;
    }
  }

  function stop() {
    gen++;
    pumping = false;
    // Wake a parked pump so its async frame can observe the gen bump and exit.
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
    for (const c of ctrls) {
      try {
        c.abort();
      } catch {}
    }
    ctrls.clear();
    items = [];
    finished = false;
    startedThisUtterance = false;
    if (audio) {
      try {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      } catch {}
    }
    revokeUrl();
  }

  return {
    prime() {
      try {
        const a = el();
        a.src = SILENT_WAV;
        void a.play().catch(() => {});
      } catch {}
    },
    applyRate,
    begin() {
      stop();
    },
    enqueue(text: string) {
      const t = text.trim();
      if (!t) return;
      items.push({ text: t });
      ensurePrefetch();
      wakePump();
    },
    finish() {
      finished = true;
      if (items.length === 0 && !pumping) {
        // Nothing was ever speakable (or everything already played and the
        // pump exited); report drained so the conversation loop resumes.
        events.onDrained?.();
        return;
      }
      wakePump();
    },
    stop,
    dispose() {
      stop();
      audio = null;
    },
    isActive() {
      return pumping || items.length > 0;
    },
  };
}
