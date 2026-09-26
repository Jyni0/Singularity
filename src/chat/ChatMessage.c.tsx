import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Bug, Check, ChevronDown, ChevronRight, Circle, ListChecks, Loader2, Wrench, XCircle } from "lucide-react";
import * as db from "../core/db.r";
import { formatDuration } from "../utils/format.u";
import { Markdown, ToolCall, ThinkBlock } from "./Markdown.c";
import type { Segment } from "./message.i";

export function MessageBody({ text }: { text: string }) {
  const long = text.length > 280 || text.split("\n").length > 6;
  const [open, setOpen] = useState(!long);
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-1" onClick={() => long && setOpen(!open)}>
      <div
        className={`min-w-0 max-w-full whitespace-pre-wrap break-words leading-relaxed text-[var(--text-main)] ${
          open ? "" : "line-clamp-4"
        }`}
      >
        {text}
      </div>
      {long && (
        <span className="flex items-center gap-1 self-start text-[11px] text-[var(--accent)]">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {open ? "Collapse" : "Expand"}
        </span>
      )}
    </div>
  );
}

/* ---------- Collapsible action group ---------- */

/**
 * Consecutive tool calls collapsed into one transparent "Worked for …" row —
 * the transcript reads as prose + a compact action log instead of a wall of
 * cards. Open WHILE streaming (live progress must be visible), auto-collapses
 * when the turn finishes; a click re-opens it to inspect every action.
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
  // Collapse once the turn is over — the answer matters, not the log.
  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);
  // Live elapsed while streaming; the stored duration takes over when done.
  // A turn that STOPPED or ERRORED never gets a stored duration — freeze the
  // live clock at the moment streaming ended so the header still reads
  // "Worked for 41s" instead of a bare "Worked".
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
  return (
    <div className="flex flex-col">
      {/* Transparent header row — same airy treatment as the project rows. */}
      <button
        className="flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 text-[11.5px] text-[var(--text-dim)] transition-colors select-none hover:text-[var(--text-muted)]"
        onClick={() => setOpen(!open)}
        title="Show the tool calls of this turn"
      >
        {streaming && running ? (
          <Loader2 size={12} className="animate-spin text-[var(--accent)]" />
        ) : (
          <Wrench size={12} strokeWidth={1.5} />
        )}
        <span>{label}</span>
        <span className="text-[10px] opacity-70">· {steps.length} action{steps.length === 1 ? "" : "s"}</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-2 border-l border-[var(--border)] pl-3">
          {steps.map((s) => (
            <ToolCall
              key={s.key}
              call={{
                name: s.step.name,
                input: s.step.input,
                result: s.step.result,
                ok: s.step.ok,
                running: !s.step.done,
                onInspect: () => onInspectStep?.(s.step),
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Folds consecutive step segments into groups so the renderer can show one
 * StepGroup per run of tool calls. Text/think/tasks/usage pass through.
 */
function groupSegments(segments: Segment[]): (Segment | { group: Segment[] })[] {
  const out: (Segment | { group: Segment[] })[] = [];
  for (const seg of segments) {
    // The planner's own status card ("Plan — …") is NOT agent work: folding it
    // into "Worked · 1 action" produced the confusing transcript the user
    // complained about. It renders standalone below.
    if (seg.kind === "step" && seg.step.name !== "plan") {
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

export function ChatMessage({
  role,
  text,
  segments,
  streaming,
  durationMs,
  images,
  debugMode,
  onInspectStep,
  onInspectImage,
}: {
  role: "user" | "agent";
  text: string;
  segments?: Segment[];
  /** True while this turn is still being produced — shows a "thinking…" marker. */
  streaming?: boolean;
  /** How long the agent worked on this answer. */
  durationMs?: number;
  /** Photos attached to the message — clickable, open in the side panel. */
  images?: db.StoredImage[];
  /** Debug mode: render the live token HUD (speed / tokens / cache / time). */
  debugMode?: boolean;
  /** Opens this step as its own closeable tab in the side panel. */
  onInspectStep?: (step: db.AgentStepEvent) => void;
  /** Opens this photo as its own closeable tab in the side panel. */
  onInspectImage?: (image: db.StoredImage) => void;
}) {
  if (role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {/* Attached photos render as thumbnails; a click opens the viewer. */}
        {images && images.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
            {images.map((img, i) => (
              <button
                key={i}
                className="overflow-hidden rounded-lg border border-[var(--border)] transition-transform hover:scale-[1.02]"
                onClick={() => onInspectImage?.(img)}
                title={`View ${img.name}`}
              >
                <img
                  src={img.data_url}
                  alt={img.name}
                  className="h-24 w-auto max-w-[180px] object-cover"
                />
              </button>
            ))}
          </div>
        )}
        <div className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2 text-left">
          <MessageBody text={text} />
        </div>
      </div>
    );
  }

  // Segments keep prose and tool calls in the order they happened, so the
  // answer reads as a transcript rather than text with a dump of calls below.
  // Consecutive tool calls fold into ONE transparent "Worked for …" group.
  if (segments && segments.length > 0) {
    const grouped = groupSegments(segments);
    return (
      <div className="flex flex-col gap-2">
        {grouped.map((seg, i) => {
          const isLast = i === grouped.length - 1;
          if ("group" in seg) {
            // Only the group that sits at the tail of a LIVE turn stays open
            // by itself; a finished turn collapses its actions.
            const live = !!streaming && isLast;
            return (
              <StepGroup
                key={`g${i}`}
                streaming={live}
                durationMs={durationMs}
                onInspectStep={onInspectStep}
                steps={seg.group.map((s, j) => ({
                  step: (s as { kind: "step"; step: db.AgentStepEvent }).step,
                  key: `s${i}-${j}`,
                }))}
              />
            );
          }
          if (seg.kind === "tasks") {
            return <TaskList key={"tasks" + i} tasks={seg.tasks} live={!!streaming} />;
          }
          if (seg.kind === "usage") {
            // Debug mode only — the HUD lives inside the transcript so it stays
            // attached to the turn it measured.
            return debugMode ? (
              <UsageHud key={"u" + i} usage={seg.usage} streaming={!!streaming} />
            ) : null;
          }
          if (seg.kind === "think") {
            return seg.text.trim() ? (
              <ThinkBlock
                key={`k${i}`}
                text={seg.text}
                live={!!streaming && isLast}
              />
            ) : null;
          }
          // Standalone step (the planner's card): a normal ToolCall, not a
          // "Worked" group — it is status, not labor.
          if (seg.kind === "step") {
            return (
              <ToolCall
                key={`s${i}`}
                call={{
                  name: seg.step.name,
                  input: seg.step.input,
                  result: seg.step.result,
                  ok: seg.step.ok,
                  running: !!streaming && !seg.step.done,
                  onInspect: () => onInspectStep?.(seg.step),
                }}
              />
            );
          }
          // Plain prose (steps were folded into groups above).
          if (seg.kind === "text") {
            return seg.text.trim() ? <Markdown key={`t${i}`} text={seg.text} /> : null;
          }
          return null;
        })}
        {/* Live run, nothing visibly growing at the tail (a tool spinner or
            freshly streamed prose is its own progress) — show the pulse so
            the screen is never "frozen" while the model thinks. */}
        {streaming && (() => {
          const last = segments[segments.length - 1];
          const tailActive =
            last?.kind === "text"
              ? last.text.trim().length > 0
              : last?.kind === "step"
                ? !last.step.done
                : false;
          return tailActive ? null : <WorkingIndicator label="Working…" />;
        })()}
        {/* Generation time — shown at the END of the finished turn. */}
        <DurationFooter streaming={streaming} durationMs={durationMs} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Model output is markdown: headings, lists, tables and fenced code. */}
      {text.trim() ? (
        <Markdown text={text} />
      ) : streaming ? (
        /* Waiting for the first token — an empty bubble looked like a dead app. */
        <WorkingIndicator label="Thinking…" />
      ) : null}
      {/* Generation time — shown at the END of the finished turn. */}
      <DurationFooter streaming={streaming} durationMs={durationMs} />
    </div>
  );
}

/* ---------- Live activity indicator ---------- */

/**
 * Pulsing "working" line shown while the run is live but nothing is visibly
 * happening — reasoning models can spend a minute before the first token,
 * and an empty bubble looked like a frozen app ("нет прогресса на экране").
 */
function WorkingIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-1 py-0.5 text-[12px] text-[var(--text-dim)]">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent)]" />
      </span>
      <span className="animate-pulse">{label}</span>
    </div>
  );
}

/* ---------- Debug mode: live token HUD ---------- */

/** One metric cell of the debug HUD. */
function HudCell({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="flex items-baseline gap-1" title={title}>
      <span className="text-[9.5px] uppercase tracking-wide text-[var(--text-dim)]">{label}</span>
      <span className="font-mono text-[10.5px] text-[var(--text-muted)]">{value}</span>
    </span>
  );
}

/**
 * Real-time inference statistics of the turn: generation speed (tok/s),
 * token spend (prompt + completion), prompt-cache hit rate and how long the
 * model has been generating. Visible only in Debug mode.
 */
export function UsageHud({ usage, streaming }: { usage: db.RunUsage; streaming?: boolean }) {
  const secs = (usage.elapsed_ms ?? 0) / 1000;
  const tps = secs > 0.5 ? usage.completion_tokens / secs : 0;
  const cacheRate =
    usage.prompt_tokens + usage.cached_tokens > 0
      ? Math.round((usage.cached_tokens / (usage.prompt_tokens + usage.cached_tokens)) * 100)
      : 0;
  const fmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)));
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--border-soft)] bg-[var(--bg-input)] px-2.5 py-1.5">
      <Bug size={11} className="shrink-0 text-[var(--accent)]" />
      <HudCell label="speed" value={tps > 0 ? tps.toFixed(1) + " tok/s" : "—"} title="Completion tokens per second" />
      <HudCell
        label="tokens"
        value={fmt(usage.prompt_tokens) + " in · " + fmt(usage.completion_tokens) + " out"}
        title={"Prompt: " + usage.prompt_tokens + " · Completion: " + usage.completion_tokens}
      />
      <HudCell
        label="cache"
        value={cacheRate + "%"}
        title={"Cached prompt tokens: " + usage.cached_tokens + " of " + (usage.prompt_tokens + usage.cached_tokens)}
      />
      <HudCell
        label="time"
        value={secs > 0 ? secs.toFixed(1) + "s" : "—"}
        title="Wall time of the generation so far"
      />
      {streaming && (
        <span className="flex items-center gap-1 text-[9.5px] uppercase tracking-wide text-[var(--accent)]">
          <Loader2 size={9} className="animate-spin" /> live
        </span>
      )}
    </div>
  );
}

