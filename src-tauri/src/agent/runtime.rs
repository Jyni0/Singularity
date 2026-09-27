//! The agent run on Rig: builds a `rig_agent::Agent` from the request,
//! streams it multi-turn and translates everything into the app's events.
//!
//! * Text / reasoning deltas come off the Rig stream and go straight to the
//!   UI (`agent://text`, `agent://think`).
//! * Tool calls are observed through an [`AgentHook`]: the card appears while
//!   the model is still streaming the arguments, the Allow/Deny gate runs
//!   before execution, and the result (with diff metadata from the tool's
//!   `ToolContext`) closes the card.
//! * Tools are `DynamicTool`s over the existing `tools::dispatch`.
//! * Subagents: user-defined helpers reachable through ONE `delegate` tool;
//!   the model decides which task goes to which helper. A semaphore bounds
//!   how many work at once, and the main run executes tool calls with the
//!   same concurrency so several delegations really run in parallel.
//! * Skills: a `skill` tool loads a skill's instructions on demand; the
//!   preamble lists only names + descriptions.
//! * MCP: every tool of every enabled MCP server becomes a `mcp__server__tool`
//!   dynamic tool over the pooled connection (mcp.rs).

use super::context::one_line;
use super::prompt::{summarize, tool_specs};
use super::{
    ask_confirm, cancelled_result, emit_step, emit_text, emit_think, emit_usage, is_cancelled,
    model, run_ssh_tool, AgentRequest, RunUsage, SubagentDef, MAX_TURNS,
};
use crate::tools;
use futures_util::StreamExt;
use rig_agent::agent::{
    AgentBuilder, AgentHook, CompletionCallAction, CompletionCallEvent, HookContext,
    MultiTurnStreamItem, ObservationAction, StreamResponseFinish, ToolCall, ToolCallAction,
    ToolCallDelta, ToolResultAction, ToolResultEvent,
};
use rig_agent::core::completion::message::{ImageMediaType, Message, UserContent};
use rig_agent::core::streaming::StreamedAssistantContent;
use rig_agent::core::tool::{ToolExecutionError, ToolOutput};
use rig_agent::core::wasm_compat::WasmBoxedFuture;
use rig_agent::streaming::StreamingChat;
use rig_agent::tool::{DynamicTool, ToolContext};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

/* ---------- Shared run state ---------- */

/// State shared by the main agent, its hook, its tools and every subagent of
/// one run. Cheap to clone (all Arcs).
#[derive(Clone)]
struct RunCtx {
    app: AppHandle,
    run_id: String,
    req: Arc<AgentRequest>,
    root: PathBuf,
    /// Rig internal call id → UI step index.
    steps: Arc<Mutex<HashMap<String, usize>>>,
    /// Next step index (shared by main agent and subagents).
    counter: Arc<AtomicUsize>,
    /// One Allow/Deny banner at a time, even with parallel tool calls.
    confirm_lock: Arc<tokio::sync::Mutex<()>>,
    /// Bounds concurrently working subagents.
    agent_slots: Arc<tokio::sync::Semaphore>,
    /// Canonical delegate args → its step index, so the running subagent can
    /// stream its progress into its own card.
    delegate_cards: Arc<Mutex<HashMap<String, usize>>>,
    usage: Arc<Mutex<RunUsage>>,
    started: std::time::Instant,
    /// MCP tool name → (server name, read-only hint) for the approval gate.
    mcp_tools: Arc<HashMap<String, (String, bool)>>,
    /// Working directory of file tools and commands; `change_dir` moves it.
    /// Starts at the workspace.
    cwd: Arc<Mutex<PathBuf>>,
    /// Set once the provider rejected the temperature parameter (reasoning
    /// models, out-of-range values): later requests go without it.
    no_temperature: Arc<AtomicBool>,
}

impl RunCtx {
    fn cwd(&self) -> PathBuf {
        self.cwd.lock().unwrap().clone()
    }

