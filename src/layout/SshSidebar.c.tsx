import { useState } from "react";
import {
  Server,
  ScrollText,
  Settings,
  Plus,
} from "lucide-react";
import type { SshServer } from "../core/types.i";
import { ROW, ROW_HOVER, ROW_ACTIVE } from "../ui/tokens.s";
import { ScrollArea } from "../ui/ScrollArea.c";

/**
 * Sidebar of the SSH Client mode — mirrors the Agent sidebar's anatomy but
 * swaps its content: the nav buttons are Units and Logs, and the tree that
 * used to hold projects/conversations lists the saved servers instead,
 * styled exactly like conversation rows (status dot + name + host).
 */
export function SshSidebar({
  width,
  startResize,
  servers,
  connected,
  view,
  selected,
  onSelectServer,
  onShowView,
  onAddServer,
  onOpenSettings,
}: {
  width: number;
  startResize: (e: React.MouseEvent) => void;
  servers: SshServer[];
  /** Server ids with a live connection (accent dot). */
  connected: string[];
  view: "units" | "ssh-logs";
  /** Server whose console is open in the Units view. */
  selected: string | null;
  onSelectServer: (id: string) => void;
  onShowView: (v: "units" | "ssh-logs") => void;
  onAddServer: () => void;
  onOpenSettings: () => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <aside
      className="selectable relative flex shrink-0 flex-col bg-[var(--bg-sidebar)] text-[13px] leading-tight"
      style={{ width: width + "px" }}
    >
      {/* Header: the two pages of this mode (same slot as New Conversation) */}
      <div className="px-2.5 pt-3">
        <nav className="flex flex-col gap-2">
          <button
            className={ROW + " " + (view === "units" ? ROW_ACTIVE : "") + " " + ROW_HOVER}
            onClick={() => onShowView("units")}
          >
            <Server size={16} strokeWidth={1.5} className="shrink-0" />
            <span>Units</span>
          </button>
          <button
            className={ROW + " " + (view === "ssh-logs" ? ROW_ACTIVE : "") + " " + ROW_HOVER}
            onClick={() => onShowView("ssh-logs")}
          >
            <ScrollText size={16} strokeWidth={1.5} className="shrink-0" />
            <span>Logs</span>
          </button>
        </nav>
      </div>

      {/* Server tree — same look and feel as Conversations */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ScrollArea
          className="min-h-0 flex-1"
          innerClassName="flex flex-col gap-0.5 px-2.5 pt-2 [&>*]:shrink-0"
        >
          <div className="group mb-1 mt-3 flex h-6 shrink-0 items-center pl-1 pr-0.5">
            <span className="text-[12px] font-medium text-[var(--text-dim)]">Servers</span>
            <span className="ml-auto flex items-center gap-2">
              <button
                className="flex items-center justify-center rounded p-0.5 text-[var(--text-muted)] opacity-60 transition-all hover:opacity-100"
                onClick={onAddServer}
                title="Add server"
              >
                <Plus size={14} strokeWidth={1.5} />
              </button>
            </span>
          </div>

          {servers.length === 0 && (
            <div className="shrink-0 px-2 py-3 text-[12px] text-[var(--text-dim)]">
              No servers yet.
            </div>
          )}

          {servers.map((s) => {
            const live = connected.includes(s.id);
            const active = selected === s.id && view === "units";
            const isHover = hovered === s.id;
            return (
              <div
                key={s.id}
                className="relative shrink-0"
                onMouseEnter={() => setHovered(s.id)}
                onMouseLeave={() => setHovered(null)}
              >
                <button
                  className={
                    ROW + " w-full " +
                    (active
                      ? " " + ROW_ACTIVE
                      : isHover
                        ? " bg-[var(--row-solid-hover)] text-[var(--text-main)]"
                        : " " + ROW_HOVER)
                  }
                  onClick={() => onSelectServer(s.id)}
                >
                  <span
                    className={
                      "h-1.5 w-1.5 shrink-0 rounded-full " +
                      (live ? "bg-[var(--accent)]" : "bg-[var(--text-dim)]")
                    }
                    title={live ? "Connected" : "Idle"}
                  />
                  <span className="truncate">{s.name}</span>
                  <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-[var(--text-dim)]">
                    {s.host}
                  </span>
                </button>
              </div>
            );
          })}

          <div className="h-2 shrink-0" />
        </ScrollArea>
      </div>

      {/* Footer: Settings, like the Agent sidebar */}
      <div className="mt-auto shrink-0 px-2.5 pb-3 pt-1">
        <button className={ROW + " w-full " + ROW_HOVER} onClick={onOpenSettings}>
          <Settings size={16} strokeWidth={1.5} className="shrink-0" />
          <span>Settings</span>
        </button>
      </div>

      <div className="sidebar-resizer" onMouseDown={startResize} />
    </aside>
  );
}
