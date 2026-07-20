"use client";

// Hands-free voice session: owns the microphone for the whole conversation
// and drives a listen -> endpoint -> transcribe loop with simple RMS-based
// voice-activity detection, plus an optional barge-in monitor so the user
// can interrupt the assistant by talking over it.
//
// Lifecycle (all on one persistent MediaStream, so the permission prompt and
// device spin-up happen once per conversation, not once per turn):
//
//   listen()  - start a fresh MediaRecorder + VAD. When speech has been heard
//               and then ~1s of silence follows, the utterance is endpointed
//               automatically: the recorder stops, the clip goes to /api/stt,
//               and onUtterance fires with the cleaned transcript.
//   monitor() - no recording; watch mic level for sustained loud speech and
//               fire onBargeIn (used while the assistant is speaking).
//   pause()   - stop listening/monitoring but keep the mic stream alive.
//   end()     - release everything (mic, AudioContext, in-flight requests).
//
// Long dictation is never cut off: recordings roll over into a new segment
// every few minutes (segmentMs). Each finished segment uploads and
// transcribes in the background while the user keeps talking; endpoint()
// stitches the segment transcripts back together in order. This keeps every
// individual /api/stt upload small (serverless request bodies cap out around
// 4.5MB) and means even a very long monologue only waits on its final
// segment when the user stops.
//
// VAD thresholds operate on the same normalized (0..1) smoothed RMS that
// drives the level meter. Echo cancellation is requested on the stream so
// the assistant's own TTS audio is (mostly) absent from the mic signal;
// barge-in still uses a much higher threshold + longer sustain than speech
// detection to avoid self-interruption on devices with weak AEC.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  cleanTranscript,
  filenameFor,
  pickMimeType,
  streamTranscript,
} from "@/app/lib/openai-stt/shared";

export type VoiceSessionStatus = "idle" | "listening" | "transcribing";

export type UseVoiceSessionOptions = {
  /** Finalized, non-empty user utterance. The session goes idle before this fires. */
  onUtterance: (text: string) => void;
  /** Live transcript while the endpointed clip is being transcribed. */
  onPartial?: (text: string) => void;
  /** The clip transcribed to nothing (silence/noise). Session auto-resumes listening. */
  onNoSpeech?: () => void;
  onError?: (message: string) => void;
  /** Listening but heard nothing for idleTimeoutMs; session paused itself. */
  onIdleTimeout?: () => void;
  /** Sustained loud speech while in monitor mode (assistant is talking). */
  onBargeIn?: () => void;
  /** Recent conversation text passed to /api/stt as a decoding hint. */
  getSttPrompt?: () => string | undefined;
  /**
   * Gate for the session's own auto-resume (after an empty clip or a
   * transcription error). Return false while muted/paused so the mic never
   * silently re-opens against the user's intent.
   */
  canListen?: () => boolean;
  /** Normalized level that counts as speech while listening. Default 0.25. */
  speechThreshold?: number;
  /** Silence after speech that ends the utterance. Default 900ms. */
  silenceMs?: number;
  /** Cumulative speech required before an endpoint can trigger. Default 250ms. */
  minSpeechMs?: number;
  /** Give up listening after this long with no speech. Default 60s. */
  idleTimeoutMs?: number;
  /** Level for barge-in (higher than speechThreshold on purpose). Default 0.6. */
  bargeInThreshold?: number;
  /** Sustain required above bargeInThreshold. Default 400ms. */
  bargeInMs?: number;
  /**
   * When false (tap-to-talk mode), silence never auto-sends: the utterance
   * only endpoints via endpointNow() or the maxUtteranceMs safety cap. The
   * level meter and idle timeout still run. Default true (hands-free).
   */
  autoEndpoint?: boolean;
  /**
   * Hard cap on a single utterance, applied only when autoEndpoint is off -
   * bounds a forgotten open mic if the user taps to talk and walks away
   * after saying something. Default 10 minutes. When it trips, the
   * utterance is SENT, not dropped.
   */
  maxUtteranceMs?: number;
  /**
   * Roll the recording into a new segment after this long, uploading the
   * finished segment for transcription in the background. Default 4 minutes
   * (~1.4MB per segment at the 48kbps recording bitrate).
   */
  segmentMs?: number;
};

type Mode = "off" | "listening" | "monitor";

