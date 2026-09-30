//! [`CliModel`]: a Rig `CompletionModel` whose "HTTP call" is one headless
//! CLI process. Each request renders the Rig history into a prompt
//! (protocol.rs), starts the CLI hidden, feeds the prompt on stdin and turns
//! its JSON event stream back into Rig stream items — text and reasoning
//! deltas, tool calls from the `<tool_call>` protocol, usage and errors.
//! Dropping the stream (Stop, retry) kills the process.

use super::protocol::{self, Piece, Rendered, ToolTagFilter};
use super::{agy_model_args, ensure, scratch, tail, Cli};
use rig_agent::core::completion::message::{AssistantContent, Text};
use rig_agent::core::completion::{
    CompletionError, CompletionModel, CompletionRequest, CompletionResponse, Usage,
};
use rig_agent::core::streaming::{
    MintKind, RawStreamingChoice, RawStreamingToolCall, StreamFinal, StreamPartId,
    StreamingCompletionResponse, ToolCallDeltaContent,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

type Item = Result<RawStreamingChoice, CompletionError>;

#[derive(Clone, Debug)]
pub struct CliModel {
    cli: Cli,
    /// "default"/"" lets the CLI pick (the account's default model).
    model: String,
    /// low | medium | high
    effort: String,
}

impl CliModel {
    pub fn new(cli: Cli, model: &str, effort: &str) -> Self {
        Self { cli, model: model.trim().to_string(), effort: effort.to_string() }
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

    /// Starts the CLI and returns the Rig stream over its events.
    async fn open(&self, req: CompletionRequest) -> Result<StreamingCompletionResponse, CompletionError> {
        let fail = CompletionError::ProviderError;
        let launch = ensure(self.cli).await.map_err(fail)?;
        let rendered = protocol::render(&req);
        let agy_args = match (self.cli, self.model_arg()) {
            (Cli::Antigravity, Some(model)) => agy_model_args(&launch, model, &self.effort).await,
            _ => Vec::new(),
        };
        let job = Job::prepare(self, &rendered, &agy_args).map_err(fail)?;

        let mut cmd = launch.command();
        cmd.args(&job.args).stdin(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| fail(format!("cannot start {}: {e}", self.cli.label())))?;

        // stdin: the prompt, then EOF so the CLI starts working. agy keeps it
        // open: a turn it spent on its own (denied) tools gets a follow-up
        // message in the same session — see `Decoder::stalled`.
        let mut stdin = child.stdin.take().ok_or_else(|| fail("no stdin".into()))?;
        let input = job.stdin.clone();
        let keep_open = self.cli == Cli::Antigravity;
        let writer = tokio::spawn(async move {
            let _ = stdin.write_all(input.as_bytes()).await;
            let _ = stdin.flush().await;
            if keep_open {
                return Some(stdin);
            }
            let _ = stdin.shutdown().await;
            None
        });
        // stderr: kept for the error message when the CLI fails.
        let mut stderr = child.stderr.take().ok_or_else(|| fail("no stderr".into()))?;
        let err_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).to_string()
        });
        let stdout = child.stdout.take().ok_or_else(|| fail("no stdout".into()))?;

        let (tx, rx) = mpsc::channel::<Item>(64);
        let cli = self.cli;
        let provider = self.provider();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut state = Decoder::new(cli);
            let mut out = Emitter::new(tx.clone());
            let mut writer = Some(writer);
            let mut nudges = 0;
            loop {
                tokio::select! {
                    line = lines.next_line() => match line {
                        Ok(Some(line)) => {
                            if cfg!(test) && std::env::var_os("CLI_TRACE").is_some() {
                                eprintln!("RAW {}", line.chars().take(400).collect::<String>());
                            }
                            for ev in state.feed(&line) {
                                if !out.send(ev).await {
                                    return; // consumer gone: child is killed on drop
                                }
                            }
                            if state.turn_over {
                                state.turn_over = false;
                                // The stdin handle, once the prompt is written.
                                let mut stdin = match writer.take() {
                                    Some(w) => w.await.ok().flatten(),
                                    None => None,
                                };
                                if state.stalled && !out.produced && nudges < MAX_NUDGES {
                                    if let Some(s) = stdin.as_mut() {
                                        nudges += 1;
                                        state.stalled = false;
                                        let _ = s.write_all(nudge(&state.denied).as_bytes()).await;
                                        let _ = s.flush().await;
                                        writer = Some(tokio::spawn(async move { stdin }));
                                        continue;
                                    }
                                }
                                // Done: EOF ends the session.
                                if let Some(mut s) = stdin {
                                    let _ = s.shutdown().await;
                                }
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
            let status = child.wait().await.ok();
            let stderr = err_task.await.unwrap_or_default();
            job.cleanup();

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
            let _ = tx
                .send(Ok(RawStreamingChoice::FinalResponse(StreamFinal::new(provider, state.usage))))
                .await;
        });

        let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|x| (x, rx)) });
        Ok(StreamingCompletionResponse::stream(provider, Box::pin(stream)))
    }
}

