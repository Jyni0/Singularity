/**
 * Background tasks panel above the prompt box: the dev servers, watchers
 * and long builds the agent started with `run_command background:true`.
 * Each can be opened to watch its live output and stopped; finished ones
 * can be cleared. Hidden while there are none.
 */
import { useEffect, useRef, useState } from "react";
import { Activity, ChevronDown, ChevronRight, ScrollText, Square, X } from "lucide-react";
import * as db from "../core/db.r";
import { inTauri } from "../utils/env.u";
import { formatDuration } from "../utils/format.u";

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

export function BackgroundTasks() {
  const [tasks, setTasks] = useState<db.BgTask[]>([]);
  const [open, setOpen] = useState(false);
  const [logFor, setLogFor] = useState<number | null>(null);
  const [log, setLog] = useState("");
  const logRef = useRef<HTMLPreElement>(null);

  // Poll the task list (and the open log) — cheap local IPC calls.
  useEffect(() => {
    if (!inTauri) return;
    let alive = true;
    const tick = async () => {
      try {
        const list = await db.bgList();
        if (!alive) return;
        setTasks(list);
        if (logFor !== null) {
          const text = await db.bgOutput(logFor).catch(() => "");
          if (alive) setLog(text);
        }
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
  }, [logFor]);

  // Keep the log scrolled to the newest line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  if (tasks.length === 0) return null;
  const running = tasks.filter((t) => t.running).length;

  const refresh = () => void db.bgList().then(setTasks).catch(() => {});

  return (
    <div className="flex flex-col gap-1 px-3 pt-3">
      <button
        className="flex items-center gap-1.5 px-1 text-[10.5px] font-medium uppercase tracking-wide text-[var(--text-dim)] transition-colors hover:text-[var(--text-main)]"
        onClick={() => setOpen((o) => !o)}
        title={open ? "Hide background tasks" : "Show background tasks"}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Activity size={11} className={running ? "text-[var(--diff-add)]" : ""} />
        Background · {running} running{tasks.length > running ? ` · ${tasks.length - running} done` : ""}
      </button>
      {open &&
        tasks.map((t) => {
          const st = status(t);
          const showing = logFor === t.id;
          return (
            <div key={t.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg-input)]">
              <div className="flex items-center gap-2 py-1 pl-2 pr-1">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: st.color }} />
                <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-dim)]">#{t.id}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--text-main)]" title={`${t.command}\n${t.cwd}\npid ${t.pid} · ${t.shell}`}>
                  {t.command}
                </span>
                <span className="shrink-0 text-[10.5px]" style={{ color: st.color }}>
                  {st.text}
                </span>
                <button
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--hover-bg)] ${showing ? "text-[var(--accent)]" : "text-[var(--text-dim)] hover:text-[var(--text-main)]"}`}
                  title={showing ? "Hide output" : "Show output"}
                  onClick={() => {
                    setLog("");
                    setLogFor(showing ? null : t.id);
                  }}
                >
                  <ScrollText size={12} />
                </button>
                {t.running ? (
                  <button
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--diff-del)]/15 hover:text-[var(--diff-del)]"
                    title="Stop this task (and everything it started)"
                    onClick={() => void db.bgStop(t.id).then(refresh).catch(() => {})}
                  >
                    <Square size={11} />
                  </button>
                ) : (
                  <button
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                    title="Clear from the list"
                    onClick={() => {
                      if (showing) setLogFor(null);
                      void db.bgRemove(t.id).then(refresh).catch(() => {});
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              {showing && (
                <pre
                  ref={logRef}
                  className="max-h-[220px] overflow-auto whitespace-pre-wrap break-all border-t border-[var(--border)] px-2 py-1.5 font-mono text-[11px] leading-[1.45] text-[var(--text-muted)]"
                >
                  {log || "(no output yet)"}
                </pre>
              )}
            </div>
          );
        })}
    </div>
  );
}
