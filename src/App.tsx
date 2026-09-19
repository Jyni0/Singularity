import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type Conversation,
  type Model,
  type Project,
  type Provider,
  type Theme,
  type ViewKind,
  type Gateway,
  CONV_LIMIT,
  NO_PROJECT,
} from "./types";
import * as db from "./db";
import { ModelsSettings } from "./ModelsSettings";
import { Markdown, ToolCall } from "./Markdown";
import { toAttachments, formatSize, composePrompt } from "./attachments";
import type { Effort, Attachment } from "./types";
import { EFFORTS } from "./types";

export type {
  Conversation,
  Model,
  ModelOption,
  Project,
  Provider,
  ProviderKind,
  ProviderStatus,
  Theme,
  ViewKind,
} from "./types";
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
  MoreHorizontal,
  Pin,
  Pencil,
  Trash2,
  FolderCog,
  CopyPlus,
  ChevronLast,
  Loader2,
  Gauge,
  Paperclip,
  FileText,
} from "lucide-react";

/* ---------- Shared class fragments (single source of truth) ---------- */

/**
 * Suppresses the default right-click menu for the whole window. A desktop app
 * should own its own menus rather than show Back / Reload / Inspect.
 */
function useBlockContextMenu() {
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);
}

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
/** Tiny icon button revealed on row hover (⋮, +, pin).
 *  Hover paints a solid grey pill instead of a faint translucent wash. */
const ROW_ICON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--row-solid-hover)] hover:text-[var(--text-main)]";

/* ---------- Custom overlay scrollbar ----------
   WebView2 draws its own "fluent" scrollbar (arrows, grows while scrolling,
   jumps width). We hide it with .no-native-scrollbar and render our own
   overlay thumb: constant 6px, no arrows, never shifts layout. */

type ThumbState = { top: number; height: number; visible: boolean };

function useOverlayThumb(elRef: React.RefObject<HTMLElement | null>) {
  const [thumb, setThumb] = useState<ThumbState>({ top: 0, height: 0, visible: false });

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    let timer: number | undefined;
    let hovering = false;

    const update = (active = false) => {
      const { scrollHeight, clientHeight, scrollTop } = el;
      const ratio = clientHeight / Math.max(scrollHeight, 1);
      const needBar = scrollHeight > clientHeight + 1;
      const height = Math.max(ratio * clientHeight, 28);
      const maxTop = clientHeight - height;
      const top = ratio >= 1 ? 0 : (scrollTop / (scrollHeight - clientHeight)) * maxTop;
      setThumb({ top, height, visible: needBar && (active || hovering) });
    };

    const onScroll = () => {
      update(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => update(hovering), 800);
    };
    const onEnter = () => {
      hovering = true;
      update(false);
    };
    const onLeave = () => {
      hovering = false;
      update(false);
    };
    const onResize = () => update(false);

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("mouseleave", onLeave);
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    update(false);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("mouseenter", onEnter);
      el.removeEventListener("mouseleave", onLeave);
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [elRef]);

  return thumb;
}

/** The thumb hugs the right edge of its scroll container — no padding gap. */
function Thumb({ thumb }: { thumb: ThumbState }) {
  return (
    <div className="pointer-events-none absolute right-0 top-0 h-full w-2">
      <div
        className={`scroll-thumb ${thumb.visible ? "" : "opacity-0"}`}
        style={{ top: `${thumb.top}px`, height: `${thumb.height}px` }}
      />
    </div>
  );
}

/** Scroll container with the custom overlay bar (fills its parent box). */
function ScrollArea({
  children,
  className = "",
  innerClassName = "",
  scrollRef,
}: {
  children: React.ReactNode;
  className?: string;
  innerClassName?: string;
  scrollRef?: React.RefObject<HTMLDivElement>;
}) {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = scrollRef ?? localRef;
  const thumb = useOverlayThumb(ref);

  return (
    <div className={`relative flex min-h-0 flex-col ${className}`}>
      <div ref={ref} className={`no-native-scrollbar min-h-0 flex-1 overflow-y-auto ${innerClassName}`}>
        {children}
      </div>
      <Thumb thumb={thumb} />
    </div>
  );
}

/** Scroll wrapper whose height is driven by its content classes (max-h-*, etc.). */
function ScrollBox({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const thumb = useOverlayThumb(ref);
  return (
    <div className="relative">
      <div ref={ref} className={`no-native-scrollbar overflow-y-auto ${className}`}>
        {children}
      </div>
      <Thumb thumb={thumb} />
    </div>
  );
}

/* ---------- Types (domain types live in ./types) ---------- */

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
  no?: string;
}

interface Msg {
  role: "user" | "agent";
  text: string;
}

/* ---------- Seed data (used by the in-memory fallback outside Tauri) ---------- */

const R = "C:\\Users\\nezuss\\Documents\\GitHub\\";

/** Loose chats (no folder). Kept as a real entry so every row action just works. */
const NO_PROJECT_ENTRY: Project = {
  name: NO_PROJECT,
  path: "",
  conversations: [
    { id: "loose-scratch", title: "Scratch notes", age: "3h" },
    { id: "loose-quick", title: "Quick question about regex", age: "9h" },
    { id: "loose-draft", title: "Draft commit message", age: "2d" },
  ],
};

