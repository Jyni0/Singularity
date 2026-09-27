/**
 * Gourab — the agent's mascot (a blobatar seeded with "gourab").
 *
 * While a turn is live he sits under it and acts out what the agent is doing:
 * typing with code glyphs flying off when files are written, sweeping a
 * magnifier while reading, hopping next to a blinking prompt while commands
 * run, blowing thought bubbles while the model thinks, sending little helper
 * blobs off when work is delegated, drooping while a failed request is
 * retried. When the turn ends he does a short victory jump and leaves.
 *
 * The face (eyes, blink, breathing, expression morphs) is blobatar's own
 * motion layer; the body acts and props are ours, in gourab.css.
 */
import { useEffect, useRef, useState } from "react";
import { Blobatar } from "@blobatar/react";
import { happy, idle, sad, smug, surprised, thinking, unsure, wink } from "blobatar/expression";
import "blobatar/motion.css";
import "./gourab.css";
import { Search } from "lucide-react";
import { formatDuration } from "../utils/format.u";
import { baseName } from "./FileIcon.c";
import type { Segment } from "./message.i";

const MASCOT_NAME = "gourab";

type Activity =
  | "thinking"
  | "reading"
  | "searching"
  | "coding"
  | "running"
  | "delegating"
  | "writing"
  | "retrying"
  | "done";

const EXPRESSION = {
  thinking,
  reading: idle,
  searching: unsure,
  coding: smug,
  running: surprised,
  delegating: wink,
  writing: happy,
  retrying: sad,
  done: happy,
} satisfies Record<Activity, unknown>;

/** Strips a subagent's "[Helper] " tag and the trailing "(12–40)" range. */
function subject(input: string): string {
  const rest = input.replace(/^\[[^\]]+\] /, "");
  const sp = rest.search(/ [(…]/);
  return (sp >= 0 ? rest.slice(0, sp) : rest).trim();
}

/** What the agent is doing right now, read off the tail of the turn. */
function readActivity(segments: Segment[] | undefined): { activity: Activity; detail: string } {
  const tail = [...(segments ?? [])].reverse().find((s) => s.kind !== "usage");
  if (!tail) return { activity: "thinking", detail: "" };
  if (tail.kind === "think") return { activity: "thinking", detail: "" };
  if (tail.kind === "text") {
    const lastLine = tail.text.trimEnd().split("\n").pop() ?? "";
    if (/retrying in \d+s/.test(lastLine)) return { activity: "retrying", detail: "" };
    return { activity: "writing", detail: "" };
  }
  if (tail.kind === "step") {
    const { name, input, done } = tail.step;
    // A finished tool means the model is deciding what comes next.
    if (done) return { activity: "thinking", detail: "" };
    switch (name) {
      case "read_file":
      case "list_dir":
        return { activity: "reading", detail: baseName(subject(input)) };
      case "grep":
      case "find_files":
      case "web_search":
        return { activity: "searching", detail: subject(input) };
      case "web_fetch":
      case "change_dir":
        return { activity: "reading", detail: "" };
      case "write_file":
      case "edit_file":
      case "apply_patch":
        return { activity: "coding", detail: baseName(subject(input)) };
      case "skill":
        return { activity: "reading", detail: subject(input) };
      case "run_command":
      case "ssh_exec":
      case "background":
        return { activity: "running", detail: "" };
      case "delegate":
        return { activity: "delegating", detail: input.replace(/^\[[^\]]+\] /, "").split(":")[0].trim() };
    }
  }
  return { activity: "thinking", detail: "" };
}

function labelOf(activity: Activity, detail: string): string {
  switch (activity) {
    case "thinking":
      return "AI is thinking";
    case "reading":
      return detail ? `Gourab is reading ${detail}` : "AI is reading";
    case "searching":
      return "AI is digging through the code";
    case "coding":
      return detail ? `AI is typing ${detail}` : "AI is typing";
    case "running":
      return "AI is running a command";
    case "delegating":
      return detail ? `AI is briefing ${detail}` : "AI is briefing a helper";
    case "writing":
      return "AI is explaining";
    case "retrying":
      return "AI hit a bump — trying again";
    case "done":
      return "Done!";
  }
}

