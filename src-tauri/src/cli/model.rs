//! [`CliModel`]: a Rig `CompletionModel` whose "HTTP call" is a headless
//! CLI process. A request is rendered into a prompt (protocol.rs), fed to
//! the CLI on stdin, and its JSON event stream is turned back into Rig
//! stream items — text and reasoning deltas, tool calls from the
//! `<tool_call>` protocol, usage and errors.
//!
//! Sessions: the official CLIs keep ONE conversation per task and only
//! append to it, so the provider's prompt cache covers everything said so
//! far. agy and Claude Code read further user messages from stdin in the
//! same headless session, so a model keeps its CLI process alive across the
//! calls of one agent run: a call that continues the previous one (same
//! instructions and history, plus the CLI's own reply and the new tool
//! results) writes only those results. Measured on agy: ~33% of the prompt
//! from cache when every call started a new process, 80–90% in one session.
//! Codex `exec` is one-shot, but `exec resume <thread>` continues its
//! recorded conversation, so it gets the same treatment with a process per
//! call. A call that does not continue (a retry after an error, another
//! prompt) ends the session and starts a new one. Dropping a stream mid-turn
//! (Stop) kills the process.
//!
//! Chats: a run's model takes its session from the chat's slot
//! ([`CliModel::for_chat`]), so ONE CLI session serves the whole chat — the
//! next message of the chat is written into the session that is already
//! running (it holds the earlier runs, tool results included) instead of
//! starting a new CLI with the whole conversation again.

use super::protocol::{self, Piece, Rendered, ToolTagFilter};
use super::{agy_model_args, ensure, jobs, tail, Cli};
use rig_agent::core::completion::message::{AssistantContent, Message, Text};
use rig_agent::core::completion::{
    CompletionError, CompletionModel, CompletionRequest, CompletionResponse, Usage,
};
use rig_agent::core::streaming::{
    MintKind, RawStreamingChoice, RawStreamingToolCall, StreamFinal, StreamPartId,
    StreamingCompletionResponse,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::mpsc;

type Item = Result<RawStreamingChoice, CompletionError>;

#[derive(Clone)]
pub struct CliModel {
    cli: Cli,
    /// "default"/"" lets the CLI pick (the account's default model).
    model: String,
    /// low | medium | high
    effort: String,
    /// The live CLI session of this model's agent run — or of its whole
    /// chat (see the module docs).
    session: Slot,
    /// No call made yet: the first call of a run may resume the chat's
    /// session with just the new user message.
    fresh: Arc<AtomicBool>,
}

type Slot = Arc<tokio::sync::Mutex<Option<Session>>>;

/// The chats' CLI sessions, most recently used last.
static CHAT_SESSIONS: LazyLock<std::sync::Mutex<Vec<(String, Slot)>>> = LazyLock::new(Default::default);
/// Idle chat sessions kept alive (each one is a CLI process for agy/Claude).
const KEEP_CHATS: usize = 4;

/// The session slot of `chat` for this CLI + model + effort. Another model
/// or effort in the same chat ends the chat's previous session.
fn chat_slot(chat: &str, key: &str) -> Slot {
    let mut all = CHAT_SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
    let prefix = format!("{chat}|");
    all.retain(|(k, _)| !k.starts_with(&prefix) || k == key);
    if let Some(i) = all.iter().position(|(k, _)| k == key) {
        let entry = all.remove(i);
        let slot = entry.1.clone();
        all.push(entry);
        return slot;
    }
    let slot = Slot::default();
    all.push((key.to_string(), slot.clone()));
    while all.len() > KEEP_CHATS {
        all.remove(0); // its process is killed with it
    }
    slot
}

/// Ends the CLI session of `chat` (the chat was deleted).
pub fn end_chat(chat: &str) {
    let prefix = format!("{chat}|");
    CHAT_SESSIONS.lock().unwrap_or_else(|e| e.into_inner()).retain(|(k, _)| !k.starts_with(&prefix));
}

impl std::fmt::Debug for CliModel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CliModel").field("cli", &self.cli).field("model", &self.model).field("effort", &self.effort).finish()
    }
}

/// A running CLI process and its pipes.
struct Proc {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Lines<BufReader<ChildStdout>>,
    err_task: tokio::task::JoinHandle<String>,
    /// Temp files of the process (system prompt, images) — removed on drop.
    _job: Job,
    /// agy reports session totals; a call's usage is the difference.
    totals: Usage,
}

/// A live session between two calls: the process (or, for Codex, the
/// recorded thread to resume) plus what it has seen.
struct Session {
    proc: Option<Proc>,
    /// Codex: the thread id `exec resume` continues.
    thread: Option<String>,
    /// Fingerprint of the tool definitions + instructions it was started with.
    tools: u64,
    /// Fingerprint of the tool definitions alone (a new run of the chat may
    /// come with updated instructions — the session keeps its own).
    tool_defs: u64,
    /// Fingerprints of the request messages it has seen (system included).
    seen: Vec<u64>,
    /// The user's own messages in the chat so far — a new run continues
    /// the session only when it brings exactly one more.
    turns: usize,
    /// Codex: the thread's usage totals so far (a resumed thread reports
    /// totals, not the call's own numbers).
    totals: Usage,
}

