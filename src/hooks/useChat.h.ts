/**
 * useChat — owns the chat surface's state and lifecycle, in the spirit of the
 * AI SDK hook of the same name, over the Tauri/Rig backend:
 *
 *  - messages per conversation (background runs keep streaming into theirs);
 *  - send(): persists the prompt, starts the Rig agent (or a plain chat
 *    stream when agent mode is off) and streams text, reasoning and every
 *    tool call into the live turn as they happen;
 *  - stop(): cancels a run; the partial answer is kept and saved;
 *  - confirm(): answers a command's Allow/Deny request;
 *  - editAndResend(): rewinds the chat to an earlier prompt and runs it again;
 *  - reload re-attach: a run that survived a WebView reload is replayed from
 *    the Rust buffer and followed to its end.
 */
import { loadDisabledTools } from "../core/plugins.u";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Dispatch, SetStateAction } from "react";
import * as db from "../core/db.r";
import type { Attachment, Conversation, Effort, Model, Project, Provider, SshServer } from "../core/types.i";
import { isCliKind } from "../core/types.i";
import { composePrompt } from "../utils/attachments.u";
import type { Msg, Segment } from "../chat/message.i";
import { storedToMsg } from "../chat/message.u";
import { diffStat } from "../utils/diff.u";

/** Opens a compacted history: the summary rides in front of the first
 *  message after it (also recognised by the Rust history trimmer). */
export const COMPACT_MARKER = "[Summary of the earlier conversation — older messages were compacted]";

/**
 * The history as the model receives it. After a /compact, the latest
 * summary replaces everything before it: it is prefixed to the first user
 * message that follows (roles keep alternating for every provider).
 */
export function modelTurns(history: Msg[]): db.ChatTurn[] {
  const at = history.map((m) => m.role).lastIndexOf("compact");
  const plain = (list: Msg[]): db.ChatTurn[] =>
    list.filter((m) => m.role !== "compact").map((m) => ({ role: m.role, text: m.text, ...workOf(m) }));
  if (at < 0) return plain(history);
  const summary = `${COMPACT_MARKER}\n${history[at].text.trim()}`;
  const rest = plain(history.slice(at + 1));
  const first = rest.findIndex((t) => t.role === "user");
  if (first < 0) return [{ role: "user", text: summary }];
  const out = rest.slice(first);
  out[0] = { role: "user", text: `${summary}\n\n---\n\n${out[0].text}` };
  return out;
}

/** Outputs of these tools are worth carrying into the next message. */
const DETAIL_TOOLS = ["read_file", "grep", "find_files", "list_dir", "run_command", "git"];
/** One output in the detail, chars (its tail holds errors and summaries). */
const DETAIL_ONE = 6_000;

/**
 * What an agent turn DID, for the next message: a line per tool call
 * (Claude Code keeps every tool result in its history; the saved chat kept
 * only the prose, so the next message re-read every file), plus the
 * outputs of its reads / searches / commands. A file the turn changed later
 * is not carried as it was read — its line says how it changed instead.
 */
function workOf(m: Msg): Pick<db.ChatTurn, "work_log" | "work_detail"> {
  if (m.role !== "agent") return {};
  const steps = (m.segments ?? []).flatMap((s) => (s.kind === "step" && s.step.done ? [s.step] : []));
  if (steps.length === 0) return {};
  const firstLine = (t: string) => (t.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 160);
  const changed = new Set(steps.filter((s) => s.path && s.new_text !== undefined).map((s) => s.path!.replace(/\\/g, "/").toLowerCase()));
  const log: string[] = [];
  const detail: string[] = [];
  for (const s of steps) {
    let outcome = firstLine(s.result ?? "");
    if (s.path && s.new_text !== undefined) {
      const { added, removed } = diffStat(s.old_text ?? "", s.new_text);
      outcome = `${s.old_text == null ? "created" : "changed"} (+${added} −${removed})`;
    }
    log.push(`- ${s.name} ${s.input.slice(0, 200)} → ${s.ok ? "" : "FAILED: "}${outcome}`);
    if (!s.ok || !DETAIL_TOOLS.includes(s.name) || !s.result) continue;
    const file = s.input.replace(/^\[[^\]]+\] /, "").split(/ [(…]/)[0].trim().replace(/\\/g, "/").toLowerCase();
    if (s.name === "read_file" && [...changed].some((c) => c.endsWith(file) || file.endsWith(c))) continue;
    const body = s.result.length > DETAIL_ONE ? `[…]\n${s.result.slice(-DETAIL_ONE)}` : s.result;
    detail.push(`### ${s.name} ${s.input.slice(0, 200)}\n${body}`);
  }
  return { work_log: log.join("\n"), work_detail: detail.join("\n\n") };
}

/** Everything the context gauge shows for one conversation. */
export interface ContextReport {
  parts: db.ContextPart[];
  info: db.ModelInfo;
  modelName: string;
  providerKind: string;
  /** Token totals of every run of this conversation (usage segments). */
  spent: { prompt: number; completion: number; cached: number; runs: number };
  /** Real / estimated tokens of the last run's first request (the parts
   *  are already scaled by it); null = nothing to calibrate against yet. */
  calibration: number | null;
  /** The real size of the last run's final request (tool results and
   *  in-run compaction included) — the estimate only sees the saved turns. */
  lastRequest: number | null;
}

/** Model ids that draw pictures (gpt-image-1, dall-e-3, imagen-4, gemini-2.5-flash-image, flux…). */
const IMAGE_MODEL =
  /(gpt-image|dall-e|imagen|flux|stable-diffusion|sdxl|\bsd3|image-gen|nano-banana|z-image|recraft|ideogram|[-_/]image(-preview|-generation)?$)/i;
/** Provider kinds that can draw without a separate image model in the list. */
const DRAWING_APIS = ["openai-responses", "openai-completions", "google", "google-cli"];
/** Kinds that draw for OTHER providers' chats too (Claude, Codex…): tested paths only. */
const SHARED_DRAWERS = ["google-cli", "google"];

