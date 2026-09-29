import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Shield, ShieldAlert, ChevronDown } from "lucide-react";
import * as db from "../core/db.r";
import type { AppMode, Effort, Model, ScheduledTask, Project, Provider, SshConn, SshKey, SshProxy, SshScript, SshServer, Theme, UnitsTab, ViewKind, Attachment } from "../core/types.i";
import { NO_PROJECT, THEMES } from "../core/types.i";
import { toGateways } from "../utils/gateways.u";
import { useBlockContextMenu } from "../hooks/useBlockContextMenu.h";
import { ScrollArea } from "../ui/ScrollArea.c";
import { GenerationGlow, type GenAnimation } from "../ui/GenerationGlow.c";

import type { PanelState, PanelTabSpec } from "../chat/message.i";
import { storedToMsg, fileLabel, toolLabel } from "../chat/message.u";
import { ChatMessage } from "../chat/ChatMessage.c";
import { useChat, DRAFT_ID } from "../hooks/useChat.h";
import { useScheduledTasks } from "../hooks/useScheduledTasks.h";
import type { ChatSelection } from "../hooks/useChat.h";
import { PromptBox, type PromptCommand } from "../chat/PromptBox.c";
import { ContextMeter } from "../chat/ContextMeter.c";
import { CompactNote } from "../chat/CompactNote.c";
import { InspectionPanel } from "../chat/InspectionPanel.c";
import { TitleBar } from "../layout/TitleBar.c";
import { Sidebar } from "../layout/Sidebar.c";
import { SshSidebar } from "../layout/SshSidebar.c";
import { HistoryView } from "../views/HistoryView.p";
import { TasksView } from "../views/TasksView.p";
import { UnitsView } from "../views/UnitsView.p";
import { SshLogsView } from "../views/SshLogsView.p";
import { TerminalView, forgetConnSession, pasteIntoConn } from "../views/TerminalView.p";
import { FilesView } from "../views/FilesView.p";
import { SshPanel } from "../layout/SshPanel.c";
import type { SshPanelTarget } from "../layout/SshPanel.c";
import { NewProjectModal } from "../settings/NewProjectModal.c";
import { ScheduleModal } from "../settings/ScheduleModal.c";
import { SettingsModal } from "../settings/SettingsModal.c";
import type { SettingsSection } from "../settings/SettingsModal.c";

/** Loose chats (no folder). Kept as a real entry so every row action just works. */
const NO_PROJECT_ENTRY: Project = {
  name: NO_PROJECT,
  path: "",
  conversations: [],
};


/* ---------- Custom title bar ---------- */

/** Inspection panel width bounds, px. */
const PANEL_MIN_W = 260;

const PANEL_MAX_W = 720;

