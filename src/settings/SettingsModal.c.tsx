import { useState, useEffect } from "react";
import { motion } from "motion/react";
import {
  Bot,
  Box,
  Folder,
  FolderCog,
  Folders,
  Info,
  Palette,
  Plug,
  Puzzle,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Model, Project, Provider, Theme, PermMode } from "../core/types.i";
import { APP_VERSION, NO_PROJECT, THEME_LIST } from "../core/types.i";
import { ModelsSettings } from "./ModelsSettings.c";
import { AgentsSettings } from "./AgentsSettings.c";
import type * as db from "../core/db.r";
import { TerminalSettings } from "./TerminalSettings.c";
import { ProjectSelect, ProjectSettingsPanel } from "./ProjectSettings.c";
import { LogsSettings } from "./LogsSettings.c";
import { SkillsSettings } from "./SkillsSettings.c";
import { GEN_ANIMATIONS, type GenAnimation } from "../components/effects/GenerationGlow.c";
import { McpSettings } from "./McpSettings.c";
import { PluginsSettings } from "./PluginsSettings.c";
import { Combobox, ScrollArea, ScrollBox, SettingRow, SettingsCard, Sep, Segmented, Button, Input, Switch, ConfirmBar, IconButton, NavItem as SideItem } from "../components";

export type SettingsSection =
  | "general"
  | "appearance"
  | "permissions"
  | "projects"
  | "project-settings"
  | "models"
  | "agents"
  | "skills"
  | "plugins"
  | "mcp"
  | "terminal"
  | "logs"
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
  genAnimation = "pixels",
  onGenAnimation,
  subagents,
  onSubagents,
  maxRetries,
  onMaxRetries,
  initialProject,
  initialSection,
  mode = "agent",
  workspace = "",
  onClose,
}: {
  /** Folder of the open chat's project — its project skills are listed too. */
  workspace?: string;
  /** Helper agents (Settings → Agent). */
  subagents: db.Subagent[];
  onSubagents: (next: db.Subagent[]) => void;
  /** Retries of a failed model request (API / stream errors). */
  maxRetries: number;
  onMaxRetries: (n: number) => void;
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
  /** Animation behind the chat while the model generates. */
  genAnimation?: GenAnimation;
  onGenAnimation?: (next: GenAnimation) => void;
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
  const sshSections: SettingsSection[] = ["general", "appearance", "terminal", "logs", "about"];
  const effectiveSection = mode === "ssh" && !sshSections.includes(section) ? "general" : section;
  const [settingsProject, setSettingsProject] = useState<string | null>(initialProject ?? null);
  const [name, setName] = useState("");
  /** Inline delete confirmation in the Manage Projects list. */
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

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

  // Both modes share this modal. General, Appearance and About exist in
  // every mode; the agent sections show in agent mode only, the SSH
  // Terminal and Logs in SSH Client mode only. Grouped by what they touch.
  type NavItem = { id: SettingsSection; label: string; icon: LucideIcon };
  type NavGroup = { group?: string; items: NavItem[] };
  const basics: NavGroup = {
    items: [
      { id: "general", label: "General", icon: SlidersHorizontal },
      { id: "appearance", label: "Appearance", icon: Palette },
    ],
  };
  const navItems: NavGroup[] =
    mode === "agent"
      ? [
          basics,
          {
            group: "Agent",
            items: [
              { id: "models", label: "Models", icon: Box },
              { id: "agents", label: "Subagents", icon: Bot },
              { id: "permissions", label: "Permissions", icon: ShieldCheck },
            ],
          },
          {
            group: "Extensions",
            items: [
              { id: "plugins", label: "Plugins", icon: Puzzle },
              { id: "skills", label: "Skills", icon: Sparkles },
              { id: "mcp", label: "MCP Servers", icon: Plug },
            ],
          },
          {
            group: "Projects",
            items: [
              { id: "projects", label: "Projects", icon: Folders },
              { id: "project-settings", label: "Project Settings", icon: FolderCog },
            ],
          },
        ]
      : [
          basics,
          {
            group: "SSH",
            items: [
              { id: "terminal", label: "Terminal", icon: SquareTerminal },
              { id: "logs", label: "Logs", icon: ScrollText },
            ],
          },
        ];

  const navButton = (it: NavItem) => {
    const Icon = it.icon;
    const on = effectiveSection === it.id;
    return (
      <SideItem
        key={it.id}
        active={on}
        className={on ? "text-[var(--text-main)]" : ""}
        icon={<Icon size={15} strokeWidth={1.7} className="shrink-0" />}
        onClick={() => setSection(it.id)}
      >
        <span className="truncate">{it.label}</span>
      </SideItem>
    );
  };

  const titles: Record<SettingsSection, [string, string]> = {
    general: ["General", "How the app behaves"],
    appearance: ["Appearance", "Theme and the animation behind the chat"],
    models: ["Models", "Connect providers and manage the models they expose"],
    agents: ["Subagents", "Helper agents, how many work at once and retries"],
    plugins: ["Plugins", "What the agent can do — built-in tools and one-click add-ons"],
    skills: ["Skills", "Instruction packs the agent loads when a task matches — or you call with /name"],
    mcp: ["MCP Servers", "External tool servers (Model Context Protocol) the agent can use"],
    permissions: ["Permissions", "What the agent may do without asking"],
    projects: ["Projects", "Create and organize project folders"],
    "project-settings": ["Project Settings", "Rename, permissions and delete for one project"],
    terminal: ["Terminal", "Theme and behaviour of the SSH console"],
    logs: ["Logs", "The SSH audit trail of connections and commands"],
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
        className="bg-[var(--bg-surface)] flex h-[min(720px,calc(100vh-40px))] w-[min(1260px,calc(100vw-40px))] overflow-hidden rounded-3xl border border-[var(--border)] shadow-[0_25px_50px_-12px_rgba(0,0,0,0.7)]"
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left column — sections, grouped; About pinned to the bottom. */}
        {/* <div className="flex w-[200px] shrink-0 flex-col border-r border-[var(--border-soft)] bg-[var(--bg-surface)]"> */}
        <div className="flex w-[200px] shrink-0 flex-col">
          <ScrollArea className="min-h-0 flex-1" innerClassName="flex flex-col gap-4 px-2 py-3">
            {navItems.map((grp, gi) => (
              <div key={grp.group ?? gi} className="flex flex-col gap-0.5">
                {grp.group && <div className="px-2.5 pb-1 text-[11px] text-[var(--text-dim)]">{grp.group}</div>}
                {grp.items.map(navButton)}
              </div>
            ))}
          </ScrollArea>
          <div className="px-2 pb-3">{navButton({ id: "about", label: "About", icon: Info })}</div>
        </div>

        {/* Right column — content */}
        {/* min-w-0: long content (paths, descriptions) must truncate inside
            the column, never widen it past the modal. */}
        {/* A card inset in the modal: the border runs all the way round and
            the rounded corners stay put while the content scrolls. */}
        <div className="my-2 mr-2 flex min-w-0 flex-1 overflow-hidden rounded-[18px] border border-[var(--border)] bg-[var(--bg-app)]">
        <ScrollArea className="min-w-0 flex-1" innerClassName="min-w-0 px-8 py-6">
          <div className="mb-5 flex items-start">
            <div className="min-w-0">
              <div className="text-[17px] font-semibold text-[var(--text-main)]">
                {titles[effectiveSection][0]}
              </div>
              <div className="mt-0.5 text-[12.5px] text-[var(--text-dim)]">{titles[effectiveSection][1]}</div>
            </div>
            <IconButton
              label="Close" className="ml-auto"
              onClick={onClose}
            >
              <X size={14} />
            </IconButton>
          </div>

          {effectiveSection === "appearance" && (
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
              {mode === "agent" && (
                <>
                  <Sep />
                  <SettingRow title="Generation Animation" hint="What plays behind the chat while the model works">
                    <Segmented
                      options={GEN_ANIMATIONS.map((a) => a.label)}
                      value={GEN_ANIMATIONS.find((a) => a.id === genAnimation)?.label ?? "Pixels"}
                      onChange={(label) => {
                        const next = GEN_ANIMATIONS.find((a) => a.label === label);
                        if (next) onGenAnimation?.(next.id);
                      }}
                    />
                  </SettingRow>
                </>
              )}
            </SettingsCard>
          )}

          {effectiveSection === "general" && (
            <SettingsCard>
              <SettingRow
                title="Background"
                hint="Closing the window keeps the app in the system tray; agents finish their runs there"
              />
              {/* Debug Mode is an agent-chat setting — agent mode only. */}
              {mode === "agent" && (
                <>
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

          {effectiveSection === "agents" && (
            <AgentsSettings
              subagents={subagents}
              onChange={onSubagents}
              maxRetries={maxRetries}
              onMaxRetries={onMaxRetries}
            />
          )}

          {effectiveSection === "skills" && <SkillsSettings workspace={workspace} />}

          {effectiveSection === "mcp" && <McpSettings />}

          {effectiveSection === "plugins" && <PluginsSettings />}

          {effectiveSection === "terminal" && <TerminalSettings />}

          {effectiveSection === "logs" && <LogsSettings />}

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
            </SettingsCard>
          )}

          {effectiveSection === "projects" && (
            <div className="flex flex-col gap-3">
              <SettingsCard>
                <ScrollBox className="flex max-h-[300px] flex-col gap-1 pr-2">
                  {projects.map((p) =>
                    confirmDel === p.name ? (
                      /* Inline delete confirmation — the row turns into the question. */
                      <ConfirmBar
                        key={p.name}
                        message={<>Delete “{p.name}”? Its {p.conversations.length} chats move to “No project”.</>}
                        onConfirm={async () => {
                          await onDeleteProject(p.name);
                          setConfirmDel(null);
                        }}
                        onCancel={() => setConfirmDel(null)}
                      />
                    ) : (
                      <span
                        key={p.name}
                        className="group flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-[13px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
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
                        <IconButton
                          label="Edit this project's settings" size="xs" reveal
                          onClick={() => {
                            setSettingsProject(p.name);
                            setSection("project-settings");
                          }}
                        >
                          <SettingsIcon size={12} />
                        </IconButton>
                        {p.name !== NO_PROJECT && (
                          <IconButton
                            label="Delete project" size="xs" tone="danger" reveal
                            onClick={() => setConfirmDel(p.name)}
                          >
                            <Trash2 size={12} />
                          </IconButton>
                        )}
                      </span>
                    )
                  )}
                </ScrollBox>
              </SettingsCard>
              <SettingsCard>
                <SettingRow title="New project" hint="Adds a folder to the sidebar tree">
                  <Input className="w-[240px]"
                    placeholder="Project name…"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && add()}
                  />
                  <Button className="ml-2" onClick={add} disabled={!name.trim()}>
                    Add
                  </Button>
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
            </SettingsCard>
          )}
        </ScrollArea>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ---------- Schedule Task modal ---------- */