const COMPACT_SYSTEM =
  "You compress a conversation between a user and a coding agent into a summary the agent will continue from. " +
  "The summary REPLACES the conversation, so anything left out is forgotten.";

const COMPACT_REQUEST =
  "Summarize the conversation below so the work can continue seamlessly. Use these sections:\n" +
  "1. Requests and intent — everything the user asked for, in their own terms, including corrections.\n" +
  "2. Key technical context — stack, conventions, constraints, decisions made and why.\n" +
  "3. Files and code — exact paths touched or important, what changed in each, key snippets only when essential.\n" +
  "4. Errors and fixes — what went wrong and how it was solved.\n" +
  "5. Pending — tasks not done yet.\n" +
  "6. Current state and next step.\n" +
  "Be complete but dense: keep exact names, paths, commands and numbers; drop chit-chat and dead ends. " +
  "Write in the language the user writes in. Output only the summary.";

/** Buffer key for the "new chat" view before a conversation exists. */
export const DRAFT_ID = "__new__";

/** Model settings picked in the prompt box for one send. */
export interface ChatSelection {
  gatewayId: string;
  modelId: string;
  effort: Effort;
}

export type RunPhase = "thinking" | "streaming";

/** A prompt written while the chat's agent was still working. */
export interface QueuedPrompt {
  id: string;
  text: string;
  attachments: Attachment[];
  selection: ChatSelection;
  /** Project of the conversation — the auto-run needs it to send. */
  project: string;
}

export interface UseChatOptions {
  providers: Provider[];
  models: Model[];
  projects: Project[];
  workspace: string;
  /** The app's own agent folder — runs of projects without a directory use it. */
  appWorkspace: string;
  agentMode: boolean;
  globalAutoRun: boolean;
  sshServers: SshServer[];
  subagents: db.Subagent[];
  /** Retries of a failed model request (Settings → Agent). */
  maxRetries: number;
  /** Model picked in the prompt box (edit-and-resend before any send). */
  pickedModel: { gatewayId: string; modelId: string } | null;
  /** Project a brand-new chat is created in. */
  newChatProject: string;
  /** A send created a conversation — add it to the tree; open it unless it runs in the background. */
  onConversationCreated: (project: string, conv: Conversation, open: boolean) => void;
  /** A message landed — refresh the sidebar's activity stamp. */
  onActivity: (convId: string) => void;
  /** The AI named a new chat. */
  onTitle: (project: string, convId: string, title: string) => void;
}