/// The user's typed messages in a request (tool results do not count).
fn user_turns(req: &CompletionRequest) -> usize {
    use rig_agent::core::completion::message::UserContent;
    req.chat_history
        .iter()
        .filter(|m| matches!(m, Message::User { content } if content.iter().any(|c| matches!(c, UserContent::Text(_)))))
        .count()
}

fn fingerprint<T: serde::Serialize>(v: &T) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(v).unwrap_or_default().hash(&mut h);
    h.finish()
}

/// (tools, per-message) fingerprints of a request.
fn request_fingerprints(req: &CompletionRequest) -> (u64, Vec<u64>) {
    let tools = fingerprint(&req.tools) ^ fingerprint(&req.preamble);
    (tools, req.chat_history.iter().map(fingerprint).collect())
}

impl Session {
    /// The text to write when `req` continues this session: everything
    /// after the session's own reply. None when it does not continue.
    fn followup(&self, req: &CompletionRequest, fps: &(u64, Vec<u64>)) -> Option<String> {
        let n = self.seen.len();
        if fps.0 != self.tools || fps.1.len() < n + 2 || fps.1[..n] != self.seen[..] {
            return None;
        }
        let rest = &req.chat_history[n..];
        if !matches!(rest[0], Message::Assistant { .. }) {
            return None;
        }
        protocol::render_followup(&rest[1..], !req.tools.is_empty())
    }

    /// The text to write when `req` starts a NEW run of the chat this
    /// session serves: its last user message. The session already holds the
    /// earlier runs (in more detail than the saved chat). None when the
    /// tools changed or the message carries images.
    fn resume(&self, req: &CompletionRequest) -> Option<String> {
        // Same tools, and the chat grew by exactly this message (an edited
        // and resent earlier prompt is another conversation).
        if fingerprint(&req.tools) != self.tool_defs || user_turns(req) != self.turns + 1 {
            return None;
        }
        let last = req.chat_history.last().filter(|m| matches!(m, Message::User { .. }))?;
        protocol::render_followup(std::slice::from_ref(last), !req.tools.is_empty())
    }
}

/// CLIs whose headless mode keeps reading user messages from stdin.
/// Codex keeps its conversation too, through `exec resume`.
pub fn keeps_session(cli: Cli) -> bool {
    matches!(cli, Cli::Antigravity | Cli::Claude | Cli::Codex)
}

/// One user message on a CLI's stream-json stdin.
fn user_line(cli: Cli, text: &str) -> String {
    let content = json!([{ "type": "text", "text": text }]);
    match cli {
        Cli::Claude => format!("{}\n", json!({ "type": "user", "message": { "role": "user", "content": content } })),
        _ => format!("{}\n", json!({ "event": "user", "message": { "role": "user", "content": content } })),
    }
}

impl CliModel {
    pub fn new(cli: Cli, model: &str, effort: &str) -> Self {
        Self {
            cli,
            model: model.trim().to_string(),
            effort: effort.to_string(),
            session: Arc::default(),
            fresh: Arc::new(AtomicBool::new(true)),
        }
    }

    /// A model whose session is the chat's one (see the module docs). An
    /// empty `chat` = a session of this run only.
    pub fn for_chat(cli: Cli, model: &str, effort: &str, chat: &str) -> Self {
        let mut m = Self::new(cli, model, effort);
        if !chat.is_empty() {
            m.session = chat_slot(chat, &format!("{chat}|{cli:?}|{}|{effort}", m.model));
        }
        m
    }