const SEED_PROJECTS: Project[] = [
  {
    name: "Singularity",
    path: R + "Singularity",
    conversations: [
      { id: "fix-terminal-tests", title: "Fix flaky terminal tests", age: "1d", pinned: true },
      { id: "model-router-fallback", title: "Add Model Router fallback", age: "2d" },
      { id: "git-sync", title: "Branchless git sync redesign", age: "3d" },
      { id: "sidebar-v2", title: "Sidebar v2 layout pass", age: "4d" },
      { id: "theme-tokens", title: "Theme tokens refactor", age: "6d" },
      { id: "cmd-palette", title: "Command palette wiring", age: "8d" },
      { id: "voice-input", title: "Voice input prototype", age: "11d" },
      { id: "tool-diff", title: "Tool diff review panel", age: "15d" },
    ],
  },
  {
    name: "accounting",
    path: R + "accounting",
    conversations: [{ id: "acc-invoices", title: "Invoice parser refactor", age: "7d" }],
  },
  {
    name: "Auth",
    path: R + "Auth",
    conversations: [
      { id: "auth-jwt", title: "JWT refresh flow", age: "12d" },
      { id: "auth-oauth", title: "OAuth device flow", age: "14d" },
      { id: "auth-sessions", title: "Session storage hardening", age: "18d" },
      { id: "auth-mfa", title: "MFA enrollment", age: "21d" },
      { id: "auth-keys", title: "Key rotation job", age: "25d" },
      { id: "auth-audit", title: "Audit log table", age: "28d" },
      { id: "auth-lockout", title: "Lockout policy", age: "31d" },
      { id: "auth-passkeys", title: "Passkeys spike", age: "34d" },
    ],
  },
  { name: "CourcesPlatform", path: R + "CourcesPlatform", conversations: [] },
  { name: "DataVisualizationMatplotlib", path: R + "DataVisualizationMatplotlib", conversations: [] },
  {
    name: "Education-Website",
    path: R + "Education-Website",
    conversations: [{ id: "edu-landing", title: "Landing page rewrite", age: "5d" }],
  },
  { name: "Frontend_Booking", path: R + "Frontend_Booking", conversations: [] },
  { name: "hosty", path: R + "hosty", conversations: [] },
  { name: "landing", path: R + "landing", conversations: [] },
  { name: "TermosClient", path: R + "TermosClient", conversations: [] },
  { name: "TSKS_1gg7sgds", path: R + "TSKS_1gg7sgds", conversations: [] },
  NO_PROJECT_ENTRY,
];

const SEED_PROVIDERS: Provider[] = [
  {
    id: "dsh",
    name: "DeepSeek Harness",
    kind: "openai-compatible",
    base_url: "http://127.0.0.1:8080",
    api_key: "",
    enabled: true,
    status: "ready",
    last_sync: null,
    auth: "key",
  },
  {
    id: "google",
    name: "Google Antigravity",
    kind: "google",
    base_url: "https://generativelanguage.googleapis.com",
    api_key: "",
    enabled: false,
    status: "disconnected",
    last_sync: null,
    auth: "key",
  },
  {
    id: "openai",
    name: "OpenAI",
    kind: "openai",
    base_url: "https://api.openai.com/v1",
    api_key: "",
    enabled: false,
    status: "disconnected",
    last_sync: null,
    auth: "key",
  },
];

const SEED_MODELS: Model[] = [
  ...[
    ["gemini-3-pro", "Gemini 3 Pro", "Artifacts"],
    ["gemini-3-flash", "Gemini 3 Flash", "fast"],
  ].map<Model>(([model_id, name, meta]) => ({
    id: `google:${model_id}`,
    provider_id: "google",
    model_id,
    name,
    meta,
    enabled: true,
  })),
  ...[
    ["deepseek-v4", "DeepSeek V4", "Reasoner"],
    ["deepseek-r2", "DeepSeek Reasoner R2", "thinking"],
  ].map<Model>(([model_id, name, meta]) => ({
    id: `dsh:${model_id}`,
    provider_id: "dsh",
    model_id,
    name,
    meta,
    enabled: true,
  })),
  ...[
    ["gpt-4o", "GPT-4o", "BYOK"],
    ["o3-mini", "o3-mini", "BYOK"],
  ].map<Model>(([model_id, name, meta]) => ({
    id: `openai:${model_id}`,
    provider_id: "openai",
    model_id,
    name,
    meta,
    enabled: true,
  })),
];

/** Groups providers and their models into the shape the pickers consume. */
function toGateways(providers: Provider[], models: Model[]): Gateway[] {
  return providers.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    status: p.status,
    enabled: p.enabled,
    models: models
      .filter((m) => m.provider_id === p.id && m.enabled)
      .map((m) => ({ id: m.model_id, name: m.name, meta: m.meta })),
  }));
}

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
        <span className="mr-0.5 px-2 text-[13px] font-semibold tracking-wide bg-[var(--text-muted)] bg-clip-text text-transparent">
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

/* ---------- Tiny dropdown used by row actions ---------- */

