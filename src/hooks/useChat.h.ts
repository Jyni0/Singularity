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
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import * as db from "../core/db.r";
import type { Attachment, Conversation, Effort, Model, Project, Provider, SshServer } from "../core/types.i";
import { composePrompt } from "../utils/attachments.u";
import type { Msg, Segment } from "../chat/message.i";
import { storedToMsg } from "../chat/message.u";

/** Buffer key for the "new chat" view before a conversation exists. */
export const DRAFT_ID = "__new__";

/** Model settings picked in the prompt box for one send. */
export interface ChatSelection {
  gatewayId: string;
  modelId: string;
  effort: Effort;
  /** null = the provider's default temperature. */
  temperature: number | null;
}

export type RunPhase = "thinking" | "streaming";

export interface UseChatOptions {
  providers: Provider[];
  models: Model[];
  projects: Project[];
  workspace: string;
  agentMode: boolean;
  globalAutoRun: boolean;
  sshServers: SshServer[];
  subagents: db.Subagent[];
  maxAgents: number;
  /** Retries of a failed model request (Settings → Agent). */
  maxRetries: number;
  /** Model picked in the prompt box (edit-and-resend before any send). */
  pickedModel: { gatewayId: string; modelId: string } | null;
  /** Project a brand-new chat is created in. */
  newChatProject: string;
  /** A send created a conversation — add it to the tree and open it. */
  onConversationCreated: (project: string, conv: Conversation) => void;
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
  const applyEvent = useCallback(
    (convId: string, ev: { kind: "text"; delta: string } | { kind: "think"; delta: string } | { kind: "step"; step: db.AgentStepEvent } | { kind: "usage"; usage: db.RunUsage; accumulate: boolean }) => {
      updateConvMsgs(convId, (prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (!last || last.role !== "agent") return prev;
        const segs: Segment[] = [...(last.segments ?? [])];
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
  const runTurn = async (
    convId: string,
    projectName: string,
    history: Msg[],
    promptText: string,
    images: db.ImageAttachment[],
    selection: ChatSelection,
    freshTitle: boolean
  ) => {
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
    if (o.agentMode && !o.workspace.trim()) {
      updateConvMsgs(convId, (prev) => [
        ...prev,
        {
          role: "agent",
          text: "**Workspace not ready.**\n\nThe tools folder could not be resolved — restart the app and try again.",
        },
      ]);
      return;
    }

    const runId = `req-${Date.now()}`;
    const startedAt = Date.now();
    localStorage.setItem("dsh:last-conv", convId);
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

    const turns = history.map((m) => ({ role: m.role, text: m.text }));
    const project = o.projects.find((p) => p.name === projectName);
    const permMode = project?.permMode ?? "default";
    const autoRun = permMode === "bypass" ? true : permMode === "ask" ? false : o.globalAutoRun;

    try {
      const answer = o.agentMode
        ? await db.runAgent(
            runId,
            {
              kind: provider.kind,
              base_url: provider.base_url,
              api_key: cred.apiKey,
              auth: cred.auth,
              model: modelRow.model_id,
              system: "",
              workspace: o.workspace,
              effort: selection.effort,
              temperature: selection.temperature,
              auto_run: autoRun,
              images,
              provider_id: provider.id,
              rate_limit_rpm: provider.rate_limit_rpm ?? 0,
              concurrency: provider.concurrency ?? 0,
              subagents: o.subagents.filter((s) => s.enabled && s.name.trim()),
              max_agents: o.maxAgents,
              max_retries: o.maxRetries,
              ssh_units: o.sshServers.map((s) => ({ id: s.id, name: s.name, host: s.host })),
            },
            turns,
            {
              onText,
              onStep: (step) => applyEvent(convId, { kind: "step", step }),
              onThink: (delta) => applyEvent(convId, { kind: "think", delta }),
              onUsage: (usage) => applyEvent(convId, { kind: "usage", usage, accumulate: false }),
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
              effort: selection.effort,
              images,
              provider_id: provider.id,
              rate_limit_rpm: provider.rate_limit_rpm ?? 0,
              concurrency: provider.concurrency ?? 0,
              system:
                "You are Singularity, a coding agent inside a desktop workspace. " +
                "Answer concisely and prefer concrete, runnable steps.",
            },
            turns,
            onText,
            (u) => applyEvent(convId, { kind: "usage", usage: { ...u, elapsed_ms: Date.now() - startedAt }, accumulate: true })
          );

      const elapsed = Date.now() - startedAt;
      // Persist prose AND the interleaved tool steps (reasoning stays live-only).
      const finalSegments = (convMsgsRef.current[convId] ?? []).at(-1)?.segments;
      const stepsCount = finalSegments?.filter((s) => s.kind === "step").length ?? 0;
      if (answer.trim() || stepsCount > 0) {
        const persisted = finalSegments?.filter((s) => s.kind !== "think");
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
      const msg = e instanceof Error ? e.message : String(e);
      const elapsed = Date.now() - startedAt;
      setErroredConv(convId);
      updateConvMsgs(convId, (prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === "agent" && last.text === "" && !last.segments?.length) {
          next[next.length - 1] = { role: "agent", text: `⚠️ ${msg}`, durationMs: elapsed };
        } else {
          next.push({ role: "agent", text: `⚠️ ${msg}`, durationMs: elapsed });
        }
        return next;
      });
      // Save what was generated before the failure/stop.
      try {
        const cur = convMsgsRef.current[convId] ?? [];
        const live = cur.at(-1);
        if (live && live.role === "agent" && (live.text.trim() || live.segments?.some((s) => s.kind === "step"))) {
          const persisted = live.segments?.filter((s) => s.kind !== "think");
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
   * per conversation — a send while it is busy is ignored.
   */
  const send = async (
    text: string,
    target: { project: string; id: string } | null,
    selection: ChatSelection,
    attachments: Attachment[] = []
  ) => {
    lastSelection.current = selection;
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
      if (activeRunsRef.current[target.id]) return;
      convId = target.id;
      projectName = target.project;
      history = [...(convMsgsRef.current[convId] ?? []), userMsg];
      updateConvMsgs(convId, (prev) => [...prev, userMsg]);
    } else {
      convId = `c-${Date.now()}`;
      projectName = opts.current.newChatProject;
      const title = promptText.length > 42 ? `${promptText.slice(0, 42)}…` : promptText;
      freshTitle = true;
      const conv: Conversation = { id: convId, title, updatedAt: Math.floor(Date.now() / 1000) };
      // State first: the browser-preview store shares project objects with
      // React state, so inserting first would add the chat twice.
      opts.current.onConversationCreated(projectName, conv);
      await db.insertConversation(projectName, conv);
      history = [userMsg];
      setConvMsgs((prev) => {
        const next = { ...prev };
        delete next[DRAFT_ID];
        next[convId] = history;
        return next;
      });
    }
    await db.appendMessage(convId, "user", promptText, { images: images.length ? images : undefined });
    opts.current.onActivity(convId);
    await runTurn(convId, projectName, history, promptText, images, selection, freshTitle);
  };

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
    const t = localStorage.getItem("temperature");
    return {
      ...picked,
      effort: (localStorage.getItem("effort") as Effort) || "medium",
      temperature: t === null || t === "" ? null : Number(t),
    };
  };

  /** Stops the run streaming into `convId`. */
  const stop = useCallback((convId: string) => {
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
              done: ev.done, path: ev.path, old_text: ev.old_text, new_text: ev.new_text,
            },
          });
        } else if (ev.kind === "Confirm") {
          setConfirmReqs((prev) => ({ ...prev, [runId]: { run_id: runId, command: ev.command, cwd: ev.cwd } }));
        }
      };
      for (const ev of snapshot) {
        if (ev.kind !== "Done" && ev.kind !== "Error") apply(ev);
      }
      const terminal = [...snapshot].reverse().find((e) => e.kind === "Done" || e.kind === "Error");

      const finish = async (answer: string, failed: boolean) => {
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
              done: true, path: ev.path, old_text: ev.old_text, new_text: ev.new_text,
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
          next[next.length - 1] = { role: "agent", text: finalText, segments: segs };
          if (failed) next.push({ role: "agent", text: "⚠️ The run failed while the page was reloading." });
          return { ...prev, [convId]: next };
        });
      };

      if (terminal) {
        await finish(terminal.kind === "Done" ? terminal.answer : "", terminal.kind === "Error");
        return;
      }
      if (!live.includes(runId)) {
        await finish("", false);
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
      });
      if (cancelled) return;
      await finish(answer, false);
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
    editAndResend,
    stop,
    confirm,
    load,
    reset,
  };
}