    fn provider(&self) -> &'static str {
        match self.cli {
            Cli::Codex => "codex-cli",
            Cli::Claude => "claude-code-cli",
            Cli::Antigravity => "antigravity-cli",
        }
    }

    fn model_arg(&self) -> Option<&str> {
        let m = self.model.as_str();
        (!m.is_empty() && m != "default").then_some(m)
    }

    /// Starts a CLI process for `req`. Returns it and the first stdin text.
    /// `persist`: Codex records the conversation so it can be resumed.
    async fn spawn(&self, req: &CompletionRequest, persist: bool) -> Result<(Proc, String), CompletionError> {
        self.spawn_rendered(&protocol::render(req), persist, None).await
    }

    /// Codex: continues recorded `thread` with `text`.
    async fn spawn_resume(&self, thread: &str, text: &str) -> Result<(Proc, String), CompletionError> {
        let r = Rendered { system: String::new(), prompt: text.to_string(), images: Vec::new() };
        self.spawn_rendered(&r, true, Some(thread)).await
    }

    async fn spawn_rendered(&self, rendered: &Rendered, persist: bool, resume: Option<&str>) -> Result<(Proc, String), CompletionError> {
        let fail = CompletionError::ProviderError;
        let launch = ensure(self.cli).await.map_err(fail)?;
        let agy_args = match (self.cli, self.model_arg()) {
            (Cli::Antigravity, Some(model)) => agy_model_args(&launch, model, &self.effort).await,
            _ => Vec::new(),
        };
        let mut job = Job::prepare(self, rendered, &agy_args, persist, resume).map_err(fail)?;
        let mut cmd = launch.command();
        cmd.args(&job.args).stdin(Stdio::piped());
        if let Some(dir) = &job.cwd {
            cmd.current_dir(dir);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| fail(format!("cannot start {}: {e}", self.cli.label())))?;
        let stdin = child.stdin.take().ok_or_else(|| fail("no stdin".into()))?;
        // stderr: kept for the error message when the CLI fails.
        let mut stderr = child.stderr.take().ok_or_else(|| fail("no stderr".into()))?;
        let err_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).to_string()
        });
        let stdout = child.stdout.take().ok_or_else(|| fail("no stdout".into()))?;
        let first = std::mem::take(&mut job.stdin);
        let proc = Proc {
            child,
            stdin: Some(stdin),
            lines: BufReader::new(stdout).lines(),
            err_task,
            _job: job,
            totals: Usage::new(),
        };
        Ok((proc, first))
    }

    /// Runs one call and returns the Rig stream over its events.
    /// `sessioned`: keep (or continue) the CLI session of this model.
    pub(super) async fn open(&self, req: CompletionRequest, sessioned: bool) -> Result<StreamingCompletionResponse, CompletionError> {
        let cli = self.cli;
        let sessioned = sessioned && keeps_session(cli);
        let fps = request_fingerprints(&req);
        let fresh = self.fresh.swap(false, Ordering::SeqCst);
        let mut slot = if sessioned { Some(self.session.clone().lock_owned().await) } else { None };
        // A session that does not continue is dropped here (its process
        // killed) and a fresh one starts. The first call of a run may resume
        // the chat's session with just the new message.
        let live = slot.as_mut().and_then(|g| g.take()).and_then(|s| {
            if let Some(text) = s.followup(&req, &fps) {
                return Some((s, text, true));
            }
            let text = if fresh { s.resume(&req) } else { None }?;
            Some((s, text, false))
        });
        // The chat's user messages at the start of this run (notes added
        // inside a run are not part of the saved chat).
        let turns = match &live {
            Some((s, _, true)) => s.turns,
            _ => user_turns(&req),
        };
        let mut thread: Option<String> = None;
        let (mut proc, first) = match live {
            Some((Session { proc: Some(proc), .. }, text, _)) => {
                tracing::debug!(cli = ?cli, chars = text.len(), "CLI session continues");
                (proc, user_line(cli, &text))
            }
            Some((Session { thread: Some(t), totals, .. }, text, _)) => {
                tracing::debug!(cli = ?cli, chars = text.len(), "Codex thread resumes");
                let mut started = self.spawn_resume(&t, &text).await?;
                started.0.totals = totals;
                thread = Some(t);
                started
            }
            _ => {
                if sessioned {
                    tracing::debug!(cli = ?cli, messages = req.chat_history.len(), "CLI session starts");
                }
                self.spawn(&req, sessioned).await?
            }
        };
        let tool_defs = fingerprint(&req.tools);

        let (tx, rx) = mpsc::channel::<Item>(64);
        let provider = self.provider();
        tokio::spawn(async move {
            // The message, then — for a one-shot call — EOF so the CLI
            // starts working. agy keeps stdin open even then: a turn it
            // spent on its own (denied) tools gets a follow-up message in
            // the same session — see `Decoder::stalled`.
            if let Some(stdin) = proc.stdin.as_mut() {
                let ok = stdin.write_all(first.as_bytes()).await.is_ok() && stdin.flush().await.is_ok();
                if !ok {
                    let _ = tx.send(Err(CompletionError::ProviderError(format!("{}: could not send the prompt", cli.label())))).await;
                    return;
                }
            }
            // Codex reads one prompt and works: EOF even in a session.
            if (!sessioned || cli == Cli::Codex) && cli != Cli::Antigravity {
                if let Some(mut s) = proc.stdin.take() {
                    let _ = s.shutdown().await;
                }
            }
            let mut state = Decoder::new(cli);
            let mut out = Emitter::new(tx.clone());
            let mut nudges = 0;
            loop {
                tokio::select! {
                    line = proc.lines.next_line() => match line {
                        Ok(Some(line)) => {
                            if cfg!(test) && std::env::var_os("CLI_TRACE").is_some() {
                                eprintln!("RAW {}", line.chars().take(400).collect::<String>());
                            }
                            for ev in state.feed(&line) {
                                if !out.send(ev).await {
                                    return; // consumer gone: the process is killed on drop
                                }
                            }
                            if !state.turn_over {
                                continue;
                            }
                            state.turn_over = false;
                            if state.stalled && !out.produced && nudges < MAX_NUDGES {
                                if let Some(s) = proc.stdin.as_mut() {
                                    nudges += 1;
                                    state.stalled = false;
                                    let _ = s.write_all(nudge(cli, &state.denied).as_bytes()).await;
                                    let _ = s.flush().await;
                                    continue;
                                }
                            }
                            if sessioned && state.fatal.is_none() && !(state.stalled && !out.produced) {
                                // The turn is over and the session stays
                                // alive for the next call of the run.
                                let usage = proc.turn_usage(cli, &state.usage);
                                if !out.flush().await {
                                    return;
                                }
                                if tx.send(Ok(RawStreamingChoice::FinalResponse(StreamFinal::new(provider, usage)))).await.is_ok() {
                                    if let Some(g) = slot.as_mut() {
                                        **g = Some(Session { proc: Some(proc), thread: None, tools: fps.0, tool_defs, seen: fps.1, turns, totals: Usage::new() });
                                    }
                                }
                                return;
                            }
                            // Done: EOF ends the session.
                            if let Some(mut s) = proc.stdin.take() {
                                let _ = s.shutdown().await;
                            }
                        }
                        Ok(None) => break,
                        // Unreadable output must not pass for an empty answer.
                        Err(e) => {
                            state.fatal.get_or_insert_with(|| format!("{}: unreadable output ({e})", cli.label()));
                            break;
                        }
                    },
                    // Stop pressed while the CLI is silent (thinking).
                    _ = tx.closed() => return,
                }
            }
            let status = proc.child.wait().await.ok();
            let stderr = (&mut proc.err_task).await.unwrap_or_default();

            if let Some(msg) = state.fatal.take() {
                let _ = tx.send(Err(CompletionError::ProviderError(explain(cli, &msg).await))).await;
                return;
            }
            if state.stalled && !out.produced {
                let msg = format!(
                    "{} kept reaching for its own tools ({}), which are switched off here, and gave no answer — retry, or pick another model",
                    cli.label(),
                    state.denied.join(", ")
                );
                let _ = tx.send(Err(CompletionError::ProviderError(msg))).await;
                return;
            }
            let failed = status.map(|s| !s.success()).unwrap_or(true);
            if failed && !out.produced {
                let detail = state.last_error.take().filter(|e| !e.is_empty()).unwrap_or_else(|| tail(&stderr, 800));
                let msg = if detail.is_empty() {
                    format!("{} exited without an answer", cli.label())
                } else {
                    format!("{}: {detail}", cli.label())
                };
                let _ = tx.send(Err(CompletionError::ProviderError(explain(cli, &msg).await))).await;
                return;
            }
            if !out.flush().await {
                return;
            }
            let usage = proc.turn_usage(cli, &state.usage);
            let sent = tx.send(Ok(RawStreamingChoice::FinalResponse(StreamFinal::new(provider, usage)))).await.is_ok();
            // Codex: the conversation is recorded; the next call resumes it.
            if let (true, Cli::Codex, Some(t)) = (sent && sessioned, cli, state.thread.take().or(thread)) {
                if let Some(g) = slot.as_mut() {
                    **g = Some(Session { proc: None, thread: Some(t), tools: fps.0, tool_defs, seen: fps.1, turns, totals: proc.totals });
                }
            }
        });

        let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|x| (x, rx)) });
        Ok(StreamingCompletionResponse::stream(provider, Box::pin(stream)))
    }
}

