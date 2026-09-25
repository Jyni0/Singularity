import { useState } from "react";
import { Folder, FolderOpen, Shield, Trash2 } from "lucide-react";
import type { Project, PermMode } from "../core/types.i";
import { NO_PROJECT } from "../core/types.i";
import { Combobox } from "../ui/Combobox.c";
import { SBUTTON } from "../ui/tokens.s";

/** Per-project command permission choices. */
export const PERM_MODES: Array<{ id: PermMode; label: string; hint: string }> = [
  { id: "bypass", label: "Bypass all", hint: "Run commands right away, never ask" },
  { id: "default", label: "As default", hint: "Use the global setting" },
  { id: "ask", label: "Always ask", hint: "Ask before every command" },
];

/** Shared settings-field geometry: h-9 to match Combobox/SBUTTON/SINPUT. */
const INPUT_CLS =
  "h-9 w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-3 text-[13px] text-[var(--text-main)] outline-none transition-colors focus:border-[var(--accent)]";

/**
 * One project's settings: rename, change directory, command permission,
 * delete. `project` is the selected project or null (nothing is
 * configurable then).
 */
export function ProjectSettingsPanel({
  project,
  onRename,
  onSetPath,
  onPermMode,
  onDelete,
}: {
  project: Project | null;
  onRename: (oldName: string, newName: string) => Promise<void>;
  /** Changes the project's working directory (agents open this folder). */
  onSetPath: (name: string, path: string) => Promise<void>;
  onPermMode: (name: string, mode: PermMode) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [path, setPath] = useState(project?.path ?? "");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync the fields when a different project gets selected.
  const [syncedTo, setSyncedTo] = useState<string | null>(project?.name ?? null);
  if (project && syncedTo !== project.name) {
    setSyncedTo(project.name);
    setName(project.name);
    setPath(project.path ?? "");
    setConfirming(false);
    setBusy(false);
    setError(null);
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
    setError(null);
    try {
      await onRename(project.name, n);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Opens the OS folder picker (Tauri dialog) and stores the new directory. */
  const browse = async () => {
    setBusy(true);
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false, defaultPath: path || undefined });
      if (typeof picked === "string" && picked) {
        setPath(picked);
        await onSetPath(project.name, picked);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const savePath = async () => {
    const v = path.trim();
    if (busy || v === (project.path ?? "")) return;
    setBusy(true);
    setError(null);
    try {
      await onSetPath(project.name, v);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onDelete(project.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
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
            className={SBUTTON + " shrink-0 !px-4"}
            disabled={!name.trim() || name.trim() === project.name || busy}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      </label>

      {/* Directory — editable now: type a path or pick a folder via the OS dialog. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-[var(--text-muted)]">Directory</span>
        <div className="flex gap-2">
          <input
            className={INPUT_CLS + " font-mono !text-[11.5px]"}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void savePath()}
            placeholder={project.path ? project.path : "no folder — agents use the default workspace"}
            spellCheck={false}
          />
          <button
            className={SBUTTON + " shrink-0 gap-1.5 !px-3"}
            onClick={() => void browse()}
            disabled={busy}
            title="Pick a folder…"
          >
            <FolderOpen size={13} /> Browse
          </button>
        </div>
        {path.trim() !== (project.path ?? "") && (
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-dim)]">
            <Folder size={11} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">Current: {project.path || "not set"}</span>
            <button
              className="rounded bg-[var(--accent)] px-2 py-0.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              disabled={busy}
              onClick={() => void savePath()}
            >
              Apply
            </button>
          </div>
        )}
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
              className={"flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors " +
                ((project.permMode ?? "default") === m.id
                  ? "border-[var(--accent)] bg-[var(--accent)]/10"
                  : "border-[var(--border)] hover:bg-[var(--hover-bg)]")}
              onClick={() => void onPermMode(project.name, m.id)}
            >
              <span
                className={"flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border " +
                  ((project.permMode ?? "default") === m.id
                    ? "border-[var(--accent)]"
                    : "border-[var(--text-dim)]")}
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

      {error && (
        <div className="rounded-md border border-[var(--diff-del)]/40 bg-[var(--diff-del)]/10 px-3 py-2 text-[12px] text-[var(--diff-del)]">
          {error}
        </div>
      )}

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
    <div className="w-[240px]">
      <Combobox
        value={value ?? ""}
        onChange={(v) => onChange(v || null)}
        placeholder={options.length ? "Select a project…" : "No projects yet"}
        emptyText="No project matches"
        options={options.map((p) => ({
          value: p.name,
          label: p.name,
          hint: p.path ? p.path.split(/[\\/]/).pop() ?? "" : "",
        }))}
      />
    </div>
  );
}
