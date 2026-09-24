import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { Modal } from "../ui/Modal.c";

/** Creating a project: a name and (optionally) a folder on disk. */
export function NewProjectModal({
  onCreate,
  onClose,
}: {
  onCreate: (name: string, path: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    await onCreate(n, path.trim());
  };

  /** Opens the native folder picker — a project does not require one. */
  const pickFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") {
        setPath(picked);
        // Suggest the folder name when the user hasn't typed one yet.
        if (!name.trim()) {
          const last = picked.split(/[\\/]/).filter(Boolean).pop();
          if (last) setName(last);
        }
      }
    } catch {
      /* outside Tauri: manual path entry still works */
    }
  };

  const inputCls =
    "w-full rounded-lg border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2 text-[13px] text-[var(--text-main)] outline-none focus:border-[var(--accent)]";

  return (
    <Modal title="New Project" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-[var(--text-muted)]">Name</span>
          <input
            autoFocus
            className={inputCls}
            placeholder="my-project"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-[var(--text-muted)]">
            Folder on disk <span className="text-[var(--text-dim)]">(optional)</span>
          </span>
          <div className="flex gap-2">
            <input
              className={inputCls}
              placeholder="C:\Users\you\Documents\project — or leave empty"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
            <button
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-[12px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
              onClick={() => void pickFolder()}
            >
              <FolderOpen size={13} /> Browse…
            </button>
          </div>
          <span className="text-[11px] text-[var(--text-dim)]">
            A project is just a folder for your chats — it works without a path.
          </span>
        </label>
        <div className="mt-1 flex justify-end gap-2">
          <button
            className="rounded-lg px-3 py-1.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)]"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            disabled={!name.trim() || busy}
            onClick={() => void submit()}
          >
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
}
