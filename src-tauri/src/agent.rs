/// Agent loop — lets the model actually do work, not just talk.
///
/// The loop is provider-agnostic on the outside and protocol-specific on the
/// inside: each round asks the model for the next step, and if it requests
/// tools, they run here and their output is fed back as the next turn. Text the
/// model emits along the way is streamed to the UI immediately, so a long task
/// shows progress instead of going silent until it finishes.
///
/// Two wire protocols are supported because they cover every provider the app
/// can talk to: OpenAI-style `tool_calls` (OpenAI, DeepSeek, vLLM, LM Studio…)
/// and Anthropic's `tool_use` content blocks.
use crate::tools;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

/* ---------- Command approval ---------- */

/// Pending approval requests, keyed by run id. The agent loop inserts a oneshot
/// sender before asking the UI, then awaits it; `agent_confirm` feeds the answer
/// back in. Dropped senders (window closed) resolve as "denied".
static PENDING: Mutex<Option<HashMap<String, oneshot::Sender<bool>>>> = Mutex::new(None);

fn pending() -> &'static Mutex<Option<HashMap<String, oneshot::Sender<bool>>>> {
    &PENDING
}

/// Called by the `agent_confirm` command with the user's decision.
pub fn resolve_confirm(run_id: &str, approve: bool) {
    if let Some(map) = pending().lock().unwrap().as_mut() {
        if let Some(tx) = map.remove(run_id) {
            let _ = tx.send(approve);
        }
    }
}

/// Asks the UI to approve a command and waits for the answer.
async fn ask_confirm(app: &AppHandle, run_id: &str, command: &str, cwd: &str) -> bool {
    let (tx, rx) = oneshot::channel();
    {
        let mut guard = pending().lock().unwrap();
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(run_id.to_string(), tx);
    }
    let _ = app.emit(
        "agent://confirm",
        json!({ "run_id": run_id, "command": command, "cwd": cwd }),
    );
    // A dropped sender (app closed) reads as denial — safe default.
    rx.await.unwrap_or(false)
}

/// Upper bound on model→tool→model rounds, so a confused model cannot spin.
const MAX_STEPS: usize = 24;

/* ---------- Events ---------- */

#[derive(Debug, Clone, Serialize)]
pub struct AgentText {
    pub run_id: String,
    pub delta: String,
}

/// Reasoning the model streams separately from its answer (DeepSeek "think"
/// mode, Anthropic extended thinking, OpenAI o-series). Shown in its own
/// collapsible block so it never pollutes the reply.
#[derive(Debug, Clone, Serialize)]
pub struct AgentThink {
    pub run_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentStep {
    pub run_id: String,
    /// Tool name, e.g. `read_file`.
    pub name: String,
    /// One-line summary of the arguments.
    pub input: String,
    pub result: String,
    pub ok: bool,
    /// 1-based index of this step within the run.
    pub index: usize,
    /// False while the tool is still running, true once the result is in. The UI
    /// shows the card as soon as it starts, so a long command is visible.
    pub done: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentDone {
    pub run_id: String,
    pub steps: usize,
    pub answer: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentError {
    pub run_id: String,
    pub message: String,
}

/* ---------- Tool schema exposed to the model ---------- */

/// Tool definitions in a neutral shape, converted per protocol when sent.
fn tool_specs() -> Value {
    json!([
        {
            "name": "read_file",
            "description": "Read a text file. Returns the contents with line numbers. Use start_line/end_line for large files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path — absolute or relative to the workspace." },
                    "start_line": { "type": "integer", "description": "First line to return (1-based)." },
                    "end_line": { "type": "integer", "description": "Last line to return." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "write_file",
            "description": "Create or overwrite a file with the given content. Parent directories are created automatically.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path — absolute or relative to the workspace." },
                    "content": { "type": "string", "description": "Full file content." }
                },
                "required": ["path", "content"]
            }
        },
        {
            "name": "edit_file",
            "description": "Replace an exact string in a file. The search text must appear exactly once — include surrounding lines to make it unique.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path — absolute or relative to the workspace." },
                    "old_text": { "type": "string", "description": "Exact text to replace." },
                    "new_text": { "type": "string", "description": "Replacement text." }
                },
                "required": ["path", "old_text", "new_text"]
            }
        },
        {
            "name": "list_dir",
            "description": "List the entries of a directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory path — absolute or relative, or \"\" for the workspace root." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "grep",
            "description": "Search for a literal string across files. Returns matching lines with file paths and line numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Text to find." },
                    "path": { "type": "string", "description": "Optional directory to search in — absolute or relative." }
                },
                "required": ["pattern"]
            }
        },
        {
            "name": "run_command",
            "description": "Run a shell command and return its combined output and exit code. Use for builds, tests and git. On Windows this runs through cmd, elsewhere through sh.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Command line to execute." },
                    "cwd": { "type": "string", "description": "Optional working directory as an absolute path. Defaults to the workspace." },
                    "timeout_secs": { "type": "integer", "description": "Optional timeout, default 120." }
                },
                "required": ["command"]
            }
        }
    ])
}

