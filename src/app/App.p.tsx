import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Shield, ChevronDown } from "lucide-react";
import * as db from "../core/db.r";
import type { Conversation, Model, Project, Provider, Theme, ViewKind, Attachment, Effort } from "../core/types.i";
import { NO_PROJECT, THEMES } from "../core/types.i";
import { composePrompt } from "../utils/attachments.u";
import { toGateways } from "../utils/gateways.u";
import { useBlockContextMenu } from "../hooks/useBlockContextMenu.h";
import { ScrollArea } from "../ui/ScrollArea.c";
import { GeneratingPill } from "../ui/GeneratingPill.c";
import type { Msg, PanelState, PanelTabSpec } from "../chat/message.i";
import { storedToMsg, fileLabel, toolLabel } from "../chat/message.u";
import { ChatMessage } from "../chat/ChatMessage.c";
import { PromptBox } from "../chat/PromptBox.c";
import { InspectionPanel } from "../chat/InspectionPanel.c";
import { TitleBar } from "../layout/TitleBar.c";
import { Sidebar } from "../layout/Sidebar.c";
import { HistoryView } from "../views/HistoryView.p";
import { TasksView } from "../views/TasksView.p";
import { NewProjectModal } from "../settings/NewProjectModal.c";
import { ScheduleModal } from "../settings/ScheduleModal.c";
import { SettingsModal } from "../settings/SettingsModal.c";
import type { SettingsSection } from "../settings/SettingsModal.c";

export /** Loose chats (no folder). Kept as a real entry so every row action just works. */
const NO_PROJECT_ENTRY: Project = {
  name: NO_PROJECT,
  path: "",
  conversations: [],
};

export const INITIAL_SCHEDULED = ["Nightly /review @main", "Weekly /test all"];

/* ---------- Custom title bar ---------- */

export /** Buffer key for the "new chat" view before a conversation exists. */
const DRAFT_ID = "__new__";

export /** Inspection panel width bounds, px. */
const PANEL_MIN_W = 260;

export const PANEL_MAX_W = 720;

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
  /** Panel width, drag-resizable and persisted like the sidebar's. */
  const [panelWidth, setPanelWidth] = useState(340);
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
  const [modal, setModal] = useState<"none" | "settings" | "schedule" | "new-project">("none");
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
      const [globalAuto, picked, savedTheme, savedPanelW] = await Promise.all([
        db.getSetting("global_auto_run"),
        db.getSetting("picked_model"),
        db.getSetting("theme"),
        db.getSetting("panel_width"),
      ]);
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
    /** Set when this send created a brand-new chat — the AI title replaces it. */
    let freshTitle = false;

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
      freshTitle = true;
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
      // A brand-new chat gets a real title: the model names it after the first
      // prompt. Fire-and-forget — on any failure the truncated prompt stays.
      if (freshTitle) {
        void generateTitle(convId, projectName, provider, cred, modelRow.model_id, promptText);
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

  /**
   * Names a brand-new chat from its first prompt using the same provider that
   * just answered. Deliberately minimal: tiny context, no tools, and the
   * result only replaces the placeholder when it looks like a real title.
   * Any failure keeps the truncated-prompt title — never worth an error UI.
   */
  const generateTitle = async (
    convId: string,
    projectName: string,
    provider: Provider,
    cred: { apiKey: string; auth: "key" | "bearer" },
    modelId: string,
    firstPrompt: string
  ) => {
    try {
      let out = "";
      await db.streamChat(
        `title-${convId}`,
        {
          kind: provider.kind,
          base_url: provider.base_url,
          api_key: cred.apiKey,
          auth: cred.auth,
          model: modelId,
          effort: "low",
          system:
            "You name conversations. Reply with a short title of at most 6 words " +
            "for the user's first message. No quotes, no trailing punctuation, " +
            "same language as the message.",
        },
        [{ role: "user", text: firstPrompt.slice(0, 600) }],
        (d) => {
          out += d;
        }
      );
      // Keep only the first line and trim it to a sane title length.
      const clean = out
        .split("\n")[0]
        .replace(/^["'«»\s]+|["'«»\s]+$/g, "")
        .slice(0, 60)
        .trim();
      if (clean.length >= 2) {
        setProjects((prev) =>
          prev.map((p) =>
            p.name !== projectName
              ? p
              : {
                  ...p,
                  conversations: p.conversations.map((c) =>
                    c.id === convId ? { ...c, title: clean } : c
                  ),
                }
          )
        );
        await db.updateConversationTitle(convId, clean);
      }
    } catch {
      /* a failed rename is not worth surfacing — the placeholder stays */
    }
  };

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
          onOpenProjectSettings={openProjectSettings}
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
            <div className="flex min-h-0 flex-1 flex-col">
              {/* Wrapper hosts the floating "jump to latest" button over the list. */}
              <div className="relative flex min-h-0 flex-1 flex-col">
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
                                  id: `cmd:${step.index}`,
                                  type: "command",
                                  label: step.input,
                                  stepIndex: step.index,
                                });
                              } else {
                                openPanelTab({
                                  id: `tool:${step.index}`,
                                  type: "tool",
                                  label: toolLabel(step),
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
                    className="absolute bottom-3 left-1/2 z-20 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-surface)] px-3 text-[12px] text-[var(--text-muted)] shadow-[var(--shadow-popup)] transition-colors hover:text-[var(--text-main)]"
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
                    className="flex justify-center px-6 pb-1.5"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                  >
                    <GeneratingPill />
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
              initialProject={settingsProject}
              initialSection={settingsSection}
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
        </AnimatePresence>
      </div>
    </div>
  );
}