    fn step_for(&self, internal_id: &str) -> usize {
        let mut map = self.steps.lock().unwrap();
        *map.entry(internal_id.to_string())
            .or_insert_with(|| self.counter.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn add_usage(&self, input: u64, output: u64, cached: u64) {
        let mut u = self.usage.lock().unwrap();
        u.prompt_tokens += input;
        u.completion_tokens += output;
        u.cached_tokens += cached;
        u.elapsed_ms = self.started.elapsed().as_millis() as u64;
        emit_usage(&self.app, &u);
    }
}

/// Canonical JSON text of tool arguments (key order, whitespace) — the hook
/// sees the raw string, the tool the parsed value; both map to this.
fn canonical(args: &Value) -> String {
    serde_json::to_string(args).unwrap_or_default()
}

/* ---------- Hook: live cards, approvals, guard, limiter ---------- */

/// Arguments of a call still streaming, for the live card.
#[derive(Default)]
struct LiveCall {
    name: String,
    args: String,
    shown: usize,
}

/// Argument growth (chars) between two live card updates.
const LIVE_ARGS_STEP: usize = 400;
/// Identical consecutive tool calls tolerated before they are skipped.
const REPEAT_SKIP_AT: usize = 3;
/// …and before the run is stopped outright.
const REPEAT_STOP_AT: usize = 5;
/// Marker of the repeat guard's stop — deliberate, never retried.
const GUARD_STOP: &str = "the model repeated the same action";
/// Pause between retries of a failed model request.
const RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(5);

/// The latest model request of one logical run — (prompt, history) exactly
/// as Rig is about to send it. After a failure the run resumes from here.
type Snapshot = Arc<Mutex<Option<(Message, Vec<Message>)>>>;

struct UiHook {
    ctx: RunCtx,
    snapshot: Snapshot,
    /// "[Helper] " prefix for subagent cards; empty for the main agent.
    label: String,
    permit: Mutex<Option<crate::limiter::Permit>>,
    live: Mutex<HashMap<String, LiveCall>>,
    last_call: Mutex<(String, usize)>,
}

impl UiHook {
    fn new(ctx: RunCtx, label: Option<&str>, snapshot: Snapshot) -> Self {
        Self {
            ctx,
            snapshot,
            label: label.map(|l| format!("[{l}] ")).unwrap_or_default(),
            permit: Mutex::new(None),
            live: Mutex::new(HashMap::new()),
            last_call: Mutex::new((String::new(), 0)),
        }
    }

    fn step(&self, index: usize, name: &str, input: String, done: bool, res: &tools::ToolResult) {
        let input = format!("{}{input}", self.label);
        emit_step(&self.ctx.app, &self.ctx.run_id, index, name, input, done, res);
    }
}

impl AgentHook for UiHook {
    /// Provider limits (RPM + concurrency) gate every model call; Stop ends
    /// the run before another request goes out.
    async fn on_completion_call(&self, _ctx: &HookContext, event: CompletionCallEvent<'_>) -> CompletionCallAction {
        if is_cancelled(&self.ctx.run_id) {
            return CompletionCallAction::Stop(crate::cancel::STOPPED.to_string());
        }
        *self.snapshot.lock().unwrap() = Some((event.prompt.clone(), event.history.to_vec()));
        let req = &self.ctx.req;
        let key = if req.provider_id.is_empty() { req.base_url.clone() } else { req.provider_id.clone() };
        let permit = crate::limiter::acquire(&key, req.rate_limit_rpm, req.concurrency, &self.ctx.run_id).await;
        *self.permit.lock().unwrap() = Some(permit);
        CompletionCallAction::Continue
    }

    /// The provider slot is free once the stream ends — tools and approval
    /// banners must not hold it.
    async fn on_stream_response_finish(&self, _ctx: &HookContext, _event: StreamResponseFinish<'_>) -> ObservationAction {
        self.permit.lock().unwrap().take();
        ObservationAction::Continue
    }

    /// The card appears while the model is still writing the call, and grows
    /// with its arguments — a long apply_patch is never a silent pause.
    async fn on_tool_call_delta(&self, _ctx: &HookContext, event: ToolCallDelta<'_>) -> ObservationAction {
        let update = {
            let mut live = self.live.lock().unwrap();
            let call = live.entry(event.internal_call_id.to_string()).or_default();
            if let Some(n) = event.tool_name {
                if call.name.is_empty() {
                    call.name = n.to_string();
                }
            }
            call.args.push_str(event.delta);
            let first = call.shown == 0;
            if call.name.is_empty() || (!first && call.args.len() < call.shown + LIVE_ARGS_STEP) {
                None
            } else {
                call.shown = call.args.len().max(1);
                Some((call.name.clone(), live_summary(&call.name, &call.args)))
            }
        };
        if let Some((name, input)) = update {
            let idx = self.ctx.step_for(event.internal_call_id);
            self.step(idx, &name, input, false, &tools::ToolResult::ok(""));
        }
        ObservationAction::Continue
    }

    /// Before execution: repeat guard, start card, Allow/Deny gate.
    async fn on_tool_call(&self, _ctx: &HookContext, event: ToolCall<'_>) -> ToolCallAction {
        if is_cancelled(&self.ctx.run_id) {
            return ToolCallAction::Stop(crate::cancel::STOPPED.to_string());
        }
        let args: Value = serde_json::from_str(event.args).unwrap_or(json!({}));
        let summary = summarize(event.tool_name, &args);
        let idx = self.ctx.step_for(event.internal_call_id);
        if event.tool_name == "delegate" {
            self.ctx.delegate_cards.lock().unwrap().insert(canonical(&args), idx);
        }

        // Stuck-loop guard: the same call over and over gets skipped with a
        // nudge, then ends the run with what exists.
        let fp = format!("{}({})", event.tool_name, canonical(&args));
        let repeats = {
            let mut last = self.last_call.lock().unwrap();
            if last.0 == fp {
                last.1 += 1;
            } else {
                *last = (fp.clone(), 1);
            }
            last.1
        };
        if repeats >= REPEAT_STOP_AT {
            self.step(idx, event.tool_name, summary, true, &tools::ToolResult::err("stopped: repeated call"));
            return ToolCallAction::Stop(format!("{GUARD_STOP} {repeats} times ({})", one_line(&fp, 120)));
        }
        if repeats >= REPEAT_SKIP_AT {
            self.step(idx, event.tool_name, summary, true, &tools::ToolResult::err("skipped: repeated call"));
            return ToolCallAction::Skip(
                "You already made this exact call and it will not give a different result. Change your approach or finish with an answer.".into(),
            );
        }

        self.step(idx, event.tool_name, summary.clone(), false, &tools::ToolResult::ok(""));

        // Permission gate (safety.rs): commands need a yes unless the project
        // runs them automatically, and risky commands, secrets and writes to
        // system / outside-project paths ALWAYS need one.
        // MCP tools act outside the app — they ask like commands do, unless
        // the server marks the tool read-only or the project auto-runs.
        let gate = match self.ctx.mcp_tools.get(event.tool_name) {
            Some((server, read_only)) => (!self.ctx.req.auto_run && !read_only).then(|| Gate {
                what: format!("{} {}", event.tool_name, one_line(&canonical(&args), 200)),
                place: format!("MCP server {server}"),
                reason: String::new(),
            }),
            None => permission_gate(
                event.tool_name,
                &args,
                &self.ctx.req.workspace,
                &self.ctx.cwd().to_string_lossy(),
                self.ctx.req.auto_run,
            ),
        };
        if let Some(gate) = gate {
            let approved = {
                let _one_banner = self.ctx.confirm_lock.lock().await;
                ask_confirm(&self.ctx.app, &self.ctx.run_id, &gate.what, &gate.place, &gate.reason).await
            };
            if !approved {
                self.step(idx, event.tool_name, summary, true, &tools::ToolResult::err("denied by the user"));
                return ToolCallAction::Skip(
                    "The user denied this action. Do not retry it or work around it — continue without it, or explain what you would need.".into(),
                );
            }
        }
        ToolCallAction::Run
    }

    /// After execution: close the card with the real result (the tool left
    /// its full `ToolResult`, diff included, in the context).
    async fn on_tool_result(&self, _ctx: &HookContext, event: ToolResultEvent<'_>) -> ToolResultAction {
        let args: Value = serde_json::from_str(event.args).unwrap_or(json!({}));
        let idx = self.ctx.step_for(event.internal_call_id);
        let res = event
            .tool_context
            .result::<tools::ToolResult>()
            .cloned()
            .unwrap_or_else(|| tools::ToolResult::err(event.presentation.render()));
        self.step(idx, event.tool_name, summarize(event.tool_name, &args), true, &res);
        ToolResultAction::Keep
    }
}

/// What the Allow/Deny banner shows for a call that needs a yes.
struct Gate {
    what: String,
    place: String,
    reason: String,
}

/// Decides whether a tool call must wait for the user. `reason` is empty
/// for the plain "commands need approval" case and names the danger
/// otherwise.
fn permission_gate(tool: &str, args: &Value, workspace: &str, cwd: &str, auto_run: bool) -> Option<Gate> {
    let get = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("");
    // A file the call writes / reads: sensitive paths always ask, writes
    // outside the project ask unless the project auto-runs.
    let path_gate = |path: &str, write: bool, verb: &str| -> Option<Gate> {
        let full = full_path(cwd, path);
        let reason = if let Some(why) = crate::safety::sensitive_path(&full.to_string_lossy(), write) {
            format!("{} {}", if write { "Writes a file that" } else { "Reads a file that" }, why)
        } else if write && !auto_run && !is_inside(&full, Path::new(workspace)) {
            "Writes outside the project folder".to_string()
        } else {
            return None;
        };
        Some(Gate {
            what: format!("{verb} {}", full.display()),
            place: workspace.to_string(),
            reason,
        })
    };
    match tool {
        "run_command" | "ssh_exec" => {
            let cmd = get("command");
            let risky = crate::safety::risky_command(cmd);
            if auto_run && risky.is_none() {
                return None;
            }
            let place = if tool == "ssh_exec" {
                format!("server {}", get("server"))
            } else if get("cwd").is_empty() {
                cwd.to_string()
            } else {
                full_path(cwd, get("cwd")).display().to_string()
            };
            Some(Gate {
                what: cmd.to_string(),
                place,
                reason: risky.map(|r| format!("Risky command: {r}")).unwrap_or_default(),
            })
        }
        "git" => {
            let sub = get("subcommand").trim().to_string();
            let rest = match args.get("args") {
                Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(" "),
                Some(Value::String(t)) => t.clone(),
                _ => String::new(),
            };
            let line = format!("git {sub} {rest}").trim().to_string();
            let risky = crate::safety::risky_command(&line);
            // Read-only subcommands never ask (a `branch`/`tag`/`remote`
            // with arguments may change things, so those do).
            let read_only = tools::GIT_READ_ONLY.contains(&sub.as_str())
                && (rest.is_empty() || !matches!(sub.as_str(), "branch" | "tag" | "remote"));
            if risky.is_none() && (read_only || auto_run) {
                return None;
            }
            Some(Gate {
                what: line,
                place: if get("cwd").is_empty() { cwd.to_string() } else { full_path(cwd, get("cwd")).display().to_string() },
                reason: risky.map(|r| format!("Risky command: {r}")).unwrap_or_default(),
            })
        }
        "file_op" => match get("op") {
            "info" | "exists" => None,
            "delete" => {
                let full = full_path(cwd, get("path"));
                let inside = is_inside(&full, Path::new(workspace));
                if auto_run && inside && crate::safety::sensitive_path(&full.to_string_lossy(), true).is_none() {
                    return None;
                }
                Some(Gate {
                    what: format!("delete {}", full.display()),
                    place: workspace.to_string(),
                    reason: if inside { String::new() } else { "Deletes outside the project folder".into() },
                })
            }
            "move" | "rename" => path_gate(get("path"), true, "move").or_else(|| path_gate(get("to"), true, "move to")),
            "copy" => path_gate(get("to"), true, "copy to"),
            _ => path_gate(get("path"), true, "create"),
        },
        "read_file" | "list_dir" | "grep" | "find_files" | "apply_patch" | "write_file" | "edit_file" => {
            let write = matches!(tool, "apply_patch" | "write_file" | "edit_file");
            path_gate(get("path"), write, if write { "edit" } else { "read" })
        }
        _ => None,
    }
}

/// The path a tool will touch, relative paths joined onto the workspace and
/// `.`/`..` folded lexically (the file may not exist yet).
fn full_path(workspace: &str, path: &str) -> PathBuf {
    let p = Path::new(path.trim());
    let joined = if p.is_absolute() { p.to_path_buf() } else { Path::new(workspace).join(p) };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

fn is_inside(path: &Path, root: &Path) -> bool {
    if root.as_os_str().is_empty() {
        return true;
    }
    // Windows paths compare case-insensitively.
    let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase();
    let (p, r) = (norm(path), norm(root));
    p == r || p.starts_with(&(r + "/"))
}

/// Card input for a call whose JSON arguments may still be incomplete.
fn live_summary(name: &str, args: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(args) {
        return summarize(name, &v);
    }
    let key = match name {
        "run_command" | "ssh_exec" => "command",
        "grep" | "find_files" => "pattern",
        "web_search" => "query",
        "web_fetch" => "url",
        "git" => "subcommand",
        "delegate" => "agent",
        "skill" => "name",
        _ => "path",
    };
    let head = partial_field(args, key).unwrap_or_default();
    if args.len() < 64 {
        format!("{head}…")
    } else {
        format!("{head} … ({} chars)", args.len())
    }
}

/// Reads a string field out of a possibly truncated JSON object.
fn partial_field(json: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\"");
    let at = json.find(&pat)? + pat.len();
    let rest = json[at..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    let mut out = String::new();
    let mut esc = false;
    for ch in rest.chars() {
        if esc {
            out.push(if ch == 'n' || ch == 't' { ' ' } else { ch });
            esc = false;
            continue;
        }
        match ch {
            '\\' => esc = true,
            '"' => break,
            c => out.push(c),
        }
    }
    Some(one_line(&out, 80))
}

/* ---------- Tools ---------- */

type ToolFuture<'a> = WasmBoxedFuture<'a, Result<ToolOutput, ToolExecutionError>>;

/// Pins a closure to the higher-ranked signature DynamicTool expects.
fn tool_fn<F>(f: F) -> F
where
    F: for<'a> Fn(&'a mut ToolContext, Value) -> ToolFuture<'a> + Send + Sync + 'static,
{
    f
}

/// What the model reads back: the output, marked when it is an error.
fn model_text(res: &tools::ToolResult) -> String {
    if res.ok {
        res.output.clone()
    } else {
        format!("ERROR: {}", res.output)
    }
}

/// The filesystem / command / SSH tools, as Rig dynamic tools.
fn fs_tools(ctx: &RunCtx) -> Vec<DynamicTool> {
    let specs = tool_specs(&ctx.req);
    specs
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|spec| {
            let name = spec["name"].as_str().unwrap_or("").to_string();
            let description = spec["description"].as_str().unwrap_or("").to_string();
            let parameters = spec["parameters"].clone();
            let c = ctx.clone();
            let tool_name = name.clone();
            DynamicTool::new(
                name,
                description,
                parameters,
                tool_fn(move |tctx, args| {
                    let c = c.clone();
                    let tool_name = tool_name.clone();
                    Box::pin(async move {
                        let get = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let res = match tool_name.as_str() {
                            "ssh_exec" => run_ssh_tool(&c.app, &c.req, &args).await,
                            "web_search" => {
                                let max = args.get("max_results").and_then(|v| v.as_u64()).unwrap_or(8) as usize;
                                crate::web::search(&get("query"), max).await
                            }
                            "web_fetch" => {
                                let start = args.get("start").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                crate::web::fetch(&get("url"), start).await
                            }
                            "change_dir" => change_dir(&c, &get("path")),
                            _ => {
                                // Tools block (file IO, processes): keep the async
                                // workers free so events keep flowing.
                                let root = c.cwd();
                                tokio::task::spawn_blocking(move || tools::dispatch(&root, &tool_name, &args))
                                    .await
                                    .unwrap_or_else(|e| tools::ToolResult::err(format!("tool task failed: {e}")))
                            }
                        };
                        let text = model_text(&res);
                        tctx.insert_result(res);
                        Ok(ToolOutput::text(text))
                    })
                }),
            )
        })
        .collect()
}

/// `change_dir`: moves the run's working directory (relative paths of every
/// later file tool and command start there) and lists the new place.
fn change_dir(ctx: &RunCtx, path: &str) -> tools::ToolResult {
    let current = ctx.cwd();
    let target = if path.trim().is_empty() {
        ctx.root.clone()
    } else {
        match tools::resolve(&current, path) {
            Ok(p) => p,
            Err(e) => return tools::ToolResult::err(e),
        }
    };
    if !target.is_dir() {
        return tools::ToolResult::err(tools::not_found(&current, path));
    }
    let target = full_path(&target.to_string_lossy(), "");
    *ctx.cwd.lock().unwrap() = target.clone();
    let listing = tools::list_dir(&target, "");
    tools::ToolResult::ok(format!("now in {}\n{}", target.display(), listing.output))
}

/// The single `delegate` tool that hands a task to a user-defined helper.
fn delegate_tool(ctx: &RunCtx) -> DynamicTool {
    let names: Vec<String> = ctx.req.subagents.iter().map(|s| s.name.clone()).collect();
    let roster = ctx
        .req
        .subagents
        .iter()
        .map(|s| format!("- {}: {}", s.name, s.description))
        .collect::<Vec<_>>()
        .join("\n");
    let c = ctx.clone();
    DynamicTool::new(
        "delegate",
        format!(
            "Hand a self-contained task to a helper agent and get its result back. Helpers have the same file/command tools. Use one only when the task matches its specialty; call delegate several times in one turn to run helpers in parallel.\nHelpers:\n{roster}"
        ),
        json!({
            "type": "object",
            "properties": {
                "agent": { "type": "string", "enum": names, "description": "Which helper to use." },
                "task": { "type": "string", "description": "Complete, self-contained instruction for the helper." }
            },
            "required": ["agent", "task"]
        }),
        tool_fn(move |tctx, args| {
            let c = c.clone();
            Box::pin(async move {
                let name = args.get("agent").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let task = args.get("task").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let card = c.delegate_cards.lock().unwrap().get(&canonical(&args)).copied();
                let res = match c.req.subagents.iter().find(|s| s.name == name) {
                    None => tools::ToolResult::err(format!("unknown helper {name:?}")),
                    Some(def) => {
                        // Bounded parallelism: extra delegations queue here.
                        let _slot = c.agent_slots.acquire().await;
                        match run_subagent(&c, def, &task, card).await {
                            Ok(text) => tools::ToolResult::ok(text),
                            Err(e) => tools::ToolResult::err(e),
                        }
                    }
                };
                let text = model_text(&res);
                tctx.insert_result(res);
                Ok(ToolOutput::text(text))
            })
        }),
    )
}

/// The `skill` tool: loads a skill's instructions (or one of its files).
fn skill_tool(skills: Arc<Vec<crate::skills::Skill>>) -> DynamicTool {
    let names: Vec<String> = skills.iter().map(|s| s.name.clone()).collect();
    DynamicTool::new(
        "skill",
        "Load the instructions of a skill listed in the system prompt. Call it before starting a task that matches the skill's description, then follow the instructions. Pass `file` to read one of the skill's supporting files.",
        json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "enum": names, "description": "Skill to load." },
                "file": { "type": "string", "description": "Optional: a file inside the skill folder, as listed by the skill." }
            },
            "required": ["name"]
        }),
        tool_fn(move |tctx, args| {
            let skills = skills.clone();
            Box::pin(async move {
                let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let file = args.get("file").and_then(|v| v.as_str());
                let res = match skills.iter().find(|s| s.name == name) {
                    None => tools::ToolResult::err(format!("unknown skill {name:?}")),
                    Some(s) => match crate::skills::load_for_model(s, file) {
                        Ok(text) => tools::ToolResult::ok(text),
                        Err(e) => tools::ToolResult::err(e),
                    },
                };
                let text = model_text(&res);
                tctx.insert_result(res);
                Ok(ToolOutput::text(text))
            })
        }),
    )
}