impl Proc {
    /// The usage of the call that just ended, with the whole prompt (cache
    /// reads included) as input — what the agent's accounting expects.
    fn turn_usage(&mut self, cli: Cli, reported: &Usage) -> Usage {
        if cli == Cli::Claude {
            return *reported;
        }
        // agy and a resumed Codex thread report totals; agy's input is
        // WITHOUT the cache reads, Codex's with them.
        let t = &self.totals;
        let mut u = Usage::new();
        u.cached_input_tokens = reported.cached_input_tokens.saturating_sub(t.cached_input_tokens);
        u.input_tokens = reported.input_tokens.saturating_sub(t.input_tokens)
            + if cli == Cli::Antigravity { u.cached_input_tokens } else { 0 };
        u.output_tokens = reported.output_tokens.saturating_sub(t.output_tokens);
        u.reasoning_tokens = reported.reasoning_tokens.saturating_sub(t.reasoning_tokens);
        u.total_tokens = u.input_tokens + u.output_tokens;
        self.totals = *reported;
        u
    }
}

impl CompletionModel for CliModel {
    /// One-shot (compaction summaries): never touches the run's session.
    async fn completion(&self, request: CompletionRequest) -> Result<CompletionResponse, CompletionError> {
        use futures_util::StreamExt;
        let mut stream = self.open(request, false).await?;
        while let Some(item) = stream.next().await {
            item?;
        }
        let usage = stream.response.as_ref().map(|r| r.usage).unwrap_or_default();
        let mut choice = stream.choice.clone();
        if choice.is_empty() {
            choice.push(AssistantContent::Text(Text::new("")));
        }
        Ok(CompletionResponse::new(choice, usage, self.provider()))
    }

    async fn stream(&self, request: CompletionRequest) -> Result<StreamingCompletionResponse, CompletionError> {
        self.open(request, true).await
    }
}

/// Makes the common failures actionable. A CLI too old for the model gets
/// updated right here, so the run's automatic retry already uses the new one.
async fn explain(cli: Cli, msg: &str) -> String {
    let low = msg.to_lowercase();
    if low.contains("or newer is required") || low.contains("does not support this model") {
        return match super::update_outdated(cli).await {
            Ok(v) => format!("{msg}\n\n{} was updated to {v} — retrying.", cli.label()),
            Err(e) => format!("{msg}\n\nUpdating {} failed: {e}", cli.label()),
        };
    }
    let auth = ["login", "log in", "sign in", "unauthorized", "401", "not logged", "authenticat", "credentials"];
    if auth.iter().any(|k| low.contains(k)) {
        return format!("{msg}\n\nSign in to {} in Settings → Models (the provider card).", cli.label());
    }
    msg.to_string()
}

