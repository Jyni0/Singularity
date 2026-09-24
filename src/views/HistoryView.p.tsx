import { motion } from "motion/react";
import { MessageSquare, Folder, History } from "lucide-react";
import type { Project } from "../core/types.i";
import { ageLabel } from "../core/types.i";
import { useNow } from "../hooks/useNow.h";

export function HistoryView({
  projects,
  onOpen,
}: {
  projects: Project[];
  onOpen: (project: string, convId: string) => void;
}) {
  const now = useNow();
  const all = projects.flatMap((p) => p.conversations);
  return (
    <motion.div
      className="mx-auto flex w-full max-w-[760px] flex-col"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      <div className="flex items-center gap-2 text-[18px] font-semibold text-[var(--text-main)]">
        <History size={18} strokeWidth={1.5} /> Conversation History
      </div>
      <div className="mb-4 mt-1 text-[13px] text-[var(--text-muted)]">
        All conversations across projects
      </div>
      {all.length === 0 && (
        <div className="p-6 text-center text-[var(--text-muted)]">No conversations yet</div>
      )}
      {projects.map((p) => {
        if (p.conversations.length === 0) return null;
        return (
          <div key={p.name} className="mb-4">
            <div className="mb-1 flex items-center gap-2 px-2 py-1 text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
              <Folder size={14} strokeWidth={1.5} /> {p.name}
            </div>
            {p.conversations.map((c) => (
              <button
                key={c.id}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-[13px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
                onClick={() => onOpen(p.name, c.id)}
              >
                <MessageSquare size={16} strokeWidth={1.5} className="shrink-0" />
                <span className="truncate">{c.title}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--text-dim)]">
                  {ageLabel(c.updatedAt, now)}
                </span>
              </button>
            ))}
          </div>
        );
      })}
    </motion.div>
  );
}

/* ---------- Scheduled tasks view ---------- */
