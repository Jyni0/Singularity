/* ---------- Project breadcrumb picker (new chat) ---------- */
import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { MessageSquare, Folder, ChevronDown, Check } from "lucide-react";
import { Project, NO_PROJECT } from "../core/types.i";
import { POPOVER, POPOVER_LABEL, popoverItem, popMotion } from "../ui/tokens.s";
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
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const pick = (name: string) => {
    onSelect(name);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      {/* Breadcrumb: h 32px, folder 15, name 13 medium, chevron 12 */}
      <button
        className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
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
            className={`${POPOVER} absolute left-1/2 top-[calc(100%+8px)] w-[260px] -translate-x-1/2`}
            {...popMotion(false)}
          >
            <div className={POPOVER_LABEL}>Start the chat in</div>
            <ScrollBox className="flex max-h-[260px] flex-col gap-0.5">
              {/* No project — chat that lives outside any folder */}
              <button className={popoverItem(project === NO_PROJECT)} onClick={() => pick(NO_PROJECT)}>
                <MessageSquare size={13} strokeWidth={1.6} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{NO_PROJECT}</span>
                {project === NO_PROJECT && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
              </button>
              <div className="mx-1 my-1 h-px shrink-0 bg-[var(--border-soft)]" />
              {projects
                .filter((p) => p.name !== NO_PROJECT)
                .map((p) => (
                  <button key={p.name} className={popoverItem(p.name === project)} onClick={() => pick(p.name)} title={p.path || undefined}>
                    <Folder size={13} strokeWidth={1.6} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {p.name === project && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
                  </button>
                ))}
            </ScrollBox>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
