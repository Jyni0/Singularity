import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Bot, User, ArrowRightLeft, LogOut, TerminalSquare, Upload, Download, ChevronRight } from "lucide-react";
import * as db from "../core/db.r";
import type { SshLog } from "../core/types.i";

/**
 * Logs — the SSH audit trail: who connected to what, and when.
 *
 * Every row is written by Rust (ssh.rs) the moment an attempt happens,
 * whether the actor was the user clicking Connect or the agent calling
 * ssh_exec. Rows are grouped by day into collapsible sections (the same
 * pattern as the sidebar); the page refreshes live via ssh://logged and
 * empties when the log is cleared in Settings → Logs.
 */
export function SshLogsView() {
  const [logs, setLogs] = useState<SshLog[]>([]);
  /** Day keys the user toggled; the newest day starts open, others closed. */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const load = () => {
    db.loadSshLogs(2000).then(setLogs).catch(() => {});
  };

  useEffect(() => {
    load();
    let off: (() => void) | undefined;
    db.onSshEvent({ onLogged: load }).then((fn) => {
      off = fn;
    });
    window.addEventListener(db.SSH_LOGS_CLEARED, load);
    return () => {
      off?.();
      window.removeEventListener(db.SSH_LOGS_CLEARED, load);
    };
  }, []);

  const days = useMemo(() => groupByDay(logs), [logs]);

  return (
    <motion.div
      className="mx-auto flex w-full max-w-[760px] flex-col"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      {logs.length === 0 && (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-[13px] text-[var(--text-muted)]">
          Nothing yet — connect to a unit and the trail starts here.
        </div>
      )}

      <div className="flex flex-col gap-1">
        {days.map((day, i) => {
          const open = toggled[day.key] ?? i === 0;
          const failed = day.logs.filter((l) => !l.ok).length;
          return (
            <div key={day.key} className="flex flex-col">
              <button
                className="group flex h-8 items-center gap-1.5 rounded-lg px-2 text-left text-[12.5px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                onClick={() => setToggled((prev) => ({ ...prev, [day.key]: !open }))}
                title={open ? "Collapse" : "Expand"}
              >
                <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.15 }} className="flex">
                  <ChevronRight size={13} strokeWidth={2} />
                </motion.span>
                <span>{day.label}</span>
                <span className="font-mono text-[11px] font-normal text-[var(--text-dim)]">{day.logs.length}</span>
                {failed > 0 && (
                  <span className="rounded bg-[var(--diff-del)]/15 px-1.5 text-[10px] font-medium text-[var(--diff-del)]">
                    {failed} failed
                  </span>
                )}
              </button>
              <AnimatePresence initial={false}>
                {open && (
                  <motion.div
                    className="flex flex-col gap-0.5 overflow-hidden"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.16, ease: "easeOut" }}
                  >
                    {day.logs.map((l) => (
                      <LogRow key={l.id} log={l} />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

function LogRow({ log: l }: { log: SshLog }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-[12.5px] transition-colors hover:bg-[var(--hover-bg)]">
      {/* Time of day — the day itself is the section header. */}
      <span className="min-w-10 w-fit shrink-0 font-mono text-[11px] text-[var(--text-dim)]">{timeOf(l.created_at)}</span>
      {/* Actor: you or the agent */}
      <span
        className={
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full " +
          (l.actor === "agent" ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "bg-[var(--hover-bg)] text-[var(--text-muted)]")
        }
        title={l.actor === "agent" ? "Agent (ssh_exec tool)" : "You"}
      >
        {l.actor === "agent" ? <Bot size={13} /> : <User size={13} />}
      </span>

      {/* Action glyph */}
      <span className="flex shrink-0 items-center gap-1 text-[var(--text-dim)]">
        {l.action === "connect" && <ArrowRightLeft size={12} />}
        {l.action === "disconnect" && <LogOut size={12} />}
        {(l.action === "exec" || l.action === "shell") && <TerminalSquare size={12} />}
        {l.action === "sftp-upload" && <Upload size={12} />}
        {l.action === "sftp-download" && <Download size={12} />}
        {l.action}
      </span>

      <span className="min-w-0 flex-1 truncate text-[var(--text-main)]">
        {l.server_name}
        {l.host && <span className="text-[var(--text-dim)]"> · {l.host}</span>}
        {l.detail && <span className="ml-2 font-mono text-[11px] text-[var(--text-muted)]">{l.detail}</span>}
      </span>

      {!l.ok && (
        <span className="shrink-0 rounded bg-[var(--diff-del)]/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--diff-del)]">
          failed
        </span>
      )}
    </div>
  );
}

/** Local calendar day key of a unix-seconds stamp. */
function dayKey(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function timeOf(sec: number): string {
  return new Date(sec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "Today" / "Yesterday" / "Thu, 24 Sep" / "24 Sep 2025". */
function dayLabel(sec: number): string {
  const now = Math.floor(Date.now() / 1000);
  if (dayKey(sec) === dayKey(now)) return "Today";
  if (dayKey(sec) === dayKey(now - 86400)) return "Yesterday";
  const d = new Date(sec * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString([], sameYear
    ? { weekday: "short", day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" });
}

/** Logs are newest first, so days come out newest first too. */
function groupByDay(logs: SshLog[]): { key: string; label: string; logs: SshLog[] }[] {
  const out: { key: string; label: string; logs: SshLog[] }[] = [];
  for (const l of logs) {
    const key = dayKey(l.created_at);
    const last = out[out.length - 1];
    if (last && last.key === key) last.logs.push(l);
    else out.push({ key, label: dayLabel(l.created_at), logs: [l] });
  }
  return out;
}
