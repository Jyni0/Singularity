import { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import { Zap, Shield, Send, X, Square, Mic, Loader2, Paperclip, FileText } from "lucide-react";
import { Project, Gateway, Attachment, Effort } from "../core/types.i";
import { toAttachments, formatSize } from "../utils/attachments.u";
import { useDictation } from "../hooks/useDictation.h";
import { useOverlayThumb } from "../hooks/useOverlayThumb.h";
import { CHIP_CTX } from "../ui/tokens.s";
import { Thumb } from "../ui/Thumb.c";
import { ModelSelector } from "./ModelSelector.c";
import { ProjectPicker } from "./ProjectPicker.c";
import { EffortChip } from "./EffortChip.c";

export function PromptBox({
  onSend,
  projects,
  project,
  onSelectProject,
  gateways,
  centered,
  busy,
  onStop,
  onTranscribe,
  pickedModel,
  onPickModel,
}: {
  onSend: (
    text: string,
    selection: { gatewayId: string; modelId: string; effort: Effort },
    attachments: Attachment[]
  ) => void;
  projects: Project[];
  project: string;
  onSelectProject: (name: string) => void;
  gateways: Gateway[];
  centered?: boolean;
  /** True while this conversation's generation is running — Send becomes Stop. */
  busy?: boolean;
  onStop?: () => void;
  /** Transcribes a recorded mic blob using the selected provider's endpoint. */
  onTranscribe?: (gatewayId: string, blob: Blob) => Promise<string>;
  /** Model chosen earlier — restored so the chat remembers its model. */
  pickedModel?: { gatewayId: string; modelId: string } | null;
  /** Reports the model the user picked, so it can be persisted. */
  onPickModel?: (next: { gatewayId: string; modelId: string }) => void;
}) {
  const [text, setText] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [modelId, setModelId] = useState("");
  const [turbo, setTurbo] = useState(true);
  const [effort, setEffort] = useState<Effort>(
    () => (localStorage.getItem("effort") as Effort) || "medium"
  );
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const promptThumb = useOverlayThumb(ref);

  // Keep the selection pointed at a model that actually exists: the provider
  // list is loaded from the database and changes as providers are connected.
  // The model picked in an earlier session wins when it is still available.
  useEffect(() => {
    const usable = gateways.filter((g) => g.models.length > 0);
    const current = usable.find(
      (g) => g.id === gatewayId && g.models.some((m) => m.id === modelId)
    );
    if (current) return;

    const saved = pickedModel
      ? usable.find(
          (g) =>
            g.id === pickedModel.gatewayId &&
            g.models.some((m) => m.id === pickedModel.modelId)
        )
      : undefined;
    if (saved) {
      setGatewayId(saved.id);
      setModelId(pickedModel!.modelId);
      return;
    }

    const first = usable[0];
    if (first) {
      setGatewayId(first.id);
      setModelId(first.models[0].id);
    }
  }, [gateways, gatewayId, modelId, pickedModel]);

  const autoGrow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  // Dictation: record the mic, transcribe through the selected provider's
  // Whisper-compatible endpoint, and append the text to the prompt.
  const speech = useDictation(async (blob) => {
    if (!onTranscribe) throw new Error("Dictation needs a connected provider");
    return onTranscribe(gatewayId, blob);
  });

  useEffect(() => {
    speech.setOnResult((text) => {
      setText((prev) => `${prev}${prev && !prev.endsWith(" ") ? " " : ""}${text}`);
      requestAnimationFrame(autoGrow);
    });
  }, [gatewayId]);

  const toggleMic = () => {
    if (speech.listening) speech.stop();
    else speech.start();
  };

  /** Accepts picked or dropped files as attachments. */
  const acceptFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const { attachments: added, rejected } = await toAttachments(files);
    if (added.length > 0) setAttachments((prev) => [...prev, ...added]);
    setNotice(rejected.length > 0 ? rejected.join(" · ") : null);
  };

  /** Pastes from the clipboard: images (screenshots) and copied files. */
  const onPaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    let textPart = "";

    for (const item of items) {
      // A copied file or a screenshot in the clipboard.
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      } else if (item.kind === "string" && item.type === "text/plain") {
        textPart = e.clipboardData.getData("text/plain");
      }
    }

    if (files.length > 0) {
      // Let the browser skip its own file handling; we take over.
      e.preventDefault();
      await acceptFiles(files);
      return;
    }

    // Plain text still goes into the textarea normally.
    if (textPart) {
      e.preventDefault();
      setText((prev) => prev + textPart);
      requestAnimationFrame(autoGrow);
    }
  };

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id));

  const pickEffort = (next: Effort) => {
    setEffort(next);
    localStorage.setItem("effort", next);
  };

  const send = () => {
    // A prompt can be just attachments — that is a legitimate request.
    if (!text.trim() && attachments.length === 0) return;
    // Sending cancels an in-flight recording instead of transcribing it.
    speech.cancel();
    onSend(text.trim(), { gatewayId, modelId, effort }, attachments);
    setText("");
    setAttachments([]);
    setNotice(null);
    requestAnimationFrame(autoGrow);
  };

  return (
    <div className={`flex w-full justify-center ${centered ? "" : "px-6 pb-4"}`}>
      <div className="flex w-full max-w-[760px] flex-col">
        {centered && (
          <div className="mb-4 flex justify-center">
            {/* Project settings moved to Settings → Projects; nothing here. */}
            <ProjectPicker projects={projects} project={project} onSelect={onSelectProject} />
          </div>
        )}
        {/* min-h 108px, radius 16, theme surface + border */}
        <div
          className={`flex min-h-[108px] w-full flex-col justify-between rounded-2xl border bg-[var(--bg-surface)] transition-colors focus-within:border-[var(--accent)] ${
            dragging ? "border-[var(--accent)] bg-[var(--hover-bg)]" : "border-[var(--border)]"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void acceptFiles(Array.from(e.dataTransfer.files));
          }}
        >
          {/* Attachment previews, above the input */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {attachments.map((a) => (
                <div
                  key={a.id}
                  className="group flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-input)] py-1 pl-1 pr-2"
                >
                  {a.kind === "image" ? (
                    <img
                      src={a.data}
                      alt={a.name}
                      className="h-8 w-8 rounded object-cover"
                    />
                  ) : (
                    <FileText size={13} className="mx-1 text-[var(--text-dim)]" />
                  )}
                  <span className="max-w-[160px] truncate text-[11px] text-[var(--text-main)]">
                    {a.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-[var(--text-dim)]">
                    {formatSize(a.size)}
                  </span>
                  <button
                    className="shrink-0 text-[var(--text-dim)] hover:text-[var(--diff-del)]"
                    onClick={() => removeAttachment(a.id)}
                    title="Remove attachment"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {(notice || speech.error) && (
            <div className="px-4 pt-2 text-[11px] text-[var(--diff-del)]">
              {notice || speech.error}
            </div>
          )}
          {dragging && (
            <div className="px-4 pt-2 text-[12px] text-[var(--accent)]">
              Drop to attach files or images…
            </div>
          )}

          {/* Textarea keeps the custom overlay bar too (native bar is hidden) */}
          <div className="relative">
            <textarea
              ref={ref}
              rows={1}
              className="no-native-scrollbar max-h-[200px] min-h-[44px] w-full resize-none border-none bg-transparent px-4 pb-2 pt-3.5 text-[14px] leading-normal text-[var(--text-main)] outline-none placeholder:text-[var(--text-dim)]"
              placeholder="Ask anything…  /commands   @files @folders @terminal @git"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                autoGrow();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onPaste={(e) => void onPaste(e)}
            />
            <Thumb thumb={promptThumb} />
          </div>
          {/* Toolbar: 6px 12px 10px, space-between */}
          <div className="flex items-center justify-between gap-1.5 px-3 pb-2.5 pt-1.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <ModelSelector
                gateways={gateways}
                gatewayId={gatewayId}
                modelId={modelId}
                onSelect={(g, m) => {
                  setGatewayId(g);
                  setModelId(m);
                  // Remember the choice so the next launch restores it.
                  onPickModel?.({ gatewayId: g, modelId: m });
                }}
              />
              <span
                className={CHIP_CTX}
                onClick={() => setTurbo(!turbo)}
                title="Turbo / Auto-Pilot vs Safe / Supervised"
              >
                {turbo ? <Zap size={12} strokeWidth={1.5} /> : <Shield size={12} strokeWidth={1.5} />}
                {turbo ? "Turbo" : "Safe"}
              </span>
              {/* Reasoning effort — low is fast, high thinks harder. */}
              <EffortChip effort={effort} onPick={pickEffort} />
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {/* Hidden file input driven by the paperclip button */}
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  void acceptFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
              <button
                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                onClick={() => fileInput.current?.click()}
                title="Attach files or images (or drag them onto the prompt)"
              >
                <Paperclip size={14} strokeWidth={1.5} />
              </button>
              {/* Mic: records audio, then transcribes it via the provider. */}
              <button
                className={`relative flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                  speech.listening
                    ? "bg-[var(--diff-del)]/15 text-[var(--diff-del)]"
                    : speech.transcribing
                      ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                      : "text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                } ${speech.supported ? "" : "cursor-not-allowed opacity-40"}`}
                onClick={toggleMic}
                disabled={!speech.supported || speech.transcribing}
                title={
                  !speech.supported
                    ? "Microphone is unavailable"
                    : speech.transcribing
                      ? "Transcribing…"
                      : speech.listening
                        ? "Stop recording"
                        : "Dictate with microphone"
                }
              >
                {speech.transcribing ? (
                  <Loader2 size={15} strokeWidth={1.5} className="animate-spin" />
                ) : (
                  <Mic size={15} strokeWidth={1.5} />
                )}
                {speech.listening && (
                  <motion.span
                    className="absolute inset-0 rounded-md border border-[var(--diff-del)]"
                    animate={{ opacity: [0.9, 0.25, 0.9] }}
                    transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
                  />
                )}
              </button>
              {busy ? (
                <motion.button
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--diff-del)] text-white transition-opacity hover:opacity-90"
                  onClick={onStop}
                  title="Stop generation"
                  initial={{ scale: 0.8 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 500, damping: 28 }}
                >
                  <Square size={12} fill="currentColor" strokeWidth={0} />
                </motion.button>
              ) : (
                <button
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)] text-white transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:bg-[var(--bg-elevated)] disabled:text-[var(--text-dim)]"
                  onClick={send}
                  disabled={!text.trim()}
                  title="Send"
                >
                  <Send size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- History view ---------- */
