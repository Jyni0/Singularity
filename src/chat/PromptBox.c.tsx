import { useState, useEffect, useRef, useMemo } from "react";
import type { ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Send, Plus, X, Square, Mic, Loader2, Paperclip, FileText, Folder, GitBranch, SquarePen, Zap, Rabbit, Scale, Brain,
  Sparkles, Plug, ListChecks, SearchCode, BookOpen, Wrench, FlaskConical, GitCommitHorizontal,
  ListPlus, Pencil, Play, Minimize2, ChevronUp,
} from "lucide-react";
import * as db from "../core/db.r";
import type { Project, Gateway, Attachment, Effort } from "../core/types.i";
import { clampEffort, effortsFor } from "../core/types.i";
import type { ChatSelection, QueuedPrompt } from "../hooks/useChat.h";
import { toAttachments, formatSize } from "../utils/attachments.u";
import { useDictation } from "../hooks/useDictation.h";
import { BgTasksChip } from "./BackgroundTasks.c";
import { useOverlayThumb } from "../hooks/useOverlayThumb.h";

import { EffortChip } from "./EffortChip.c";
import { ModelSelector } from "./ModelSelector.c";
import { ProjectPicker } from "./ProjectPicker.c";

import { ComposerMenu, type ComposerItem } from "./ComposerMenu.c";
import { detectTrigger, mentionText, rankFiles, replaceToken, splitPath } from "./composer.u";
import { Thumb, ScrollBox, IconButton } from "../components";

/** What a `/` action asks the app to do. */
export type PromptCommand = "new" | "skills" | "mcp" | "compact";

/** A `/` entry: runs at once (action) or stays in the prompt (template —
 *  expanded by the agent, see src-tauri/src/agent/expand.rs). */
interface SlashDef {
  name: string;
  hint: string;
  icon: React.ReactNode;
  kind: "action" | "template" | "skill";
}

const ICON = { size: 13, strokeWidth: 1.6 } as const;

const TEMPLATES: SlashDef[] = [
  { name: "plan", hint: "Investigate and write a plan — no changes", icon: <ListChecks {...ICON} />, kind: "template" },
  { name: "review", hint: "Review the uncommitted changes", icon: <SearchCode {...ICON} />, kind: "template" },
  { name: "explain", hint: "Explain code or the whole project", icon: <BookOpen {...ICON} />, kind: "template" },
  { name: "fix", hint: "Find and fix a problem, then verify", icon: <Wrench {...ICON} />, kind: "template" },
  { name: "test", hint: "Write tests and run them", icon: <FlaskConical {...ICON} />, kind: "template" },
  { name: "commit", hint: "Commit the current changes", icon: <GitCommitHorizontal {...ICON} />, kind: "template" },
];

const ACTIONS: SlashDef[] = [
  { name: "new", hint: "Start a new conversation", icon: <SquarePen {...ICON} />, kind: "action" },
  { name: "model", hint: "Choose the model", icon: <Zap {...ICON} />, kind: "action" },
  { name: "fast", hint: "Effort: fast answers", icon: <Rabbit {...ICON} />, kind: "action" },
  { name: "balanced", hint: "Effort: balanced", icon: <Scale {...ICON} />, kind: "action" },
  { name: "think", hint: "Effort: think harder", icon: <Brain {...ICON} />, kind: "action" },
  { name: "skills", hint: "Manage skills", icon: <Sparkles {...ICON} />, kind: "action" },
  { name: "mcp", hint: "Manage MCP servers", icon: <Plug {...ICON} />, kind: "action" },
  { name: "compact", hint: "Summarize the chat to free context (/compact [what to keep])", icon: <Minimize2 {...ICON} />, kind: "action" },
];

/** Workspace listings are cached this long (ms) between @ menus. */
const FILES_TTL = 30_000;

