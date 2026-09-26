//! Agent loop - lets the model actually do work, not just talk.
//!
//! This file is the shared spine: events, cancellation, the approval gate,
//! the public entry point and the protocol dispatch. The heavy parts live in
//! the agent/ submodules:
//!   prompt     - tool schema + system prompt + call summaries
//!   planner    - decompose a request into subtasks
//!   decompose  - parallel subtask execution + merge round
//!   openai     - OpenAI-compatible tool_calls loop
//!   anthropic  - Anthropic tool_use loop
//!   context    - token-budget pruning of the outgoing history
//!   guard      - stuck-loop detection and nudges

mod anthropic;
mod context;
mod decompose;
mod guard;
mod openai;
mod planner;
mod prompt;

pub use openai::OpenAiUsage;

use crate::tools;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

/* ---------- Cancellation ---------- */

/// Result for a run the user stopped: an error so the UI shows "stopped",
/// but the text already streamed to the UI stays visible in the message.
fn cancelled_result(final_text: String) -> Result<String, String> {
    Err(if final_text.trim().is_empty() {
        crate::cancel::STOPPED.to_string()
    } else {
        format!("{} — partial answer kept:\n\n{final_text}", crate::cancel::STOPPED)
    })
}

fn is_cancelled(run_id: &str) -> bool {
    crate::cancel::is_requested(run_id)
}

/// Pushes aggregated token usage to the Debug HUD (agent://usage).
fn emit_usage(app: &AppHandle, u: &RunUsage) {
    let _ = app.emit("agent://usage", u);
}

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
    // The banner is answered — a later reload must not resurrect it.
    crate::runs::drop_confirms(run_id);
    if let Some(map) = pending().lock().unwrap().as_mut() {
        if let Some(tx) = map.remove(run_id) {
            let _ = tx.send(approve);
        }
    }
}

/// Asks the UI to approve a command and waits for the answer. Returns as soon
/// as the user decides — or as soon as the run is stopped, so a Stop pressed
/// while the Allow/Deny banner is up does not hang the loop.
async fn ask_confirm(app: &AppHandle, run_id: &str, command: &str, cwd: &str) -> bool {
    let (tx, rx) = oneshot::channel();
    {
        let mut guard = pending().lock().unwrap();
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(run_id.to_string(), tx);
    }
    // Buffered: a WebView reload while the banner is up must be able to
    // re-show it — otherwise the run waits forever for an answer nobody sees.
    crate::runs::push_event(
        run_id,
        crate::runs::RunEvent::Confirm {
            command: command.to_string(),
            cwd: cwd.to_string(),
        },
    );
    let _ = app.emit(
        "agent://confirm",
        json!({ "run_id": run_id, "command": command, "cwd": cwd }),
    );

    // Wait on the answer, but keep an eye on cancellation so Stop unblocks us.
    let mut rx = std::pin::pin!(rx);
    loop {
        tokio::select! {
            res = &mut rx => {
                // A dropped sender (app closed) reads as denial — safe default.
                return res.unwrap_or(false);
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(150)) => {
                if is_cancelled(run_id) {
                    // Remove our sender so a late decision is ignored.
                    resolve_confirm(run_id, false);
                    return false;
                }
            }
        }
    }
}

/// Upper bound on model→tool→model rounds. Big enough for a real project
/// (the old 64 cut off legitimate long runs), while the repeat guard and the
/// failure-streak nudge stop pathological loops long before this.
const MAX_STEPS: usize = 128;

/// Rounds before MAX_STEPS where the model is told to wrap up: no new tools,
/// write the final summary now. The run must not be cut off mid-project at the
/// step limit — this gives the model a graceful exit and the user a real answer.
pub(super) const WRAP_UP_AT: usize = MAX_STEPS - 4;

/// The wrap-up instruction injected near the step budget.
fn wrap_up_nudge(remaining: usize) -> String {
    format!(
        "SYSTEM: you are near the tool-round budget — {remaining} round(s) left. STOP starting new work. Use the remaining rounds only to finish and TEST what is in progress, then give your final summary of exactly what you completed and what is left. Do NOT call more tools once the work is in a stable state."
    )
}

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
    /// File changed by a write/edit, with before/after content for the Changes panel.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_text: Option<String>,
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

/// Dispatches to the provider's protocol loop (used by both the plain and
/// decomposed paths).
async fn run_protocol(
    app: &AppHandle,
    run_id: &str,
    req: &AgentRequest,
    system: &str,
    root: &Path,
    turns: Vec<crate::chat::ChatTurn>,
) -> Result<String, String> {
    run_protocol_from(app, run_id, req, system, root, turns, 0).await
}