/// One MCP tool offered to the model.
#[derive(Clone)]
struct McpBinding {
    server: Arc<crate::mcp::McpServer>,
    tool: crate::mcp::McpTool,
    /// Name the model sees (`mcp__server__tool`, unique within the run).
    name: String,
}

/// Connects every enabled MCP server (pooled — usually instant) and lists
/// their tools. A server that fails gets a red card and is left out; the run
/// goes on with the rest.
async fn load_mcp(app: &AppHandle, run_id: &str, counter: &AtomicUsize) -> Vec<McpBinding> {
    let servers: Vec<_> = crate::mcp::list(app)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|s| s.enabled)
        .collect();
    if servers.is_empty() {
        return Vec::new();
    }
    let results = futures_util::future::join_all(servers.into_iter().map(|s| async move {
        let r = tokio::select! {
            r = crate::mcp::connect(&s) => r,
            _ = crate::cancel::cancel_signal(run_id) => Err(crate::cancel::STOPPED.to_string()),
        };
        (s, r)
    }))
    .await;
    let mut out: Vec<McpBinding> = Vec::new();
    for (server, res) in results {
        match res {
            Ok(conn) => {
                let server = Arc::new(server);
                for tool in &conn.tools {
                    let mut name = crate::mcp::tool_name(&server.name, &tool.name);
                    let mut n = 2;
                    while out.iter().any(|b| b.name == name) {
                        let suffix = format!("_{n}");
                        name = format!("{}{suffix}", name.chars().take(64 - suffix.len()).collect::<String>());
                        n += 1;
                    }
                    out.push(McpBinding { server: server.clone(), tool: tool.clone(), name });
                }
            }
            Err(e) if e == crate::cancel::STOPPED => {}
            Err(e) => {
                let idx = counter.fetch_add(1, Ordering::SeqCst) + 1;
                emit_step(app, run_id, idx, "mcp", format!("connect {}", server.name), true, &tools::ToolResult::err(e));
            }
        }
    }
    out
}