const CODE_GLYPHS = ["{ }", "</>", ";", "=>", "()", "[ ]"];

/** The props floating around Gourab for each activity. */
function Props({ activity, detail }: { activity: Activity; detail: string }) {
  switch (activity) {
    case "coding":
      return (
        <>
          {CODE_GLYPHS.map((g, i) => (
            <span key={g} className="gourab-glyph" style={{ animationDelay: `${i * 0.28}s`, left: `${8 + ((i * 37) % 70)}%` }}>
              {g}
            </span>
          ))}
        </>
      );
    case "reading":
    case "searching":
      return (
        <span className={"gourab-lens " + (activity === "searching" ? "gourab-lens-fast" : "")}>
          <Search size={13} strokeWidth={2.5} />
        </span>
      );
    case "running":
      return (
        <span className="gourab-prompt">
          {">"}
          <span className="gourab-caret">_</span>
        </span>
      );
    case "thinking":
      return (
        <>
          {[0, 1, 2].map((i) => (
            <span key={i} className="gourab-bubble" style={{ animationDelay: `${i * 0.35}s`, width: 4 + i * 2, height: 4 + i * 2 }} />
          ))}
        </>
      );
    case "delegating":
      return (
        <span className="gourab-minion">
          <Blobatar name={detail || "helper"} animate="always" expression={happy} size={16} />
        </span>
      );
    case "writing":
      return (
        <>
          {[0, 1, 2].map((i) => (
            <span key={i} className="gourab-talk" style={{ animationDelay: `${i * 0.18}s` }} />
          ))}
        </>
      );
    case "retrying":
      return <span className="gourab-sweat" />;
    case "done":
      return (
        <>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`gourab-spark gourab-spark-${i}`}>
              ✦
            </span>
          ))}
        </>
      );
  }
}

/**
 * Live mascot row under an agent turn. Mounted for the whole turn; when the
 * turn stops streaming it celebrates for a moment and then renders nothing.
 * A turn loaded from history (never streamed here) shows nothing at all.
 */
export function GourabDock({
  streaming,
  segments,
  quietMs,
}: {
  streaming?: boolean;
  segments?: Segment[];
  /** How long the turn has been visually quiet — shown once it is noticeable. */
  quietMs?: number;
}) {
  const wasLive = useRef(!!streaming);
  const [celebrating, setCelebrating] = useState(false);

  useEffect(() => {
    if (streaming) {
      wasLive.current = true;
      setCelebrating(false);
      return;
    }
    if (!wasLive.current) return;
    wasLive.current = false;
    setCelebrating(true);
    const id = setTimeout(() => setCelebrating(false), 2200);
    return () => clearTimeout(id);
  }, [streaming]);

  if (!streaming && !celebrating) return null;

  const { activity, detail } = streaming ? readActivity(segments) : { activity: "done" as const, detail: "" };
  const label = labelOf(activity, detail);
  const showTimer = streaming && quietMs !== undefined && quietMs >= 2000;

  return (
    <div className="flex items-center gap-2.5 px-1 py-1" aria-live="polite">
      <div className={`gourab gourab-${activity}`} title="Gourab">
        <div className="gourab-body">
          <Blobatar name={MASCOT_NAME} animate="always" expression={EXPRESSION[activity]} size={34} title="Gourab" />
        </div>
        <Props activity={activity} detail={detail} />
      </div>
      <span className={"text-[12px] " + (activity === "done" ? "text-[var(--accent)]" : "text-[var(--text-dim)]")}>
        <span className={streaming ? "gourab-label" : ""}>{label}</span>
        {showTimer && <span className="ml-1.5 font-mono text-[10.5px]">{formatDuration(quietMs!)}</span>}
      </span>
    </div>
  );
}
