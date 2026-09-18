import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Plus,
  MessageSquare,
  Folder,
  History,
  Timer,
  ListFilter,
  FolderPlus,
  Clock,
  Zap,
  Shield,
  Send,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  Eye,
  Circle,
  CircleDot,
  Settings,
  CalendarClock,
  Minus,
  Square,
  Copy,
  FolderOpen,
  Mic,
} from "lucide-react";

/* ---------- Types ---------- */

export type Theme = "dark" | "light" | "slate" | "amoled";

export interface ModelOption {
  id: string;
  name: string;
  meta: string;
}

export interface Gateway {
  id: string;
  name: string;
  models: ModelOption[];
}

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
  no?: string;
}

interface Msg {
  role: "user" | "agent";
  text: string;
}

export interface Conversation {
  id: string;
  title: string;
  age: string; // e.g. "7d"
}

export interface Project {
  name: string;
  conversations: Conversation[];
}

export type ViewKind = "chat" | "new" | "history" | "tasks";

/* ---------- Data ---------- */

const GATEWAYS: Gateway[] = [
  {
    id: "antigravity",
    name: "Google Antigravity",
    models: [
      { id: "gemini-3-pro", name: "Gemini 3 Pro", meta: "Artifacts" },
      { id: "gemini-3-flash", name: "Gemini 3 Flash", meta: "fast" },
    ],
  },
  {
    id: "dsh",
    name: "DeepSeek Harness",
    models: [
      { id: "deepseek-v4", name: "DeepSeek V4", meta: "Reasoner" },
      { id: "deepseek-r2", name: "DeepSeek Reasoner R2", meta: "thinking" },
    ],
  },
  {
    id: "ollama",
    name: "Ollama · localhost:11434",
    models: [
      { id: "llama3-70b", name: "Llama 3 70B", meta: "local" },
      { id: "qwen2.5-coder", name: "Qwen 2.5 Coder 32B", meta: "local" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI · BYOK",
    models: [
      { id: "gpt-4o", name: "GPT-4o", meta: "BYOK" },
      { id: "o3-mini", name: "o3-mini", meta: "BYOK" },
    ],
  },
];

const INITIAL_PROJECTS: Project[] = [
  {
    name: "Singularity",
    conversations: [
      { id: "fix-terminal-tests", title: "Fix flaky terminal tests", age: "1d" },
      { id: "model-router-fallback", title: "Add Model Router fallback", age: "2d" },
    ],
  },
  { name: "accounting", conversations: [{ id: "acc-invoices", title: "Invoice parser refactor", age: "7d" }] },
  { name: "Auth", conversations: [{ id: "auth-jwt", title: "JWT refresh flow", age: "12d" }] },
  { name: "CourcesPlatform", conversations: [] },
  { name: "DataVisualizationMatplotlib", conversations: [] },
  { name: "Education-Website", conversations: [{ id: "edu-landing", title: "Landing page rewrite", age: "5d" }] },
  { name: "Frontend_Booking", conversations: [] },
  { name: "hosty", conversations: [] },
  { name: "landing", conversations: [] },
  { name: "TermosClient", conversations: [] },
  { name: "TSKS_1gg7sgds", conversations: [] },
];

const INITIAL_SCHEDULED = ["Nightly /review @main", "Weekly /test all"];

const DIFF: DiffLine[] = [
  { kind: "hunk", text: "@@ src/router/fallback.ts @@" },
  { kind: "ctx", text: "export class ModelRouter {", no: "12" },
  { kind: "ctx", text: "  private providers: Gateway[];", no: "13" },
  { kind: "del", text: "  async route(req: Request) {", no: "14" },
  { kind: "del", text: "    return this.providers[0].send(req);", no: "15" },
  { kind: "add", text: "  async route(req: Request) {", no: "14" },
  { kind: "add", text: "  for (const gw of this.providers) {", no: "15" },
  { kind: "add", text: "      try { return await gw.send(req); }", no: "16" },
  { kind: "add", text: "      catch (e) { if (!is429(e)) throw e; }", no: "17" },
  { kind: "ctx", text: "  }", no: "18" },
];

/* ---------- Custom title bar (window controls + app menu) ---------- */

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const MENUS: Record<string, string[]> = {
  File: ["New Conversation", "Open Folder…", "Save Workspace", "Close Window"],
  View: ["Command Palette", "Toggle Sidebar", "Reload", "Toggle Fullscreen"],
  Window: ["Minimize", "Zoom", "Close"],
};

function TitleBar() {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!inTauri) return;
    const win = getCurrentWindow();
    win.isMaximized().then(setMaximized).catch(() => {});
    const un = win
      .onResized(() => {
        win.isMaximized().then(setMaximized).catch(() => {});
      })
      .catch(() => null);
    return () => {
      un.then((f) => f && f()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!openMenu) return;
    const close = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [openMenu]);

  const minimize = () => inTauri && getCurrentWindow().minimize();
  const toggleMax = () => inTauri && getCurrentWindow().toggleMaximize();
  const close = () => inTauri && getCurrentWindow().close();

  const runMenuAction = (item: string) => {
    setOpenMenu(null);
    if (!inTauri) return;
    if (item === "Minimize") minimize();
    if (item === "Close" || item === "Close Window") close();
    if (item === "Zoom" || item === "Toggle Fullscreen") toggleMax();
  };

  return (
    <div ref={barRef} className="titlebar" data-tauri-drag-region>
      {/* Left: app menu */}
      <div className="titlebar__menu">
        <span className="titlebar__logo">Singularity</span>
        {Object.keys(MENUS).map((m) => (
          <div key={m} className="titlebar__menu-item-wrap">
            <button
              className={`titlebar__menu-item ${openMenu === m ? "titlebar__menu-item--open" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOpenMenu(openMenu === m ? null : m);
              }}
              onMouseEnter={() => openMenu && setOpenMenu(m)}
            >
              {m}
            </button>
            <AnimatePresence>
              {openMenu === m && (
                <motion.div
                  className="titlebar__dropdown"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.12 }}
                >
                  {MENUS[m].map((item) => (
                    <button
                      key={item}
                      className="titlebar__dropdown-item"
                      onClick={() => runMenuAction(item)}
                    >
                      {item}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>

      {/* Center: drag region */}
      <div className="titlebar__drag" data-tauri-drag-region />

      {/* Right: window controls */}
      <div className="titlebar__controls">
        <button className="titlebar__ctrl" onClick={minimize} title="Minimize">
          <Minus size={12} strokeWidth={1} />
        </button>
        <button className="titlebar__ctrl" onClick={toggleMax} title={maximized ? "Restore" : "Maximize"}>
          {maximized ? <Copy size={11} strokeWidth={1} /> : <Square size={11} strokeWidth={1} />}
        </button>
        <button className="titlebar__ctrl titlebar__ctrl--close" onClick={close} title="Close">
          <X size={12} strokeWidth={1} />
        </button>
      </div>
    </div>
  );
}

/* ---------- Sidebar (tree view) ---------- */

function Sidebar({
  width,
  startResize,
  projects,
  activeConversation,
  view,
  onSelectConversation,
  onNewConversation,
  onShowView,
  onOpenSettings,
  onNewProject,
}: {
  width: number;
  startResize: (e: React.MouseEvent) => void;
  projects: Project[];
  activeConversation: string | null;
  view: ViewKind;
  onSelectConversation: (projectId: string, convId: string) => void;
  onNewConversation: () => void;
  onShowView: (v: "history" | "tasks") => void;
  onOpenSettings: () => void;
  onNewProject: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ Singularity: true });
  const [sortAZ, setSortAZ] = useState(true);

  const toggle = (name: string) => setExpanded((e) => ({ ...e, [name]: !e[name] }));
  const sorted = sortAZ ? [...projects].sort((a, b) => a.name.localeCompare(b.name)) : projects;

  return (
    <aside
      className="relative flex shrink-0 flex-col bg-[#181818] p-[12px_10px] text-[13px] leading-tight"
      style={{ width: `${width}px` }}
    >
      {/* Primary action */}
      <button
        className="mb-3 flex h-9 w-full items-center gap-2 rounded-lg border border-[#2e2e2e] bg-[#1f1f1f] px-3 text-left text-[13px] font-medium text-[#cccccc] transition-colors hover:bg-[#262626] hover:text-white"
        onClick={onNewConversation}
      >
        <Plus size={14} strokeWidth={1.5} className="shrink-0" />
        <span>New Conversation</span>
      </button>

      {/* System navigation — opens views in chat area */}
      <nav className="flex flex-col gap-0.5">
        <button
          className={`flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors ${
            view === "history"
              ? "font-medium text-white"
              : "text-[#cccccc] hover:text-white"
          }`}
          onClick={() => onShowView("history")}
        >
          <History size={16} strokeWidth={1.5} className="shrink-0" />
          <span>Conversation History</span>
        </button>
        <button
          className={`flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors ${
            view === "tasks"
              ? "font-medium text-white"
              : "text-[#cccccc] hover:text-white"
          }`}
          onClick={() => onShowView("tasks")}
        >
          <Timer size={16} strokeWidth={1.5} className="shrink-0" />
          <span>Scheduled Tasks</span>
        </button>
      </nav>

      {/* Project tree header */}
      <div className="mt-4 mb-1 flex h-6 items-center px-2">
        <span className="text-[12px] font-medium text-[#707070]">Projects</span>
        <span className="ml-auto flex items-center gap-2">
          <button
            className={`flex items-center justify-center rounded p-0.5 opacity-60 transition-all hover:opacity-100 ${sortAZ ? "text-[#388BFD]" : "text-[#9CA3AF]"}`}
            onClick={() => setSortAZ(!sortAZ)}
            title="Sort A–Z / by date"
          >
            <ListFilter size={14} strokeWidth={1.5} />
          </button>
          <button
            className="flex items-center justify-center rounded p-0.5 text-[#9CA3AF] opacity-60 transition-all hover:opacity-100"
            onClick={onNewProject}
            title="New project"
          >
            <FolderPlus size={14} strokeWidth={1.5} />
          </button>
        </span>
      </div>

      {/* Tree view (scrollable) */}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden [scrollbar-color:rgba(255,255,255,0.1)_transparent] [scrollbar-width:thin]">
        {sorted.map((p) => {
          const isOpen = !!expanded[p.name];
          return (
            <div key={p.name}>
              {/* Level 1 — project */}
              <button
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-[#cccccc] transition-colors hover:text-white"
                onClick={() => toggle(p.name)}
              >
                {isOpen ? (
                  <FolderOpen size={15} strokeWidth={1.5} className="shrink-0" />
                ) : (
                  <Folder size={15} strokeWidth={1.5} className="shrink-0" />
                )}
                <span className="truncate">{p.name}</span>
              </button>
              {/* Level 2 — conversations */}
              <AnimatePresence initial={false}>
                {isOpen && p.conversations.length > 0 && (
                  <motion.div
                    className="flex flex-col gap-0.5 overflow-hidden"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18, ease: "easeOut" }}
                  >
                    {p.conversations.map((c) => (
                      <button
                        key={c.id}
                        className={`flex h-8 items-center gap-2 rounded-md py-0 pr-2 text-left text-[13px] transition-colors ${
                          activeConversation === c.id && view === "chat"
                            ? "font-medium text-white"
                            : "text-[#cccccc] hover:text-white"
                        }`}
                        style={{ paddingLeft: "24px" }}
                        onClick={() => onSelectConversation(p.name, c.id)}
                      >
                        <MessageSquare size={15} strokeWidth={1.5} className="shrink-0" />
                        <span className="truncate">{c.title}</span>
                        <span className="ml-auto w-5 shrink-0 text-right font-mono text-[11px] text-[#6e6e6e]">
                          {c.age}
                        </span>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {/* Footer — Settings pinned to bottom */}
      <button
        className="mt-auto flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-[13px] text-[#cccccc] transition-colors hover:text-white"
        onClick={onOpenSettings}
      >
        <Settings size={16} strokeWidth={1.5} className="shrink-0" />
        <span>Settings</span>
      </button>

      <div className="sidebar__resizer" onMouseDown={startResize} />
    </aside>
  );
}

/* ---------- Collapsible task card ---------- */

function TaskCard({
  title,
  badge,
  children,
  defaultOpen = true,
}: {
  title: string;
  badge: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card task-card">
      <div className="task-card__head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="task-card__title">{title}</span>
        {badge}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="task-card__anim"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <div className="task-card__body">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- Diff viewer ---------- */

function DiffViewer({ file }: { file: string }) {
  const [decision, setDecision] = useState<"none" | "accepted" | "rejected">("none");
  return (
    <div className="diff">
      <div className="diff__header">
        <span className="diff__file mono">{file}</span>
        <span className="badge badge--add">+4</span>
        <span className="badge badge--del">-2</span>
        <div className="diff__actions">
          {decision === "none" ? (
            <>
              <button className="btn" onClick={() => setDecision("accepted")}>
                <Check size={12} /> Accept
              </button>
              <button className="btn" onClick={() => setDecision("rejected")}>
                <X size={12} /> Reject
              </button>
              <button className="btn">
                <Eye size={12} /> Review
              </button>
            </>
          ) : (
            <span className={`badge badge--${decision === "accepted" ? "add" : "del"}`}>{decision}</span>
          )}
        </div>
      </div>
      {DIFF.map((l, i) => (
        <div key={i} className={`diff__line diff__line--${l.kind}`}>
          {l.no !== undefined && <span className="diff__no">{l.no}</span>}
          <span>{l.text}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- Collapsible message ---------- */

function MessageBody({ text }: { text: string }) {
  const long = text.length > 280 || text.split("\n").length > 6;
  const [open, setOpen] = useState(!long);
  return (
    <div className="msg__body-wrap" onClick={() => long && setOpen(!open)}>
      <div className={`msg__body ${!open ? "msg__body--clamped" : ""}`}>{text}</div>
      {long && (
        <span className="msg__expand">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {open ? "Collapse" : "Expand"}
        </span>
      )}
    </div>
  );
}

/* ---------- Chat body ---------- */

function ChatBody() {
  const steps: Array<[string, "done" | "run" | "todo"]> = [
    ["Locate rate-limit handling in router", "done"],
    ["Implement 429 fallback loop", "done"],
    ["Run terminal tests (pnpm test)", "run"],
    ["Commit changes", "todo"],
  ];
  return (
    <>
      <div className="msg msg--user">
        <MessageBody
          text={"/fix Rate limits on the official gateway cause task failures — add a fallback strategy. @src"}
        />
      </div>

      <div className="msg">
        <div className="msg__role">Agent · DeepSeek V4</div>
        <MessageBody
          text={`Found the issue: ModelRouter only ever used the first provider and never retried on 429.

Root cause analysis:
- providers[0] hardcoded in route()
- no fallback strategy on rate limits
- no network error handling

Plan: iterate over all gateways, retry on 429, fail fast on other errors.`}
        />

        <TaskCard title="Walkthrough — Model Router fallback" badge={<span className="badge badge--run">running</span>}>
          {steps.map(([text, st]) => (
            <div key={text} className="task-card__step">
              {st === "done" ? (
                <Check size={14} color="var(--diff-add)" />
              ) : st === "run" ? (
                <CircleDot size={14} color="var(--accent-primary)" />
              ) : (
                <Circle size={14} color="var(--text-muted)" />
              )}
              <span style={{ color: st === "todo" ? "var(--text-muted)" : undefined }}>{text}</span>
              {st === "run" && <span className="badge badge--run">step 3/4</span>}
            </div>
          ))}
        </TaskCard>

        <DiffViewer file="src/router/fallback.ts" />

        <TaskCard title="Terminal — pnpm test" badge={<span className="badge badge--add">exit 0</span>} defaultOpen={false}>
          <div className="term">
            <div><span className="term__prompt">$ pnpm test</span></div>
            <div>вњ“ router/fallback (12 tests) 843ms</div>
            <div>Test Files 1 passed (1)</div>
          </div>
        </TaskCard>
      </div>
    </>
  );
}

/* ---------- Model selector (grouped by gateway, submenu flies right) ---------- */

function ModelSelector({
  gatewayId,
  modelId,
  onSelect,
}: {
  gatewayId: string;
  modelId: string;
  onSelect: (gatewayId: string, modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hoveredGw, setHoveredGw] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const gw = GATEWAYS.find((g) => g.id === gatewayId)!;
  const model = gw.models.find((m) => m.id === modelId)!;

  return (
    <div className="dropdown" ref={ref}>
      <span className="prompt-chip" onClick={() => setOpen(!open)}>
        <Zap size={12} strokeWidth={1.5} /> {model.name}
        <span className="prompt-chip__meta">· {gw.name.split(" ·")[0]}</span>
        <ChevronDown size={12} />
      </span>
      <AnimatePresence>
        {open && (
          <motion.div
            className="dropdown__menu"
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            {GATEWAYS.map((g) => (
              <div
                key={g.id}
                className="dropdown__gw"
                onMouseEnter={() => setHoveredGw(g.id)}
                onClick={() => setHoveredGw(g.id)}
              >
                <button className="dropdown__item">
                  <span>{g.name.split(" ·")[0]}</span>
                  {g.id === gatewayId && <Check size={12} />}
                  <ChevronRight size={12} className="dropdown__item-meta" />
                </button>
                <AnimatePresence>
                  {hoveredGw === g.id && (
                    <motion.div
                      className="dropdown__submenu"
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -6 }}
                      transition={{ duration: 0.12, ease: "easeOut" }}
                    >
                      {g.models.map((m) => (
                        <button
                          key={m.id}
                          className={`dropdown__item ${
                            g.id === gatewayId && m.id === modelId ? "dropdown__item--active" : ""
                          }`}
                          onClick={() => {
                            onSelect(g.id, m.id);
                            setOpen(false);
                            setHoveredGw(null);
                          }}
                        >
                          <span className="mono">{m.name}</span>
                          <span className="dropdown__item-meta">{m.meta}</span>
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- Project picker (for new chat) ---------- */

function ProjectPicker({
  projects,
  project,
  onSelect,
}: {
  projects: Project[];
  project: string;
  onSelect: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  return (
    <div className="dropdown" ref={ref}>
      <button
        className="flex h-8 items-center gap-1.5 bg-transparent px-1 text-[13px] font-medium text-[#D4D4D8] transition-colors hover:text-white"
        onClick={() => setOpen(!open)}
      >
        <Folder size={15} strokeWidth={1.5} className="text-[#9CA3AF]" />
        {project}
        <ChevronDown size={12} className="text-[#71717A]" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="dropdown__menu dropdown__menu--down"
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            {projects.map((p) => (
              <button
                key={p.name}
                className={`dropdown__item ${p.name === project ? "dropdown__item--active" : ""}`}
                onClick={() => {
                  onSelect(p.name);
                  setOpen(false);
                }}
              >
                <Folder size={14} />
                <span className="truncate">{p.name}</span>
                {p.name === project && <Check size={12} className="dropdown__item-meta" />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- Prompt box ---------- */

function PromptBox({
  onSend,
  projects,
  project,
  onSelectProject,
  centered,
}: {
  onSend: (text: string) => void;
  projects: Project[];
  project: string;
  onSelectProject: (name: string) => void;
  centered?: boolean;
}) {
  const [text, setText] = useState("");
  const [gatewayId, setGatewayId] = useState("dsh");
  const [modelId, setModelId] = useState("deepseek-v4");
  const [turbo, setTurbo] = useState(true);
  const ref = useRef<HTMLTextAreaElement>(null);

  const autoGrow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const send = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText("");
    requestAnimationFrame(autoGrow);
  };

  return (
    <div className={`inputbox-wrap ${centered ? "inputbox-wrap--centered" : ""}`}>
      <div className="inputbox-col">
        {centered && (
          <div className="inputbox-project">
            <ProjectPicker projects={projects} project={project} onSelect={onSelectProject} />
          </div>
        )}
        <div className="inputbox">
          <textarea
            ref={ref}
            className="inputbox__textarea"
            rows={1}
            placeholder="Ask anything…  /commands   @files @folders @terminal @git"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              autoGrow();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="inputbox__bottom">
            <ModelSelector
              gatewayId={gatewayId}
              modelId={modelId}
              onSelect={(g, m) => {
                setGatewayId(g);
                setModelId(m);
              }}
            />
            <span
              className="prompt-chip prompt-chip--context"
              onClick={() => setTurbo(!turbo)}
              title="Turbo / Auto-Pilot vs Safe / Supervised"
            >
              {turbo ? <Zap size={12} /> : <Shield size={12} />}
              {turbo ? "Turbo" : "Safe"}
            </span>
            <span className="prompt-chip prompt-chip--context" title="Context: local workspace">
              <Folder size={12} strokeWidth={1.5} />
              Local
              <ChevronDown size={12} />
            </span>
            <span className="inputbox__spacer" />
            <button className="prompt-mic" title="Voice input">
              <Mic size={15} strokeWidth={1.5} />
            </button>
            <button className="prompt-send" onClick={send} disabled={!text.trim()} title="Send">
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- History view (shown in chat area) ---------- */

function HistoryView({
  projects,
  onOpen,
}: {
  projects: Project[];
  onOpen: (project: string, convId: string) => void;
}) {
  const all = projects.flatMap((p) => p.conversations.map((c) => ({ p: p.name, c })));
  return (
    <motion.div
      className="view-panel"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      <div className="view-panel__title">
        <History size={18} strokeWidth={1.5} /> Conversation History
      </div>
      <div className="view-panel__hint">All conversations across projects</div>
      {all.length === 0 && <div className="view-panel__empty">No conversations yet</div>}
      {projects.map((p) => {
        const convs = p.conversations;
        if (convs.length === 0) return null;
        return (
          <div key={p.name} className="view-group">
            <div className="view-group__title">
              <Folder size={14} strokeWidth={1.5} /> {p.name}
            </div>
            {convs.map((c) => (
              <button key={c.id} className="view-row" onClick={() => onOpen(p.name, c.id)}>
                <MessageSquare size={16} strokeWidth={1.5} className="shrink-0" />
                <span className="truncate">{c.title}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-[#6e6e6e]">{c.age}</span>
              </button>
            ))}
          </div>
        );
      })}
    </motion.div>
  );
}

/* ---------- Scheduled tasks view (shown in chat area) ---------- */

function TasksView({
  scheduled,
  onScheduleTask,
}: {
  scheduled: string[];
  onScheduleTask: () => void;
}) {
  return (
    <motion.div
      className="view-panel"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      <div className="view-panel__title">
        <Timer size={18} strokeWidth={1.5} /> Scheduled Tasks
        <button className="btn ml-auto" onClick={onScheduleTask}>
          <CalendarClock size={14} /> Schedule Task
        </button>
      </div>
      <div className="view-panel__hint">Recurring agent jobs</div>
      {scheduled.length === 0 && <div className="view-panel__empty">No scheduled tasks</div>}
      {scheduled.map((s) => (
        <div key={s} className="view-row view-row--static">
          <Clock size={16} strokeWidth={1.5} className="shrink-0" />
          <span className="truncate font-mono">{s}</span>
          <span className="badge badge--run ml-auto shrink-0">active</span>
        </div>
      ))}
    </motion.div>
  );
}

/* ---------- Modal shell (Motion) ---------- */

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <AnimatePresence>
      <motion.div
        className="modal-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={onClose}
      >
        <motion.div
          className="modal"
          initial={{ opacity: 0, y: 16, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.97 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal__head">
            <span className="modal__title">{title}</span>
            <button className="btn modal__close" onClick={onClose} title="Close">
              <X size={14} />
            </button>
          </div>
          <div className="modal__body">{children}</div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

/* ---------- Settings modal (two-column layout) ---------- */

const THEMES: Theme[] = ["dark", "light", "slate", "amoled"];

type SettingsSection = "general" | "execution" | "permissions" | "behavior" | "projects";

function Segmented({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o} className={`seg__opt ${value === o ? "seg__opt--active" : ""}`} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}

function SettingRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="set-row__label">
        <div className="set-row__title">{title}</div>
        {hint && <div className="set-row__hint">{hint}</div>}
      </div>
      {children && <div className="set-row__ctrl">{children}</div>}
    </div>
  );
}

function SettingsModal({
  theme,
  onTheme,
  projects,
  onAddProject,
  onClose,
}: {
  theme: Theme;
  onTheme: (t: Theme) => void;
  projects: Project[];
  onAddProject: (name: string) => void;
  onClose: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>("general");
  const [sendMode, setSendMode] = useState("Queue");
  const [turboMode, setTurboMode] = useState("Turbo Mode");
  const [reviewPolicy, setReviewPolicy] = useState("Always Ask");
  const [autonomy, setAutonomy] = useState("Medium");
  const [stopOnError, setStopOnError] = useState(true);
  const [name, setName] = useState("");

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
        { id: "execution", label: "Execution" },
        { id: "behavior", label: "Agent Behavior" },
      ],
    },
    {
      group: "Projects",
      items: [
        { id: "permissions", label: "Permissions" },
        { id: "projects", label: "Manage Projects" },
      ],
    },
  ];

  const titles: Record<SettingsSection, [string, string]> = {
    general: ["General", "Appearance, theme and workspace defaults"],
    execution: ["Execution", "How agent tasks are queued and run"],
    behavior: ["Agent Behavior", "Autonomy, safety and review policies"],
    permissions: ["Global Permissions", "Tool and filesystem access rules"],
    projects: ["Manage Projects", "Create and organize project folders"],
  };

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <motion.div
        className="settings-modal"
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left column — categories */}
        <div className="settings-nav">
          {navItems.map((grp) => (
            <div key={grp.group}>
              <div className="settings-nav__group">{grp.group}</div>
              {grp.items.map((it) => (
                <button
                  key={it.id}
                  className={`settings-nav__item ${section === it.id ? "settings-nav__item--active" : ""}`}
                  onClick={() => setSection(it.id)}
                >
                  {it.label}
                </button>
              ))}
            </div>
          ))}
          <div className="settings-nav__profile">
            <div className="settings-nav__avatar">N</div>
            <div className="min-w-0">
              <div className="truncate text-[12px] font-bold text-white">nezuss</div>
              <div className="truncate text-[11px] text-[#6B7280]">nezuss@local</div>
            </div>
          </div>
        </div>

        {/* Right column — content */}
        <div className="settings-content">
          <div className="settings-content__head">
            <div>
              <div className="settings-content__title">{titles[section][0]}</div>
              <div className="settings-content__desc">{titles[section][1]}</div>
            </div>
            <button className="settings-close" onClick={onClose} title="Close">
              <X size={14} />
            </button>
          </div>

          {section === "general" && (
            <div className="settings-card">
              <SettingRow title="Theme" hint="Application color scheme">
                <Segmented options={THEMES} value={theme} onChange={(v) => onTheme(v as Theme)} />
              </SettingRow>
              <div className="settings-card__sep" />
              <SettingRow title="Send Behavior" hint="How submitted prompts are handled">
                <Segmented options={["Queue", "Send Immediately"]} value={sendMode} onChange={setSendMode} />
              </SettingRow>
              <div className="settings-card__sep" />
              <SettingRow title="Default Gateway" hint="Model provider for new conversations">
                <select className="settings-select" defaultValue="dsh">
                  {GATEWAYS.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name.split(" ·")[0]}
                    </option>
                  ))}
                </select>
              </SettingRow>
            </div>
          )}

          {section === "execution" && (
            <div className="settings-card">
              <SettingRow title="Run Mode" hint="Auto-pilot vs supervised execution">
                <select className="settings-select" value={turboMode} onChange={(e) => setTurboMode(e.target.value)}>
                  <option>Turbo Mode</option>
                  <option>Safe Mode</option>
                </select>
              </SettingRow>
              <div className="settings-card__sep" />
              <SettingRow title="Artifact Review Policy" hint="When diffs require human approval">
                <select className="settings-select" value={reviewPolicy} onChange={(e) => setReviewPolicy(e.target.value)}>
                  <option>Always Ask</option>
                  <option>Auto-accept</option>
                  <option>Reject by default</option>
                </select>
              </SettingRow>
              <div className="settings-card__sep" />
              <SettingRow title="Workspace" hint="Root folder opened for agents">
                <button className="settings-btn">Open</button>
              </SettingRow>
            </div>
          )}

          {section === "behavior" && (
            <div className="settings-card">
              <SettingRow title="Autonomy Level" hint="How much freedom agents get">
                <Segmented options={["Low", "Medium", "High"]} value={autonomy} onChange={setAutonomy} />
              </SettingRow>
              <div className="settings-card__sep" />
              <SettingRow title="Stop on Error" hint="Halt the pipeline when a step fails">
                <button
                  className={`settings-toggle ${stopOnError ? "settings-toggle--on" : ""}`}
                  onClick={() => setStopOnError(!stopOnError)}
                  aria-label="toggle"
                >
                  <span className="settings-toggle__knob" />
                </button>
              </SettingRow>
            </div>
          )}

          {section === "permissions" && (
            <div className="settings-card">
              <SettingRow title="Tool Permissions">
                <span className="settings-badge">59</span>
                <button className="settings-btn ml-2">Manage</button>
              </SettingRow>
              <div className="settings-card__sep" />
              <SettingRow title="Filesystem Access" hint="Scope of writable paths">
                <select className="settings-select" defaultValue="workspace">
                  <option value="workspace">Workspace only</option>
                  <option value="full">Full access</option>
                  <option value="none">Read-only</option>
                </select>
              </SettingRow>
            </div>
          )}

          {section === "projects" && (
            <>
              <div className="settings-card">
                <div className="settings-projects">
                  {projects.map((p) => (
                    <span key={p.name} className="settings-project-chip">
                      <Folder size={12} /> {p.name}
                      <span className="ml-auto font-mono text-[11px] text-[#6B7280]">{p.conversations.length}</span>
                    </span>
                  ))}
                </div>
              </div>
              <div className="settings-card mt-3">
                <SettingRow title="New project" hint="Adds a folder to the sidebar tree">
                  <input
                    className="settings-input"
                    placeholder="Project name…"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && add()}
                  />
                  <button className="settings-btn ml-2" onClick={add} disabled={!name.trim()}>
                    Add
                  </button>
                </SettingRow>
              </div>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}

/* ---------- Schedule Task modal ---------- */

function ScheduleModal({
  onAdd,
  onClose,
}: {
  onAdd: (task: string) => void;
  onClose: () => void;
}) {
  const [cmd, setCmd] = useState("");
  const [freq, setFreq] = useState("daily");
  const submit = () => {
    if (!cmd.trim()) return;
    onAdd(`${freq === "daily" ? "Nightly" : freq === "weekly" ? "Weekly" : "Once"} ${cmd.trim()}`);
    onClose();
  };
  return (
    <Modal title="Schedule Task" onClose={onClose}>
      <div className="settings__section">Command</div>
      <input
        className="settings__input mono"
        placeholder="/review @main"
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        autoFocus
      />
      <div className="settings__section">Frequency</div>
      <div className="settings__row">
        {["once", "daily", "weekly"].map((f) => (
          <button
            key={f}
            className={`chip mono ${freq === f ? "chip--active" : ""}`}
            onClick={() => setFreq(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="settings__actions">
        <button className="btn btn--primary" onClick={submit} disabled={!cmd.trim()}>
          <CalendarClock size={14} /> Schedule
        </button>
      </div>
    </Modal>
  );
}

/* ---------- App ---------- */

export default function App() {
  const [draftMsgs, setDraftMsgs] = useState<Msg[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [theme, setTheme] = useState<Theme>("dark");
  const [projects, setProjects] = useState<Project[]>(INITIAL_PROJECTS);
  const [scheduled, setScheduled] = useState<string[]>(INITIAL_SCHEDULED);
  const [modal, setModal] = useState<"none" | "settings" | "schedule">("none");
  const [view, setView] = useState<ViewKind>("chat");
  const [activeConv, setActiveConv] = useState<{ project: string; id: string } | null>({
    project: "Singularity",
    id: "fix-terminal-tests",
  });
  const [newChatProject, setNewChatProject] = useState("Singularity");
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [draftMsgs, activeConv, view]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      setSidebarWidth(Math.min(Math.max(startW + ev.clientX - startX, 220), 480));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const activeTitle = (() => {
    if (view === "history") return "Conversation History";
    if (view === "tasks") return "Scheduled Tasks";
    if (!activeConv) return "New Conversation";
    for (const p of projects) {
      const c = p.conversations.find((c) => c.id === activeConv.id);
      if (c) return c.title;
    }
    return "New Conversation";
  })();

  const openConversation = (project: string, id: string) => {
    setActiveConv({ project, id });
    setDraftMsgs([]);
    setView("chat");
  };

  const isNewChat = view === "new";

  return (
    <div className="app-col">
      <TitleBar />
      <div className="app">
        <Sidebar
          width={sidebarWidth}
          startResize={startResize}
          projects={projects}
          activeConversation={activeConv?.id ?? null}
          view={view}
          onSelectConversation={openConversation}
          onNewConversation={() => {
            setActiveConv(null);
            setDraftMsgs([]);
            setView("new");
          }}
          onShowView={(v) => setView(v)}
          onOpenSettings={() => setModal("settings")}
          onNewProject={() => setModal("settings")}
        />
        <div className="main">
          {view !== "new" && (
            <div className="main__header">
              {activeTitle}
              {view === "chat" && activeConv && <span className="badge badge--run">agent active</span>}
            </div>
          )}
          {view === "history" && (
            <div className="chat">
              <HistoryView projects={projects} onOpen={openConversation} />
            </div>
          )}
          {view === "tasks" && (
            <div className="chat">
              <TasksView scheduled={scheduled} onScheduleTask={() => setModal("schedule")} />
            </div>
          )}
          {isNewChat && (
            <div className="chat chat--centered">
              <motion.div
                className="prompt-centered"
                initial={{ opacity: 0, y: 16, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.25, ease: "easeOut" }}
              >
                <PromptBox
                  centered
                  projects={projects}
                  project={newChatProject}
                  onSelectProject={setNewChatProject}
                  onSend={(text) => {
                    setActiveConv({ project: newChatProject, id: `new-${Date.now()}` });
                    setDraftMsgs([{ role: "user", text }]);
                    setView("chat");
                  }}
                />
              </motion.div>
            </div>
          )}
          {view === "chat" && (
            <>
              <div className="chat" ref={chatRef}>
                <div className="chat__inner" key={activeConv?.id ?? "new"}>
                  {activeConv?.id === "fix-terminal-tests" && <ChatBody />}
                  <AnimatePresence initial={false}>
                    {draftMsgs.map((m, i) => (
                      <motion.div
                        key={i}
                        className={`msg ${m.role === "user" ? "msg--user" : ""}`}
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2, ease: "easeOut" }}
                      >
                        {m.role === "agent" && <div className="msg__role">Agent</div>}
                        <MessageBody text={m.text} />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
              <PromptBox
                onSend={(text) => setDraftMsgs((prev) => [...prev, { role: "user", text }])}
                projects={projects}
                project={activeConv?.project ?? "Singularity"}
                onSelectProject={() => {}}
              />
            </>
          )}
        </div>

        {modal === "settings" && (
          <SettingsModal
            theme={theme}
            onTheme={setTheme}
            projects={projects}
            onAddProject={(n) => setProjects((p) => [...p, { name: n, conversations: [] }])}
            onClose={() => setModal("none")}
          />
        )}
        {modal === "schedule" && (
          <ScheduleModal
            onAdd={(t) => setScheduled((s) => [...s, t])}
            onClose={() => setModal("none")}
          />
        )}
      </div>
    </div>
  );
}
