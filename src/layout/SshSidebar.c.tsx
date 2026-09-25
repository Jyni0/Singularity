import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Server,
  ScrollText,
  Settings,
  Plus,
  KeyRound,
  FileCode2,
  TerminalSquare,
  FolderOpen,
  ChevronRight,
  X,
} from "lucide-react";
import type { SshConn, SshKey, SshScript, SshServer, UnitsTab, ViewKind } from "../core/types.i";
import { ROW, ROW_HOVER, ROW_ACTIVE, ROW_ICON } from "../ui/tokens.s";
import { ScrollArea } from "../ui/ScrollArea.c";

/** Deterministic avatar color from an id — same palette as the Units page. */
const AVATAR_COLORS = [
  "#e06c75",
  "#e5c07b",
  "#98c379",
  "#56b6c2",
  "#61afef",
  "#c678dd",
  "#d19a66",
  "#be5046",
];

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/**
 * Sidebar of the SSH Client mode. Same anatomy as the Agent sidebar — nav
 * buttons on top, a collapsible tree below, Settings pinned at the bottom.
 * Four sections, all collapsing exactly like Projects does in the agent:
 *
 * * Connections — every open terminal/SFTP page (many per server, Termius
 *   tabs); SFTP rows read "SFTP {name}". Clicking a row reopens its page,
 *   the hover × closes the connection (its PTY session dies with it).
 * * Servers / Credentials / Scripts — the saved unit collections; the gear
 *   opens the right-hand panel form, "+" creates.
 */
