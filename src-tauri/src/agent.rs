//! Agent loop - lets the model actually do work, not just talk.
//!
//! The run loop itself is Rig's (`rig-agent`): provider clients, streaming,
//! multi-turn tool calling and hooks. This file is the shared spine around
//! it: the request shape, UI events, the command approval gate and the
//! public entry point. The heavy parts live in the agent/ submodules:
//!   prompt    - tool schema + system prompt + call summaries
//!   model     - provider → Rig model handle (effort, temperature, caching)
//!   runtime   - Rig agent build, streaming consumer, hook, tools, subagents
//!   context   - history bounding
//!   expand    - /commands, skills invoked by name and @mentions

mod cachenet;
mod context;
mod expand;
mod model;
mod plain;
mod prompt;
mod runtime;
pub use plain::stream as stream_plain;
pub use runtime::ContextPart;

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
async fn ask_confirm(app: &AppHandle, run_id: &str, command: &str, cwd: &str, reason: &str) -> bool {
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
            reason: reason.to_string(),
        },
    );
    let _ = app.emit(
        "agent://confirm",
        json!({ "run_id": run_id, "command": command, "cwd": cwd, "reason": reason }),
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

/// Upper bound on model calls of one run (Rig's total model-call budget).
/// The repeat guard in the hook stops pathological loops long before this.
const MAX_TURNS: usize = 128;

/* ---------- Events ---------- */

#[derive(Debug, Clone, Serialize)]
pub struct AgentText {
    pub run_id: String,
    pub delta: String,
}

/// A failed request of the run that is retried after a pause.
#[derive(Debug, Clone, Serialize)]
pub struct AgentRetry {
    pub run_id: String,
    pub message: String,
    pub attempt: usize,
    pub max: usize,
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
    /// Picture file a generate_image call produced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
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
    /// Sampling temperature; None keeps the provider default.
    #[serde(default)]
    pub temperature: Option<f64>,
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
    /// Built-in tools switched off in Settings → Plugins (by tool name).
    #[serde(default)]
    pub disabled_tools: Vec<String>,
    /// Stable provider id — the key the limiter budgets requests under.
    #[serde(default)]
    pub provider_id: String,
    /// Max requests/minute for this provider (0 = unlimited).
    #[serde(default)]
    pub rate_limit_rpm: usize,
    /// Max parallel in-flight requests (0 = unlimited).
    #[serde(default)]
    pub concurrency: usize,
    /// Helper agents the main agent MAY delegate to (Settings → Agent).
    #[serde(default)]
    pub subagents: Vec<SubagentDef>,
    /// How many subagents may work at the same time (0/1 = one at a time).
    #[serde(default)]
    pub max_agents: usize,
    /// Retries of a failed model request (any API/stream error) before the
    /// run gives up. Settings → Agent; default 5.
    #[serde(default = "default_retries")]
    pub max_retries: usize,
    /// Longest answer, tokens — set by hand for API models (Settings →
    /// Models); None keeps the provider's own default.
    #[serde(default)]
    pub max_tokens: Option<u64>,
    /// Where `generate_image` draws (None = this run cannot make pictures).
    #[serde(default)]
    pub image_gen: Option<crate::imagegen::ImageGenConfig>,
}

fn default_retries() -> usize {
    5
}

/// A user-defined helper agent: the main agent decides which task (if any)
/// to hand it through the `delegate` tool.
#[derive(Debug, Clone, Deserialize)]
pub struct SubagentDef {
    pub name: String,
    /// When to use it — shown to the main agent.
    #[serde(default)]
    pub description: String,
    /// The subagent's own system prompt.
    #[serde(default)]
    pub prompt: String,
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

/// What the next request of a conversation would carry, part by part
/// (system prompt, tool schemas, history…) with estimated tokens — the
/// context gauge under the prompt box.
pub async fn agent_context(
    app: AppHandle,
    req: AgentRequest,
    turns: Vec<crate::chat::ChatTurn>,
) -> Result<Vec<runtime::ContextPart>, String> {
    let root = Path::new(&req.workspace).to_path_buf();
    let system = if req.system.trim().is_empty() { prompt::default_system() } else { req.system.clone() };
    let turns = context::trim_history(turns);
    runtime::context_info(&app, &req, &system, &root, turns).await
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

    // Only the recent conversation goes on the wire, with old answers
    // clipped — the whole chat history used to ride along on every round.
    let full = turns.clone();
    let turns = context::trim_history(turns);

    let result = runtime::run(&app, &run_id, &req, &system, &root, turns, &full).await;

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

fn emit_retry(app: &AppHandle, run_id: &str, message: String, attempt: usize, max: usize) {
    crate::runs::push_event(run_id, crate::runs::RunEvent::Retry { message: message.clone(), attempt, max });
    let _ = app.emit(
        "agent://retry",
        AgentRetry {
            run_id: run_id.to_string(),
            message,
            attempt,
            max,
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
            image: res.image.clone(),
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
            image: res.image.clone(),
        },
    );
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
    /// Sum of prompt tokens over all rounds of this run — the whole prompt,
    /// cache reads included, for every provider.
    pub prompt_tokens: u64,
    /// Sum of completion tokens over all rounds.
    pub completion_tokens: u64,
    /// Prompt tokens served from cache (Anthropic cache_read / OpenAI cached).
    pub cached_tokens: u64,
    /// Wall time of the run so far, ms — the frontend derives tokens/sec.
    pub elapsed_ms: u64,
    /// Input tokens of the run's FIRST model call as the provider counted
    /// them (cache reads included) — the real size of that request.
    pub first_input: u64,
    /// Our estimate of that same request (context_info's method): the
    /// context gauge scales its estimates by first_input / first_est.
    pub first_est: u64,
}
