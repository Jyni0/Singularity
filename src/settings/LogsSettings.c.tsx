/**
 * Settings → Logs (SSH Client mode only): wipes the SSH audit trail.
 * Two-step, inline confirmation — the delete cannot be undone.
 */
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import * as db from "../core/db.r";
import { SettingRow, SettingsCard } from "./SettingsParts.c";

export function LogsSettings() {
  const [count, setCount] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void db.countSshLogs().then(setCount).catch(() => setCount(null));
  }, []);

  const clear = async () => {
    setBusy(true);
    try {
      await db.clearSshLogs();
      setCount(0);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return (
    <SettingsCard>
      <SettingRow
        title="Clear all logs"
        hint={
          (count === null ? "" : `${count} entr${count === 1 ? "y" : "ies"} stored. `) +
          "Removes every connection, command and transfer record. This cannot be undone."
        }
      >
        {confirm ? (
          <span className="flex items-center gap-2">
            <button
              className="flex h-9 items-center rounded-md bg-[var(--diff-del)] px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              onClick={() => void clear()}
              disabled={busy}
            >
              Delete all
            </button>
            <button
              className="flex h-9 items-center rounded-md px-3 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)]"
              onClick={() => setConfirm(false)}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            className="flex h-9 items-center gap-1.5 rounded-md border border-[var(--diff-del)]/40 px-3 text-[12px] text-[var(--diff-del)] transition-colors hover:bg-[var(--diff-del)]/10 disabled:opacity-40"
            onClick={() => setConfirm(true)}
            disabled={count === 0}
          >
            <Trash2 size={13} /> Clear logs
          </button>
        )}
      </SettingRow>
    </SettingsCard>
  );
}