/* ---------- Command line per CLI ---------- */

struct Job {
    args: Vec<String>,
    stdin: String,
    /// Temp files (system prompt, images) removed after the run.
    files: Vec<PathBuf>,
    /// Where the process runs (default: the shared scratch folder).
    cwd: Option<PathBuf>,
}

impl Job {
    /// `persist` / `resume`: Codex only — record the conversation, or
    /// continue a recorded thread with `r.prompt`.
    fn prepare(m: &CliModel, r: &Rendered, agy_args: &[String], persist: bool, resume: Option<&str>) -> Result<Self, String> {
        let dir = jobs().join(format!("run-{}", uid()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut job = Job { args: vec![], stdin: String::new(), files: vec![dir.clone()], cwd: None };
        // Levels each CLI accepts (the UI offers only these; anything else
        // falls back to the CLI's own default).
        let levels: &[&str] = match m.cli {
            Cli::Codex => &["low", "medium", "high", "xhigh", "ultra"],
            Cli::Claude => &["low", "medium", "high", "xhigh", "max", "ultracode"],
            Cli::Antigravity => &["low", "medium", "high"],
        };
        let effort = levels.contains(&m.effort.as_str()).then_some(m.effort.as_str());

        match m.cli {
            Cli::Claude => {
                let sys = dir.join("system.md");
                std::fs::write(&sys, &r.system).map_err(|e| e.to_string())?;
                job.args = [
                    "-p",
                    "--output-format",
                    "stream-json",
                    "--input-format",
                    "stream-json",
                    "--verbose",
                    "--include-partial-messages",
                    "--no-session-persistence",
                    // Its own tools (and the user's MCP servers) stay off:
                    // tools are the app's, offered through the prompt.
                    "--tools",
                    "",
                    "--strict-mcp-config",
                    "--disallowedTools",
                    "mcp__*",
                    "--system-prompt-file",
                ]
                .iter()
                .map(|s| s.to_string())
                .collect();
                job.args.push(sys.display().to_string());
                if let Some(model) = m.model_arg() {
                    job.args.extend(["--model".into(), model.into()]);
                }
                if let Some(e) = effort {
                    job.args.extend(["--effort".into(), e.into()]);
                }
                let mut content = vec![json!({ "type": "text", "text": r.prompt })];
                for img in &r.images {
                    content.push(json!({
                        "type": "image",
                        "source": { "type": "base64", "media_type": img.mime, "data": img.base64 },
                    }));
                }
                job.stdin = format!(
                    "{}\n",
                    json!({ "type": "user", "message": { "role": "user", "content": content } })
                );
            }
            Cli::Codex => {
                job.args = match resume {
                    // `exec resume` takes no --sandbox / --color flags.
                    Some(_) => vec!["exec", "resume", "--json", "--skip-git-repo-check", "-c", "sandbox_mode=\"read-only\""],
                    None => vec!["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never"],
                }
                .into_iter()
                .map(String::from)
                .collect();
                if !persist {
                    job.args.push("--ephemeral".into());
                }
                if let Some(model) = m.model_arg() {
                    job.args.extend(["-m".into(), model.into()]);
                }
                if let Some(e) = effort {
                    job.args.extend(["-c".into(), format!("model_reasoning_effort=\"{e}\"")]);
                }
                for (i, img) in r.images.iter().enumerate() {
                    let ext = img.mime.rsplit('/').next().unwrap_or("png");
                    let p = dir.join(format!("image-{i}.{ext}"));
                    let bytes = base64_decode(&img.base64)?;
                    std::fs::write(&p, bytes).map_err(|e| e.to_string())?;
                    job.args.push(format!("--image={}", p.display()));
                }
                if let Some(thread) = resume {
                    job.args.push(thread.into());
                }
                job.args.push("-".into()); // prompt from stdin
                job.stdin = with_system(r);
            }
            Cli::Antigravity => {
                // The prompt rides stdin as one stream-json message (`-p ""`
                // turns on print mode) — a command line would cap its size.
                // Tools needing permission are denied headless; the rest only
                // see the empty scratch folder.
                job.args = ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands"]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                // `--model` (and `--effort` when needed), picked in `open`.
                job.args.extend(agy_args.iter().cloned());
                job.args.extend(["-p".into(), String::new()]);
                // agy has no system-prompt flag, but it puts the GEMINI.md /
                // AGENTS.md rules of its working folder INTO its system
                // prompt. Our instructions go there (a folder per session):
                // as the user's first message they read like an injection —
                // Gemini spent its reasoning (and a whole call on its own
                // RunCommand) doubting them — and a stable system prefix is
                // what its prompt cache keys on.
                let rest = write_agy_rules(&dir, &r.system).map_err(|e| format!("cannot write the agy rules: {e}"))?;
                job.cwd = Some(dir.clone());
                let mut text = if rest.trim().is_empty() {
                    r.prompt.clone()
                } else {
                    with_system(&Rendered { system: rest, prompt: r.prompt.clone(), images: Vec::new() })
                };
                if !r.images.is_empty() {
                    text.push_str("\n\n[Images were attached, but this provider receives text only.]");
                }
                job.stdin = format!(
                    "{}\n",
                    json!({ "event": "user", "message": { "role": "user", "content": [{ "type": "text", "text": text }] } })
                );
            }
        }
        Ok(job)
    }

}

impl Drop for Job {
    fn drop(&mut self) {
        for f in &self.files {
            let _ = std::fs::remove_dir_all(f);
        }
    }
}

/// agy's per-file rules cap (bytes), with some room to spare.
const AGY_RULE_BYTES: usize = 23_000;

/// Writes `system` as agy rules into `dir` (GEMINI.md, then AGENTS.md — two
/// files of 24 KB at most each). Returns what did not fit.
fn write_agy_rules(dir: &std::path::Path, system: &str) -> std::io::Result<String> {
    let mut rest = system;
    for name in ["GEMINI.md", "AGENTS.md"] {
        if rest.trim().is_empty() {
            break;
        }
        let cut = if rest.len() <= AGY_RULE_BYTES {
            rest.len()
        } else {
            // On a line boundary, at most AGY_RULE_BYTES.
            let mut at = AGY_RULE_BYTES;
            while !rest.is_char_boundary(at) {
                at -= 1;
            }
            rest[..at].rfind('\n').map(|i| i + 1).unwrap_or(at)
        };
        std::fs::write(dir.join(name), &rest[..cut])?;
        rest = &rest[cut..];
    }
    Ok(rest.to_string())
}

/// CLIs without a system-prompt flag get it at the top of the prompt, as the
/// user's own instructions (a fake `<system>` block in a user turn reads as
/// an injection attempt, and the models ignored it).
fn with_system(r: &Rendered) -> String {
    if r.system.trim().is_empty() {
        r.prompt.clone()
    } else {
        format!("My instructions for this conversation:\n\n{}\n\n---\n\n{}", r.system, r.prompt)
    }
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s.trim()).map_err(|e| format!("bad image data: {e}"))
}

fn uid() -> String {
    use rand::Rng;
    format!("{:016x}", rand::thread_rng().gen::<u64>())
}

/* ---------- Event decoding ---------- */

enum Ev {
    Text(String),
    Think(String),
}

/// Turns one CLI's JSON lines into text/think events, usage and errors.
struct Decoder {
    cli: Cli,
    usage: Usage,
    /// An error that ends the request no matter what was produced.
    fatal: Option<String>,
    /// A non-fatal error, reported only if the CLI then fails.
    last_error: Option<String>,
    /// Claude: partial deltas seen, so the full message must not repeat them.
    saw_delta: bool,
    /// Codex: text already emitted per item id (items may update in place).
    emitted: HashMap<String, usize>,
    /// Codex: a new agent message after an earlier one starts a paragraph.
    messages: usize,
    /// A turn just ended (its `result` arrived).
    turn_over: bool,
    /// agy: the turn ended with no answer after its own tools were denied —
    /// headless print mode auto-denies them and reports SUCCESS with an
    /// empty response.
    stalled: bool,
    /// agy: its own tools that were denied (RunCommand, …).
    denied: Vec<String>,
    /// Codex: the recorded conversation (`thread.started`).
    thread: Option<String>,
}

impl Decoder {
    fn new(cli: Cli) -> Self {
        Self {
            cli,
            usage: Usage::new(),
            fatal: None,
            last_error: None,
            saw_delta: false,
            emitted: HashMap::new(),
            messages: 0,
            turn_over: false,
            stalled: false,
            denied: Vec::new(),
            thread: None,
        }
    }

