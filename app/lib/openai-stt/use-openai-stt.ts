"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  cleanTranscript,
  filenameFor,
  pickMimeType,
  streamTranscript,
} from "./shared";

export type STTStatus = "idle" | "ready" | "recording" | "error";

interface UseOpenAISTTOptions {
  // Partial = the live, still-changing transcript while the upload is being
  // transcribed. OpenAI streams deltas, so the partial arrives a chunk at a
  // time after the user stops recording.
  onPartial?: (text: string) => void;
  // Commit = the finalized transcript once the streamed response ends.
  onCommit?: (text: string) => void;
  onError?: (message: string) => void;
}

// Transcript cleaning, SSE parsing, and MIME selection live in ./shared so
// the hands-free voice session can reuse them without pulling in this hook.

export function useOpenAISTT(options: UseOpenAISTTOptions = {}) {
  const { onPartial, onCommit, onError } = options;
  const [status, setStatus] = useState<STTStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // partialText is kept on the return shape for back-compat, but we no longer
  // stream partials during recording — only during the post-stop transcription.
  const [partialText, setPartialText] = useState("");
  const [audioLevel, setAudioLevel] = useState(0); // 0..1 smoothed mic level

  const callbacksRef = useRef({ onPartial, onCommit, onError });
  callbacksRef.current = { onPartial, onCommit, onError };

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // AudioContext + AnalyserNode power the level meter only. Capture itself is
  // MediaRecorder, which is unaffected if the AnalyserNode pipeline fails (as
  // iOS sometimes does when the AudioContext stays suspended).
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelFrameRef = useRef<number | null>(null);
  const stoppedRef = useRef<boolean>(true);
  // Finals must complete in-order — chain them on a single promise so
  // back-to-back recordings don't interleave their transcripts.
  const commitChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const transcribeCtrlRef = useRef<AbortController | null>(null);

  const cleanup = useCallback(() => {
    if (levelFrameRef.current !== null) {
      cancelAnimationFrame(levelFrameRef.current);
      levelFrameRef.current = null;
    }
    setAudioLevel(0);
    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch {}
      analyserRef.current = null;
    }
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.disconnect();
      } catch {}
      sourceNodeRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    recorderRef.current = null;
  }, []);

  const transcribe = useCallback(async (blob: Blob, filename: string) => {
    const ctrl = new AbortController();
    transcribeCtrlRef.current = ctrl;
    try {
      const form = new FormData();
      form.append("audio", blob, filename);
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
        if (ctrl.signal.aborted) return;
        const trimmed = cleanTranscript(live);
        setPartialText(trimmed);
        if (trimmed) callbacksRef.current.onPartial?.(trimmed);
      });
      if (ctrl.signal.aborted) return;
      const trimmed = cleanTranscript(finalText);
      setPartialText("");
      if (trimmed) callbacksRef.current.onCommit?.(trimmed);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      callbacksRef.current.onError?.(message);
    } finally {
      if (transcribeCtrlRef.current === ctrl) transcribeCtrlRef.current = null;
    }
  }, []);

  // Returns a promise that resolves once the post-stop transcription
  // completes. Callers that need the committed text must `await stop()` —
  // the network round-trip to OpenAI is far longer than React's render
  // cycle, so a fire-and-forget stop followed by a synchronous commit
  // check will always miss.
  const stop = useCallback(async () => {
    stoppedRef.current = true;
    const recorder = recorderRef.current;

    let blob: Blob | null = null;
    let mime = "audio/webm";

    if (recorder && recorder.state !== "inactive") {
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
      mime = recorder.mimeType || mime;
      if (chunksRef.current.length > 0) {
        blob = new Blob(chunksRef.current, { type: mime });
      }
    }
    chunksRef.current = [];
    cleanup();
    setStatus((s) => (s === "error" ? s : "ready"));

    if (blob && blob.size > 0) {
      const prev = commitChainRef.current;
      const job = (async () => {
        try {
          await prev;
        } catch {}
        await transcribe(blob, filenameFor(mime));
      })();
      commitChainRef.current = job;
      try {
        await job;
      } catch {}
    }
  }, [cleanup, transcribe]);

  const start = useCallback(async () => {
    setError(null);
    stoppedRef.current = false;
    chunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (stoppedRef.current) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      streamRef.current = stream;

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined
      );
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      // No timeslice — let MediaRecorder buffer the whole utterance and emit
      // one chunk on stop(). iOS sometimes drops mid-stream chunks if a
      // timeslice forces them out before the recorder is ready.
      recorder.start();

      // Level meter via AnalyserNode. If this fails (iOS AudioContext stuck
      // suspended), recording still works — the button just won't pulse.
      try {
        const Ctx: typeof AudioContext =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const audioCtx = new Ctx();
        audioCtxRef.current = audioCtx;
        void audioCtx.resume().catch(() => {});
        const source = audioCtx.createMediaStreamSource(stream);
        sourceNodeRef.current = source;
        const analyser = audioCtx.createAnalyser();
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
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          // EMA-smoothed level, biased toward speech loudness.
          smooth = 0.7 * smooth + 0.3 * Math.min(1, rms / 0.15);
          setAudioLevel(smooth);
          levelFrameRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        // Level meter is nice-to-have; ignore failures and keep recording.
      }

      setStatus("recording");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatus("error");
      callbacksRef.current.onError?.(message);
      cleanup();
    }
  }, [cleanup]);

  useEffect(() => {
    return () => {
      void stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    status,
    isLoading: false,
    isRecording: status === "recording",
    loadProgress: 1,
    error,
    partialText,
    audioLevel,
    start,
    stop,
  };
}