fn mcp_tool(b: &McpBinding) -> DynamicTool {
    let desc = if b.tool.description.trim().is_empty() {
        format!("{} (MCP server {})", b.tool.name, b.server.name)
    } else {
        format!("{} (MCP server {})", b.tool.description.trim(), b.server.name)
    };
    let (server, tool_name) = (b.server.clone(), b.tool.name.clone());
    DynamicTool::new(
        b.name.clone(),
        desc,
        b.tool.input_schema.clone(),
        tool_fn(move |tctx, args| {
            let (server, tool_name) = (server.clone(), tool_name.clone());
            Box::pin(async move {
                let res = match crate::mcp::call(&server, &tool_name, args).await {
                    Ok((text, false)) => tools::ToolResult::ok(text),
                    Ok((text, true)) => tools::ToolResult::err(text),
                    Err(e) => tools::ToolResult::err(e),
                };
                let text = model_text(&res);
                tctx.insert_result(res);
                Ok(ToolOutput::text(text))
            })
        }),
    )
}

/* ---------- Agent build + streaming ---------- */

/// Builds one Rig agent (main or helper) on the request's provider.
fn build_agent(ctx: &RunCtx, preamble: &str, tools: Vec<DynamicTool>) -> Result<rig_agent::Agent, String> {
    let setup = model::build(&ctx.req)?;
    let mut b = AgentBuilder::from_model_handle(setup.handle)
        .preamble(preamble)
        .default_max_turns(MAX_TURNS);
    if let Some(t) = setup.temperature.filter(|_| !ctx.no_temperature.load(Ordering::Relaxed)) {
        b = b.temperature(t);
    }
    if let Some(m) = setup.max_tokens {
        b = b.max_tokens(m);
    }
    if let Some(p) = setup.params {
        b = b.additional_params(p);
    }
    Ok(b.dynamic_tools(tools).build())
}

