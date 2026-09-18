import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Plus,
  MessageSquare,
  Folder,
  FolderOpen,
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
  Mic,
} from "lucide-react";

/* ---------- Shared class fragments (single source of truth) ---------- */

/** Sidebar / titlebar row: h 32px, padding 0 8px, radius 6px, gap 10px */
const ROW = "flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-[13px]";
/** Hover: text brightens only (no background) */
const ROW_TEXT = "text-[var(--text-muted)] transition-colors hover:text-[var(--text-main)]";
/** Hover + active: background highlight (used by nav / settings) */
const ROW_HOVER =
  "text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";
/** Active row: background highlight only (no other changes) */
const ROW_ACTIVE = "bg-[var(--hover-bg)]";
/** Chip in prompt box: h 28px, padding 0 10px, radius 6px, 12px */
const CHIP =
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";
/** Context chip: h 24px, padding 0 8px, 11px */
const CHIP_CTX =
  "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px] text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";
/** Small theme-aware button (settings / panels) */
const SBUTTON =
  "flex h-[30px] shrink-0 items-center justify-center rounded-md bg-[var(--bg-elevated)] px-3 text-[12px] text-[var(--text-main)] transition-colors hover:bg-[var(--bg-input)] disabled:cursor-not-allowed disabled:opacity-50";
/** Select in settings */
const SSELECT =
  "h-8 min-w-[130px] cursor-pointer rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 text-[12px] text-[var(--text-main)] outline-none";
/** Text input in settings */
const SINPUT =
  "h-8 w-[180px] rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2.5 text-[12px] text-[var(--text-main)] outline-none focus:border-[var(--accent)]";

/* ---------- Scroll indicator hook ----------
   Adds `.scrolling` to the scrolled element while the user is actively
   scrolling, so the thumb only appears then (plus on hover). */

function useScrollIndicator<T extends HTMLElement>(extraRef?: React.RefObject<T>) {
  const localRef = useRef<T>(null);
  const ref = (extraRef ?? localRef) as React.RefObject<T>;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: number | undefined;
    const onScroll = () => {
      el.classList.add("scrolling");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => el.classList.remove("scrolling"), 900);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.clearTimeout(timer);
    };
  }, [ref]);
  return ref;
}

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
  age: string;
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