/// Default system prompt — tells the model it can act, not just answer.
fn default_system() -> String {
    "You are Singularity, a coding agent inside a desktop app running on the user's own \
     computer.\n\
     You have tools that act on the real filesystem: read_file, write_file, edit_file, \
     list_dir, grep and run_command.\n\
     You can work anywhere on this machine, not only inside the workspace. Pass absolute \
     paths (for example C:\\Users\\name\\Documents\\GitHub\\proj\\src\\main.rs) to read_file, \
     write_file, edit_file, list_dir and grep, and pass `cwd` to run_command to execute in \
     another folder. The workspace root is only the default for relative paths.\n\
     Never tell the user to run a command themselves when run_command can do it. Never say \
     you lack access to a path without actually calling a tool on it — you do have access, \
     so read the real files instead of guessing.\n\
     Work step by step: look at the actual files before changing them, keep edits small and \
     exact, and run the build or tests when that helps.\n\
     Prefer doing the work over describing it. When you are done, give a short summary of \
     what changed."
        .to_string()
}

/* ---------- Public entry point ---------- */

#[derive(Debug, Clone, Deserialize)]
pub struct AgentRequest {
    pub kind: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    /// Kept for parity with the chat request shape; the agent authenticates the
    /// same way (`bearer` for OpenAI-shaped APIs, `x-api-key` for Anthropic).
    #[serde(default = "default_auth")]
    #[allow(dead_code)]
    pub auth: String,
    pub model: String,
    #[serde(default)]
    pub system: String,
    /// Workspace root the tools operate inside.
    pub workspace: String,
    /// `low`, `medium`, `high` — reasoning depth where the provider supports it.
    #[serde(default)]
    pub effort: String,
    /// Run commands without asking. False = every `run_command` needs the
    /// user's approval through the `agent://confirm` event.
    #[serde(default)]
    pub auto_run: bool,
    /// Images attached to the last user turn.
    #[serde(default)]
    pub images: Vec<crate::chat::ImageAttachment>,
}

fn default_auth() -> String {
    "key".to_string()
}

/// Runs the agent loop, streaming text and reporting each tool call.
pub async fn run_agent(
    app: AppHandle,
    run_id: String,
    req: AgentRequest,
    turns: Vec<super::chat::ChatTurn>,
) -> Result<(), String> {
    let root = Path::new(&req.workspace).to_path_buf();
    if !root.is_dir() {
        let msg = format!("workspace is not a directory: {}", req.workspace);
        let _ = app.emit(
            "agent://error",
            AgentError {
                run_id,
                message: msg.clone(),
            },
        );
        return Err(msg);
    }

    let system = if req.system.trim().is_empty() {
        default_system()
    } else {
        req.system.clone()
    };

    let result = match req.kind.as_str() {
        "anthropic-messages" => run_anthropic(&app, &run_id, &req, &system, &root, turns).await,
        // Google and everything OpenAI-shaped use the tool_calls protocol here.
        _ => run_openai(&app, &run_id, &req, &system, &root, turns).await,
    };

    match result {
        Ok(answer) => {
            let _ = app.emit(
                "agent://done",
                AgentDone {
                    run_id,
                    steps: 0,
                    answer,
                },
            );
            Ok(())
        }
        Err(e) => {
            let _ = app.emit(
                "agent://error",
                AgentError {
                    run_id,
                    message: e.clone(),
                },
            );
            Err(e)
        }
    }
}

fn emit_text(app: &AppHandle, run_id: &str, delta: impl Into<String>) {
    let _ = app.emit(
        "agent://text",
        AgentText {
            run_id: run_id.to_string(),
            delta: delta.into(),
        },
    );
}