export default function App() {
  // No default browser context menu anywhere in the window.
  useBlockContextMenu();
  /** Right inspection panel of the chat view. */
  const [panel, setPanel] = useState<PanelState>({ kind: "none" });
  /** Panel width, drag-resizable and persisted like the sidebar's. */
  const [panelWidth, setPanelWidth] = useState(340);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  /** View → Hide Sidebar (Ctrl+B); remembered across launches. */
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try {
      return localStorage.getItem("dsh:sidebar-hidden") === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarHidden((h) => {
      try {
        localStorage.setItem("dsh:sidebar-hidden", h ? "0" : "1");
      } catch {
        /* per-viewer convenience only */
      }
      return !h;
    });
  }, []);
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
  /** Task open in the Schedule dialog (undefined = creating a new one). */
  const [editingTask, setEditingTask] = useState<ScheduledTask | undefined>(undefined);
  const [modal, setModal] = useState<
    "none" | "settings" | "schedule" | "new-project"
  >("none");
  /** Which project the Settings modal's "Project Settings" tab focuses. */
  const [settingsProject, setSettingsProject] = useState<string | null>(null);
  /** Tab Settings opens on — "Project Settings" jumps straight there. */
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [view, setView] = useState<ViewKind>("chat");
  const [activeConv, setActiveConv] = useState<{ project: string; id: string } | null>(null);
  const [newChatProject, setNewChatProject] = useState(NO_PROJECT);
  /** False until the first DB read finishes. */
  const [persistent, setPersistent] = useState(false);
  /** Workspace root the agent's file/command tools operate inside. */
  const [workspace, setWorkspace] = useState(
    () => localStorage.getItem("agent_workspace") ?? ""
  );
  /** The app's own agent folder (projects without a directory run there). */
  const [appWorkspace, setAppWorkspace] = useState("");
  useEffect(() => {
    void db.appWorkspace().then(setAppWorkspace);
  }, []);
  /** When off, prompts are answered by plain chat with no tool access. */
  const [agentMode] = useState(() => localStorage.getItem("agent_mode") !== "off");
  /** Global command permission — the default for projects set to "As default". */
  const [globalAutoRun, setGlobalAutoRun] = useState(false);
  /** Debug mode: live token/speed/cache HUD inside the chat transcript.
   *  Persisted as the "debug_mode" setting. */
  const [debugMode, setDebugMode] = useState(false);
  /** Animation behind the chat while the model works ("gen_animation"). */
  const [genAnimation, setGenAnimation] = useState<GenAnimation>(
    () => (localStorage.getItem("gen_animation") as GenAnimation | null) ?? "pixels"
  );
  /** Last picked model, restored on launch so the chat remembers its choice. */
  const [pickedModel, setPickedModel] = useState<{ gatewayId: string; modelId: string } | null>(
    null
  );
  const chatRef = useRef<HTMLDivElement>(null);

  /* ---------- App mode (Agent ↔ SSH Client) ----------
     The mode only swaps what the sidebar and the main area SHOW. Agent runs
     live in Rust and keep streaming into their buffers regardless of which
     mode is on screen — switching modes never interrupts a generation. */
  const [mode, setMode] = useState<AppMode>("agent");
  /** View to return to when the user switches back to Agent mode. */
  const agentViewRef = useRef<ViewKind>("chat");
  const [sshServers, setSshServers] = useState<SshServer[]>([]);
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  /** Saved proxies — Units page only (not in the sidebar). */
  const [sshProxies, setSshProxies] = useState<SshProxy[]>([]);
  const [sshScripts, setSshScripts] = useState<SshScript[]>([]);
  const [sshConnectedIds, setSshConnectedIds] = useState<string[]>([]);
  const [sshBusyIds, setSshBusyIds] = useState<string[]>([]);
  const [sshNotice, setSshNotice] = useState<string | null>(null);
  /** True when the vault master key is safely persisted (OS keyring/file). */
  const [sshVaultBacked, setSshVaultBacked] = useState(true);
  /** Which Units collection the switcher shows. */
  const [unitsTab, setUnitsTab] = useState<UnitsTab>("servers");
  /**
   * Open connection pages — Termius-style tabs. One server can have many
   * (each terminal click opens a NEW PTY session; each SFTP page is its own
   * entry). The sidebar's Connections section lists them; closing a row
   * closes the page and kills its PTY session.
   */
  const [sshConns, setSshConns] = useState<SshConn[]>([]);
  /** Connection whose page is on screen. */
  const [activeConn, setActiveConn] = useState<string | null>(null);
  /** Width of the docked right-hand panel (drag-resized like the chat panel). */
  const [sshPanelWidth, setSshPanelWidth] = useState(400);
  /** True while the panel's left edge is being dragged — disables the width
   *  animation so the panel tracks the cursor exactly. */
  const [sshPanelResizing, setSshPanelResizing] = useState(false);
  /**
   * The docked right-hand panel of SSH mode: create / edit / settings forms
   * live here instead of dialogs (Termius-style). Null = closed.
   */
  const [sshPanel, setSshPanel] = useState<SshPanelTarget | null>(null);

  /** Helper agents (Settings → Agent) and how many may work at once. */
  const [subagents, setSubagents] = useState<db.Subagent[]>([]);
  const [maxAgents, setMaxAgents] = useState(2);
  /** Retries of a failed model request before a run gives up. */
  const [maxRetries, setMaxRetries] = useState(5);
  useEffect(() => {
    void db.loadSubagents().then(setSubagents);
    void db.loadMaxAgents().then(setMaxAgents);
    void db.loadMaxRetries().then(setMaxRetries);
  }, []);

  /** Chat state + lifecycle: messages, streaming, tools, stop, edit/resend. */
  const chat = useChat({
    providers,
    models,
    projects,
    workspace,
    appWorkspace,
    agentMode,
    globalAutoRun,
    sshServers,
    subagents,
    maxAgents,
    maxRetries,
    pickedModel,
    newChatProject,
    onConversationCreated: (project, conv, open) => {
      setProjects((prev) =>
        prev.map((p) => (p.name !== project ? p : { ...p, conversations: [conv, ...p.conversations] }))
      );
      if (!open) return;
      setActiveConv({ project, id: conv.id });
      setView("chat");
    },
    onActivity: (convId) => bumpConversationActivity(convId),
    onTitle: (project, convId, title) =>
      setProjects((prev) =>
        prev.map((p) =>
          p.name !== project
            ? p
            : { ...p, conversations: p.conversations.map((c) => (c.id === convId ? { ...c, title } : c)) }
        )
      ),
  });
  const { convMsgs, setConvMsgs, activeRuns, runPhase, erroredConv, confirmReqs } = chat;

  /** Scheduled Tasks: each due run is a new background chat in the task's project. */
  const schedule = useScheduledTasks(async (t) => {
    if (!projects.some((p) => p.name === t.project)) return null; // project was deleted
    return chat.send(
      t.prompt,
      null,
      {
        gatewayId: t.provider_id,
        modelId: t.model_id,
        effort: (localStorage.getItem("effort") as Effort) || "medium",
      },
      [],
      { project: t.project, background: true }
    );
  });

  /** Messages of the conversation currently on screen. */
  const draftMsgs = activeConv
    ? convMsgs[activeConv.id] ?? []
    : convMsgs[DRAFT_ID] ?? [];
  /** True while THIS conversation has a generation running. */
  const streaming = !!activeConv && !!activeRuns[activeConv.id];
  /**
   * Aurora palette for the prompt box, derived from the on-screen chat's run:
   * red after a failed turn, indigo while it thinks, amber once text streams,
   * calm mint when idle.
   */
  const promptMood: "idle" | "thinking" | "streaming" | "error" = activeConv
    ? erroredConv === activeConv.id
      ? "error"
      : activeRuns[activeConv.id]
        ? runPhase[activeConv.id] === "streaming"
          ? "streaming"
          : "thinking"
        : "idle"
    : "idle";
  /** The pending Allow/Deny request of the conversation on screen, if any. */
  const confirmReq = streaming ? confirmReqs[activeRuns[activeConv!.id]] ?? null : null;
  /** Ids of conversations with a live run — drives the sidebar pulse. */
  const runningConvIds = Object.keys(activeRuns);


  // Adaptive re-clamp: shrinking the window (or growing the sidebar) must
  // never leave the SSH panel wider than the space that remains — otherwise
  // the main column is squeezed off-screen. Runs on every window resize and
  // caps the panel to window − sidebar − 320px of usable main area.
  useEffect(() => {
    const onResize = () => {
      const maxW = Math.max(
        PANEL_MIN_W,
        Math.min(PANEL_MAX_W, window.innerWidth - sidebarWidth - 320)
      );
      setSshPanelWidth((w) => (w > maxW ? maxW : w));
      setPanelWidth((w) => (w > maxW ? maxW : w));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [sidebarWidth]);

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

  /* ---------- App mode switching ----------
     Swapping modes only changes what the sidebar/main area render. Agent runs
     are owned by Rust and keep streaming into their per-conversation buffers,
     so nothing is cancelled by a switch — the run even finishes while you are
     looking at the SSH units. */
  const applyMode = useCallback(
    (next: AppMode) => {
      if (mode === next) return;
      if (next === "ssh") {
        // Park the current agent view so returning restores it exactly.
        agentViewRef.current = view;
        setView("units");
      } else {
        setView(agentViewRef.current);
      }
      setMode(next);
      void db.setSetting("app_mode", next);
    },
    [mode, view]
  );

  /** Set once boot has restored mode + page, so the initial state isn't saved over them. */
  const bootedRef = useRef(false);

  // Remember the last page per mode — the next launch reopens it.
  useEffect(() => {
    if (!bootedRef.current) return;
    localStorage.setItem(`dsh:last-view:${mode}`, view);
  }, [mode, view]);

  /* ---------- SSH Client data ---------- */

  /**
   * A list was dragged into a new order: show it at once, then persist.
   * Open connections are session-only, so their order is not stored.
   */
  const reorderSsh = useCallback((kind: "server" | "key" | "script" | "proxy" | "conn", ids: string[]) => {
    const sortBy = <T extends { id: string }>(cur: T[]): T[] => {
      const byId = new Map(cur.map((x) => [x.id, x]));
      const moved = ids.map((id) => byId.get(id)).filter((x): x is T => !!x);
      return [...moved, ...cur.filter((x) => !ids.includes(x.id))];
    };
    if (kind === "conn") {
      setSshConns(sortBy);
      return;
    }
    if (kind === "server") setSshServers(sortBy);
    else if (kind === "key") setSshKeys(sortBy);
    else if (kind === "proxy") setSshProxies(sortBy);
    else setSshScripts(sortBy);
    void db.reorderSshUnits(kind, ids).catch(() => {
      void db.loadSshServers().then(setSshServers).catch(() => {});
      void db.loadSshKeys().then(setSshKeys).catch(() => {});
      void db.loadSshProxies().then(setSshProxies).catch(() => {});
      void db.loadSshScripts().then(setSshScripts).catch(() => {});
    });
  }, []);

  const reloadSshServers = useCallback(() => {
    void db.loadSshServers().then(setSshServers).catch(() => {});
    void db.loadSshKeys().then(setSshKeys).catch(() => {});
    void db.loadSshProxies().then(setSshProxies).catch(() => {});
    void db.loadSshScripts().then(setSshScripts).catch(() => {});
    void db.sshConnected().then(setSshConnectedIds).catch(() => {});
    void db.sshVaultBacked().then(setSshVaultBacked).catch(() => {});
  }, []);

  // Load units once, then track live status/log events pushed by Rust.
  useEffect(() => {
    reloadSshServers();
    let off: (() => void) | undefined;
    void db
      .onSshEvent({
        onStatus: (ids) => setSshConnectedIds(ids),
        onLogged: () => {},
        // A connect just detected the remote OS — patch the row in place so
        // the logo appears without a full reload.
        onOs: ([serverId, os]) =>
          setSshServers((prev) =>
            prev.map((s) => (s.id === serverId ? { ...s, os } : s))
          ),
      })
      .then((fn) => {
        off = fn;
      });
    return () => off?.();
  }, [reloadSshServers]);

  /**
   * Open (or focus) a connection page. Terminal/SFTP pages are Termius-style
   * tabs: fresh=true always appends a NEW connection (a second terminal on
   * the same server gets its own PTY); otherwise an existing page of the same
   * server+kind is focused — several connections per server is expected.
   */
  // Mirrors sshConns/activeConn for the handlers below: state updaters must
  // stay pure (React StrictMode runs them twice), so reads go through refs.
  const sshConnsRef = useRef<SshConn[]>([]);
  sshConnsRef.current = sshConns;
  const activeConnRef = useRef<string | null>(null);
  activeConnRef.current = activeConn;

  const openSshConn = useCallback(
    (serverId: string, kind: "terminal" | "sftp", fresh = false) => {
      const prev = sshConnsRef.current;
      if (!fresh) {
        const existing = prev.find((c) => c.serverId === serverId && c.kind === kind);
        if (existing) {
          setActiveConn(existing.id);
          setView(kind === "terminal" ? "ssh-terminal" : "ssh-files");
          return;
        }
      }
      const id = "conn-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
      setSshConns([...prev, { id, serverId, kind }]);
      setActiveConn(id);
      setView(kind === "terminal" ? "ssh-terminal" : "ssh-files");
    },
    []
  );

  /** Sidebar Connections row → focus that page. */
  const selectSshConn = useCallback((connId: string) => {
    const c = sshConnsRef.current.find((x) => x.id === connId);
    if (!c) return;
    setActiveConn(connId);
    setView(c.kind === "terminal" ? "ssh-terminal" : "ssh-files");
  }, []);

  /** Close a connection: drop the page and kill its PTY session (if any). */
  const closeSshConn = useCallback((connId: string) => {
    const prev = sshConnsRef.current;
    const idx = prev.findIndex((x) => x.id === connId);
    if (idx < 0) return;
    const dying = prev[idx];
    if (dying.sessionId) void db.sshShellClose(dying.sessionId).catch(() => {});
    forgetConnSession(connId);
    const next = prev.filter((x) => x.id !== connId);
    setSshConns(next);
    // Focus a neighbour, like closing a chat panel tab does.
    if (activeConnRef.current === connId) {
      const neighbor = next[Math.max(0, idx - 1)] ?? null;
      setActiveConn(neighbor?.id ?? null);
      setView(neighbor ? (neighbor.kind === "terminal" ? "ssh-terminal" : "ssh-files") : "units");
    }
  }, []);

  /** Sidebar gear / row click → the unit's form in the right-hand panel. */
  const openSshPanel = useCallback((target: SshPanelTarget) => {
    setSshPanel(target);
  }, []);

  // A server deleted anywhere (panel, another window) drops its connections.
  useEffect(() => {
    setSshConns((prev) => {
      if (prev.length === 0) return prev;
      const alive = prev.filter((c) => sshServers.some((s) => s.id === c.serverId));
      if (alive.length === prev.length) return prev;
      for (const gone of prev) {
        if (!alive.includes(gone)) {
          if (gone.sessionId) void db.sshShellClose(gone.sessionId).catch(() => {});
          forgetConnSession(gone.id);
        }
      }
      setActiveConn((cur) => (alive.some((c) => c.id === cur) ? cur : null));
      return alive;
    });
  }, [sshServers]);

  const setSshBusy = (id: string, busy: boolean) =>
    setSshBusyIds((prev) => (busy ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));

  const connectServer = useCallback((id: string) => {
    setSshBusy(id, true);
    setSshNotice(null);
    db.sshConnect(id)
      .then(() => db.sshConnected())
      .then(setSshConnectedIds)
      .catch((e) => setSshNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => setSshBusy(id, false));
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

      // Restore user settings persisted in SQLite (falls back to localStorage
      // values from older versions, then to defaults).
      const [globalAuto, picked, savedTheme, savedPanelW, savedSshPanelW, savedDebug, savedMode] =
        await Promise.all([
          db.getSetting("global_auto_run"),
          db.getSetting("picked_model"),
          db.getSetting("theme"),
          db.getSetting("panel_width"),
          db.getSetting("ssh_panel_width"),
          db.getSetting("debug_mode"),
          db.getSetting("app_mode"),
        ]);
      const savedAnim = await db.getSetting("gen_animation");
      if (!cancelled && (savedAnim === "pixels" || savedAnim === "aurora" || savedAnim === "off")) {
        setGenAnimation(savedAnim);
      }
      if (!cancelled && savedDebug !== null) setDebugMode(savedDebug === "1");
      if (!cancelled && savedPanelW) {
        const w = Number(savedPanelW);
        if (Number.isFinite(w)) setPanelWidth(Math.min(Math.max(w, PANEL_MIN_W), PANEL_MAX_W));
      }
      if (!cancelled && savedSshPanelW) {
        const w = Number(savedSshPanelW);
        if (Number.isFinite(w)) {
          // Clamp against the ACTUAL window: a width saved on a big monitor
          // must never push the main column off-screen on a smaller one.
          const maxW = Math.max(
            PANEL_MIN_W,
            Math.min(PANEL_MAX_W, window.innerWidth - sidebarWidth - 320)
          );
          setSshPanelWidth(Math.min(Math.max(w, PANEL_MIN_W), maxW));
        }
      }
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

      // Reopen the page the app was closed on, per mode. Agent: the last
      // chat (if it still exists), History or Tasks — otherwise New
      // Conversation. SSH: Units or Logs — terminal/files tabs don't survive
      // a restart, so those land on Units.
      const sshMode = savedMode === "ssh";
      const agentView = localStorage.getItem("dsh:last-view:agent") ?? "chat";
      const sshView = localStorage.getItem("dsh:last-view:ssh");
      const restoredSshView: ViewKind = sshView === "ssh-logs" ? "ssh-logs" : "units";
      if (sshMode) setMode("ssh");
      /** Shows an agent page — or parks it for the switch back when SSH is on screen. */
      const showAgent = (v: ViewKind) => {
        agentViewRef.current = v;
        setView(sshMode ? restoredSshView : v);
      };

      const lastId = agentView === "chat" ? localStorage.getItem("dsh:last-conv") : null;
      const reattachId = (() => {
        try {
          return (JSON.parse(localStorage.getItem("dsh:live-run") ?? "null") as { convId?: string } | null)?.convId ?? null;
        } catch {
          return null;
        }
      })();
      // A run that was live across the reload always wins — its re-attach
      // effect owns that conversation's buffer.
      const targetId = reattachId ?? lastId;
      const owner = targetId ? nextProjects.find((p) => p.conversations.some((c) => c.id === targetId)) : undefined;
      const conv = owner?.conversations.find((c) => c.id === targetId);
      if (owner && conv) {
        setActiveConv({ project: owner.name, id: conv.id });
        showAgent("chat");
        // The re-attach effect loads the stored rows AND appends the streaming
        // draft for its conversation; overwriting here would wipe it mid-stream.
        if (conv.id !== reattachId) {
          const stored = await db.loadMessages(conv.id);
          if (!cancelled && stored.length) {
            setConvMsgs((prev) => ({
              ...prev,
              [conv!.id]: stored.map(storedToMsg),
            }));
          }
        }
      } else if (agentView === "history" || agentView === "tasks") {
        showAgent(agentView);
      } else {
        // Closed on New Conversation, or the last chat is gone.
        setNewChatProject(NO_PROJECT);
        setConvMsgs((prev) => ({ ...prev, [DRAFT_ID]: prev[DRAFT_ID] ?? [] }));
        showAgent("new");
      }
      if (!cancelled) bootedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);



  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  /**
   * True when the chat is scrolled far enough from the bottom that new output
   * is off-screen — drives the floating "jump to the latest message" button.
   */
  const [chatScrolledUp, setChatScrolledUp] = useState(false);
  /**
   * Auto-follow new output only while the user is already at the bottom.
   * Scrolling up to re-read detaches it, so a streaming answer can never
   * yank the viewport back down mid-read.
   */
  const chatStickRef = useRef(true);

  useEffect(() => {
    const el = chatRef.current;
    if (el && chatStickRef.current) el.scrollTop = el.scrollHeight;
  }, [draftMsgs]);

  // Opening another chat (or view) always lands at the newest message.
  useEffect(() => {
    chatStickRef.current = true;
    setChatScrolledUp(false);
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeConv, view]);

  useEffect(() => {
    const el = chatRef.current;
    if (!el || view !== "chat") return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const away = distance > 160;
      chatStickRef.current = !away;
      setChatScrolledUp(away);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [view, activeConv]);

  /** Smooth-scrolls the chat back to the newest message and re-attaches follow. */
  const scrollToChatBottom = () => {
    const el = chatRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    chatStickRef.current = true;
  };

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

  /**
   * Drag-resize of the inspection panel. Its handle sits on the panel's LEFT
   * edge, so dragging left grows it (width = start − dx). The width reached at
   * mouse-up is persisted so the next launch reuses it.
   */
  const startPanelResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    let latest = startW;
    const onMove = (ev: MouseEvent) => {
      latest = Math.min(Math.max(startW - (ev.clientX - startX), PANEL_MIN_W), PANEL_MAX_W);
      setPanelWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      void db.setSetting("panel_width", String(latest));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /**
   * Drag-resize of the SSH right-hand panel — same mechanics as the chat
   * inspection panel: handle on the LEFT edge, dragging left grows it, the
   * width reached at mouse-up is persisted.
   */
  const startSshPanelResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sshPanelWidth;
    // Never wider than the window minus the left sidebar and a usable main
    // column — the chat panel gets away without this because it is narrower.
    const maxW = Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, window.innerWidth - sidebarWidth - 320));
    let latest = startW;
    // While dragging, the open/close width animation is switched OFF so the
    // panel follows the cursor 1:1 instead of lagging behind it.
    setSshPanelResizing(true);
    const onMove = (ev: MouseEvent) => {
      latest = Math.min(Math.max(startW - (ev.clientX - startX), PANEL_MIN_W), maxW);
      setSshPanelWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setSshPanelResizing(false);
      void db.setSetting("ssh_panel_width", String(latest));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const activeTitle = (() => {
    if (view === "history") return "Conversation History";
    if (view === "tasks") return "Scheduled Tasks";
    // SSH pages render no title bar (each page carries its own heading).
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
    // Boot opens the LAST OPENED chat — not some arbitrary "most recent" row
    // that may not even exist anymore ("при запуске открывается несуществующий чат").
    localStorage.setItem("dsh:last-conv", id);
    // Messages come from the database (a live run keeps its own buffer).
    await chat.load(id);
  };

  /** Providers grouped with their models — feeds the model picker. */
  const gateways = useMemo(() => toGateways(providers, models), [providers, models]);

  /** Remembers the model the user picked, so the next launch restores it. */
  const pickModel = useCallback((next: { gatewayId: string; modelId: string }) => {
    setPickedModel(next);
    void db.setSetting("picked_model", JSON.stringify(next));
  }, []);

  /** Opens the New Conversation screen in Agent mode, optionally inside a project. */
  const startNewChat = (project: string = NO_PROJECT) => {
    if (mode !== "agent") applyMode("agent");
    setNewChatProject(project);
    setActiveConv(null);
    chat.reset(DRAFT_ID);
    setView("new");
  };

  /** Folder a prompt in `project` runs in (the @ menu lists its files). */
  const workspaceOf = (project: string) =>
    projects.find((p) => p.name === project)?.path?.trim() || appWorkspace || workspace;

  /** `/new`, `/skills`, `/mcp`, `/compact` typed in the prompt box. */
  const onPromptCommand = (cmd: PromptCommand, arg?: string) => {
    if (cmd === "new") return startNewChat(activeConv?.project ?? newChatProject);
    if (cmd === "compact") {
      if (!activeConv) return Promise.resolve("Open a conversation to compact it.");
      return chat.compact(activeConv.id, arg ?? "");
    }
    setSettingsSection(cmd);
    setModal("settings");
  };

  /** File → Open Folder: the folder's project (created on first open) + a new chat in it. */
  const openFolder = async () => {
    let picked: string | string[] | null = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      picked = await open({ directory: true, multiple: false, title: "Open folder as a project" });
    } catch {
      return; // no native dialog outside Tauri
    }
    if (typeof picked !== "string") return;
    const norm = (x: string) => x.replace(/[\\/]+$/, "").toLowerCase();
    const existing = projects.find((p) => p.path && norm(p.path) === norm(picked as string));
    if (existing) return startNewChat(existing.name);
    const base = picked.split(/[\\/]/).filter(Boolean).pop() || "Project";
    let name = base;
    for (let i = 2; projects.some((p) => p.name === name); i++) name = `${base} ${i}`;
    await addProject(name, picked);
    startNewChat(name);
  };

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

  /** Changes a project's working directory — the folder agents open when
   *  chatting inside this project. Files on disk are never touched. */
  const setProjectPath = async (name: string, path: string) => {
    setProjects((prev) => prev.map((p) => (p.name === name ? { ...p, path } : p)));
    await db.setProjectPath(name, path);
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
    chat.stop(convId);
    setProjects((prev) =>
      prev.map((p) =>
        p.name !== project
          ? p
          : { ...p, conversations: p.conversations.filter((c) => c.id !== convId) }
      )
    );
    chat.reset(convId, true);
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

  /** Prompt box → useChat. */
  const sendMessage = (
    text: string,
    target: { project: string; id: string } | null,
    selection: ChatSelection,
    attachments: Attachment[] = []
  ) => void chat.send(text, target, selection, attachments);

  /** Opens Settings directly on the "Project Settings" tab for one project. */
  const openProjectSettings = (name: string) => {
    setSettingsProject(name);
    setSettingsSection("project-settings");
    setModal("settings");
  };

  /**
   * Opens an item in the inspection panel as its own closeable tab — the same
   * interaction as editor tabs. Opening an item that is already a tab simply
   * activates it (and refreshes its payload, e.g. a re-sent photo).
   */
  const openPanelTab = useCallback((tab: PanelTabSpec) => {
    setPanel((prev) => {
      if (prev.kind !== "panel") return { kind: "panel", tabs: [tab], activeId: tab.id };
      const exists = prev.tabs.some((t) => t.id === tab.id);
      const tabs = exists
        ? prev.tabs.map((t) => (t.id === tab.id ? tab : t))
        : [...prev.tabs, tab];
      return { kind: "panel", tabs, activeId: tab.id };
    });
  }, []);

  /** Closes one tab; the neighbor becomes active, empty panel closes itself. */
  const closePanelTab = useCallback((id: string) => {
    setPanel((prev) => {
      if (prev.kind !== "panel") return prev;
      const idx = prev.tabs.findIndex((t) => t.id === id);
      const tabs = prev.tabs.filter((t) => t.id !== id);
      if (tabs.length === 0) return { kind: "none" };
      let activeId = prev.activeId;
      if (prev.activeId === id) {
        const neighbor = prev.tabs[Math.max(0, idx - 1)];
        activeId = neighbor ? neighbor.id : tabs[0].id;
      }
      return { kind: "panel", tabs, activeId };
    });
  }, []);

  /** Activates an already-open tab. */
  const selectPanelTab = useCallback((id: string) => {
    setPanel((prev) => (prev.kind === "panel" ? { ...prev, activeId: id } : prev));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TitleBar
        mode={mode}
        onSetMode={applyMode}
        onNewConversation={() => startNewChat()}
        onNewProject={() => {
          if (mode !== "agent") applyMode("agent");
          setModal("new-project");
        }}
        onOpenFolder={() => void openFolder()}
        onOpenSettings={() => {
          setSettingsSection("general");
          setSettingsProject(null);
          setModal("settings");
        }}
        onToggleSidebar={toggleSidebar}
        sidebarHidden={sidebarHidden}
      />
      {/* overflow-hidden: the row must never scroll — a focus jump into the
          right-hand panel used to shift the whole page sideways. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {sidebarHidden ? null : mode === "ssh" ? (
          /* SSH Client mode: Units / Logs nav + the server list, laid out
             exactly like the Agent sidebar's conversations. */
          <SshSidebar
            width={sidebarWidth}
            startResize={startResize}
            servers={sshServers}
            keys={sshKeys}
            scripts={sshScripts}
            conns={sshConns}
            connected={sshConnectedIds}
            view={view}
            activeConn={activeConn}
            activePanel={sshPanel}
            onOpenConn={openSshConn}
            onSelectConn={selectSshConn}
            onCloseConn={closeSshConn}
            onOpenPanel={openSshPanel}
            onReorder={reorderSsh}
            onPasteScript={
              view === "ssh-terminal" && activeConn
                ? (script) => void pasteIntoConn(activeConn, script.content)
                : null
            }
            onShowView={(v) => {
              setView(v);
            }}
            onAdd={(tab) => {
              setUnitsTab(tab);
              setView("units");
              setSshPanel({
                kind: tab === "servers" ? "server" : tab === "keys" ? "key" : tab === "proxies" ? "proxy" : "script",
              });
            }}
            onOpenSettings={() => {
              // Same SettingsModal the Agent mode opens — these settings and
              // only these; unit create/edit forms stay in SshPanel.
              setSettingsSection("general");
              setSettingsProject(null);
              setModal("settings");
            }}
          />
        ) : (
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
              chat.reset(DRAFT_ID);
              setView("new");
            }}
            onNewConversationInProject={(project) => {
              setNewChatProject(project);
              setActiveConv(null);
              chat.reset(DRAFT_ID);
              setView("new");
            }}
            onShowView={(v) => setView(v)}
            onOpenSettings={() => setModal("settings")}
            onOpenProjectSettings={openProjectSettings}
            onNewProject={() => setModal("new-project")}
            onRenameConversation={renameConversation}
            onDeleteConversation={deleteConversation}
            onTogglePin={togglePin}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col bg-[var(--bg-app)]">
          {/* No navbar in SSH Client mode at all: every page there carries its
              own heading (Units / Logs / the unit's settings), and the terminal
              and files pages are full-window. The agent views keep the title. */}
          {view !== "new" && mode !== "ssh" && (
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
                <TasksView
                  tasks={schedule.tasks}
                  models={models}
                  runningIds={schedule.runningIds}
                  onNew={() => {
                    setEditingTask(undefined);
                    setModal("schedule");
                  }}
                  onEdit={(t) => {
                    setEditingTask(t);
                    setModal("schedule");
                  }}
                  onDelete={(t) => {
                    if (confirm(`Delete the scheduled task "${t.name}"? Chats it already created stay.`)) void schedule.remove(t.id);
                  }}
                  onToggle={(t, on) => void schedule.setEnabled(t, on)}
                  onRunNow={(t) => void schedule.runNow(t)}
                  onOpenChat={(t) => {
                    const owner = projects.find((p) => p.conversations.some((c) => c.id === t.last_conv));
                    if (owner) void openConversation(owner.name, t.last_conv);
                  }}
                />
              </div>
            </ScrollArea>
          )}

          {view === "units" && (
            <ScrollArea className="flex-1" innerClassName="py-4">
              <div className="px-6">
                <UnitsView
                  servers={sshServers}
                  keys={sshKeys}
                  scripts={sshScripts}
                  proxies={sshProxies}
                  connected={sshConnectedIds}
                  busyIds={sshBusyIds}
                  notice={sshNotice}
                  vaultBacked={sshVaultBacked}
                  tab={unitsTab}
                  onTab={setUnitsTab}
                  onChanged={reloadSshServers}
                  onEditUnit={(t) => setSshPanel(t)}
                  onAddUnit={(kind) => setSshPanel({ kind })}
                  onConnect={connectServer}
                  onOpenTerminal={(id) => openSshConn(id, "terminal", true)}
                  onReorder={reorderSsh}
                />
              </div>
            </ScrollArea>
          )}

          {view === "ssh-logs" && (
            <ScrollArea className="flex-1" innerClassName="py-4">
              <div className="px-6">
                <SshLogsView />
              </div>
            </ScrollArea>
          )}

          {/* Full-window SSH pages — each connection page carries its own
              header, so the generic title bar above is skipped for them.
              Keyed by the connection id: opening a second terminal on the
              same server mounts a second xterm with its own PTY. */}
          {view === "ssh-terminal" && activeConn && (() => {
            const conn = sshConns.find((c) => c.id === activeConn);
            const s = conn && sshServers.find((x) => x.id === conn.serverId);
            if (!conn || !s) return <SshGone onBack={() => setView("units")} />;
            return (
              <TerminalView
                key={conn.id}
                server={s}
                connId={conn.id}
                onSession={(sid) =>
                  setSshConns((prev) =>
                    prev.map((c) =>
                      c.id === conn.id ? { ...c, sessionId: sid ?? undefined } : c
                    )
                  )
                }
                onOpenFiles={() => openSshConn(s.id, "sftp", true)}
                onClose={() => closeSshConn(conn.id)}
              />
            );
          })()}

          {view === "ssh-files" && activeConn && (() => {
            const conn = sshConns.find((c) => c.id === activeConn);
            const s = conn && sshServers.find((x) => x.id === conn.serverId);
            if (!conn || !s) return <SshGone onBack={() => setView("units")} />;
            return (
              <FilesView
                key={conn.id}
                server={s}
                onOpenTerminal={() => openSshConn(s.id, "terminal", true)}
                onClose={() => closeSshConn(conn.id)}
              />
            );
          })()}

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
                  workspace={workspaceOf(newChatProject)}
                  onCommand={onPromptCommand}
                  onSend={(text, selection, attachments) => sendMessage(text, null, selection, attachments)}
                />
              </motion.div>
            </div>
          )}

          {view === "chat" && (
            <div className="relative isolate flex min-h-0 flex-1 flex-col">
              {/* Aurora Borealis — spans the whole chat column, painted
                  BEHIND every in-flow child via a negative z-index (the
                  column is a stacking context via isolate, so the glow can
                  never slip under the page background).

                  Do NOT "fix" this by giving the content wrapper a positive
                  z-index: the prompt's dropdown popups (model picker, etc.)
                  are trapped inside the glass container's stacking context
                  (backdrop-filter creates one), and any positioned sibling
                  with z > 0 paints over them — menus lose their background
                  and become unclickable. Negative-z aurora keeps the natural
                  paint order those popups rely on. */}
              <div className="absolute inset-0 -z-10 overflow-hidden">
                <GenerationGlow mood={promptMood} style={genAnimation} />
              </div>
              {/* Wrapper hosts the floating "jump to latest" button over the list. */}
              <div className="relative flex min-h-0 flex-1 flex-col">
              <ScrollArea className="flex-1" innerClassName="py-4" scrollRef={chatRef}>
                <div className="px-6">
                  <div
                    className="selectable mx-auto flex w-full max-w-[760px] flex-col gap-4"
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
                          {m.role === "compact" ? (
                            <CompactNote
                              text={m.text}
                              live={streaming && i === draftMsgs.length - 1}
                            />
                          ) : (
                          <ChatMessage
                            role={m.role}
                            text={m.text}
                            segments={m.segments}
                            streaming={streaming && i === draftMsgs.length - 1}
                            durationMs={m.durationMs}
                            images={m.images}
                            debugMode={debugMode}
                            onEdit={
                              m.role === "user" && activeConv && !streaming
                                ? (next) => void chat.editAndResend(activeConv.id, activeConv.project, i, next)
                                : undefined
                            }
                            onInspectStep={(step) => {
                              // Every step opens as its OWN closeable panel tab:
                              // a file change shows its diff, a command its full
                              // output, any other tool its raw result.
                              if (step.path && step.new_text !== undefined) {
                                openPanelTab({
                                  id: `file:${step.path}`,
                                  type: "file",
                                  label: fileLabel(step.path),
                                  path: step.path,
                                });
                              } else if (step.name === "run_command") {
                                openPanelTab({
                                  id: `cmd:${i}:${step.index}`,
                                  type: "command",
                                  label: step.input,
                                  msgIndex: i,
                                  stepIndex: step.index,
                                });
                              } else {
                                openPanelTab({
                                  id: `tool:${i}:${step.index}`,
                                  type: "tool",
                                  label: toolLabel(step),
                                  msgIndex: i,
                                  stepIndex: step.index,
                                });
                              }
                            }}
                            onInspectImage={(img) =>
                              openPanelTab({
                                id: `img:${img.name}`,
                                type: "image",
                                label: img.name,
                                image: img,
                              })
                            }
                          />
                          )}
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                </div>
              </ScrollArea>

              {/* Floating jump-to-bottom — visible only when the newest message
                  is off-screen (scrolled up more than ~160px). */}
              <AnimatePresence>
                {chatScrolledUp && (
                  <motion.button
                    /* Same glass recipe as the prompt container: translucent
                       surface + backdrop blur, so scrolled content shimmers
                       through the pill instead of hiding behind a solid chip. */
                    className="prompt-glass absolute bottom-3 left-1/2 z-20 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full px-3 text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-main)]"
                    initial={{ opacity: 0, y: 8, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 8, scale: 0.95 }}
                    transition={{ duration: 0.15, ease: "easeOut" }}
                    onClick={scrollToChatBottom}
                    title="Jump to the latest message"
                  >
                    <ChevronDown size={14} />
                    Latest
                  </motion.button>
                )}
              </AnimatePresence>
              </div>

              {/* The agent is paused on a command that needs permission. */}
              <AnimatePresence>
                {confirmReq && (
                  <motion.div
                    className="px-6 pb-1"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                  >
                    <div
                      className={
                        "mx-auto flex w-full max-w-[760px] items-center gap-3 rounded-xl border bg-[var(--bg-surface)] px-3.5 py-2.5 shadow-[var(--shadow-popup)] " +
                        (confirmReq.reason ? "border-[var(--diff-del)]/60" : "border-[var(--accent)]/50")
                      }
                    >
                      {confirmReq.reason ? (
                        <ShieldAlert size={15} className="shrink-0 text-[var(--diff-del)]" />
                      ) : (
                        <Shield size={15} className="shrink-0 text-[var(--accent)]" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div
                          className={
                            "text-[12px] font-medium " +
                            (confirmReq.reason ? "text-[var(--diff-del)]" : "text-[var(--text-main)]")
                          }
                        >
                          {confirmReq.reason || "The agent wants to run a command"}
                        </div>
                        <code
                          className="mt-0.5 block truncate font-mono text-[11px] text-[var(--text-muted)]"
                          title={confirmReq.command}
                        >
                          {confirmReq.command}
                        </code>
                        {confirmReq.cwd && (
                          <span className="block truncate text-[10.5px] text-[var(--text-dim)]">{confirmReq.cwd}</span>
                        )}
                      </div>
                      <button
                        className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                        onClick={() => chat.confirm(confirmReq.run_id, true)}
                      >
                        Allow
                      </button>
                      <button
                        className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)]"
                        onClick={() => chat.confirm(confirmReq.run_id, false)}
                      >
                        Deny
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* The column-wide aurora above IS the running indicator: its
                  palette shifts indigo → amber with the run phase. */}
              <PromptBox
                onSend={(text, selection, attachments) => sendMessage(text, activeConv, selection, attachments)}
                projects={projects}
                project={activeConv?.project ?? NO_PROJECT}
                onSelectProject={() => {}}
                gateways={gateways}
                pickedModel={pickedModel}
                onPickModel={pickModel}
                busy={streaming}
                onStop={() => activeConv && chat.stop(activeConv.id)}
                workspace={workspaceOf(activeConv?.project ?? NO_PROJECT)}
                onCommand={onPromptCommand}
                queued={activeConv ? chat.queues[activeConv.id] ?? [] : []}
                onTakeQueued={(id) => (activeConv ? chat.takeQueued(activeConv.id, id) : undefined)}
                onRunQueued={(id) => activeConv && void chat.runQueued(activeConv.id, activeConv.project, id)}
                contextMeter={
                  pickedModel && (
                    <ContextMeter
                      load={() =>
                        chat.contextFor(activeConv?.id ?? null, activeConv?.project ?? NO_PROJECT, {
                          ...pickedModel,
                          effort: (localStorage.getItem("effort") as Effort) || "medium",
                        })
                      }
                      refreshKey={`${activeConv?.id ?? ""}|${draftMsgs.length}|${pickedModel.gatewayId}|${pickedModel.modelId}|${maxAgents}`}
                      busy={streaming}
                    />
                  )
                }
              />
            </div>
          )}
        </div>

        {/* Right inspection panel — a full-height column next to the whole
            main area, so the chat's navbar above never stretches over it. */}
        <AnimatePresence>
          {panel.kind === "panel" && activeConv && view === "chat" && (
            <InspectionPanel
              panel={panel}
              msgs={draftMsgs}
              width={panelWidth}
              onResizeStart={startPanelResize}
              onSelect={selectPanelTab}
              onCloseTab={closePanelTab}
              onCloseAll={() => setPanel({ kind: "none" })}
            />
          )}
        </AnimatePresence>

        {/* SSH mode: create/edit/settings dock in a right-hand panel —
            Termius-style, no dialogs. */}
        <AnimatePresence>
          {mode === "ssh" && sshPanel && (
            <SshPanel
              target={sshPanel}
              servers={sshServers}
              keys={sshKeys}
              scripts={sshScripts}
              proxies={sshProxies}
              width={sshPanelWidth}
              resizing={sshPanelResizing}
              onResizeStart={startSshPanelResize}
              onChanged={reloadSshServers}
              onClose={() => setSshPanel(null)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {modal === "settings" && (
            <SettingsModal
              theme={theme}
              onTheme={setTheme}
              projects={projects}
              onAddProject={addProject}
              onRenameProject={renameProject}
              onProjectPermMode={async (name, mode) => {
                setProjects((prev) =>
                  prev.map((p) => (p.name === name ? { ...p, permMode: mode } : p))
                );
                await db.setProjectPermMode(name, mode);
              }}
              onProjectSetPath={setProjectPath}
              onDeleteProject={removeProject}
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
              genAnimation={genAnimation}
              onGenAnimation={(next) => {
                setGenAnimation(next);
                localStorage.setItem("gen_animation", next);
                void db.setSetting("gen_animation", next);
              }}
              debugMode={debugMode}
              onDebugMode={(next) => {
                setDebugMode(next);
                void db.setSetting("debug_mode", next ? "1" : "0");
              }}
              subagents={subagents}
              onSubagents={(next) => {
                setSubagents(next);
                void db.saveSubagents(next);
              }}
              maxRetries={maxRetries}
              onMaxRetries={(n) => {
                setMaxRetries(n);
                void db.setSetting("max_retries", String(n));
              }}
              maxAgents={maxAgents}
              onMaxAgents={(n) => {
                setMaxAgents(n);
                void db.setSetting("max_agents", String(n));
              }}
              initialProject={settingsProject}
              initialSection={settingsSection}
              mode={mode}
              workspace={workspaceOf(activeConv?.project ?? newChatProject)}
              onClose={() => {
                setModal("none");
                // The next plain "Settings" click must land on General again.
                setSettingsSection("general");
                setSettingsProject(null);
              }}
            />
          )}
          {modal === "schedule" && (
            <ScheduleModal
              task={editingTask}
              projects={projects}
              providers={providers}
              models={models}
              defaultModel={pickedModel}
              onSave={schedule.save}
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
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * Shown when a full-window SSH page points at a server that is no longer in
 * the list (deleted in another tab / after a reload). Offers the way back.
 */
function SshGone({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-10">
      <div className="max-w-sm rounded-xl border border-dashed border-[var(--border)] p-8 text-center">
        <div className="text-[14px] font-medium text-[var(--text-main)]">Server not found</div>
        <div className="mt-1 text-[12.5px] text-[var(--text-muted)]">
          This unit is no longer saved — it may have been deleted.
        </div>
        <button
          className="mt-4 h-8 rounded-md border border-[var(--border)] px-3 text-[12px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
          onClick={onBack}
        >
          Back to Units
        </button>
      </div>
    </div>
  );
}
