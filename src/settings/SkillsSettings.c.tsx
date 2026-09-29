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
import { Switch, SettingsCard, Sep, Button, Input, TextArea, Alert, ConfirmBar, IconButton, Field } from "../components";

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
        <Field label="Name (also the /command)">
          <Input className="font-mono"
            value={draft.name}
            placeholder="code-review"
            onChange={(e) => setDraft({ ...draft, name: e.target.value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) })}
            autoFocus={draft.original === ""}
          />
        </Field>
        <Field label="When to use it (the agent reads this to decide)">
          <Input
            value={draft.description}
            placeholder="Reviews a diff for bugs, security issues and style problems"
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Instructions (Markdown — SKILL.md body)">
        <TextArea mono rows={12} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
      </Field>
      <div className="flex items-center justify-end gap-2">
        <Button onClick={close}>
          <X size={13} className="mr-1" /> Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={busy}
        >
          <Save size={13} /> Save skill
        </Button>
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
          <Button onClick={() => void importFrom(true)} title="Import a folder that contains SKILL.md">
            <FolderInput size={13} className="mr-1" /> Folder
          </Button>
          <Button onClick={() => void importFrom(false)} title="Import a single SKILL.md / .md file">
            <FileInput size={13} className="mr-1" /> File
          </Button>
          <Button onClick={startNew}>
            <Plus size={13} className="mr-1" /> New skill
          </Button>
        </div>

        {error && (
          <Alert>{error}</Alert>
        )}

        {editing === "" && editor}

        {skills.length === 0 && editing !== "" && (
          <div className="rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-center text-[12px] text-[var(--text-dim)]">
            No skills yet — create one, or import a folder with a SKILL.md.
          </div>
        )}

        {skills.map((s, i) => {
          const isOpen = editing === s.name;
          return (
            <div key={`${s.source}:${s.name}`} className="flex flex-col">
              {i > 0 && <Sep />}
              {confirmDel === s.name ? (
                <ConfirmBar
                  message={<>Delete the skill “{s.name}” and its folder?</>}
                  onConfirm={() => void remove(s.name)}
                  onCancel={() => setConfirmDel(null)}
                />
              ) : (
                <div
                  className="group flex cursor-pointer items-center gap-2 rounded-xl px-1.5 py-2 transition-colors hover:bg-[var(--hover-bg)]"
                  onClick={() => void open(s)}
                >
                  <Sparkles size={14} className={s.enabled ? "shrink-0 text-[var(--accent)]" : "shrink-0 text-[var(--text-dim)]"} />
                  <span className="max-w-[45%] shrink-0 truncate font-mono text-[12.5px] font-medium text-[var(--text-main)]">/{s.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-dim)]">{s.description || "No description"}</span>
                  {s.source !== "user" && (
                    <span className="shrink-0 rounded-md border border-[var(--border)] px-1.5 text-[10px] text-[var(--text-dim)]" title={s.dir}>
                      {s.source === "builtin" ? "built-in" : "project"}
                    </span>
                  )}
                  <span onClick={(e) => e.stopPropagation()}>
                    <Switch on={s.enabled} onChange={(on) => void toggle(s, on)} ariaLabel="enable skill" />
                  </span>
                  {s.source === "user" && (
                    <IconButton
                      label="Delete skill" size="xs" tone="danger" reveal
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDel(s.name);
                      }}
                    >
                      <Trash2 size={12} />
                    </IconButton>
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
                  <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] bg-[var(--bg-input)] px-2.5 py-2 font-mono text-[11.5px] text-[var(--text-main)]">
                    {preview.body}
                  </pre>
                  {preview.files.length > 0 && (
                    <div className="break-all text-[11px] text-[var(--text-dim)]">Files: {preview.files.join(", ")}</div>
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
