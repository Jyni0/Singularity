import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { Modal, Button, Input, Field } from "../components";

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

  return (
    <Modal title="New Project" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <Input
            autoFocus
            placeholder="my-project"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
          />
        </Field>
        <Field label="Folder on disk (optional)" hint="A project is just a folder for your chats — it works without a path.">
          <div className="flex gap-2">
            <Input
              placeholder="C:\Users\you\Documents\project — or leave empty"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
            <Button icon={<FolderOpen size={13} />} onClick={() => void pickFolder()}>
              Browse…
            </Button>
          </div>
        </Field>
        <div className="mt-1 flex justify-end gap-2">
          <Button
            variant="secondary" size="sm"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="primary" size="sm"
            disabled={!name.trim() || busy}
            onClick={() => void submit()}
          >
            Create
          </Button>
        </div>
      </div>
    </Modal>
  );
}