/// Chat history → Rig messages; the LAST user turn becomes the prompt (with
/// the attached images).
fn to_messages(req: &AgentRequest, turns: &[crate::chat::ChatTurn]) -> (Vec<Message>, Message) {
    let last_user = turns
        .iter()
        .rposition(|t| t.role != "agent" && t.role != "assistant");
    let mut history = Vec::new();
    let mut prompt = Message::user("");
    for (i, t) in turns.iter().enumerate() {
        let agent = t.role == "agent" || t.role == "assistant";
        if Some(i) == last_user {
            let mut content = vec![UserContent::text(t.text.clone())];
            for img in &req.images {
                let mt = match img.mime.as_str() {
                    "image/png" => Some(ImageMediaType::PNG),
                    "image/jpeg" | "image/jpg" => Some(ImageMediaType::JPEG),
                    "image/gif" => Some(ImageMediaType::GIF),
                    "image/webp" => Some(ImageMediaType::WEBP),
                    _ => None,
                };
                content.push(UserContent::image_base64(
                    crate::chat::base64_body(&img.data_url).to_string(),
                    mt,
                    None,
                ));
            }
            prompt = Message::User { content };
        } else if agent {
            if !t.text.trim().is_empty() {
                history.push(Message::assistant(t.text.clone()));
            }
        } else {
            history.push(Message::user(t.text.clone()));
        }
    }
    (history, prompt)
}