    fn feed(&mut self, line: &str) -> Vec<Ev> {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            return vec![];
        };
        match self.cli {
            Cli::Claude => self.claude(&v),
            Cli::Codex => self.codex(&v),
            Cli::Antigravity => self.antigravity(&v),
        }
    }

    fn claude(&mut self, v: &Value) -> Vec<Ev> {
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match v["type"].as_str().unwrap_or("") {
            "stream_event" => {
                let delta = &v["event"]["delta"];
                match delta["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        self.saw_delta = true;
                        vec![Ev::Text(s(delta, "text"))]
                    }
                    "thinking_delta" => {
                        self.saw_delta = true;
                        vec![Ev::Think(s(delta, "thinking"))]
                    }
                    _ => vec![],
                }
            }
            // Full message — only used when the CLI streamed no deltas.
            // "<synthetic>" messages restate an error the result reports.
            "assistant" if !self.saw_delta && v["message"]["model"] != "<synthetic>" => v["message"]["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|b| match b["type"].as_str() {
                            Some("text") => Some(Ev::Text(s(b, "text"))),
                            Some("thinking") => Some(Ev::Think(s(b, "thinking"))),
                            _ => None,
                        })
                        .collect()
                })
                .unwrap_or_default(),
            "result" => {
                let u = &v["usage"];
                let n = |k: &str| u[k].as_u64().unwrap_or(0);
                let read = n("cache_read_input_tokens");
                let created = n("cache_creation_input_tokens");
                // Whole prompt, cache reads included (what the HUD expects).
                self.usage.input_tokens = n("input_tokens") + read;
                self.usage.cached_input_tokens = read;
                self.usage.cache_creation_input_tokens = created;
                self.usage.output_tokens = n("output_tokens");
                self.usage.total_tokens = self.usage.input_tokens + created + self.usage.output_tokens;
                self.turn_over = true;
                if v["is_error"].as_bool().unwrap_or(false) {
                    let msg = s(v, "result");
                    self.fatal = Some(if msg.is_empty() { s(v, "subtype") } else { msg });
                }
                vec![]
            }
            _ => vec![],
        }
    }

    fn codex(&mut self, v: &Value) -> Vec<Ev> {
        match v["type"].as_str().unwrap_or("") {
            "thread.started" => {
                self.thread = v["thread_id"].as_str().map(String::from);
                vec![]
            }
            "item.started" | "item.updated" | "item.completed" => {
                let item = &v["item"];
                let id = item["id"].as_str().unwrap_or("").to_string();
                let text = item["text"].as_str().unwrap_or("");
                let kind = item["type"].as_str().unwrap_or("");
                if kind != "agent_message" && kind != "reasoning" {
                    return vec![];
                }
                let seen = self.emitted.get(&id).copied().unwrap_or(0);
                if text.len() <= seen || !text.is_char_boundary(seen) {
                    return vec![];
                }
                let mut new = text[seen..].to_string();
                if kind == "agent_message" && seen == 0 {
                    if self.messages > 0 {
                        new = format!("\n\n{new}");
                    }
                    self.messages += 1;
                }
                self.emitted.insert(id, text.len());
                vec![if kind == "reasoning" { Ev::Think(new) } else { Ev::Text(new) }]
            }
            "turn.completed" => {
                let u = &v["usage"];
                let n = |k: &str| u[k].as_u64().unwrap_or(0);
                self.usage.input_tokens += n("input_tokens");
                self.usage.cached_input_tokens += n("cached_input_tokens");
                self.usage.output_tokens += n("output_tokens");
                self.usage.reasoning_tokens += n("reasoning_output_tokens");
                self.usage.total_tokens = self.usage.input_tokens + self.usage.output_tokens;
                vec![]
            }
            "turn.failed" => {
                self.fatal = v["error"]["message"].as_str().map(String::from).or(Some("turn failed".into()));
                vec![]
            }
            "error" => {
                self.last_error = v["message"].as_str().map(String::from);
                vec![]
            }
            _ => vec![],
        }
    }

    /// agy stream-json: `step_update` events carry `text_delta` for the
    /// agent's answer; `result` closes the run with usage and status.
    fn antigravity(&mut self, v: &Value) -> Vec<Ev> {
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match v["event"].as_str().unwrap_or("") {
            "step_update" => {
                let su = &v["step_update"];
                if su["step_type"] == "tool" && su["state"] == "ERROR" {
                    self.deny(&s(su, "tool_name"));
                }
                if su["step_type"] != "agent_response" {
                    return vec![];
                }
                let mut out = Vec::new();
                for k in ["thinking_delta", "reasoning_delta"] {
                    let t = s(su, k);
                    if !t.is_empty() {
                        out.push(Ev::Think(t));
                    }
                }
                let t = s(su, "text_delta");
                if !t.is_empty() {
                    self.saw_delta = true;
                    out.push(Ev::Text(t));
                }
                out
            }
            "result" => {
                let r = &v["result"];
                let u = &r["usage"];
                let n = |k: &str| u[k].as_u64().unwrap_or(0);
                // Session totals: a nudged session's last result covers every turn.
                self.usage.input_tokens = n("input_tokens");
                self.usage.cached_input_tokens = n("cache_read_tokens");
                self.usage.output_tokens = n("output_tokens");
                self.usage.reasoning_tokens = n("thinking_tokens");
                self.usage.total_tokens = n("total_tokens");
                self.turn_over = true;
                if s(r, "status").eq_ignore_ascii_case("error") {
                    let e = s(r, "error");
                    self.fatal = Some(if e.is_empty() { "request failed".into() } else { e });
                    return vec![];
                }
                // A run that streamed nothing still reports its answer here.
                let resp = s(r, "response");
                if !self.saw_delta && !resp.is_empty() {
                    return vec![Ev::Text(resp)];
                }
                for d in r["denied_actions"].as_array().into_iter().flatten() {
                    self.deny(d["display_name"].as_str().or(d["action"].as_str()).unwrap_or(""));
                }
                self.stalled = !self.saw_delta && resp.trim().is_empty() && !self.denied.is_empty();
                vec![]
            }
            _ => {
                if let Some(e) = v["error"].as_str() {
                    self.last_error = Some(e.to_string());
                }
                vec![]
            }
        }
    }
}

