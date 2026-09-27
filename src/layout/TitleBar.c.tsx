import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { X, Minus, Square, Copy } from "lucide-react";
import { inTauri } from "../utils/env.u";
import { shortcutKey } from "../utils/keys.u";
import { UpdateButton, requestUpdateCheck } from "./UpdateButton.c";

type AppMode = "agent" | "ssh";

interface MenuItem {
  label: string;
  /** Shown on the right; the same combo is bound globally below. */
  shortcut?: string;
  checked?: boolean;
  run: () => void;
}
type MenuEntry = MenuItem | "separator";

const RELEASES_URL = "https://github.com/Jyni0/Singularity/releases";

/** True when focus is in a terminal — it owns Ctrl-combos (Ctrl+R, Ctrl+N…). */
const inTerminal = (t: EventTarget | null) => t instanceof Element && !!t.closest(".xterm");

export function TitleBar({
  mode,
  onSetMode,
  onNewConversation,
  onNewProject,
  onOpenFolder,
  onOpenSettings,
  onToggleSidebar,
  sidebarHidden,
}: {
  /** Current app mode — the Mode menu marks the active entry with a check. */
  mode: AppMode;
  onSetMode: (mode: AppMode) => void;
  onNewConversation: () => void;
  onNewProject: () => void;
  /** Pick a folder and start a chat in the project for it. */
  onOpenFolder: () => void;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
  sidebarHidden: boolean;
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!inTauri) return;
    const win = getCurrentWindow();
    win.isMaximized().then(setMaximized).catch(() => {});
    const un = win
      .onResized(() => {
        win.isMaximized().then(setMaximized).catch(() => {});
      })
      .catch(() => null);
    return () => {
      un.then((f) => f && f()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!openMenu) return;
    const close = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpenMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [openMenu]);

  const minimize = () => inTauri && void getCurrentWindow().minimize();
  const toggleMax = () => inTauri && void getCurrentWindow().toggleMaximize();
  // Closing hides the window to the tray (lib.rs); Quit really exits.
  const close = () => inTauri && void getCurrentWindow().close();
  const quit = async () => {
    if (!inTauri) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("tray_action", { action: "quit" });
  };
  const toggleFullscreen = async () => {
    if (!inTauri) {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
      return;
    }
    const win = getCurrentWindow();
    await win.setFullscreen(!(await win.isFullscreen()));
  };
  const openReleases = () => {
    const a = document.createElement("a");
    a.href = RELEASES_URL;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.click();
  };

  const MENUS: Record<string, MenuEntry[]> = {
    File: [
      { label: "New Conversation", shortcut: "Ctrl+N", run: onNewConversation },
      { label: "New Project…", run: onNewProject },
      { label: "Open Folder…", shortcut: "Ctrl+O", run: onOpenFolder },
      "separator",
      { label: "Settings", shortcut: "Ctrl+,", run: onOpenSettings },
      "separator",
      { label: "Close Window", run: close },
      { label: "Quit Singularity", shortcut: "Ctrl+Q", run: () => void quit() },
    ],
    Mode: [
      { label: "Agent", shortcut: "Ctrl+1", checked: mode === "agent", run: () => onSetMode("agent") },
      { label: "SSH Client", shortcut: "Ctrl+2", checked: mode === "ssh", run: () => onSetMode("ssh") },
    ],
    View: [
      { label: sidebarHidden ? "Show Sidebar" : "Hide Sidebar", shortcut: "Ctrl+B", run: onToggleSidebar },
      { label: "Toggle Fullscreen", shortcut: "F11", run: () => void toggleFullscreen() },
      "separator",
      { label: "Reload", shortcut: "Ctrl+R", run: () => location.reload() },
    ],
    Help: [
      { label: "Check for Updates", run: requestUpdateCheck },
      { label: "Releases on GitHub", run: openReleases },
    ],
  };

  // Keyboard shortcuts for the menu entries. A focused terminal keeps its
  // own Ctrl-combos (reverse search, next line…); F11 works everywhere.
  const menusRef = useRef(MENUS);
  menusRef.current = MENUS;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.defaultPrevented) return;
      let combo = "";
      if (e.key === "F11") combo = "F11";
      else if (e.ctrlKey && !e.shiftKey && !inTerminal(e.target)) {
        // Physical key, so Ctrl+N works on any keyboard layout (e.g. Russian).
        combo = "Ctrl+" + shortcutKey(e);
      }
      if (!combo) return;
      for (const entries of Object.values(menusRef.current)) {
        for (const item of entries) {
          if (item !== "separator" && item.shortcut === combo) {
            e.preventDefault();
            setOpenMenu(null);
            item.run();
            return;
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const runItem = (item: MenuItem) => {
    setOpenMenu(null);
    item.run();
  };

  return (
    <div
      ref={barRef}
      data-tauri-drag-region
      className="flex h-[34px] shrink-0 select-none items-center bg-[var(--bg-titlebar)]"
    >
      {/* Left: app menu */}
      <div className="flex h-full items-center gap-1 pl-2">
        <span className="mr-0.5 px-2 text-[13px] font-semibold tracking-wide bg-[var(--text-muted)] bg-clip-text text-transparent">
          Singularity
        </span>
        {Object.keys(MENUS).map((m) => (
          <div key={m} className="relative flex h-full items-center">
            <button
              className={`mr-0.5 rounded px-2.5 py-1 text-[13px] transition-colors ${
                openMenu === m
                  ? "bg-[var(--hover-bg)] text-[var(--text-main)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOpenMenu(openMenu === m ? null : m);
              }}
              onMouseEnter={() => openMenu && setOpenMenu(m)}
            >
              {m}
            </button>
            <AnimatePresence>
              {openMenu === m && (
                <motion.div
                  className="absolute left-0 top-[calc(100%+4px)] z-[300] flex min-w-[230px] flex-col gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-1 shadow-[var(--shadow-popup)]"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.12 }}
                >
                  {MENUS[m].map((item, i) =>
                    item === "separator" ? (
                      <div key={`sep-${i}`} className="mx-1.5 my-0.5 h-px bg-[var(--border)]" />
                    ) : (
                      <button
                        key={item.label}
                        className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
                        onClick={() => runItem(item)}
                      >
                        {m === "Mode" && (
                          <span
                            className="w-3 shrink-0 text-center text-[var(--accent)]"
                            style={{ opacity: item.checked ? 1 : 0 }}
                          >
                            ✓
                          </span>
                        )}
                        <span className="flex-1">{item.label}</span>
                        {item.shortcut && (
                          <span className="pl-4 text-[11px] text-[var(--text-dim)]">{item.shortcut}</span>
                        )}
                      </button>
                    )
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>

      {/* Center: drag region */}
      <div className="h-full flex-1" data-tauri-drag-region />

      {/* Shown when GitHub Releases has a newer version (and briefly after Help → Check for Updates). */}
      <UpdateButton />

      {/* Right: window controls — 54px wide, full height */}
      <div className="flex h-full items-stretch">
        <button
          className="flex w-[54px] items-center justify-center text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
          onClick={minimize}
          title="Minimize"
        >
          <Minus size={15} strokeWidth={1} />
        </button>
        <button
          className="flex w-[54px] items-center justify-center text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
          onClick={toggleMax}
          title={maximized ? "Restore" : "Maximize"}
        >
          {maximized ? <Copy size={13} strokeWidth={1} /> : <Square size={13} strokeWidth={1} />}
        </button>
        <button
          className="flex w-[54px] items-center justify-center text-[var(--text-muted)] transition-colors hover:bg-[#E81123] hover:text-white"
          onClick={close}
          title="Close"
        >
          <X size={15} strokeWidth={1.2} />
        </button>
      </div>
    </div>
  );
}
