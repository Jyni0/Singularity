import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { Folder, Settings as SettingsIcon, Trash2, X } from "lucide-react";
import * as db from "../core/db.r";
import type { Model, Project, Provider, Theme, PermMode } from "../core/types.i";
import { APP_VERSION, NO_PROJECT, THEME_LIST } from "../core/types.i";
import { Combobox } from "../ui/Combobox.c";
import { SBUTTON, SINPUT } from "../ui/tokens.s";
import { ScrollArea, ScrollBox } from "../ui/ScrollArea.c";
import { ModelsSettings } from "./ModelsSettings.c";
import { TerminalSettings } from "./TerminalSettings.c";
import { ProjectSelect, ProjectSettingsPanel } from "./ProjectSettings.c";
import { Segmented, SettingRow, SettingsCard, Sep } from "./SettingsParts.c";
import { Switch } from "../ui/Switch.c";

export type SettingsSection =
  | "general"
  | "execution"
  | "permissions"
  | "behavior"
  | "projects"
  | "project-settings"
  | "models"
  | "terminal"
  | "about";

export function SettingsModal({
  theme,
  onTheme,
  projects,
  onAddProject,
  onRenameProject,
  onProjectPermMode,
  onProjectSetPath,
  onDeleteProject,
  providers,
  models,
  persistent,
  onProvidersChanged,
  onModelsChanged,
  globalAutoRun,
  onGlobalAutoRun,
  debugMode,
  onDebugMode,
  initialProject,
  initialSection,
  mode = "agent",
  onClose,
}: {
  theme: Theme;
  onTheme: (t: Theme) => void;
  projects: Project[];
  onAddProject: (name: string) => void;
  onRenameProject: (oldName: string, newName: string) => Promise<void>;
  onProjectPermMode: (name: string, mode: PermMode) => Promise<void>;
  /** Changes a project's working directory (Project Settings → Directory). */
  onProjectSetPath: (name: string, path: string) => Promise<void>;
  onDeleteProject: (name: string) => Promise<void>;
  providers: Provider[];
  models: Model[];
  persistent: boolean;
  onProvidersChanged: (next: Provider[]) => void;
  onModelsChanged: (next: Model[]) => void;
  globalAutoRun: boolean;
  onGlobalAutoRun: (next: boolean) => void;
  /** Debug mode: live token/speed/cache/time HUD inside the chat. */
  debugMode: boolean;
  onDebugMode: (next: boolean) => void;
  /** Pre-selected project of the "Project Settings" tab (from the sidebar menu). */
  initialProject?: string | null;
  /** Tab to land on — "Project Settings" opens it directly. */
  initialSection?: SettingsSection;
  /**
   * Which app mode opened the modal. The SAME modal serves both modes:
   * General and About are always available; the agent sections (Models,
   * Execution, Behavior, Projects…) show in agent mode, and SSH Client gets
   * the Terminal section instead.
   */
  mode?: "agent" | "ssh";
  onClose: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? "general");
  // A section that this mode does not offer (deep link / stale state) lands
  // on General — General and About exist in EVERY mode.
  const sshSections: SettingsSection[] = ["general", "terminal", "about"];
  const effectiveSection = mode === "ssh" && !sshSections.includes(section) ? "general" : section;
  const [settingsProject, setSettingsProject] = useState<string | null>(initialProject ?? null);
  const [sendMode, setSendMode] = useState("Queue");
  const [turboMode, setTurboMode] = useState("Turbo Mode");
  const [reviewPolicy, setReviewPolicy] = useState("Always Ask");
  const [autonomy, setAutonomy] = useState("Medium");
  const [stopOnError, setStopOnError] = useState(true);
  const [fsAccess, setFsAccess] = useState("workspace");
  const [name, setName] = useState("");
  /** Inline delete confirmation in the Manage Projects list. */
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

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
        db.getSetting("fs_access"),
      ]);
      if (cancelled) return;
      if (entries[0]) setSendMode(entries[0]);
      if (entries[1]) setTurboMode(entries[1]);
      if (entries[2]) setReviewPolicy(entries[2]);
      if (entries[3]) setAutonomy(entries[3]);
      if (entries[4] !== null) setStopOnError(entries[4] === "1");
      if (entries[5]) setFsAccess(entries[5]);
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

  // Both modes share this modal. General/About (and their groups) are always
  // available; agent-specific sections show in agent mode only, the SSH
  // Terminal section in SSH Client mode only.
  type NavItem = { id: SettingsSection; label: string };
  type NavGroup = { group: string; items: NavItem[] };
  const settingsItems: NavItem[] =
    mode === "agent"
      ? [
          { id: "general", label: "General" },
          { id: "models", label: "Models" },
          { id: "execution", label: "Execution" },
          { id: "behavior", label: "Agent Behavior" },
        ]
      : [
          { id: "general", label: "General" },
          { id: "terminal", label: "Terminal" },
        ];
  const navItems: NavGroup[] = [
    { group: "Settings", items: settingsItems },
    ...(mode === "agent"
      ? ([
          {
            group: "Projects",
            items: [
              { id: "permissions", label: "Permissions" },
              { id: "projects", label: "Manage Projects" },
              { id: "project-settings", label: "Project Settings" },
            ],
          },
        ] as NavGroup[])
      : []),
    { group: "App", items: [{ id: "about", label: "About" }] },
  ];

  const titles: Record<SettingsSection, [string, string]> = {
    general: ["General", "Appearance, theme and workspace defaults"],
    models: ["Models", "Connect providers and manage the models they expose"],
    execution: ["Execution", "How agent tasks are queued and run"],
    behavior: ["Agent Behavior", "Autonomy, safety and review policies"],
    permissions: ["Global Permissions", "Tool and filesystem access rules"],
    projects: ["Manage Projects", "Create and organize project folders"],
    "project-settings": ["Project Settings", "Rename, permissions and delete for one project"],
    terminal: ["Terminal", "Theme and behaviour of the SSH console"],
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
                    effectiveSection === it.id
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

          {effectiveSection === "general" && (
            <SettingsCard>
              <SettingRow title="Theme" hint="Application color scheme — searchable">
                {/* Searchable dropdown with a 3-dot palette preview per theme */}
                <div className="w-[240px]">
                  <Combobox
                    value={theme}
                    onChange={(v) => onTheme(v as Theme)}
                    placeholder="Search themes…"
                    emptyText="No theme matches"
                    options={THEME_LIST.map((t) => ({
                      value: t.id,
                      label: t.label,
                      hint: t.kind,
                      swatch: t.swatch,
                    }))}
                  />
                </div>
              </SettingRow>
              {/* Send Behavior is an agent-chat setting — agent mode only. */}
              {mode === "agent" && (
                <>
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
                  <Sep />
                  <SettingRow
                    title="Debug Mode"
                    hint="Live stats in chat: tokens/sec, token spend, cache rate, time"
                  >
                    <Switch
                      on={debugMode}
                      onChange={onDebugMode}
                      ariaLabel="toggle debug mode"
                    />
                  </SettingRow>
                </>
              )}
            </SettingsCard>
          )}

          {effectiveSection === "models" && (
            <ModelsSettings
              providers={providers}
              models={models}
              persistent={persistent}
              onProvidersChanged={onProvidersChanged}
              onModelsChanged={onModelsChanged}
            />
          )}

          {effectiveSection === "terminal" && <TerminalSettings />}

          {effectiveSection === "execution" && (
            <SettingsCard>
              <SettingRow title="Run Mode" hint="Auto-pilot vs supervised execution">
                <div className="w-[240px]">
                  <Combobox
                    searchable={false}
                    value={turboMode}
                    onChange={(v) => {
                      setTurboMode(v);
                      persistSetting("turbo_mode", v);
                    }}
                    options={[
                      { value: "Turbo Mode", label: "Turbo Mode" },
                      { value: "Safe Mode", label: "Safe Mode" },
                    ]}
                  />
                </div>
              </SettingRow>
              <Sep />
              <SettingRow title="Artifact Review Policy" hint="When diffs require human approval">
                <div className="w-[240px]">
                  <Combobox
                    searchable={false}
                    value={reviewPolicy}
                    onChange={(v) => {
                      setReviewPolicy(v);
                      persistSetting("review_policy", v);
                    }}
                    options={[
                      { value: "Always Ask", label: "Always Ask" },
                      { value: "Auto-accept", label: "Auto-accept" },
                      { value: "Reject by default", label: "Reject by default" },
                    ]}
                  />
                </div>
              </SettingRow>
              <Sep />
              <SettingRow title="Workspace" hint="Root folder opened for agents">
                <button className={SBUTTON}>Open</button>
              </SettingRow>
            </SettingsCard>
          )}

          {effectiveSection === "behavior" && (
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
                <Switch
                  on={stopOnError}
                  onChange={(next) => {
                    setStopOnError(next);
                    persistSetting("stop_on_error", next ? "1" : "0");
                  }}
                />
              </SettingRow>
            </SettingsCard>
          )}

          {effectiveSection === "permissions" && (
            <SettingsCard>
              <SettingRow
                title="Run Commands Without Asking"
                hint="Global default for projects set to “As default”"
              >
                <Switch
                  on={globalAutoRun}
                  onChange={onGlobalAutoRun}
                  ariaLabel="toggle global auto-run"
                />
              </SettingRow>
              <Sep />
              <SettingRow title="Filesystem Access" hint="Scope of writable paths">
                <div className="w-[240px]">
                  <Combobox
                    searchable={false}
                    value={fsAccess}
                    onChange={(v) => {
                      setFsAccess(v);
                      persistSetting("fs_access", v);
                    }}
                    options={[
                      { value: "workspace", label: "Workspace only" },
                      { value: "full", label: "Full access" },
                      { value: "none", label: "Read-only" },
                    ]}
                  />
                </div>
              </SettingRow>
            </SettingsCard>
          )}

          {effectiveSection === "projects" && (
            <div className="flex flex-col gap-3">
              <SettingsCard>
                <ScrollBox className="flex max-h-[300px] flex-col gap-1 pr-2">
                  {projects.map((p) =>
                    confirmDel === p.name ? (
                      /* Inline delete confirmation — the row turns into the question. */
                      <span
                        key={p.name}
                        className="flex items-center gap-2 rounded-lg border border-[var(--diff-del)]/40 bg-[var(--diff-del)]/10 px-2.5 py-1.5 text-[12.5px] text-[var(--text-main)]"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          Delete “{p.name}”? Its {p.conversations.length} chats move to “No project”.
                        </span>
                        <button
                          className="shrink-0 rounded-md bg-[var(--diff-del)] px-2.5 py-1 text-[11px] font-medium text-white"
                          onClick={async () => {
                            await onDeleteProject(p.name);
                            setConfirmDel(null);
                          }}
                        >
                          Delete
                        </button>
                        <button
                          className="shrink-0 rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--hover-bg)]"
                          onClick={() => setConfirmDel(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <span
                        key={p.name}
                        className="group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
                      >
                        <Folder size={12} className="shrink-0 text-[var(--text-muted)]" />
                        <span className="min-w-0 truncate">{p.name}</span>
                        {p.path && (
                          <span className="hidden min-w-0 truncate font-mono text-[10.5px] text-[var(--text-dim)] group-hover:block">
                            {p.path}
                          </span>
                        )}
                        <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--text-dim)]">
                          {p.conversations.length}
                        </span>
                        {/* Row actions: open this project's settings, or delete it. */}
                        <button
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-dim)] opacity-0 transition-all hover:bg-[var(--bg-input)] hover:text-[var(--text-main)] group-hover:opacity-100"
                          title="Edit this project's settings"
                          onClick={() => {
                            setSettingsProject(p.name);
                            setSection("project-settings");
                          }}
                        >
                          <SettingsIcon size={12} />
                        </button>
                        {p.name !== NO_PROJECT && (
                          <button
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-dim)] opacity-0 transition-all hover:bg-[var(--diff-del)]/15 hover:text-[var(--diff-del)] group-hover:opacity-100"
                            title="Delete project"
                            onClick={() => setConfirmDel(p.name)}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </span>
                    )
                  )}
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

          {effectiveSection === "project-settings" && (
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
                  onSetPath={onProjectSetPath}
                  onPermMode={onProjectPermMode}
                  onDelete={async (projName) => {
                    await onDeleteProject(projName);
                    setSettingsProject(null);
                  }}
                />
              </SettingsCard>
            </div>
          )}

          {effectiveSection === "about" && (
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
