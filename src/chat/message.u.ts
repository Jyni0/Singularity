/**
 * Small pure helpers shared by the chat surface and the inspection panel.
 */
import * as db from "../core/db.r";
import type { Msg, Segment } from "./message.i";

/** Collects every tool step from a conversation's messages, in order. */
export function collectSteps(msgs: Msg[]): db.AgentStepEvent[] {
  const out: db.AgentStepEvent[] = [];
  for (const m of msgs) {
    for (const s of m.segments ?? []) {
      if (s.kind === "step") out.push(s.step);
    }
  }
  return out;
}

/** Turns a stored row back into a renderable message (duration + photos + steps). */
export function storedToMsg(m: db.StoredMessage): Msg {
  let images: db.StoredImage[] | undefined;
  if (m.images && m.images !== "[]") {
    try {
      const parsed = JSON.parse(m.images);
      if (Array.isArray(parsed) && parsed.length) images = parsed as db.StoredImage[];
    } catch {
      /* stored before images existed — ignore */
    }
  }
  // Segments (migration 9) carry the tool steps and think blocks, so a
  // restored turn renders exactly like the live one — cards, outputs and
  // panel tabs included. Unmarked in-flight steps are re-flagged as done:
  // nothing is running anymore once the row was stored.
  let segments: Segment[] | undefined;
  if (m.segments && m.segments !== "[]") {
    try {
      const parsed = JSON.parse(m.segments);
      if (Array.isArray(parsed) && parsed.length) {
        segments = (parsed as Segment[]).map((s) =>
          s.kind === "step" && !s.step.done ? { kind: "step", step: { ...s.step, done: true } } : s
        );
      }
    } catch {
      /* stored before segments existed — fall back to plain text */
    }
  }
  return {
    role: m.role,
    text: m.text,
    durationMs: m.duration_ms ?? undefined,
    images,
    segments,
  };
}

/** Basename of a path — panel tabs label files by name, not by full path. */
export function fileLabel(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * Short label for a tool step's tab title: the tool verb ("Edit", "Run",
 * "Search"…), matching the chat card's wording.
 */
export function toolLabel(step: db.AgentStepEvent): string {
  const verb: Record<string, string> = {
    read_file: "Read",
    write_file: "Write",
    edit_file: "Edit",
    list_dir: "List",
    grep: "Search",
    run_command: "Run",
  };
  return verb[step.name] ?? step.name;
}
