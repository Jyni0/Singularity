import { useState, useEffect, useRef } from "react";

/**
 * Microphone → text.
 *
 * WebView2 (Tauri's Windows webview) has no Web Speech API, so `SpeechRecognition`
 * is always undefined there and the old implementation silently did nothing.
 * This records the mic with `MediaRecorder`, then hands the finished blob to the
 * caller's `submit`, which posts it to an OpenAI-compatible
 * `/audio/transcriptions` endpoint through Rust (`db.transcribeAudio`).
 *
 * `state`: `idle` → `recording` → `transcribing` → `idle`. `error` carries a
 * short message when recording or transcription fails.
 */
export function useDictation(submit: (blob: Blob) => Promise<string>) {
  const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [supported] = useState(
    () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined"
  );
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  const cleanup = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  };

  const stop = () => {
    // Stopping the recorder fires `onstop`, which does the transcription.
    try {
      recorderRef.current?.stop();
    } catch {
      /* already stopped */
    }
  };

  /** Drops the current recording without transcribing it. */
  const cancel = () => {
    const recorder = recorderRef.current;
    if (recorder) recorder.onstop = null;
    try {
      recorder?.stop();
    } catch {
      /* already stopped */
    }
    cleanup();
    setState("idle");
  };

  const start = async () => {
    if (!supported) {
      setError("Microphone is unavailable in this environment");
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // Pick a codec the platform actually records with; WebView2 supports webm/opus.
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
        (m) => MediaRecorder.isTypeSupported?.(m)
      );
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onerror = () => {
        setError("Recording failed");
        setState("idle");
        cleanup();
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mime || "audio/webm" });
        cleanup();
        if (blob.size === 0) {
          setState("idle");
          setError("Nothing was recorded");
          return;
        }
        setState("transcribing");
        try {
          const text = await submit(blob);
          if (text.trim()) {
            dictationResultRef.current?.(text.trim());
          }
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setState("idle");
        }
      };

      recorder.start();
      setState("recording");
    } catch (e) {
      cleanup();
      setState("idle");
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Microphone permission denied"
          : e instanceof Error
            ? e.message
            : String(e)
      );
    }
  };

  // Lets the caller feed the final text into the prompt without re-rendering
  // the hook on every keystroke.
  const dictationResultRef = useRef<((text: string) => void) | null>(null);

  useEffect(() => () => cleanup(), []);

  return {
    state,
    listening: state === "recording",
    transcribing: state === "transcribing",
    supported,
    error,
    start,
    stop,
    cancel,
    toggle: () => (state === "recording" ? stop() : void start()),
    setOnResult: (fn: (text: string) => void) => {
      dictationResultRef.current = fn;
    },
  };
}

/* ---------- Effort selector ---------- */
