/**
 * Settings → Skills: instruction packs (a folder with SKILL.md) the agent
 * loads when a task matches the skill's description, or that the user calls
 * with /name in the prompt box.
 *
 * User skills live in the app data folder and are edited here; project
 * skills (<project>/.singularity/skills, <project>/.claude/skills) show up
 * read-only. Enabling/disabling works for both.
 */
import { useCallback, useEffect, useState } from "react";
import { Sparkles, Plus, Trash2, FolderInput, FileInput, Save, X, FolderOpen } from "lucide-react";
import * as db from "../core/db.r";
import { SBUTTON, SINPUT } from "../ui/tokens.s";
import { Switch } from "../ui/Switch.c";
import { SettingsCard, Sep } from "./SettingsParts.c";

const TEXTAREA =
  "w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2.5 py-2 font-mono text-[12px] leading-relaxed text-[var(--text-main)] outline-none focus:border-[var(--accent)]";
const LABEL = "flex flex-col gap-1 text-[11px] text-[var(--text-dim)]";

interface Draft {
  original: string;
  name: string;
  description: string;
  body: string;
}

const NEW_BODY = `# Steps

1. …

# Rules

- …
`;

export function SkillsSettings({ workspace }: { workspace: string }) {
  const [skills, setSkills] = useState<db.Skill[]>([]);
  const [folder, setFolder] = useState("");
  /** Row being edited ("" = the new-skill form). */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** Read-only preview of a project skill. */
  const [preview, setPreview] = useState<db.SkillFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const reload = useCallback(() => {
    void db.listSkills(workspace).then(setSkills).catch((e) => setError(String(e)));
  }, [workspace]);
  useEffect(() => {
    reload();
    void db.skillsFolder().then(setFolder).catch(() => {});
  }, [reload]);

  const close = () => {
    setEditing(null);
    setDraft(null);
    setPreview(null);
    setError(null);
  };

  const open = async (s: db.Skill) => {
    if (editing === s.name) return close();
    setError(null);
    try {
      const full = await db.getSkill(s.name, workspace);
      if (s.source === "user") {
        setPreview(null);
        setDraft({ original: s.name, name: s.name, description: full.description, body: full.body });
      } else {
        setDraft(null);
        setPreview(full);
      }
      setEditing(s.name);
    } catch (e) {
      setError(String(e));
    }
  };

  const startNew = () => {
    setPreview(null);
    setEditing("");
    setError(null);
    setDraft({ original: "", name: "", description: "", body: NEW_BODY });
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await db.saveSkill(draft);
      close();
      reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const importFrom = async (directory: boolean) => {
    setError(null);
    let picked: string | string[] | null = null;
    try {
      const { open: pick } = await import("@tauri-apps/plugin-dialog");
      picked = await pick(
        directory
          ? { directory: true, multiple: false, title: "Import a skill folder (with SKILL.md)" }
          : { multiple: false, title: "Import a SKILL.md file", filters: [{ name: "Markdown", extensions: ["md"] }] }
      );
    } catch {
      return setError("Import needs the desktop app.");
    }
    if (typeof picked !== "string") return;
    try {
      await db.importSkill(picked);
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const toggle = async (s: db.Skill, on: boolean) => {
    setSkills((prev) => prev.map((x) => (x.name === s.name ? { ...x, enabled: on } : x)));
    try {
      await db.setSkillEnabled(s.name, on);
    } catch (e) {
      setError(String(e));
      reload();
    }
  };

  const remove = async (name: string) => {
    try {
      await db.deleteSkill(name);
      setConfirmDel(null);
      if (editing === name) close();
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const editor = draft && (
    <div className="flex flex-col gap-2.5 px-1.5 pb-2 pt-1">
      <div className="grid grid-cols-[220px_1fr] gap-2.5">
        <label className={LABEL}>
          Name (also the /command)
          <input
            className={`${SINPUT} w-full font-mono`}
            value={draft.name}
            placeholder="code-review"
            onChange={(e) => setDraft({ ...draft, name: e.target.value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) })}
            autoFocus={draft.original === ""}
          />
        </label>
        <label className={LABEL}>
          When to use it (the agent reads this to decide)
          <input
            className={`${SINPUT} w-full`}
            value={draft.description}
            placeholder="Reviews a diff for bugs, security issues and style problems"
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </label>
      </div>
      <label className={LABEL}>
        Instructions (Markdown — SKILL.md body)
        <textarea className={TEXTAREA} rows={12} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
      </label>
      <div className="flex items-center justify-end gap-2">
        <button className={SBUTTON} onClick={close}>
          <X size={13} className="mr-1" /> Cancel
        </button>
        <button
          className="flex h-9 items-center rounded-md bg-[var(--accent)] px-3 text-[12px] text-white transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
          onClick={() => void save()}
          disabled={busy}
        >
          <Save size={13} className="mr-1.5" /> Save skill
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <SettingsCard>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-[var(--text-main)]">Skills</div>
            <div className="mt-0.5 text-[12px] text-[var(--text-dim)]">
              The agent sees each skill's name and description and loads the instructions when a task matches. Type{" "}
              <span className="font-mono text-[var(--text-muted)]">/name</span> in the prompt to use one directly.
            </div>
          </div>
          <button className={SBUTTON} onClick={() => void importFrom(true)} title="Import a folder that contains SKILL.md">
            <FolderInput size={13} className="mr-1" /> Folder
          </button>
          <button className={SBUTTON} onClick={() => void importFrom(false)} title="Import a single SKILL.md / .md file">
            <FileInput size={13} className="mr-1" /> File
          </button>
          <button className={SBUTTON} onClick={startNew}>
            <Plus size={13} className="mr-1" /> New skill
          </button>
        </div>

        {error && (
          <div className="rounded-md border border-[var(--diff-del)]/40 bg-[var(--diff-del)]/10 px-3 py-2 text-[12px] text-[var(--diff-del)]">
            {error}
          </div>
        )}

        {editing === "" && editor}

        {skills.length === 0 && editing !== "" && (
          <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-center text-[12px] text-[var(--text-dim)]">
            No skills yet — create one, or import a folder with a SKILL.md.
          </div>
        )}

        {skills.map((s, i) => {
          const isOpen = editing === s.name;
          return (
            <div key={`${s.source}:${s.name}`} className="flex flex-col">
              {i > 0 && <Sep />}
              {confirmDel === s.name ? (
                <div className="flex items-center gap-2 rounded-lg border border-[var(--diff-del)]/40 bg-[var(--diff-del)]/10 px-2.5 py-1.5 text-[12.5px] text-[var(--text-main)]">
                  <span className="min-w-0 flex-1 truncate">Delete the skill “{s.name}” and its folder?</span>
                  <button className="shrink-0 rounded-md bg-[var(--diff-del)] px-2.5 py-1 text-[11px] font-medium text-white" onClick={() => void remove(s.name)}>
                    Delete
                  </button>
                  <button className="shrink-0 rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--hover-bg)]" onClick={() => setConfirmDel(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div
                  className="group flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-2 transition-colors hover:bg-[var(--hover-bg)]"
                  onClick={() => void open(s)}
                >
                  <Sparkles size={14} className={s.enabled ? "shrink-0 text-[var(--accent)]" : "shrink-0 text-[var(--text-dim)]"} />
                  <span className="shrink-0 font-mono text-[12.5px] font-medium text-[var(--text-main)]">/{s.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-dim)]">{s.description || "No description"}</span>
                  {s.source !== "user" && (
                    <span className="shrink-0 rounded border border-[var(--border)] px-1.5 text-[10px] text-[var(--text-dim)]" title={s.dir}>
                      {s.source === "builtin" ? "built-in" : "project"}
                    </span>
                  )}
                  <span onClick={(e) => e.stopPropagation()}>
                    <Switch on={s.enabled} onChange={(on) => void toggle(s, on)} ariaLabel="enable skill" />
                  </span>
                  {s.source === "user" && (
                    <button
                      className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-dim)] opacity-0 transition-all hover:bg-[var(--diff-del)]/15 hover:text-[var(--diff-del)] group-hover:opacity-100"
                      title="Delete skill"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDel(s.name);
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              )}
              {isOpen && draft && editor}
              {isOpen && preview && (
                <div className="flex flex-col gap-2 px-1.5 pb-2 pt-1">
                  <div className="text-[11px] text-[var(--text-dim)]">
                    {s.source === "builtin" ? (
                      <>Built-in skill — read-only. A skill of yours with the same name replaces it.</>
                    ) : (
                      <>
                        Project skill — edit it in <span className="font-mono">{preview.dir}</span>
                      </>
                    )}
                  </div>
                  <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2.5 py-2 font-mono text-[11.5px] text-[var(--text-main)]">
                    {preview.body}
                  </pre>
                  {preview.files.length > 0 && (
                    <div className="text-[11px] text-[var(--text-dim)]">Files: {preview.files.join(", ")}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </SettingsCard>

      {folder && (
        <SettingsCard>
          <div className="flex items-center gap-2 text-[12px] text-[var(--text-dim)]">
            <FolderOpen size={13} className="shrink-0" />
            <span className="shrink-0">Your skills folder:</span>
            <span className="min-w-0 flex-1 select-text truncate font-mono text-[11.5px] text-[var(--text-muted)]" title={folder}>
              {folder}
            </span>
          </div>
          <div className="text-[11.5px] text-[var(--text-dim)]">
            Each skill is a folder with a SKILL.md; extra files next to it (scripts, templates, references) are available to the agent
            too. Projects can ship their own skills in <span className="font-mono">.singularity/skills/</span> or{" "}
            <span className="font-mono">.claude/skills/</span>.
          </div>
        </SettingsCard>
      )}
    </div>
  );
}