/// Consumes one Rig stream: text and reasoning go to the UI (only when
/// `to_ui`), usage to the HUD. Returns the text it produced plus the error
/// that ended it, if any (Stop drops the stream at once and reports
/// `STOPPED`).
async fn drive(
    ctx: &RunCtx,
    mut stream: rig_agent::agent::StreamingResult,
    to_ui: bool,
    mut on_text: impl FnMut(&str),
) -> (String, Option<String>) {
    let mut text = String::new();
    // Providers that stream reasoning deltas also send the full block at the
    // end of the turn — show it only when no deltas came.
    let mut saw_reasoning_delta = false;
    loop {
        let item = tokio::select! {
            it = stream.next() => match it {
                Some(it) => it,
                None => break,
            },
            _ = crate::cancel::cancel_signal(&ctx.run_id) => {
                drop(stream);
                return (text, Some(crate::cancel::STOPPED.to_string()));
            }
        };
        let item = match item {
            Ok(it) => it,
            Err(e) => {
                let msg = e.to_string();
                if is_cancelled(&ctx.run_id) || msg.contains(crate::cancel::STOPPED) {
                    return (text, Some(crate::cancel::STOPPED.to_string()));
                }
                return (text, Some(msg));
            }
        };
        match item {
            MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(t)) => {
                if !t.text.is_empty() {
                    text.push_str(&t.text);
                    on_text(&t.text);
                    if to_ui {
                        emit_text(&ctx.app, &ctx.run_id, t.text);
                    }
                }
            }
            MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::ReasoningDelta { reasoning, .. }) => {
                saw_reasoning_delta = true;
                if to_ui && !reasoning.is_empty() {
                    emit_think(&ctx.app, &ctx.run_id, reasoning);
                }
            }
            MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Reasoning { reasoning, .. }) => {
                if to_ui && !saw_reasoning_delta {
                    let full = reasoning.display_text();
                    if !full.trim().is_empty() {
                        emit_think(&ctx.app, &ctx.run_id, full);
                    }
                }
                saw_reasoning_delta = false;
            }
            MultiTurnStreamItem::CompletionCall(call) => {
                let u = call.usage;
                ctx.add_usage(u.input_tokens + u.cache_creation_input_tokens, u.output_tokens, u.cached_input_tokens);
            }
            MultiTurnStreamItem::FinalResponse(resp) => {
                if text.trim().is_empty() && !resp.output.trim().is_empty() {
                    // Non-streaming providers: the answer only arrives here.
                    text = resp.output.clone();
                    if to_ui {
                        emit_text(&ctx.app, &ctx.run_id, resp.output);
                    }
                }
            }
            _ => {}
        }
    }
    (text, None)
}

