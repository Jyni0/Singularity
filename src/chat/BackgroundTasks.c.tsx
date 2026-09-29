/**
 * Background tasks: the dev servers, watchers and long builds the agent
 * started with `run_command background:true`.
 *
 * `BgTasksChip` sits in the prompt lip (after the mic) while there are any:
 * a dropdown like the model picker lists them, and picking one opens it as
 * a tab of the side panel — `BgTaskView` there shows its live output with
 * Stop / Clear.
 */
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Activity, Square, X } from "lucide-react";
import * as db from "../core/db.r";
import { inTauri } from "../utils/env.u";
import { formatDuration } from "../utils/format.u";
import { LIP_CHIP, POPOVER, POPOVER_LABEL, popoverItem, popMotion, OverlayScroll, ScrollBox, IconButton } from "../components";

const POLL_MS = 2000;

function uptime(started: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - started);
  return s < 60 ? `${s}s` : formatDuration(s * 1000);
}

function status(t: db.BgTask): { text: string; color: string } {
  if (t.running) return { text: `running · ${uptime(t.started)}`, color: "var(--diff-add)" };
  if (t.stopped) return { text: "stopped", color: "var(--text-dim)" };
  if (t.exitCode === 0) return { text: "finished", color: "var(--text-dim)" };
  return { text: `exited ${t.exitCode ?? "?"}`, color: "var(--diff-del)" };
}

/** The task list, polled — cheap local IPC calls. */
function useBgTasks(): [db.BgTask[], () => void] {
  const [tasks, setTasks] = useState<db.BgTask[]>([]);
  const refresh = () => void db.bgList().then(setTasks).catch(() => {});
  useEffect(() => {
    if (!inTauri) return;
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, []);
  return [tasks, refresh];
}

/** Lip chip + dropdown of the background tasks; hidden while there are none. */
export function BgTasksChip({ onOpen }: { onOpen?: (task: db.BgTask) => void }) {
  const [tasks, refresh] = useBgTasks();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  if (tasks.length === 0) return null;
  const running = tasks.filter((t) => t.running).length;

  return (
    <div className="relative shrink-0" ref={ref}>
      <span
        className={`${LIP_CHIP} ${open ? "bg-[var(--hover-bg)] text-[var(--text-main)]" : ""}`}
        onClick={() => setOpen(!open)}
        title="Background tasks"
      >
        <Activity size={14} strokeWidth={1.6} className={running ? "text-[var(--diff-add)]" : ""} />
        {running > 0 ? running : tasks.length}
      </span>
      <AnimatePresence>
        {open && (
          <motion.div className={`${POPOVER} absolute bottom-[calc(100%+8px)] left-0 w-[340px]`} {...popMotion(true)}>
            <div className={POPOVER_LABEL}>
              <span>Background tasks</span>
              <span className="normal-case tracking-normal">
                {running} running{tasks.length > running ? ` · ${tasks.length - running} done` : ""}
              </span>
            </div>
            <ScrollBox className="flex max-h-[260px] flex-col gap-0.5">
              {tasks.map((t) => {
                const st = status(t);
                return (
                  <div
                    key={t.id}
                    className={`${popoverItem(false)} group cursor-pointer`}
                    onClick={() => {
                      onOpen?.(t);
                      setOpen(false);
                    }}
                    title={`${t.command}\n${t.cwd}`}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: st.color }} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--text-main)]">{t.command}</span>
                    <span className="shrink-0 text-[10.5px]" style={{ color: st.color }}>
                      {st.text}
                    </span>
                    <IconButton
                      label={t.running ? "Stop this task" : "Clear from the list"} size="xs" tone="danger" reveal
                      onClick={(e) => {
                        e.stopPropagation();
                        void (t.running ? db.bgStop(t.id) : db.bgRemove(t.id)).then(refresh).catch(() => {});
                      }}
                    >
                      {t.running ? <Square size={10} /> : <X size={12} />}
                    </IconButton>
                  </div>
                );
              })}
            </ScrollBox>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Side-panel tab of one background task: live output, Stop / Clear. */
export function BgTaskView({ id }: { id: number }) {
  const [task, setTask] = useState<db.BgTask | null | undefined>(undefined);
  const [log, setLog] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!inTauri) return;
    let alive = true;
    const tick = async () => {
      try {
        const list = await db.bgList();
        const t = list.find((x) => x.id === id) ?? null;
        const text = t ? await db.bgOutput(id).catch(() => "") : "";
        if (!alive) return;
        setTask(t);
        setLog(text);
      } catch {
        /* the backend may not be ready yet */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  // Keep the log scrolled to the newest line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  if (task === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-[12px] text-[var(--text-dim)]">
        This background task is no longer in the list.
      </div>
    );
  }
  const st = task ? status(task) : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-surface)] px-3 py-1.5">
        {st && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: st.color }} />}
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-main)]" title={task ? `${task.command}\n${task.cwd}\npid ${task.pid} · ${task.shell}` : ""}>
          {task?.command ?? "…"}
        </code>
        {st && (
          <span className="shrink-0 text-[10.5px]" style={{ color: st.color }}>
            {st.text}
          </span>
        )}
        {task && (
          <button
            className="flex h-6 shrink-0 items-center gap-1 rounded-lg px-2 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--diff-del)]/15 hover:text-[var(--diff-del)]"
            title={task.running ? "Stop this task (and everything it started)" : "Clear from the list"}
            onClick={() => void (task.running ? db.bgStop(id) : db.bgRemove(id)).catch(() => {})}
          >
            {task.running ? <Square size={10} /> : <X size={11} />}
            {task.running ? "Stop" : "Clear"}
          </button>
        )}
      </div>
      <OverlayScroll wrapperClassName="min-h-0 flex-1" className="h-full overflow-auto bg-[var(--bg-app)]" innerRef={logRef}>
        <pre className="whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--text-muted)]">
          {log || "(no output yet)"}
        </pre>
      </OverlayScroll>
    </div>
  );
}
