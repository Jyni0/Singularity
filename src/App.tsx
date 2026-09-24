import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Markdown, ToolCall, ThinkBlock } from "./Markdown";
import { toAttachments, formatSize, composePrompt } from "./attachments";
import type { Effort, Attachment, PermMode } from "./types";
import { EFFORTS, ageLabel, prettyModelName } from "./types";

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
  FileDiff,
  Terminal,
  Image as ImageIcon,
} from "lucide-react";
import { computeDiff, diffStats } from "./diff";

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

/**
 * Unix seconds, ticking every 15s. Conversation rows derive their "41S / 2H /
 * 3D" age from it, so a chat opened an hour ago stops claiming to be "now".
 * The cadence is coarse on purpose — the labels only change by the minute at
 * best, and re-rendering the sidebar every second would be pure waste.
 */
function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
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

/** One piece of an agent turn: reasoning, prose, or a tool call. */
type Segment =
  | { kind: "think"; text: string }
  | { kind: "text"; text: string }
  | { kind: "step"; step: db.AgentStepEvent };

interface Msg {
  role: "user" | "agent";
  /** Full text of the turn — what gets stored and sent back as history. */
  text: string;
  /** Interleaved prose and tool calls, newest last. Live turns only. */
  segments?: Segment[];
  /** How long the agent spent producing this turn, in milliseconds. */
  durationMs?: number;
  /** Images attached to this message, rendered as clickable previews. */
  images?: db.StoredImage[];
}

/**
 * What the right inspection panel shows:
 * `changes` — the diff of one file (or the list when no focus),
 * `commands` — one command's full output (or the list),
 * `image` — a photo attached to a message, full size.
 */
type PanelState =
  | { kind: "none" }
  | { kind: "changes"; file?: string }
  | { kind: "commands"; stepIndex?: number }
  | { kind: "image"; image: db.StoredImage };

/* ---------- Fallback data (used by the in-memory store outside Tauri) ---------- */

/** Loose chats (no folder). Kept as a real entry so every row action just works. */
const NO_PROJECT_ENTRY: Project = {
  name: NO_PROJECT,
  path: "",
  conversations: [],
};

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
      .map((m) => ({
        id: m.model_id,
        // Display names are humanized (`claude-fable-5` → `Claude Fable 5`)
        // unless the user gave the model a custom name of their own.
        name:
          m.name && m.name !== m.model_id ? m.name : prettyModelName(m.model_id),
        meta: m.meta,
      })),
  }));
}