/* ---------- Custom title bar ---------- */

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
    <div
      ref={barRef}
      data-tauri-drag-region
      className="flex h-[34px] shrink-0 select-none items-center bg-[var(--bg-titlebar)]"
    >
      {/* Left: app menu */}
      <div className="flex h-full items-center gap-1 pl-2">
        <span className="mr-0.5 px-2 text-[13px] font-semibold tracking-wide bg-gradient-to-r from-[#348867] to-[#64d5a4] bg-clip-text text-transparent">
          Singularity
        </span>
        {Object.keys(MENUS).map((m) => (
          <div key={m} className="relative flex h-full items-center">
            <button
              className={`mr-0.5 rounded px-2.5 py-1 text-[13px] transition-colors ${
                openMenu === m
                  ? "bg-[var(--hover-bg)] text-[var(--text-main)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
              }`}
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
                  className="absolute left-0 top-[calc(100%+4px)] z-[300] flex min-w-[200px] flex-col gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-1 shadow-[var(--shadow-popup)]"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.12 }}
                >
                  {MENUS[m].map((item) => (
                    <button
                      key={item}
                      className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
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
      <div className="h-full flex-1" data-tauri-drag-region />

      {/* Right: window controls — 54px wide, full height */}
      <div className="flex h-full items-stretch">
        <button
          className="flex w-[54px] items-center justify-center text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
          onClick={minimize}
          title="Minimize"
        >
          <Minus size={15} strokeWidth={1} />
        </button>
        <button
          className="flex w-[54px] items-center justify-center text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
          onClick={toggleMax}
          title={maximized ? "Restore" : "Maximize"}
        >
          {maximized ? <Copy size={13} strokeWidth={1} /> : <Square size={13} strokeWidth={1} />}
        </button>
        <button
          className="flex w-[54px] items-center justify-center text-[var(--text-muted)] transition-colors hover:bg-[#E81123] hover:text-white"
          onClick={close}
          title="Close"
        >
          <X size={15} strokeWidth={1.2} />
        </button>
      </div>
    </div>
  );
}

/* ---------- Sidebar ---------- */

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
  const listRef = useScrollIndicator<HTMLDivElement>();

  const toggle = (name: string) => setExpanded((e) => ({ ...e, [name]: !e[name] }));
  const sorted = sortAZ ? [...projects].sort((a, b) => a.name.localeCompare(b.name)) : projects;

  return (
    <aside
      className="relative flex shrink-0 flex-col bg-[var(--bg-sidebar)] text-[13px] leading-tight"
      style={{ width: `${width}px` }}
    >
      {/* Header block (fixed — scrollbar never overlaps it) */}
      <div className="px-2.5 pt-3">
        <button
          className="mb-2 flex h-9 w-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 text-left text-[13px] font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
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

      {/* Projects header */}
      <div className="mb-1 mt-6 flex h-6 shrink-0 items-center px-[18px]">
        <span className="text-[12px] font-medium text-[var(--text-dim)]">Projects</span>
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

      {/* Tree — the scrollbar sits flush against the sidebar edge,
          so the horizontal padding lives on this scrolling element. */}
      <div
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-2.5"
        ref={listRef}
      >
        {sorted.map((p) => {
          const isOpen = !!expanded[p.name];
          return (
            <div key={p.name}>
              <button className={`${ROW} w-full ${ROW_TEXT}`} onClick={() => toggle(p.name)}>
                {isOpen ? (
                  <FolderOpen size={15} strokeWidth={1.5} className="shrink-0" />
                ) : (
                  <Folder size={15} strokeWidth={1.5} className="shrink-0" />
                )}
                <span className="truncate">{p.name}</span>
              </button>

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
                        className={`${ROW} pl-6 ${
                          activeConversation === c.id && view === "chat" ? ROW_ACTIVE : ROW_HOVER
                        }`}
                        onClick={() => onSelectConversation(p.name, c.id)}
                      >
                        <span className="truncate">{c.title}</span>
                        <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--text-dim)]">
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

      {/* Footer: Settings (fixed) */}
      <div className="px-2.5 pb-3 pt-1">
        <button className={`${ROW} w-full ${ROW_HOVER}`} onClick={onOpenSettings}>
          <Settings size={16} strokeWidth={1.5} className="shrink-0" />
          <span>Settings</span>
        </button>
      </div>

      <div className="sidebar-resizer" onMouseDown={startResize} />
    </aside>
  );
}

/* ---------- Badge ---------- */

function Badge({ kind, children }: { kind: "add" | "del" | "run"; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] ${
        kind === "add" ? "badge-add" : kind === "del" ? "badge-del" : "badge-run"
      }`}
    >
      {children}
    </span>
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
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-surface)]">
      <div
        className="flex cursor-pointer select-none items-center gap-2 border-b border-[var(--border)] px-3 py-2"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="flex-1 font-semibold">{title}</span>
        {badge}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <div className="flex flex-col gap-2 p-3">{children}</div>
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
    <div className="max-w-full overflow-x-auto rounded-xl border border-[var(--border)] font-mono text-[13px] leading-normal">
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2">
        <span className="flex-1 text-[12px]">{file}</span>
        <Badge kind="add">+4</Badge>
        <Badge kind="del">-2</Badge>
        <div className="flex gap-2">
          {decision === "none" ? (
            <>
              <button className={`${SBUTTON} h-6 px-2 text-[11px]`} onClick={() => setDecision("accepted")}>
                <Check size={12} className="mr-1" /> Accept
              </button>
              <button className={`${SBUTTON} h-6 px-2 text-[11px]`} onClick={() => setDecision("rejected")}>
                <X size={12} className="mr-1" /> Reject
              </button>
              <button className={`${SBUTTON} h-6 px-2 text-[11px]`}>
                <Eye size={12} className="mr-1" /> Review
              </button>
            </>
          ) : (
            <Badge kind={decision === "accepted" ? "add" : "del"}>{decision}</Badge>
          )}
        </div>
      </div>
      {DIFF.map((l, i) => (
        <div
          key={i}
          className={`flex whitespace-pre px-2 ${
            l.kind === "add" ? "diff-line--add" : l.kind === "del" ? "diff-line--del" : ""
          } ${l.kind === "hunk" ? "bg-[var(--bg-surface)] py-0.5 text-[var(--text-dim)]" : ""}`}
        >
          {l.no !== undefined && (
            <span className="w-11 shrink-0 select-none text-[var(--text-dim)]">{l.no}</span>
          )}
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
    <div className="flex min-w-0 max-w-full flex-col gap-1" onClick={() => long && setOpen(!open)}>
      <div
        className={`min-w-0 max-w-full whitespace-pre-wrap break-words leading-relaxed text-[var(--text-main)] ${
          open ? "" : "line-clamp-4"
        }`}
      >
        {text}
      </div>
      {long && (
        <span className="flex items-center gap-1 self-start text-[11px] text-[var(--accent)]">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {open ? "Collapse" : "Expand"}
        </span>
      )}
    </div>
  );
}

/* ---------- Unified chat message row ---------- */

function ChatMessage({ role, text }: { role: "user" | "agent"; text: string }) {
  if (role === "user") {
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-[85%] rounded-xl border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2 text-left">
          <MessageBody text={text} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-dim)]">Agent</div>
      <MessageBody text={text} />
    </div>
  );
}

/* ---------- Demo conversation ---------- */

function ChatBody() {
  const steps: Array<[string, "done" | "run" | "todo"]> = [
    ["Locate rate-limit handling in router", "done"],
    ["Implement 429 fallback loop", "done"],
    ["Run terminal tests (pnpm test)", "run"],
    ["Commit changes", "todo"],
  ];
  return (
    <>
      <ChatMessage
        role="user"
        text="/fix Rate limits on the official gateway cause task failures — add a fallback strategy. @src"
      />

      <div className="flex flex-col gap-2">
        <div className="text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
          Agent · DeepSeek V4
        </div>
        <MessageBody
          text={`Found the issue: ModelRouter only ever used the first provider and never retried on 429.

Root cause analysis:
- providers[0] hardcoded in route()
- no fallback strategy on rate limits
- no network error handling

Plan: iterate over all gateways, retry on 429, fail fast on other errors.`}
        />

        <TaskCard title="Walkthrough — Model Router fallback" badge={<Badge kind="run">running</Badge>}>
          {steps.map(([text, st]) => (
            <div key={text} className="flex items-center gap-2 rounded-lg px-2 py-1">
              {st === "done" ? (
                <Check size={14} color="var(--diff-add)" />
              ) : st === "run" ? (
                <CircleDot size={14} color="var(--accent)" />
              ) : (
                <Circle size={14} color="var(--text-dim)" />
              )}
              <span className={st === "todo" ? "text-[var(--text-dim)]" : ""}>{text}</span>
              {st === "run" && <Badge kind="run">step 3/4</Badge>}
            </div>
          ))}
        </TaskCard>

        <DiffViewer file="src/router/fallback.ts" />

        <TaskCard title="Terminal — pnpm test" badge={<Badge kind="add">exit 0</Badge>} defaultOpen={false}>
          <div className="max-w-full overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--bg-sidebar)] p-3 font-mono text-[13px] leading-normal text-[var(--text-main)]">
            <div className="text-[var(--text-dim)]">$ pnpm test</div>
            <div>OK router/fallback (12 tests) 843ms</div>
            <div>Test Files 1 passed (1)</div>
          </div>
        </TaskCard>
      </div>
    </>
  );
}

/* ---------- Shared menu bits ---------- */

const MENU_ITEM =
  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]";

/* ---------- Model selector (gateways → submenu flies right) ---------- */

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
    <div className="relative" ref={ref}>
      <span className={CHIP} onClick={() => setOpen(!open)}>
        <Zap size={12} strokeWidth={1.5} />
        {model.name}
        <span className="text-[var(--text-dim)]">· {gw.name.split(" ·")[0]}</span>
        <ChevronDown size={12} />
      </span>
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute bottom-[calc(100%+8px)] left-0 z-[200] flex min-w-[240px] flex-col gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-2 shadow-[var(--shadow-popup)]"
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            {GATEWAYS.map((g) => (
              <div
                key={g.id}
                className="relative"
                onMouseEnter={() => setHoveredGw(g.id)}
                onClick={() => setHoveredGw(g.id)}
              >
                <button className={MENU_ITEM}>
                  <span>{g.name.split(" ·")[0]}</span>
                  {g.id === gatewayId && <Check size={12} />}
                  <ChevronRight size={12} className="ml-auto text-[var(--text-dim)]" />
                </button>
                <AnimatePresence>
                  {hoveredGw === g.id && (
                    <motion.div
                      className="absolute bottom-[-4px] left-[calc(100%+4px)] z-[210] flex min-w-[220px] flex-col gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-2 shadow-[var(--shadow-popup)]"
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -6 }}
                      transition={{ duration: 0.12, ease: "easeOut" }}
                    >
                      {g.models.map((m) => (
                        <button
                          key={m.id}
                          className={`${MENU_ITEM} ${g.id === gatewayId && m.id === modelId ? "bg-[var(--hover-bg)]" : ""}`}
                          onClick={() => {
                            onSelect(g.id, m.id);
                            setOpen(false);
                            setHoveredGw(null);
                          }}
                        >
                          <span className="font-mono">{m.name}</span>
                          <span className="ml-auto text-[11px] text-[var(--text-dim)]">{m.meta}</span>
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

/* ---------- Project breadcrumb picker (new chat) ---------- */

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
    <div className="relative" ref={ref}>
      {/* Breadcrumb: h 32px, folder 15, name 13 medium, chevron 12 */}
      <button
        className="flex h-8 items-center gap-1.5 px-1 text-[13px] font-medium text-[var(--text-main)] transition-colors hover:text-[var(--accent)]"
        onClick={() => setOpen(!open)}
      >
        <Folder size={15} strokeWidth={1.5} className="text-[var(--text-muted)]" />
        {project}
        <ChevronDown size={12} className="text-[var(--text-dim)]" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute left-1/2 top-[calc(100%+8px)] z-[200] flex max-h-[260px] min-w-[240px] -translate-x-1/2 flex-col gap-0.5 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-2 shadow-[var(--shadow-popup)]"
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            {projects.map((p) => (
              <button
                key={p.name}
                className={`${MENU_ITEM} ${p.name === project ? "bg-[var(--hover-bg)]" : ""} py-2`}
                onClick={() => {
                  onSelect(p.name);
                  setOpen(false);
                }}
              >
                <Folder size={14} />
                <span className="truncate">{p.name}</span>
                {p.name === project && <Check size={12} className="ml-auto text-[var(--text-dim)]" />}
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
    <div className={`flex w-full justify-center ${centered ? "" : "px-6 pb-4"}`}>
      <div className="flex w-full max-w-[760px] flex-col">
        {centered && (
          <div className="mb-4 flex justify-center">
            <ProjectPicker projects={projects} project={project} onSelect={onSelectProject} />
          </div>
        )}
        {/* min-h 108px, radius 16, theme surface + border */}
        <div className="flex min-h-[108px] w-full flex-col justify-between rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] transition-colors focus-within:border-[var(--accent)]">
          <textarea
            ref={ref}
            rows={1}
            className="max-h-[200px] min-h-[44px] w-full resize-none border-none bg-transparent px-4 pb-2 pt-3.5 text-[14px] leading-normal text-[var(--text-main)] outline-none placeholder:text-[var(--text-dim)]"
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
          {/* Toolbar: 6px 12px 10px, space-between */}
          <div className="flex items-center justify-between gap-1.5 px-3 pb-2.5 pt-1.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <ModelSelector
                gatewayId={gatewayId}
                modelId={modelId}
                onSelect={(g, m) => {
                  setGatewayId(g);
                  setModelId(m);
                }}
              />
              <span
                className={CHIP_CTX}
                onClick={() => setTurbo(!turbo)}
                title="Turbo / Auto-Pilot vs Safe / Supervised"
              >
                {turbo ? <Zap size={12} strokeWidth={1.5} /> : <Shield size={12} strokeWidth={1.5} />}
                {turbo ? "Turbo" : "Safe"}
              </span>
              <span className={CHIP_CTX} title="Context: local workspace">
                <Folder size={12} strokeWidth={1.5} />
                Local
                <ChevronDown size={12} />
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <button
                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                title="Voice input"
              >
                <Mic size={15} strokeWidth={1.5} />
              </button>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)] text-white transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:bg-[var(--bg-elevated)] disabled:text-[var(--text-dim)]"
                onClick={send}
                disabled={!text.trim()}
                title="Send"
              >
                <Send size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- History view ---------- */

function HistoryView({
  projects,
  onOpen,
}: {
  projects: Project[];
  onOpen: (project: string, convId: string) => void;
}) {
  const all = projects.flatMap((p) => p.conversations);
  return (
    <motion.div
      className="mx-auto flex w-full max-w-[760px] flex-col"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      <div className="flex items-center gap-2 text-[18px] font-semibold text-[var(--text-main)]">
        <History size={18} strokeWidth={1.5} /> Conversation History
      </div>
      <div className="mb-4 mt-1 text-[13px] text-[var(--text-muted)]">
        All conversations across projects
      </div>
      {all.length === 0 && (
        <div className="p-6 text-center text-[var(--text-muted)]">No conversations yet</div>
      )}
      {projects.map((p) => {
        if (p.conversations.length === 0) return null;
        return (
          <div key={p.name} className="mb-4">
            <div className="mb-1 flex items-center gap-2 px-2 py-1 text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
              <Folder size={14} strokeWidth={1.5} /> {p.name}
            </div>
            {p.conversations.map((c) => (
              <button
                key={c.id}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-3 text-left text-[13px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
                onClick={() => onOpen(p.name, c.id)}
              >
                <MessageSquare size={16} strokeWidth={1.5} className="shrink-0" />
                <span className="truncate">{c.title}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--text-dim)]">
                  {c.age}
                </span>
              </button>
            ))}
          </div>
        );
      })}
    </motion.div>
  );
}

/* ---------- Scheduled tasks view ---------- */

function TasksView({
  scheduled,
  onScheduleTask,
}: {
  scheduled: string[];
  onScheduleTask: () => void;
}) {
  return (
    <motion.div
      className="mx-auto flex w-full max-w-[760px] flex-col"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      <div className="flex items-center gap-2 text-[18px] font-semibold text-[var(--text-main)]">
        <Timer size={18} strokeWidth={1.5} /> Scheduled Tasks
        <button className={`${SBUTTON} ml-auto`} onClick={onScheduleTask}>
          <CalendarClock size={14} className="mr-1.5" /> Schedule Task
        </button>
      </div>
      <div className="mb-4 mt-1 text-[13px] text-[var(--text-muted)]">Recurring agent jobs</div>
      {scheduled.length === 0 && (
        <div className="p-6 text-center text-[var(--text-muted)]">No scheduled tasks</div>
      )}
      {scheduled.map((s) => (
        <div
          key={s}
          className="flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] text-[var(--text-main)]"
        >
          <Clock size={16} strokeWidth={1.5} className="shrink-0" />
          <span className="truncate font-mono">{s}</span>
          <span className="ml-auto shrink-0">
            <Badge kind="run">active</Badge>
          </span>
        </div>
      ))}
    </motion.div>
  );
}

/* ---------- Small modal shell (Schedule Task) ---------- */

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
    <motion.div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
    >
      <motion.div
        className="flex w-[min(480px,calc(100vw-48px))] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] shadow-[var(--shadow-popup)]"
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.97 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center border-b border-[var(--border)] px-5 py-4">
          <span className="flex-1 text-[20px] font-semibold text-[var(--text-main)]">{title}</span>
          <button
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
            onClick={onClose}
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex flex-col gap-2 px-5 pb-5 pt-4">{children}</div>
      </motion.div>
    </motion.div>
  );
}

/* ---------- Settings modal (two-column) ---------- */

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
    <div className="flex h-[30px] items-center gap-0.5 rounded-md bg-[var(--bg-input)] p-0.5">
      {options.map((o) => (
        <button
          key={o}
          className={`h-full whitespace-nowrap rounded px-2.5 text-[12px] transition-colors ${
            value === o
              ? "bg-[var(--bg-elevated)] text-[var(--text-main)]"
              : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
          }`}
          onClick={() => onChange(o)}
        >
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
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-[var(--text-main)]">{title}</div>
        {hint && <div className="mt-0.5 text-[12px] text-[var(--text-dim)]">{hint}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center">{children}</div>}
    </div>
  );
}

function SettingsCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3.5">
      {children}
    </div>
  );
}

function Sep() {
  return <div className="h-px bg-[var(--border-soft)]" />;
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
    <motion.div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/65 backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
    >
      <motion.div
        className="flex h-[min(580px,calc(100vh-48px))] w-[min(820px,calc(100vw-48px))] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-app)] shadow-[0_25px_50px_-12px_rgba(0,0,0,0.7)]"
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left column — categories */}
        <div className="flex w-[210px] shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] px-3 py-4">
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
          <div className="mt-auto flex items-center gap-2.5 border-t border-[var(--border)] pt-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[12px] font-semibold text-white">
              N
            </div>
            <div className="min-w-0">
              <div className="truncate text-[12px] font-bold text-[var(--text-main)]">nezuss</div>
              <div className="truncate text-[11px] text-[var(--text-dim)]">nezuss@local</div>
            </div>
          </div>
        </div>

        {/* Right column — content */}
        <div className="flex-1 overflow-y-auto px-7 py-6">
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
                <Segmented options={["Queue", "Send Immediately"]} value={sendMode} onChange={setSendMode} />
              </SettingRow>
              <Sep />
              <SettingRow title="Default Gateway" hint="Model provider for new conversations">
                <select className={SSELECT} defaultValue="dsh">
                  {GATEWAYS.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name.split(" ·")[0]}
                    </option>
                  ))}
                </select>
              </SettingRow>
            </SettingsCard>
          )}

          {section === "execution" && (
            <SettingsCard>
              <SettingRow title="Run Mode" hint="Auto-pilot vs supervised execution">
                <select className={SSELECT} value={turboMode} onChange={(e) => setTurboMode(e.target.value)}>
                  <option>Turbo Mode</option>
                  <option>Safe Mode</option>
                </select>
              </SettingRow>
              <Sep />
              <SettingRow title="Artifact Review Policy" hint="When diffs require human approval">
                <select
                  className={SSELECT}
                  value={reviewPolicy}
                  onChange={(e) => setReviewPolicy(e.target.value)}
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
                <Segmented options={["Low", "Medium", "High"]} value={autonomy} onChange={setAutonomy} />
              </SettingRow>
              <Sep />
              <SettingRow title="Stop on Error" hint="Halt the pipeline when a step fails">
                <button
                  className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                    stopOnError ? "bg-[var(--accent)]" : "bg-[var(--bg-elevated)]"
                  }`}
                  onClick={() => setStopOnError(!stopOnError)}
                  aria-label="toggle"
                >
                  <span
                    className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                      stopOnError ? "translate-x-[18px]" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </SettingRow>
            </SettingsCard>
          )}

          {section === "permissions" && (
            <SettingsCard>
              <SettingRow title="Tool Permissions">
                <span className="inline-flex h-[18px] items-center rounded-full bg-[var(--bg-elevated)] px-1.5 text-[11px] text-[var(--text-muted)]">
                  59
                </span>
                <button className={`${SBUTTON} ml-2`}>Manage</button>
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
                <div className="flex max-h-[300px] flex-col gap-1 overflow-y-auto">
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
                </div>
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
        </div>
      </motion.div>
    </motion.div>
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
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-dim)]">Command</div>
      <input
        className={`${SINPUT} w-full font-mono`}
        placeholder="/review @main"
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        autoFocus
      />
      <div className="mt-2 text-[11px] uppercase tracking-wide text-[var(--text-dim)]">Frequency</div>
      <div className="flex items-center gap-2">
        {["once", "daily", "weekly"].map((f) => (
          <button
            key={f}
            className={`h-7 rounded-md border px-2.5 font-mono text-[12px] transition-colors ${
              freq === f
                ? "border-[var(--accent)] bg-[var(--hover-bg)] text-[var(--text-main)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-main)]"
            }`}
            onClick={() => setFreq(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <button
          className="flex h-8 items-center rounded-lg bg-[var(--accent)] px-3 text-[13px] text-white transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={submit}
          disabled={!cmd.trim()}
        >
          <CalendarClock size={14} className="mr-1.5" /> Schedule
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
  // Hooks must run unconditionally, so all scroll areas get their indicator here.
  const historyRef = useScrollIndicator<HTMLDivElement>();
  const tasksRef = useScrollIndicator<HTMLDivElement>();
  const chatScrollRef = useScrollIndicator<HTMLDivElement>(chatRef);

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

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
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

        <div className="flex min-w-0 flex-1 flex-col bg-[var(--bg-app)]">
          {view !== "new" && (
            <div className="flex items-center gap-2 px-4 py-3 text-[16px] font-semibold text-[var(--text-main)]">
              {activeTitle}
              {view === "chat" && activeConv && <Badge kind="run">agent active</Badge>}
            </div>
          )}

          {view === "history" && (
            <div className="flex-1 overflow-y-auto py-4" ref={historyRef}>
              <div className="px-6">
                <HistoryView projects={projects} onOpen={openConversation} />
              </div>
            </div>
          )}

          {view === "tasks" && (
            <div className="flex-1 overflow-y-auto py-4" ref={tasksRef}>
              <div className="px-6">
                <TasksView scheduled={scheduled} onScheduleTask={() => setModal("schedule")} />
              </div>
            </div>
          )}

          {view === "new" && (
            <div className="flex flex-1 items-center justify-center overflow-hidden p-6">
              <motion.div
                className="w-full max-w-[760px]"
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
              <div className="flex-1 overflow-y-auto py-4" ref={chatScrollRef}>
                <div className="px-6 pr-2">
                  <div
                    className="mx-auto flex w-full max-w-[760px] flex-col gap-4"
                    key={activeConv?.id ?? "new"}
                  >
                  {activeConv?.id === "fix-terminal-tests" && <ChatBody />}
                    <AnimatePresence initial={false}>
                      {draftMsgs.map((m, i) => (
                        <motion.div
                          key={i}
                          initial={{ opacity: 0, y: 12 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.2, ease: "easeOut" }}
                        >
                          <ChatMessage role={m.role} text={m.text} />
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
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

        <AnimatePresence>
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
        </AnimatePresence>
      </div>
    </div>
  );
}
