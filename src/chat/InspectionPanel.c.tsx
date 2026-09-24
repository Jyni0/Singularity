/**
 * Right-hand inspection panel: closeable tabs, like an editor.
 *
 * Everything the user opens from the chat (a file diff, a command output, any
 * other tool call, a photo) becomes its OWN tab with an x to close it - there
 * are no list/overview screens anymore. The panel itself is drag-resizable
 * from its left edge; the width is owned (and persisted) by the App.
 */
import { FileDiff, Terminal, Wrench, X, Image as ImageIcon } from "lucide-react";
import { motion } from "motion/react";
import type { Msg, PanelOpen, PanelTabSpec } from "./message.i";
import { collectSteps } from "./message.u";
import { computeDiff } from "../utils/diff.u";
import type * as db from "../core/db.r";

/** Renders a file's diff, reused by the file tab. */
export function FileDiffBody({ step }: { step: db.AgentStepEvent }) {
  const lines = computeDiff(step.old_text ?? "", step.new_text ?? "");
  return (
    <div className="overflow-auto bg-[var(--bg-app)] font-mono text-[11px] leading-[1.55]">
      {lines.map((l, i) => (
        <div
          key={i}
          className={`flex whitespace-pre-wrap break-all px-1.5 ${
            l.kind === "add"
              ? "diff-line--add"
              : l.kind === "del"
                ? "diff-line--del"
                : l.kind === "hunk"
                  ? "bg-[var(--bg-surface)] py-0.5 text-[var(--text-dim)]"
                  : "text-[var(--text-muted)]"
          }`}
        >
          <span className="w-4 shrink-0 select-none text-center text-[var(--text-dim)]">
            {l.kind === "add" ? "+" : l.kind === "del" ? "\u2212" : l.kind === "hunk" ? "\u22ef" : ""}
          </span>
          <span className="w-8 shrink-0 select-none text-right text-[var(--text-dim)]">
            {l.kind === "add"
              ? l.newNo
              : l.kind === "del"
                ? l.oldNo
                : l.kind === "ctx"
                  ? l.newNo
                  : ""}
          </span>
          <span className="ml-1.5 min-w-0">{l.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

/** Small icon button used in the panel header. */
const ICON_BTN =
  "shrink-0 rounded-md p-1 text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";

/** Icon per tab type. */
function tabIcon(t: PanelTabSpec) {
  if (t.type === "file") return <FileDiff size={12} strokeWidth={1.8} />;
  if (t.type === "command") return <Terminal size={12} strokeWidth={1.8} />;
  if (t.type === "image") return <ImageIcon size={12} strokeWidth={1.8} />;
  return <Wrench size={12} strokeWidth={1.8} />;
}

function TabBody({ tab, msgs }: { tab: PanelTabSpec; msgs: Msg[] }) {
  // Steps of THIS conversation resolve file/command/tool tabs by identity.
  const steps = collectSteps(msgs);

  if (tab.type === "image") {
    return (
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-3">
        <img
          src={tab.image.data_url}
          alt={tab.image.name}
          className="max-w-full rounded-lg border border-[var(--border)] object-contain"
        />
      </div>
    );
  }

  if (tab.type === "file") {
    // Latest change of the file wins - the tab shows the net result.
    let step: db.AgentStepEvent | undefined;
    for (const s of steps) {
      if (s.path === tab.path && s.done && s.ok && s.new_text !== undefined) step = s;
    }
    if (!step) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-[12px] text-[var(--text-dim)]">
          This file has no recorded change in this conversation.
        </div>
      );
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border)] bg-[var(--bg-surface)] px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-main)]" title={step.path}>
            {step.path}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <FileDiffBody step={step} />
        </div>
      </div>
    );
  }

  // command / tool - both resolve a single step by its index.
  const step = steps.find((s) => s.index === tab.stepIndex);
  if (!step) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-[12px] text-[var(--text-dim)]">
        This step is no longer part of the conversation.
      </div>
    );
  }

  if (tab.type === "command") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <code className="block shrink-0 truncate border-b border-[var(--border)] bg-[var(--bg-surface)] px-3 py-1.5 font-mono text-[11px] text-[var(--text-main)]" title={step.input}>
          {step.input}
        </code>
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-[var(--bg-app)] px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--text-muted)]">
          {step.done ? step.result : "running\u2026"}
        </pre>
      </div>
    );
  }

  // Generic tool output: read/list/grep etc. - the full result, verbatim.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <code className="block shrink-0 truncate border-b border-[var(--border)] bg-[var(--bg-surface)] px-3 py-1.5 font-mono text-[11px] text-[var(--text-main)]" title={step.input}>
        {step.name}: {step.input}
      </code>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-[var(--bg-app)] px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--text-muted)]">
        {step.done ? step.result : "running\u2026"}
      </pre>
    </div>
  );
}

export function InspectionPanel({
  panel,
  msgs,
  width,
  onResizeStart,
  onSelect,
  onCloseTab,
  onCloseAll,
}: {
  panel: PanelOpen;
  msgs: Msg[];
  /** Current panel width in px - dragged by the handle on its left edge. */
  width: number;
  /** Starts a drag-resize of the panel's left edge. */
  onResizeStart: (e: React.MouseEvent) => void;
  /** Makes another open tab the visible one. */
  onSelect: (id: string) => void;
  /** Closes one tab; the App falls back to a neighbor or closes the panel. */
  onCloseTab: (id: string) => void;
  /** Closes every tab (the x at the far right of the tab strip). */
  onCloseAll: () => void;
}) {
  const active = panel.tabs.find((t) => t.id === panel.activeId) ?? panel.tabs[0];

  return (
    <motion.aside
      className="selectable relative flex h-full shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg-app)]"
      style={{ width }}
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      {/* Drag handle on the left edge - resizes the panel. */}
      <div className="panel-resizer" onMouseDown={onResizeStart} />

      {/* Closeable tabs across the top - one per opened item. */}
      <div className="no-native-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border)] px-2 py-1.5">
        {panel.tabs.map((t) => {
          const isActive = active?.id === t.id;
          return (
            <div
              key={t.id}
              className={`group flex h-7 max-w-[170px] shrink-0 items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors ${
                isActive
                  ? "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-main)]"
                  : "border-transparent text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
              }`}
            >
              <button
                className="flex min-w-0 items-center gap-1.5"
                onClick={() => onSelect(t.id)}
                title={t.label}
              >
                <span className="shrink-0 text-[var(--text-dim)]">{tabIcon(t)}</span>
                <span className="truncate">{t.label}</span>
              </button>
              <button
                className={`shrink-0 rounded p-0.5 text-[var(--text-dim)] transition-opacity hover:text-[var(--text-main)] ${
                  isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
                onClick={() => onCloseTab(t.id)}
                title="Close tab"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
        <button className={`${ICON_BTN} ml-auto`} onClick={onCloseAll} title="Close all tabs">
          <X size={14} />
        </button>
      </div>

      {active ? (
        <TabBody tab={active} msgs={msgs} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-[12px] text-[var(--text-dim)]">
          Nothing open.
        </div>
      )}
    </motion.aside>
  );
}