const INITIAL_SCHEDULED = ["Nightly /review @main", "Weekly /test all"];

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
            {/* A generation is running in this chat — pulsing accent dot. */}
            {running && (
              <motion.span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]"
                animate={{ opacity: [1, 0.25, 1], scale: [1, 0.85, 1] }}
                transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                title="Generating…"
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

function ChatMessage({
  role,
  text,
  segments,
  streaming,
  durationMs,
  images,
  onInspectStep,
  onInspectImage,
}: {
  role: "user" | "agent";
  text: string;
  segments?: Segment[];
  /** True while this turn is still being produced — shows a "thinking…" marker. */
  streaming?: boolean;
  /** How long the agent worked on this answer. */
  durationMs?: number;
  /** Photos attached to the message — clickable, open in the side panel. */
  images?: db.StoredImage[];
  /** Opens the inspection panel for a write/edit or run_command step. */
  onInspectStep?: (step: db.AgentStepEvent) => void;
  /** Opens the photo viewer panel. */
  onInspectImage?: (image: db.StoredImage) => void;
}) {
  if (role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {/* Attached photos render as thumbnails; a click opens the viewer. */}
        {images && images.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
            {images.map((img, i) => (
              <button
                key={i}
                className="overflow-hidden rounded-lg border border-[var(--border)] transition-transform hover:scale-[1.02]"
                onClick={() => onInspectImage?.(img)}
                title={`View ${img.name}`}
              >
                <img
                  src={img.data_url}
                  alt={img.name}
                  className="h-24 w-auto max-w-[180px] object-cover"
                />
              </button>
            ))}
          </div>
        )}
        <div className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2 text-left">
          <MessageBody text={text} />
        </div>
      </div>
    );
  }

  // Segments keep prose and tool calls in the order they happened, so the
  // answer reads as a transcript rather than text with a dump of calls below.
  if (segments && segments.length > 0) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
          Agent
          {/* How long this turn took — visible once the generation finished. */}
          {!streaming && !!durationMs && durationMs > 0 && (
            <span className="rounded-full bg-[var(--hover-bg)] px-1.5 py-0.5 font-mono text-[10px] normal-case tracking-normal text-[var(--text-dim)]" title="Generation time">
              {formatDuration(durationMs)}
            </span>
          )}
        </div>
        {segments.map((seg, i) => {
          const isLast = i === segments.length - 1;
          if (seg.kind === "step") {
            const st = seg.step;
            const hasChange = !!(st.path && st.new_text !== undefined && st.ok);
            const isCommand = st.name === "run_command";
            return (
              <ToolCall
                key={`s${st.index}-${i}`}
                call={{
                  name: st.name,
                  input: st.input,
                  result: st.result,
                  ok: st.ok,
                  running: !st.done,
                  hasChange,
                  isCommand,
                  onInspect:
                    hasChange || isCommand
                      ? () => onInspectStep?.(st)
                      : undefined,
                }}
              />
            );
          }
          if (seg.kind === "think") {
            return seg.text.trim() ? (
              <ThinkBlock
                key={`k${i}`}
                text={seg.text}
                live={!!streaming && isLast}
              />
            ) : null;
          }
          return seg.text.trim() ? <Markdown key={`t${i}`} text={seg.text} /> : null;
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
        Agent
        {!streaming && !!durationMs && durationMs > 0 && (
          <span className="rounded-full bg-[var(--hover-bg)] px-1.5 py-0.5 font-mono text-[10px] normal-case tracking-normal text-[var(--text-dim)]" title="Generation time">
            {formatDuration(durationMs)}
          </span>
        )}
      </div>
      {/* Model output is markdown: headings, lists, tables and fenced code. */}
      <Markdown text={text} />
    </div>
  );
}

/** Compact generation time: 842ms / 12.4s / 2m 5s. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
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

/* ---------- Speech-to-text (MediaRecorder → Whisper endpoint) ---------- */

/**
 * Microphone → text.
 *
 * WebView2 (Tauri's Windows webview) has no Web Speech API, so `SpeechRecognition`
 * is always undefined there and the old implementation silently did nothing.
 * This records the mic with `MediaRecorder`, then hands the finished blob to the
 * caller's `submit`, which posts it to an OpenAI-compatible
 * `/audio/transcriptions` endpoint through Rust (`db.transcribeAudio`).
 *
 * `state`: `idle` → `recording` → `transcribing` → `idle`. `error` carries a
 * short message when recording or transcription fails.
 */
function useDictation(submit: (blob: Blob) => Promise<string>) {
  const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [supported] = useState(
    () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined"
  );
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  const cleanup = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  };

  const stop = () => {
    // Stopping the recorder fires `onstop`, which does the transcription.
    try {
      recorderRef.current?.stop();
    } catch {
      /* already stopped */
    }
  };

  /** Drops the current recording without transcribing it. */
  const cancel = () => {
    const recorder = recorderRef.current;
    if (recorder) recorder.onstop = null;
    try {
      recorder?.stop();
    } catch {
      /* already stopped */
    }
    cleanup();
    setState("idle");
  };

  const start = async () => {
    if (!supported) {
      setError("Microphone is unavailable in this environment");
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // Pick a codec the platform actually records with; WebView2 supports webm/opus.
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
        (m) => MediaRecorder.isTypeSupported?.(m)
      );
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onerror = () => {
        setError("Recording failed");
        setState("idle");
        cleanup();
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mime || "audio/webm" });
        cleanup();
        if (blob.size === 0) {
          setState("idle");
          setError("Nothing was recorded");
          return;
        }
        setState("transcribing");
        try {
          const text = await submit(blob);
          if (text.trim()) {
            dictationResultRef.current?.(text.trim());
          }
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setState("idle");
        }
      };

      recorder.start();
      setState("recording");
    } catch (e) {
      cleanup();
      setState("idle");
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Microphone permission denied"
          : e instanceof Error
            ? e.message
            : String(e)
      );
    }
  };

  // Lets the caller feed the final text into the prompt without re-rendering
  // the hook on every keystroke.
  const dictationResultRef = useRef<((text: string) => void) | null>(null);

  useEffect(() => () => cleanup(), []);

  return {
    state,
    listening: state === "recording",
    transcribing: state === "transcribing",
    supported,
    error,
    start,
    stop,
    cancel,
    toggle: () => (state === "recording" ? stop() : void start()),
    setOnResult: (fn: (text: string) => void) => {
      dictationResultRef.current = fn;
    },
  };
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
  busy,
  onStop,
  onTranscribe,
  pickedModel,
  onPickModel,
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
  /** True while this conversation's generation is running — Send becomes Stop. */
  busy?: boolean;
  onStop?: () => void;
  /** Transcribes a recorded mic blob using the selected provider's endpoint. */
  onTranscribe?: (gatewayId: string, blob: Blob) => Promise<string>;
  /** Model chosen earlier — restored so the chat remembers its model. */
  pickedModel?: { gatewayId: string; modelId: string } | null;
  /** Reports the model the user picked, so it can be persisted. */
  onPickModel?: (next: { gatewayId: string; modelId: string }) => void;
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
  // The model picked in an earlier session wins when it is still available.
  useEffect(() => {
    const usable = gateways.filter((g) => g.models.length > 0);
    const current = usable.find(
      (g) => g.id === gatewayId && g.models.some((m) => m.id === modelId)
    );
    if (current) return;

    const saved = pickedModel
      ? usable.find(
          (g) =>
            g.id === pickedModel.gatewayId &&
            g.models.some((m) => m.id === pickedModel.modelId)
        )
      : undefined;
    if (saved) {
      setGatewayId(saved.id);
      setModelId(pickedModel!.modelId);
      return;
    }

    const first = usable[0];
    if (first) {
      setGatewayId(first.id);
      setModelId(first.models[0].id);
    }
  }, [gateways, gatewayId, modelId, pickedModel]);

  const autoGrow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  // Dictation: record the mic, transcribe through the selected provider's
  // Whisper-compatible endpoint, and append the text to the prompt.
  const speech = useDictation(async (blob) => {
    if (!onTranscribe) throw new Error("Dictation needs a connected provider");
    return onTranscribe(gatewayId, blob);
  });

  useEffect(() => {
    speech.setOnResult((text) => {
      setText((prev) => `${prev}${prev && !prev.endsWith(" ") ? " " : ""}${text}`);
      requestAnimationFrame(autoGrow);
    });
  }, [gatewayId]);

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
    // Sending cancels an in-flight recording instead of transcribing it.
    speech.cancel();
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

          {(notice || speech.error) && (
            <div className="px-4 pt-2 text-[11px] text-[var(--diff-del)]">
              {notice || speech.error}
            </div>
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
                  // Remember the choice so the next launch restores it.
                  onPickModel?.({ gatewayId: g, modelId: m });
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
              {/* Mic: records audio, then transcribes it via the provider. */}
              <button
                className={`relative flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                  speech.listening
                    ? "bg-[var(--diff-del)]/15 text-[var(--diff-del)]"
                    : speech.transcribing
                      ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                      : "text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                } ${speech.supported ? "" : "cursor-not-allowed opacity-40"}`}
                onClick={toggleMic}
                disabled={!speech.supported || speech.transcribing}
                title={
                  !speech.supported
                    ? "Microphone is unavailable"
                    : speech.transcribing
                      ? "Transcribing…"
                      : speech.listening
                        ? "Stop recording"
                        : "Dictate with microphone"
                }
              >
                {speech.transcribing ? (
                  <Loader2 size={15} strokeWidth={1.5} className="animate-spin" />
                ) : (
                  <Mic size={15} strokeWidth={1.5} />
                )}
                {speech.listening && (
                  <motion.span
                    className="absolute inset-0 rounded-md border border-[var(--diff-del)]"
                    animate={{ opacity: [0.9, 0.25, 0.9] }}
                    transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
                  />
                )}
              </button>
              {busy ? (
                <motion.button
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--diff-del)] text-white transition-opacity hover:opacity-90"
                  onClick={onStop}
                  title="Stop generation"
                  initial={{ scale: 0.8 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 500, damping: 28 }}
                >
                  <Square size={12} fill="currentColor" strokeWidth={0} />
                </motion.button>
              ) : (
                <button
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)] text-white transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:bg-[var(--bg-elevated)] disabled:text-[var(--text-dim)]"
                  onClick={send}
                  disabled={!text.trim()}
                  title="Send"
                >
                  <Send size={14} />
                </button>
              )}
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
  const now = useNow();
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
                  {ageLabel(c.updatedAt, now)}
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

