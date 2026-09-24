import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { X, Minus, Square, Copy } from "lucide-react";
import { inTauri } from "../utils/env.u";

export const MENUS: Record<string, string[]> = {
  File: ["New Conversation", "Open Folder…", "Save Workspace", "Close Window"],
  View: ["Command Palette", "Toggle Sidebar", "Reload", "Toggle Fullscreen"],
  Window: ["Minimize", "Zoom", "Close"],
};

export function TitleBar() {
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
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [openMenu]);

  const minimize = () => inTauri && getCurrentWindow().minimize();
  const toggleMax = () => inTauri && getCurrentWindow().toggleMaximize();
  const close = () => inTauri && getCurrentWindow().close();

  const runMenuAction = (item: string) => {
    setOpenMenu(null);
    if (!inTauri) return;
    if (item === "Minimize") minimize();
    if (item === "Close" || item === "Close Window") close();
    if (item === "Zoom" || item === "Toggle Fullscreen") toggleMax();
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
                  className="absolute left-0 top-[calc(100%+4px)] z-[300] flex min-w-[200px] flex-col gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-1 shadow-[var(--shadow-popup)]"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.12 }}
                >
                  {MENUS[m].map((item) => (
                    <button
                      key={item}
                      className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
                      onClick={() => runMenuAction(item)}
                    >
                      {item}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>

      {/* Center: drag region */}
      <div className="h-full flex-1" data-tauri-drag-region />

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

/* ---------- Tiny dropdown used by row actions ---------- */
