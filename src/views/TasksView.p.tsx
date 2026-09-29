import { motion } from "motion/react";
import { Timer, CalendarClock, Play, Pause, Pencil, Trash2, MessageSquare, FolderOpen, Cpu } from "lucide-react";
import type { Model, ScheduledTask } from "../core/types.i";
import { describeSchedule, type ScheduleKind } from "../utils/cron.u";
import { nextRunOf } from "../hooks/useScheduledTasks.h";
import { Button, IconButton, Spinner } from "../components";

const when = (d: Date | number | null) => {
  if (d === null) return "—";
  const date = typeof d === "number" ? new Date(d * 1000) : d;
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

/** Scheduled Tasks — recurring agent jobs: list, pause, run now, edit, delete. */
export function TasksView({
  tasks,
  models,
  runningIds,
  onNew,
  onEdit,
  onDelete,
  onToggle,
  onRunNow,
  onOpenChat,
}: {
  tasks: ScheduledTask[];
  models: Model[];
  runningIds: string[];
  onNew: () => void;
  onEdit: (t: ScheduledTask) => void;
  onDelete: (t: ScheduledTask) => void;
  onToggle: (t: ScheduledTask, enabled: boolean) => void;
  onRunNow: (t: ScheduledTask) => void;
  /** Opens the chat the task's last run created. */
  onOpenChat: (t: ScheduledTask) => void;
}) {
  const modelName = (t: ScheduledTask) =>
    models.find((m) => m.provider_id === t.provider_id && m.model_id === t.model_id)?.name || t.model_id || "no model";

  return (
    <motion.div
      className="mx-auto flex w-full max-w-[860px] flex-col"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      <div className="flex items-center gap-2 text-[18px] font-semibold text-[var(--text-main)]">
        <Timer size={18} strokeWidth={1.5} /> Scheduled Tasks
        <Button className="ml-auto" onClick={onNew}>
          <CalendarClock size={14} className="mr-1.5" /> Schedule Task
        </Button>
      </div>
      <div className="mb-4 mt-1 text-[13px] text-[var(--text-muted)]">
        Recurring agent jobs — each run opens a new chat in the task's project. They run while Singularity is open
        (also minimized to the tray).
      </div>

      {tasks.length === 0 && (
        <div className="rounded-2xl border border-dashed border-[var(--border)] p-10 text-center text-[13px] text-[var(--text-muted)]">
          <CalendarClock size={22} strokeWidth={1.4} className="mx-auto mb-2 text-[var(--text-dim)]" />
          No scheduled tasks yet.
        </div>
      )}

      {tasks.length > 0 && (
        <div className="flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)]">
          {tasks.map((t, i) => {
            const running = runningIds.includes(t.id);
            const next = nextRunOf(t);
            return (
              <div key={t.id}>
                {i > 0 && <div className="h-px bg-[var(--border-soft)]" />}
                <div className="group flex items-start gap-3 px-4 py-3">
                  <span
                    className={
                      "mt-1 h-2.5 w-2.5 shrink-0 rounded-full " +
                      (running ? "animate-pulse bg-[var(--accent)]" : t.enabled ? "bg-[var(--diff-add,#4ec9b0)]" : "bg-[var(--text-dim)]")
                    }
                    title={running ? "Running" : t.enabled ? "Active" : "Paused"}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13.5px] font-medium text-[var(--text-main)]">{t.name}</span>
                      <span className="shrink-0 rounded-md border border-[var(--border)] px-1.5 text-[10.5px] text-[var(--text-muted)]">
                        {describeSchedule(t.kind as ScheduleKind, t.schedule)}
                      </span>
                      {!t.enabled && <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-[var(--text-dim)]">paused</span>}
                    </div>
                    <div className="mt-0.5 truncate text-[12px] text-[var(--text-muted)]" title={t.prompt}>
                      {t.prompt}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-dim)]">
                      <span className="flex items-center gap-1"><FolderOpen size={11} /> {t.project}</span>
                      <span className="flex items-center gap-1"><Cpu size={11} /> {modelName(t)}</span>
                      <span>Next: {running ? "running now" : when(next)}</span>
                      <span>Last: {when(t.last_run_at)}</span>
                      {t.last_conv && (
                        <button className="flex items-center gap-1 text-[var(--accent)] hover:underline" onClick={() => onOpenChat(t)}>
                          <MessageSquare size={11} /> Open last chat
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <IconButton label="Run now" disabled={running} onClick={() => onRunNow(t)}>
                      {running ? <Spinner size={14} /> : <Play size={14} />}
                    </IconButton>
                    <IconButton label={t.enabled ? "Pause" : "Resume"} onClick={() => onToggle(t, !t.enabled)}>
                      {t.enabled ? <Pause size={14} /> : <CalendarClock size={14} />}
                    </IconButton>
                    <IconButton label="Edit" onClick={() => onEdit(t)}>
                      <Pencil size={13} />
                    </IconButton>
                    <IconButton
                      className="hover:!text-[var(--diff-del)]"
                      label="Delete"
                      onClick={() => onDelete(t)}
                    >
                      <Trash2 size={13} />
                    </IconButton>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}
