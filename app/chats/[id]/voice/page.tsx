"use client";

// Hands-free voice mode, modeled on the ChatGPT / Claude app voice UX:
// tap once to start, then just talk. The loop is
//
//   listening -> (silence endpoint) -> transcribing -> thinking ->
//   speaking (TTS starts on the FIRST SENTENCE while the model still
//   streams) -> listening again
//
// with barge-in (speak over the assistant, or tap the orb) to interrupt.
// Every turn is persisted to the normal chat history, so exiting voice mode
// lands in the same conversation with everything on the record.
//
// Latency choices, since silence is what makes voice modes feel broken:
// - The chat model defaults to a FAST model (Settings.voiceModel ->
//   DEFAULT_VOICE_MODEL), not the chat's pinned flagship.
// - The reply is spoken sentence-by-sentence as it streams instead of
//   waiting for the full response (no post-hoc "rewrite for speech" pass -
//   the model is told up front to answer in spoken prose).
// - TTS chunks are prefetched ahead of the playhead and cached locally.

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Mic, MicOff, Pause, Play, Settings2, X } from "lucide-react";

import {
  DEFAULT_SETTINGS,
  getChat,
  getPinnedNote,
  loadMessages,
  loadSettings,
  newId,
  putMessage,
  saveSettings,
  type Settings,
  type StoredChat,
  type StoredMessage,
  type StoredPinnedNote,
} from "@/app/db";
import {
  DEFAULT_VOICE_MODEL,
  partitionVoiceModels,
} from "@/app/models";
import { noteToCanvasBody } from "@/app/lib/note-canvas/body";
import { buildExtraSystem } from "@/app/lib/extra-system";
import { deriveNoteTitle } from "@/app/lib/note-title";
import { consumeDeltasOnly } from "@/app/lib/consume-deltas";
import { useAvailableModels } from "@/app/lib/use-available-models";
import { useVoiceSession } from "@/app/lib/voice/use-voice-session";
import { createTtsQueue, type TtsQueue } from "@/app/lib/voice/tts-queue";
import { createSentenceChunker } from "@/app/lib/voice/sentence-chunker";
import { stripForSpeech } from "@/app/lib/speech";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// What the user sees. "live" phases (listening/transcribing) are derived
// from the voice session hook; thinking/speaking are owned by the turn.
// "ready" only occurs in tap-to-talk mode: it's the user's turn, mic closed,
// waiting for a tap.
type Ui =
  | "start"
  | "ready"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "paused";

const DEFAULT_TTS_VOICE = "nova";

// Short curated list; /api/tts validates and falls back server-side.
const TTS_VOICES: { id: string; label: string }[] = [
  { id: "nova", label: "Nova (bright)" },
  { id: "marin", label: "Marin (natural)" },
  { id: "cedar", label: "Cedar (natural, deep)" },
  { id: "coral", label: "Coral (warm)" },
  { id: "sage", label: "Sage (calm)" },
  { id: "alloy", label: "Alloy (neutral)" },
  { id: "echo", label: "Echo (male)" },
  { id: "onyx", label: "Onyx (deep)" },
  { id: "shimmer", label: "Shimmer (soft)" },
];

// Injected as body.system on every voice turn - this replaces the old
// post-hoc Gemma "rewrite for speech" round-trip, which added a whole extra
// model call of latency before any audio could start.
const VOICE_SYSTEM = [
  "The user is speaking to you by voice and your reply will be read aloud by a text-to-speech engine.",
  "Reply the way a person talks in a conversation:",
  "- Keep it brief: one to four sentences unless the user clearly asks for depth. Never pad.",
  "- Plain spoken prose only: no markdown, no bullet or numbered lists, no headings, no tables, no emojis, and no code blocks unless the user explicitly asks to hear code.",
  "- Say numbers, symbols, dates, and abbreviations the way you would speak them out loud.",
  "- Never read out a URL; briefly describe the destination instead.",
  "- If the request is ambiguous, ask one short clarifying question rather than guessing at length.",
].join("\n");

