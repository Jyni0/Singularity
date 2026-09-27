/**
 * useScheduledTasks — the Scheduled Tasks store plus the scheduler that
 * fires them.
 *
 * Every 30 s each enabled task is checked: when a minute matching its cron
 * passed since its last run (or its creation), it runs once — a new chat in
 * the task's project, sent in the background with the task's model. Runs
 * happen while the app is open (it keeps running in the tray when the window
 * is closed); a run missed while the app was quit fires once on the next
 * launch. The run is recorded BEFORE it starts, so a reload never repeats it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as db from "../core/db.r";
import type { ScheduledTask } from "../core/types.i";
import { nextRun } from "../utils/cron.u";

const TICK_MS = 30_000;
const nowSec = () => Math.floor(Date.now() / 1000);

/** When the task fires next (null = disabled or the cron never matches). */
export function nextRunOf(t: ScheduledTask): Date | null {
  if (!t.enabled) return null;
  try {
    return nextRun(t.schedule, new Date(t.armed_at * 1000));
  } catch {
    return null;
  }
}

export function useScheduledTasks(
  /** Starts the task's chat; resolves with the conversation id when the run ends. */
  runTask: (t: ScheduledTask) => Promise<string | null>
) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const runRef = useRef(runTask);
  runRef.current = runTask;
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const running = useRef(new Set<string>());

  const reload = useCallback(() => {
    void db.loadScheduledTasks().then(setTasks).catch(() => {});
  }, []);
  useEffect(reload, [reload]);

  const patch = (id: string, fields: Partial<ScheduledTask>) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...fields } : t)));

  const fire = useCallback(async (t: ScheduledTask) => {
    if (running.current.has(t.id)) return;
    running.current.add(t.id);
    setRunningIds([...running.current]);
    const at = nowSec();
    try {
      await db.markScheduledTaskRun(t.id, at);
      patch(t.id, { last_run_at: at, armed_at: at });
      const convId = await runRef.current(t);
      if (convId) {
        await db.markScheduledTaskRun(t.id, at, convId);
        patch(t.id, { last_conv: convId });
      }
    } catch {
      /* the chat itself shows what went wrong */
    } finally {
      running.current.delete(t.id);
      setRunningIds([...running.current]);
    }
  }, []);

  // The scheduler tick.
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      for (const t of tasksRef.current) {
        const next = nextRunOf(t);
        if (next && next.getTime() <= now) void fire(t);
      }
    };
    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [fire, tasks.length]);

  /** Create or edit; the schedule counts from now, so past times never fire. */
  const save = useCallback(async (task: ScheduledTask) => {
    const t = { ...task, armed_at: nowSec() };
    await db.saveScheduledTask(t);
    setTasks((prev) => (prev.some((x) => x.id === t.id) ? prev.map((x) => (x.id === t.id ? t : x)) : [...prev, t]));
  }, []);

  const remove = useCallback(async (id: string) => {
    await db.deleteScheduledTask(id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  /** Pause / resume. Resuming counts from now, so the paused time never fires. */
  const setEnabled = useCallback(async (t: ScheduledTask, enabled: boolean) => {
    const next = { ...t, enabled, armed_at: enabled ? nowSec() : t.armed_at };
    await db.saveScheduledTask(next);
    setTasks((prev) => prev.map((x) => (x.id === t.id ? next : x)));
  }, []);

  return { tasks, runningIds, save, remove, setEnabled, runNow: fire, reload };
}
