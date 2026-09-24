import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { MessageSquare, Folder, ChevronDown, Check } from "lucide-react";
import { Project, NO_PROJECT } from "../core/types.i";
import { MENU_ITEM } from "../ui/tokens.s";
import { ScrollBox } from "../ui/ScrollArea.c";

export function ProjectPicker({
  projects,
  project,
  onSelect,
}: {
  projects: Project[];
  project: string;
  onSelect: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  return (
    <div className="relative" ref={ref}>
      {/* Breadcrumb: h 32px, folder 15, name 13 medium, chevron 12 */}
      <button
        className="flex h-8 items-center gap-1.5 px-1 text-[13px] font-medium text-[var(--text-main)] transition-colors hover:text-[var(--accent)]"
        onClick={() => setOpen(!open)}
      >
        {project === NO_PROJECT ? (
          <MessageSquare size={15} strokeWidth={1.8} className="text-[var(--text-muted)]" />
        ) : (
          <Folder size={16} strokeWidth={2} />
        )}
        {project}
        <ChevronDown size={12} className="text-[var(--text-dim)]" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute left-1/2 top-[calc(100%+8px)] z-[200] min-w-[240px] -translate-x-1/2 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-2 shadow-[var(--shadow-popup)]"
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            <ScrollBox className="flex max-h-[260px] flex-col gap-0.5">
              {/* No project — chat that lives outside any folder */}
              <button
                className={`${MENU_ITEM} ${project === NO_PROJECT ? "bg-[var(--hover-bg)]" : ""} py-2`}
                onClick={() => {
                  onSelect(NO_PROJECT);
                  setOpen(false);
                }}
              >
                <MessageSquare size={14} />
                <span className="truncate">{NO_PROJECT}</span>
                {project === NO_PROJECT && (
                  <Check size={12} className="ml-auto text-[var(--text-dim)]" />
                )}
              </button>
              <div className="my-1 h-px bg-[var(--border-soft)]" />
              {projects
                .filter((p) => p.name !== NO_PROJECT)
                .map((p) => (
                  <button
                    key={p.name}
                    className={`${MENU_ITEM} ${p.name === project ? "bg-[var(--hover-bg)]" : ""} py-2`}
                    onClick={() => {
                      onSelect(p.name);
                      setOpen(false);
                    }}
                  >
                    <Folder size={14} />
                    <span className="truncate">{p.name}</span>
                    {p.name === project && (
                      <Check size={12} className="ml-auto text-[var(--text-dim)]" />
                    )}
                  </button>
                ))}
            </ScrollBox>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- Speech-to-text (MediaRecorder → Whisper endpoint) ---------- */