/// Runs an agent (main or helper) to the end, retrying ANY failure — HTTP
/// 5xx/429, broken JSON, a cut connection — up to `req.max_retries` times,
/// every RETRY_DELAY. A retry resumes from the exact request that failed
/// (the hook's snapshot), so finished tool work is never redone. Stop and
/// the repeat guard are deliberate and end the run at once.
#[allow(clippy::too_many_arguments)]
async fn run_with_retry(
    ctx: &RunCtx,
    preamble: &str,
    tools: impl Fn() -> Vec<DynamicTool>,
    label: Option<&str>,
    mut prompt: Message,
    mut history: Vec<Message>,
    parallel: usize,
    to_ui: bool,
    mut on_text: impl FnMut(&str),
) -> Result<String, String> {
    let snapshot: Snapshot = Arc::default();
    let mut text = String::new();
    let mut attempt = 0usize;
    loop {
        let agent = build_agent(ctx, preamble, tools())?;
        let stream = agent
            .stream_chat(prompt.clone(), history.clone())
            .max_turns(MAX_TURNS)
            // Several delegate calls in one turn run side by side.
            .tool_concurrency(parallel)
            .add_hook(UiHook::new(ctx.clone(), label, snapshot.clone()))
            .await;
        let (part, err) = drive(ctx, stream, to_ui, &mut on_text).await;
        text.push_str(&part);
        let Some(err) = err else {
            return Ok(text);
        };
        if err.starts_with(crate::cancel::STOPPED) || is_cancelled(&ctx.run_id) {
            return cancelled_result(text);
        }
        if err.contains(GUARD_STOP) {
            return Err(err);
        }
        // The provider refused the temperature (reasoning models take none,
        // Anthropic caps it at 1): drop it and go again at once — this used
        // to burn every retry, 5 s apart, on the same 400.
        if ctx.req.temperature.is_some()
            && !ctx.no_temperature.load(Ordering::Relaxed)
            && err.to_lowercase().contains("temperature")
        {
            ctx.no_temperature.store(true, Ordering::Relaxed);
            emit_text(
                &ctx.app,
                &ctx.run_id,
                "\n\n⚠️ This model does not accept the chosen temperature — continuing with its default.\n\n".to_string(),
            );
            if let Some((p, h)) = snapshot.lock().unwrap().take() {
                prompt = p;
                history = h;
            }
            continue;
        }
        if attempt >= ctx.req.max_retries {
            return Err(err);
        }
        attempt += 1;
        let who = label.map(|l| format!("{l}: ")).unwrap_or_default();
        emit_text(
            &ctx.app,
            &ctx.run_id,
            format!(
                "\n\n⚠️ {who}{} — retrying in {}s ({attempt}/{})…\n\n",
                one_line(&err, 200),
                RETRY_DELAY.as_secs(),
                ctx.req.max_retries
            ),
        );
        tokio::select! {
            _ = tokio::time::sleep(RETRY_DELAY) => {}
            _ = crate::cancel::cancel_signal(&ctx.run_id) => return cancelled_result(text),
        }
        // Resume from the request that failed; before the first request
        // there is no snapshot and the original prompt goes out again.
        if let Some((p, h)) = snapshot.lock().unwrap().take() {
            prompt = p;
            history = h;
        }
    }
}

/// Runs one helper agent to completion. Its tool cards join the run's
/// transcript (prefixed with its name); its prose streams into the delegate
/// card and comes back to the main agent as the tool result.
async fn run_subagent(ctx: &RunCtx, def: &SubagentDef, task: &str, card: Option<usize>) -> Result<String, String> {
    let preamble = format!(
        "{}\n\nYou are the helper agent \"{}\". {}\nDo ONLY the task you are given, then answer with a short factual summary of what you did or found.",
        super::prompt::default_system(),
        def.name,
        def.prompt.trim()
    );
    let summary = format!("{}: {}", def.name, one_line(task, 80));
    let mut partial = String::new();
    let mut shown = 0usize;
    let result = run_with_retry(ctx, &preamble, || fs_tools(ctx), Some(&def.name), Message::user(task), Vec::new(), 1, false, |t| {
        partial.push_str(t);
        // Live progress in the delegate card, throttled.
        if let Some(idx) = card {
            if partial.len() >= shown + 200 {
                shown = partial.len();
                emit_step(&ctx.app, &ctx.run_id, idx, "delegate", summary.clone(), false, &tools::ToolResult::ok(partial.clone()));
            }
        }
    })
    .await;
    match result {
        Ok(text) if text.trim().is_empty() => Err("the helper returned no answer".into()),
        other => other,
    }
}