fn emit_think(app: &AppHandle, run_id: &str, delta: impl Into<String>) {
    let _ = app.emit(
        "agent://think",
        AgentThink {
            run_id: run_id.to_string(),
            delta: delta.into(),
        },
    );
}

/// Emits a step. `done=false` marks "this tool just started" so the UI shows the
/// card immediately; `done=true` carries the result.
fn emit_step(app: &AppHandle, run_id: &str, index: usize, name: &str, input: String, done: bool, res: &tools::ToolResult) {
    let _ = app.emit(
        "agent://step",
        AgentStep {
            run_id: run_id.to_string(),
            name: name.to_string(),
            input,
            result: res.output.clone(),
            ok: res.ok,
            index,
            done,
        },
    );
}

/// Short, human-readable rendering of a tool's arguments for the UI.
fn summarize(name: &str, args: &Value) -> String {
    let get = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("");
    match name {
        "run_command" => get("command").to_string(),
        "read_file" => {
            let s = get("start_line");
            let e = get("end_line");
            if s.is_empty() && e.is_empty() {
                get("path").to_string()
            } else {
                format!("{} ({}–{})", get("path"), s, e)
            }
        }
        "grep" => format!("\"{}\" in {}", get("pattern"), if get("path").is_empty() { "." } else { get("path") }),
        "write_file" => format!("{} ({} bytes)", get("path"), get("content").len()),
        _ => get("path").to_string(),
    }
}

/* ---------- OpenAI tool_calls protocol ---------- */

#[derive(Deserialize)]
struct ToolCallDelta {
    index: Option<usize>,
    id: Option<String>,
    function: Option<FunctionDelta>,
}

#[derive(Deserialize)]
struct FunctionDelta {
    name: Option<String>,
    arguments: Option<String>,
}

#[derive(Deserialize)]
struct StreamChoice {
    delta: Option<StreamDelta>,
    #[serde(rename = "finish_reason")]
    _finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct StreamDelta {
    content: Option<String>,
    /// DeepSeek and OpenAI o-series stream reasoning separately from content.
    reasoning_content: Option<String>,
    reasoning: Option<String>,
    tool_calls: Option<Vec<ToolCallDelta>>,
}

#[derive(Deserialize)]
struct StreamChunk {
    choices: Option<Vec<StreamChoice>>,
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct ApiError {
    message: Option<String>,
}

/// One accumulated tool call. Arguments arrive split across chunks.
#[derive(Default, Clone)]
struct PendingCall {
    id: String,
    name: String,
    args: String,
}

async fn run_openai(
    app: &AppHandle,
    run_id: &str,
    req: &AgentRequest,
    system: &str,
    root: &Path,
    turns: Vec<super::chat::ChatTurn>,
) -> Result<String, String> {
    let base = req.base_url.trim_end_matches('/');
    let url = if req.kind == "ollama" {
        format!("{base}/api/chat")
    } else {
        format!("{base}/chat/completions")
    };

    // Conversation state grows as tools run.
    let mut messages: Vec<Value> = vec![json!({ "role": "system", "content": system })];
    // Images attach to the final user turn as OpenAI-style image_url parts.
    let last_user = turns
        .iter()
        .rposition(|t| t.role != "agent" && t.role != "assistant");
    for (i, t) in turns.iter().enumerate() {
        let role = if t.role == "agent" || t.role == "assistant" {
            "assistant"
        } else {
            "user"
        };
        if Some(i) == last_user && !req.images.is_empty() {
            let mut parts = vec![json!({ "type": "text", "text": t.text })];
            for img in &req.images {
                parts.push(json!({
                    "type": "image_url",
                    "image_url": { "url": img.data_url }
                }));
            }
            messages.push(json!({ "role": role, "content": parts }));
        } else {
            messages.push(json!({ "role": role, "content": t.text }));
        }
    }

    let client = reqwest::Client::new();
    let mut final_text = String::new();
    let mut step_index = 0usize;

    for _ in 0..MAX_STEPS {
        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "tools": tool_specs().as_array().map(|specs| {
                specs.iter().map(|s| json!({
                    "type": "function",
                    "function": {
                        "name": s["name"],
                        "description": s["description"],
                        "parameters": s["parameters"],
                    }
                })).collect::<Vec<_>>()
            }),
            "stream": true,
        });
        // Reasoning effort, only when the user picked a non-default level.
        if let Some(eff) = crate::chat::reasoning_effort(&req.effort) {
            body["reasoning_effort"] = json!(eff);
        }