// Reconstruct the note context the text chat sends so the model can actually
// see what the user is talking about. A voice turn only forwards chat
// messages; on a note-canvas chat the note body lives in the note row (sent as
// a VFS by the text UI, never as a message), and attached notes live on the
// chat row - so without this the model has no attachment and answers "I can't
// see it." Returns a system-prompt fragment, or null when there's nothing to
// add.
async function buildVoiceContext(chat: StoredChat | null): Promise<string | null> {
  if (!chat) return null;
  const parts: string[] = [];

  // The pinned note this canvas chat is editing / talking about.
  if (chat.target?.kind === "note-canvas" && chat.target.noteId) {
    const note = await getPinnedNote(chat.target.noteId).catch(() => undefined);
    const body = note ? noteToCanvasBody(note) : null;
    if (note && body && body.body.trim()) {
      const title = deriveNoteTitle(note).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      parts.push(
        `<current_note title="${title}">\n${body.body.trim()}\n</current_note>\n\n` +
          "The <current_note> block above is the note the user is looking at and talking about. Answer from it, and read it aloud when the user asks you to."
      );
    }
  }

  // Pinned notes explicitly attached to this chat for extra context (plus any
  // running session-memory note). Same wire content the text chat builds.
  const pinIds = chat.attachedPinIds ?? [];
  if (pinIds.length > 0) {
    const pins = (
      await Promise.all(pinIds.map((id) => getPinnedNote(id).catch(() => undefined)))
    ).filter((p): p is StoredPinnedNote => !!p);
    const extra = buildExtraSystem(undefined, pins, chat.sessionMemoryNoteId);
    if (extra) parts.push(extra);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

export default function VoiceMode({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: chatId } = use(params);
  const router = useRouter();

  const [ui, setUi] = useState<Ui>("start");
  const [chat, setChat] = useState<StoredChat | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [muted, setMuted] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [userText, setUserText] = useState<string | null>(null);
  const [assistantText, setAssistantText] = useState<string>("");

  const settingsRef = useRef<Settings>({ ...DEFAULT_SETTINGS });
  const mutedRef = useRef(false);
  const exitingRef = useRef(false);
  // "thinking" | "speaking" | null - which half of the assistant turn we're
  // in. Null means the mic loop (hook status) drives the displayed state.
  const turnRef = useRef<"thinking" | "speaking" | null>(null);
  const inflightCtrlRef = useRef<AbortController | null>(null);
  const lastAssistantRef = useRef<string>("");
  // Note/attachment context for this chat, folded into every turn's system
  // prompt so the model can see the note the user is voicing about. Built once
  // on mount from the chat row (see the mount effect below).
  const noteContextRef = useRef<string | null>(null);
  const captionsRef = useRef<HTMLDivElement | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const { models: availableModels } = useAvailableModels(
    settings?.runpodEndpointId || undefined
  );

  const voiceModel = settings?.voiceModel ?? DEFAULT_VOICE_MODEL;
  const ttsVoice = settings?.voiceName ?? DEFAULT_TTS_VOICE;
  const bargeIn = settings?.voiceBargeIn !== false;
  // "auto" = hands-free loop; "manual" = tap-to-talk (mic only opens on tap,
  // silence never auto-sends, no barge-in). The escape hatch for rooms and
  // speakers where VAD or echo cancellation misbehave.
  const convMode = settings?.voiceInputMode ?? "auto";
  const handsFree = convMode === "auto";
  const speed = settings?.voiceSpeed ?? 1;
  const ttsVoiceRef = useRef(ttsVoice);
  ttsVoiceRef.current = ttsVoice;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const bargeInRef = useRef(bargeIn);
  bargeInRef.current = bargeIn;
  const handsFreeRef = useRef(handsFree);
  handsFreeRef.current = handsFree;

  // ---- TTS queue (one per page lifetime) ----------------------------------
  const queueRef = useRef<TtsQueue | null>(null);
  // Events need stable targets; route through refs set after voice is built.
  const onSpeakStartRef = useRef<() => void>(() => {});
  const onDrainedRef = useRef<() => void>(() => {});
  if (!queueRef.current) {
    queueRef.current = createTtsQueue(
      () => ttsVoiceRef.current,
      {
        onSpeakStart: () => onSpeakStartRef.current(),
        onDrained: () => onDrainedRef.current(),
        onError: (m) => setError(m),
      },
      () => speedRef.current
    );
  }
  const queue = queueRef.current;

  // ---- Voice session (mic + VAD + STT) -------------------------------------
  const runTurnRef = useRef<(utterance: string) => void>(() => {});
  const interruptRef = useRef<() => void>(() => {});

  const voice = useVoiceSession({
    onUtterance: (text) => runTurnRef.current(text),
    onPartial: (text) => setUserText(text),
    onNoSpeech: () => {
      setHint("Didn't catch that - still listening.");
      setUi("listening");
    },
    onError: (m) => {
      setError(m);
      // The hook resumes listening after transcription errors; mirror it.
      if (turnRef.current === null && !mutedRef.current && !exitingRef.current) {
        setUi("listening");
      }
    },
    onIdleTimeout: () => {
      mutedRef.current = true;
      setMuted(true);
      setUi("paused");
      setHint("Paused after a quiet minute - tap the circle to resume.");
    },
    onBargeIn: () => interruptRef.current(),
    getSttPrompt: () => lastAssistantRef.current.slice(-300) || undefined,
    canListen: () => !mutedRef.current && !exitingRef.current,
    autoEndpoint: handsFree,
  });
  const { listen, endpointNow, monitor, pause: pauseMic, end: endMic } = voice;
  const voiceStatus = voice.status;

  const startListening = useCallback(() => {
    if (exitingRef.current || mutedRef.current) return;
    turnRef.current = null;
    setUi("listening");
    void listen();
  }, [listen]);

  // Hand the turn back to the user: hands-free reopens the mic immediately;
  // tap-to-talk parks on "ready" and waits for the next tap.
  const yieldToUser = useCallback(() => {
    if (exitingRef.current) return;
    turnRef.current = null;
    if (mutedRef.current) {
      setUi("paused");
      return;
    }
    if (handsFreeRef.current) {
      startListening();
    } else {
      setUi("ready");
    }
  }, [startListening]);

  // Interrupt = barge-in or orb tap while the assistant is replying: silence
  // the TTS, abort the stream (the partial reply is persisted by runTurn's
  // abort path), and give the turn back to the user.
  interruptRef.current = () => {
    if (exitingRef.current) return;
    queue.stop();
    inflightCtrlRef.current?.abort();
    turnRef.current = null;
    mutedRef.current = false;
    setMuted(false);
    if (handsFreeRef.current) {
      startListening();
    } else {
      setUi("ready");
    }
  };

  onSpeakStartRef.current = () => {
    if (exitingRef.current) return;
    turnRef.current = "speaking";
    setUi("speaking");
    // Arm barge-in while we talk (mic stays open, nothing is recorded).
    // Tap-to-talk mode never listens while speaking - that's its point.
    if (handsFreeRef.current && bargeInRef.current && !mutedRef.current) {
      monitor();
    }
  };

  onDrainedRef.current = () => {
    if (exitingRef.current || turnRef.current === null) return;
    yieldToUser();
  };

  // ---- One conversation turn ----------------------------------------------
  const runTurn = useCallback(
    async (utterance: string) => {
      setError(null);
      setHint(null);
      setUserText(utterance);
      setAssistantText("");
      turnRef.current = "thinking";
      setUi("thinking");

      const ctrl = new AbortController();
      inflightCtrlRef.current = ctrl;
      queue.begin();
      const chunker = createSentenceChunker();
      let streamedLen = 0;
      let accumulated = "";
      const s = settingsRef.current;
      const model = s.voiceModel ?? DEFAULT_VOICE_MODEL;

      // Persist the partial (or full) assistant reply. Called on both the
      // happy path and interruption, so what the user heard is what's in
      // the chat history when they exit voice mode.
      const persistAssistant = async (content: string) => {
        const t = content.trim();
        if (!t) return;
        const msg: StoredMessage = {
          id: newId(),
          chatId,
          role: "assistant",
          content: t,
          createdAt: Date.now(),
          model,
        };
        await putMessage(msg);
        lastAssistantRef.current = t;
      };

      try {
        const prior = await loadMessages(chatId);
        const wirePayload = prior
          .filter((m) => !m.summarizedInto && !m.error && m.kind !== "summary")
          .map((m) => ({ role: m.role, content: m.content }));
        wirePayload.push({ role: "user", content: utterance });

        const userMsg: StoredMessage = {
          id: newId(),
          chatId,
          role: "user",
          content: utterance,
          createdAt: Date.now(),
        };
        await putMessage(userMsg);

        // Deliberately NOT passed: research / novelMode (multi-minute
        // producers - unusable in a live conversation) and imageSearch
        // (nothing to show). Web search stays available for freshness.
        const postBody: Record<string, unknown> = {
          model,
          webSearch: !!s.webSearch,
          imageSearch: false,
          research: false,
          messages: wirePayload,
          responseFormat: "chat",
          // Fold the note/attachment context in after the voice instructions so
          // the model can actually read what the user is talking about.
          system: noteContextRef.current
            ? `${VOICE_SYSTEM}\n\n${noteContextRef.current}`
            : VOICE_SYSTEM,
        };
        if (s.chatPersonaId) postBody.chatPersonaId = s.chatPersonaId;
        if (s.runpodEndpointId) postBody.runpodEndpointId = s.runpodEndpointId;

        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(postBody),
          signal: ctrl.signal,
        });
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (res.status === 503) {
          throw new Error(
            "Voice mode needs server stream storage configured (UPSTASH_REDIS_REST_URL)."
          );
        }
        if (!res.ok) {
          const detail = await res
            .json()
            .catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(detail.error ?? `HTTP ${res.status}`);
        }
        const handshake = (await res.json()) as { streamId?: string };
        if (!handshake.streamId) throw new Error("Server did not return a streamId.");

        const full = await consumeDeltasOnly(
          handshake.streamId,
          ctrl.signal,
          (fullText) => {
            const delta = fullText.slice(streamedLen);
            streamedLen = fullText.length;
            accumulated = fullText;
            setAssistantText(fullText);
            for (const chunk of chunker.push(delta)) {
              const cleaned = stripForSpeech(chunk);
              if (cleaned) queue.enqueue(cleaned);
            }
          }
        );
        if (!full.trim()) throw new Error("Empty response.");

        for (const chunk of chunker.flush()) {
          const cleaned = stripForSpeech(chunk);
          if (cleaned) queue.enqueue(cleaned);
        }
        queue.finish();
        await persistAssistant(full);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // Barge-in or page exit. Keep whatever was generated on record;
          // the interrupt handler already put the mic back in charge.
          void persistAssistant(accumulated);
          return;
        }
        queue.stop();
        setError(err instanceof Error ? err.message : "Request failed");
        void persistAssistant(accumulated);
        yieldToUser();
      } finally {
        if (inflightCtrlRef.current === ctrl) inflightCtrlRef.current = null;
      }
    },
    [chatId, queue, yieldToUser]
  );
  runTurnRef.current = (u) => void runTurn(u);

  // ---- Start / pause / exit -------------------------------------------------
  const begin = useCallback(() => {
    setError(null);
    setHint(null);
    // Unlock audio inside this tap - required for iOS autoplay.
    queue.prime();
    // In both modes the start tap opens the mic - in tap-to-talk the tap IS
    // the "talk" button; subsequent turns then wait on "ready".
    startListening();
  }, [queue, startListening]);

  const toggleMute = useCallback(() => {
    if (mutedRef.current) {
      mutedRef.current = false;
      setMuted(false);
      setHint(null);
      if (turnRef.current === "speaking") {
        if (handsFreeRef.current && bargeInRef.current) monitor();
      } else if (turnRef.current === null) {
        yieldToUser();
      }
    } else {
      mutedRef.current = true;
      setMuted(true);
      // Mute silences the mic, not the assistant's in-progress reply.
      pauseMic();
      if (turnRef.current === null) setUi("paused");
    }
  }, [monitor, pauseMic, yieldToUser]);

  // Pause = fully suspend the back-and-forth without leaving: close the mic,
  // silence any reply that's playing, and abort the in-flight model turn (the
  // partial reply is persisted by runTurn's abort path). Distinct from mute,
  // which only closes the mic and lets the assistant keep talking. Reuses the
  // muted machinery so canListen() stays false until the user resumes.
  const pauseConversation = useCallback(() => {
    mutedRef.current = true;
    setMuted(true);
    queue.stop();
    inflightCtrlRef.current?.abort();
    turnRef.current = null;
    pauseMic();
    setHint(null);
    setUi("paused");
  }, [pauseMic, queue]);

  const resumeConversation = useCallback(() => {
    mutedRef.current = false;
    setMuted(false);
    setHint(null);
    if (handsFreeRef.current) {
      startListening();
    } else {
      setUi("ready");
    }
  }, [startListening]);

  const togglePause = useCallback(() => {
    if (ui === "paused") resumeConversation();
    else pauseConversation();
  }, [pauseConversation, resumeConversation, ui]);

  const exit = useCallback(() => {
    exitingRef.current = true;
    inflightCtrlRef.current?.abort();
    queue.dispose();
    endMic();
    router.push(`/chats/${chatId}`);
  }, [chatId, endMic, queue, router]);

  // Orb tap: context-dependent primary action.
  const onOrbTap = useCallback(() => {
    if (ui === "start") return begin();
    if (ui === "ready") return startListening(); // tap-to-talk: open the mic
    if (ui === "paused") {
      // Resuming with a tap means "I want to talk" in either mode.
      mutedRef.current = false;
      setMuted(false);
      setHint(null);
      return startListening();
    }
    if (ui === "listening") return endpointNow(); // send now
    if (ui === "speaking" || ui === "thinking") return interruptRef.current();
  }, [begin, endpointNow, startListening, ui]);

  // ---- Mount: chat + settings ------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [c, s, msgs] = await Promise.all([
        getChat(chatId),
        loadSettings(),
        loadMessages(chatId),
      ]);
      if (cancelled) return;
      settingsRef.current = s;
      setSettings(s);
      setChat(c ?? null);
      // Load the note/attachment context up front so the very first turn can
      // see it. Non-blocking for the mic loop; it only feeds the system prompt.
      void buildVoiceContext(c ?? null).then((ctx) => {
        if (!cancelled) noteContextRef.current = ctx;
      });
      // Seed the STT decoding hint with the last assistant reply.
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === "assistant" && !m.error && m.kind !== "summary" && m.content?.trim()) {
          lastAssistantRef.current = m.content;
          break;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  const persistSettings = useCallback((patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    void saveSettings(next);
  }, []);

  // Cycle playback speed 1x -> 1.25x -> 1.5x -> 2x -> 1x; takes effect on
  // the chunk that's playing right now, not just the next one.
  const cycleSpeed = useCallback(() => {
    const SPEEDS = [1, 1.25, 1.5, 2];
    const idx = SPEEDS.indexOf(speedRef.current);
    const next = SPEEDS[(idx + 1) % SPEEDS.length] ?? 1;
    speedRef.current = next;
    persistSettings({ voiceSpeed: next });
    queue.applyRate();
  }, [persistSettings, queue]);

  // Switching conversation style mid-session takes effect immediately:
  // -> hands-free from "ready" opens the mic (auto mode has no ready state);
  // -> tap-to-talk while the assistant speaks disarms the barge-in monitor.
  const setConvMode = useCallback(
    (mode: "auto" | "manual") => {
      handsFreeRef.current = mode === "auto";
      persistSettings({ voiceInputMode: mode });
      if (mode === "auto") {
        if (ui === "ready") startListening();
        else if (ui === "speaking" && bargeInRef.current && !mutedRef.current) {
          monitor();
        }
      } else if (ui === "speaking" || ui === "thinking") {
        pauseMic();
      }
    },
    [monitor, pauseMic, persistSettings, startListening, ui]
  );

  // ---- Screen wake lock - a conversation shouldn't fight the lockscreen. ----
  useEffect(() => {
    let cancelled = false;
    const requestLock = async () => {
      if (!("wakeLock" in navigator)) return;
      try {
        const s = await (
          navigator as Navigator & {
            wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
          }
        ).wakeLock!.request("screen");
        if (cancelled) {
          void s.release().catch(() => {});
        } else {
          wakeLockRef.current = s;
        }
      } catch {
        // Permission/visibility denied - silent.
      }
    };
    void requestLock();
    const onVis = () => {
      if (document.visibilityState === "visible" && !wakeLockRef.current) {
        void requestLock();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      const lock = wakeLockRef.current;
      wakeLockRef.current = null;
      lock?.release().catch(() => {});
    };
  }, []);

  // Final teardown (browser back, route change, unmount in general).
  useEffect(() => {
    return () => {
      exitingRef.current = true;
      inflightCtrlRef.current?.abort();
      queueRef.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the streaming caption pinned to the newest text.
  useEffect(() => {
    const el = captionsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [assistantText]);

  // Reconcile the mic loop's own transitions (listening <-> transcribing)
  // into the displayed state whenever the turn isn't in charge.
  useEffect(() => {
    if (exitingRef.current || turnRef.current !== null) return;
    if (ui === "start" || ui === "paused" || ui === "ready") return;
    if (voiceStatus === "listening" && ui !== "listening") setUi("listening");
    if (voiceStatus === "transcribing" && ui !== "transcribing") setUi("transcribing");
  }, [voiceStatus, ui]);

  const modelGroups = useMemo(() => {
    const enabled = settingsRef.current.enabledModels;
    const visible =
      enabled && enabled.length > 0
        ? availableModels.filter(
            (m) => enabled.includes(m.id) || m.id === voiceModel
          )
        : availableModels;
    return partitionVoiceModels(visible);
  }, [availableModels, voiceModel]);

  const statusLine: string = (() => {
    if (hint) return hint;
    switch (ui) {
      case "start":
        return handsFree
          ? "Tap the circle to start a conversation."
          : "Tap the circle and start talking.";
      case "ready":
        return "Your turn - tap the circle to talk.";
      case "listening":
        return handsFree
          ? "Listening - just talk. Tap the circle to send right away."
          : "Listening - tap the circle when you're done.";
      case "transcribing":
        return "Got it...";
      case "thinking":
        return "Thinking...";
      case "speaking":
        return handsFree && bargeIn
          ? "Speak or tap the circle to interrupt."
          : "Tap the circle to stop.";
      case "paused":
        return "Paused - tap the circle to resume.";
    }
  })();

  const orbScale =
    ui === "listening"
      ? 1 + Math.min(1, voice.audioLevel) * 0.18
      : ui === "speaking"
        ? 1.04
        : 1;

  return (
    <div className="safe-top safe-bottom fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <header className="flex items-center justify-between px-4 pt-3 pb-2">
        <Button
          variant="ghost"
          size="icon-touch"
          onClick={exit}
          aria-label="Exit voice mode"
        >
          <ArrowLeft className="h-6 w-6" />
        </Button>
        <div className="min-w-0 text-center">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Voice mode
          </div>
          <div className="truncate text-xs text-muted-foreground/70">
            {chat?.title ?? "Chat"}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-touch"
          onClick={() => setShowConfig((v) => !v)}
          aria-label="Voice settings"
          className={cn(showConfig && "bg-muted")}
        >
          <Settings2 className="h-5 w-5" />
        </Button>
      </header>

      {showConfig && (
        <div className="mx-auto w-full max-w-md px-6">
          <div className="space-y-3 rounded-xl border bg-card p-4 text-sm shadow-sm">
            <div>
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                Conversation style
              </span>
              <div className="grid grid-cols-2 gap-1 rounded-md border p-1">
                <button
                  type="button"
                  onClick={() => setConvMode("auto")}
                  className={cn(
                    "rounded px-2 py-1.5 text-xs font-medium transition-colors",
                    handsFree
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted"
                  )}
                >
                  Hands-free
                </button>
                <button
                  type="button"
                  onClick={() => setConvMode("manual")}
                  className={cn(
                    "rounded px-2 py-1.5 text-xs font-medium transition-colors",
                    !handsFree
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted"
                  )}
                >
                  Tap to talk
                </button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground/80">
                {handsFree
                  ? "It listens continuously and sends when you pause."
                  : "Tap to talk, tap to send, tap to stop a reply. Best when auto-detection or echo cancellation misbehaves."}
              </p>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                Model (fast models keep the conversation snappy)
              </span>
              <select
                value={voiceModel}
                onChange={(e) => persistSettings({ voiceModel: e.target.value })}
                className="w-full rounded-md border bg-background px-2 py-1.5"
              >
                <optgroup label="Recommended for voice">
                  {modelGroups.recommended.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
                {modelGroups.others.length > 0 && (
                  <optgroup label="Other models (may be slow to answer)">
                    {modelGroups.others.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                Voice
              </span>
              <select
                value={ttsVoice}
                onChange={(e) => persistSettings({ voiceName: e.target.value })}
                className="w-full rounded-md border bg-background px-2 py-1.5"
              >
                {TTS_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <label
              className={cn(
                "flex items-center justify-between gap-3",
                !handsFree && "opacity-50"
              )}
            >
              <span className="text-xs font-medium text-muted-foreground">
                Interrupt by speaking (hands-free only; turn off if it cuts
                itself off on loudspeakers)
              </span>
              <input
                type="checkbox"
                checked={bargeIn}
                disabled={!handsFree}
                onChange={(e) => persistSettings({ voiceBargeIn: e.target.checked })}
                className="size-4 accent-primary"
              />
            </label>
          </div>
        </div>
      )}

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-8 px-6">
        {/* Captions */}
        <div className="flex min-h-[7rem] w-full flex-col items-center justify-end gap-2 text-center">
          {userText && (
            <p className="max-w-prose text-sm text-muted-foreground line-clamp-2">
              &ldquo;{userText}&rdquo;
            </p>
          )}
          {assistantText && (
            <div
              ref={captionsRef}
              className="max-h-36 w-full overflow-y-auto"
            >
              <p className="mx-auto max-w-prose text-lg leading-relaxed text-foreground/90">
                {stripForSpeech(assistantText)}
              </p>
            </div>
          )}
          {!userText && !assistantText && ui === "start" && (
            <p className="text-base text-muted-foreground">
              Have a spoken conversation - it listens, answers out loud, and
              keeps going until you leave.
            </p>
          )}
        </div>

        {/* Orb */}
        <button
          type="button"
          onClick={onOrbTap}
          aria-label={
            ui === "start"
              ? "Start conversation"
              : ui === "ready"
                ? "Tap to talk"
                : ui === "paused"
                  ? "Resume conversation"
                  : ui === "listening"
                    ? "Send now"
                    : "Interrupt"
          }
          className={cn(
            "relative flex size-40 items-center justify-center rounded-full transition-transform duration-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40",
            "bg-gradient-to-br from-primary via-primary/85 to-primary/60 shadow-lg",
            ui === "thinking" && "animate-pulse",
            ui === "paused" && "opacity-60 saturate-50",
            ui === "speaking" && "voice-orb-speaking"
          )}
          style={{ transform: `scale(${orbScale})` }}
        >
          {ui === "start" || ui === "paused" ? (
            <Mic className="size-12 text-primary-foreground" />
          ) : ui === "transcribing" || ui === "thinking" ? (
            <Loader2 className="size-12 animate-spin text-primary-foreground" />
          ) : ui === "speaking" ? (
            <span className="flex items-end gap-1.5" aria-hidden>
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  className="voice-eq-bar w-2 rounded-full bg-primary-foreground"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </span>
          ) : (
            <Mic className="size-12 text-primary-foreground" />
          )}
          {ui === "listening" && (
            <span
              className="absolute inset-0 -z-10 rounded-full bg-primary/25"
              style={{
                transform: `scale(${1.05 + Math.min(1, voice.audioLevel) * 0.35})`,
              }}
              aria-hidden
            />
          )}
        </button>

        {/* Status + error lines (kept separate so a sticky error doesn't
            mask what state the conversation is actually in). */}
        <div className="min-h-[2.5rem] max-w-prose space-y-1 text-center text-sm">
          {error && <div className="text-destructive">{error}</div>}
          <div className="text-muted-foreground">{statusLine}</div>
        </div>
      </div>

      {/* Bottom controls */}
      <div className="flex items-center justify-center gap-6 pb-8">
        <Button
          variant={muted ? "destructive" : "outline"}
          onClick={toggleMute}
          disabled={ui === "start" || ui === "paused"}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          className="size-14 rounded-full p-0 [&_svg]:size-6"
        >
          {muted ? <MicOff /> : <Mic />}
        </Button>
        <Button
          variant={ui === "paused" ? "default" : "outline"}
          onClick={togglePause}
          disabled={ui === "start"}
          aria-label={ui === "paused" ? "Resume conversation" : "Pause conversation"}
          className="size-14 rounded-full p-0 [&_svg]:size-6"
        >
          {ui === "paused" ? <Play /> : <Pause />}
        </Button>
        <Button
          variant="outline"
          onClick={cycleSpeed}
          aria-label={`Playback speed ${speed}x - tap to change`}
          className="size-14 rounded-full p-0 font-mono text-sm font-semibold tabular-nums"
        >
          {speed === 1 ? "1×" : `${speed}×`}
        </Button>
        <Button
          variant="secondary"
          onClick={exit}
          aria-label="End conversation"
          className="size-14 rounded-full p-0 [&_svg]:size-6"
        >
          <X />
        </Button>
      </div>

      {/* Local keyframes for the speaking equalizer + orb glow. Class names
          are voice-* prefixed so this plain global style tag can't collide. */}
      <style>{`
        .voice-eq-bar {
          height: 1.25rem;
          animation: voice-eq 0.9s ease-in-out infinite;
        }
        @keyframes voice-eq {
          0%,
          100% {
            height: 0.75rem;
          }
          50% {
            height: 2.25rem;
          }
        }
        .voice-orb-speaking {
          box-shadow: 0 0 0 0.75rem
            color-mix(in srgb, var(--primary) 15%, transparent);
        }
      `}</style>
    </div>
  );
}