/// Same as run_protocol, but step events start from step_index_start — the
/// merge round of a decomposed run continues numbering after the subtask
/// steps so the two never collide in the transcript.
async fn run_protocol_from(
    app: &AppHandle,
    run_id: &str,
    req: &AgentRequest,
    system: &str,
    root: &Path,
    turns: Vec<crate::chat::ChatTurn>,
    step_index_start: usize,
) -> Result<String, String> {
    match req.kind.as_str() {
        "anthropic-messages" => anthropic::run_anthropic(app, run_id, req, system, root, turns, step_index_start).await,
        _ => openai::run_openai(app, run_id, req, system, root, turns, step_index_start).await,
    }
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
    /// Saved SSH units the project may use (name + host only — credentials
    /// stay in the database; the ssh_exec tool resolves them server-side).
    #[serde(default)]
    pub ssh_units: Vec<SshUnitRef>,
    /// Stable provider id — the key the limiter budgets requests under.
    #[serde(default)]
    pub provider_id: String,
    /// Max requests/minute for this provider (0 = unlimited).
    #[serde(default)]
    pub rate_limit_rpm: usize,
    /// Max parallel in-flight requests (0 = unlimited).
    #[serde(default)]
    pub concurrency: usize,
    /// Decompose the user's prompt into parallel subtasks (Task list) before
    /// executing. Off by default; the prompt box toggles it per message.
    #[serde(default)]
    pub decompose: bool,
}

/// What the model needs to see about an SSH unit: a name to pick and the
/// host for context. No credentials ever cross into the prompt.
#[derive(Debug, Clone, Deserialize)]
pub struct SshUnitRef {
    pub name: String,
    #[serde(default)]
    pub host: String,
    /// Server row id — ssh_exec maps name → id with this.
    #[serde(default)]
    pub id: String,
}

fn default_auth() -> String {
    "key".to_string()
}

/// Runs the agent loop, streaming text and reporting each tool call.
pub async fn run_agent(
    app: AppHandle,
    run_id: String,
    req: AgentRequest,
    turns: Vec<crate::chat::ChatTurn>,
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
        prompt::default_system()
    } else {
        req.system.clone()
    };

    // A stale stop request must never kill a fresh run that reuses the id.
    crate::cancel::clear(&run_id);

    // Decomposition (opt-in per message): plan → parallel subtasks → merge.
    // Falls back to the plain single loop when the prompt is too simple.
    let result = if req.decompose {
        decompose::run_decomposed(&app, &run_id, &req, &system, &root, turns).await
    } else {
        run_protocol(&app, &run_id, &req, &system, &root, turns).await
    };

    crate::cancel::clear(&run_id);

    match result {
        Ok(answer) => {
            // Buffered BEFORE the run is unregistered: a reload landing right
            // now must still see the final answer in the retention window.
            crate::runs::push_event(&run_id, crate::runs::RunEvent::Done { answer: answer.clone() });
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
            crate::runs::push_event(&run_id, crate::runs::RunEvent::Error { message: e.clone() });
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

/// Injects the wrap-up nudge into a message list. Anthropic requires strict
/// role alternation, so there the nudge is merged INTO the trailing user turn
/// instead of adding a second one; the OpenAI shape just appends.
fn inject_wrap_up(messages: &mut Vec<Value>, anthropic: bool) {
    let nudge = wrap_up_nudge(MAX_STEPS - WRAP_UP_AT);
    if anthropic {
        if let Some(last) = messages.last_mut() {
            if last.get("role").and_then(|v| v.as_str()) == Some("user") {
                match last.get("content").cloned() {
                    Some(Value::Array(mut parts)) => {
                        parts.push(json!({ "type": "text", "text": nudge }));
                        last["content"] = Value::Array(parts);
                        return;
                    }
                    Some(Value::String(s)) => {
                        last["content"] = json!([{ "type": "text", "text": s }, { "type": "text", "text": nudge }]);
                        return;
                    }
                    _ => {}
                }
            }
        }
    }
    messages.push(json!({ "role": "user", "content": nudge }));
}

fn emit_text(app: &AppHandle, run_id: &str, delta: impl Into<String>) {
    let delta = delta.into();
    // Buffered so a WebView reload mid-run can rebuild the transcript.
    crate::runs::push_event(run_id, crate::runs::RunEvent::Text { delta: delta.clone() });
    let _ = app.emit(
        "agent://text",
        AgentText {
            run_id: run_id.to_string(),
            delta,
        },
    );
}

fn emit_think(app: &AppHandle, run_id: &str, delta: impl Into<String>) {
    let delta = delta.into();
    crate::runs::push_event(run_id, crate::runs::RunEvent::Think { delta: delta.clone() });
    let _ = app.emit(
        "agent://think",
        AgentThink {
            run_id: run_id.to_string(),
            delta,
        },
    );
}

/// Emits a step. `done=false` marks "this tool just started" so the UI shows the
/// card immediately; `done=true` carries the result.
fn emit_step(app: &AppHandle, run_id: &str, index: usize, name: &str, input: String, done: bool, res: &tools::ToolResult) {
    crate::runs::push_event(
        run_id,
        crate::runs::RunEvent::Step {
            index,
            name: name.to_string(),
            input: input.clone(),
            done,
            ok: res.ok,
            result: res.output.clone(),
            path: res.path.clone(),
            old_text: res.old_text.clone(),
            new_text: res.new_text.clone(),
        },
    );
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
            path: res.path.clone(),
            old_text: res.old_text.clone(),
            new_text: res.new_text.clone(),
        },
    );
}

