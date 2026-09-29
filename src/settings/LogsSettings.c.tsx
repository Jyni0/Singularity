/**
 * Settings → Logs (SSH Client mode only): wipes the SSH audit trail.
 * Two-step, inline confirmation — the delete cannot be undone.
 */
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import * as db from "../core/db.r";
import { SettingRow, SettingsCard, Button } from "../components";

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
            <Button variant="danger" onClick={() => void clear()} disabled={busy}>
              Delete all
            </Button>
            <Button
              variant="secondary"
              onClick={() => setConfirm(false)}
            >
              Cancel
            </Button>
          </span>
        ) : (
          <Button variant="danger-ghost" icon={<Trash2 size={13} />} onClick={() => setConfirm(true)} disabled={count === 0}>
            Clear logs
          </Button>
        )}
      </SettingRow>
    </SettingsCard>
  );
}