impl Decoder {
    fn deny(&mut self, tool: &str) {
        if !tool.is_empty() && !self.denied.iter().any(|d| d == tool) {
            self.denied.push(tool.to_string());
        }
    }
}

/// Follow-up turns for an agy session that stalled on its own tools.
const MAX_NUDGES: usize = 2;

/// The follow-up message: agy's own tools are off, the app's tools are the
/// `<tool_call>` ones from the instructions.
fn nudge(cli: Cli, denied: &[String]) -> String {
    let text = format!(
        "Your built-in tools ({}) are switched off in this app, and the call was denied. \
         Do not use them again. Use only the tools from my instructions, by writing a <tool_call> block, \
         or answer me in plain text.",
        denied.join(", ")
    );
    user_line(cli, &text)
}

/* ---------- Rig stream items ---------- */

/// Text → tool-call filter → Rig items on the channel.
struct Emitter {
    tx: mpsc::Sender<Item>,
    filter: ToolTagFilter,
    calls: usize,
    /// Anything (text or call) reached the consumer.
    produced: bool,
}

impl Emitter {
    fn new(tx: mpsc::Sender<Item>) -> Self {
        Self { tx, filter: ToolTagFilter::default(), calls: 0, produced: false }
    }

    /// False when the consumer is gone.
    async fn send(&mut self, ev: Ev) -> bool {
        match ev {
            Ev::Think(t) if !t.is_empty() => {
                self.tx
                    .send(Ok(RawStreamingChoice::ReasoningDelta {
                        id: MintKind::Reasoning.for_wire_index(0),
                        provider_id: None,
                        reasoning: t,
                    }))
                    .await
                    .is_ok()
            }
            Ev::Text(t) if !t.is_empty() => {
                let pieces = self.filter.push(&t);
                self.pieces(pieces).await
            }
            _ => true,
        }
    }

