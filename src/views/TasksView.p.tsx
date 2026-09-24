import { motion } from "motion/react";
import { Timer, Clock, CalendarClock } from "lucide-react";
import { SBUTTON } from "../ui/tokens.s";
import { Badge } from "../ui/Badge.c";

export function TasksView({
  scheduled,
  onScheduleTask,
}: {
  scheduled: string[];
  onScheduleTask: () => void;
}) {
  return (
    <motion.div
      className="mx-auto flex w-full max-w-[760px] flex-col"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      <div className="flex items-center gap-2 text-[18px] font-semibold text-[var(--text-main)]">
        <Timer size={18} strokeWidth={1.5} /> Scheduled Tasks
        <button className={`${SBUTTON} ml-auto`} onClick={onScheduleTask}>
          <CalendarClock size={14} className="mr-1.5" /> Schedule Task
        </button>
      </div>
      <div className="mb-4 mt-1 text-[13px] text-[var(--text-muted)]">Recurring agent jobs</div>
      {scheduled.length === 0 && (
        <div className="p-6 text-center text-[var(--text-muted)]">No scheduled tasks</div>
      )}
      {scheduled.map((s) => (
        <div
          key={s}
          className="flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] text-[var(--text-main)]"
        >
          <Clock size={16} strokeWidth={1.5} className="shrink-0" />
          <span className="truncate font-mono">{s}</span>
          <span className="ml-auto shrink-0">
            <Badge kind="run">active</Badge>
          </span>
        </div>
      ))}
    </motion.div>
  );
}

/* ---------- Small modal shell (Schedule Task) ---------- */