const THEMES: Theme[] = ["dark", "light", "slate", "amoled", "vibe"];

/** Creating a project: a name and (optionally) a folder on disk. */
function NewProjectModal({
  onCreate,
  onClose,
}: {
  onCreate: (name: string, path: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    await onCreate(n, path.trim());
  };

  /** Opens the native folder picker — a project does not require one. */
  const pickFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") {
        setPath(picked);
        // Suggest the folder name when the user hasn't typed one yet.
        if (!name.trim()) {
          const last = picked.split(/[\\/]/).filter(Boolean).pop();
          if (last) setName(last);
        }
      }
    } catch {
      /* outside Tauri: manual path entry still works */
    }
  };

  const inputCls =
    "w-full rounded-lg border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2 text-[13px] text-[var(--text-main)] outline-none focus:border-[var(--accent)]";

  return (
    <Modal title="New Project" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-[var(--text-muted)]">Name</span>
          <input
            autoFocus
            className={inputCls}
            placeholder="my-project"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-[var(--text-muted)]">
            Folder on disk <span className="text-[var(--text-dim)]">(optional)</span>
          </span>
          <div className="flex gap-2">
            <input
              className={inputCls}
              placeholder="C:\Users\you\Documents\project — or leave empty"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
            <button
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-[12px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
              onClick={() => void pickFolder()}
            >
              <FolderOpen size={13} /> Browse…
            </button>
          </div>
          <span className="text-[11px] text-[var(--text-dim)]">
            A project is just a folder for your chats — it works without a path.
          </span>
        </label>
        <div className="mt-1 flex justify-end gap-2">
          <button
            className="rounded-lg px-3 py-1.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)]"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            disabled={!name.trim() || busy}
            onClick={() => void submit()}
          >
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Per-project command permission choices. */
const PERM_MODES: Array<{ id: PermMode; label: string; hint: string }> = [
  { id: "bypass", label: "Bypass all", hint: "Run commands right away, never ask" },
  { id: "default", label: "As default", hint: "Use the global setting" },
  { id: "ask", label: "Always ask", hint: "Ask before every command" },
];

/** Per-project settings: rename, execution permission, delete. */
function ProjectSettingsModal({
  project,
  onRename,
  onPermMode,
  onDelete,
  onClose,
}: {
  project: Project | null;
  onRename: (oldName: string, newName: string) => Promise<void>;
  onPermMode: (name: string, mode: PermMode) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!project) return null;

  const inputCls =
    "w-full rounded-lg border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2 text-[13px] text-[var(--text-main)] outline-none focus:border-[var(--accent)]";

  const save = async () => {
    const n = name.trim();
    if (!n || n === project.name || busy) return;
    setBusy(true);
    await onRename(project.name, n);
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    await onDelete(project.name);
  };

  return (
    <Modal title={`Project · ${project.name}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-[var(--text-muted)]">Name</span>
          <div className="flex gap-2">
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void save()}
            />
            <button
              className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              disabled={!name.trim() || name.trim() === project.name || busy}
              onClick={() => void save()}
            >
              Save
            </button>
          </div>
        </label>

        {project.path && (
          <div className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-[var(--text-muted)]">Folder</span>
            <span className="truncate font-mono text-[11px] text-[var(--text-dim)]">{project.path}</span>
          </div>
        )}

        {/* Command permission: three explicit modes instead of a boolean. */}
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2.5">
          <div className="flex items-start gap-2">
            <Shield size={16} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
            <div className="flex flex-1 flex-col gap-0.5">
              <span className="text-[12px] font-medium text-[var(--text-main)]">
                Command permission
              </span>
              <span className="text-[11px] text-[var(--text-dim)]">
                Who decides whether the agent may run shell commands in this project.
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-1.5 pl-6">
            {PERM_MODES.map((m) => (
              <button
                key={m.id}
                className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                  (project.permMode ?? "default") === m.id
                    ? "border-[var(--accent)] bg-[var(--accent)]/10"
                    : "border-[var(--border)] hover:bg-[var(--hover-bg)]"
                }`}
                onClick={() => void onPermMode(project.name, m.id)}
              >
                <span
                  className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                    (project.permMode ?? "default") === m.id
                      ? "border-[var(--accent)]"
                      : "border-[var(--text-dim)]"
                  }`}
                >
                  {(project.permMode ?? "default") === m.id && (
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                  )}
                </span>
                <span className="flex flex-col">
                  <span className="text-[12px] font-medium text-[var(--text-main)]">{m.label}</span>
                  <span className="text-[10px] text-[var(--text-dim)]">{m.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {confirming ? (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--diff-del)]/40 bg-[var(--diff-del)]/10 px-3 py-2.5">
            <span className="flex-1 text-[12px] text-[var(--text-main)]">
              Delete this project? Its chats move to “No project”.
            </span>
            <button
              className="rounded-md bg-[var(--diff-del)] px-2.5 py-1 text-[11px] font-medium text-white"
              onClick={() => void remove()}
            >
              Delete
            </button>
            <button
              className="rounded-md px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--hover-bg)]"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="flex items-center gap-2 self-start rounded-lg px-3 py-1.5 text-[12px] text-[var(--diff-del)] transition-colors hover:bg-[var(--hover-bg)]"
            onClick={() => setConfirming(true)}
          >
            <Trash2 size={13} /> Delete project
          </button>
        )}
      </div>
    </Modal>
  );
}

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
  onProvidersChanged,
  onModelsChanged,
  globalAutoRun,
  onGlobalAutoRun,
  onClose,
}: {
  theme: Theme;
  onTheme: (t: Theme) => void;
  projects: Project[];
  onAddProject: (name: string) => void;
  providers: Provider[];
  models: Model[];
  persistent: boolean;
  onProvidersChanged: (next: Provider[]) => void;
  onModelsChanged: (next: Model[]) => void;
  globalAutoRun: boolean;
  onGlobalAutoRun: (next: boolean) => void;
  onClose: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>("general");
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

/* ---------- Inspection panel (Changes / Commands) ---------- */

/** Collects every tool step from a conversation's messages, in order. */
function collectSteps(msgs: Msg[]): db.AgentStepEvent[] {
  const out: db.AgentStepEvent[] = [];
  for (const m of msgs) {
    for (const s of m.segments ?? []) {
      if (s.kind === "step") out.push(s.step);
    }
  }
  return out;
}

/** Turns a stored row back into a renderable message (duration + photos). */
function storedToMsg(m: db.StoredMessage): Msg {
  let images: db.StoredImage[] | undefined;
  if (m.images && m.images !== "[]") {
    try {
      const parsed = JSON.parse(m.images);
      if (Array.isArray(parsed) && parsed.length) images = parsed as db.StoredImage[];
    } catch {
      /* stored before images existed — ignore */
    }
  }
  return {
    role: m.role,
    text: m.text,
    durationMs: m.duration_ms ?? undefined,
    images,
  };
}

/** Renders a file's diff, reused by the list and the focused view. */
function FileDiffBody({ step }: { step: db.AgentStepEvent }) {
  const lines = computeDiff(step.old_text ?? "", step.new_text ?? "");
  return (
    <div className="overflow-auto bg-[var(--bg-app)] font-mono text-[11px] leading-[1.55]">
      {lines.map((l, i) => (
        <div
          key={i}
          className={`flex whitespace-pre-wrap break-all px-1.5 ${
            l.kind === "add"
              ? "diff-line--add"
              : l.kind === "del"
                ? "diff-line--del"
                : l.kind === "hunk"
                  ? "bg-[var(--bg-surface)] py-0.5 text-[var(--text-dim)]"
                  : "text-[var(--text-muted)]"
          }`}
        >
          <span className="w-4 shrink-0 select-none text-center text-[var(--text-dim)]">
            {l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "hunk" ? "⋯" : ""}
          </span>
          <span className="w-8 shrink-0 select-none text-right text-[var(--text-dim)]">
            {l.kind === "add"
              ? l.newNo
              : l.kind === "del"
                ? l.oldNo
                : l.kind === "ctx"
                  ? l.newNo
                  : ""}
          </span>
          <span className="ml-1.5 min-w-0">{l.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

function InspectionPanel({
  panel,
  msgs,
  onNavigate,
  onClose,
}: {
  panel: PanelState;
  msgs: Msg[];
  /** Switch the panel to another file/command without closing it. */
  onNavigate: (next: PanelState) => void;
  onClose: () => void;
}) {
  const steps = collectSteps(msgs);
  // Hooks must run unconditionally, so the list-view state lives above the
  // image early-return even though only the list views use it.
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [openCmd, setOpenCmd] = useState<number | null>(null);

  if (panel.kind === "image") {
    return (
      <motion.aside
        className="flex h-full w-[340px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg-main)]"
        initial={{ opacity: 0, x: 24 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 24 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <ImageIcon size={15} className="text-[var(--text-dim)]" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text-main)]">
            {panel.image.name}
          </span>
          <button
            className="ml-auto rounded-md p-1 text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
            onClick={onClose}
            title="Close panel"
          >
            <X size={15} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-3">
          <img
            src={panel.image.data_url}
            alt={panel.image.name}
            className="max-w-full rounded-lg border border-[var(--border)] object-contain"
          />
        </div>
      </motion.aside>
    );
  }

  const mode = panel.kind;
  const changes = steps.filter((s) => s.done && s.ok && s.path && s.new_text !== undefined);
  // Latest change per file wins — the panel shows the net result of the run.
  const byFile = new Map<string, db.AgentStepEvent>();
  for (const c of changes) byFile.set(c.path!, c);
  const files = [...byFile.entries()];
  const commands = steps.filter((s) => s.name === "run_command");

  // Focused views: one file's diff, or one command's output.
  const focusFile = panel.kind === "changes" && panel.file ? byFile.get(panel.file) : undefined;
  const focusCmd =
    panel.kind === "commands" && panel.stepIndex !== undefined
      ? commands.find((c) => c.index === panel.stepIndex)
      : undefined;

  const header = (
    <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
      {mode === "changes" ? <FileDiff size={15} className="text-[var(--text-dim)]" /> : <Terminal size={15} className="text-[var(--text-dim)]" />}
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text-main)]">
        {mode === "changes"
          ? focusFile
            ? focusFile.path!.split(/[\\/]/).pop()
            : "Changes"
          : focusCmd
            ? "Command"
            : "Commands"}
      </span>
      {(focusFile || focusCmd) && (
        <button
          className="rounded-md p-1 text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
          onClick={() => onNavigate({ kind: mode })}
          title="Back to the list"
        >
          <ChevronRight size={15} className="rotate-180" />
        </button>
      )}
      <button
        className="rounded-md p-1 text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
        onClick={onClose}
        title="Close panel"
      >
        <X size={15} />
      </button>
    </div>
  );

  return (
    <motion.aside
      className="flex h-full w-[340px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg-main)]"
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      {header}

      {/* Focused diff of a single file. */}
      {mode === "changes" && focusFile && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="truncate border-b border-[var(--border)] bg-[var(--bg-surface)] px-3 py-1.5 font-mono text-[10px] text-[var(--text-dim)]">
            {focusFile.path}
          </div>
          <div className="h-[calc(100%-25px)] overflow-auto">
            <FileDiffBody step={focusFile} />
          </div>
        </div>
      )}

      {/* Focused output of a single command. */}
      {mode === "commands" && focusCmd && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <code className="block truncate border-b border-[var(--border)] bg-[var(--bg-surface)] px-3 py-1.5 font-mono text-[11px] text-[var(--text-main)]">
            {focusCmd.input}
          </code>
          <pre className="h-[calc(100%-33px)] overflow-auto whitespace-pre-wrap break-all bg-[var(--bg-app)] px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--text-muted)]">
            {focusCmd.done ? focusCmd.result : "running…"}
          </pre>
        </div>
      )}

      {/* List views (panel opened without a focus). */}
      {((mode === "changes" && !focusFile) || (mode === "commands" && !focusCmd)) && (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {mode === "changes" && files.length === 0 && (
            <p className="px-2 py-6 text-center text-[12px] text-[var(--text-dim)]">
              No file changes in this conversation yet.
            </p>
          )}
          {mode === "changes" &&
            files.map(([path, step]) => {
              const stats = diffStats(step.old_text ?? "", step.new_text ?? "");
              const open = openFile === path;
              return (
                <div key={path} className="mb-1.5 overflow-hidden rounded-lg border border-[var(--border)]">
                  <button
                    className="flex w-full items-center gap-2 bg-[var(--bg-surface)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--hover-bg)]"
                    onClick={() => setOpenFile(open ? null : path)}
                    onDoubleClick={() => onNavigate({ kind: "changes", file: path })}
                  >
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text-main)]">
                      {path.split(/[\\/]/).pop()}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-[var(--diff-add)]">+{stats.added}</span>
                    <span className="shrink-0 font-mono text-[11px] text-[var(--diff-del)]">-{stats.removed}</span>
                  </button>
                  <AnimatePresence initial={false}>
                    {open && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15, ease: "easeOut" }}
                        className="max-h-[320px] overflow-hidden"
                      >
                        <FileDiffBody step={step} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}

          {mode === "commands" && commands.length === 0 && (
            <p className="px-2 py-6 text-center text-[12px] text-[var(--text-dim)]">
              No commands have run in this conversation yet.
            </p>
          )}
          {mode === "commands" &&
            commands.map((c, i) => {
              const open = openCmd === i;
              return (
                <div key={i} className="mb-1.5 overflow-hidden rounded-lg border border-[var(--border)]">
                  <button
                    className="flex w-full items-center gap-2 bg-[var(--bg-surface)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--hover-bg)]"
                    onClick={() => setOpenCmd(open ? null : i)}
                  >
                    {c.done ? (
                      c.ok ? (
                        <Check size={13} className="shrink-0 text-[var(--diff-add)]" />
                      ) : (
                        <X size={13} className="shrink-0 text-[var(--diff-del)]" />
                      )
                    ) : (
                      <Loader2 size={13} className="shrink-0 animate-spin text-[var(--accent)]" />
                    )}
                    <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text-main)]">
                      {c.input}
                    </code>
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  <AnimatePresence initial={false}>
                    {open && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15, ease: "easeOut" }}
                        className="overflow-hidden"
                      >
                        <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-all border-t border-[var(--border)] bg-[var(--bg-app)] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[var(--text-muted)]">
                          {c.done ? c.result : "running…"}
                        </pre>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
        </div>
      )}
    </motion.aside>
  );
}

/* ---------- App ---------- */

/** Buffer key for the "new chat" view before a conversation exists. */
const DRAFT_ID = "__new__";

export default function App() {
  // No default browser context menu anywhere in the window.
  useBlockContextMenu();
  /**
   * Live message buffers, keyed by conversation id. A run keeps streaming into
   * its own buffer even while the user reads another chat or another view —
   * background generation falls out of this shape for free.
   */
  const [convMsgs, setConvMsgs] = useState<Record<string, Msg[]>>({});
  const convMsgsRef = useRef(convMsgs);
  convMsgsRef.current = convMsgs;
  /** convId → requestId of the generation currently running for it. */
  const [activeRuns, setActiveRuns] = useState<Record<string, string>>({});
  /** Right inspection panel of the chat view. */
  const [panel, setPanel] = useState<PanelState>({ kind: "none" });
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [theme, setThemeState] = useState<Theme>("dark");
  /** Every settings edit is persisted, so edits survive a relaunch. */
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    void db.setSetting("theme", t);
  }, []);
  /** Workspace tree — hydrated from SQLite on mount. */
  const [projects, setProjects] = useState<Project[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [scheduled, setScheduled] = useState<string[]>(INITIAL_SCHEDULED);
  const [modal, setModal] = useState<"none" | "settings" | "schedule" | "new-project" | "project-settings">("none");
  /** Which project the settings modal edits. */
  const [settingsProject, setSettingsProject] = useState<string | null>(null);
  const [view, setView] = useState<ViewKind>("chat");
  const [activeConv, setActiveConv] = useState<{ project: string; id: string } | null>(null);
  const [newChatProject, setNewChatProject] = useState(NO_PROJECT);
  /** False until the first DB read finishes. */
  const [persistent, setPersistent] = useState(false);
  /** Workspace root the agent's file/command tools operate inside. */
  const [workspace, setWorkspace] = useState(
    () => localStorage.getItem("agent_workspace") ?? ""
  );
  /** When off, prompts are answered by plain chat with no tool access. */
  const [agentMode] = useState(() => localStorage.getItem("agent_mode") !== "off");
  /** Global command permission — the default for projects set to "As default". */
  const [globalAutoRun, setGlobalAutoRun] = useState(false);
  /** Last picked model, restored on launch so the chat remembers its choice. */
  const [pickedModel, setPickedModel] = useState<{ gatewayId: string; modelId: string } | null>(
    null
  );
  /** Commands waiting for Allow/Deny, keyed by run id — a background run's
   * request survives navigation and shows again when the chat is opened. */
  const [confirmReqs, setConfirmReqs] = useState<Record<string, db.ConfirmRequest>>({});
  const chatRef = useRef<HTMLDivElement>(null);

  /** Messages of the conversation currently on screen. */
  const draftMsgs = activeConv
    ? convMsgs[activeConv.id] ?? []
    : convMsgs[DRAFT_ID] ?? [];
  /** True while THIS conversation has a generation running. */
  const streaming = !!activeConv && !!activeRuns[activeConv.id];
  /** The pending Allow/Deny request of the conversation on screen, if any. */
  const confirmReq = streaming ? confirmReqs[activeRuns[activeConv!.id]] ?? null : null;
  /** Ids of conversations with a live run — drives the sidebar pulse. */
  const runningConvIds = Object.keys(activeRuns);

  /** Writes to a specific conversation's buffer; safe for background runs. */
  const updateConvMsgs = useCallback((key: string, updater: (prev: Msg[]) => Msg[]) => {
    setConvMsgs((prev) => ({ ...prev, [key]: updater(prev[key] ?? []) }));
  }, []);

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

  // A project with a folder on disk scopes the agent to that folder; projects
  // without one fall back to the default workspace.
  useEffect(() => {
    let cancelled = false;
    const project = projects.find((p) => p.name === activeConv?.project);
    (async () => {
      const dir = project?.path || (await db.defaultWorkspace());
      if (!cancelled && dir) {
        setWorkspace(dir);
        await db.setWorkspace(dir);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeConv?.project, projects]);

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

      // Restore user settings persisted in SQLite (falls back to localStorage
      // values from older versions, then to defaults).
      const [globalAuto, picked, savedTheme] = await Promise.all([
        db.getSetting("global_auto_run"),
        db.getSetting("picked_model"),
        db.getSetting("theme"),
      ]);
      if (!cancelled && globalAuto !== null) setGlobalAutoRun(globalAuto === "1");
      if (!cancelled && savedTheme && THEMES.includes(savedTheme as Theme)) {
        setThemeState(savedTheme as Theme);
      }
      if (!cancelled && picked) {
        try {
          setPickedModel(JSON.parse(picked));
        } catch {
          /* malformed — keep null and let the picker choose */
        }
      }

      // Outside Tauri the DB is unavailable; start clean — only the bucket for
      // loose chats, no demo projects, providers or models.
      const nextProjects = loadedProjects.length ? loadedProjects : [NO_PROJECT_ENTRY];
      const nextProviders = loadedProviders;
      const nextModels = loadedModels;
      if (!persist) db.seedMemory(nextProjects, nextProviders, nextModels);

      setPersistent(persist);
      setProjects(nextProjects);
      setProviders(nextProviders);
      setModels(nextModels);

      // Open the most recent chat, whichever project it lives in.
      const first = nextProjects.find((p) => p.conversations.length > 0);
      const conv = first?.conversations[0];
      if (first && conv) {
        setActiveConv({ project: first.name, id: conv.id });
        const stored = await db.loadMessages(conv.id);
        if (!cancelled && stored.length) {
          setConvMsgs((prev) => ({
            ...prev,
            [conv.id]: stored.map(storedToMsg),
          }));
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
    setPanel({ kind: "none" });
    // A live run owns its buffer — loading over it would wipe the streaming
    // turn. Stored messages already arrived before the run started.
    if (activeRuns[id]) return;
    // Messages come from the database, not from an in-memory draft.
    const stored = await db.loadMessages(id);
    setConvMsgs((prev) => ({
      ...prev,
      [id]: stored.map(storedToMsg),
    }));
  };

  /** Providers grouped with their models — feeds the model picker. */
  const gateways = useMemo(() => toGateways(providers, models), [providers, models]);

  /** Remembers the model the user picked, so the next launch restores it. */
  const pickModel = useCallback((next: { gatewayId: string; modelId: string }) => {
    setPickedModel(next);
    void db.setSetting("picked_model", JSON.stringify(next));
  }, []);

  /**
   * Dictation: posts a recorded blob to the chosen provider's
   * `/audio/transcriptions` endpoint (OpenAI-compatible) via Rust.
   */
  const transcribeForProvider = useCallback(
    async (gatewayId: string, blob: Blob): Promise<string> => {
      const provider = providers.find((p) => p.id === gatewayId);
      if (!provider) throw new Error("Connect a provider to use dictation");
      const oauth = {
        clientId: localStorage.getItem("google_client_id") ?? "",
        clientSecret: localStorage.getItem("google_client_secret") ?? "",
      };
      const cred = await db.credentialFor(provider, oauth);
      if (cred.error) throw new Error(cred.error);
      return db.transcribeAudio(
        { base_url: provider.base_url, api_key: cred.apiKey },
        blob,
        (navigator.language || "en").split("-")[0]
      );
    },
    [providers]
  );

  /** Creates a project. `path` is optional — a project can be just a folder
   * for chats with no directory on disk behind it. */
  const addProject = async (name: string, path: string = "") => {
    const project: Project = { name, path, conversations: [], permMode: "default" };
    setProjects((prev) => [...prev, project]);
    await db.insertProject(project, projects.length);
  };

  /** Renames a project and re-points all of its chats at the new name. */
  const renameProject = async (oldName: string, newName: string) => {
    setProjects((prev) =>
      prev.map((p) => (p.name === oldName ? { ...p, name: newName } : p))
    );
    if (activeConv?.project === oldName) {
      setActiveConv({ project: newName, id: activeConv.id });
    }
    await db.renameProject(oldName, newName);
  };

  /** Deletes a project; its conversations survive under “No project”. */
  const removeProject = async (name: string) => {
    const victim = projects.find((p) => p.name === name);
    const moved = victim?.conversations ?? [];
    setProjects((prev) =>
      prev
        .filter((p) => p.name !== name)
        .map((p) =>
          p.name === NO_PROJECT ? { ...p, conversations: [...moved, ...p.conversations] } : p
        )
    );
    // A chat from the deleted project now lives under “No project”.
    if (activeConv?.project === name) {
      setActiveConv({ project: NO_PROJECT, id: activeConv.id });
    }
    await db.deleteProject(name);
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
    // A run streaming into a deleted chat would keep emitting into a buffer
    // nobody can see — stop it first.
    const run = activeRuns[convId];
    if (run) {
      await db.stopGeneration(run);
      setActiveRuns((prev) => {
        const next = { ...prev };
        delete next[convId];
        return next;
      });
    }
    setProjects((prev) =>
      prev.map((p) =>
        p.name !== project
          ? p
          : { ...p, conversations: p.conversations.filter((c) => c.id !== convId) }
      )
    );
    setConvMsgs((prev) => {
      const next = { ...prev };
      delete next[convId];
      return next;
    });
    await db.removeConversation(convId);
    if (activeConv?.id === convId) {
      setActiveConv(null);
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
   * Refreshes a conversation's activity stamp in the in-memory tree so the
   * sidebar's age label ("now" → "41S") updates the moment a message lands,
   * without waiting for the next full reload.
   */
  const bumpConversationActivity = (convId: string) => {
    const stamp = Math.floor(Date.now() / 1000);
    setProjects((prev) =>
      prev.map((p) => ({
        ...p,
        conversations: p.conversations.map((c) =>
          c.id === convId ? { ...c, updatedAt: stamp } : c
        ),
      }))
    );
  };

  /**
   * Sends a message: persists it, then streams the model's answer into the
   * conversation's own buffer, keyed by conversation id. The run keeps going
   * when the user navigates away — the sidebar shows a pulse while it lasts.
   * The reply is written to SQLite once streaming completes, so a partially
   * received turn is never stored as if it were finished.
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
      .map((a) => ({ name: a.name, mime: a.mime, data_url: a.data }));
    /** The user message as shown in the chat, with photo previews. */
    const userMsg: Msg = {
      role: "user",
      text: promptText,
      images: images.length ? images : undefined,
    };

    // Resolve (or create) the conversation this turn belongs to.
    let convId: string;
    let projectName: string;
    let history: Msg[];

    if (target) {
      // One run per conversation — ignore sends while this chat is busy.
      if (activeRuns[target.id]) return;
      convId = target.id;
      projectName = target.project;
      history = [...(convMsgsRef.current[convId] ?? []), userMsg];
      updateConvMsgs(convId, (prev) => [...prev, userMsg]);
    } else {
      convId = `c-${Date.now()}`;
      projectName = newChatProject;
      const title = promptText.length > 42 ? `${promptText.slice(0, 42)}…` : promptText;
      const conv: Conversation = {
        id: convId,
        title,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      setProjects((prev) =>
        prev.map((p) =>
          p.name !== projectName ? p : { ...p, conversations: [conv, ...p.conversations] }
        )
      );
      await db.insertConversation(projectName, conv);
      history = [userMsg];
      setActiveConv({ project: projectName, id: convId });
      // The new-chat draft becomes this conversation's buffer.
      setConvMsgs((prev) => {
        const next = { ...prev };
        delete next[DRAFT_ID];
        next[convId] = history;
        return next;
      });
      setView("chat");
    }
    await db.appendMessage(convId, "user", promptText, {
      images: images.length ? images : undefined,
    });
    bumpConversationActivity(convId);

    // Find the provider/model the user picked in the prompt box.
    const provider = providers.find((p) => p.id === selection.gatewayId);
    const modelRow = models.find(
      (m) => m.provider_id === selection.gatewayId && m.model_id === selection.modelId
    );
    if (!provider || !modelRow) {
      const note = "No model selected — add a provider in Settings → Models.";
      updateConvMsgs(convId, (prev) => [...prev, { role: "agent", text: note }]);
      return;
    }

    const oauth = {
      clientId: localStorage.getItem("google_client_id") ?? "",
      clientSecret: localStorage.getItem("google_client_secret") ?? "",
    };
    const cred = await db.credentialFor(provider, oauth);
    if (cred.error) {
      const note = `${provider.name}: ${cred.error}`;
      updateConvMsgs(convId, (prev) => [...prev, { role: "agent", text: note }]);
      return;
    }

    // With agent mode on the tools always have a workspace; the only case worth
    // reporting is the shell not having one ready yet.
    if (agentMode && !workspace.trim()) {
      updateConvMsgs(convId, (prev) => [
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

    // Placeholder that grows as deltas arrive — always into THIS conversation,
    // whatever the user is looking at while the run streams.
    const requestId = `req-${Date.now()}`;
    const startedAt = Date.now();
    updateConvMsgs(convId, (prev) => [...prev, { role: "agent", text: "", segments: [] }]);
    setActiveRuns((prev) => ({ ...prev, [convId]: requestId }));

    /** Appends streamed prose to the current text segment of the live turn. */
    const appendDelta = (delta: string) => {
      updateConvMsgs(convId, (prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (!last || last.role !== "agent") return prev;

        const segs = [...(last.segments ?? [])];
        const tail = segs[segs.length - 1];
        // Keep appending into the open text segment; a step closes it, so the
        // next prose starts a fresh segment right after that call.
        if (tail && tail.kind === "text") {
          segs[segs.length - 1] = { kind: "text", text: tail.text + delta };
        } else {
          segs.push({ kind: "text", text: delta });
        }
        next[next.length - 1] = { ...last, text: last.text + delta, segments: segs };
        return next;
      });
    };

    /** Appends model reasoning to its own block, kept out of the answer. */
    const appendThink = (delta: string) => {
      updateConvMsgs(convId, (prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (!last || last.role !== "agent") return prev;

        const segs = [...(last.segments ?? [])];
        const tail = segs[segs.length - 1];
        if (tail && tail.kind === "think") {
          segs[segs.length - 1] = { kind: "think", text: tail.text + delta };
        } else {
          segs.push({ kind: "think", text: delta });
        }
        // `text` stays reasoning-free: it is what gets stored and replayed.
        next[next.length - 1] = { ...last, segments: segs };
        return next;
      });
    };

    /** Records a tool call: `done=false` shows it as running, `done=true`
     * replaces the same card with its result. */
    const appendStep = (step: db.AgentStepEvent) => {
      updateConvMsgs(convId, (prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (!last || last.role !== "agent") return prev;

        const segs = [...(last.segments ?? [])];
        const at = segs.findIndex(
          (s) => s.kind === "step" && s.step.index === step.index
        );
        if (at >= 0) {
          segs[at] = { kind: "step", step };
        } else {
          segs.push({ kind: "step", step });
        }
        next[next.length - 1] = { ...last, segments: segs };
        return next;
      });
    };

    const historyTurns = history.map((m) => ({ role: m.role, text: m.text }));

    try {
      // With a workspace set, run the full agent loop so the model can read,
      // write and execute — otherwise it is a plain streaming chat.
      const useAgent = !!workspace.trim() && agentMode;
      // Per-project permission: bypass runs everything, ask prompts for every
      // command, default inherits the global "Run commands without asking".
      const runProject = projects.find((p) => p.name === projectName);
      const permMode = runProject?.permMode ?? "default";
      const autoRun = permMode === "bypass" ? true : permMode === "ask" ? false : globalAutoRun;

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
              auto_run: autoRun,
              images,
            },
            historyTurns,
            {
              onText: appendDelta,
              onStep: appendStep,
              onThink: appendThink,
              // Parked per run id: a background run's request stays available
              // and reappears the moment the user opens that chat.
              onConfirm: (req) =>
                setConfirmReqs((prev) => ({ ...prev, [req.run_id]: req })),
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

      const elapsed = Date.now() - startedAt;
      if (answer.trim()) {
        await db.appendMessage(convId, "agent", answer, { durationMs: elapsed });
        bumpConversationActivity(convId);
      }
      // Show the elapsed time on the live message right away.
      updateConvMsgs(convId, (prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "agent") {
          next[next.length - 1] = { ...last, durationMs: elapsed };
        }
        return next;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const elapsed = Date.now() - startedAt;
      updateConvMsgs(convId, (prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "agent" && last.text === "") {
          next[next.length - 1] = { role: "agent", text: `⚠️ ${msg}`, durationMs: elapsed };
        } else {
          next.push({ role: "agent", text: `⚠️ ${msg}`, durationMs: elapsed });
        }
        return next;
      });
    } finally {
      setActiveRuns((prev) => {
        const next = { ...prev };
        delete next[convId];
        return next;
      });
      setConfirmReqs((prev) => {
        const next = { ...prev };
        delete next[requestId];
        return next;
      });
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
          runningConversations={runningConvIds}
          onSelectConversation={openConversation}
          onNewConversation={() => {
            // Plain "New Conversation" starts a chat with no project folder.
            setNewChatProject(NO_PROJECT);
            setActiveConv(null);
            setConvMsgs((prev) => ({ ...prev, [DRAFT_ID]: [] }));
            setView("new");
          }}
          onNewConversationInProject={(project) => {
            setNewChatProject(project);
            setActiveConv(null);
            setConvMsgs((prev) => ({ ...prev, [DRAFT_ID]: [] }));
            setView("new");
          }}
          onShowView={(v) => setView(v)}
          onOpenSettings={() => setModal("settings")}
          onOpenProjectSettings={(name) => {
            setSettingsProject(name);
            setModal("project-settings");
          }}
          onNewProject={() => setModal("new-project")}
          onRenameConversation={renameConversation}
          onDeleteConversation={deleteConversation}
          onTogglePin={togglePin}
        />

        <div className="flex min-w-0 flex-1 flex-col bg-[var(--bg-app)]">
          {view !== "new" && (
            <div className="flex items-center gap-2 px-4 py-3 text-[16px] font-semibold text-[var(--text-main)]">
              {activeTitle}
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
                  pickedModel={pickedModel}
                  onPickModel={pickModel}
                  onTranscribe={transcribeForProvider}
                  onSend={(text, selection, attachments) => sendMessage(text, null, selection, attachments)}
                />
              </motion.div>
            </div>
          )}

          {view === "chat" && (
            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
              <ScrollArea className="flex-1" innerClassName="py-4" scrollRef={chatRef}>
                <div className="px-6">
                  <div
                    className="mx-auto flex w-full max-w-[760px] flex-col gap-4"
                    key={activeConv?.id ?? "new"}
                  >
                    <AnimatePresence initial={false}>
                      {draftMsgs.map((m, i) => (
                        <motion.div
                          key={i}
                          initial={{ opacity: 0, y: 12 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.2, ease: "easeOut" }}
                        >
                          <ChatMessage
                            role={m.role}
                            text={m.text}
                            segments={m.segments}
                            streaming={streaming && i === draftMsgs.length - 1}
                            durationMs={m.durationMs}
                            images={m.images}
                            onInspectStep={(step) => {
                              // A changed file opens the Changes panel focused on it;
                              // a command opens its full output in the Commands panel.
                              if (step.path && step.new_text !== undefined) {
                                setPanel({ kind: "changes", file: step.path });
                              } else if (step.name === "run_command") {
                                setPanel({ kind: "commands", stepIndex: step.index });
                              }
                            }}
                            onInspectImage={(img) => setPanel({ kind: "image", image: img })}
                          />
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                </div>
              </ScrollArea>

              {/* The agent is paused on a command that needs permission. */}
              <AnimatePresence>
                {confirmReq && (
                  <motion.div
                    className="px-6 pb-1"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                  >
                    <div className="mx-auto flex w-full max-w-[760px] items-center gap-3 rounded-xl border border-[var(--accent)]/50 bg-[var(--bg-surface)] px-3.5 py-2.5 shadow-[var(--shadow-popup)]">
                      <Shield size={15} className="shrink-0 text-[var(--accent)]" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-medium text-[var(--text-main)]">
                          The agent wants to run a command
                        </div>
                        <code className="mt-0.5 block truncate font-mono text-[11px] text-[var(--text-muted)]">
                          {confirmReq.command}
                        </code>
                      </div>
                      <button
                        className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                        onClick={() => {
                          const req = confirmReq;
                          setConfirmReqs((prev) => {
                            const next = { ...prev };
                            delete next[req.run_id];
                            return next;
                          });
                          void db.confirmCommand(req.run_id, true);
                        }}
                      >
                        Allow
                      </button>
                      <button
                        className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)]"
                        onClick={() => {
                          const req = confirmReq;
                          setConfirmReqs((prev) => {
                            const next = { ...prev };
                            delete next[req.run_id];
                            return next;
                          });
                          void db.confirmCommand(req.run_id, false);
                        }}
                      >
                        Deny
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

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
                onSend={(text, selection, attachments) => sendMessage(text, activeConv, selection, attachments)}
                projects={projects}
                project={activeConv?.project ?? NO_PROJECT}
                onSelectProject={() => {}}
                gateways={gateways}
                pickedModel={pickedModel}
                onPickModel={pickModel}
                onTranscribe={transcribeForProvider}
                busy={streaming}
                onStop={() => {
                  const run = activeConv ? activeRuns[activeConv.id] : undefined;
                  if (run) void db.stopGeneration(run);
                }}
              />
              </div>

              {/* Right inspection panel — opened by clicking a file/command/photo. */}
              <AnimatePresence>
                {panel.kind !== "none" && activeConv && (
                  <InspectionPanel
                    panel={panel}
                    msgs={draftMsgs}
                    onNavigate={setPanel}
                    onClose={() => setPanel({ kind: "none" })}
                  />
                )}
              </AnimatePresence>
            </div>
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
              onProvidersChanged={setProviders}
              onModelsChanged={setModels}
              globalAutoRun={globalAutoRun}
              onGlobalAutoRun={(next) => {
                setGlobalAutoRun(next);
                void db.setSetting("global_auto_run", next ? "1" : "0");
              }}
              onClose={() => setModal("none")}
            />
          )}
          {modal === "schedule" && (
            <ScheduleModal
              onAdd={(t) => setScheduled((s) => [...s, t])}
              onClose={() => setModal("none")}
            />
          )}
          {modal === "new-project" && (
            <NewProjectModal
              onCreate={async (name, path) => {
                await addProject(name, path);
                setModal("none");
              }}
              onClose={() => setModal("none")}
            />
          )}
          {modal === "project-settings" && settingsProject && (
            <ProjectSettingsModal
              project={projects.find((p) => p.name === settingsProject) ?? null}
              onRename={async (oldName, newName) => {
                await renameProject(oldName, newName);
                setSettingsProject(newName);
              }}
              onPermMode={async (name, mode) => {
                setProjects((prev) =>
                  prev.map((p) => (p.name === name ? { ...p, permMode: mode } : p))
                );
                await db.setProjectPermMode(name, mode);
              }}
              onDelete={async (name) => {
                await removeProject(name);
                setModal("none");
              }}
              onClose={() => setModal("none")}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