export function SshSidebar({
  width,
  startResize,
  servers,
  keys,
  scripts,
  conns,
  connected,
  view,
  activeConn,
  activePanel,
  onOpenConn,
  onSelectConn,
  onCloseConn,
  onOpenPanel,
  onShowView,
  onAdd,
  onOpenSettings,
}: {
  width: number;
  startResize: (e: React.MouseEvent) => void;
  servers: SshServer[];
  keys: SshKey[];
  scripts: SshScript[];
  /** Open connection pages (terminal + SFTP), newest last. */
  conns: SshConn[];
  /** Server ids with a live pooled connection (accent dot). */
  connected: string[];
  view: ViewKind;
  /** Connection whose page is on screen. */
  activeConn: string | null;
  /** Row whose form is open in the right-hand panel (highlighted here). */
  activePanel: { kind: "server" | "key" | "script"; id?: string } | null;
  /** Focus the server's connection of this kind; fresh=true opens a new one. */
  onOpenConn: (serverId: string, kind: "terminal" | "sftp", fresh?: boolean) => void;
  onSelectConn: (connId: string) => void;
  onCloseConn: (connId: string) => void;
  onOpenPanel: (target: { kind: "server" | "key" | "script"; id: string }) => void;
  onShowView: (v: "units" | "ssh-logs") => void;
  onAdd: (tab: UnitsTab) => void;
  onOpenSettings: () => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  /* Section collapse state — the same pattern as Projects in the agent sidebar. */
  const [open, setOpen] = useState<Record<string, boolean>>({
    connections: true,
    servers: true,
    keys: true,
    scripts: true,
  });
  const toggle = (name: string) => setOpen((prev) => ({ ...prev, [name]: !prev[name] }));

  /** Section header: label + count + hover chevron, optional "+" on the right. */
  const sectionHeader = (name: string, title: string, count: number, tab?: UnitsTab, addLabel?: string) => (
    <div className="group mb-1 mt-3 flex h-6 shrink-0 items-center pl-1 pr-0.5">
      <button
        className="flex h-6 items-center gap-1 rounded text-[12px] font-medium text-[var(--text-dim)] transition-colors hover:text-[var(--text-main)]"
        onClick={() => toggle(name)}
        title={open[name] ? "Collapse" : "Expand"}
      >
        {title}
        <motion.span
          animate={{ rotate: open[name] ? 90 : 0 }}
          transition={{ duration: 0.15 }}
          className="flex items-center opacity-0 transition-opacity group-hover:opacity-100"
        >
          <ChevronRight size={12} strokeWidth={2} />
        </motion.span>
      </button>
      {tab && (
        <span className="ml-auto flex items-center gap-2">
          <button
            className="flex items-center justify-center rounded p-0.5 text-[var(--text-muted)] opacity-60 transition-all hover:opacity-100"
            onClick={() => onAdd(tab)}
            title={addLabel}
          >
            <Plus size={14} strokeWidth={1.5} />
          </button>
        </span>
      )}
    </div>
  );

  /** Collapsible body of a section — exact copy of the Projects animation. */
  const sectionBody = (name: string, children: React.ReactNode) => (
    <AnimatePresence initial={false}>
      {open[name] && (
        <motion.div
          className="flex shrink-0 flex-col gap-0.5 overflow-hidden"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );

  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? "server";

  return (
    <aside
      className="selectable relative flex shrink-0 flex-col bg-[var(--bg-sidebar)] text-[13px] leading-tight"
      style={{ width: width + "px" }}
    >
      {/* Header: the two pages of this mode */}
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

      {/* Collections tree — same rows as conversations */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ScrollArea
          className="min-h-0 flex-1"
          innerClassName="flex flex-col gap-0.5 px-2.5 pt-2 [&>*]:shrink-0"
        >
          {/* ---- Connections: every open terminal / SFTP page ---- */}
          {sectionHeader("connections", "Connections", conns.length)}
          {sectionBody(
            "connections",
            conns.length === 0 ? (
              <div className="shrink-0 px-2 py-1.5 text-center text-[12px] text-[var(--text-dim)]">
                No open connections.
              </div>
            ) : (
              conns.map((c) => {
                const isSftp = c.kind === "sftp";
                const isActive = activeConn === c.id;
                const hoverKey = "conn-" + c.id;
                const isHover = hovered === hoverKey;
                const label = isSftp ? "SFTP " + serverName(c.serverId) : serverName(c.serverId);
                return (
                  <div
                    key={c.id}
                    className="relative shrink-0"
                    onMouseEnter={() => setHovered(hoverKey)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    <button
                      className={
                        ROW + " w-full " +
                        (isActive
                          ? ROW_ACTIVE
                          : isHover
                            ? "bg-[var(--row-solid-hover)] text-[var(--text-main)]"
                            : ROW_HOVER)
                      }
                      onClick={() => onSelectConn(c.id)}
                    >
                      {isSftp ? (
                        <FolderOpen size={14} strokeWidth={1.5} className="shrink-0 text-[var(--accent)]" />
                      ) : (
                        <TerminalSquare size={14} strokeWidth={1.5} className="shrink-0 text-[var(--accent)]" />
                      )}
                      <span className="truncate">{label}</span>
                    </button>
                    {/* Hover: close the connection (kills its PTY session). */}
                    <div
                      className={
                        "absolute right-0.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-gradient-to-l from-[var(--row-solid-gradient)] via-[var(--row-solid-gradient)] to-transparent pl-4 transition-opacity duration-100 " +
                        (isHover ? "opacity-100" : "pointer-events-none opacity-0")
                      }
                    >
                      <button
                        className={ROW_ICON}
                        title="Close connection"
                        onClick={(e) => {
                          e.stopPropagation();
                          onCloseConn(c.id);
                        }}
                      >
                        <X size={13} strokeWidth={1.5} />
                      </button>
                    </div>
                  </div>
                );
              })
            )
          )}

          {/* ---- Servers ---- */}
          {sectionHeader("servers", "Servers", servers.length, "servers", "Add server")}
          {sectionBody(
            "servers",
            servers.map((s) => {
              const live = connected.includes(s.id);
              const panelActive = activePanel?.kind === "server" && activePanel.id === s.id;
              const hoverKey = "srv-" + s.id;
              const isHover = hovered === hoverKey;
              return (
                <div
                  key={s.id}
                  className="relative shrink-0"
                  onMouseEnter={() => setHovered(hoverKey)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <button
                    className={
                      ROW + " w-full " +
                      (panelActive
                        ? ROW_ACTIVE
                        : isHover
                          ? "bg-[var(--row-solid-hover)] text-[var(--text-main)]"
                          : ROW_HOVER)
                    }
                    onClick={() => onOpenConn(s.id, "terminal", true)}
                  >
                    {/* Termius-style colored avatar with a live dot */}
                    <span className="relative shrink-0">
                      <span
                        className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                        style={{ backgroundColor: avatarColor(s.id) }}
                      >
                        {s.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span
                        className={
                          "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-[var(--bg-sidebar)] " +
                          (live ? "bg-[var(--diff-add,#4ec9b0)]" : "bg-[var(--text-dim)]")
                        }
                        title={live ? "Connected" : "Idle"}
                      />
                    </span>
                    <span className="truncate">{s.name}</span>
                    <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-[var(--text-dim)]">
                      {s.host}
                    </span>
                  </button>
                  {/* Hover actions: files + settings */}
                  <div
                    className={
                      "absolute right-0.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 bg-gradient-to-l from-[var(--row-solid-gradient)] via-[var(--row-solid-gradient)] to-transparent pl-4 transition-opacity duration-100 " +
                      (isHover ? "opacity-100" : "pointer-events-none opacity-0")
                    }
                  >
                    <button
                      className={ROW_ICON}
                      title="Open SFTP"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenConn(s.id, "sftp", true);
                      }}
                    >
                      <FolderOpen size={13} strokeWidth={1.5} />
                    </button>
                    <button
                      className={ROW_ICON}
                      title="Server settings"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenPanel({ kind: "server", id: s.id });
                      }}
                    >
                      <Settings size={13} strokeWidth={1.5} />
                    </button>
                  </div>
                </div>
              );
            })
          )}

          {/* ---- Credentials ---- */}
          {sectionHeader("keys", "Credentials", keys.length, "keys", "Add credential")}
          {sectionBody(
            "keys",
            keys.map((k) => {
              const active = activePanel?.kind === "key" && activePanel.id === k.id;
              return (
                <button
                  key={k.id}
                  className={ROW + " w-full " + (active ? ROW_ACTIVE : ROW_HOVER)}
                  onClick={() => onOpenPanel({ kind: "key", id: k.id })}
                >
                  <KeyRound size={13} strokeWidth={1.5} className="shrink-0 text-[var(--text-muted)]" />
                  <span className="truncate">{k.name}</span>
                  {k.fingerprint && (
                    <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-[var(--text-dim)]">
                      {k.fingerprint.slice(0, 16)}
                    </span>
                  )}
                </button>
              );
            })
          )}

          {/* ---- Scripts ---- */}
          {sectionHeader("scripts", "Scripts", scripts.length, "scripts", "Add script")}
          {sectionBody(
            "scripts",
            scripts.map((s) => {
              const active = activePanel?.kind === "script" && activePanel.id === s.id;
              return (
                <button
                  key={s.id}
                  className={ROW + " w-full " + (active ? ROW_ACTIVE : ROW_HOVER)}
                  onClick={() => onOpenPanel({ kind: "script", id: s.id })}
                >
                  <FileCode2 size={13} strokeWidth={1.5} className="shrink-0 text-[var(--text-muted)]" />
                  <span className="truncate">{s.name}</span>
                </button>
              );
            })
          )}

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