/* ---------- Decomposed-run task list ---------- */

/** Status icon + color per subtask state. */
const TASK_VISUAL: Record<string, { icon: typeof Check; cls: string }> = {
  pending: { icon: Circle, cls: "text-[var(--text-dim)]" },
  running: { icon: Loader2, cls: "text-[var(--accent)] animate-spin" },
  done: { icon: Check, cls: "text-[var(--diff-add)]" },
  error: { icon: XCircle, cls: "text-[var(--diff-del)]" },
};

/**
 * The subtask list of a decomposed run — rendered in place inside the
 * transcript, updated live as tasks move pending → running → done/error.
 */
export function TaskList({ tasks, live }: { tasks: db.TaskState[]; live?: boolean }) {
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "error").length;
  // A run that was stopped/finished can leave tasks stuck at "running" — the
  // spinner must NOT keep animating forever ("при остановке не пропадает
  // анимация"). Frozen turns render "running" as an interrupted outline.
  const visual = (status: string) => {
    if (status === "running" && !live) return { icon: Circle, cls: "text-[var(--text-dim)]" };
    return TASK_VISUAL[status] ?? TASK_VISUAL.pending;
  };
  return (
    <div className="selectable overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-surface)]">
      <div className="flex items-center gap-2 border-b border-[var(--border-soft)] px-3 py-2">
        <ListChecks size={13} className="shrink-0 text-[var(--accent)]" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--text-main)]">
          Task list
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-dim)]">
          {done}/{tasks.length} done{failed > 0 ? " · " + failed + " failed" : ""}
        </span>
      </div>
      <div className="flex flex-col">
        {tasks.map((t) => {
          const vis = visual(t.status);
          const Icon = vis.icon;
          return (
            <div
              key={t.id}
              className="flex items-start gap-2 border-b border-[var(--border-soft)] px-3 py-1.5 last:border-b-0"
            >
              <Icon size={13} className={"mt-0.5 shrink-0 " + vis.cls} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[12px] text-[var(--text-main)]">
                  <span className="mr-1.5 font-mono text-[10.5px] text-[var(--text-dim)]">{t.id}.</span>
                  {t.title}
                </span>
                {t.summary && (
                  <span className="truncate text-[10.5px] text-[var(--text-dim)]" title={t.summary}>
                    {t.summary}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Compact task strip that lives ABOVE the prompt box while a decomposed run
 * is working. Two states, one click apart:
 *  - collapsed: a single row — current task title + live progress counter;
 *  - expanded:  the whole board in a small panel that scrolls past ~5 tasks.
 * The transcript TaskList stays the durable record; this is the always-
 * visible "what is happening right now" indicator the user asked for.
 */
export function TaskChips({ tasks }: { tasks: db.TaskState[] }) {
  const [open, setOpen] = useState(false);
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "error").length;
  const current = tasks.find((t) => t.status === "running");
  if (!tasks.length) return null;
  return (
    <div className="px-6 pb-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg py-1 text-left text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-main)]"
      >
        {current ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-[var(--accent)]" />
        ) : (
          <ListChecks size={12} className="shrink-0 text-[var(--accent)]" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {current ? current.title : done + failed >= tasks.length ? "All tasks finished" : "Tasks"}
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-dim)]">
          {done}/{tasks.length}{failed > 0 ? " · " + failed + " failed" : ""}
        </span>
        <ChevronRight
          size={13}
          className={"shrink-0 transition-transform " + (open ? "rotate-90" : "")}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            {/* Small by design: past ~5 tasks it scrolls instead of pushing
                the prompt box off screen. */}
            <div className="mb-1.5 max-h-[150px] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-surface)]/60 backdrop-blur-sm">
              {tasks.map((t) => {
                const vis = t.status === "running"
                  ? { icon: Loader2, cls: "text-[var(--accent)] animate-spin" }
                  : t.status === "done"
                    ? { icon: Check, cls: "text-[var(--diff-add)]" }
                    : t.status === "error"
                      ? { icon: XCircle, cls: "text-[var(--diff-del)]" }
                      : { icon: Circle, cls: "text-[var(--text-dim)]" };
                const Icon = vis.icon;
                return (
                  <div key={t.id} className="flex items-center gap-2 border-b border-[var(--border-soft)] px-2.5 py-1 last:border-b-0">
                    <Icon size={12} className={"shrink-0 " + vis.cls} />
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-main)]">
                      <span className="mr-1 font-mono text-[10px] text-[var(--text-dim)]">{t.id}.</span>
                      {t.title}
                    </span>
                    {t.summary && (
                      <span className="hidden max-w-[40%] shrink-0 truncate text-[10px] text-[var(--text-dim)] sm:inline" title={t.summary}>
                        {t.summary}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export /**
 * Generation time badge at the bottom-right of a finished agent turn.
 * Hidden while streaming and for turns without a measured duration.
 */
function DurationFooter({
  streaming,
  durationMs,
}: {
  streaming?: boolean;
  durationMs?: number;
}) {
  if (streaming || !durationMs || durationMs <= 0) return null;
  return (
    <div className="flex justify-end">
      <span
        className="rounded-full bg-[var(--hover-bg)] flex flex-row items-center px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-dim)]"
        title="Generation time"
      >
        Ran for {formatDuration(durationMs)} <ArrowUp className="ml-1 size-3" />
      </span>
    </div>
  );
}