/// The main run.
pub(super) async fn run(
    app: &AppHandle,
    run_id: &str,
    req: &AgentRequest,
    system: &str,
    root: &Path,
    turns: Vec<crate::chat::ChatTurn>,
) -> Result<String, String> {
    let parallel = req.max_agents.max(1);
    let counter = Arc::new(AtomicUsize::new(0));
    let skills = Arc::new(crate::skills::for_run(app, &req.workspace));
    let mcp = load_mcp(app, run_id, &counter).await;
    if is_cancelled(run_id) {
        return cancelled_result(String::new());
    }
    let ctx = RunCtx {
        app: app.clone(),
        run_id: run_id.to_string(),
        req: Arc::new(req.clone()),
        root: root.to_path_buf(),
        steps: Arc::default(),
        counter,
        confirm_lock: Arc::default(),
        agent_slots: Arc::new(tokio::sync::Semaphore::new(parallel)),
        delegate_cards: Arc::default(),
        usage: Arc::new(Mutex::new(RunUsage {
            run_id: run_id.to_string(),
            prompt_tokens: 0,
            completion_tokens: 0,
            cached_tokens: 0,
            elapsed_ms: 0,
        })),
        started: std::time::Instant::now(),
        mcp_tools: Arc::new(
            mcp.iter()
                .map(|b| (b.name.clone(), (b.server.name.clone(), b.tool.read_only)))
                .collect(),
        ),
        cwd: Arc::new(Mutex::new(root.to_path_buf())),
        no_temperature: Arc::default(),
    };

    let has_helpers = req.subagents.iter().any(|s| !s.name.trim().is_empty());
    let mut preamble = system.to_string();
    // Facts the model otherwise guesses wrong: which OS and shell, where it
    // is, and today's date (for web searches and "latest version" questions).
    preamble.push_str(&format!(
        "\n\nEnvironment:\n- {}\n- Workspace: {} (the starting working directory; change_dir moves it)\n- Today: {}\n\
         Prefer the dedicated tools over shell one-liners: find_files / list_dir / grep to look around, \
         read_file to read, apply_patch to edit, file_op to create folders or move / copy / delete, git for git, \
         web_search + web_fetch for anything on the internet (never curl/wget for reading pages). \
         Use run_command for builds, tests, package managers and project scripts; \
         start dev servers and watchers with background:true. \
         When a command fails, read its error and hint and change the approach — never rerun it unchanged.",
        tools::shell_summary(),
        root.display(),
        today()
    ));
    if has_helpers {
        preamble.push_str(&format!(
            "\n\nHelper agents are available through the `delegate` tool (up to {parallel} at once). They are optional: do simple or tightly coupled work yourself, and delegate only self-contained parts that match a helper's specialty."
        ));
    }
    if !skills.is_empty() {
        preamble.push_str(
            "\n\nSkills — instruction packs for particular kinds of tasks. When the request matches a skill's description, call the `skill` tool with its name BEFORE you start, then follow it:",
        );
        for s in skills.iter() {
            preamble.push_str(&format!("\n- {}: {}", s.name, one_line(&s.description, 300)));
        }
    }
    if !mcp.is_empty() {
        preamble.push_str(
            "\n\nTools named mcp__<server>__<tool> come from MCP servers the user connected; use them when they fit the task better than the built-in tools.",
        );
    }
    let tools = || {
        let mut t = fs_tools(&ctx);
        if has_helpers {
            t.push(delegate_tool(&ctx));
        }
        if !skills.is_empty() {
            t.push(skill_tool(skills.clone()));
        }
        t.extend(mcp.iter().map(mcp_tool));
        t
    };
    // /commands, invoked skills and @mentions → what the model reads. File
    // IO and git run off the async workers.
    let turns = {
        let (skills, root) = (skills.clone(), root.to_path_buf());
        tokio::task::spawn_blocking(move || {
            let is_user = |r: &str| r != "agent" && r != "assistant";
            let last_user = turns.iter().rposition(|t| is_user(&t.role));
            turns
                .into_iter()
                .enumerate()
                .map(|(i, mut t)| {
                    if is_user(&t.role) {
                        t.text = super::expand::user_turn(&t.text, &skills, &root, Some(i) == last_user);
                    }
                    t
                })
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|e| format!("prompt expansion failed: {e}"))?
    };
    let (history, prompt) = to_messages(req, &turns);
    let text = run_with_retry(&ctx, &preamble, tools, None, prompt, history, parallel, true, |_| {}).await?;
    if text.trim().is_empty() && ctx.counter.load(Ordering::SeqCst) == 0 {
        return Err(
            "the model returned an empty answer — its output may have been reasoning-only; retry, or try another model/effort level".into(),
        );
    }
    Ok(text)
}

/// Today's date (UTC) as YYYY-MM-DD.
fn today() -> String {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0) as i64;
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn today_is_a_date() {
        let t = today();
        assert_eq!(t.len(), 10);
        assert!(t.starts_with("20"));
    }

    #[test]
    fn gates_follow_the_tool() {
        let ws = if cfg!(windows) { "C:/proj" } else { "/proj" };
        assert!(permission_gate("git", &json!({"subcommand": "status"}), ws, ws, false).is_none());
        assert!(permission_gate("git", &json!({"subcommand": "commit", "args": ["-m", "x"]}), ws, ws, false).is_some());
        assert!(permission_gate("git", &json!({"subcommand": "commit", "args": ["-m", "x"]}), ws, ws, true).is_none());
        assert!(permission_gate("git", &json!({"subcommand": "reset", "args": ["--hard"]}), ws, ws, true).is_some());
        assert!(permission_gate("file_op", &json!({"op": "delete", "path": "a"}), ws, ws, false).is_some());
        assert!(permission_gate("file_op", &json!({"op": "delete", "path": "a"}), ws, ws, true).is_none());
        assert!(permission_gate("file_op", &json!({"op": "mkdir", "path": "a/b"}), ws, ws, false).is_none());
        assert!(permission_gate("web_fetch", &json!({"url": "https://x"}), ws, ws, false).is_none());
    }

    #[test]
    fn partial_field_reads_truncated_json() {
        assert_eq!(partial_field(r#"{"path":"src/ma"#, "path").as_deref(), Some("src/ma"));
        assert_eq!(partial_field(r#"{"path": "a\"b", "diff":"x"#, "path").as_deref(), Some("a\"b"));
        assert_eq!(partial_field(r#"{"diff":"x"#, "path"), None);
    }

    #[test]
    fn live_summary_uses_full_json_when_complete() {
        assert_eq!(live_summary("list_dir", r#"{"path":"src"}"#), "src");
        assert!(live_summary("apply_patch", r#"{"path":"a.rs","diff":"<<<"#).starts_with("a.rs"));
    }

    #[test]
    fn canonical_ignores_formatting() {
        let a: Value = serde_json::from_str(r#"{ "agent": "X",  "task": "t" }"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"agent":"X","task":"t"}"#).unwrap();
        assert_eq!(canonical(&a), canonical(&b));
    }
}
