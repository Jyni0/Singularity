import { useState } from "react";
import { FolderOpen, Trash2 } from "lucide-react";
import type { Project, PermMode } from "../core/types.i";
import { NO_PROJECT } from "../core/types.i";
import { Combobox, SettingRow, SettingsCard, Sep, Segmented, Button, Input, Alert } from "../components";

/** Per-project command permission choices. */
const PERM_MODES: Array<{ id: PermMode; label: string; hint: string }> = [
  { id: "bypass", label: "Never ask", hint: "The agent runs shell commands right away" },
  { id: "default", label: "Default", hint: "Follows the global setting in Permissions" },
  { id: "ask", label: "Always ask", hint: "The agent asks before every shell command" },
];

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
      <SettingsCard>
        <p className="py-3 text-center text-[13px] text-[var(--text-dim)]">Pick a project above to edit its settings.</p>
      </SettingsCard>
    );
  }

  const save = async () => {
    const n = name.trim();
    if (!n) setName(project.name);
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

  const mode = project.permMode ?? "default";
  const modeInfo = PERM_MODES.find((m) => m.id === mode) ?? PERM_MODES[1];

  return (
    <>
      <SettingsCard>
        <SettingRow title="Name" hint="Shown in the sidebar and the project picker — Enter to save">
          <Input className="w-[240px]"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") setName(project.name);
            }}
            onBlur={() => void save()}
            spellCheck={false}
          />
        </SettingRow>
        <Sep />
        <SettingRow title="Directory" hint="The folder agents work in for this project">
          <div className="flex w-[240px] items-center gap-1.5">
            <Input className="min-w-0 flex-1 font-mono text-[11px]"
              value={path}
              disabled={busy}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void savePath();
                if (e.key === "Escape") setPath(project.path ?? "");
              }}
              onBlur={() => void savePath()}
              placeholder="default workspace"
              title={project.path || "No folder set"}
              spellCheck={false}
            />
            <Button className="w-9 px-0" onClick={() => void browse()} disabled={busy} title="Pick a folder…">
              <FolderOpen size={14} />
            </Button>
          </div>
        </SettingRow>
      </SettingsCard>

      <SettingsCard>
        <SettingRow title="Command permission" hint={modeInfo.hint}>
          <Segmented
            options={PERM_MODES.map((m) => m.label)}
            value={modeInfo.label}
            onChange={(label) => {
              const next = PERM_MODES.find((m) => m.label === label);
              if (next && next.id !== mode) void onPermMode(project.name, next.id);
            }}
          />
        </SettingRow>
      </SettingsCard>

      {error && (
        <Alert>{error}</Alert>
      )}

      <SettingsCard>
        <SettingRow
          title="Delete project"
          hint={confirming ? "Sure? This cannot be undone." : 'Its chats are kept and move to "No project"'}
        >
          {confirming ? (
            <div className="flex items-center gap-1.5">
              <Button onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                className="gap-1.5 bg-[var(--diff-del)] text-white hover:opacity-90"
                onClick={() => void remove()}
                disabled={busy}
              >
                <Trash2 size={13} /> Delete
              </Button>
            </div>
          ) : (
            <Button
              className="gap-1.5 text-[var(--diff-del)]"
              onClick={() => setConfirming(true)}
            >
              <Trash2 size={13} /> Delete…
            </Button>
          )}
        </SettingRow>
      </SettingsCard>
    </>
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
