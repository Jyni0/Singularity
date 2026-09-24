/**
 * Project settings — an embedded panel, NOT a modal anymore.
 *
 * It lives as a tab inside the Settings window (project configuration belongs
 * to Settings, never to the chat chrome). The caller picks which project to
 * edit via the dropdown rendered here.
 */
import { useState } from "react";
import { Folder, Shield, Trash2 } from "lucide-react";
import type { Project, PermMode } from "../core/types.i";
import { NO_PROJECT } from "../core/types.i";

/** Per-project command permission choices. */
export const PERM_MODES: Array<{ id: PermMode; label: string; hint: string }> = [
  { id: "bypass", label: "Bypass all", hint: "Run commands right away, never ask" },
  { id: "default", label: "As default", hint: "Use the global setting" },
  { id: "ask", label: "Always ask", hint: "Ask before every command" },
];

const INPUT_CLS =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2 text-[13px] text-[var(--text-main)] outline-none focus:border-[var(--accent)]";
const SELECT_CLS =
  "h-9 min-w-[220px] cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--bg-input)] px-2 text-[13px] text-[var(--text-main)] outline-none focus:border-[var(--accent)]";

/**
 * One project's settings: rename, folder, command permission, delete.
 * `project` is the selected project or null (nothing is configurable then).
 */
export function ProjectSettingsPanel({
  project,
  onRename,
  onPermMode,
  onDelete,
}: {
  project: Project | null;
  onRename: (oldName: string, newName: string) => Promise<void>;
  onPermMode: (name: string, mode: PermMode) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  // Re-sync the name field when a different project gets selected.
  const [syncedTo, setSyncedTo] = useState<string | null>(project?.name ?? null);
  if (project && syncedTo !== project.name) {
    setSyncedTo(project.name);
    setName(project.name);
    setConfirming(false);
    setBusy(false);
  }

  if (!project) {
    return (
      <p className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-6 text-center text-[13px] text-[var(--text-dim)]">
        Pick a project above to edit its settings.
      </p>
    );
  }

  const save = async () => {
    const n = name.trim();
    if (!n || n === project.name || busy) return;
    setBusy(true);
    await onRename(project.name, n);
    setBusy(false);
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    await onDelete(project.name);
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-[var(--text-muted)]">Name</span>
        <div className="flex gap-2">
          <input
            className={INPUT_CLS}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
          <button
            className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            disabled={!name.trim() || name.trim() === project.name || busy}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-[var(--text-muted)]">
          Folder <span className="text-[var(--text-dim)]">(read-only)</span>
        </span>
        <span className="flex items-center gap-1.5 truncate font-mono text-[11px] text-[var(--text-dim)]">
          <Folder size={12} className="shrink-0" />
          {project.path || "no folder on disk"}
        </span>
      </div>

      {/* Command permission: three explicit modes instead of a boolean. */}
      <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2.5">
        <div className="flex items-start gap-2">
          <Shield size={16} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
          <div className="flex flex-1 flex-col gap-0.5">
            <span className="text-[12px] font-medium text-[var(--text-main)]">
              Command permission
            </span>
            <span className="text-[11px] text-[var(--text-dim)]">
              Who decides whether the agent may run shell commands in this project.
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 pl-6">
          {PERM_MODES.map((m) => (
            <button
              key={m.id}
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                (project.permMode ?? "default") === m.id
                  ? "border-[var(--accent)] bg-[var(--accent)]/10"
                  : "border-[var(--border)] hover:bg-[var(--hover-bg)]"
              }`}
              onClick={() => void onPermMode(project.name, m.id)}
            >
              <span
                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                  (project.permMode ?? "default") === m.id
                    ? "border-[var(--accent)]"
                    : "border-[var(--text-dim)]"
                }`}
              >
                {(project.permMode ?? "default") === m.id && (
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                )}
              </span>
              <span className="flex flex-col">
                <span className="text-[12px] font-medium text-[var(--text-main)]">{m.label}</span>
                <span className="text-[10px] text-[var(--text-dim)]">{m.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {confirming ? (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--diff-del)]/40 bg-[var(--diff-del)]/10 px-3 py-2.5">
          <span className="flex-1 text-[12px] text-[var(--text-main)]">
            Delete this project? Its chats move to "No project".
          </span>
          <button
            className="rounded-md bg-[var(--diff-del)] px-2.5 py-1 text-[11px] font-medium text-white"
            onClick={() => void remove()}
          >
            Delete
          </button>
          <button
            className="rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--hover-bg)]"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="flex items-center gap-2 self-start rounded-lg px-3 py-1.5 text-[12px] text-[var(--diff-del)] transition-colors hover:bg-[var(--hover-bg)]"
          onClick={() => setConfirming(true)}
        >
          <Trash2 size={13} /> Delete project
        </button>
      )}
    </div>
  );
}

/** The dropdown that chooses which project the panel edits. */
export function ProjectSelect({
  projects,
  value,
  onChange,
}: {
  projects: Project[];
  value: string | null;
  onChange: (name: string | null) => void;
}) {
  // "No project" has nothing to configure, so it is not offered.
  const options = projects.filter((p) => p.name !== NO_PROJECT);
  return (
    <select
      className={SELECT_CLS}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="" disabled>
        {options.length ? "Select a project\u2026" : "No projects yet"}
      </option>
      {options.map((p) => (
        <option key={p.name} value={p.name}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