    async fn flush(&mut self) -> bool {
        let pieces = self.filter.finish();
        self.pieces(pieces).await
    }

    async fn pieces(&mut self, pieces: Vec<Piece>) -> bool {
        for p in pieces {
            let item = match p {
                Piece::Text(t) => RawStreamingChoice::Message(t),
                Piece::Call { name, arguments } => {
                    self.calls += 1;
                    let id = format!("call_{}_{}", self.calls, uid());
                    RawStreamingChoice::ToolCall(
                        RawStreamingToolCall::new(StreamPartId::wire(id.clone()), name, arguments).with_call_id(id),
                    )
                }
            };
            self.produced = true;
            if self.tx.send(Ok(item)).await.is_err() {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(history: Vec<Message>) -> CompletionRequest {
        CompletionRequest {
            model: None,
            preamble: Some("instructions".into()),
            chat_history: history,
            documents: vec![],
            tools: vec![],
            temperature: None,
            max_tokens: None,
            tool_choice: None,
            additional_params: None,
            output_schema: None,
            record_telemetry_content: false,
        }
    }

    /// A new run of the same chat sends only its new message; an edited
    /// earlier prompt (the chat did not grow by one) does not resume.
    #[test]
    fn chat_session_resumes_with_only_the_new_message() {
        let first = req(vec![Message::user("build it")]);
        let (tools, seen) = request_fingerprints(&first);
        let s = Session { proc: None, thread: Some("t".into()), tools, tool_defs: fingerprint(&first.tools), seen, turns: 1, totals: Usage::new() };
        // Next run: saved turns + the new prompt, with fresh instructions.
        let mut next = req(vec![Message::user("build it"), Message::assistant("done"), Message::user("now test it")]);
        next.preamble = Some("instructions, repo map changed".into());
        assert_eq!(s.resume(&next).as_deref(), Some("now test it"));
        let edited = req(vec![Message::user("build it differently")]);
        assert!(s.resume(&edited).is_none());
    }

    #[test]
    fn a_chat_has_one_session_slot_per_model() {
        let a = chat_slot("chat-x", "chat-x|Claude|opus|high");
        let b = chat_slot("chat-x", "chat-x|Claude|opus|high");
        assert!(Arc::ptr_eq(&a, &b));
        // Another model in the chat replaces it.
        let c = chat_slot("chat-x", "chat-x|Claude|sonnet|high");
        assert!(!Arc::ptr_eq(&a, &c));
        assert_eq!(CHAT_SESSIONS.lock().unwrap().iter().filter(|(k, _)| k.starts_with("chat-x|")).count(), 1);
        end_chat("chat-x");
        assert!(!CHAT_SESSIONS.lock().unwrap().iter().any(|(k, _)| k.starts_with("chat-x|")));
    }

    /// agy's real events when Gemini used its own (denied) run_command.
    #[test]
    fn agy_denied_tool_turn_is_stalled_not_empty() {
        let mut d = Decoder::new(Cli::Antigravity);
        for line in [
            r#"{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response"}}"#,
            r#"{"event":"step_update","step_update":{"step_index":2,"state":"ERROR","step_type":"tool","tool_name":"run_command"}}"#,
            r#"{"event":"result","result":{"status":"SUCCESS","response":"","usage":{"input_tokens":12036},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}"#,
        ] {
            assert!(d.feed(line).is_empty());
        }
        assert!(d.turn_over && d.stalled);
        assert_eq!(d.denied, ["run_command", "RunCommand"]);
        assert!(nudge(Cli::Antigravity, &d.denied).ends_with("}\n"));

        // An answered turn is not stalled, even with the old denial on record.
        let mut d = Decoder::new(Cli::Antigravity);
        d.feed(r#"{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"Hi"}}"#);
        d.feed(r#"{"event":"result","result":{"status":"SUCCESS","response":"Hi","denied_actions":[{"action":"command"}]}}"#);
        assert!(d.turn_over && !d.stalled);
    }
}
