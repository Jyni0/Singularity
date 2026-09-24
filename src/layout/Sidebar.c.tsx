import { useState, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Plus, Folder, FolderOpen, History, Timer, ListFilter, FolderPlus, ChevronRight, Settings, Copy, MoreHorizontal, Pin, Pencil, Trash2, FolderCog, CopyPlus, ChevronLast, LoaderCircle } from "lucide-react";
import { Conversation, Project, ViewKind, CONV_LIMIT, NO_PROJECT, ageLabel } from "../core/types.i";
import { useNow } from "../hooks/useNow.h";
import { ROW, ROW_TEXT, ROW_HOVER, ROW_ACTIVE, SINPUT, ROW_ICON } from "../ui/tokens.s";
import { ScrollArea } from "../ui/ScrollArea.c";
import { RowMenu } from "../ui/RowMenu.c";

export function Sidebar({
  width,
  startResize,
  projects,
  activeConversation,
  view,
  runningConversations,
  onSelectConversation,
  onNewConversation,
  onNewConversationInProject,
  onShowView,
  onOpenSettings,
  onOpenProjectSettings,
  onNewProject,
  onRenameConversation,
  onDeleteConversation,
  onTogglePin,
}: {
  width: number;
  startResize: (e: React.MouseEvent) => void;
  projects: Project[];
  activeConversation: string | null;
  view: ViewKind;
  /** Conversation ids with a generation running — rows get a pulsing dot. */
  runningConversations: string[];
  onSelectConversation: (projectId: string, convId: string) => void;
  onNewConversation: () => void;
  onNewConversationInProject: (project: string) => void;
  onShowView: (v: "history" | "tasks") => void;
  onOpenSettings: () => void;
  onOpenProjectSettings: (project: string) => void;
  onNewProject: () => void;
  onRenameConversation: (project: string, convId: string, title: string) => void;
  onDeleteConversation: (project: string, convId: string) => void;
  onTogglePin: (project: string, convId: string) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ Singularity: true });
  const [sortAZ, setSortAZ] = useState(true);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [convsOpen, setConvsOpen] = useState(true);
  /** Ticking clock so conversation ages stay live (41S → 2M → 3H). */
  const now = useNow();
  /** Expanded past the 6-chat limit; reset whenever the project is collapsed. */
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [hoveredProject, setHoveredProject] = useState<string | null>(null);
  const [hoveredConv, setHoveredConv] = useState<string | null>(null);
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const [convMenu, setConvMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  /** Trigger element of whichever row menu is open (anchors the portal). */
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  const menuAnchor = menuAnchorRef as React.RefObject<HTMLElement | null>;

  const toggle = (name: string) => {
    setExpanded((e) => {
      const next = !e[name];
      // Collapsing resets "See all", so the next open shows 6 again.
      if (!next) setShowAll((s) => ({ ...s, [name]: false }));
      return { ...e, [name]: next };
    });
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
  };

  const foldered = projects.filter((p) => p.name !== NO_PROJECT);
  const sorted = sortAZ
    ? [...foldered].sort((a, b) => a.name.localeCompare(b.name))
    : foldered;
  /** Loose chats (no folder) — rendered flat, in place of a project row. */
  const looseConvs = projects.find((p) => p.name === NO_PROJECT)?.conversations ?? [];
  const looseOrdered = [
    ...looseConvs.filter((c) => c.pinned),
    ...looseConvs.filter((c) => !c.pinned),
  ];
  const looseShowAll = !!showAll[NO_PROJECT];
  const looseVisible = looseShowAll ? looseOrdered : looseOrdered.slice(0, CONV_LIMIT);
  const looseHidden = looseOrdered.length - looseVisible.length;

  /**
   * One conversation row. `topLevel` rows are the content of the Conversations
   * section, so they keep the section's own indentation instead of nesting.
   */
  const renderConversation = (
    projectName: string,
    c: Conversation,
    topLevel: boolean
  ) => {
    const active = activeConversation === c.id && view === "chat";
    const convActive = hoveredConv === c.id || convMenu === c.id;
    const isRenaming = renaming === c.id;
    const running = runningConversations.includes(c.id);
    return (
      <div
        key={`${projectName}:${c.id}`}
        className="relative shrink-0"
        onMouseEnter={() => setHoveredConv(c.id)}
        onMouseLeave={() => setHoveredConv(null)}
      >
        {isRenaming ? (
          <input
            autoFocus
            className={`${SINPUT} h-8 w-full text-[13px]`}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => {
              const t = renameValue.trim();
              if (t) onRenameConversation(projectName, c.id, t);
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setRenaming(null);
            }}
          />
        ) : (
          <button
            className={`${ROW} w-full ${
              topLevel ? "" : "pl-8"
            } ${
              active
                ? ROW_ACTIVE
                : convActive
                  ? "bg-[var(--row-solid-hover)] text-[var(--text-main)]"
                  : ROW_HOVER
            }`}
            onClick={() => onSelectConversation(projectName, c.id)}
          >
            {/* No icon — plain text, same as nested conversation rows */}
            {c.pinned && (
              <Pin
                size={11}
                strokeWidth={1.8}
                fill="currentColor"
                className="shrink-0 text-[var(--text-muted)]"
              />
            )}
            {/* A generation is running in this chat — a plain loading spinner. */}
            {running && (
              <LoaderCircle
                size={12}
                strokeWidth={2}
                className="shrink-0 animate-spin text-[var(--accent)]"
                aria-label="Generating…"
              />
            )}
            <span className={`truncate ${running ? "text-[var(--text-main)]" : ""}`}>{c.title}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--text-dim)]">
              {ageLabel(c.updatedAt, now)}
            </span>
          </button>
        )}

        {!isRenaming && (
          <div
            className={`absolute right-0.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 bg-gradient-to-l from-[var(--row-solid-gradient)] via-[var(--row-solid-gradient)] to-transparent pl-4 transition-opacity duration-100 ${
              convActive ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
          >
            <button
              className={ROW_ICON}
              title={c.pinned ? "Unpin chat" : "Pin chat"}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin(projectName, c.id);
              }}
            >
              <Pin size={14} strokeWidth={1.5} fill={c.pinned ? "currentColor" : "none"} />
            </button>
            <button
              className={ROW_ICON}
              title="Chat actions"
              onClick={(e) => {
                e.stopPropagation();
                menuAnchorRef.current = e.currentTarget;
                setConvMenu(convMenu === c.id ? null : c.id);
              }}
            >
              <MoreHorizontal size={14} strokeWidth={1.5} />
            </button>
          </div>
        )}

        <RowMenu
          open={convMenu === c.id}
          anchor={menuAnchor}
          onClose={() => setConvMenu(null)}
          items={[
            {
              icon: <Pencil size={14} strokeWidth={1.5} />,
              label: "Rename chat",
              onClick: () => {
                setRenaming(c.id);
                setRenameValue(c.title);
              },
            },
            {
              icon: <Trash2 size={14} strokeWidth={1.5} />,
              label: "Delete chat",
              danger: true,
              onClick: () => onDeleteConversation(projectName, c.id),
            },
          ]}
        />
      </div>
    );
  };

  const seeAllButton = (key: string, hidden: number) =>
    hidden > 0 ? (
      <button
        key={`see-all-${key}`}
        className={`flex h-7 items-center gap-1.5 rounded-md pr-2 text-[12px] text-[var(--accent)] transition-colors hover:bg-[var(--hover-bg)] ${
          key === NO_PROJECT ? "pl-2" : "pl-6"
        }`}
        onClick={() => setShowAll((s) => ({ ...s, [key]: true }))}
      >
        <ChevronLast size={13} strokeWidth={1.8} />
        See all ({hidden})
      </button>
    ) : null;

  const showLessButton = (key: string, total: number) =>
    showAll[key] && total > CONV_LIMIT ? (
      <button
        key={`show-less-${key}`}
        className={`flex h-7 items-center gap-1.5 rounded-md pr-2 text-[12px] text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)] ${
          key === NO_PROJECT ? "pl-2" : "pl-6"
        }`}
        onClick={() => setShowAll((s) => ({ ...s, [key]: false }))}
      >
        <ChevronLast size={13} strokeWidth={1.8} className="-rotate-90" />
        Show less
      </button>
    ) : null;

  return (
    <aside
      className="selectable relative flex shrink-0 flex-col bg-[var(--bg-sidebar)] text-[13px] leading-tight"
      style={{ width: `${width}px` }}
    >
      {/* Header block (fixed — scrollbar never overlaps it) */}
      <div className="px-2.5 pt-3">
        <button
          className="mb-2 flex h-8 w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 text-left text-[13px] font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
          onClick={onNewConversation}
        >
          <Plus size={14} strokeWidth={1.5} className="shrink-0" />
          <span>New Conversation</span>
        </button>

        <nav className="flex flex-col gap-2">
          <button
            className={`${ROW} ${view === "history" ? ROW_ACTIVE : ROW_HOVER}`}
            onClick={() => onShowView("history")}
          >
            <History size={16} strokeWidth={1.5} className="shrink-0" />
            <span>Conversation History</span>
          </button>
          <button
            className={`${ROW} ${view === "tasks" ? ROW_ACTIVE : ROW_HOVER}`}
            onClick={() => onShowView("tasks")}
          >
            <Timer size={16} strokeWidth={1.5} className="shrink-0" />
            <span>Scheduled Tasks</span>
          </button>
        </nav>
      </div>

      {/* Sidebar tree — Projects and Conversations share one scroll region */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ScrollArea
          className="min-h-0 flex-1"
          innerClassName="flex flex-col gap-0.5 px-2.5 pt-2 [&>*]:shrink-0"
        >
          {/* Projects header — the chevron sits after the label and only
              appears while the row is hovered. */}
          <div className="group mb-1 mt-3 flex h-6 shrink-0 items-center pl-1 pr-0.5">
            <button
              className="flex h-6 items-center gap-1 rounded text-[12px] font-medium text-[var(--text-dim)] transition-colors hover:text-[var(--text-main)]"
              onClick={() => setProjectsOpen(!projectsOpen)}
              title={projectsOpen ? "Collapse projects" : "Expand projects"}
            >
              Projects
              <motion.span
                animate={{ rotate: projectsOpen ? 90 : 0 }}
                transition={{ duration: 0.15 }}
                className="flex items-center opacity-0 transition-opacity group-hover:opacity-100"
              >
                <ChevronRight size={12} strokeWidth={2} />
              </motion.span>
            </button>
            <span className="ml-auto flex items-center gap-2">
              <button
                className={`flex items-center justify-center rounded p-0.5 opacity-60 transition-all hover:opacity-100 ${
                  sortAZ ? "text-[var(--accent)]" : "text-[var(--text-muted)]"
                }`}
                onClick={() => setSortAZ(!sortAZ)}
                title="Sort A–Z / by date"
              >
                <ListFilter size={14} strokeWidth={1.5} />
              </button>
              <button
                className="flex items-center justify-center rounded p-0.5 text-[var(--text-muted)] opacity-60 transition-all hover:opacity-100"
                onClick={onNewProject}
                title="New project"
              >
                <FolderPlus size={14} strokeWidth={1.5} />
              </button>
            </span>
          </div>

          <AnimatePresence initial={false}>
            {projectsOpen && (
              <motion.div
                className="flex shrink-0 flex-col gap-0.5 overflow-hidden"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                {sorted.map((p) => {
                const isOpen = !!expanded[p.name];
                // Pinned chats float to the top of their project.
                const ordered = [
                  ...p.conversations.filter((c) => c.pinned),
                  ...p.conversations.filter((c) => !c.pinned),
                ];
                const isShowAll = !!showAll[p.name];
                const visible = isShowAll ? ordered : ordered.slice(0, CONV_LIMIT);
                const hidden = ordered.length - visible.length;
                const projectActive = hoveredProject === p.name || projectMenu === p.name;

                return (
                  <div
                    key={p.name}
                    className="shrink-0"
                    onMouseEnter={() => setHoveredProject(p.name)}
                    onMouseLeave={() => setHoveredProject(null)}
                  >
                    {/* Level 1 — project row; actions float above the text */}
                    <div className="group relative">
                      <button
                        className={`${ROW} w-full ${ROW_TEXT}`}
                        onClick={() => toggle(p.name)}
                      >
                        {isOpen ? (
                          <FolderOpen size={15} strokeWidth={1.5} className="shrink-0" />
                        ) : (
                          <Folder size={15} strokeWidth={1.5} className="shrink-0" />
                        )}
                        <span className="truncate">{p.name}</span>
                      </button>

                      <div
                        className={`absolute right-0.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md transition-opacity duration-100 ${
                          projectActive ? "opacity-100" : "pointer-events-none opacity-0"
                        }`}
                      >
                        <button
                          className={`${ROW_ICON} bg-[var(--row-solid)]`}
                          title="New chat in this project"
                          onClick={(e) => {
                            e.stopPropagation();
                            onNewConversationInProject(p.name);
                          }}
                        >
                          <Plus size={14} strokeWidth={1.5} />
                        </button>
                        <button
                          className={`${ROW_ICON} bg-[var(--row-solid)]`}
                          title="Project actions"
                          onClick={(e) => {
                            e.stopPropagation();
                            menuAnchorRef.current = e.currentTarget;
                            setProjectMenu(projectMenu === p.name ? null : p.name);
                          }}
                        >
                          <MoreHorizontal size={14} strokeWidth={1.5} />
                        </button>
                      </div>

                      <RowMenu
                        open={projectMenu === p.name}
                        anchor={menuAnchor}
                        onClose={() => setProjectMenu(null)}
                        items={[
                          {
                            icon: <FolderCog size={14} strokeWidth={1.5} />,
                            label: "Project settings",
                            onClick: () => onOpenProjectSettings(p.name),
                          },
                          {
                            icon: <Copy size={14} strokeWidth={1.5} />,
                            label: "Copy name",
                            onClick: () => copy(p.name),
                          },
                          {
                            icon: <CopyPlus size={14} strokeWidth={1.5} />,
                            label: "Copy directory",
                            onClick: () => copy(p.path),
                          },
                        ]}
                      />
                    </div>

                    {/* Level 2 — conversations */}
                    <AnimatePresence initial={false}>
                      {isOpen && ordered.length > 0 && (
                        <motion.div
                          className="flex flex-col gap-0.5 overflow-hidden"
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.18, ease: "easeOut" }}
                        >
                          {visible.map((c) => renderConversation(p.name, c, false))}
                          {seeAllButton(p.name, hidden)}
                          {showLessButton(p.name, ordered.length)}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}

              </motion.div>
            )}
          </AnimatePresence>

          {/* Conversations header — loose chats, mirroring the Projects section */}
          <div className="group mb-1 mt-3 flex h-6 shrink-0 items-center pl-1 pr-0.5">
            <button
              className="flex h-6 items-center gap-1 rounded text-[12px] font-medium text-[var(--text-dim)] transition-colors hover:text-[var(--text-main)]"
              onClick={() => setConvsOpen(!convsOpen)}
              title={convsOpen ? "Collapse conversations" : "Expand conversations"}
            >
              Conversations
              <motion.span
                animate={{ rotate: convsOpen ? 90 : 0 }}
                transition={{ duration: 0.15 }}
                className="flex items-center opacity-0 transition-opacity group-hover:opacity-100"
              >
                <ChevronRight size={12} strokeWidth={2} />
              </motion.span>
            </button>
            <span className="ml-auto flex items-center gap-2">
              <button
                className="flex items-center justify-center rounded p-0.5 text-[var(--text-muted)] opacity-60 transition-all hover:opacity-100"
                onClick={() => onNewConversationInProject(NO_PROJECT)}
                title="New chat without a project"
              >
                <Plus size={14} strokeWidth={1.5} />
              </button>
            </span>
          </div>

          <AnimatePresence initial={false}>
            {convsOpen && (
              <motion.div
                className="flex shrink-0 flex-col gap-0.5 overflow-hidden"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                {/* Loose chats — plain text rows, each still pinnable and editable */}
                {looseVisible.map((c) => renderConversation(NO_PROJECT, c, true))}
                {seeAllButton(NO_PROJECT, looseHidden)}
                {showLessButton(NO_PROJECT, looseOrdered.length)}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Bottom breathing room inside the scroll region */}
          <div className="h-2 shrink-0" />
        </ScrollArea>
      </div>

      {/* Footer: Settings — always pinned to the very bottom of the sidebar */}
      <div className="mt-auto shrink-0 px-2.5 pb-3 pt-1">
        <button className={`${ROW} w-full ${ROW_HOVER}`} onClick={onOpenSettings}>
          <Settings size={16} strokeWidth={1.5} className="shrink-0" />
          <span>Settings</span>
        </button>
      </div>

      <div className="sidebar-resizer" onMouseDown={startResize} />
    </aside>
  );
}
