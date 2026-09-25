/**
 * Shared shapes of the chat surface: message segments and the inspection
 * panel's tab model. Kept apart from the components so the App, the message
 * renderer and the panel all speak the same types.
 */
import type * as db from "../core/db.r";

/** One piece of an agent turn: reasoning, prose, a tool call, or the
 *  decomposed run's task list (titles + live statuses). */
export type Segment =
  | { kind: "think"; text: string }
  | { kind: "text"; text: string }
  | { kind: "step"; step: db.AgentStepEvent }
  | { kind: "tasks"; tasks: db.TaskState[] };

export interface Msg {
  role: "user" | "agent";
  /** Full text of the turn — what gets stored and sent back as history. */
  text: string;
  /** Interleaved prose and tool calls, newest last. Live turns only. */
  segments?: Segment[];
  /** How long the agent spent producing this turn, in milliseconds. */
  durationMs?: number;
  /** Images attached to this message, rendered as clickable previews. */
  images?: db.StoredImage[];
}

/**
 * One open tab of the inspection panel. Opening anything in the chat (a file
 * change, a command, another tool call, a photo) adds a tab; every tab can be
 * closed on its own, exactly like editor tabs.
 *
 * The `file` variant resolves its diff from the conversation's steps by path,
 * `command` and `tool` resolve their step by index, `image` carries its payload.
 */
export type PanelTabSpec =
  | { id: string; type: "file"; label: string; path: string }
  | { id: string; type: "command"; label: string; stepIndex: number }
  | { id: string; type: "tool"; label: string; stepIndex: number }
  | { id: string; type: "image"; label: string; image: db.StoredImage };

/** The panel while it is open: its tab list plus the active tab id. */
export interface PanelOpen {
  kind: "panel";
  tabs: PanelTabSpec[];
  activeId: string;
}

/** Right inspection panel state — closed, or open with its tabs. */
export type PanelState = { kind: "none" } | PanelOpen;
