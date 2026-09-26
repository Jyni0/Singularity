import { useState } from "react";
import { ArrowUp, Bug, Check, ChevronDown, ChevronRight, Circle, ListChecks, Loader2, XCircle } from "lucide-react";
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
  if (segments && segments.length > 0) {
    return (
      <div className="flex flex-col gap-2">
        {segments.map((seg, i) => {
          const isLast = i === segments.length - 1;
          if (seg.kind === "step") {
            const st = seg.step;
            // Every step opens as its own closeable tab in the side panel —
            // the card itself never expands anymore.
            return (
              <ToolCall
                key={`s${st.index}-${i}`}
                call={{
                  name: st.name,
                  input: st.input,
                  result: st.result,
                  ok: st.ok,
                  running: !st.done,
                  onInspect: () => onInspectStep?.(st),
                }}
              />
            );
          }
          if (seg.kind === "tasks") {
            return <TaskList key={"tasks" + i} tasks={seg.tasks} />;
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
          return seg.text.trim() ? <Markdown key={`t${i}`} text={seg.text} /> : null;
        })}
        {/* Generation time — shown at the END of the finished turn. */}
        <DurationFooter streaming={streaming} durationMs={durationMs} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Model output is markdown: headings, lists, tables and fenced code. */}
      <Markdown text={text} />
      {/* Generation time — shown at the END of the finished turn. */}
      <DurationFooter streaming={streaming} durationMs={durationMs} />
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
export function TaskList({ tasks }: { tasks: db.TaskState[] }) {
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "error").length;
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
          const vis = TASK_VISUAL[t.status] ?? TASK_VISUAL.pending;
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
