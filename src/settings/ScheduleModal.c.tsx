import { useState } from "react";
import { CalendarClock } from "lucide-react";
import { SINPUT } from "../ui/tokens.s";
import { Modal } from "../ui/Modal.c";

export function ScheduleModal({
  onAdd,
  onClose,
}: {
  onAdd: (task: string) => void;
  onClose: () => void;
}) {
  const [cmd, setCmd] = useState("");
  const [freq, setFreq] = useState("daily");
  const submit = () => {
    if (!cmd.trim()) return;
    onAdd(`${freq === "daily" ? "Nightly" : freq === "weekly" ? "Weekly" : "Once"} ${cmd.trim()}`);
    onClose();
  };
  return (
    <Modal title="Schedule Task" onClose={onClose}>
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-dim)]">Command</div>
      <input
        className={`${SINPUT} w-full font-mono`}
        placeholder="/review @main"
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        autoFocus
      />
      <div className="mt-2 text-[11px] uppercase tracking-wide text-[var(--text-dim)]">Frequency</div>
      <div className="flex items-center gap-2">
        {["once", "daily", "weekly"].map((f) => (
          <button
            key={f}
            className={`h-7 rounded-md border px-2.5 font-mono text-[12px] transition-colors ${
              freq === f
                ? "border-[var(--accent)] bg-[var(--hover-bg)] text-[var(--text-main)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-main)]"
            }`}
            onClick={() => setFreq(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <button
          className="flex h-8 items-center rounded-lg bg-[var(--accent)] px-3 text-[13px] text-white transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={submit}
          disabled={!cmd.trim()}
        >
          <CalendarClock size={14} className="mr-1.5" /> Schedule
        </button>
      </div>
    </Modal>
  );
}

/* ---------- Inspection panel (Changes / Commands) ---------- */