        let mut request = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body);
        if !req.api_key.trim().is_empty() {
            request = request.bearer_auth(req.api_key.trim());
        }

        let res = request.send().await.map_err(|e| format!("request failed: {e}"))?;
        let status = res.status();
        if !status.is_success() {
            let detail = res.text().await.unwrap_or_default();
            return Err(format!("provider returned {status}: {detail}"));
        }

        // Parse the stream, collecting text and any tool calls.
        let mut stream = res.bytes_stream();
        let mut buf = String::new();
        let mut calls: Vec<PendingCall> = Vec::new();
        let mut round_text = String::new();

        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| format!("stream error: {e}"))?;
            buf.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(idx) = buf.find('\n') {
                let line = buf[..idx].trim().to_string();
                buf.drain(..idx + 1);
                let Some(data) = line.strip_prefix("data: ").unwrap_or(&line).trim().into() else {
                    continue;
                };
                if data == "[DONE]" || data.is_empty() {
                    continue;
                }
                let Ok(parsed) = serde_json::from_str::<StreamChunk>(data) else {
                    continue;
                };
                if let Some(err) = parsed.error {
                    return Err(err.message.unwrap_or_else(|| "provider error".into()));
                }
                let Some(choices) = parsed.choices else { continue };
                for choice in choices {
                    let Some(delta) = choice.delta else { continue };
                    // Reasoning streams separately from the answer on DeepSeek
                    // and o-series models. It is shown in its own block and is
                    // deliberately kept out of `round_text`, so it never becomes
                    // part of what gets stored as the reply.
                    if let Some(think) = delta
                        .reasoning_content
                        .as_deref()
                        .or(delta.reasoning.as_deref())
                    {
                        if !think.is_empty() {
                            emit_think(app, run_id, think);
                        }
                    }
                    if let Some(text) = delta.content {
                        if !text.is_empty() {
                            round_text.push_str(&text);
                            emit_text(app, run_id, text);
                        }
                    }
                    // Tool call arguments stream in pieces, keyed by index.
                    if let Some(partials) = delta.tool_calls {
                        for p in partials {
                            let i = p.index.unwrap_or(calls.len());
                            while calls.len() <= i {
                                calls.push(PendingCall::default());
                            }
                            if let Some(id) = p.id {
                                calls[i].id = id;
                            }
                            if let Some(f) = p.function {
                                if let Some(n) = f.name {
                                    calls[i].name.push_str(&n);
                                }
                                if let Some(a) = f.arguments {
                                    calls[i].args.push_str(&a);
                                }
                            }
                        }
                    }
                }
            }
        }

        final_text.push_str(&round_text);

        // No tools requested — the model is done.
        if calls.iter().all(|c| c.name.is_empty()) {
            return Ok(final_text);
        }

        // Record the assistant turn that asked for the tools.
        let assistant_calls: Vec<Value> = calls
            .iter()
            .filter(|c| !c.name.is_empty())
            .map(|c| {
                json!({
                    "id": c.id,
                    "type": "function",
                    "function": { "name": c.name, "arguments": c.args }
                })
            })
            .collect();
        messages.push(json!({
            "role": "assistant",
            "content": if round_text.is_empty() { Value::Null } else { json!(round_text) },
            "tool_calls": assistant_calls,
        }));

        // Run each tool and feed the results back. The step event carries the
        // call, so the UI can place it inline — do not inject it into the text.
        for call in calls.iter().filter(|c| !c.name.is_empty()) {
            let args: Value = serde_json::from_str(&call.args).unwrap_or(json!({}));
            let summary = summarize(&call.name, &args);

            step_index += 1;
            let this_index = step_index;

            // Announce the call BEFORE it runs, so a long command is visible
            // instead of leaving the UI on "Generating…" with no output.
            emit_step(
                app,
                run_id,
                this_index,
                &call.name,
                summary.clone(),
                false,
                &tools::ToolResult::ok(""),
            );

            // Permission gate: unless the project runs commands automatically,
            // `run_command` waits for the user's Allow/Deny in the UI.
            let denied = if !req.auto_run && call.name == "run_command" {
                let cmd = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
                let cwd = args
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .unwrap_or(req.workspace.as_str());
                !ask_confirm(app, run_id, cmd, cwd).await
            } else {
                false
            };

            // Tools block (file IO, waiting on a process). Running them on the
            // async worker thread stalls the whole task and starves event
            // delivery, so hand them to the blocking pool and await the result.
            let tool_root = root.to_path_buf();
            let tool_name = call.name.clone();
            let tool_args = args.clone();
            let result = if denied {
                tools::ToolResult::err(
                    "The user denied this command. Do not retry it — continue without it.",
                )
            } else {
                tokio::task::spawn_blocking(move || {
                    tools::dispatch(&tool_root, &tool_name, &tool_args)
                })
                .await
                .unwrap_or_else(|e| tools::ToolResult {
                    ok: false,
                    output: format!("tool task failed: {e}"),
                })
            };

            emit_step(app, run_id, this_index, &call.name, summary, true, &result);

            messages.push(json!({
                "role": "tool",
                "tool_call_id": call.id,
                "content": result.output,
            }));
        }
    }

    Err(format!("stopped after {MAX_STEPS} steps without finishing"))
}