/// Transient provider failures must not kill a whole run: "provider returned
/// 502 Bad Gateway" ended generations that were one retry away from finishing.
pub(super) fn is_transient_status(status: u16) -> bool {
    status == 408 || status == 429 || (500..=504).contains(&status)
}

/// Send attempts for one round before giving up (1 try + 2 retries).
pub(super) const RETRY_ATTEMPTS: usize = 3;

/// Sends a provider request, retrying transient failures (429/5xx/connection
/// resets) with a short backoff. The user SEES each retry in the chat instead
/// of watching the run die. `build` creates a fresh RequestBuilder per
/// attempt — reqwest builders are not Clone.
pub(super) async fn send_with_retry(
    app: &AppHandle,
    run_id: &str,
    build: impl Fn() -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let mut last_err = String::from("request failed");
    for attempt in 0..RETRY_ATTEMPTS {
        if is_cancelled(run_id) {
            return Err(crate::cancel::STOPPED.to_string());
        }
        let res = tokio::select! {
            r = build().send() => r,
            _ = crate::cancel::cancel_signal(run_id) => {
                return Err(crate::cancel::STOPPED.to_string());
            }
        };
        match res {
            Ok(r) => {
                let status = r.status();
                if status.is_success()
                    || !is_transient_status(status.as_u16())
                    || attempt + 1 == RETRY_ATTEMPTS
                {
                    return Ok(r);
                }
                last_err = format!("provider returned {status}");
            }
            Err(e) => {
                if attempt + 1 == RETRY_ATTEMPTS {
                    return Err(format!("request failed: {e}"));
                }
                last_err = format!("connection error: {e}");
            }
        }
        // Backoff 1s, 2s — long enough for a gateway to recover, short enough
        // to stay responsive. Stop still works while waiting.
        let wait = std::time::Duration::from_millis(1000 * 2u64.pow(attempt as u32));
        emit_text(
            app,
            run_id,
            format!(
                "\n\n⚠️ {last_err} — retrying in {}s ({}/{})…\n",
                wait.as_secs(),
                attempt + 1,
                RETRY_ATTEMPTS
            ),
        );
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = crate::cancel::cancel_signal(run_id) => {
                return Err(crate::cancel::STOPPED.to_string());
            }
        }
    }
    Err(last_err)
}

/// Runs the model's ssh_exec call through the shared SSH pool. The unit name
/// from the model maps to a saved server id; credentials never leave Rust.
/// Every attempt is audit-logged with actor "agent" (the Logs page shows it).
async fn run_ssh_tool(app: &AppHandle, req: &AgentRequest, args: &Value) -> tools::ToolResult {
    let server_name = args.get("server").and_then(|v| v.as_str()).unwrap_or("");
    let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
    if server_name.is_empty() || command.is_empty() {
        return tools::ToolResult::err("ssh_exec needs both server and command");
    }
    let unit = req.ssh_units.iter().find(|u| u.name == server_name);
    let Some(unit) = unit else {
        let known: Vec<&str> = req.ssh_units.iter().map(|u| u.name.as_str()).collect();
        return tools::ToolResult::err(format!(
            "unknown server {server_name:?}; available: {known:?}"
        ));
    };
    match crate::ssh::exec(app, "agent", &unit.id, command).await {
        Ok(out) => tools::ToolResult::ok(out),
        Err(e) => tools::ToolResult::err(e),
    }
}


/// Aggregated usage of one run — what the Debug HUD displays.
#[derive(Debug, Clone, Serialize)]
pub struct RunUsage {
    pub run_id: String,
    /// Sum of prompt tokens over all rounds of this run.
    pub prompt_tokens: u64,
    /// Sum of completion tokens over all rounds.
    pub completion_tokens: u64,
    /// Prompt tokens served from cache (Anthropic cache_read / OpenAI cached).
    pub cached_tokens: u64,
    /// Wall time of the run so far, ms — the frontend derives tokens/sec.
    pub elapsed_ms: u64,
}

#[derive(Deserialize)]
pub(super) struct ApiError {
    pub message: Option<String>,
}

/// One accumulated tool call. Arguments arrive split across chunks.
#[derive(Default, Clone)]
pub(super) struct PendingCall {
    pub id: String,
    pub name: String,
    pub args: String,
}
