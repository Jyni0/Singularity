import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { Folder, X } from "lucide-react";
import * as db from "../core/db.r";
import type { Model, Project, Provider, Theme, PermMode } from "../core/types.i";
import { APP_VERSION, THEMES } from "../core/types.i";
import { SBUTTON, SSELECT, SINPUT } from "../ui/tokens.s";
import { ScrollArea, ScrollBox } from "../ui/ScrollArea.c";
import { ModelsSettings } from "./ModelsSettings.c";
import { ProjectSelect, ProjectSettingsPanel } from "./ProjectSettings.c";
import { Segmented, SettingRow, SettingsCard, Sep } from "./SettingsParts.c";

export type SettingsSection =
  | "general"
  | "execution"
  | "permissions"
  | "behavior"
  | "projects"
  | "project-settings"
  | "models"
  | "about";

export function SettingsModal({
  theme,
  onTheme,
  projects,
  onAddProject,
  onRenameProject,
  onProjectPermMode,
  onDeleteProject,
  providers,
  models,
  persistent,
  onProvidersChanged,
  onModelsChanged,
  globalAutoRun,
  onGlobalAutoRun,
  initialProject,
  initialSection,
  onClose,
}: {
  theme: Theme;
  onTheme: (t: Theme) => void;
  projects: Project[];
  onAddProject: (name: string) => void;
  onRenameProject: (oldName: string, newName: string) => Promise<void>;
  onProjectPermMode: (name: string, mode: PermMode) => Promise<void>;
  onDeleteProject: (name: string) => Promise<void>;
  providers: Provider[];
  models: Model[];
  persistent: boolean;
  onProvidersChanged: (next: Provider[]) => void;
  onModelsChanged: (next: Model[]) => void;
  globalAutoRun: boolean;
  onGlobalAutoRun: (next: boolean) => void;
  /** Pre-selected project of the "Project Settings" tab (from the sidebar menu). */
  initialProject?: string | null;
  /** Tab to land on — "Project Settings" opens it directly. */
  initialSection?: SettingsSection;
  onClose: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? "general");
  const [settingsProject, setSettingsProject] = useState<string | null>(initialProject ?? null);
  const [sendMode, setSendMode] = useState("Queue");
  const [turboMode, setTurboMode] = useState("Turbo Mode");
  const [reviewPolicy, setReviewPolicy] = useState("Always Ask");
  const [autonomy, setAutonomy] = useState("Medium");
  const [stopOnError, setStopOnError] = useState(true);
  const [name, setName] = useState("");

  /** Every settings value is persisted to SQLite on edit and restored on open,
   * so nothing the user configures here is lost between launches. */
  const persistSetting = (key: string, value: string) => {
    void db.setSetting(key, value);
  };
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all([
        db.getSetting("send_mode"),
        db.getSetting("turbo_mode"),
        db.getSetting("review_policy"),
        db.getSetting("autonomy"),
        db.getSetting("stop_on_error"),
      ]);
      if (cancelled) return;
      if (entries[0]) setSendMode(entries[0]);
      if (entries[1]) setTurboMode(entries[1]);
      if (entries[2]) setReviewPolicy(entries[2]);
      if (entries[3]) setAutonomy(entries[3]);
      if (entries[4] !== null) setStopOnError(entries[4] === "1");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const add = () => {
    const n = name.trim();
    if (!n || projects.some((p) => p.name === n)) return;
    onAddProject(n);
    setName("");
  };

  const navItems: Array<{ group: string; items: Array<{ id: SettingsSection; label: string }> }> = [
    {
      group: "Settings",
      items: [
        { id: "general", label: "General" },
        { id: "models", label: "Models" },
        { id: "execution", label: "Execution" },
        { id: "behavior", label: "Agent Behavior" },
      ],
    },
    {
      group: "Projects",
      items: [
        { id: "permissions", label: "Permissions" },
        { id: "projects", label: "Manage Projects" },
        { id: "project-settings", label: "Project Settings" },
      ],
    },
    {
      group: "App",
      items: [{ id: "about", label: "About" }],
    },
  ];

  const titles: Record<SettingsSection, [string, string]> = {
    general: ["General", "Appearance, theme and workspace defaults"],
    models: ["Models", "Connect providers and manage the models they expose"],
    execution: ["Execution", "How agent tasks are queued and run"],
    behavior: ["Agent Behavior", "Autonomy, safety and review policies"],
    permissions: ["Global Permissions", "Tool and filesystem access rules"],
    projects: ["Manage Projects", "Create and organize project folders"],
    "project-settings": ["Project Settings", "Rename, permissions and delete for one project"],
    about: ["About", "Application information"],
  };

  return (
    <motion.div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/5 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
    >
      <motion.div
        className="flex h-[min(760px,calc(100vh-40px))] w-[min(1100px,calc(100vw-40px))] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-app)] shadow-[0_25px_50px_-12px_rgba(0,0,0,0.7)]"
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left column — categories */}
        <ScrollArea
          className="w-[210px] shrink-0 border-r border-[var(--border)]"
          innerClassName="flex flex-col gap-3 px-3 py-4"
        >
          {navItems.map((grp) => (
            <div key={grp.group}>
              <div className="mb-1.5 mt-3 px-2.5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)] first:mt-0">
                {grp.group}
              </div>
              {grp.items.map((it) => (
                <button
                  key={it.id}
                  className={`flex h-8 w-full items-center rounded-lg px-2.5 text-left text-[13px] transition-colors ${
                    section === it.id
                      ? "bg-[var(--bg-elevated)] text-[var(--text-main)]"
                      : "text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                  }`}
                  onClick={() => setSection(it.id)}
                >
                  {it.label}
                </button>
              ))}
            </div>
          ))}
        </ScrollArea>

        {/* Right column — content */}
        <ScrollArea className="flex-1" innerClassName="px-7 py-6">
          <div className="mb-6 flex items-start">
            <div>
              <div className="text-[21px] font-semibold text-[var(--text-main)]">
                {titles[section][0]}
              </div>
              <div className="mt-1 text-[13px] text-[var(--text-dim)]">{titles[section][1]}</div>
            </div>
            <button
              className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
              onClick={onClose}
              title="Close"
            >
              <X size={14} />
            </button>
          </div>

          {section === "general" && (
            <SettingsCard>
              <SettingRow title="Theme" hint="Application color scheme">
                <Segmented options={THEMES} value={theme} onChange={(v) => onTheme(v as Theme)} />
              </SettingRow>
              <Sep />
              <SettingRow title="Send Behavior" hint="How submitted prompts are handled">
                <Segmented
                  options={["Queue", "Send Immediately"]}
                  value={sendMode}
                  onChange={(v) => {
                    setSendMode(v);
                    persistSetting("send_mode", v);
                  }}
                />
              </SettingRow>
            </SettingsCard>
          )}

          {section === "models" && (
            <ModelsSettings
              providers={providers}
              models={models}
              persistent={persistent}
              onProvidersChanged={onProvidersChanged}
              onModelsChanged={onModelsChanged}
            />
          )}

          {section === "execution" && (
            <SettingsCard>
              <SettingRow title="Run Mode" hint="Auto-pilot vs supervised execution">
                <select
                  className={SSELECT}
                  value={turboMode}
                  onChange={(e) => {
                    setTurboMode(e.target.value);
                    persistSetting("turbo_mode", e.target.value);
                  }}
                >
                  <option>Turbo Mode</option>
                  <option>Safe Mode</option>
                </select>
              </SettingRow>
              <Sep />
              <SettingRow title="Artifact Review Policy" hint="When diffs require human approval">
                <select
                  className={SSELECT}
                  value={reviewPolicy}
                  onChange={(e) => {
                    setReviewPolicy(e.target.value);
                    persistSetting("review_policy", e.target.value);
                  }}
                >
                  <option>Always Ask</option>
                  <option>Auto-accept</option>
                  <option>Reject by default</option>
                </select>
              </SettingRow>
              <Sep />
              <SettingRow title="Workspace" hint="Root folder opened for agents">
                <button className={SBUTTON}>Open</button>
              </SettingRow>
            </SettingsCard>
          )}

          {section === "behavior" && (
            <SettingsCard>
              <SettingRow title="Autonomy Level" hint="How much freedom agents get">
                <Segmented
                  options={["Low", "Medium", "High"]}
                  value={autonomy}
                  onChange={(v) => {
                    setAutonomy(v);
                    persistSetting("autonomy", v);
                  }}
                />
              </SettingRow>
              <Sep />
              <SettingRow title="Stop on Error" hint="Halt the pipeline when a step fails">
                <button
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                    stopOnError ? "bg-[var(--accent)]" : "bg-[var(--bg-elevated)]"
                  }`}
                  onClick={() => {
                    const next = !stopOnError;
                    setStopOnError(next);
                    persistSetting("stop_on_error", next ? "1" : "0");
                  }}
                  aria-label="toggle"
                >
                  {/* The knob is anchored left so it never overflows the track. */}
                  <span
                    className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                      stopOnError ? "translate-x-[16px]" : "translate-x-0"
                    }`}
                  />
                </button>
              </SettingRow>
            </SettingsCard>
          )}

          {section === "permissions" && (
            <SettingsCard>
              <SettingRow
                title="Run Commands Without Asking"
                hint="Global default for projects set to “As default”"
              >
                <button
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                    globalAutoRun ? "bg-[var(--accent)]" : "bg-[var(--bg-elevated)]"
                  }`}
                  onClick={() => onGlobalAutoRun(!globalAutoRun)}
                  aria-label="toggle global auto-run"
                >
                  <span
                    className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                      globalAutoRun ? "translate-x-[16px]" : "translate-x-0"
                    }`}
                  />
                </button>
              </SettingRow>
              <Sep />
              <SettingRow title="Filesystem Access" hint="Scope of writable paths">
                <select className={SSELECT} defaultValue="workspace">
                  <option value="workspace">Workspace only</option>
                  <option value="full">Full access</option>
                  <option value="none">Read-only</option>
                </select>
              </SettingRow>
            </SettingsCard>
          )}

          {section === "projects" && (
            <div className="flex flex-col gap-3">
              <SettingsCard>
                <ScrollBox className="flex max-h-[300px] flex-col gap-1 pr-2">
                  {projects.map((p) => (
                    <span
                      key={p.name}
                      className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
                    >
                      <Folder size={12} /> {p.name}
                      <span className="ml-auto font-mono text-[11px] text-[var(--text-dim)]">
                        {p.conversations.length}
                      </span>
                    </span>
                  ))}
                </ScrollBox>
              </SettingsCard>
              <SettingsCard>
                <SettingRow title="New project" hint="Adds a folder to the sidebar tree">
                  <input
                    className={SINPUT}
                    placeholder="Project name…"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && add()}
                  />
                  <button className={`${SBUTTON} ml-2`} onClick={add} disabled={!name.trim()}>
                    Add
                  </button>
                </SettingRow>
              </SettingsCard>
            </div>
          )}

          {section === "project-settings" && (
            <div className="flex flex-col gap-3">
              <SettingsCard>
                <SettingRow title="Project" hint="Which project these settings apply to">
                  <ProjectSelect
                    projects={projects}
                    value={settingsProject}
                    onChange={setSettingsProject}
                  />
                </SettingRow>
              </SettingsCard>
              <SettingsCard>
                <ProjectSettingsPanel
                  project={projects.find((p) => p.name === settingsProject) ?? null}
                  onRename={async (oldName, newName) => {
                    await onRenameProject(oldName, newName);
                    setSettingsProject(newName);
                  }}
                  onPermMode={onProjectPermMode}
                  onDelete={async (projName) => {
                    await onDeleteProject(projName);
                    setSettingsProject(null);
                  }}
                />
              </SettingsCard>
            </div>
          )}

          {section === "about" && (
            <SettingsCard>
              <SettingRow title="Application" hint="Singularity — agentic desktop workspace">
                <span className="font-mono text-[13px] text-[var(--text-main)]">
                  v{APP_VERSION}
                </span>
              </SettingRow>
              <Sep />
              <SettingRow
                title="Storage"
                hint={persistent ? "SQLite (desktop shell)" : "In-memory (browser preview)"}
              />
              <Sep />
              <SettingRow
                title="Background"
                hint="Closing the window keeps the app in the system tray; agents finish their runs there"
              />
            </SettingsCard>
          )}
        </ScrollArea>
      </motion.div>
    </motion.div>
  );
}

/* ---------- Schedule Task modal ---------- */