/* ---------- Anthropic tool_use protocol ---------- */

#[derive(Deserialize)]
struct AnthropicStreamEvent {
    #[serde(rename = "type")]
    kind: Option<String>,
    index: Option<usize>,
    content_block: Option<AnthropicBlock>,
    delta: Option<AnthropicStreamDelta>,
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct AnthropicBlock {
    #[serde(rename = "type")]
    kind: Option<String>,
    id: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicStreamDelta {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
    partial_json: Option<String>,
    /// Extended thinking arrives as `thinking_delta` with the text here.
    thinking: Option<String>,
}

async fn run_anthropic(
    app: &AppHandle,
    run_id: &str,
    req: &AgentRequest,
    system: &str,
    root: &Path,
    turns: Vec<super::chat::ChatTurn>,
) -> Result<String, String> {
    let base = req.base_url.trim_end_matches('/');
    let url = format!("{base}/messages");

    // Images attach to the final user turn as Anthropic image blocks.
    let last_user = turns
        .iter()
        .rposition(|t| t.role != "agent" && t.role != "assistant");
    let mut messages: Vec<Value> = turns
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let role = if t.role == "agent" || t.role == "assistant" {
                "assistant"
            } else {
                "user"
            };
            if Some(i) == last_user && !req.images.is_empty() {
                let mut parts = vec![json!({ "type": "text", "text": t.text })];
                for img in &req.images {
                    parts.push(json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": img.mime,
                            "data": crate::chat::base64_body(&img.data_url),
                        }
                    }));
                }
                json!({ "role": role, "content": parts })
            } else {
                json!({ "role": role, "content": t.text })
            }
        })
        .collect();

    let client = reqwest::Client::new();
    let mut final_text = String::new();
    let mut step_index = 0usize;

    // Anthropic requires max_tokens to exceed the thinking budget.
    let thinking_budget = match req.effort.as_str() {
        "low" => None,
        "high" => Some(8192u32),
        _ => Some(2048u32),
    };
    let max_tokens = match thinking_budget {
        Some(b) => b.max(4096) + 2048,
        None => 4096,
    };

    for _ in 0..MAX_STEPS {
        let mut body = json!({
            "model": req.model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
            "tools": tool_specs().as_array().map(|specs| {
                specs.iter().map(|s| json!({
                    "name": s["name"],
                    "description": s["description"],
                    "input_schema": s["parameters"],
                })).collect::<Vec<_>>()
            }),
            "stream": true,
        });
        if let Some(budget) = thinking_budget {
            body["thinking"] = json!({ "type": "enabled", "budget_tokens": budget });
        }

        let mut request = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("anthropic-version", "2023-06-01")
            .json(&body);
        if !req.api_key.trim().is_empty() {
            request = request.header("x-api-key", req.api_key.trim());
        }

        let res = request.send().await.map_err(|e| format!("request failed: {e}"))?;
        let status = res.status();
        if !status.is_success() {
            let detail = res.text().await.unwrap_or_default();
            return Err(format!("Anthropic returned {status}: {detail}"));
        }

        let mut stream = res.bytes_stream();
        let mut buf = String::new();
        let mut round_text = String::new();
        // Tool inputs stream as partial JSON keyed by content-block index.
        let mut blocks: Vec<PendingCall> = Vec::new();

        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| format!("stream error: {e}"))?;
            buf.push_str(&String::from_utf8_lossy(&bytes));

            while let Some(idx) = buf.find('\n') {
                let line = buf[..idx].trim().to_string();
                buf.drain(..idx + 1);
                let Some(data) = line.strip_prefix("data: ") else {
                    continue;
                };
                let Ok(parsed) = serde_json::from_str::<AnthropicStreamEvent>(data) else {
                    continue;
                };
                if let Some(err) = parsed.error {
                    return Err(err.message.unwrap_or_else(|| "provider error".into()));
                }

                match parsed.kind.as_deref() {
                    // A tool_use block opens with its name and id.
                    Some("content_block_start") => {
                        if let Some(block) = parsed.content_block {
                            if block.kind.as_deref() == Some("tool_use") {
                                let i = parsed.index.unwrap_or(blocks.len());
                                while blocks.len() <= i {
                                    blocks.push(PendingCall::default());
                                }
                                blocks[i].id = block.id.unwrap_or_default();
                                blocks[i].name = block.name.unwrap_or_default();
                            }
                        }
                    }
                    Some("content_block_delta") => {
                        if let Some(d) = parsed.delta {
                            match d.kind.as_deref() {
                                Some("text_delta") => {
                                    if let Some(text) = d.text {
                                        if !text.is_empty() {
                                            round_text.push_str(&text);
                                            emit_text(app, run_id, text);
                                        }
                                    }
                                }
                                // Extended thinking — displayed separately, never
                                // stored as part of the answer.
                                Some("thinking_delta") => {
                                    if let Some(think) = d.thinking {
                                        if !think.is_empty() {
                                            emit_think(app, run_id, think);
                                        }
                                    }
                                }
                                Some("input_json_delta") => {
                                    if let Some(json) = d.partial_json {
                                        let i = parsed.index.unwrap_or(0);
                                        while blocks.len() <= i {
                                            blocks.push(PendingCall::default());
                                        }
                                        blocks[i].args.push_str(&json);
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        final_text.push_str(&round_text);

        let used = blocks.iter().filter(|b| !b.name.is_empty()).collect::<Vec<_>>();
        if used.is_empty() {
            return Ok(final_text);
        }

        // The assistant turn carries the tool_use blocks it requested.
        let assistant_content: Vec<Value> = used
            .iter()
            .map(|b| {
                json!({
                    "type": "tool_use",
                    "id": b.id,
                    "name": b.name,
                    "input": serde_json::from_str::<Value>(&b.args).unwrap_or(json!({})),
                })
            })
            .collect();
        messages.push(json!({ "role": "assistant", "content": assistant_content }));

        // Results come back as tool_result blocks in a single user turn.
        let mut results: Vec<Value> = Vec::new();
        for b in &used {
            let args: Value = serde_json::from_str(&b.args).unwrap_or(json!({}));
            let summary = summarize(&b.name, &args);

            step_index += 1;
            let this_index = step_index;

            // Show the call before it runs, so long commands are visible.
            emit_step(
                app,
                run_id,
                this_index,
                &b.name,
                summary.clone(),
                false,
                &tools::ToolResult::ok(""),
            );

            // Permission gate: same as the OpenAI branch — commands wait for
            // the user unless the project runs them automatically.
            let denied = if !req.auto_run && b.name == "run_command" {
                let cmd = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
                let cwd = args
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .unwrap_or(req.workspace.as_str());
                !ask_confirm(app, run_id, cmd, cwd).await
            } else {
                false
            };

            // Tools block; keep the async worker free so events keep flowing.
            let tool_root = root.to_path_buf();
            let tool_name = b.name.clone();
            let tool_args = args.clone();
            let result = if denied {
                tools::ToolResult::err(
                    "The user denied this command. Do not retry it — continue without it.",
                )
            } else {
                tokio::task::spawn_blocking(move || {
                    tools::dispatch(&tool_root, &tool_name, &tool_args)
                })
                .await
                .unwrap_or_else(|e| tools::ToolResult {
                    ok: false,
                    output: format!("tool task failed: {e}"),
                })
            };

            emit_step(app, run_id, this_index, &b.name, summary, true, &result);

            results.push(json!({
                "type": "tool_result",
                "tool_use_id": b.id,
                "content": result.output,
                "is_error": !result.ok,
            }));
        }
        messages.push(json!({ "role": "user", "content": results }));
    }

    Err(format!("stopped after {MAX_STEPS} steps without finishing"))
}