import { useState } from "react";
import { ArrowUp, ChevronDown, ChevronRight } from "lucide-react";
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
