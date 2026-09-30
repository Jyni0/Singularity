import { Fragment, useEffect, useRef, useState, memo } from "react";
import { ArrowUp, Bug, Check, ChevronDown, ChevronRight, Copy, Image as ImageIcon, Pencil, Wrench } from "lucide-react";
import * as db from "../core/db.r";
import { formatDuration } from "../utils/format.u";
import { Markdown, ToolCall, ThinkBlock } from "./Markdown.c";
import { GourabDock } from "./Gourab.c";
import type { Segment } from "./message.i";
import { GeneratedImage } from "./GeneratedImage.c";
import { FileIcon, Button, Spinner, IconButton } from "../components";

/*
 * Transcript rows, Antigravity-style: nothing sits in a boxed bubble. Prose,
 * prompts and tool rows are flat on the page; a soft background appears only
 * under the row the pointer is on, together with that row's actions.
 */

function MessageBody({ text }: { text: string }) {
  const long = text.length > 600 || text.split("\n").length > 12;
  const [open, setOpen] = useState(!long);
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-1">
      <div
        className={`min-w-0 max-w-full whitespace-pre-wrap break-words text-[14px] leading-relaxed text-[var(--text-main)] ${
          open ? "" : "line-clamp-6"
        }`}
      >
        {text}
      </div>
      {long && (
        <button
          className="flex items-center gap-1 self-start text-[11px] text-[var(--text-muted)]"
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {open ? "Collapse" : "Expand"}
        </button>
      )}
    </div>
  );
}

/* ---------- Hover actions ---------- */

function ActionButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <IconButton
      label={title} size="xs"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </IconButton>
  );
}

/** Copies `text`; the icon turns into a check for a moment. */
function CopyButton({ text, title = "Copy" }: { text: string; title?: string }) {
  const [done, setDone] = useState(false);
  return (
    <ActionButton
      title={done ? "Copied" : title}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <Check size={13} className="text-[var(--diff-add)]" /> : <Copy size={13} />}
    </ActionButton>
  );
}

/** Inline editor of a sent prompt: Enter resends, Esc cancels. */
function EditBox({ initial, onCancel, onSave }: { initial: string; onCancel: () => void; onSave: (text: string) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, []);
  const save = () => value.trim() && onSave(value.trim());
  return (
    <div className="flex flex-col gap-2">
      <textarea
        ref={ref}
        className="min-h-[60px] w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2 text-[14px] leading-relaxed text-[var(--text-main)] outline-none focus:border-[var(--accent)]/60"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 320)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-[var(--text-dim)]">
          Resending replaces everything after this prompt
        </span>
        <Button
          variant="secondary" size="sm"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          variant="primary" size="sm"
          onClick={save}
          disabled={!value.trim()}
        >
          Send
        </Button>
      </div>
    </div>
  );
}

/* ---------- Collapsible action group ---------- */