function RowMenu({
  open,
  anchor,
  items,
  onClose,
}: {
  open: boolean;
  /** The element the menu should be anchored to (its trigger button). */
  anchor: React.RefObject<HTMLElement | null>;
  items: Array<{ icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, flipped: false });
  // Keep callbacks/refs out of the effect deps so positioning never loops.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const itemCount = items.length;

  /**
   * Positioned with `position: fixed` against the trigger's viewport rect and
   * re-measured on scroll/resize — so it is never clipped by the sidebar's
   * overflow and never drifts out of view when the list is scrolled.
   */
  useEffect(() => {
    if (!open) return;

    const place = () => {
      const el = anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const menuH = ref.current?.offsetHeight ?? itemCount * 32 + 12;
      const menuW = ref.current?.offsetWidth ?? 200;
      const gap = 6;
      const below = r.bottom + gap;
      const fitBelow = below + menuH <= window.innerHeight - 8;
      const top = fitBelow ? below : Math.max(8, r.top - gap - menuH);
      const left = Math.min(Math.max(8, r.right - menuW), window.innerWidth - menuW - 8);
      setPos((p) =>
        p.top === top && p.left === left && p.flipped === !fitBelow
          ? p // bail out: identical position must not trigger a re-render
          : { top, left, flipped: !fitBelow }
      );
    };

    place();
    const raf = requestAnimationFrame(place); // second pass with real size

    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseRef.current();

    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    // capture:true also catches scrolling inside nested scroll containers
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchor, itemCount]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          className="z-[600] flex min-w-[200px] flex-col gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-1 shadow-[var(--shadow-popup)]"
          initial={{ opacity: 0, y: pos.flipped ? 4 : -4, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: pos.flipped ? 4 : -4, scale: 0.97 }}
          transition={{ duration: 0.12, ease: "easeOut" }}
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((it) => (
            <button
              key={it.label}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-[var(--hover-bg)] ${
                it.danger ? "text-[var(--diff-del)]" : "text-[var(--text-main)]"
              }`}
              onClick={() => {
                it.onClick();
                onClose();
              }}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
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
              topLevel ? "" : "pl-6"
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
            <span className="truncate">{c.title}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--text-dim)]">
              {c.age}
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
      className="relative flex shrink-0 flex-col bg-[var(--bg-sidebar)] text-[13px] leading-tight"
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
          innerClassName="flex flex-col gap-0.5 px-2.5 [&>*]:shrink-0"
        >
          {/* Projects header — click the label to collapse the whole section */}
          <div className="mb-1 mt-3 flex h-6 shrink-0 items-center pl-1 pr-0.5">
            <button
              className="flex h-6 items-center gap-1 rounded text-[12px] font-medium text-[var(--text-dim)] transition-colors hover:text-[var(--text-main)]"
              onClick={() => setProjectsOpen(!projectsOpen)}
              title={projectsOpen ? "Collapse projects" : "Expand projects"}
            >
              <motion.span
                animate={{ rotate: projectsOpen ? 90 : 0 }}
                transition={{ duration: 0.15 }}
                className="flex items-center"
              >
                <ChevronRight size={12} strokeWidth={2} />
              </motion.span>
              Projects
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
          <div className="mb-1 mt-3 flex h-6 shrink-0 items-center pl-1 pr-0.5">
            <button
              className="flex h-6 items-center gap-1 rounded text-[12px] font-medium text-[var(--text-dim)] transition-colors hover:text-[var(--text-main)]"
              onClick={() => setConvsOpen(!convsOpen)}
              title={convsOpen ? "Collapse conversations" : "Expand conversations"}
            >
              <motion.span
                animate={{ rotate: convsOpen ? 90 : 0 }}
                transition={{ duration: 0.15 }}
                className="flex items-center"
              >
                <ChevronRight size={12} strokeWidth={2} />
              </motion.span>
              Conversations
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
      {/* Model output is markdown: headings, lists, tables and fenced code. */}
      <Markdown text={text} />
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
  gateways,
  gatewayId,
  modelId,
  onSelect,
}: {
  gateways: Gateway[];
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

  // Providers with at least one enabled model are the ones worth showing.
  const usable = gateways.filter((g) => g.models.length > 0);
  const gw = usable.find((g) => g.id === gatewayId) ?? usable[0];
  const model = gw?.models.find((m) => m.id === modelId) ?? gw?.models[0];

  if (!gw || !model) {
    return (
      <span className={`${CHIP} cursor-default opacity-60`} title="No models available — connect a provider in Settings → Models">
        <Zap size={12} strokeWidth={1.5} />
        No models
      </span>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <span className={CHIP} onClick={() => setOpen(!open)}>
        <Zap size={12} strokeWidth={1.5} />
        {model.name}
        <span className="text-[var(--text-dim)]">· {gw.name}</span>
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
            {usable.map((g) => (
              <div
                key={g.id}
                className="relative"
                onMouseEnter={() => setHoveredGw(g.id)}
                onClick={() => setHoveredGw(g.id)}
              >
                <button className={MENU_ITEM}>
                  <span>{g.name}</span>
                  {g.id === gw.id && <Check size={12} />}
                  <span
                    className={`ml-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                      g.status === "ready" ? "bg-[var(--accent)]" : "bg-[var(--text-dim)]"
                    }`}
                    title={g.status}
                  />
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
                          className={`${MENU_ITEM} ${g.id === gw.id && m.id === model.id ? "bg-[var(--hover-bg)]" : ""}`}
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
        {project === NO_PROJECT ? (
          <MessageSquare size={15} strokeWidth={1.8} className="text-[var(--text-muted)]" />
        ) : (
          <Folder size={16} strokeWidth={2} />
        )}
        {project}
        <ChevronDown size={12} className="text-[var(--text-dim)]" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute left-1/2 top-[calc(100%+8px)] z-[200] min-w-[240px] -translate-x-1/2 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-2 shadow-[var(--shadow-popup)]"
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            <ScrollBox className="flex max-h-[260px] flex-col gap-0.5">
              {/* No project — chat that lives outside any folder */}
              <button
                className={`${MENU_ITEM} ${project === NO_PROJECT ? "bg-[var(--hover-bg)]" : ""} py-2`}
                onClick={() => {
                  onSelect(NO_PROJECT);
                  setOpen(false);
                }}
              >
                <MessageSquare size={14} />
                <span className="truncate">{NO_PROJECT}</span>
                {project === NO_PROJECT && (
                  <Check size={12} className="ml-auto text-[var(--text-dim)]" />
                )}
              </button>
              <div className="my-1 h-px bg-[var(--border-soft)]" />
              {projects
                .filter((p) => p.name !== NO_PROJECT)
                .map((p) => (
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
                    {p.name === project && (
                      <Check size={12} className="ml-auto text-[var(--text-dim)]" />
                    )}
                  </button>
                ))}
            </ScrollBox>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- Speech-to-text (Web Speech API, provided by WebView2/Edge) ---------- */

type SpeechRec = {
  start: () => void;
  stop: () => void;
  abort: () => void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

function getSpeechRecognition(): (new () => SpeechRec) | null {
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Microphone → text. Streams recognized speech into the caller via onText
 * (interim results are shown live, final results are appended).
 *
 * Uses the Web Speech API, which is available in the WebView2 runtime. The
 * language follows the browser locale, with a sane default when it cannot be
 * detected.
 */
function useSpeechToText(onText: (chunk: string, isFinal: boolean) => void) {
  const [listening, setListening] = useState(false);
  const [supported] = useState(() => getSpeechRecognition() !== null);
  const recRef = useRef<SpeechRec | null>(null);
  const finalRef = useRef("");
  const cbRef = useRef(onText);
  cbRef.current = onText;

  const stop = () => {
    try {
      recRef.current?.stop();
    } catch {
      /* already stopped */
    }
    setListening(false);
  };

  const start = () => {
    const Ctor = getSpeechRecognition();
    if (!Ctor) return;
    try {
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      // Match the user's language, falling back to English.
      rec.lang = navigator.language || "en-US";
      finalRef.current = "";

      rec.onresult = (e: any) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          const txt = res[0]?.transcript ?? "";
          if (res.isFinal) {
            finalRef.current += txt;
            cbRef.current(txt.trim() ? txt : "", true);
          } else {
            interim += txt;
          }
        }
        if (interim) cbRef.current(interim, false);
      };
      rec.onerror = () => {
        setListening(false);
      };
      rec.onend = () => setListening(false);

      rec.start();
      recRef.current = rec;
      setListening(true);
    } catch {
      setListening(false);
    }
  };

  useEffect(() => () => recRef.current?.abort?.(), []);

  return { listening, supported, start, stop, toggle: () => (listening ? stop() : start()) };
}

/* ---------- Effort selector ---------- */

const EFFORT_INFO: Record<Effort, { label: string; hint: string }> = {
  low: { label: "Fast", hint: "Low effort — quick answers, minimal reasoning" },
  medium: { label: "Balanced", hint: "Medium effort — default balance of speed and depth" },
  high: { label: "Think", hint: "High effort — deeper reasoning, slower" },
};

/** Dropdown chip that picks the reasoning effort. */
function EffortChip({ effort, onPick }: { effort: Effort; onPick: (e: Effort) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Close on outside click, matching the other dropdowns.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const info = EFFORT_INFO[effort];

  return (
    <div className="relative shrink-0" ref={ref}>
      <span
        className={CHIP_CTX}
        onClick={() => setOpen(!open)}
        title="Reasoning effort"
      >
        <Gauge size={12} strokeWidth={1.5} />
        {info.label}
        <ChevronDown size={12} />
      </span>

      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute bottom-full left-0 z-50 mb-1.5 w-[210px] rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-1.5 shadow-[0_12px_28px_-10px_rgba(0,0,0,0.55)]"
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
          >
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--text-dim)]">
              Reasoning effort
            </div>
            {EFFORTS.map((lvl) => (
              <button
                key={lvl}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors ${
                  effort === lvl
                    ? "bg-[var(--hover-bg)] text-[var(--text-main)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                }`}
                onClick={() => {
                  onPick(lvl);
                  setOpen(false);
                }}
              >
                {effort === lvl ? <Check size={13} /> : <span className="w-[13px]" />}
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{EFFORT_INFO[lvl].label}</span>
                  <span className="block truncate text-[10px] text-[var(--text-dim)]">
                    {EFFORT_INFO[lvl].hint}
                  </span>
                </span>
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
  gateways,
  centered,
}: {
  onSend: (
    text: string,
    selection: { gatewayId: string; modelId: string; effort: Effort },
    attachments: Attachment[]
  ) => void;
  projects: Project[];
  project: string;
  onSelectProject: (name: string) => void;
  gateways: Gateway[];
  centered?: boolean;
}) {
  const [text, setText] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [modelId, setModelId] = useState("");
  const [turbo, setTurbo] = useState(true);
  const [effort, setEffort] = useState<Effort>(
    () => (localStorage.getItem("effort") as Effort) || "medium"
  );
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const promptThumb = useOverlayThumb(ref);

  // Keep the selection pointed at a model that actually exists: the provider
  // list is loaded from the database and changes as providers are connected.
  useEffect(() => {
    const usable = gateways.filter((g) => g.models.length > 0);
    const current = usable.find(
      (g) => g.id === gatewayId && g.models.some((m) => m.id === modelId)
    );
    if (current) return;
    const first = usable[0];
    if (first) {
      setGatewayId(first.id);
      setModelId(first.models[0].id);
    }
  }, [gateways, gatewayId, modelId]);

  const autoGrow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const speech = useSpeechToText((chunk, isFinal) => {
    if (!isFinal) return; // interim text is handled below via preview
    setText((prev) => `${prev}${prev && !prev.endsWith(" ") ? " " : ""}${chunk.trim()}`);
    requestAnimationFrame(autoGrow);
  });

  const toggleMic = () => {
    if (speech.listening) speech.stop();
    else speech.start();
  };

  /** Accepts picked or dropped files as attachments. */
  const acceptFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const { attachments: added, rejected } = await toAttachments(files);
    if (added.length > 0) setAttachments((prev) => [...prev, ...added]);
    setNotice(rejected.length > 0 ? rejected.join(" · ") : null);
  };

  /** Pastes from the clipboard: images (screenshots) and copied files. */
  const onPaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    let textPart = "";

    for (const item of items) {
      // A copied file or a screenshot in the clipboard.
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      } else if (item.kind === "string" && item.type === "text/plain") {
        textPart = e.clipboardData.getData("text/plain");
      }
    }

    if (files.length > 0) {
      // Let the browser skip its own file handling; we take over.
      e.preventDefault();
      await acceptFiles(files);
      return;
    }

    // Plain text still goes into the textarea normally.
    if (textPart) {
      e.preventDefault();
      setText((prev) => prev + textPart);
      requestAnimationFrame(autoGrow);
    }
  };

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id));

  const pickEffort = (next: Effort) => {
    setEffort(next);
    localStorage.setItem("effort", next);
  };

  const send = () => {
    // A prompt can be just attachments — that is a legitimate request.
    if (!text.trim() && attachments.length === 0) return;
    speech.stop();
    onSend(text.trim(), { gatewayId, modelId, effort }, attachments);
    setText("");
    setAttachments([]);
    setNotice(null);
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
        <div
          className={`flex min-h-[108px] w-full flex-col justify-between rounded-2xl border bg-[var(--bg-surface)] transition-colors focus-within:border-[var(--accent)] ${
            dragging ? "border-[var(--accent)] bg-[var(--hover-bg)]" : "border-[var(--border)]"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void acceptFiles(Array.from(e.dataTransfer.files));
          }}
        >
          {/* Attachment previews, above the input */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {attachments.map((a) => (
                <div
                  key={a.id}
                  className="group flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-input)] py-1 pl-1 pr-2"
                >
                  {a.kind === "image" ? (
                    <img
                      src={a.data}
                      alt={a.name}
                      className="h-8 w-8 rounded object-cover"
                    />
                  ) : (
                    <FileText size={13} className="mx-1 text-[var(--text-dim)]" />
                  )}
                  <span className="max-w-[160px] truncate text-[11px] text-[var(--text-main)]">
                    {a.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-[var(--text-dim)]">
                    {formatSize(a.size)}
                  </span>
                  <button
                    className="shrink-0 text-[var(--text-dim)] hover:text-[var(--diff-del)]"
                    onClick={() => removeAttachment(a.id)}
                    title="Remove attachment"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {notice && (
            <div className="px-4 pt-2 text-[11px] text-[var(--diff-del)]">{notice}</div>
          )}
          {dragging && (
            <div className="px-4 pt-2 text-[12px] text-[var(--accent)]">
              Drop to attach files or images…
            </div>
          )}

          {/* Textarea keeps the custom overlay bar too (native bar is hidden) */}
          <div className="relative">
            <textarea
              ref={ref}
              rows={1}
              className="no-native-scrollbar max-h-[200px] min-h-[44px] w-full resize-none border-none bg-transparent px-4 pb-2 pt-3.5 text-[14px] leading-normal text-[var(--text-main)] outline-none placeholder:text-[var(--text-dim)]"
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
              onPaste={(e) => void onPaste(e)}
            />
            <Thumb thumb={promptThumb} />
          </div>
          {/* Toolbar: 6px 12px 10px, space-between */}
          <div className="flex items-center justify-between gap-1.5 px-3 pb-2.5 pt-1.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <ModelSelector
                gateways={gateways}
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
              {/* Reasoning effort — low is fast, high thinks harder. */}
              <EffortChip effort={effort} onPick={pickEffort} />
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {/* Hidden file input driven by the paperclip button */}
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  void acceptFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
              <button
                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                onClick={() => fileInput.current?.click()}
                title="Attach files or images (or drag them onto the prompt)"
              >
                <Paperclip size={14} strokeWidth={1.5} />
              </button>
              {/* Mic: 28×28, icon 15 — live speech-to-text while active */}
              <button
                className={`relative flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                  speech.listening
                    ? "bg-[var(--diff-del)]/15 text-[var(--diff-del)]"
                    : "text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                } ${speech.supported ? "" : "cursor-not-allowed opacity-40"}`}
                onClick={toggleMic}
                disabled={!speech.supported}
                title={
                  speech.supported
                    ? speech.listening
                      ? "Stop dictation"
                      : "Dictate with microphone"
                    : "Speech recognition is unavailable"
                }
              >
                <Mic size={15} strokeWidth={1.5} />
                {speech.listening && (
                  <motion.span
                    className="absolute inset-0 rounded-md border border-[var(--diff-del)]"
                    animate={{ opacity: [0.9, 0.25, 0.9] }}
                    transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
                  />
                )}
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

type SettingsSection =
  | "general"
  | "execution"
  | "permissions"
  | "behavior"
  | "projects"
  | "models";

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
  providers,
  models,
  persistent,
  dbInfo,
  onProvidersChanged,
  onModelsChanged,
  onClose,
}: {
  theme: Theme;
  onTheme: (t: Theme) => void;
  projects: Project[];
  onAddProject: (name: string) => void;
  providers: Provider[];
  models: Model[];
  persistent: boolean;
  dbInfo: string;
  onProvidersChanged: (next: Provider[]) => void;
  onModelsChanged: (next: Model[]) => void;
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
      ],
    },
  ];

  const titles: Record<SettingsSection, [string, string]> = {
    general: ["General", "Appearance, theme and workspace defaults"],
    models: ["Models", "Connect providers and manage the models they expose"],
    execution: ["Execution", "How agent tasks are queued and run"],
    behavior: ["Agent Behavior", "Autonomy, safety and review policies"],
    permissions: ["Global Permissions", "Tool and filesystem access rules"],
    projects: ["Manage Projects", "Create and organize project folders"],
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
                <Segmented options={["Queue", "Send Immediately"]} value={sendMode} onChange={setSendMode} />
              </SettingRow>
              <Sep />
              <SettingRow title="Default Gateway" hint="Model provider for new conversations">
                <select className={SSELECT} defaultValue={providers[0]?.id}>
                  {providers.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </SettingRow>
              <Sep />
              <SettingRow title="Storage" hint="Where chats, projects and settings live">
                <span className="font-mono text-[12px] text-[var(--text-muted)]">{dbInfo}</span>
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
        </ScrollArea>
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
  // No default browser context menu anywhere in the window.
  useBlockContextMenu();
  const [draftMsgs, setDraftMsgs] = useState<Msg[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [theme, setTheme] = useState<Theme>("dark");
  /** Workspace tree — hydrated from SQLite on mount. */
  const [projects, setProjects] = useState<Project[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [scheduled, setScheduled] = useState<string[]>(INITIAL_SCHEDULED);
  const [modal, setModal] = useState<"none" | "settings" | "schedule">("none");
  const [view, setView] = useState<ViewKind>("chat");
  const [activeConv, setActiveConv] = useState<{ project: string; id: string } | null>(null);
  const [newChatProject, setNewChatProject] = useState("Singularity");
  /** False until the first DB read finishes. */
  const [persistent, setPersistent] = useState(false);
  /** Human-readable description of where the workspace is stored. */
  const [dbInfo, setDbInfo] = useState("");
  /** True while a model response is streaming in. */
  const [streaming, setStreaming] = useState(false);
  /** Workspace root the agent's file/command tools operate inside. */
  const [workspace, setWorkspace] = useState(
    () => localStorage.getItem("agent_workspace") ?? ""
  );
  /** When off, prompts are answered by plain chat with no tool access. */
  const [agentMode] = useState(() => localStorage.getItem("agent_mode") !== "off");
  /** Tool calls made during the current turn, newest last. */
  const [steps, setSteps] = useState<db.AgentStepEvent[]>([]);
  const chatRef = useRef<HTMLDivElement>(null);

  // The agent always has a workspace: the app's own folder by default, or a
  // project folder the user points it at once (no picker in the prompt box).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const dir = await db.defaultWorkspace();
      if (!cancelled && dir) setWorkspace(dir);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- Boot: hydrate the workspace from SQLite ---------- */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [persist, loadedProjects, loadedProviders, loadedModels] = await Promise.all([
        db.isPersistent(),
        db.loadProjects(),
        db.loadProviders(),
        db.loadModels(),
      ]);
      if (cancelled) return;

      // Outside Tauri the DB is unavailable; fall back to the demo workspace.
      const nextProjects = loadedProjects.length ? loadedProjects : SEED_PROJECTS;
      const nextProviders = loadedProviders.length ? loadedProviders : SEED_PROVIDERS;
      const nextModels = loadedModels.length ? loadedModels : SEED_MODELS;
      if (!persist) db.seedMemory(nextProjects, nextProviders, nextModels);

      setPersistent(persist);
      setProjects(nextProjects);
      setProviders(nextProviders);
      setModels(nextModels);
      setDbInfo(
        persist
          ? "SQLite · singularity.db (app data directory)"
          : "In-memory (desktop shell not detected)"
      );

      // Open the most recent chat in the default project.
      const first = nextProjects.find((p) => p.name === "Singularity") ?? nextProjects[0];
      const conv = first?.conversations[0];
      if (first && conv) {
        setActiveConv({ project: first.name, id: conv.id });
        const stored = await db.loadMessages(conv.id);
        if (!cancelled && stored.length) {
          setDraftMsgs(stored.map((m) => ({ role: m.role, text: m.text })));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const openConversation = async (project: string, id: string) => {
    setActiveConv({ project, id });
    setView("chat");
    // Messages come from the database, not from an in-memory draft.
    const stored = await db.loadMessages(id);
    setDraftMsgs(stored.map((m) => ({ role: m.role, text: m.text })));
  };

  /** Providers grouped with their models — feeds the model picker. */
  const gateways = useMemo(() => toGateways(providers, models), [providers, models]);

  const addProject = async (name: string) => {
    const project: Project = { name, path: R + name, conversations: [] };
    setProjects((prev) => [...prev, project]);
    await db.insertProject(project, projects.length);
  };

  const renameConversation = async (project: string, convId: string, title: string) => {
    setProjects((prev) =>
      prev.map((p) =>
        p.name !== project
          ? p
          : { ...p, conversations: p.conversations.map((c) => (c.id === convId ? { ...c, title } : c)) }
      )
    );
    await db.updateConversationTitle(convId, title);
  };

  const deleteConversation = async (project: string, convId: string) => {
    setProjects((prev) =>
      prev.map((p) =>
        p.name !== project
          ? p
          : { ...p, conversations: p.conversations.filter((c) => c.id !== convId) }
      )
    );
    await db.removeConversation(convId);
    if (activeConv?.id === convId) {
      setActiveConv(null);
      setDraftMsgs([]);
      setView("new");
    }
  };

  const togglePin = async (project: string, convId: string) => {
    let next = false;
    setProjects((prev) =>
      prev.map((p) => {
        if (p.name !== project) return p;
        return {
          ...p,
          conversations: p.conversations.map((c) => {
            if (c.id !== convId) return c;
            next = !c.pinned;
            return { ...c, pinned: next };
          }),
        };
      })
    );
    // `next` is captured during the state updater above.
    await Promise.resolve();
    await db.updateConversationPinned(convId, next);
  };

  /**
   * Sends a message: persists it, then streams the model's answer into the
   * conversation. The reply is written to SQLite once streaming completes, so a
   * partially received turn is never stored as if it were finished.
   */
  const sendMessage = async (
    text: string,
    target: { project: string; id: string } | null,
    selection: { gatewayId: string; modelId: string; effort: Effort },
    attachments: Attachment[] = []
  ) => {
    // Text files are inlined into the prompt; images travel as data URLs and
    // are converted to each provider's wire shape on the Rust side.
    const promptText = composePrompt(text, attachments);
    const images = attachments
      .filter((a) => a.kind === "image")
      .map((a) => ({ mime: a.mime, data_url: a.data }));

    // Resolve (or create) the conversation this turn belongs to.
    let convId: string;
    let projectName: string;
    let history: Msg[];

    if (target) {
      convId = target.id;
      projectName = target.project;
      history = [...draftMsgs, { role: "user", text: promptText }];
      setDraftMsgs(history);
    } else {
      convId = `c-${Date.now()}`;
      projectName = newChatProject;
      const title = promptText.length > 42 ? `${promptText.slice(0, 42)}…` : promptText;
      const conv: Conversation = { id: convId, title, age: "now" };
      setProjects((prev) =>
        prev.map((p) =>
          p.name !== projectName ? p : { ...p, conversations: [conv, ...p.conversations] }
        )
      );
      await db.insertConversation(projectName, conv);
      history = [{ role: "user", text: promptText }];
      setActiveConv({ project: projectName, id: convId });
      setDraftMsgs(history);
      setView("chat");
    }
    await db.appendMessage(convId, "user", promptText);

    // Find the provider/model the user picked in the prompt box.
    const provider = providers.find((p) => p.id === selection.gatewayId);
    const modelRow = models.find(
      (m) => m.provider_id === selection.gatewayId && m.model_id === selection.modelId
    );
    if (!provider || !modelRow) {
      const note = "No model selected — add a provider in Settings → Models.";
      setDraftMsgs((prev) => [...prev, { role: "agent", text: note }]);
      return;
    }

    const oauth = {
      clientId: localStorage.getItem("google_client_id") ?? "",
      clientSecret: localStorage.getItem("google_client_secret") ?? "",
    };
    const cred = await db.credentialFor(provider, oauth);
    if (cred.error) {
      const note = `${provider.name}: ${cred.error}`;
      setDraftMsgs((prev) => [...prev, { role: "agent", text: note }]);
      return;
    }

    // With agent mode on the tools always have a workspace; the only case worth
    // reporting is the shell not having one ready yet.
    if (agentMode && !workspace.trim()) {
      setDraftMsgs((prev) => [
        ...prev,
        {
          role: "agent",
          text:
            "**Workspace not ready.**\n\nThe tools folder could not be resolved — " +
            "restart the app and try again.",
        },
      ]);
      return;
    }

    // Placeholder that grows as deltas arrive.
    const requestId = `req-${Date.now()}`;
    setDraftMsgs((prev) => [...prev, { role: "agent", text: "" }]);
    setSteps([]);
    setStreaming(true);

    /** Appends streamed text to the agent's bubble. */
    const appendDelta = (delta: string) => {
      setDraftMsgs((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "agent") {
          next[next.length - 1] = { ...last, text: last.text + delta };
        }
        return next;
      });
    };

    const historyTurns = history.map((m) => ({ role: m.role, text: m.text }));

    try {
      // With a workspace set, run the full agent loop so the model can read,
      // write and execute — otherwise it is a plain streaming chat.
      const useAgent = !!workspace.trim() && agentMode;

      const answer = useAgent
        ? await db.runAgent(
            requestId,
            {
              kind: provider.kind,
              base_url: provider.base_url,
              api_key: cred.apiKey,
              auth: cred.auth,
              model: modelRow.model_id,
              system: "",
              workspace,
              effort: selection.effort,
              images,
            },
            historyTurns,
            {
              onText: appendDelta,
              onStep: (step) => setSteps((prev) => [...prev, step]),
            }
          )
        : await db.streamChat(
            requestId,
            {
              kind: provider.kind,
              base_url: provider.base_url,
              api_key: cred.apiKey,
              auth: cred.auth,
              model: modelRow.model_id,
              effort: selection.effort,
              images,
              system:
                "You are Singularity, a coding agent inside a desktop workspace. " +
                "Answer concisely and prefer concrete, runnable steps.",
            },
            historyTurns,
            appendDelta
          );

      await db.appendMessage(convId, "agent", answer);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDraftMsgs((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "agent" && last.text === "") {
          next[next.length - 1] = { role: "agent", text: `⚠️ ${msg}` };
        } else {
          next.push({ role: "agent", text: `⚠️ ${msg}` });
        }
        return next;
      });
    } finally {
      setStreaming(false);
    }
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
            // Plain "New Conversation" starts a chat with no project folder.
            setNewChatProject(NO_PROJECT);
            setActiveConv(null);
            setDraftMsgs([]);
            setView("new");
          }}
          onNewConversationInProject={(project) => {
            setNewChatProject(project);
            setActiveConv(null);
            setDraftMsgs([]);
            setView("new");
          }}
          onShowView={(v) => setView(v)}
          onOpenSettings={() => setModal("settings")}
          onOpenProjectSettings={() => setModal("settings")}
          onNewProject={() => setModal("settings")}
          onRenameConversation={renameConversation}
          onDeleteConversation={deleteConversation}
          onTogglePin={togglePin}
        />

        <div className="flex min-w-0 flex-1 flex-col bg-[var(--bg-app)]">
          {view !== "new" && (
            <div className="flex items-center gap-2 px-4 py-3 text-[16px] font-semibold text-[var(--text-main)]">
              {activeTitle}
              {view === "chat" && activeConv && <Badge kind="run">agent active</Badge>}
            </div>
          )}

          {view === "history" && (
            <ScrollArea className="flex-1" innerClassName="py-4">
              <div className="px-6">
                <HistoryView projects={projects} onOpen={openConversation} />
              </div>
            </ScrollArea>
          )}

          {view === "tasks" && (
            <ScrollArea className="flex-1" innerClassName="py-4">
              <div className="px-6">
                <TasksView scheduled={scheduled} onScheduleTask={() => setModal("schedule")} />
              </div>
            </ScrollArea>
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
                  gateways={gateways}
                  onSend={(text, selection) => sendMessage(text, null, selection)}
                />
              </motion.div>
            </div>
          )}

          {view === "chat" && (
            <>
              <ScrollArea className="flex-1" innerClassName="py-4" scrollRef={chatRef}>
                <div className="px-6">
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

                    {/* Tool calls for the current turn, in the order they ran */}
                    {steps.length > 0 && (
                      <div className="flex flex-col">
                        <div className="mb-1 text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
                          Tool calls · {steps.length}
                        </div>
                        {steps.map((s) => (
                          <ToolCall
                            key={s.index}
                            call={{
                              name: s.name,
                              input: s.input,
                              result: s.result,
                              ok: s.ok,
                              running: false,
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </ScrollArea>

              {/* Streaming indicator sits above the prompt while the model answers */}
              <AnimatePresence>
                {streaming && (
                  <motion.div
                    className="flex items-center gap-2 px-6 pb-1 text-[12px] text-[var(--text-dim)]"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                  >
                    <span className="mx-auto flex w-full max-w-[760px] items-center gap-2">
                      <Loader2 size={13} className="animate-spin" />
                      Generating…
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>
              <PromptBox
                onSend={(text, selection) => sendMessage(text, activeConv, selection)}
                projects={projects}
                project={activeConv?.project ?? NO_PROJECT}
                onSelectProject={() => {}}
                gateways={gateways}
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
              onAddProject={addProject}
              providers={providers}
              models={models}
              persistent={persistent}
              dbInfo={dbInfo}
              onProvidersChanged={setProviders}
              onModelsChanged={setModels}
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