export function useChat(options: UseChatOptions) {
  /** Latest options for async callbacks (they outlive the render). */
  const opts = useRef(options);
  opts.current = options;

  const [convMsgs, setConvMsgs] = useState<Record<string, Msg[]>>({});
  const convMsgsRef = useRef(convMsgs);
  convMsgsRef.current = convMsgs;
  /** convId → run id of the generation streaming into it. */
  const [activeRuns, setActiveRuns] = useState<Record<string, string>>({});
  const activeRunsRef = useRef(activeRuns);
  activeRunsRef.current = activeRuns;
  /** convId → "thinking" until the first text delta, then "streaming". */
  const [runPhase, setRunPhase] = useState<Record<string, RunPhase>>({});
  /** Conversation whose last run failed (the aurora glows red). */
  const [erroredConv, setErroredConv] = useState<string | null>(null);
  /** Commands waiting for Allow/Deny, keyed by run id. */
  const [confirmReqs, setConfirmReqs] = useState<Record<string, db.ConfirmRequest>>({});
  /** Settings of the latest send — "edit and resend" reuses them. */
  const lastSelection = useRef<ChatSelection | null>(null);
  /** Re-attach claims (StrictMode double-mounts effects in dev). */
  const claimedRuns = useRef(new Set<string>());
  /** Conversations with a send in flight — set synchronously, so a second
   *  prompt typed right away is queued instead of racing the first. */
  const busy = useRef(new Set<string>());
  /** Follow-up prompts per conversation, run one by one after the current run. */
  const [queues, setQueues] = useState<Record<string, QueuedPrompt[]>>({});
  const queuesRef = useRef(queues);
  queuesRef.current = queues;
  /** Conversations the user stopped — their queue waits instead of running on. */
  const paused = useRef(new Set<string>());

  /** Writes to one conversation's buffer; safe for background runs. */
  const updateConvMsgs = useCallback((key: string, updater: (prev: Msg[]) => Msg[]) => {
    setConvMsgs((prev) => ({ ...prev, [key]: updater(prev[key] ?? []) }));
  }, []);

  const dropKey = <T,>(setter: Dispatch<SetStateAction<Record<string, T>>>, key: string) =>
    setter((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  /* ---------- Live-turn mutators ---------- */

  /** Applies one run event to the conversation's live (last) agent turn. */
  const applyNow = useCallback(
    (
      convId: string,
      ev:
        | { kind: "text"; delta: string }
        | { kind: "think"; delta: string }
        | { kind: "step"; step: db.AgentStepEvent }
        | { kind: "usage"; usage: db.RunUsage; accumulate: boolean }
        | { kind: "retry"; retry: db.RunRetry }
    ) => {
      updateConvMsgs(convId, (prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (!last || last.role !== "agent") return prev;
        let segs: Segment[] = [...(last.segments ?? [])];
        // One retry notice per turn: a new attempt moves its counter; once
        // the run produces anything again it has recovered and the notice goes.
        const retryAt = segs.findIndex((s) => s.kind === "retry");
        if (ev.kind === "retry") {
          if (retryAt >= 0) segs[retryAt] = { kind: "retry", ...ev.retry };
          else segs.push({ kind: "retry", ...ev.retry });
          next[next.length - 1] = { ...last, segments: segs };
          return next;
        }
        if (retryAt >= 0 && ev.kind !== "usage") segs = segs.filter((s) => s.kind !== "retry");
        const tail = segs[segs.length - 1];
        if (ev.kind === "text") {
          // Prose appends to the open text segment; a step closes it.
          if (tail && tail.kind === "text") segs[segs.length - 1] = { kind: "text", text: tail.text + ev.delta };
          else segs.push({ kind: "text", text: ev.delta });
          next[next.length - 1] = { ...last, text: last.text + ev.delta, segments: segs };
          return next;
        }
        if (ev.kind === "think") {
          // Reasoning has its own block; `text` stays reasoning-free.
          if (tail && tail.kind === "think") segs[segs.length - 1] = { kind: "think", text: tail.text + ev.delta };
          else segs.push({ kind: "think", text: ev.delta });
        } else if (ev.kind === "step") {
          // done=false shows the card running; done=true replaces it.
          const at = segs.findIndex((s) => s.kind === "step" && s.step.index === ev.step.index);
          if (at >= 0) segs[at] = { kind: "step", step: ev.step };
          else segs.push({ kind: "step", step: ev.step });
        } else {
          // The agent re-sends cumulative totals (replace); plain chat reports
          // prompt and completion separately (accumulate).
          const at = segs.findIndex((s) => s.kind === "usage");
          const prevU = at >= 0 ? (segs[at] as { kind: "usage"; usage: db.RunUsage }).usage : null;
          const u = ev.usage;
          const merged: db.RunUsage =
            ev.accumulate && prevU
              ? {
                  run_id: u.run_id,
                  prompt_tokens: prevU.prompt_tokens + u.prompt_tokens,
                  completion_tokens: prevU.completion_tokens + u.completion_tokens,
                  cached_tokens: prevU.cached_tokens + u.cached_tokens,
                  elapsed_ms: u.elapsed_ms ?? prevU.elapsed_ms,
                }
              : { ...u, elapsed_ms: u.elapsed_ms ?? prevU?.elapsed_ms };
          if (at >= 0) segs[at] = { kind: "usage", usage: merged };
          else segs.push({ kind: "usage", usage: merged });
        }
        next[next.length - 1] = { ...last, segments: segs };
        return next;
      });
    },
    [updateConvMsgs]
  );

  /* ---------- Delta batching ----------
     Providers stream a delta per token; applying each one re-rendered the
     whole app (and re-parsed the Markdown) up to hundreds of times a second
     per running agent — several agents at once starved the UI. Text and
     reasoning deltas are now merged and applied at most every FLUSH_MS; any
     other event (a tool card, usage) flushes first, so the order stays. */
  const FLUSH_MS = 50;
  const pending = useRef<Record<string, Array<{ kind: "text" | "think"; delta: string }>>>({});
  const flushTimer = useRef<number | null>(null);

  const applyPending = useCallback(
    (convId: string) => {
      const list = pending.current[convId];
      if (!list || list.length === 0) return;
      delete pending.current[convId];
      for (const ev of list) applyNow(convId, ev);
    },
    [applyNow]
  );

  const applyEvent = useCallback(
    (convId: string, ev: Parameters<typeof applyNow>[1]) => {
      if (ev.kind === "text" || ev.kind === "think") {
        const list = (pending.current[convId] ??= []);
        const last = list[list.length - 1];
        if (last && last.kind === ev.kind) last.delta += ev.delta;
        else list.push({ kind: ev.kind, delta: ev.delta });
        if (flushTimer.current === null) {
          flushTimer.current = window.setTimeout(() => {
            flushTimer.current = null;
            for (const id of Object.keys(pending.current)) applyPending(id);
          }, FLUSH_MS);
        }
        return;
      }
      applyPending(convId);
      applyNow(convId, ev);
    },
    [applyNow, applyPending]
  );

  /** Applies buffered deltas and renders NOW — before a finished turn is
   *  read back from state to be saved. */
  const flushNow = useCallback(
    (convId: string) => {
      if (pending.current[convId]?.length) flushSync(() => applyPending(convId));
    },
    [applyPending]
  );

  /* ---------- Running a turn ---------- */

  /** Names a brand-new chat from its first prompt. Failures keep the placeholder. */
  const generateTitle = async (
    convId: string,
    projectName: string,
    provider: Provider,
    cred: { apiKey: string; auth: "key" | "bearer" },
    modelId: string,
    firstPrompt: string
  ) => {
    // A subscription CLI would start a second session (and spend the plan)
    // just to name the chat: the title comes from the prompt itself.
    if (isCliKind(provider.kind)) {
      const words = firstPrompt.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
      const clean = words.replace(/^["'«»\s]+|["'«».,!?:;\s]+$/g, "").slice(0, 60).trim();
      if (clean.length >= 2) {
        opts.current.onTitle(projectName, convId, clean);
        await db.updateConversationTitle(convId, clean).catch(() => {});
      }
      return;
    }
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
          provider_id: provider.id,
          rate_limit_rpm: provider.rate_limit_rpm ?? 0,
          concurrency: provider.concurrency ?? 0,
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
      const clean = out
        .split("\n")[0]
        .replace(/^["'«»\s]+|["'«»\s]+$/g, "")
        .slice(0, 60)
        .trim();
      if (clean.length >= 2) {
        opts.current.onTitle(projectName, convId, clean);
        await db.updateConversationTitle(convId, clean);
      }
    } catch {
      /* a failed rename is not worth surfacing */
    }
  };

  /**
   * Streams one agent turn for `history` (whose last entry is the user
   * prompt, already persisted) into the conversation's buffer, then saves it.
   */
  /** The agent request of one run (also measured by the context gauge). */
  const agentRequest = (
    provider: Provider,
    cred: { apiKey: string; auth: "key" | "bearer" },
    model: string,
    selection: ChatSelection,
    projectName: string,
    workspace: string,
    images: db.ImageAttachment[] = [],
    /** Agents this model may use (per model; CLIs always 1). */
    agents = 1,
    /** The conversation — a subscription CLI keeps one session per chat. */
    chatId = "",
  ): db.AgentRequest => {
    const o = opts.current;
    const project = o.projects.find((p) => p.name === projectName);
    const permMode = project?.permMode ?? "default";
    const autoRun = permMode === "bypass" ? true : permMode === "ask" ? false : o.globalAutoRun;
    return {
      kind: provider.kind,
      base_url: provider.base_url,
      api_key: cred.apiKey,
      auth: cred.auth,
      model,
      system: "",
      workspace,
      effort: selection.effort,
      auto_run: autoRun,
      images,
      provider_id: provider.id,
      rate_limit_rpm: provider.rate_limit_rpm ?? 0,
      concurrency: provider.concurrency ?? 0,
      subagents: o.subagents.filter((s) => s.enabled && s.name.trim()),
      max_agents: agents,
      chat_id: chatId,
      max_retries: o.maxRetries,
      ssh_units: o.sshServers.map((s) => ({ id: s.id, name: s.name, host: s.host })),
      disabled_tools: loadDisabledTools(),
    };
  };

  /**
   * Where this run's pictures come from: an image model of the chat's own
   * provider, else the provider itself when its API can draw (OpenAI's
   * image tool / Images API, Gemini image models), else any other provider
   * with an image model. None = the model is told it cannot draw.
   */
  const imageGenFor = async (
    provider: Provider,
    cred: { apiKey: string; auth: "key" | "bearer" },
    chatModel: string,
  ): Promise<db.ImageGenConfig | undefined> => {
    const o = opts.current;
    const imageModel = (providerId: string) =>
      o.models.find((m) => m.provider_id === providerId && m.enabled !== false && IMAGE_MODEL.test(m.model_id));
    const config = (p: Provider, c: { apiKey: string; auth: "key" | "bearer" }, model: string): db.ImageGenConfig => ({
      kind: p.kind,
      base_url: p.base_url,
      api_key: c.apiKey,
      auth: c.auth,
      model,
      chat_model: chatModel,
    });
    const own = imageModel(provider.id);
    if (own) return config(provider, cred, own.model_id);
    if (DRAWING_APIS.includes(provider.kind)) return config(provider, cred, "");
    // Another provider draws: one with an image model first, then a Google
    // one (Antigravity / Gemini API draw with no image model listed).
    const others = o.providers.filter((p) => p.id !== provider.id && p.enabled);
    const candidates = [
      ...others.flatMap((p) => {
        const m = imageModel(p.id);
        return m ? [{ p, model: m.model_id }] : [];
      }),
      ...others.filter((p) => SHARED_DRAWERS.includes(p.kind)).map((p) => ({ p, model: "" })),
    ];
    for (const { p, model } of candidates) {
      const c = await db.credentialFor(p, {
        clientId: localStorage.getItem("google_client_id") ?? "",
        clientSecret: localStorage.getItem("google_client_secret") ?? "",
      });
      if (!c.error) return config(p, c, model);
    }
    return undefined;
  };

  /** Provider, model row and credentials of a selection — or why not. */
  const resolveModel = async (selection: ChatSelection) => {
    const o = opts.current;
    const provider = o.providers.find((p) => p.id === selection.gatewayId);
    const modelRow = o.models.find((m) => m.provider_id === selection.gatewayId && m.model_id === selection.modelId);
    if (!provider || !modelRow) return { error: "No model selected — add a provider in Settings → Models." } as const;
    const cred = await db.credentialFor(provider, {
      clientId: localStorage.getItem("google_client_id") ?? "",
      clientSecret: localStorage.getItem("google_client_secret") ?? "",
    });
    if (cred.error) return { error: `${provider.name}: ${cred.error}` } as const;
    return { provider, modelRow, cred } as const;
  };

  const workspaceOf = (projectName: string) => {
    const o = opts.current;
    const p = o.projects.find((x) => x.name === projectName);
    return p?.path?.trim() || o.appWorkspace || o.workspace;
  };

  /** The context gauge's data: next request's parts, model window/prices, spend so far. */
  const contextFor = async (convId: string | null, projectName: string, selection: ChatSelection): Promise<ContextReport | null> => {
    const r = await resolveModel(selection);
    if ("error" in r || !r.provider) return null;
    const { provider, modelRow, cred } = r;
    const history = convId ? convMsgsRef.current[convId] ?? [] : [];
    const request = {
      ...agentRequest(
        provider, cred, modelRow.model_id, selection, projectName, workspaceOf(projectName), [],
        await db.loadModelAgents(modelRow.id, provider.kind, provider.id), convId ?? "",
      ),
      image_gen: await imageGenFor(provider, cred, modelRow.model_id),
    };
    const [parts, info] = await Promise.all([
      db.agentContext(request, modelTurns(history)).catch(() => [] as db.ContextPart[]),
      db.effectiveModelInfo(provider.kind, provider.base_url, modelRow.model_id, modelRow.id),
    ]);
    const spent = { prompt: 0, completion: 0, cached: 0, runs: 0 };
    let calibration: number | null = null;
    let lastRequest: number | null = null;
    for (const m of history) {
      for (const seg of m.segments ?? []) {
        if (seg.kind !== "usage") continue;
        if (seg.usage.last_input) lastRequest = seg.usage.last_input;
        spent.prompt += seg.usage.prompt_tokens;
        spent.completion += seg.usage.completion_tokens;
        spent.cached += seg.usage.cached_tokens;
        spent.runs += 1;
        // The provider's own count of a request we also estimated: the
        // ratio corrects the chars→tokens guess for this model's tokenizer
        // (and hidden overhead like tool-use framing). The latest run wins.
        const { first_input: real, first_est: est } = seg.usage;
        // (Not for a CLI: its own hidden prompt is in `real`, the gauge
        // uses the session's measured size instead.)
        if (real && est && est > 200 && !isCliKind(provider.kind)) calibration = Math.min(3, Math.max(0.4, real / est));
      }
    }
    const scaled = calibration === null
      ? parts
      : parts.map((p) => ({
          ...p,
          tokens: Math.round(p.tokens * calibration!),
          items: p.items.map((it) => ({ ...it, tokens: Math.round(it.tokens * calibration!) })),
        }));
    return { parts: scaled, info, spent, calibration, lastRequest, modelName: modelRow.name || modelRow.model_id, providerKind: provider.kind };
  };

  /**
   * /compact: the model summarizes the conversation; the summary is saved
   * as a "compact" message and from then on sent INSTEAD of everything
   * before it. `focus` = what the summary should keep in detail.
   */
  const compact = async (convId: string, focus = ""): Promise<string | null> => {
    if (busy.current.has(convId) || activeRunsRef.current[convId]) return "The agent is still working — compact after it finishes.";
    const selection = lastSelection.current ?? fallbackSelection();
    if (!selection) return "No model selected.";
    const r = await resolveModel(selection);
    if ("error" in r) return r.error ?? "No model selected.";
    const { provider, modelRow, cred } = r;
    // One CLI session per chat: a summary run would be a second session,
    // and the chat's own session compacts its context by itself.
    if (isCliKind(provider.kind)) {
      return `${provider.name} keeps one session per chat and compacts its context on its own — /compact is not needed.`;
    }
    const turns = modelTurns(convMsgsRef.current[convId] ?? []);
    if (turns.length === 0) return "Nothing to compact yet.";
    // One transcript in one user message: every provider accepts it, and
    // very long old answers are clipped (their tail holds the outcome).
    const clip = (t: string, n: number) => (t.length > n ? `[…] ${t.slice(t.length - n)}` : t);
    const transcript = turns
      .map((t) => (t.role === "user" ? `USER:\n${clip(t.text, 12_000)}` : `AGENT:\n${clip(t.text, 6_000)}`))
      .join("\n\n");
    const ask = `${COMPACT_REQUEST}${focus.trim() ? `\nKeep especially detailed: ${focus.trim()}` : ""}\n\n<conversation>\n${transcript}\n</conversation>`;

    busy.current.add(convId);
    const runId = `compact-${Date.now()}`;
    updateConvMsgs(convId, (prev) => [...prev, { role: "compact", text: "" }]);
    setActiveRuns((prev) => ({ ...prev, [convId]: runId }));
    setRunPhase((prev) => ({ ...prev, [convId]: "thinking" }));
    const startedAt = Date.now();
    let text = "";
    try {
      text = await db.streamChat(
        runId,
        {
          kind: provider.kind,
          base_url: provider.base_url,
          api_key: cred.apiKey,
          auth: cred.auth,
          model: modelRow.model_id,
          effort: "low",
          images: [],
          provider_id: provider.id,
          rate_limit_rpm: provider.rate_limit_rpm ?? 0,
          concurrency: provider.concurrency ?? 0,
          system: COMPACT_SYSTEM,
        },
        [{ role: "user", text: ask }],
        (delta) => {
          setRunPhase((prev) => ({ ...prev, [convId]: "streaming" }));
          updateConvMsgs(convId, (prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "compact") next[next.length - 1] = { ...last, text: last.text + delta };
            return next;
          });
        }
      );
      if (!text.trim()) throw new Error("the model returned an empty summary");
      const durationMs = Date.now() - startedAt;
      updateConvMsgs(convId, (prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "compact") next[next.length - 1] = { ...last, text, durationMs };
        return next;
      });
      await db.appendMessage(convId, "compact", text, { durationMs });
      opts.current.onActivity(convId);
      return null;
    } catch (e) {
      // Nothing is saved: the full history stays in effect.
      updateConvMsgs(convId, (prev) => (prev.at(-1)?.role === "compact" ? prev.slice(0, -1) : prev));
      return `Compact failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      busy.current.delete(convId);
      dropKey(setActiveRuns, convId);
      dropKey(setRunPhase, convId);
    }
  };

  const runTurn = async (
    convId: string,
    projectName: string,
    history: Msg[],
    promptText: string,
    images: db.ImageAttachment[],
    selection: ChatSelection,
    freshTitle: boolean,
    background = false
  ) => {
    // The chat keeps the provider + model it runs on (reopening it restores them).
    if (!background) void db.saveConvModel(convId, selection).catch(() => {});
    const o = opts.current;
    const provider = o.providers.find((p) => p.id === selection.gatewayId);
    const modelRow = o.models.find(
      (m) => m.provider_id === selection.gatewayId && m.model_id === selection.modelId
    );
    if (!provider || !modelRow) {
      updateConvMsgs(convId, (prev) => [
        ...prev,
        { role: "agent", text: "No model selected — add a provider in Settings → Models." },
      ]);
      return;
    }
    const oauth = {
      clientId: localStorage.getItem("google_client_id") ?? "",
      clientSecret: localStorage.getItem("google_client_secret") ?? "",
    };
    const cred = await db.credentialFor(provider, oauth);
    if (cred.error) {
      updateConvMsgs(convId, (prev) => [...prev, { role: "agent", text: `${provider.name}: ${cred.error}` }]);
      return;
    }
    // Each run works in ITS project's folder — not whichever folder the open
    // chat happens to use (a new chat's first prompt, a scheduled task).
    const runProject = o.projects.find((p) => p.name === projectName);
    const runWorkspace = runProject?.path?.trim() || o.appWorkspace || o.workspace;
    if (o.agentMode && !runWorkspace.trim()) {
      updateConvMsgs(convId, (prev) => [
        ...prev,
        {
          role: "agent",
          text: "**Workspace not ready.**\n\nThe tools folder could not be resolved — restart the app and try again.",
        },
      ]);
      return;
    }

    // API models: what the user set for this model (tools, images, reasoning,
    // answer length). Every other provider is automatic.
    const caps = db.isApiKind(provider.kind) ? await db.loadModelCaps(modelRow.id) : null;
    const useAgent = o.agentMode && caps?.tools !== false;
    const runImages = caps && !caps.vision ? [] : images;
    // "none" = send no reasoning setting at all.
    const runEffort: Effort | "none" = caps && !caps.reasoning ? "none" : selection.effort;
    const maxTokens = caps?.maxOutput ?? undefined;

    const runId = `req-${Date.now()}`;
    const startedAt = Date.now();
    // A background (scheduled) run must not become the chat the next launch opens.
    if (!background) localStorage.setItem("dsh:last-conv", convId);
    // Reload re-attach: remember which conversation this run streams into.
    localStorage.setItem("dsh:live-run", JSON.stringify({ runId, convId }));
    updateConvMsgs(convId, (prev) => [...prev, { role: "agent", text: "", segments: [] }]);
    setActiveRuns((prev) => ({ ...prev, [convId]: runId }));
    setRunPhase((prev) => ({ ...prev, [convId]: "thinking" }));
    setErroredConv((prev) => (prev === convId ? null : prev));
    let phase: RunPhase = "thinking";
    const onText = (delta: string) => {
      if (phase === "thinking") {
        phase = "streaming";
        setRunPhase((prev) => ({ ...prev, [convId]: "streaming" }));
      }
      applyEvent(convId, { kind: "text", delta });
    };

    const turns = modelTurns(history);
    const imageGen = useAgent ? await imageGenFor(provider, cred, modelRow.model_id) : undefined;

    try {
      const answer = useAgent
        ? await db.runAgent(
            runId,
            {
              ...agentRequest(
                provider, cred, modelRow.model_id, selection, projectName, runWorkspace, runImages,
                await db.loadModelAgents(modelRow.id, provider.kind, provider.id), convId,
              ),
              effort: runEffort,
              max_tokens: maxTokens,
              image_gen: imageGen,
            },
            turns,
            {
              onText,
              onStep: (step) => applyEvent(convId, { kind: "step", step }),
              onThink: (delta) => applyEvent(convId, { kind: "think", delta }),
              onUsage: (usage) => applyEvent(convId, { kind: "usage", usage, accumulate: false }),
              onRetry: (retry) => applyEvent(convId, { kind: "retry", retry }),
              onConfirm: (req) => setConfirmReqs((prev) => ({ ...prev, [req.run_id]: req })),
            }
          )
        : await db.streamChat(
            runId,
            {
              kind: provider.kind,
              base_url: provider.base_url,
              api_key: cred.apiKey,
              auth: cred.auth,
              model: modelRow.model_id,
              effort: runEffort,
              images: runImages,
              max_tokens: maxTokens,
              provider_id: provider.id,
              rate_limit_rpm: provider.rate_limit_rpm ?? 0,
              concurrency: provider.concurrency ?? 0,
              chat_id: convId,
              system:
                "You are Singularity, a coding agent inside a desktop workspace. " +
                "Answer concisely and prefer concrete, runnable steps.",
            },
            turns,
            onText,
            (u) => applyEvent(convId, { kind: "usage", usage: { ...u, elapsed_ms: Date.now() - startedAt }, accumulate: true })
          );

      flushNow(convId);
      const elapsed = Date.now() - startedAt;
      // Persist prose AND the interleaved tool steps (reasoning stays live-only).
      const finalSegments = (convMsgsRef.current[convId] ?? []).at(-1)?.segments;
      const stepsCount = finalSegments?.filter((s) => s.kind === "step").length ?? 0;
      if (answer.trim() || stepsCount > 0) {
        const persisted = finalSegments?.filter((s) => s.kind !== "think" && s.kind !== "retry");
        await db.appendMessage(convId, "agent", answer, {
          durationMs: elapsed,
          segmentsJson: persisted && persisted.length ? JSON.stringify(persisted) : undefined,
        });
        opts.current.onActivity(convId);
      }
      if (freshTitle) {
        void generateTitle(convId, projectName, provider, cred, modelRow.model_id, promptText);
      }
      updateConvMsgs(convId, (prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "agent") next[next.length - 1] = { ...last, durationMs: elapsed };
        return next;
      });
    } catch (e) {
      flushNow(convId);
      const msg = e instanceof Error ? e.message : String(e);
      const elapsed = Date.now() - startedAt;
      setErroredConv(convId);
      // The error belongs to the turn it ended: shown under what it made.
      updateConvMsgs(convId, (prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        const segments = last?.role === "agent" ? last.segments?.filter((s) => s.kind !== "retry") : undefined;
        if (last && last.role === "agent") next[next.length - 1] = { ...last, segments, error: msg, durationMs: elapsed };
        else next.push({ role: "agent", text: "", error: msg, durationMs: elapsed });
        return next;
      });
      // Save what was generated before the failure/stop.
      try {
        const cur = convMsgsRef.current[convId] ?? [];
        const live = cur.at(-1);
        if (live && live.role === "agent" && (live.text.trim() || live.segments?.some((s) => s.kind === "step"))) {
          const persisted = live.segments?.filter((s) => s.kind !== "think" && s.kind !== "retry");
          await db.appendMessage(convId, "agent", live.text, {
            durationMs: elapsed,
            segmentsJson: persisted && persisted.length ? JSON.stringify(persisted) : undefined,
          });
          opts.current.onActivity(convId);
        }
      } catch {
        /* persistence must never mask the original error */
      }
    } finally {
      localStorage.removeItem("dsh:live-run");
      dropKey(setActiveRuns, convId);
      dropKey(setRunPhase, convId);
      dropKey(setConfirmReqs, runId);
    }
  };

  /**
   * Sends a prompt into `target` (or a brand-new chat when null). One run
   * per conversation — a send while it is busy is ignored. `project`
   * overrides the new chat's project; `background` leaves the screen alone
   * (scheduled tasks). Resolves with the conversation id once the run ends.
   */
  const send = async (
    text: string,
    target: { project: string; id: string } | null,
    selection: ChatSelection,
    attachments: Attachment[] = [],
    extra: { project?: string; background?: boolean } = {}
  ): Promise<string | null> => {
    const background = !!extra.background;
    if (!background) lastSelection.current = selection;
    const promptText = composePrompt(text, attachments);
    const images = attachments
      .filter((a) => a.kind === "image")
      .map((a) => ({ name: a.name, mime: a.mime, data_url: a.data }));
    const userMsg: Msg = { role: "user", text: promptText, images: images.length ? images : undefined };

    let convId: string;
    let projectName: string;
    let history: Msg[];
    let freshTitle = false;
    if (target) {
      // The agent is still working here: queue the prompt for afterwards.
      if (busy.current.has(target.id) || activeRunsRef.current[target.id]) {
        const item: QueuedPrompt = {
          id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          text,
          attachments,
          selection,
          project: target.project,
        };
        setQueues((prev) => ({ ...prev, [target.id]: [...(prev[target.id] ?? []), item] }));
        queuesRef.current = { ...queuesRef.current, [target.id]: [...(queuesRef.current[target.id] ?? []), item] };
        return null;
      }
      busy.current.add(target.id);
      paused.current.delete(target.id);
      convId = target.id;
      projectName = target.project;
      history = [...(convMsgsRef.current[convId] ?? []), userMsg];
      updateConvMsgs(convId, (prev) => [...prev, userMsg]);
    } else {
      convId = `c-${Date.now()}`;
      projectName = extra.project ?? opts.current.newChatProject;
      const title = promptText.length > 42 ? `${promptText.slice(0, 42)}…` : promptText;
      freshTitle = true;
      const conv: Conversation = { id: convId, title, updatedAt: Math.floor(Date.now() / 1000) };
      // State first: the browser-preview store shares project objects with
      // React state, so inserting first would add the chat twice.
      opts.current.onConversationCreated(projectName, conv, !background);
      await db.insertConversation(projectName, conv);
      busy.current.add(convId);
      history = [userMsg];
      setConvMsgs((prev) => {
        const next = { ...prev };
        // The draft belongs to the user's new-chat screen — a background run keeps it.
        if (!background) delete next[DRAFT_ID];
        next[convId] = history;
        return next;
      });
    }
    try {
      await db.appendMessage(convId, "user", promptText, { images: images.length ? images : undefined });
      opts.current.onActivity(convId);
      await runTurn(convId, projectName, history, promptText, images, selection, freshTitle, background);
    } finally {
      busy.current.delete(convId);
    }
    // Next queued follow-up — unless the user pressed Stop. (The effect
    // below also catches runs that did not start here.)
    if (!paused.current.has(convId)) void runQueued(convId, projectName);
    return convId;
  };

  /** Removes a queued prompt; returns it (Edit puts it back in the prompt box). */
  const takeQueued = (convId: string, id: string): QueuedPrompt | undefined => {
    const item = (queuesRef.current[convId] ?? []).find((q) => q.id === id);
    const rest = (queuesRef.current[convId] ?? []).filter((q) => q.id !== id);
    queuesRef.current = { ...queuesRef.current, [convId]: rest };
    setQueues((prev) => ({ ...prev, [convId]: (prev[convId] ?? []).filter((q) => q.id !== id) }));
    return item;
  };

  /** Sends the first queued prompt (or the one with `id`) into the chat. */
  const runQueued = async (convId: string, project: string, id?: string) => {
    if (busy.current.has(convId) || activeRunsRef.current[convId]) return;
    const first = id ?? queuesRef.current[convId]?.[0]?.id;
    if (!first) return;
    const item = takeQueued(convId, first);
    if (item) await send(item.text, { project, id: convId }, item.selection, item.attachments);
  };

  // Auto-send the queue whenever a conversation goes idle — whatever started
  // the run that just ended (a send, edit-and-resend, a run re-attached
  // after a reload, a failed turn). Stop pauses it until sent by hand.
  const runQueuedRef = useRef(runQueued);
  runQueuedRef.current = runQueued;
  useEffect(() => {
    for (const [convId, items] of Object.entries(queues)) {
      if (!items.length || activeRuns[convId] || busy.current.has(convId) || paused.current.has(convId)) continue;
      void runQueuedRef.current(convId, items[0].project);
    }
  }, [queues, activeRuns]);

  /**
   * Rewinds the conversation to the user message at `index`, replaces its
   * text and runs it again. Everything after it (answers, later prompts) is
   * dropped from the screen and the database.
   */
  const editAndResend = async (convId: string, project: string, index: number, newText: string) => {
    if (activeRunsRef.current[convId] || !newText.trim()) return;
    const selection = lastSelection.current ?? fallbackSelection();
    if (!selection) return;
    const msgs = convMsgsRef.current[convId] ?? [];
    const original = msgs[index];
    if (!original || original.role !== "user") return;
    const nth = msgs.slice(0, index).filter((m) => m.role === "user").length;
    await db.truncateFromUserMessage(convId, nth);
    const userMsg: Msg = { role: "user", text: newText, images: original.images };
    const history = [...msgs.slice(0, index), userMsg];
    setConvMsgs((prev) => ({ ...prev, [convId]: history }));
    await db.appendMessage(convId, "user", newText, { images: original.images });
    opts.current.onActivity(convId);
    await runTurn(convId, project, history, newText, original.images ?? [], selection, false);
  };

  /** Model settings when nothing was sent yet this session. */
  const fallbackSelection = (): ChatSelection | null => {
    const picked = opts.current.pickedModel;
    if (!picked) return null;
    return {
      ...picked,
      effort: (localStorage.getItem("effort") as Effort) || "low",
    };
  };

  /** Stops the run streaming into `convId`. */
  const stop = useCallback((convId: string) => {
    // Stop means "hold on": queued follow-ups wait until sent by hand.
    if ((queuesRef.current[convId] ?? []).length > 0) paused.current.add(convId);
    const run = activeRunsRef.current[convId];
    if (run) void db.stopGeneration(run);
  }, []);

  /** Answers a pending Allow/Deny request. */
  const confirm = useCallback((runId: string, approve: boolean) => {
    dropKey(setConfirmReqs, runId);
    void db.confirmCommand(runId, approve);
  }, []);

  /** Loads a conversation from the database (unless a live run owns it). */
  const load = useCallback(async (convId: string) => {
    if (activeRunsRef.current[convId]) return;
    const stored = await db.loadMessages(convId);
    setConvMsgs((prev) => ({ ...prev, [convId]: stored.map(storedToMsg) }));
  }, []);

  /** Clears a buffer (new chat draft) or forgets a deleted conversation. */
  const reset = useCallback((convId: string, remove = false) => {
    setConvMsgs((prev) => {
      const next = { ...prev };
      if (remove) delete next[convId];
      else next[convId] = [];
      return next;
    });
  }, []);

  /* ---------- Reload re-attach ----------
     Agent runs live in Rust and keep streaming when the WebView reloads;
     runs.rs buffers their output. On boot, replay the buffer of the run that
     was live and keep listening until it finishes, then persist the turn. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const marker = localStorage.getItem("dsh:live-run");
      if (!marker) return;
      let runId = "";
      let convId = "";
      try {
        const parsed = JSON.parse(marker) as { runId?: string; convId?: string };
        runId = parsed.runId ?? "";
        convId = parsed.convId ?? "";
      } catch {
        localStorage.removeItem("dsh:live-run");
        return;
      }
      if (!runId || !convId || claimedRuns.current.has(runId)) return;
      claimedRuns.current.add(runId);
      const live = await db.liveRuns();
      const snapshot = await db.agentSnapshot(runId);
      if (cancelled) return;
      if (!live.includes(runId) && snapshot.length === 0) {
        localStorage.removeItem("dsh:live-run");
        return;
      }

      const stored = await db.loadMessages(convId);
      if (cancelled) return;
      setConvMsgs((prev) => ({
        ...prev,
        [convId]: [...stored.map(storedToMsg), { role: "agent", text: "", segments: [] }],
      }));
      setActiveRuns((prev) => ({ ...prev, [convId]: runId }));
      setRunPhase((prev) => ({ ...prev, [convId]: "thinking" }));

      /** Everything this session has seen, folded into the saved turn. */
      const collected: db.RunEvent[] = [];
      const apply = (ev: db.RunEvent) => {
        collected.push(ev);
        if (ev.kind === "Text") {
          setRunPhase((pp) => ({ ...pp, [convId]: "streaming" }));
          applyEvent(convId, { kind: "text", delta: ev.delta });
        } else if (ev.kind === "Think") {
          applyEvent(convId, { kind: "think", delta: ev.delta });
        } else if (ev.kind === "Step") {
          applyEvent(convId, {
            kind: "step",
            step: {
              name: ev.name, input: ev.input, result: ev.result, ok: ev.ok, index: ev.index,
              done: ev.done, path: ev.path, old_text: ev.old_text, new_text: ev.new_text, image: ev.image,
            },
          });
        } else if (ev.kind === "Retry") {
          applyEvent(convId, { kind: "retry", retry: { message: ev.message, attempt: ev.attempt, max: ev.max } });
        } else if (ev.kind === "Confirm") {
          setConfirmReqs((prev) => ({ ...prev, [runId]: { run_id: runId, command: ev.command, cwd: ev.cwd, reason: ev.reason } }));
        }
      };
      for (const ev of snapshot) {
        if (ev.kind !== "Done" && ev.kind !== "Error") apply(ev);
      }
      const terminal = [...snapshot].reverse().find((e) => e.kind === "Done" || e.kind === "Error");

      const finish = async (answer: string, error?: string) => {
        localStorage.removeItem("dsh:live-run");
        dropKey(setActiveRuns, convId);
        dropKey(setRunPhase, convId);
        // Fold the BUFFER (state may not have flushed yet).
        let text = "";
        const segs: Segment[] = [];
        for (const ev of collected) {
          if (ev.kind === "Text") {
            text += ev.delta;
            const tail = segs[segs.length - 1];
            if (tail && tail.kind === "text") tail.text += ev.delta;
            else segs.push({ kind: "text", text: ev.delta });
          } else if (ev.kind === "Step") {
            const step: db.AgentStepEvent = {
              name: ev.name, input: ev.input, result: ev.result, ok: ev.ok, index: ev.index,
              done: true, path: ev.path, old_text: ev.old_text, new_text: ev.new_text, image: ev.image,
            };
            const at = segs.findIndex((s) => s.kind === "step" && s.step.index === ev.index);
            if (at >= 0) segs[at] = { kind: "step", step };
            else segs.push({ kind: "step", step });
          }
        }
        const finalText = answer || text;
        if (finalText.trim() || segs.some((s) => s.kind === "step")) {
          await db.appendMessage(convId, "agent", finalText, {
            segmentsJson: segs.length ? JSON.stringify(segs) : undefined,
          });
        }
        setConvMsgs((prev) => {
          const cur = prev[convId] ?? [];
          if (!cur.length) return prev;
          const next = [...cur];
          next[next.length - 1] = { role: "agent", text: finalText, segments: segs, error };
          return { ...prev, [convId]: next };
        });
      };

      if (terminal) {
        await finish(terminal.kind === "Done" ? terminal.answer : "", terminal.kind === "Error" ? terminal.message : undefined);
        return;
      }
      if (!live.includes(runId)) {
        await finish("");
        return;
      }
      const answer = await db.resumeAgent(runId, {
        onText: (d) => apply({ kind: "Text", delta: d }),
        onStep: (s) =>
          apply({
            kind: "Step", index: s.index, name: s.name, input: s.input, done: s.done, ok: s.ok,
            result: s.result, path: s.path, old_text: s.old_text, new_text: s.new_text,
          }),
        onThink: (d) => apply({ kind: "Think", delta: d }),
        onConfirm: (req) => setConfirmReqs((prev) => ({ ...prev, [req.run_id]: req })),
        onRetry: (r) => apply({ kind: "Retry", ...r }),
      });
      if (cancelled) return;
      await finish(answer);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    /** Message buffers by conversation id (DRAFT_ID = the new-chat view). */
    convMsgs,
    setConvMsgs,
    activeRuns,
    runPhase,
    erroredConv,
    confirmReqs,
    send,
    /** /compact and the context gauge. */
    compact,
    contextFor,
    /** Follow-up prompts queued per conversation. */
    queues,
    takeQueued,
    runQueued,
    editAndResend,
    stop,
    confirm,
    load,
    reset,
  };
}