impl CompletionModel for CliModel {
    async fn completion(&self, request: CompletionRequest) -> Result<CompletionResponse, CompletionError> {
        use futures_util::StreamExt;
        let mut stream = self.open(request).await?;
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
        self.open(request).await
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
}

impl Job {
    fn prepare(m: &CliModel, r: &Rendered, agy_args: &[String]) -> Result<Self, String> {
        let dir = scratch().join(format!("run-{}", uid()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut job = Job { args: vec![], stdin: String::new(), files: vec![dir.clone()] };
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
                    // No CLAUDE.md, hooks or settings of the user's own Claude
                    // Code: they cost tokens on every step and are not the app's.
                    "--setting-sources",
                    "",
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
                // One block per turn, the newest marked for the cache: every
                // agent step is a new process, and without the mark only the
                // system prompt was reused — each step paid the whole history
                // again (as a cache write). 1h, like Claude Code's own marks
                // (a shorter one after them is rejected).
                let mut content: Vec<Value> = r.turns.iter().map(|t| json!({ "type": "text", "text": t })).collect();
                if !r.tail.is_empty() {
                    if let Some(last) = content.last_mut() {
                        last["cache_control"] = json!({ "type": "ephemeral", "ttl": "1h" });
                    }
                }
                for img in &r.images {
                    content.push(json!({
                        "type": "image",
                        "source": { "type": "base64", "media_type": img.mime, "data": img.base64 },
                    }));
                }
                if !r.tail.is_empty() {
                    content.push(json!({ "type": "text", "text": r.tail }));
                }
                job.stdin = format!(
                    "{}\n",
                    json!({ "type": "user", "message": { "role": "user", "content": content } })
                );
            }
            Cli::Codex => {
                job.args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never"]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                // Codex's own base instructions (~3.5k tokens a call) replaced
                // by one line: the app's instructions ride in the prompt.
                let base = scratch().join("codex-base.md");
                let line = "You answer the user of the Singularity desktop app. Follow the instructions in the user's message.";
                if std::fs::read_to_string(&base).ok().as_deref() != Some(line) {
                    let _ = std::fs::write(&base, line);
                }
                if base.is_file() {
                    let p = base.display().to_string().replace('\\', "/");
                    job.args.extend(["-c".into(), format!("model_instructions_file=\"{p}\"")]);
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
                // The app's lean agent: no agy prompt sections, no built-in tools.
                if super::ensure_agy_agent().is_ok() {
                    job.args.extend(["--agent".into(), super::AGY_AGENT.into()]);
                }
                // `--model` (and `--effort` when needed), picked in `open`.
                job.args.extend(agy_args.iter().cloned());
                job.args.extend(["-p".into(), String::new()]);
                let mut text = with_system(r);
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

    fn cleanup(&self) {
        for f in &self.files {
            let _ = std::fs::remove_dir_all(f);
        }
    }
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
    /// agy: a turn just ended (its `result` arrived).
    turn_over: bool,
    /// agy: the turn ended with no answer after its own tools were denied —
    /// headless print mode auto-denies them and reports SUCCESS with an
    /// empty response.
    stalled: bool,
    /// agy: its own tools that were denied (RunCommand, …).
    denied: Vec<String>,
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
fn nudge(denied: &[String]) -> String {
    let text = format!(
        "Your built-in tools ({}) are switched off in this app, and the call was denied. \
         Do not use them again. Use only the tools from my instructions, by writing a <tool_call> block, \
         or answer me in plain text.",
        denied.join(", ")
    );
    format!("{}\n", json!({ "event": "user", "message": { "role": "user", "content": [{ "type": "text", "text": text }] } }))
}

/* ---------- Rig stream items ---------- */

/// The tool name of a call whose JSON is still being written.
fn call_name(body: &str) -> Option<String> {
    let at = body.find("\"name\"")? + 6;
    let rest = body[at..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string()).filter(|n| !n.is_empty())
}

/// Text → tool-call filter → Rig items on the channel.
struct Emitter {
    tx: mpsc::Sender<Item>,
    filter: ToolTagFilter,
    calls: usize,
    /// Anything (text or call) reached the consumer.
    produced: bool,
    /// The call being written: its id, its text so far, whether its name
    /// went out. Its deltas and the finished call share the id, so Rig
    /// keeps them one call (one card).
    open: Option<(String, String, bool)>,
}

impl Emitter {
    fn new(tx: mpsc::Sender<Item>) -> Self {
        Self { tx, filter: ToolTagFilter::default(), calls: 0, produced: false, open: None }
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
                Piece::CallDelta(fragment) => {
                    if self.open.is_none() {
                        self.calls += 1;
                        self.open = Some((format!("call_{}_{}", self.calls, uid()), String::new(), false));
                    }
                    let Some((id, body, named)) = self.open.as_mut() else { continue };
                    body.push_str(&fragment);
                    let wire = StreamPartId::wire(id.clone());
                    if !*named {
                        if let Some(name) = call_name(body) {
                            *named = true;
                            let item = RawStreamingChoice::ToolCallDelta { id: wire.clone(), content: ToolCallDeltaContent::Name(name) };
                            if self.tx.send(Ok(item)).await.is_err() {
                                return false;
                            }
                        }
                    }
                    RawStreamingChoice::ToolCallDelta { id: wire, content: ToolCallDeltaContent::Delta(fragment) }
                }
                Piece::Call { name, arguments } => {
                    let id = match self.open.take() {
                        Some((id, _, _)) => id,
                        None => {
                            self.calls += 1;
                            format!("call_{}_{}", self.calls, uid())
                        }
                    };
                    RawStreamingChoice::ToolCall(
                        RawStreamingToolCall::new(StreamPartId::wire(id.clone()), name, arguments).with_call_id(id),
                    )
                }
            };
            if matches!(item, RawStreamingChoice::Message(_)) {
                // A call that did not parse came back as text: it is over.
                self.open = None;
            }
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
        assert!(nudge(&d.denied).ends_with("}\n"));

        // An answered turn is not stalled, even with the old denial on record.
        let mut d = Decoder::new(Cli::Antigravity);
        d.feed(r#"{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"Hi"}}"#);
        d.feed(r#"{"event":"result","result":{"status":"SUCCESS","response":"Hi","denied_actions":[{"action":"command"}]}}"#);
        assert!(d.turn_over && !d.stalled);
    }
}