/** Distinct files a group of steps touched, in first-touch order. */
function touchedFiles(steps: db.AgentStepEvent[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    const p = s.path ?? (["read_file", "apply_patch", "write_file", "edit_file"].includes(s.name)
      ? s.input.replace(/^\[[^\]]+\] /, "").split(/ [(…]/)[0].trim()
      : "");
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Consecutive tool calls folded into one flat "Worked for …" row with the
 * language badges of the files involved. Open while streaming, collapsed
 * when the turn finishes; a click re-opens the action log.
 */
function StepGroup({
  steps,
  streaming,
  durationMs,
  onInspectStep,
}: {
  steps: { step: db.AgentStepEvent; key: string }[];
  streaming?: boolean;
  durationMs?: number;
  onInspectStep?: (step: db.AgentStepEvent) => void;
}) {
  const [open, setOpen] = useState(!!streaming);
  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);
  // Live elapsed while streaming; frozen when a stopped turn has no duration.
  const startRef = useRef(Date.now());
  const endRef = useRef<number | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (streaming) {
      endRef.current = null;
      const id = setInterval(() => tick((n) => n + 1), 1000);
      return () => clearInterval(id);
    }
    if (endRef.current === null) endRef.current = Date.now();
  }, [streaming]);
  const elapsed = streaming
    ? Date.now() - startRef.current
    : (durationMs ?? (endRef.current !== null ? endRef.current - startRef.current : 0));
  const label = elapsed && elapsed > 0 ? "Worked for " + formatDuration(elapsed) : "Worked";
  const running = steps.some((s) => !s.step.done);
  const files = touchedFiles(steps.map((s) => s.step));
  return (
    <div className="flex flex-col">
      <button
        className="flex w-fit items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-[12px] text-[var(--text-dim)] transition-colors select-none hover:bg-[var(--hover-bg)] hover:text-[var(--text-muted)]"
        onClick={() => setOpen(!open)}
        title="Show the actions of this turn"
      >
        {streaming && running ? (
          <Spinner size={12} className="text-[var(--accent)]" />
        ) : (
          <Wrench size={12} strokeWidth={1.5} />
        )}
        <span>{label}</span>
        <span className="text-[11px] opacity-70">
          · {steps.length} action{steps.length === 1 ? "" : "s"}
        </span>
        {files.length > 0 && (
          <span className="ml-0.5 flex items-center gap-0.5">
            {files.slice(0, 5).map((f) => (
              <FileIcon key={f} path={f} size={12} />
            ))}
            {files.length > 5 && <span className="text-[10px]">+{files.length - 5}</span>}
          </span>
        )}
        <ChevronRight size={12} className={`transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="ml-2 mt-0.5 flex flex-col border-l border-[var(--border-soft)] pl-2">
          {steps.map((s) => (
            <Fragment key={s.key}>
            <ToolCall
              call={{
                name: s.step.name,
                input: s.step.input,
                result: s.step.result,
                ok: s.step.ok,
                // Only a LIVE turn may show a spinner.
                running: !!streaming && !s.step.done,
                onInspect: () => onInspectStep?.(s.step),
              }}
            />
            {streaming && !s.step.done && s.step.new_text !== undefined && (
              <LiveEdit before={s.step.old_text ?? ""} after={s.step.new_text} />
            )}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/** Lines of a live edit shown under its row. */
const LIVE_EDIT_LINES = 12;

/**
 * The part of a file an edit is writing right now, while the model is still
 * streaming it: the lines between what stays the same at the start and at
 * the end, newest at the bottom. Linear time — it re-renders many times a
 * second, so no full diff here (the side panel has that).
 */
function LiveEdit({ before, after }: { before: string; after: string }) {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  const lineStart = after.lastIndexOf("\n", start - 1) + 1;
  const lines = after.slice(lineStart, after.length - end).split("\n");
  const shown = lines.slice(-LIVE_EDIT_LINES);
  if (!shown.some((l) => l.trim())) return null;
  return (
    <div className="my-0.5 ml-5 overflow-hidden rounded-md border border-[var(--border-soft)] bg-[var(--bg-app)] font-mono text-[11px] leading-[1.5]">
      {lines.length > shown.length && (
        <div className="px-2 text-[var(--text-dim)]">⋯ {lines.length - shown.length} more lines</div>
      )}
      {shown.map((l, i) => (
        <div key={i} className="diff-line--add truncate whitespace-pre px-2">
          {l || " "}
        </div>
      ))}
    </div>
  );
}

/** Folds consecutive step segments into groups (one StepGroup each). */
function groupSegments(segments: Segment[]): (Segment | { group: Segment[] })[] {
  const out: (Segment | { group: Segment[] })[] = [];
  for (const seg of segments) {
    if (seg.kind === "step") {
      const tail = out[out.length - 1];
      if (tail && "group" in tail) tail.group.push(seg);
      else out.push({ group: [seg] });
    } else {
      out.push(seg);
    }
  }
  return out;
}

/* ---------- Unified chat message row ---------- */

/**
 * When the live turn last visibly changed. Kept outside the component:
 * switching to another mode/view unmounts the chat, and a ref reset the
 * "AI is thinking" timer to 0 on the way back although the model had been
 * quiet all along. One record, not a map by content: every new turn starts
 * from the same empty-content signature, so a map handed the new prompt the
 * previous prompt's start time and the timer kept adding up.
 */
let LIVE_CHANGE = { signature: NaN, at: 0 };

function changedAt(signature: number, streaming: boolean): number {
  if (!streaming) return Date.now();
  if (LIVE_CHANGE.signature !== signature) LIVE_CHANGE = { signature, at: Date.now() };
  return LIVE_CHANGE.at;
}

function ChatMessageView({
  role,
  text,
  segments,
  streaming,
  durationMs,
  images,
  error,
  debugMode,
  onEdit,
  onInspectStep,
  onInspectImage,
}: {
  role: "user" | "agent" | "compact";
  text: string;
  segments?: Segment[];
  /** True while this turn is still being produced. */
  streaming?: boolean;
  /** How long the agent worked on this answer. */
  durationMs?: number;
  /** Photos attached to the message — clickable, open in the side panel. */
  images?: db.StoredImage[];
  /** Why the turn failed — red text under what it produced. */
  error?: string;
  /** Debug mode: render the live token HUD. */
  debugMode?: boolean;
  /** User prompts only: rewrite this prompt and run it again. */
  onEdit?: (text: string) => void;
  /** Opens this step as its own closeable tab in the side panel. */
  onInspectStep?: (step: db.AgentStepEvent) => void;
  /** Opens this photo as its own closeable tab in the side panel. */
  onInspectImage?: (image: db.StoredImage) => void;
}) {
  const [editing, setEditing] = useState(false);
  // When did this turn last visibly change? Drives the "Working…" pulse.
  const signature =
    (segments?.length ?? 0) * 1_000_003 +
    (text?.length ?? 0) +
    (segments?.reduce((n, s) => {
      if (s.kind === "text" || s.kind === "think") return n + s.text.length;
      if (s.kind === "step") return n + (s.step.result?.length ?? 0) * 7 + (s.step.input.length) * 3 + (s.step.done ? 1 : 0) * 13;
      if (s.kind === "usage") return n + (s.usage.completion_tokens ?? 0) * 3;
      if (s.kind === "retry") return n + s.attempt * 17;
      return n;
    }, 0) ?? 0);
  const lastChange = { current: changedAt(signature, !!streaming) };

  if (role === "user") {
    return (
      <div className="bg-[var(--hover-bg)] group relative -mx-3 flex flex-col gap-1.5 rounded-2xl px-3 py-2 transition-colors">
        {images && images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => (
              <button
                key={i}
                className="overflow-hidden rounded-xl border border-[var(--border)] transition-transform hover:scale-[1.02]"
                onClick={() => onInspectImage?.(img)}
                title={`View ${img.name}`}
              >
                <img src={img.data_url} alt={img.name} className="h-20 w-auto max-w-[180px] object-cover" />
              </button>
            ))}
          </div>
        )}
        {editing && onEdit ? (
          <EditBox
            initial={text}
            onCancel={() => setEditing(false)}
            onSave={(next) => {
              setEditing(false);
              onEdit(next);
            }}
          />
        ) : (
          <>
            <MessageBody text={text} />
            <div className="absolute right-2 bottom-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <CopyButton text={text} title="Copy prompt" />
              {onEdit && (
                <ActionButton title="Edit and resend" onClick={() => setEditing(true)}>
                  <Pencil size={13} />
                </ActionButton>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  const answerText = text.trim();
  const actions = !streaming && answerText && (
    <div className="flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
      <CopyButton text={answerText} title="Copy answer" />
    </div>
  );

  // Segments keep prose and tool calls in the order they happened.
  if (segments && segments.length > 0) {
    const grouped = groupSegments(segments);
    const usage = segments.find((s): s is Extract<Segment, { kind: "usage" }> => s.kind === "usage");
    return (
      <div className="group -mx-3 flex flex-col gap-1.5 rounded-2xl px-3 py-2 transition-colors hover:bg-[var(--hover-bg)]/40">
        {grouped.map((seg, i) => {
          const isLast = i === grouped.length - 1;
          if ("group" in seg) {
            const steps = seg.group.map((s) => (s as { kind: "step"; step: db.AgentStepEvent }).step);
            // Pictures stay visible under the (collapsible) action log.
            const drawing = steps.filter((s) => s.name === "generate_image" && (s.image || (!s.done && streaming)));
            return (
              <Fragment key={`g${i}`}>
                <StepGroup
                  streaming={!!streaming && isLast}
                  durationMs={durationMs}
                  onInspectStep={onInspectStep}
                  steps={steps.map((step, j) => ({ step, key: `s${i}-${j}` }))}
                />
                {drawing.map((s) =>
                  s.image ? (
                    <GeneratedImage key={`img${s.index}`} path={s.image} prompt={s.input} onOpen={onInspectImage} />
                  ) : (
                    <div
                      key={`img${s.index}`}
                      className="flex h-48 w-72 animate-pulse items-center justify-center gap-2 rounded-2xl bg-[var(--bg-input)] text-[12px] text-[var(--text-dim)]"
                    >
                      <ImageIcon size={14} /> Drawing…
                    </div>
                  ),
                )}
              </Fragment>
            );
          }
          // Debug stats are pinned to the very bottom of the turn instead.
          if (seg.kind === "usage") return null;
          if (seg.kind === "think") {
            return seg.text.trim() ? <ThinkBlock key={`k${i}`} text={seg.text} live={!!streaming && isLast} /> : null;
          }
          if (seg.kind === "text") {
            return seg.text.trim() ? <Markdown key={`t${i}`} text={seg.text} /> : null;
          }
          if (seg.kind === "retry") return <RetryNotice key={`r${i}`} retry={seg} />;
          return null;
        })}
        {error && <ErrorText text={error} />}
        <LiveTail streaming={streaming} lastChange={lastChange} segments={segments} />
        <div className="flex items-center justify-between">
          {actions || <span />}
          <DurationFooter streaming={streaming} durationMs={durationMs} />
        </div>
        {debugMode && usage && <UsageHud usage={usage.usage} streaming={!!streaming} />}
      </div>
    );
  }

  return (
    <div className="group -mx-3 flex flex-col gap-1.5 rounded-2xl px-3 py-2 transition-colors hover:bg-[var(--hover-bg)]/40">
      {answerText && <Markdown text={text} />}
      {error && <ErrorText text={error} />}
      <LiveTail streaming={streaming} lastChange={lastChange} />
      <div className="flex items-center justify-between">
        {actions || <span />}
        <DurationFooter streaming={streaming} durationMs={durationMs} />
      </div>
    </div>
  );
}

/** Why a turn failed: plain red text, nothing more. */
function ErrorText({ text }: { text: string }) {
  return <div className="select-text whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--diff-del)]">{text}</div>;
}

/** A failed request being retried: one line whose counter moves. */
function RetryNotice({ retry }: { retry: { message: string; attempt: number; max: number } }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-[12.5px]" title={retry.message}>
      <span className="shrink-0 text-[var(--text-muted)]">
        Retrying {retry.attempt}/{retry.max}
      </span>
      <span className="min-w-0 truncate text-[var(--diff-del)]">{retry.message}</span>
    </div>
  );
}

/**
 * Live "the model is doing something" row: Gourab acting out the current
 * activity, with a ticking figure once the turn has been quiet for 2s.
 */
function LiveTail({
  streaming,
  lastChange,
  segments,
}: {
  streaming?: boolean;
  lastChange: { current: number };
  segments?: Segment[];
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!streaming) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [streaming]);
  return <GourabDock streaming={streaming} segments={segments} quietMs={Date.now() - lastChange.current} />;
}

/* ---------- Debug mode: live token HUD ---------- */

function HudCell({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="flex items-baseline gap-1" title={title}>
      <span className="text-[9.5px] uppercase tracking-wide text-[var(--text-dim)]">{label}</span>
      <span className="font-mono text-[10.5px] text-[var(--text-muted)]">{value}</span>
    </span>
  );
}

/** Real-time inference statistics of the turn (Debug mode only). */
function UsageHud({ usage, streaming }: { usage: db.RunUsage; streaming?: boolean }) {
  const secs = (usage.elapsed_ms ?? 0) / 1000;
  const tps = secs > 0.5 ? usage.completion_tokens / secs : 0;
  // prompt_tokens is the whole prompt, cache reads included (older Anthropic
  // runs stored them apart — then cached can exceed prompt).
  const promptAll = Math.max(usage.prompt_tokens, usage.cached_tokens);
  const cacheRate = promptAll > 0 ? Math.round((usage.cached_tokens / promptAll) * 100) : 0;
  const fmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)));
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1.5 py-1">
      <Bug size={11} className="shrink-0 text-[var(--accent)]" />
      <HudCell label="speed" value={tps > 0 ? tps.toFixed(1) + " tok/s" : "—"} title="Completion tokens per second" />
      <HudCell
        label="tokens"
        value={fmt(usage.prompt_tokens) + " in · " + fmt(usage.completion_tokens) + " out"}
        title={"Prompt: " + usage.prompt_tokens + " · Completion: " + usage.completion_tokens}
      />
      <HudCell
        label="cache"
        value={promptAll > 0 ? cacheRate + "%" : "—"}
        title={"Cached prompt tokens: " + usage.cached_tokens + " of " + promptAll}
      />
      <HudCell
        label="time"
        value={secs > 0 ? formatDuration(secs * 1000) : "—"}
        title={secs > 0 ? `Wall time of the generation so far: ${secs.toFixed(1)} s` : "Wall time of the generation so far"}
      />
      {streaming && (
        <span className="flex items-center gap-1 text-[9.5px] uppercase tracking-wide text-[var(--accent)]">
          <Spinner size={9} /> live
        </span>
      )}
    </div>
  );
}

/** Generation time at the end of a finished agent turn. */
function DurationFooter({ streaming, durationMs }: { streaming?: boolean; durationMs?: number }) {
  if (streaming || !durationMs || durationMs <= 0) return null;
  return (
    <span
      className="flex items-center font-mono text-[10.5px] text-[var(--text-dim)]"
      title="Generation time"
    >
      Ran for {formatDuration(durationMs)} <ArrowUp className="ml-1 size-3" />
    </span>
  );
}

type ChatMessageProps = Parameters<typeof ChatMessageView>[0];

/**
 * Memoized: while an agent streams, only its live turn changes — finished
 * messages (and their Markdown) must not re-render on every token. Callback
 * props are recreated by the parent each render but never change meaning
 * for a mounted message (the list remounts per conversation), so only
 * whether they exist is compared.
 */
export const ChatMessage = memo(ChatMessageView, (a: ChatMessageProps, b: ChatMessageProps) =>
  a.role === b.role &&
  a.text === b.text &&
  a.segments === b.segments &&
  a.streaming === b.streaming &&
  a.durationMs === b.durationMs &&
  a.images === b.images &&
  a.error === b.error &&
  a.debugMode === b.debugMode &&
  !!a.onEdit === !!b.onEdit
);
