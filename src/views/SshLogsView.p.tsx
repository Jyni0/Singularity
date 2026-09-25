import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Bot, User, ArrowRightLeft, LogOut, TerminalSquare, Upload, Download } from "lucide-react";
import * as db from "../core/db.r";
import type { SshLog } from "../core/types.i";
import { useNow } from "../hooks/useNow.h";
import { ageLabel } from "../core/types.i";

/**
 * Logs — the SSH audit trail: who connected to what, and when.
 *
 * Every row is written by Rust (ssh.rs) the moment an attempt happens,
 * whether the actor was the user clicking Connect or the agent calling
 * ssh_exec. The page refreshes live via the ssh://logged event.
 */
export function SshLogsView() {
  const [logs, setLogs] = useState<SshLog[]>([]);
  const now = useNow();

  const load = () => {
    db.loadSshLogs(300).then(setLogs).catch(() => {});
  };

  useEffect(() => {
    load();
    let off: (() => void) | undefined;
    db.onSshEvent({ onLogged: load }).then((fn) => {
      off = fn;
    });
    return () => off?.();
  }, []);

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
        {logs.map((l) => (
          <div
            key={l.id}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[12.5px] transition-colors hover:bg-[var(--hover-bg)]"
          >
            {/* Actor: you or the agent */}
            <span
              className={
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full " +
                (l.actor === "agent"
                  ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                  : "bg-[var(--hover-bg)] text-[var(--text-muted)]")
              }
              title={l.actor === "agent" ? "Agent (ssh_exec tool)" : "You"}
            >
              {l.actor === "agent" ? <Bot size={13} /> : <User size={13} />}
            </span>

            <span className="shrink-0 text-[var(--text-muted)]">
              {l.actor === "agent" ? "Agent" : "You"}
            </span>

            {/* Action glyph */}
            <span className="flex shrink-0 items-center gap-1 text-[var(--text-dim)]">
              {l.action === "connect" && <ArrowRightLeft size={12} />}
              {l.action === "disconnect" && <LogOut size={12} />}
              {l.action === "exec" && <TerminalSquare size={12} />}
              {l.action === "shell" && <TerminalSquare size={12} />}
              {l.action === "sftp-upload" && <Upload size={12} />}
              {l.action === "sftp-download" && <Download size={12} />}
              {l.action}
            </span>

            <span className="min-w-0 flex-1 truncate text-[var(--text-main)]">
              {l.server_name}
              {l.host && <span className="text-[var(--text-dim)]"> · {l.host}</span>}
              {l.detail && (
                <span className="ml-2 font-mono text-[11px] text-[var(--text-muted)]">{l.detail}</span>
              )}
            </span>

            {!l.ok && (
              <span className="shrink-0 rounded bg-[var(--diff-del)]/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--diff-del)]">
                failed
              </span>
            )}
            <span className="w-12 shrink-0 text-right font-mono text-[11px] text-[var(--text-dim)]">
              {ageLabel(l.created_at, now)}
            </span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
