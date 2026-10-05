import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Shield, ShieldAlert, ChevronDown } from "lucide-react";
import * as db from "../core/db.r";
import type { Effort, Model, ScheduledTask, Project, Provider, Theme, ViewKind, Attachment } from "../core/types.i";
import { NO_PROJECT, THEMES } from "../core/types.i";
import { toGateways } from "../utils/gateways.u";
import { useBlockContextMenu } from "../hooks/useBlockContextMenu.h";
import { GenerationGlow, type GenAnimation } from "../components/effects/GenerationGlow.c";

import type { PanelState, PanelTabSpec } from "../chat/message.i";
import { storedToMsg, fileLabel, toolLabel } from "../chat/message.u";
import { ChatMessage } from "../chat/ChatMessage.c";
import { useChat, DRAFT_ID } from "../hooks/useChat.h";
import { useScheduledTasks } from "../hooks/useScheduledTasks.h";
import type { ChatSelection } from "../hooks/useChat.h";
import { PromptBox, type PromptCommand } from "../chat/PromptBox.c";
import { ContextMeter } from "../chat/ContextMeter.c";
import { CompactNote } from "../chat/CompactNote.c";
import { UnseenDivider } from "../chat/UnseenDivider.c";
import { useUnseenMarks } from "../hooks/useUnseenMarks.h";
import { InspectionPanel } from "../chat/InspectionPanel.c";
import { TitleBar } from "../layout/TitleBar.c";
import { Sidebar } from "../layout/Sidebar.c";
import { HistoryView } from "../views/HistoryView.p";
import { TasksView } from "../views/TasksView.p";
import { NewProjectModal } from "../settings/NewProjectModal.c";
import { ScheduleModal } from "../settings/ScheduleModal.c";
import { SettingsModal } from "../settings/SettingsModal.c";
import type { SettingsSection } from "../settings/SettingsModal.c";
import { ScrollArea, Button, cx } from "../components";

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
  const [pickedModel, setPickedModel] = useState<{ gatewayId: string; modelId: string; effort?: Effort } | null>(
    null
  );
  const chatRef = useRef<HTMLDivElement>(null);

  /** Helper agents (Settings → Agent); how many may work at once is per model. */
  const [subagents, setSubagents] = useState<db.Subagent[]>([]);
  /** Retries of a failed model request before a run gives up. */
  const [maxRetries, setMaxRetries] = useState(5);
  useEffect(() => {
    void db.loadSubagents().then(setSubagents);
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
    subagents,
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
        effort: (localStorage.getItem("effort") as Effort) || "low",
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
  /** Where each CLI session of this chat stopped reading (one per provider). */
  const unseen = useUnseenMarks(activeConv?.id, draftMsgs, streaming);
  /** The running agent's latest request size, tokens (the gauge's live reading). */
  const liveContext = (() => {
    if (!streaming) return undefined;
    const last = draftMsgs[draftMsgs.length - 1];
    const seg = last?.segments?.find((s) => s.kind === "usage");
    return seg?.kind === "usage" ? seg.usage.last_input || undefined : undefined;
  })();
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
  // never leave the panel wider than the space that remains — otherwise
  // the main column is squeezed off-screen. Runs on every window resize and
  // caps the panel to window − sidebar − 320px of usable main area.
  useEffect(() => {
    const onResize = () => {
      const maxW = Math.max(
        PANEL_MIN_W,
        Math.min(PANEL_MAX_W, window.innerWidth - sidebarWidth - 320)
      );
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

  /** Set once boot has restored the page, so the initial state isn't saved over it. */
  const bootedRef = useRef(false);

  // Remember the last page — the next launch reopens it.
  useEffect(() => {
    if (!bootedRef.current) return;
    localStorage.setItem("dsh:last-view:agent", view);
  }, [view]);

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
      const [globalAuto, picked, savedTheme, savedPanelW, savedDebug] =
        await Promise.all([
          db.getSetting("global_auto_run"),
          db.getSetting("picked_model"),
          db.getSetting("theme"),
          db.getSetting("panel_width"),
          db.getSetting("debug_mode"),
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

      // Reopen the page the app was closed on: the last chat (if it still
      // exists), History or Tasks — otherwise New Conversation.
      const agentView = localStorage.getItem("dsh:last-view:agent") ?? "chat";
      const showAgent = (v: ViewKind) => setView(v);

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
    // Boot opens the LAST OPENED chat — not some arbitrary "most recent" row
    // that may not even exist anymore ("при запуске открывается несуществующий чат").
    localStorage.setItem("dsh:last-conv", id);
    // Messages come from the database (a live run keeps its own buffer).
    await chat.load(id);
  };

  /** Providers grouped with their models — feeds the model picker. */
  const gateways = useMemo(() => toGateways(providers, models), [providers, models]);

  /** Remembers the model the user picked, so the next launch restores it —
   *  and, inside a chat, makes it that chat's model from now on. */
  const pickModel = useCallback(
    (next: { gatewayId: string; modelId: string }) => {
      setPickedModel(next);
      void db.setSetting("picked_model", JSON.stringify(next));
      if (activeConv) {
        const effort = (localStorage.getItem("effort") as Effort) || "low";
        void db.saveConvModel(activeConv.id, { ...next, effort });
      }
    },
    [activeConv],
  );

  /** Effort of a chat that never saved one (the prompt box's own default). */
  const DEFAULT_EFFORT: Effort = "low";

  /** The effort picked inside a chat is that chat's from now on — another
   *  chat keeps its own. */
  const pickEffort = useCallback(
    (next: { gatewayId: string; modelId: string; effort: Effort }) => {
      if (activeConv) void db.saveConvModel(activeConv.id, next);
    },
    [activeConv],
  );

  /** Opening a chat brings back the provider + model it runs on. */
  useEffect(() => {
    const id = activeConv?.id;
    if (!id) return;
    let alive = true;
    void db.loadConvModel(id).then((m) => {
      if (!alive) return;
      // A chat that never saved its effort gets the default one — never the
      // effort of whichever chat was open before.
      const effort = m?.effort ?? DEFAULT_EFFORT;
      // Only a model that still exists (and is enabled) — else keep the current pick.
      const ok = !!m && models.some((x) => x.provider_id === m.gatewayId && x.model_id === m.modelId && x.enabled !== false);
      if (ok) setPickedModel({ gatewayId: m.gatewayId, modelId: m.modelId, effort });
      else setPickedModel((p) => (p ? { gatewayId: p.gatewayId, modelId: p.modelId, effort } : p));
    });
    return () => {
      alive = false;
    };
    // Re-run only when another chat is opened (not on every models refresh).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConv?.id]);

  /** Opens the New Conversation screen, optionally inside a project. */
  const startNewChat = (project: string = NO_PROJECT) => {
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

  /** A background task from the prompt lip opens as a side-panel tab. */
  const openBgTask = useCallback(
    (t: db.BgTask) => openPanelTab({ id: `bg:${t.id}`, type: "bgtask", label: t.command, taskId: t.id }),
    [openPanelTab]
  );

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
        onNewConversation={() => startNewChat()}
        onNewProject={() => setModal("new-project")}
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
      <div className="flex min-h-0 flex-1 overflow-hidden bg-[var(--bg-sidebar)]">
        {!sidebarHidden && (
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

        <div
          className={cx(
            "flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-app)]",
            // The page sits in the corner between the sidebar and the title
            // bar like a sheet: rounded top-left, a hairline along both edges.
            !sidebarHidden && "rounded-tl-2xl border-l border-t border-[var(--border-soft)]",
          )}
        >
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
                  onPickEffort={pickEffort}
                  workspace={workspaceOf(newChatProject)}
                  onCommand={onPromptCommand}
                  onOpenBgTask={openBgTask}
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
                          {unseen.has(i) && (
                            <div className="mb-4">
                              <UnseenDivider marks={unseen.get(i)!} />
                            </div>
                          )}
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
                            error={m.error}
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
                        "mx-auto flex w-full max-w-[760px] items-center gap-3 rounded-2xl border bg-[var(--bg-surface)] px-3.5 py-2.5 shadow-[var(--shadow-popup)] " +
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
                      <Button
                        variant="primary" size="sm"
                        onClick={() => chat.confirm(confirmReq.run_id, true)}
                      >
                        Allow
                      </Button>
                      <Button
                        variant="secondary" size="sm"
                        onClick={() => chat.confirm(confirmReq.run_id, false)}
                      >
                        Deny
                      </Button>
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
                  onPickEffort={pickEffort}
                busy={streaming}
                onStop={() => activeConv && chat.stop(activeConv.id)}
                workspace={workspaceOf(activeConv?.project ?? NO_PROJECT)}
                onCommand={onPromptCommand}
                onOpenBgTask={openBgTask}
                queued={activeConv ? chat.queues[activeConv.id] ?? [] : []}
                onTakeQueued={(id) => (activeConv ? chat.takeQueued(activeConv.id, id) : undefined)}
                onRunQueued={(id) => activeConv && void chat.runQueued(activeConv.id, activeConv.project, id)}
                contextMeter={
                  pickedModel && (
                    <ContextMeter
                      load={() =>
                        chat.contextFor(activeConv?.id ?? null, activeConv?.project ?? NO_PROJECT, {
                          ...pickedModel,
                          effort: (localStorage.getItem("effort") as Effort) || "low",
                        })
                      }
                      refreshKey={`${activeConv?.id ?? ""}|${draftMsgs.length}|${pickedModel.gatewayId}|${pickedModel.modelId}`}
                      busy={streaming}
                      live={liveContext}
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
              initialProject={settingsProject}
              initialSection={settingsSection}
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