type ActiveRecorder = { recorder: MediaRecorder; chunks: Blob[] };

// Speech is fine at low bitrates and this keeps segment uploads small; the
// browser may ignore the hint (Safari), which segmentation also covers.
const AUDIO_BITS_PER_SECOND = 48_000;

export function useVoiceSession(options: UseVoiceSessionOptions) {
  const [status, setStatus] = useState<VoiceSessionStatus>("idle");
  const [audioLevel, setAudioLevel] = useState(0);

  const optsRef = useRef(options);
  optsRef.current = options;

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const frameRef = useRef<number | null>(null);
  const recRef = useRef<ActiveRecorder | null>(null);
  // In-flight /api/stt calls (final clip + any background segments).
  const transcribeCtrlsRef = useRef<Set<AbortController>>(new Set());
  // Ordered accumulation of rolled-segment transcripts for the CURRENT
  // utterance. Reset on every listen(). Never rejects - segment failures
  // surface via onError and resolve to whatever text made it through.
  const segChainRef = useRef<Promise<string>>(Promise.resolve(""));
  const rollingRef = useRef(false);
  const endedRef = useRef(false);

  const modeRef = useRef<Mode>("off");
  // VAD bookkeeping (reset on every listen()).
  const vadRef = useRef({
    listenStart: 0,
    segmentStart: 0,
    speechMs: 0,
    lastLoudAt: 0,
    lastFrameAt: 0,
    bargeLoudMs: 0,
    endpointing: false,
  });

  const releaseAnalyser = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    setAudioLevel(0);
    try {
      analyserRef.current?.disconnect();
    } catch {}
    analyserRef.current = null;
    try {
      sourceRef.current?.disconnect();
    } catch {}
    sourceRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }, []);

  // Start a fresh MediaRecorder on the shared stream (one per segment).
  const beginRecorder = useCallback((stream: MediaStream) => {
    const chunks: Blob[] = [];
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    // No timeslice - iOS drops mid-stream chunks when forced out early.
    recorder.start();
    recRef.current = { recorder, chunks };
    vadRef.current.segmentStart = performance.now();
  }, []);

  // Stop a recorder, resolving with its clip (or null if it captured nothing).
  const stopRec = useCallback(
    async (rec: ActiveRecorder | null): Promise<{ blob: Blob; mime: string } | null> => {
      if (!rec) return null;
      const { recorder, chunks } = rec;
      if (recorder.state !== "inactive") {
        const stopped = new Promise<void>((resolve) => {
          const h = () => {
            recorder.removeEventListener("stop", h);
            resolve();
          };
          recorder.addEventListener("stop", h);
        });
        try {
          recorder.stop();
        } catch {
          // Already inactive; flush whatever we have.
        }
        await stopped;
      }
      const mime = recorder.mimeType || "audio/webm";
      if (chunks.length === 0) return null;
      const blob = new Blob(chunks, { type: mime });
      return blob.size > 0 ? { blob, mime } : null;
    },
    []
  );

  /** Stop and discard the active recorder (mode switches, pause, teardown). */
  const discardRec = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    if (rec) void stopRec(rec);
  }, [stopRec]);

  const transcribe = useCallback(
    async (
      blob: Blob,
      mime: string,
      prompt: string | undefined,
      emitPartials: boolean
    ): Promise<string> => {
      const ctrl = new AbortController();
      transcribeCtrlsRef.current.add(ctrl);
      try {
        const form = new FormData();
        form.append("audio", blob, filenameFor(mime));
        if (prompt && prompt.trim()) form.append("prompt", prompt.trim());
        const res = await fetch("/api/stt", {
          method: "POST",
          body: form,
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(
            `stt ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`
          );
        }
        const finalText = await streamTranscript(res, ctrl.signal, (live) => {
          if (!emitPartials || ctrl.signal.aborted) return;
          const t = cleanTranscript(live);
          if (t) optsRef.current.onPartial?.(t);
        });
        if (ctrl.signal.aborted) return "";
        return cleanTranscript(finalText);
      } finally {
        transcribeCtrlsRef.current.delete(ctrl);
      }
    },
    []
  );

  // Roll the current recording into a new segment: start a fresh recorder
  // immediately (minimizing the audio gap), then transcribe the finished
  // segment in the background, chained so segment texts stay in order. The
  // previous segment's tail doubles as the decoding hint for the next one.
  const rollSegment = useCallback(() => {
    if (rollingRef.current) return;
    const stream = streamRef.current;
    const finished = recRef.current;
    if (!stream || !finished || modeRef.current !== "listening") return;
    rollingRef.current = true;
    try {
      beginRecorder(stream);
    } catch {
      rollingRef.current = false;
      return;
    }
    segChainRef.current = segChainRef.current.then(async (prev) => {
      try {
        const clip = await stopRec(finished);
        if (!clip || endedRef.current) return prev;
        const hint = prev.slice(-200) || optsRef.current.getSttPrompt?.();
        const text = await transcribe(clip.blob, clip.mime, hint, false);
        return [prev, text].filter(Boolean).join(" ");
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          optsRef.current.onError?.(
            err instanceof Error ? err.message : "Transcription failed"
          );
        }
        return prev;
      } finally {
        rollingRef.current = false;
      }
    });
  }, [beginRecorder, stopRec, transcribe]);

  // Forward declaration so endpoint() can restart listening on empty clips.
  const listenRef = useRef<() => Promise<void>>(async () => {});

  const endpoint = useCallback(async () => {
    const v = vadRef.current;
    if (v.endpointing) return;
    v.endpointing = true;
    modeRef.current = "off";
    setStatus("transcribing");
    const rec = recRef.current;
    recRef.current = null;
    // Detach this utterance's segment chain; listen() starts a fresh one.
    const chain = segChainRef.current;
    segChainRef.current = Promise.resolve("");
    try {
      const clip = await stopRec(rec);
      if (endedRef.current) return;
      const prefix = await chain;
      if (endedRef.current) return;
      let tail = "";
      if (clip) {
        const hint = prefix.slice(-200) || optsRef.current.getSttPrompt?.();
        tail = await transcribe(clip.blob, clip.mime, hint, !prefix);
      }
      if (endedRef.current) return;
      const text = [prefix, tail].filter(Boolean).join(" ");
      if (!text) {
        optsRef.current.onNoSpeech?.();
        void listenRef.current();
        return;
      }
      setStatus("idle");
      optsRef.current.onUtterance(text);
    } catch (err) {
      if (endedRef.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setStatus("idle");
      optsRef.current.onError?.(
        err instanceof Error ? err.message : "Transcription failed"
      );
      // Recover by listening again rather than dead-ending the conversation.
      void listenRef.current();
    } finally {
      vadRef.current.endpointing = false;
    }
  }, [stopRec, transcribe]);

  // Per-frame VAD tick, shared by listening and monitor modes.
  const onLevelFrame = useCallback(
    (level: number) => {
      const o = optsRef.current;
      const v = vadRef.current;
      const now = performance.now();
      const dt = v.lastFrameAt ? Math.min(100, now - v.lastFrameAt) : 16;
      v.lastFrameAt = now;

      if (modeRef.current === "listening") {
        const speechThreshold = o.speechThreshold ?? 0.25;
        const silenceMs = o.silenceMs ?? 900;
        const minSpeechMs = o.minSpeechMs ?? 250;
        const idleTimeoutMs = o.idleTimeoutMs ?? 60_000;
        const auto = o.autoEndpoint !== false;
        const maxUtteranceMs = o.maxUtteranceMs ?? 600_000;
        const segmentMs = o.segmentMs ?? 240_000;
        if (level >= speechThreshold) {
          v.speechMs += dt;
          v.lastLoudAt = now;
        }
        const heardEnough = v.speechMs >= minSpeechMs;
        if (auto && heardEnough && now - v.lastLoudAt >= silenceMs) {
          void endpoint();
        } else if (!auto && heardEnough && now - v.listenStart >= maxUtteranceMs) {
          void endpoint();
        } else if (!heardEnough && now - v.listenStart >= idleTimeoutMs) {
          modeRef.current = "off";
          discardRec();
          setStatus("idle");
          o.onIdleTimeout?.();
        } else if (now - v.segmentStart >= segmentMs) {
          rollSegment();
        }
      } else if (modeRef.current === "monitor") {
        const threshold = o.bargeInThreshold ?? 0.6;
        const sustain = o.bargeInMs ?? 400;
        if (level >= threshold) {
          v.bargeLoudMs += dt;
          if (v.bargeLoudMs >= sustain) {
            v.bargeLoudMs = 0;
            modeRef.current = "off";
            o.onBargeIn?.();
          }
        } else {
          v.bargeLoudMs = 0;
        }
      }
    },
    [discardRec, endpoint, rollSegment]
  );

  // Acquire the mic + analyser once per conversation; reused across turns.
  const ensureStream = useCallback(async (): Promise<MediaStream> => {
    if (streamRef.current) return streamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (endedRef.current) {
      for (const t of stream.getTracks()) t.stop();
      throw new DOMException("session ended", "AbortError");
    }
    streamRef.current = stream;

    // Level meter + VAD via AnalyserNode. If AudioContext setup fails (iOS
    // occasionally leaves it suspended), recording still works - only auto-
    // endpointing degrades, and the UI exposes a tap-to-send fallback.
    try {
      const Ctx: typeof AudioContext =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      void ctx.resume().catch(() => {});
      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.fftSize);
      let smooth = 0;
      const tick = () => {
        const a = analyserRef.current;
        if (!a) return;
        a.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const val = (data[i] - 128) / 128;
          sum += val * val;
        }
        const rms = Math.sqrt(sum / data.length);
        smooth = 0.7 * smooth + 0.3 * Math.min(1, rms / 0.15);
        setAudioLevel(smooth);
        onLevelFrame(smooth);
        frameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // Meter/VAD are best-effort; manual endpointing still works.
    }
    return stream;
  }, [onLevelFrame]);

  const listen = useCallback(async () => {
    if (endedRef.current) return;
    if (optsRef.current.canListen && !optsRef.current.canListen()) return;
    if (modeRef.current === "listening") return;
    try {
      const stream = await ensureStream();
      if (endedRef.current) return;
      // Discard any recorder left over from a mode switch, and reset the
      // segment chain for the new utterance.
      discardRec();
      segChainRef.current = Promise.resolve("");
      rollingRef.current = false;
      beginRecorder(stream);
      const v = vadRef.current;
      v.listenStart = performance.now();
      v.speechMs = 0;
      v.lastLoudAt = v.listenStart;
      v.bargeLoudMs = 0;
      modeRef.current = "listening";
      setStatus("listening");
    } catch (err) {
      if (endedRef.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      setStatus("idle");
      optsRef.current.onError?.(
        err instanceof Error ? err.message : "Microphone unavailable"
      );
    }
  }, [beginRecorder, discardRec, ensureStream]);
  listenRef.current = listen;

  /** Force-send the current utterance now (tap-to-send while listening). */
  const endpointNow = useCallback(() => {
    if (modeRef.current !== "listening") return;
    void endpoint();
  }, [endpoint]);

  const abortTranscriptions = useCallback(() => {
    for (const ctrl of transcribeCtrlsRef.current) {
      try {
        ctrl.abort();
      } catch {}
    }
    transcribeCtrlsRef.current.clear();
    segChainRef.current = Promise.resolve("");
  }, []);

  /** Watch for barge-in while the assistant speaks. No recording. */
  const monitor = useCallback(() => {
    if (endedRef.current) return;
    discardRec();
    vadRef.current.bargeLoudMs = 0;
    vadRef.current.lastFrameAt = 0;
    modeRef.current = "monitor";
    setStatus("idle");
  }, [discardRec]);

  /** Stop listening/monitoring; keep the mic stream for a later listen(). */
  const pause = useCallback(() => {
    modeRef.current = "off";
    abortTranscriptions();
    discardRec();
    setStatus("idle");
  }, [abortTranscriptions, discardRec]);

  /** Tear down the whole session (mic, analyser, in-flight transcription). */
  const end = useCallback(() => {
    endedRef.current = true;
    modeRef.current = "off";
    abortTranscriptions();
    discardRec();
    releaseAnalyser();
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    setStatus("idle");
  }, [abortTranscriptions, discardRec, releaseAnalyser]);

  // Allow a component to start a fresh session after end() (not used by the
  // voice page today, but keeps the hook honest for remounts in dev/strict).
  const reset = useCallback(() => {
    endedRef.current = false;
  }, []);

  useEffect(() => {
    return () => {
      end();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    status,
    audioLevel,
    listen,
    endpointNow,
    monitor,
    pause,
    end,
    reset,
  };
}