export function PromptBox({
  onSend,
  projects,
  project,
  onSelectProject,
  gateways,
  centered,
  busy,
  onStop,
  pickedModel,
  onPickModel,
  workspace = "",
  onCommand,
  queued = [],
  onTakeQueued,
  onRunQueued,
  onOpenBgTask,
  contextMeter,
}: {
  onSend: (text: string, selection: ChatSelection, attachments: Attachment[]) => void;
  projects: Project[];
  project: string;
  onSelectProject: (name: string) => void;
  gateways: Gateway[];
  centered?: boolean;
  /** True while this conversation's generation is running — Send becomes Stop. */
  busy?: boolean;
  onStop?: () => void;
  /** Model chosen earlier — restored so the chat remembers its model. */
  pickedModel?: { gatewayId: string; modelId: string } | null;
  /** Reports the model the user picked, so it can be persisted. */
  onPickModel?: (next: { gatewayId: string; modelId: string }) => void;
  /** Folder the prompt's run works in — the @ menu lists its files. */
  workspace?: string;
  /** `/new`, `/skills`, `/mcp`, `/compact [focus]` — handled by the app;
   *  a returned message is shown under the prompt. */
  onCommand?: (cmd: PromptCommand, arg?: string) => void | Promise<string | null | void>;
  /** The context gauge, shown in the toolbar. */
  contextMeter?: ReactNode;
  /** Follow-ups written while the agent works; they run one by one after it. */
  queued?: QueuedPrompt[];
  /** Removes a queued prompt and returns it (Edit / Delete). */
  onTakeQueued?: (id: string) => QueuedPrompt | undefined;
  /** Sends a queued prompt now (the queue is paused after Stop). */
  onRunQueued?: (id: string) => void;
  /** Opens a background task (dev server, watcher) in the side panel. */
  onOpenBgTask?: (task: db.BgTask) => void;
}) {
  const [text, setText] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState<Effort>(
    () => (localStorage.getItem("effort") as Effort) || "medium"
  );
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** The queue plate above the prompt: collapsed to one line by default. */
  const [queueOpen, setQueueOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const promptThumb = useOverlayThumb(ref);

  /* ---------- `/` and `@` menu ---------- */
  const [caret, setCaret] = useState(0);
  const [menuActive, setMenuActive] = useState(0);
  /** Token start the user closed the menu on (Esc) — stays closed there. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [modelSignal, setModelSignal] = useState(0);
  const [files, setFiles] = useState<{ root: string; at: number; list: string[] } | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [skills, setSkills] = useState<db.Skill[]>([]);
  const trigger = detectTrigger(text, caret);
  const menuOpen = trigger !== null && dismissedAt !== trigger.start;

  // Fresh data when a menu opens: skills for `/`, the file index for `@`.
  const triggerKind = menuOpen ? trigger.kind : null;
  useEffect(() => {
    if (triggerKind === "slash") {
      void db.listSkills(workspace).then((l) => setSkills(l.filter((s) => s.enabled))).catch(() => setSkills([]));
    }
    if (triggerKind === "mention" && workspace) {
      if (files && files.root === workspace && Date.now() - files.at < FILES_TTL) return;
      setFilesLoading(true);
      void db
        .workspaceFiles(workspace)
        .then((list) => setFiles({ root: workspace, at: Date.now(), list }))
        .catch(() => setFiles({ root: workspace, at: Date.now(), list: [] }))
        .finally(() => setFilesLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerKind, workspace]);

  const slashDefs = useMemo<SlashDef[]>(() => {
    const q = trigger?.kind === "slash" ? trigger.query.toLowerCase() : "";
    const skillDefs: SlashDef[] = skills.map((s) => ({
      name: s.name,
      hint: s.description,
      icon: <Sparkles {...ICON} />,
      kind: "skill",
    }));
    const all = [...TEMPLATES, ...skillDefs, ...ACTIONS];
    const starts = all.filter((d) => d.name.toLowerCase().startsWith(q));
    const contains = all.filter((d) => !d.name.toLowerCase().startsWith(q) && d.name.toLowerCase().includes(q));
    // Keep the group order stable: prompts, skills, actions.
    const order = (d: SlashDef) => (d.kind === "template" ? 0 : d.kind === "skill" ? 1 : 2);
    return [...starts, ...contains].sort((a, b) => order(a) - order(b));
  }, [trigger?.kind, trigger?.query, skills]);

  const mentionPaths = useMemo<string[]>(() => {
    if (trigger?.kind !== "mention") return [];
    const q = trigger.query;
    const git = q && !q.includes("/") && "git".startsWith(q.toLowerCase()) ? ["@git"] : !q ? ["@git"] : [];
    return [...git, ...rankFiles(files?.root === workspace ? files.list : [], q)];
  }, [trigger?.kind, trigger?.query, files, workspace]);

  const menuItems: ComposerItem[] =
    trigger?.kind === "slash"
      ? slashDefs.map((d) => ({
          id: `${d.kind}:${d.name}`,
          group: d.kind === "template" ? "Prompts" : d.kind === "skill" ? "Skills" : "Actions",
          icon: d.icon,
          label: `/${d.name}`,
          detail: d.hint,
          mono: true,
          badge: d.kind === "skill" ? "skill" : undefined,
        }))
      : mentionPaths.map((p) => {
          if (p === "@git") {
            return { id: p, group: "Context", icon: <GitBranch {...ICON} />, label: "git", detail: "status, recent commits and diff", mono: true };
          }
          const { name, dir } = splitPath(p);
          return {
            id: p,
            group: "Files & folders",
            icon: p.endsWith("/") ? <Folder {...ICON} /> : <FileText {...ICON} />,
            label: name,
            detail: dir,
          };
        });

  // A new query starts the highlight at the top.
  useEffect(() => setMenuActive(0), [trigger?.kind, trigger?.query]);
  // Leaving the token re-arms Esc for the next one.
  useEffect(() => {
    if (!trigger) setDismissedAt(null);
  }, [trigger]);

  /** Puts text + caret into the textarea after a menu pick. */
  const applyText = (next: { text: string; caret: number }) => {
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      autoGrow();
    });
  };

  /** Runs a `/` action; true when `name` was one. */
  const runAction = (name: string): boolean => {
    switch (name) {
      case "new":
        onCommand?.("new");
        return true;
      case "model":
        setModelSignal((n) => n + 1);
        return true;
      case "fast":
        pickEffort("low");
        return true;
      case "balanced":
        pickEffort("medium");
        return true;
      case "think":
        pickEffort("high");
        return true;
      case "skills":
      case "mcp":
        onCommand?.(name);
        return true;
      case "compact":
        void Promise.resolve(onCommand?.("compact")).then((msg) => setNotice(msg || null));
        return true;
    }
    return false;
  };

  const pickMenu = (index: number) => {
    if (!trigger) return;
    if (trigger.kind === "slash") {
      const d = slashDefs[index];
      if (!d) return;
      if (d.kind === "action") {
        applyText(replaceToken(text, trigger, ""));
        runAction(d.name);
        return;
      }
      applyText(replaceToken(text, trigger, `/${d.name} `));
      return;
    }
    const p = mentionPaths[index];
    if (!p) return;
    if (p === "@git") return applyText(replaceToken(text, trigger, "@git "));
    // A folder opens: the menu lists its children next. Space attaches it.
    applyText(replaceToken(text, trigger, mentionText(p, p.endsWith("/"))));
  };

  const onMenuKey = (e: React.KeyboardEvent): boolean => {
    if (!menuOpen || !trigger) return false;
    const n = menuItems.length;
    if (e.key === "Escape") {
      setDismissedAt(trigger.start);
      return true;
    }
    if (n === 0) return false;
    if (e.key === "ArrowDown") {
      setMenuActive((i) => (i + 1) % n);
      return true;
    }
    if (e.key === "ArrowUp") {
      setMenuActive((i) => (i - 1 + n) % n);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      pickMenu(Math.min(menuActive, n - 1));
      return true;
    }
    return false;
  };

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

  // Dictation: record the mic, transcribe fully on-device (Whisper.cpp in
  // Rust), and append the text to the prompt. No provider involved.
  // No language hint on purpose: whisper auto-detects per utterance, so the
  // user can freely mix Russian, Ukrainian and English in one conversation.
  const speech = useDictation((blob) => db.transcribeAudio(blob));

  /** One-time local voice model download progress (0–100), null when idle. */
  const [modelProgress, setModelProgress] = useState<number | null>(null);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    void db.onSttProgress((p) => {
      setModelProgress(p.done || p.percent >= 100 ? null : p.percent);
    }).then((fn) => {
      dispose = fn;
    });
    return () => dispose?.();
  }, []);

  useEffect(() => {
    speech.setOnResult((text) => {
      setText((prev) => `${prev}${prev && !prev.endsWith(" ") ? " " : ""}${text}`);
      requestAnimationFrame(autoGrow);
    });
  }, []);

  const toggleMic = () => {
    if (speech.listening) speech.stop();
    else speech.start();
  };

  /** Accepts picked or dropped files as attachments. */
  const acceptFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const { attachments: picked, rejected } = await toAttachments(files);
    // API models accept only what their settings allow.
    const added = picked.filter((a) => {
      const allowed = a.kind === "image" ? caps?.vision !== false : caps?.files !== false;
      if (!allowed) rejected.push(`${a.name}: this model does not take ${a.kind === "image" ? "images" : "files"} (Settings → Models)`);
      return allowed;
    });
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

  /** Kind of the selected provider — decides which effort levels exist. */
  const gateway = gateways.find((g) => g.id === gatewayId);
  const providerKind = gateway?.kind;
  /** The selected model's meta — may list the effort levels it has. */
  const modelMeta = gateway?.models.find((m) => m.id === modelId)?.meta;

  /** Hand-set abilities of an API model (images / files); null = automatic. */
  const [caps, setCaps] = useState<db.ModelCapsOverride | null>(null);
  useEffect(() => {
    const rowId = `${gatewayId}:${modelId}`;
    let alive = true;
    const load = () =>
      void (providerKind && db.isApiKind(providerKind) ? db.loadModelCaps(rowId) : Promise.resolve(null)).then(
        (c) => alive && setCaps(c)
      );
    load();
    const off = db.onModelCapsChanged((id) => id === rowId && load());
    return () => {
      alive = false;
      off();
    };
  }, [gatewayId, modelId, providerKind]);

  /** The model takes an effort (not an API model with reasoning off, not a fixed-effort model). */
  const takesEffort =
    modelMeta !== undefined && caps?.reasoning !== false && effortsFor(providerKind, modelMeta).length > 0;

  const pickEffort = (next: Effort) => {
    setEffort(next);
    localStorage.setItem("effort", next);
  };

  const send = () => {
    // A prompt can be just attachments — that is a legitimate request.
    if (!text.trim() && attachments.length === 0) return;
    // "/compact <what to keep>" takes an argument.
    const compactArg = /^\/compact\s+([\s\S]+)$/i.exec(text.trim());
    if (compactArg && attachments.length === 0) {
      void Promise.resolve(onCommand?.("compact", compactArg[1])).then((msg) => setNotice(msg || null));
      setText("");
      requestAnimationFrame(autoGrow);
      return;
    }
    // A bare action command ("/new") runs instead of being sent.
    const bare = /^\/([\w-]+)$/.exec(text.trim());
    if (bare && attachments.length === 0 && runAction(bare[1].toLowerCase())) {
      setText("");
      requestAnimationFrame(autoGrow);
      return;
    }
    // Sending cancels an in-flight recording instead of transcribing it.
    speech.cancel();
    onSend(text.trim(), { gatewayId, modelId, effort: clampEffort(effort, providerKind, modelMeta) }, attachments);
    setText("");
    setAttachments([]);
    setNotice(null);
    requestAnimationFrame(autoGrow);
  };

  return (
    <div className={`flex w-full justify-center ${centered ? "" : "pb-4"}`}>
      <div className="flex w-full max-w-[784px] flex-col">
        {centered && (
          <div className="mb-4 flex justify-center">
            {/* Project settings moved to Settings → Projects; nothing here. */}
            <ProjectPicker projects={projects} project={project} onSelect={onSelectProject} />
          </div>
        )}
        {/* Queued follow-ups: their own small plate above the prompt, one
            line until opened; open, it shows up to 5 and scrolls the rest. */}
        {queued.length > 0 && (
          <div className="prompt-lip mx-3 mb-1.5 flex flex-col rounded-xl">
            <button
              className="flex h-8 items-center gap-2 px-3 text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-main)]"
              onClick={() => setQueueOpen((o) => !o)}
              title={queueOpen ? "Collapse the queue" : "Show the queue"}
            >
              <ListPlus size={13} className="shrink-0" />
              <span className="shrink-0 text-[var(--text-main)]">{queued.length} queued</span>
              <span className="min-w-0 flex-1 truncate text-left text-[var(--text-dim)]">
                {queueOpen ? (busy ? "runs after the current task" : "paused after Stop") : queued[0].text}
              </span>
              <ChevronUp size={13} className={`shrink-0 transition-transform ${queueOpen ? "rotate-180" : ""}`} />
            </button>
            {queueOpen && (
              <ScrollBox className="flex max-h-[164px] flex-col gap-0.5 px-1.5 pb-1.5">
              {queued.map((q, i) => (
                <div key={q.id} className="group flex h-8 shrink-0 items-center gap-2 rounded-lg pl-2 pr-1 transition-colors hover:bg-[var(--hover-bg)]">
                  <span className="w-3 shrink-0 text-right font-mono text-[10.5px] text-[var(--text-dim)]">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-main)]" title={q.text}>
                    {q.text || "(attachments)"}
                  </span>
                  {q.attachments.length > 0 && (
                    <span className="flex shrink-0 items-center gap-0.5 text-[10.5px] text-[var(--text-dim)]">
                      <Paperclip size={10} /> {q.attachments.length}
                    </span>
                  )}
                  <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                    {!busy && (
                      <IconButton
                        label="Send now" size="xs" className="text-[var(--accent)]"
                        onClick={() => onRunQueued?.(q.id)}
                      >
                        <Play size={12} />
                      </IconButton>
                    )}
                    <IconButton
                      label="Edit — moves it back into the prompt box" size="xs"
                      onClick={() => {
                        const item = onTakeQueued?.(q.id);
                        if (!item) return;
                        setText((prev) => (prev.trim() ? `${prev}\n${item.text}` : item.text));
                        setAttachments((prev) => [...prev, ...item.attachments]);
                        requestAnimationFrame(() => {
                          autoGrow();
                          ref.current?.focus();
                        });
                      }}
                    >
                      <Pencil size={11} />
                    </IconButton>
                    <IconButton
                      label="Remove from the queue" size="xs" tone="danger"
                      onClick={() => onTakeQueued?.(q.id)}
                    >
                      <X size={12} />
                    </IconButton>
                  </div>
                </div>
              ))}
              </ScrollBox>
            )}
          </div>
        )}
        {/* The lip: a tray behind the prompt box, with the model + effort */}
        {/* picker along its bottom edge. */}
        <div className="prompt-lip flex w-full flex-col rounded-[18px]">
        {/* Glassmorphism container: the chat-column aurora glows through the blur. */}
        <div
          className={`prompt-glass relative flex w-full flex-col rounded-2xl transition-colors ${
            dragging ? "border-b-[var(--accent)]" : ""
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
          <AnimatePresence>
            {menuOpen && trigger && (
              <ComposerMenu
                key={trigger.kind}
                title={trigger.kind === "slash" ? "Commands" : workspace ? `Files in ${workspace.split(/[\\/]/).filter(Boolean).pop()}` : "Files"}
                items={menuItems}
                active={Math.min(menuActive, Math.max(0, menuItems.length - 1))}
                loading={trigger.kind === "mention" && filesLoading}
                empty={trigger.kind === "slash" ? "No command matches" : "No file or folder matches"}
                onPick={pickMenu}
                onHover={setMenuActive}
              />
            )}
          </AnimatePresence>
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

          {/* Text and Send share one row: the button sits at the bottom right */}
          {/* next to the text instead of adding a strip (a chin) under it. */}
          <div className="flex items-end">
          {/* Textarea keeps the custom overlay bar too (native bar is hidden) */}
          <div className="relative min-w-0 flex-1">
            <textarea
              ref={ref}
              rows={1}
              className="no-native-scrollbar max-h-[200px] min-h-[64px] w-full resize-none border-none bg-transparent py-3.5 pl-4 pr-2 text-[14px] leading-normal text-[var(--text-main)] outline-none placeholder:text-[var(--text-dim)]"
              placeholder={
                busy
                  ? "Agent is working — write a follow-up, it runs when the current task ends…"
                  : "Ask anything…   / for commands and skills   @ for files, folders and git"
              }
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setCaret(e.target.selectionStart ?? e.target.value.length);
                autoGrow();
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onBlur={() => setDismissedAt(trigger?.start ?? null)}
              onFocus={() => setDismissedAt(null)}
              onKeyDown={(e) => {
                if (onMenuKey(e)) {
                  e.preventDefault();
                  return;
                }
                // Enter sends; Alt+Enter adds to the queue (while the agent
                // works any send queues — idle, it just runs).
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onPaste={(e) => void onPaste(e)}
            />
            <Thumb thumb={promptThumb} />
          </div>
            {/* Send / Stop sit in the box; everything else is in the lip. */}
            <div className="group/send relative flex shrink-0 items-center gap-1 pb-2.5 pr-2.5">
              {/* Hover hint: the keys, instead of extra buttons. */}
              <div className="pointer-events-none absolute bottom-[calc(100%+4px)] right-1 z-[210] flex w-max flex-col gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-2.5 py-2 text-[11.5px] text-[var(--text-muted)] opacity-0 shadow-[var(--shadow-popup)] transition-opacity delay-300 group-hover/send:opacity-100">
                {busy && <div className="text-[var(--text-main)]">Stop generation</div>}
                {[
                  ["Enter", busy ? "Add to queue" : "Send"],
                  ["Alt + Enter", "Add to queue"],
                  ["Shift + Enter", "New line"],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-4">
                    <span>{v}</span>
                    <kbd className="rounded border border-[var(--border)] px-1 font-mono text-[10.5px] text-[var(--text-dim)]">{k}</kbd>
                  </div>
                ))}
              </div>
              {busy ? (
                <motion.button
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--diff-del)] text-white transition-opacity hover:opacity-90"
                  onClick={onStop}
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
                >
                  <Send size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
        {/* The lip: attach + mic on the left; context, model and effort on the right. */}
        <div className="prompt-lip-strip flex min-w-0 items-center justify-between gap-2 px-2 py-1">
          <div className="flex shrink-0 items-center gap-0.5">
            {/* Hidden file input driven by the + button */}
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
            <IconButton
              label="Attach files or images (or drag them onto the prompt)"
              onClick={() => fileInput.current?.click()}
            >
              <Plus size={16} strokeWidth={1.6} />
            </IconButton>
            {/* Mic: records audio, then transcribes it fully on-device
                (Whisper.cpp in Rust) — no provider, no network. */}
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
                  : modelProgress !== null
                    ? "Preparing local voice model… " + modelProgress + "%"
                    : speech.transcribing
                      ? "Transcribing on-device…"
                      : speech.listening
                        ? "Stop recording"
                        : "Dictate with microphone (local, offline)"
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
            {/* Dev servers / watchers the agent left running. */}
            <BgTasksChip onOpen={onOpenBgTask} />
          </div>
          <div className="flex min-w-0 items-center gap-0.5">
            <ModelSelector
              gateways={gateways}
              gatewayId={gatewayId}
              modelId={modelId}
              openSignal={modelSignal}
              onSelect={(g, m) => {
                setGatewayId(g);
                setModelId(m);
                // Remember the choice so the next launch restores it.
                onPickModel?.({ gatewayId: g, modelId: m });
              }}
            />
            {/* Levels follow the selected provider and model; hidden when it takes none. */}
            {takesEffort && (
              <EffortChip effort={clampEffort(effort, providerKind, modelMeta)} kind={providerKind} meta={modelMeta} onPick={pickEffort} />
            )}
            {contextMeter}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- History view ---------- */
