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
    ask_confirm, cancelled_result, emit_retry, emit_step, emit_text, emit_think, emit_usage, is_cancelled,
    model, run_ssh_tool, AgentRequest, RunUsage, SubagentDef, MAX_TURNS,
};
use crate::tools;
use futures_util::StreamExt;
use rig_agent::agent::{
    AgentBuilder, AgentHook, CompletionCallAction, CompletionCallEvent, HookContext,
    MultiTurnStreamItem, ObservationAction, StreamResponseFinish, ToolCall, ToolCallAction,
    ToolCallDelta, ToolResultAction, ToolResultEvent,
};
use rig_agent::core::completion::message::{AssistantContent, ImageMediaType, Message, UserContent};
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

/// Upper bound of "Max agents at once".
pub(super) const MAX_AGENTS: usize = 52;
/// Name of the built-in general-purpose helper.
const WORKER: &str = "worker";

/* ---------- Shared run state ---------- */

/// State shared by the main agent, its hook, its tools and every subagent of
/// one run. Cheap to clone (all Arcs).
#[derive(Clone)]
struct RunCtx {
    app: AppHandle,
    run_id: String,
    req: Arc<AgentRequest>,
    root: PathBuf,
    /// Rig internal call id → the UI cards opened under it. Normally one per
    /// id, but gateways / local servers can hand several parallel calls the
    /// same id — each (id, call fingerprint) then keeps a card of its own
    /// instead of all of them overwriting one ("list_dir shown as a failed
    /// Edit").
    steps: Arc<Mutex<HashMap<String, Vec<CallCard>>>>,
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

    fn next_index(&self) -> usize {
        self.counter.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Card of a call whose arguments are still streaming.
    fn live_step(&self, internal_id: &str) -> usize {
        let mut map = self.steps.lock().unwrap();
        let cards = map.entry(internal_id.to_string()).or_default();
        if let Some(c) = cards.iter().find(|c| c.call.is_none()) {
            return c.index;
        }
        let index = self.next_index();
        cards.push(CallCard { call: None, index, done: false });
        index
    }

    /// Card of a call about to run: the live card of its id if one is still
    /// unclaimed, else a new one.
    fn call_step(&self, internal_id: &str, fingerprint: &str) -> usize {
        let mut map = self.steps.lock().unwrap();
        let cards = map.entry(internal_id.to_string()).or_default();
        if let Some(c) = cards.iter_mut().find(|c| c.call.is_none()) {
            c.call = Some(fingerprint.to_string());
            return c.index;
        }
        let index = self.next_index();
        cards.push(CallCard { call: Some(fingerprint.to_string()), index, done: false });
        index
    }

    /// How many calls ran under this Rig call id (> 1 = the gateway reused it).
    fn cards_under(&self, internal_id: &str) -> usize {
        self.steps.lock().unwrap().get(internal_id).map_or(0, |c| c.iter().filter(|c| c.call.is_some()).count())
    }

    /// Card a finished call's result belongs to: the one opened for exactly
    /// this call (id + fingerprint).
    fn result_step(&self, internal_id: &str, fingerprint: &str) -> usize {
        let mut map = self.steps.lock().unwrap();
        let cards = map.entry(internal_id.to_string()).or_default();
        let pick = cards
            .iter()
            .position(|c| !c.done && c.call.as_deref() == Some(fingerprint))
            .or_else(|| cards.iter().position(|c| !c.done && c.call.is_none()));
        match pick {
            Some(i) => {
                cards[i].done = true;
                cards[i].index
            }
            None => {
                let index = self.next_index();
                cards.push(CallCard { call: Some(fingerprint.to_string()), index, done: true });
                index
            }
        }
    }

    fn add_usage(&self, input: u64, output: u64, cached: u64) {
        let mut u = self.usage.lock().unwrap();
        if u.first_input == 0 {
            u.first_input = input;
        }
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

/// One UI card under a Rig call id.
struct CallCard {
    /// Fingerprint (`tool(args)`) of the call that claimed it; None while
    /// its arguments are still streaming.
    call: Option<String>,
    index: usize,
    done: bool,
}

/// Arguments as an object: some providers send them as a JSON *string*
/// (`"{\"command\":…}"`), which the hook and the tool then saw differently.
fn norm_args(args: &Value) -> Value {
    let mut v = match args {
        Value::String(s) => serde_json::from_str::<Value>(s)
            .ok()
            .filter(|v| v.is_object())
            .unwrap_or_else(|| args.clone()),
        _ => args.clone(),
    };
    coerce_types(&mut v);
    v
}

/// Integer parameters of the built-in tools.
const INT_ARGS: &[&str] = &["start_line", "end_line", "timeout_secs", "max_results", "start", "id", "max_chars"];
/// Boolean parameters of the built-in tools.
const BOOL_ARGS: &[&str] = &["create", "background"];

/// Models often send numbers and booleans as strings (`"start_line": "2001"`)
/// or floats (`2001.0`). The tools read them strictly, so such a value was
/// silently ignored — read_file then returned line 1 onward again and again
/// while the model asked for the next part: a read loop with no edit.
fn coerce_types(args: &mut Value) {
    let Value::Object(map) = args else { return };
    for (k, v) in map.iter_mut() {
        if INT_ARGS.contains(&k.as_str()) {
            let n = match &*v {
                Value::String(s) => s.trim().parse::<f64>().ok(),
                Value::Number(n) if n.as_u64().is_none() => n.as_f64(),
                _ => None,
            };
            if let Some(n) = n.filter(|n| n.is_finite() && *n >= 0.0) {
                *v = json!(n.round() as u64);
            }
        } else if BOOL_ARGS.contains(&k.as_str()) {
            if let Value::String(s) = &*v {
                match s.trim().to_ascii_lowercase().as_str() {
                    "true" | "yes" | "1" => *v = json!(true),
                    "false" | "no" | "0" | "" => *v = json!(false),
                    _ => {}
                }
            }
        }
    }
}

/// Parses the raw argument text the hooks get.
fn parse_args(raw: &str) -> Value {
    norm_args(&serde_json::from_str(raw).unwrap_or(json!({})))
}

/// `tool(args)` — identifies one call independent of Rig's call id.
fn fingerprint(tool: &str, args: &Value) -> String {
    format!("{tool}({})", canonical(&norm_args(args)))
}

/// Tool results by call fingerprint, filled by the tools themselves. The
/// hook reads the card's result from here: Rig's per-call ToolContext is
/// keyed by its call id, and calls that share an id also shared (and
/// overwrote) each other's result.
static RESULTS: Mutex<Option<HashMap<String, Vec<tools::ToolResult>>>> = Mutex::new(None);

fn stash_result(fingerprint: String, res: &tools::ToolResult) {
    if let Ok(mut g) = RESULTS.lock() {
        g.get_or_insert_with(HashMap::new).entry(fingerprint).or_default().push(res.clone());
    }
}

fn take_result(fingerprint: &str) -> Option<tools::ToolResult> {
    let mut g = RESULTS.lock().ok()?;
    let map = g.as_mut()?;
    let key = if map.contains_key(fingerprint) {
        fingerprint.to_string()
    } else {
        // Same tool, arguments serialized a little differently: accept it
        // only when exactly one result of that tool is waiting.
        let tool = fingerprint.split('(').next().unwrap_or("");
        let prefix = format!("{tool}(");
        let mut same = map.keys().filter(|k| k.starts_with(&prefix));
        match (same.next(), same.next()) {
            (Some(k), None) => k.clone(),
            _ => return None,
        }
    };
    let fingerprint = key.as_str();
    let list = map.get_mut(fingerprint)?;
    let res = (!list.is_empty()).then(|| list.remove(0));
    if list.is_empty() {
        map.remove(fingerprint);
    }
    res
}

/* ---------- Context editing ---------- */

/// Text size of one tool result.
fn result_chars(r: &rig_agent::core::completion::message::ToolResult) -> usize {
    use rig_agent::core::completion::message::ToolResultContent;
    r.content
        .iter()
        .map(|c| match c {
            ToolResultContent::Text(t) => t.text.len(),
            ToolResultContent::Json { value } => value.to_string().len(),
            ToolResultContent::Image(_) => 1_000,
        })
        .sum()
}

/// Returns the history to send with the oldest bulky tool results stubbed
/// (None = send it unchanged). `cleared` is the hook's watermark: it only
/// ever moves forward, and only when the history outgrew the trigger.
fn clear_old_results(history: &[Message], cleared: &mut usize) -> Option<Vec<Message>> {
    use rig_agent::core::completion::message::ToolResultContent;
    // Clearable results in order: (message, content index, size). A helper's
    // report and loaded skill instructions are the agent's working notes —
    // they are never cleared.
    let mut results = Vec::new();
    for (mi, m) in history.iter().enumerate() {
        if let Message::User { content } = m {
            for (ci, c) in content.iter().enumerate() {
                if let UserContent::ToolResult(r) = c {
                    let size = result_chars(r);
                    if size >= CLEAR_MIN_CHARS && r.name != "delegate" && r.name != "skill" {
                        results.push((mi, ci, size));
                    }
                }
            }
        }
    }
    let clearable = results.len().saturating_sub(CLEAR_KEEP_RECENT);
    *cleared = (*cleared).min(clearable);
    let total: usize = history.iter().map(|m| serde_json::to_string(m).map(|j| j.len()).unwrap_or(0)).sum();
    let freed = |n: usize| results[..n].iter().map(|r| r.2.saturating_sub(CLEARED_STUB.len())).sum::<usize>();
    if total.saturating_sub(freed(*cleared)) > CLEAR_TRIGGER_CHARS {
        while *cleared < clearable && total.saturating_sub(freed(*cleared)) > CLEAR_TARGET_CHARS {
            *cleared += 1;
        }
    }
    if *cleared == 0 {
        return None;
    }
    let mut out = history.to_vec();
    for &(mi, ci, _) in &results[..*cleared] {
        if let Message::User { content } = &mut out[mi] {
            if let Some(UserContent::ToolResult(r)) = content.get_mut(ci) {
                r.content = vec![ToolResultContent::text(CLEARED_STUB)];
            }
        }
    }
    Some(out)
}

/* ---------- Hook: live cards, approvals, guard, limiter ---------- */

/// Arguments of a call still streaming, for the live card.
#[derive(Default)]
struct LiveCall {
    name: String,
    args: String,
    shown: usize,
    /// When the card was last updated (edits update on a timer).
    at: Option<std::time::Instant>,
    /// An edit's target as it is on disk (read once): (path, content).
    before: Option<(String, Option<String>)>,
}

/// Argument growth (chars) between two live card updates.
const LIVE_ARGS_STEP: usize = 400;
/// Pause between two live previews of an edit being written.
const LIVE_EDIT_EVERY: std::time::Duration = std::time::Duration::from_millis(90);
/// Identical consecutive tool calls tolerated before they are skipped.
const REPEAT_SKIP_AT: usize = 3;
/// …and before the run is stopped outright.
const REPEAT_STOP_AT: usize = 5;
/// Marker of the repeat guard's stop — deliberate, never retried.
const GUARD_STOP: &str = "the model repeated the same action";
/// Context editing — the client-side twin of Anthropic's `clear_tool_uses`:
/// once the conversation inside a run grows past CLEAR_TRIGGER_CHARS, the
/// OLDEST bulky tool results are replaced by a stub until it is back under
/// CLEAR_TARGET_CHARS. The most recent results always stay. Clearing jumps
/// in big steps and then holds still, so the prompt prefix stays byte-stable
/// between jumps and the provider's prompt cache keeps hitting.
const CLEAR_TRIGGER_CHARS: usize = 160_000;
const CLEAR_TARGET_CHARS: usize = 80_000;
/// Newest tool results that are never cleared.
const CLEAR_KEEP_RECENT: usize = 6;
/// Results shorter than this are not worth clearing.
const CLEAR_MIN_CHARS: usize = 600;
const CLEARED_STUB: &str = "[older tool result cleared to save context — call the tool again if you still need it]";
/// Pause between retries of a failed model request.
const RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(5);

/// The latest model request of one logical run — (prompt, history) exactly
/// as Rig is about to send it. After a failure the run resumes from here.
type Snapshot = Arc<Mutex<Option<(Message, Vec<Message>)>>>;
/// The assistant content of the latest finished model turn.
type Finished = Arc<Mutex<Option<Vec<AssistantContent>>>>;

struct UiHook {
    ctx: RunCtx,
    snapshot: Snapshot,
    /// "[Helper] " prefix for subagent cards; empty for the main agent.
    label: String,
    permit: Mutex<Option<crate::limiter::Permit>>,
    live: Mutex<HashMap<String, LiveCall>>,
    last_call: Mutex<(String, usize)>,
    /// How many of the clearable tool results (oldest first) are stubbed.
    cleared: Mutex<usize>,
    /// Files this agent has read; forgotten when old results get stubbed.
    memo: ReadMemo,
    /// What the model answered in its latest finished turn.
    finished: Finished,
}

impl UiHook {
    fn new(ctx: RunCtx, label: Option<&str>, snapshot: Snapshot, memo: ReadMemo, finished: Finished) -> Self {
        Self {
            ctx,
            snapshot,
            label: label.map(|l| format!("[{l}] ")).unwrap_or_default(),
            permit: Mutex::new(None),
            live: Mutex::new(HashMap::new()),
            last_call: Mutex::new((String::new(), 0)),
            cleared: Mutex::new(0),
            memo,
            finished,
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
        let mut cleared = self.cleared.lock().unwrap();
        let before = *cleared;
        let patched = clear_old_results(event.history, &mut cleared);
        if *cleared != before {
            // Earlier file contents may be stubs now: reading again is real.
            self.memo.forget();
        }
        match patched {
            Some(history) => CompletionCallAction::patch(rig_agent::agent::RequestPatch::new().history(history)),
            None => CompletionCallAction::Continue,
        }
    }

    /// The provider slot is free once the stream ends — tools and approval
    /// banners must not hold it.
    async fn on_stream_response_finish(&self, _ctx: &HookContext, event: StreamResponseFinish<'_>) -> ObservationAction {
        self.permit.lock().unwrap().take();
        *self.finished.lock().unwrap() = Some(event.content.clone());
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
            let edit = matches!(call.name.as_str(), "write_file" | "apply_patch");
            // An edit shows the file taking shape as the model writes it —
            // on a short timer; other cards only every few hundred chars.
            let due = if edit {
                call.args.len() > call.shown && call.at.is_none_or(|t| t.elapsed() >= LIVE_EDIT_EVERY)
            } else {
                call.args.len() >= call.shown + LIVE_ARGS_STEP
            };
            if call.name.is_empty() || (!first && !due) {
                None
            } else {
                call.shown = call.args.len().max(1);
                call.at = Some(std::time::Instant::now());
                let preview = if edit { live_edit(call, &self.ctx.cwd()) } else { None };
                Some((call.name.clone(), live_summary(&call.name, &call.args), preview))
            }
        };
        if let Some((name, input, preview)) = update {
            let idx = self.ctx.live_step(event.internal_call_id);
            let res = match preview {
                Some((path, old, new)) => tools::ToolResult::ok("").with_change(&path, old, new),
                None => tools::ToolResult::ok(""),
            };
            self.step(idx, &name, input, false, &res);
        }
        ObservationAction::Continue
    }

    /// Before execution: repeat guard, start card, Allow/Deny gate.
    async fn on_tool_call(&self, _ctx: &HookContext, event: ToolCall<'_>) -> ToolCallAction {
        if is_cancelled(&self.ctx.run_id) {
            return ToolCallAction::Stop(crate::cancel::STOPPED.to_string());
        }
        let args = parse_args(event.args);
        let summary = summarize(event.tool_name, &args);
        let idx = self.ctx.call_step(event.internal_call_id, &fingerprint(event.tool_name, &args));
        // The streamed-args buffer of this id is done; a later call that
        // reuses the id must not inherit its name and arguments.
        self.live.lock().unwrap().remove(event.internal_call_id);
        if event.tool_name == "delegate" {
            self.ctx.delegate_cards.lock().unwrap().insert(canonical(&args), idx);
        }
        // A CLI model's request line whose JSON could not be read: nothing
        // runs, the model gets the parser's error and how to write it.
        if let Some(err) = args.get(crate::cli::protocol::INVALID_JSON).and_then(|v| v.as_str()) {
            self.step(idx, event.tool_name, summary, true, &tools::ToolResult::err(format!("invalid call JSON: {err}")));
            return ToolCallAction::Skip(format!(
                "ERROR: this {} request line was not valid JSON ({err}), so nothing ran. Send it again as ONE line of valid JSON: \
                 inside strings write line breaks as \\n, quotes as \\\" and backslashes as \\\\. \
                 For a long change prefer several small apply_patch calls.",
                event.tool_name
            ));
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
        // mcp_call is gated as the MCP tool it runs.
        let mcp_target = if event.tool_name == "mcp_call" {
            let name = args.get("tool").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let hit = self.ctx.mcp_tools.get_key_value(name.as_str()).or_else(|| {
                let tail = format!("__{name}");
                let mut hits = self.ctx.mcp_tools.iter().filter(|(k, _)| k.ends_with(&tail));
                let first = hits.next()?;
                hits.next().is_none().then_some(first)
            });
            // Unknown name: the tool itself reports it, nothing runs.
            hit.map(|(k, v)| (k.clone(), v.clone(), args.get("arguments").cloned().unwrap_or(Value::Null)))
        } else {
            self.ctx.mcp_tools.get(event.tool_name).map(|v| (event.tool_name.to_string(), v.clone(), args.clone()))
        };
        let gate = match (event.tool_name == "mcp_call", mcp_target) {
            (_, Some((tool, (server, read_only), shown))) => (!self.ctx.req.auto_run && !read_only).then(|| Gate {
                what: format!("{tool} {}", one_line(&canonical(&shown), 200)),
                place: format!("MCP server {server}"),
                reason: String::new(),
            }),
            (true, None) => None,
            (false, None) => permission_gate(
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
        let args = parse_args(event.args);
        let fp = fingerprint(event.tool_name, &args);
        let shared_id = self.ctx.cards_under(event.internal_call_id) > 1;
        let idx = self.ctx.result_step(event.internal_call_id, &fp);
        // Rig's ToolContext is per call id — with a reused id it may hold
        // ANOTHER call's result ("npm install" showing a list_dir listing),
        // so it is only trusted when the id is unique.
        let res = take_result(&fp)
            .or_else(|| (!shared_id).then(|| event.tool_context.result::<tools::ToolResult>().cloned()).flatten())
            .unwrap_or_else(|| tools::ToolResult::ok(event.presentation.render()));
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
        "generate_image" => "prompt",
        "git" => "subcommand",
        "delegate" => "agent",
        "skill" => "name",
        "mcp_find" => "query",
        "mcp_call" => "tool",
        _ => "path",
    };
    let head = partial_field(args, key).unwrap_or_default();
    if args.len() < 64 {
        format!("{head}…")
    } else {
        format!("{head} … ({} chars)", args.len())
    }
}

/// The file an edit is writing, as it will look once the arguments that
/// arrived so far are applied: (path, before, after). write_file shows its
/// content so far; apply_patch its finished SEARCH/REPLACE blocks plus the
/// one being written. None until the path is complete.
fn live_edit(call: &mut LiveCall, cwd: &Path) -> Option<(String, Option<String>, String)> {
    let path = json_string(&call.args, "path", false)?;
    if path.trim().is_empty() {
        return None;
    }
    if call.before.as_ref().is_none_or(|(p, _)| *p != path) {
        let text = tools::resolve(cwd, &path).ok().and_then(|f| std::fs::read_to_string(f).ok());
        call.before = Some((path.clone(), text));
    }
    let before = call.before.as_ref().and_then(|(_, t)| t.clone());
    let after = if call.name == "write_file" {
        json_string(&call.args, "content", true)?
    } else {
        preview_patch(before.as_deref().unwrap_or(""), &json_string(&call.args, "diff", true)?)
    };
    Some((path, before, after))
}

/// `text` with the SEARCH/REPLACE blocks of a (possibly unfinished) diff
/// applied — exact matches only; it is a preview, the tool decides.
fn preview_patch(text: &str, diff: &str) -> String {
    let mut out = text.to_string();
    let mut swap = |search: &str, replace: &str| {
        if search.trim().is_empty() {
            out = replace.to_string();
        } else if let Some(at) = out.find(search) {
            out.replace_range(at..at + search.len(), replace);
        }
    };
    for (search, replace) in tools::parse_patch(diff) {
        swap(&search, &replace);
    }
    // The block still being written: its SEARCH is complete once the
    // ======= line arrived; the REPLACE side so far takes its place.
    let lines: Vec<&str> = diff.lines().collect();
    let open = lines.iter().rposition(|l| l.trim_start().starts_with("<<<<<<<"));
    if let Some(open) = open {
        let rest = &lines[open + 1..];
        if !rest.iter().any(|l| l.trim_start().starts_with(">>>>>>>")) {
            if let Some(mid) = rest.iter().position(|l| l.trim() == "=======") {
                swap(&rest[..mid].join("\n"), &rest[mid + 1..].join("\n"));
            }
        }
    }
    out
}

/// A string field of a possibly truncated JSON object, unescaped. `open`:
/// accept a value still being written (no closing quote yet).
fn json_string(json: &str, key: &str, open: bool) -> Option<String> {
    let pat = format!("\"{key}\"");
    let at = json.find(&pat)? + pat.len();
    let rest = json[at..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => match chars.next()? {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'r' => out.push('\r'),
                'b' => out.push('\u{8}'),
                'f' => out.push('\u{c}'),
                'u' => {
                    let hex: String = chars.by_ref().take(4).collect();
                    let mut code = u32::from_str_radix(&hex, 16).ok()?;
                    // A surrogate pair: the low half follows as \uXXXX.
                    if (0xD800..0xDC00).contains(&code) {
                        let tail: String = chars.by_ref().take(6).collect();
                        let low = tail.strip_prefix("\\u").and_then(|h| u32::from_str_radix(h, 16).ok())?;
                        code = 0x10000 + ((code - 0xD800) << 10) + (low.wrapping_sub(0xDC00) & 0x3FF);
                    }
                    out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                }
                other => out.push(other),
            },
            c => out.push(c),
        }
    }
    open.then_some(out)
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

/// Files one agent has read in this run: path → (content hash, reads of
/// that content). Every read returns the real file — a "you read it
/// already" stub instead of the text left models re-reading in a circle and
/// never editing. Reading the same unchanged file over and over gets a
/// nudge appended to the real content instead; any edit resets the count.
#[derive(Clone, Default)]
/// Keyed by path and the requested line range: paging through a long file
/// is not re-reading.
#[allow(clippy::type_complexity)]
struct ReadMemo(Arc<Mutex<HashMap<(PathBuf, String), (u64, usize)>>>);

/// Reads of one unchanged file before the result carries the nudge.
const REREAD_NUDGE_AT: usize = 3;

impl ReadMemo {
    fn forget(&self) {
        self.0.lock().unwrap().clear();
    }

    /// An edit tool touched this file (applied or failed): its read count
    /// starts over.
    fn forget_path(&self, root: &Path, path: &str) {
        if let Ok(full) = tools::resolve(root, path) {
            self.0.lock().unwrap().retain(|(p, _), _| *p != full);
        }
    }

    fn read(&self, root: &Path, args: &Value) -> tools::ToolResult {
        let mut res = tools::dispatch(root, "read_file", args);
        if !res.ok {
            return res;
        }
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let Some((full, hash)) = tools::resolve(root, path).ok().and_then(|full| {
            use std::hash::{Hash, Hasher};
            let bytes = std::fs::read(&full).ok()?;
            let mut h = std::collections::hash_map::DefaultHasher::new();
            bytes.hash(&mut h);
            Some((full, h.finish()))
        }) else {
            return res;
        };
        let count = {
            let mut map = self.0.lock().unwrap();
            let range = format!("{}-{}", args.get("start_line").unwrap_or(&Value::Null), args.get("end_line").unwrap_or(&Value::Null));
            let entry = map.entry((full, range)).or_insert((hash, 0));
            if entry.0 != hash {
                *entry = (hash, 0);
            }
            entry.1 += 1;
            entry.1
        };
        if count >= REREAD_NUDGE_AT {
            res.output.push_str(&format!(
                "\n[You have read {path} {count} times in this task and it has not changed. \
                 Stop reading it: make the change now with apply_patch (SEARCH copied from the lines above) \
                 or write_file, or tell the user what blocks you.]"
            ));
        }
        res
    }
}

/// The filesystem / command / SSH tools, as Rig dynamic tools.
fn fs_tools(ctx: &RunCtx, memo: &ReadMemo) -> Vec<DynamicTool> {
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
            let memo = memo.clone();
            let tool_name = name.clone();
            DynamicTool::new(
                name,
                description,
                parameters,
                tool_fn(move |tctx, args| {
                    let c = c.clone();
                    let memo = memo.clone();
                    let tool_name = tool_name.clone();
                    Box::pin(async move {
                        let args = norm_args(&args);
                        let fp = fingerprint(&tool_name, &args);
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
                            "generate_image" => crate::imagegen::tool(&c.app, c.req.image_gen.as_ref(), &args).await,
                            "read_file" => {
                                let root = c.cwd();
                                tokio::task::spawn_blocking(move || memo.read(&root, &args))
                                    .await
                                    .unwrap_or_else(|e| tools::ToolResult::err(format!("tool task failed: {e}")))
                            }
                            _ => {
                                let root = c.cwd();
                                if matches!(tool_name.as_str(), "apply_patch" | "write_file" | "edit_file" | "file_op") {
                                    memo.forget_path(&root, &get("path"));
                                    memo.forget_path(&root, &get("to"));
                                }
                                // Tools block (file IO, processes): keep the async
                                // workers free so events keep flowing.
                                tokio::task::spawn_blocking(move || tools::dispatch(&root, &tool_name, &args))
                                    .await
                                    .unwrap_or_else(|e| tools::ToolResult::err(format!("tool task failed: {e}")))
                            }
                        };
                        let text = model_text(&res);
                        stash_result(fp, &res);
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
                let args = norm_args(&args);
                let fp = fingerprint("delegate", &args);
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
                stash_result(fp, &res);
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
                let args = norm_args(&args);
                let fp = fingerprint("skill", &args);
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
                stash_result(fp, &res);
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
    let model_name = b.name.clone();
    DynamicTool::new(
        b.name.clone(),
        desc,
        b.tool.input_schema.clone(),
        tool_fn(move |tctx, args| {
            let (server, tool_name) = (server.clone(), tool_name.clone());
            let args = norm_args(&args);
            let fp = fingerprint(&model_name, &args);
            Box::pin(async move {
                let res = match crate::mcp::call(&server, &tool_name, args).await {
                    Ok((text, false)) => tools::ToolResult::ok(text),
                    Ok((text, true)) => tools::ToolResult::err(text),
                    Err(e) => tools::ToolResult::err(e),
                };
                let text = model_text(&res);
                stash_result(fp, &res);
                tctx.insert_result(res);
                Ok(ToolOutput::text(text))
            })
        }),
    )
}

/// MCP schemas above this many tokens are not sent inline (see mcp_deferred).
const MCP_INLINE_TOKENS: usize = 6_000;

fn mcp_schema_tokens(mcp: &[McpBinding]) -> usize {
    mcp.iter()
        .map(|b| est_tokens(&format!("{}{}{}", b.name, b.tool.description, b.tool.input_schema)))
        .sum()
}

/// Whether MCP tools are offered through mcp_find / mcp_call instead of one
/// tool each. A dozen servers (Playwright, DevTools…) carry 20k+ tokens of
/// schemas into EVERY request: on a local model reading ~40 tokens/s that
/// was minutes before the first word and more than its whole window (Ollama
/// then silently cuts the prompt's start — the model lost its instructions
/// and never finished). Local models always defer; others once it is big.
fn mcp_deferred(req: &AgentRequest, mcp: &[McpBinding]) -> bool {
    !mcp.is_empty() && (req.kind == "ollama" || mcp_schema_tokens(mcp) > MCP_INLINE_TOKENS)
}

/// The MCP binding a model-given name points at: the full
/// `mcp__server__tool` name, or the bare tool name when that is unique.
fn find_mcp<'a>(mcp: &'a [McpBinding], name: &str) -> Option<&'a McpBinding> {
    let name = name.trim();
    mcp.iter().find(|b| b.name == name).or_else(|| {
        let mut hits = mcp.iter().filter(|b| b.tool.name == name);
        let first = hits.next()?;
        hits.next().is_none().then_some(first)
    })
}

/// Catalog for the system prompt: server → tool names, no schemas.
fn mcp_catalog(mcp: &[McpBinding]) -> String {
    let mut out = String::from(
        "\n\nMCP tools — extra tools from servers the user connected. Their parameters are NOT loaded: \
         call mcp_find with what you need (or an exact tool name) to get its name and parameters, \
         then run it with mcp_call {tool, arguments}. Use them when they fit better than the built-in tools.",
    );
    let mut servers: Vec<&str> = Vec::new();
    for b in mcp {
        if !servers.contains(&b.server.name.as_str()) {
            servers.push(&b.server.name);
        }
    }
    for server in servers {
        let names: Vec<&str> = mcp.iter().filter(|b| b.server.name == server).map(|b| b.name.as_str()).collect();
        out.push_str(&format!("\n- {server}: {}", names.join(", ")));
    }
    out
}

/// `mcp_find`: full name, description and parameters of matching MCP tools.
fn mcp_find_tool(mcp: Arc<Vec<McpBinding>>) -> DynamicTool {
    DynamicTool::new(
        "mcp_find",
        "Look up MCP tools listed in the system prompt: returns their exact names, descriptions and parameter schemas. Pass keywords (\"screenshot\", \"navigate page\") or an exact tool name.",
        json!({
            "type": "object",
            "properties": { "query": { "type": "string", "description": "Keywords or an exact tool name." } },
            "required": ["query"]
        }),
        tool_fn(move |tctx, args| {
            let mcp = mcp.clone();
            Box::pin(async move {
                let args = norm_args(&args);
                let fp = fingerprint("mcp_find", &args);
                let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
                let words: Vec<&str> = query.split(|c: char| !c.is_alphanumeric() && c != '_').filter(|w| w.len() > 1).collect();
                let mut scored: Vec<(usize, &McpBinding)> = match find_mcp(&mcp, &query) {
                    Some(b) => vec![(usize::MAX, b)],
                    None => mcp
                        .iter()
                        .map(|b| {
                            let hay = format!("{} {} {}", b.name, b.server.name, b.tool.description).to_lowercase();
                            (words.iter().filter(|w| hay.contains(*w)).count(), b)
                        })
                        .filter(|(n, _)| *n > 0)
                        .collect(),
                };
                scored.sort_by(|a, b| b.0.cmp(&a.0));
                let res = if scored.is_empty() {
                    tools::ToolResult::err(format!("no MCP tool matches {query:?} — pick a name from the list in the system prompt"))
                } else {
                    tools::ToolResult::ok(
                        scored
                            .iter()
                            .take(6)
                            .map(|(_, b)| format!("{}\n{}\nparameters: {}", b.name, one_line(&b.tool.description, 600), b.tool.input_schema))
                            .collect::<Vec<_>>()
                            .join("\n\n"),
                    )
                };
                let text = model_text(&res);
                stash_result(fp, &res);
                tctx.insert_result(res);
                Ok(ToolOutput::text(text))
            })
        }),
    )
}

/// `mcp_call`: runs one MCP tool by name.
fn mcp_call_tool(mcp: Arc<Vec<McpBinding>>) -> DynamicTool {
    DynamicTool::new(
        "mcp_call",
        "Run an MCP tool. Get its exact name and parameters with mcp_find first.",
        json!({
            "type": "object",
            "properties": {
                "tool": { "type": "string", "description": "Exact MCP tool name (mcp__server__tool)." },
                "arguments": { "type": "object", "description": "The tool's parameters, as mcp_find showed them." }
            },
            "required": ["tool"]
        }),
        tool_fn(move |tctx, args| {
            let mcp = mcp.clone();
            Box::pin(async move {
                let args = norm_args(&args);
                let fp = fingerprint("mcp_call", &args);
                let name = args.get("tool").and_then(|v| v.as_str()).unwrap_or("");
                let call_args = match args.get("arguments") {
                    Some(Value::String(s)) => serde_json::from_str(s).unwrap_or_else(|_| json!({})),
                    Some(v) if v.is_object() => v.clone(),
                    _ => json!({}),
                };
                let res = match find_mcp(&mcp, name) {
                    None => tools::ToolResult::err(format!("unknown MCP tool {name:?} — use mcp_find to get the exact name")),
                    Some(b) => match crate::mcp::call(&b.server, &b.tool.name, call_args).await {
                        Ok((text, false)) => tools::ToolResult::ok(text),
                        Ok((text, true)) => tools::ToolResult::err(text),
                        Err(e) => tools::ToolResult::err(e),
                    },
                };
                let text = model_text(&res);
                stash_result(fp, &res);
                tctx.insert_result(res);
                Ok(ToolOutput::text(text))
            })
        }),
    )
}

/* ---------- Agent build + streaming ---------- */

/// Builds one Rig agent (main or helper) on the request's provider.
type CacheSeen = Option<Arc<Mutex<Option<super::cachenet::CacheSeen>>>>;

fn build_agent(ctx: &RunCtx, preamble: &str, tools: Vec<DynamicTool>) -> Result<(rig_agent::Agent, CacheSeen), String> {
    let setup = model::build(&ctx.req)?;
    let seen = setup.cache_seen.clone();
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
    Ok((b.dynamic_tools(tools).build(), seen))
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
    seen: &CacheSeen,
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
                // Input = the WHOLE prompt, cache reads included, for every
                // provider (Anthropic reports reads apart from input).
                let (mut input, mut cached) = if ctx.req.kind == "anthropic-messages" {
                    (u.input_tokens + u.cache_creation_input_tokens + u.cached_input_tokens, u.cached_input_tokens)
                } else {
                    (u.input_tokens + u.cache_creation_input_tokens, u.cached_input_tokens)
                };
                // What the gateway itself reported (fields Rig does not read).
                if let Some(s) = seen.as_ref().and_then(|s| s.lock().unwrap().take()) {
                    cached = cached.max(s.cached);
                    input = input.max(s.prompt);
                    if s.cached > 0 && s.prompt < s.cached {
                        // Anthropic-style report behind the gateway: reads apart from input.
                        input = input.max(s.prompt + s.cached + s.created);
                    }
                }
                ctx.add_usage(input, u.output_tokens, cached);
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
    tools: impl Fn(&ReadMemo) -> Vec<DynamicTool>,
    label: Option<&str>,
    mut prompt: Message,
    mut history: Vec<Message>,
    parallel: usize,
    to_ui: bool,
    carry: Option<&Mutex<Option<Vec<Message>>>>,
    memo: ReadMemo,
    mut on_text: impl FnMut(&str),
) -> Result<String, String> {
    let snapshot: Snapshot = Arc::default();
    let finished: Finished = Arc::default();
    let mut text = String::new();
    let mut attempt = 0usize;
    loop {
        let (agent, seen) = build_agent(ctx, preamble, tools(&memo))?;
        let stream = agent
            .stream_chat(prompt.clone(), history.clone())
            .max_turns(MAX_TURNS)
            // Several delegate calls in one turn run side by side.
            .tool_concurrency(parallel)
            .add_hook(UiHook::new(ctx.clone(), label, snapshot.clone(), memo.clone(), finished.clone()))
            .await;
        let (part, err) = drive(ctx, stream, &seen, to_ui, &mut on_text).await;
        text.push_str(&part);
        let Some(err) = err else {
            // The whole conversation as the model saw it: the last request
            // plus the answer it gave to it.
            if let (Some(out), Some((p, mut h)), Some(answer)) =
                (carry, snapshot.lock().unwrap().take(), finished.lock().unwrap().take())
            {
                h.push(p);
                if !answer.is_empty() {
                    h.push(Message::Assistant { id: None, content: answer });
                }
                *out.lock().unwrap() = Some(h);
            }
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
        emit_retry(&ctx.app, &ctx.run_id, format!("{who}{}", one_line(&err, 300)), attempt, ctx.req.max_retries);
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
    // Helpers batch their own independent tool calls too (several reads /
    // searches in one turn run side by side).
    let parallel = ctx.req.max_agents.clamp(1, 8);
    let result = run_with_retry(ctx, &preamble, |memo| fs_tools(ctx, memo), Some(&def.name), Message::user(task), Vec::new(), parallel, false, None, ReadMemo::default(), |t| {
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
/// The request with the built-in helper added: with room for more than one
/// agent, a general-purpose helper is always there — parallel work no
/// longer depends on the user defining subagents.
fn with_worker(req: &AgentRequest) -> AgentRequest {
    let mut req = req.clone();
    if req.max_agents.clamp(1, MAX_AGENTS) > 1 && !req.subagents.iter().any(|s| s.name == WORKER) {
        req.subagents.push(SubagentDef {
            name: WORKER.into(),
            description: "General-purpose helper for a LARGE, independent part of the task: exploring a separate area of a big codebase, a long web research, a sizable change confined to its own files. It starts knowing nothing — give it everything it needs in `task`.".into(),
            prompt: "Work fast: batch independent tool calls into one turn.".into(),
        });
    }
    req
}

fn has_helpers(req: &AgentRequest) -> bool {
    req.subagents.iter().any(|s| !s.name.trim().is_empty())
}

/// The system prompt as labelled sections; joined, they are the preamble.
/// The context view measures the very same sections.
fn preamble_sections(
    system: &str,
    req: &AgentRequest,
    root: &Path,
    skills: &[crate::skills::Skill],
    mcp: &[McpBinding],
) -> Vec<(&'static str, String)> {
    let parallel = req.max_agents.clamp(1, MAX_AGENTS);
    let mut out: Vec<(&'static str, String)> = vec![("System prompt", system.to_string())];
    // Facts the model otherwise guesses wrong: which OS and shell, where it
    // is, and today's date (for web searches and "latest version" questions).
    // Only name the tools this run has (Settings → Plugins can switch some off).
    let on = |name: &str| !req.disabled_tools.iter().any(|d| d == name);
    let mut prefer = String::from(
        "Prefer the dedicated tools over shell one-liners: find_files / list_dir / grep to look around, \
         read_file to read, apply_patch to edit, file_op to create folders or move / copy / delete",
    );
    if on("git") {
        prefer.push_str(", git for git");
    }
    if on("web_search") || on("web_fetch") {
        prefer.push_str(", web_search + web_fetch for anything on the internet (never curl/wget for reading pages)");
    }
    prefer.push_str(". ");
    if on("run_command") {
        prefer.push_str(
            "Use run_command for builds, tests, package managers and project scripts; \
             start dev servers and watchers with background:true. \
             When a command fails, read its error and hint and change the approach — never rerun it unchanged.",
        );
    }
    let mut env = format!(
        "\n\nEnvironment:\n- {}\n- Workspace: {} (the starting working directory; change_dir moves it)\n- Today: {}\n{prefer}",
        tools::shell_summary(),
        root.display(),
        today()
    );
    if has_helpers(req) {
        env.push_str(&format!(
            "\n\nHelper agents are available through the `delegate` tool — up to {parallel} work AT THE SAME TIME. \
             A helper starts from zero: it knows nothing you have read and re-reads what it needs, so every delegation \
             costs a whole new context. Delegate only large, independent parts (exploring separate areas of a big \
             codebase, long self-contained implementations) — and then all of them in ONE turn so they run in parallel. \
             Do small, single-file or tightly coupled work yourself, and never delegate what you have already read."
        ));
    }
    // Parallel tool calls: independent reads / searches / commands in one
    // turn run side by side instead of one round-trip each.
    env.push_str(
        "\n\nSpeed: whenever several tool calls do not depend on each other (reading several files, several searches, \
         listing folders), issue them together in ONE turn — they run in parallel. Avoid one-call-per-turn crawling.",
    );
    // Earlier answers carry the list of what they did (the frontend adds it).
    env.push_str(
        "\n\nYour earlier answers in this chat end with a \"[Tool calls of this turn]\" list the app adds: a record of \
         what you already read, changed and ran, so you need not search or run it again. It holds no file contents: \
         to edit a file named there, read_file it first (only the part you need). The names in it are a history, \
         not your tool set — the tools you have now are exactly the ones you were given in this request, and they work. \
         Never write such a list yourself.",
    );
    if !mcp.is_empty() && !mcp_deferred(req, mcp) {
        env.push_str(
            "\n\nTools named mcp__<server>__<tool> come from MCP servers the user connected; use them when they fit the task better than the built-in tools.",
        );
    }
    // Without this the model "generates" a picture in words and tells the
    // user it is shown above — while nothing is.
    if req.image_gen.is_some() && on("generate_image") {
        env.push_str(
            "\n\nPictures: when the user asks for an image, photo, drawing, logo or icon, call generate_image — \
             it is shown to the user automatically; afterwards just say it is ready (one short line).",
        );
    } else {
        env.push_str(
            "\n\nPictures: this run has no image generator. If the user asks for a picture, say you cannot draw \
             with the current model and that an image model can be added in Settings → Models; never claim a picture was made.",
        );
    }
    out.push(("Environment & working rules", env));
    if mcp_deferred(req, mcp) {
        out.push(("MCP catalog", mcp_catalog(mcp)));
    }
    if !skills.is_empty() {
        let mut list = String::from(
            "\n\nSkills — instruction packs for particular kinds of tasks. When the request matches a skill's description, call the `skill` tool with its name BEFORE you start, then follow it:",
        );
        for s in skills {
            list.push_str(&format!("\n- {}: {}", s.name, one_line(&s.description, 300)));
        }
        out.push(("Skills list", list));
    }
    out
}

/// /commands, invoked skills and @mentions → what the model reads. File IO
/// and git run off the async workers.
async fn expand_turns(
    skills: Arc<Vec<crate::skills::Skill>>,
    root: &Path,
    turns: Vec<crate::chat::ChatTurn>,
) -> Result<Vec<crate::chat::ChatTurn>, String> {
    let root = root.to_path_buf();
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
    .map_err(|e| format!("prompt expansion failed: {e}"))
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
    let parallel = req.max_agents.clamp(1, MAX_AGENTS);
    let req = &with_worker(req);
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
            first_input: 0,
            first_est: 0,
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

    let has_helpers = has_helpers(req);
    let deferred = mcp_deferred(req, &mcp);
    let mcp_all = Arc::new(mcp.clone());
    let preamble: String = preamble_sections(system, req, root, &skills, &mcp)
        .into_iter()
        .map(|(_, text)| text)
        .collect();
    let tools = |memo: &ReadMemo| {
        let mut t = fs_tools(&ctx, memo);
        if has_helpers {
            t.push(delegate_tool(&ctx));
        }
        if !skills.is_empty() {
            t.push(skill_tool(skills.clone()));
        }
        if deferred {
            t.push(mcp_find_tool(mcp_all.clone()));
            t.push(mcp_call_tool(mcp_all.clone()));
        } else {
            t.extend(mcp.iter().map(mcp_tool));
        }
        t
    };
    let turns = expand_turns(skills.clone(), root, turns).await?;
    ctx.usage.lock().unwrap().first_est =
        measure(req, system, root, &skills, &mcp, &turns, None).iter().map(|p| p.tokens as u64).sum();
    let (history, prompt) = to_messages(req, &turns);
    // One per agent history: a retry resumes the same history, so the reads
    // it remembers are still in it.
    let memo = ReadMemo::default();
    // The conversation as the model saw it at the end — the text-call check
    // below continues from it.
    let final_messages = Mutex::new(None);
    // The main agent may run many tool calls of one turn at once (parallel
    // reads, several delegations); at least a handful even with one helper.
    let tool_parallel = parallel.max(8);
    let mut text =
        run_with_retry(&ctx, &preamble, &tools, None, prompt, history, tool_parallel, true, Some(&final_messages), memo.clone(), |_| {})
            .await?;
    // A tool call written as plain text ("functions.read_file:0{…}") is no
    // call: nothing ran and the run ended mid-task. Point it out and go on.
    for _ in 0..TEXT_CALL_NUDGES {
        let Some(messages) = final_messages.lock().unwrap().clone() else { break };
        let Some(Message::Assistant { content, .. }) = messages.last() else { break };
        // Reasoning counts: some models "call" from inside their thinking.
        let said: String = content
            .iter()
            .filter_map(|c| match c {
                AssistantContent::Text(t) => Some(t.text.clone()),
                AssistantContent::Reasoning(r) => Some(r.display_text()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        let reply: String = content
            .iter()
            .filter_map(|c| match c {
                AssistantContent::Text(t) => Some(t.text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        let cli = crate::cli::Cli::from_kind(&req.kind).is_some();
        let nudge = if is_text_tool_call(&said) && cli {
            // CLI models call tools BY writing request lines; one that is
            // left in the text was not a readable line.
            "[Singularity] Your last message has a <tool_call> request line my app could not read, so nothing ran. \
             Write each request line exactly as <tool_call>{\"name\": \"…\", \"arguments\": {…}}</tool_call> with valid JSON \
             (inside strings: line breaks as \\n, quotes as \\\"), then stop and wait for the result."
        } else if is_text_tool_call(&said) {
            "[Singularity] Your last message wrote a tool call as plain text, so nothing ran. \
             Call the tool through the tool-calling interface (not in your reply text) and continue the task."
        } else if announces_next_step(&reply) {
            "[Singularity] Your last message announced a next step but ended without doing it — no tool was called. \
             Do that step now with a tool call and continue until the task is done."
        } else {
            break;
        };
        if is_cancelled(run_id) {
            break;
        }
        let nudge = Message::user(nudge);
        emit_text(app, run_id, "\n\n".to_string());
        let more =
            run_with_retry(&ctx, &preamble, &tools, None, nudge, messages, tool_parallel, true, Some(&final_messages), memo.clone(), |_| {})
                .await?;
        text.push_str("\n\n");
        text.push_str(&more);
    }
    if text.trim().is_empty() && ctx.counter.load(Ordering::SeqCst) == 0 {
        return Err(
            "the model returned an empty answer — its output may have been reasoning-only; retry, or try another model/effort level".into(),
        );
    }
    Ok(text)
}

/* ---------- Tool calls written as text ---------- */

/// Times one run points out a tool call written as text before giving up.
const TEXT_CALL_NUDGES: usize = 2;

/// Whether an answer ends with a tool call the model wrote as text instead
/// of calling it: `functions.read_file:0{…}`, `<tool_call>…`, `read_file({…})`.
/// Only the end of the answer counts — an explanation that mentions a tool
/// earlier is not a call.
fn is_text_tool_call(text: &str) -> bool {
    use std::sync::LazyLock;
    static CALL: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r#"(?x)
            functions\.[A-Za-z_][\w.-]*\s*(:\s*\d+)?\s*[({]
            | <\|?(tool_call|function_call|tool_calls_begin|tool▁call)
            | <function=
            | \bto=functions\.
            | \b(read_file|apply_patch|write_file|run_command|list_dir|grep|find_files|file_op|git|web_search|web_fetch|change_dir)\s*\(?\s*\{\s*"
            "#,
        )
        .unwrap()
    });
    let tail: String = {
        let t = text.trim_end();
        let start = t.char_indices().rev().nth(399).map_or(0, |(i, _)| i);
        t[start..].to_string()
    };
    CALL.is_match(&tail)
}

/// Whether an answer stops on an announcement of work it never did:
/// "Now I'll update the handler:", "Сейчас исправлю файл…". A final summary
/// ends on a statement, not on a colon or a "let me".
fn announces_next_step(text: &str) -> bool {
    use std::sync::LazyLock;
    static NEXT: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)^(let me|let's|now,? i('ll| will| am going to)|i('ll| will) now|next,? i('ll| will)|i('m| am) going to|сейчас|теперь (я )?(исправ|измен|обнов|добав|удал|перепиш|внес|сдела|посмотр|прочит|провер|созда|запущ)|далее|давай(те)?|приступаю|начну|перейду)",
        )
        .unwrap()
    });
    let t = text.trim_end();
    if t.is_empty() {
        return false;
    }
    let last = t.lines().last().unwrap_or("").trim();
    if last.ends_with(':') || last.ends_with("...") || last.ends_with('…') {
        return true;
    }
    // The last sentence of the last line.
    let sentence = last
        .trim_end_matches(['.', '!'])
        .rsplit(['.', '!', '?'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_start_matches(['*', '-', ' ']);
    // "Let me know if…" closes an answer, it announces nothing.
    NEXT.is_match(sentence) && !sentence.to_lowercase().starts_with("let me know")
}

/* ---------- Context view ---------- */

/// Rough token count: ~4 characters per token for ASCII (English, code),
/// ~2.5 for other scripts (Cyrillic, CJK tokenize denser). Real tokenizers
/// differ by model; this is for the "how full is it" gauge.
pub(crate) fn est_tokens(text: &str) -> usize {
    let (mut ascii, mut other) = (0usize, 0usize);
    for c in text.chars() {
        if c.is_ascii() {
            ascii += 1;
        } else {
            other += 1;
        }
    }
    (ascii as f64 / 4.0 + other as f64 / 2.5).ceil() as usize
}

/// One line inside a context category (a tool, a skill, a kind of message).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ContextItem {
    pub name: String,
    pub tokens: usize,
    /// Shown for information only — not part of the request (and not in
    /// the category's total): what the history bound left out.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub note: bool,
}

/// One category of what the next request carries.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ContextPart {
    pub label: String,
    /// "messages" | "tools" | "mcp" | "skills" | "system" — picks the color.
    pub group: &'static str,
    pub tokens: usize,
    pub items: Vec<ContextItem>,
}

fn item(name: impl Into<String>, text: &str) -> ContextItem {
    ContextItem { name: name.into(), tokens: est_tokens(text), note: false }
}

/// The first words of a message, on one line.
fn snippet(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= 48 {
        return if flat.is_empty() { "(empty)".into() } else { flat };
    }
    format!("{}…", flat.chars().take(47).collect::<String>())
}

fn category(label: &str, group: &'static str, mut items: Vec<ContextItem>) -> ContextPart {
    items.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    ContextPart { label: label.into(), group, tokens: items.iter().map(|i| i.tokens).sum(), items }
}

/// What the NEXT agent request of this conversation would send, measured
/// category by category — the same preamble, tool list and trimmed,
/// expanded history the run builds. (Inside a run the history then grows
/// with tool calls and results; context editing trims those.)
pub(super) async fn context_info(
    app: &AppHandle,
    req: &AgentRequest,
    system: &str,
    root: &Path,
    turns: Vec<crate::chat::ChatTurn>,
) -> Result<Vec<ContextPart>, String> {
    let req = &with_worker(req);
    let counter = AtomicUsize::new(0);
    let skills = Arc::new(crate::skills::for_run(app, &req.workspace));
    let mcp = load_mcp(app, "context-info", &counter).await;
    // The latest prompt as typed: the rest of its expanded text is @files.
    let raw_last = turns.iter().rev().find(|t| t.role != "agent" && t.role != "assistant").map(|t| t.text.clone());
    let turns = expand_turns(skills.clone(), root, turns).await?;
    Ok(measure(req, system, root, &skills, &mcp, &turns, raw_last.as_deref()))
}

/// Estimated tokens per category of one request (see context_info). The
/// run measures its first request the same way, which calibrates this.
fn measure(
    req: &AgentRequest,
    system: &str,
    root: &Path,
    skills: &[crate::skills::Skill],
    mcp: &[McpBinding],
    turns: &[crate::chat::ChatTurn],
    raw_last: Option<&str>,
) -> Vec<ContextPart> {
    let mut parts = Vec::new();

    // Messages: one line per message ("You · first words…"), the latest
    // prompt split from the @files expanded into it.
    let is_user = |r: &str| r != "agent" && r != "assistant";
    let last_user = turns.iter().rposition(|t| is_user(&t.role));
    let mut msgs = Vec::new();
    for (i, t) in turns.iter().enumerate() {
        let who = if !is_user(&t.role) {
            "Agent"
        } else if Some(i) == last_user {
            "Latest"
        } else {
            "You"
        };
        match raw_last.filter(|_| Some(i) == last_user) {
            Some(raw) => {
                let typed = item(format!("{who} · {}", snippet(raw)), raw);
                let files = est_tokens(&t.text).saturating_sub(typed.tokens);
                msgs.push(typed);
                if files > 0 {
                    msgs.push(ContextItem { name: "Latest · attached @files".into(), tokens: files, note: false });
                }
            }
            None => msgs.push(item(format!("{who} · {}", snippet(&t.text)), &t.text)),
        }
    }
    parts.push(category("Messages", "messages", msgs));

    // System tools: each built-in schema as sent (name + description + params).
    let mut tools_items: Vec<ContextItem> = tool_specs(req)
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|spec| item(spec["name"].as_str().unwrap_or("tool"), &spec.to_string()))
        .collect();
    if has_helpers(req) {
        let roster: String = req.subagents.iter().map(|s| format!("- {}: {}\n", s.name, s.description)).collect();
        tools_items.push(item("delegate", &format!("{roster}{}", " ".repeat(420))));
    }
    if !skills.is_empty() {
        let names = skills.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(",");
        tools_items.push(item("skill", &format!("{names}{}", " ".repeat(450))));
    }
    parts.push(category("System tools", "tools", tools_items));

    if mcp_deferred(req, mcp) {
        // Only the catalog and the two lookup tools ride along.
        let items = vec![
            item("catalog (names only)", &mcp_catalog(mcp)),
            item("mcp_find + mcp_call", &" ".repeat(1_400)),
        ];
        parts.push(category("MCP tools", "mcp", items));
    } else if !mcp.is_empty() {
        let items = mcp
            .iter()
            .map(|b| item(format!("{} · {}", b.server.name, b.tool.name), &format!("{}{}{}", b.name, b.tool.description, b.tool.input_schema)))
            .collect();
        parts.push(category("MCP tools", "mcp", items));
    }

    let sections = preamble_sections(system, req, root, skills, mcp);
    if !skills.is_empty() {
        // Only name + description ride along; a skill's body loads on use.
        let items = skills
            .iter()
            .map(|sk| item(sk.name.clone(), &format!("\n- {}: {}", sk.name, one_line(&sk.description, 300))))
            .collect();
        parts.push(category("Skills", "skills", items));
    }
    let sys_items = sections
        .iter()
        .filter(|(label, _)| *label != "Skills list" && *label != "MCP catalog")
        .map(|(label, text)| item(*label, text))
        .collect();
    parts.push(category("System prompt", "system", sys_items));
    parts
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
    fn old_tool_results_are_cleared_in_steps() {
        let stub_count = |h: &[Message]| {
            h.iter()
                .filter(|m| serde_json::to_string(m).unwrap().contains("older tool result cleared"))
                .count()
        };
        // 30 bulky results ≈ 300k chars: well past the trigger.
        let mut history = vec![Message::user("task")];
        for i in 0..30 {
            history.push(Message::tool_result(format!("c{i}"), "read_file", "x".repeat(10_000)));
        }
        history.push(Message::tool_result("d", "delegate", "y".repeat(10_000)));
        let mut cleared = 0;
        let out = clear_old_results(&history, &mut cleared).expect("history over the trigger is edited");
        assert!(cleared > 0 && cleared <= 30 - CLEAR_KEEP_RECENT);
        assert_eq!(stub_count(&out), cleared);
        // The newest results and the helper's report stay verbatim.
        assert!(serde_json::to_string(&out[30]).unwrap().contains("xxxx"));
        assert!(serde_json::to_string(out.last().unwrap()).unwrap().contains("yyyy"));
        // Next turn with one more small result: the watermark holds (cache-stable).
        history.push(Message::tool_result("e", "list_dir", "z"));
        let before = cleared;
        clear_old_results(&history, &mut cleared);
        assert_eq!(cleared, before);
        // Small histories are sent untouched.
        let mut zero = 0;
        assert!(clear_old_results(&history[..3], &mut zero).is_none());
    }

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
    fn string_encoded_args_match() {
        let obj = json!({"command": "npm install", "cwd": "web"});
        let as_string = Value::String(obj.to_string());
        assert_eq!(fingerprint("run_command", &obj), fingerprint("run_command", &as_string));
        assert_eq!(parse_args(&serde_json::to_string(&obj.to_string()).unwrap()), obj);
    }

    #[test]
    fn canonical_ignores_formatting() {
        let a: Value = serde_json::from_str(r#"{ "agent": "X",  "task": "t" }"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"agent":"X","task":"t"}"#).unwrap();
        assert_eq!(canonical(&a), canonical(&b));
    }
}

#[cfg(test)]
mod text_call_tests {
    use super::is_text_tool_call;

    #[test]
    fn tool_calls_written_as_text_are_seen() {
        assert!(is_text_tool_call(
            r#"Проблема с синтаксисом регулярки. Исправлю:functions.read_file:0{"path": "src/a.ts", "start_line": 140}"#
        ));
        assert!(is_text_tool_call("Let me look.\n<tool_call>{\"name\": \"read_file\"}"));
        assert!(is_text_tool_call(r#"Reading it now: read_file({"path": "a"})"#));
        assert!(!is_text_tool_call("Done — I changed read_file handling in tools.rs and the build passes."));
        assert!(!is_text_tool_call("Use `functions` in JS as shown."));
    }

    #[test]
    fn abandoned_announcements_are_seen() {
        use super::announces_next_step as next;
        assert!(next("I found the bug in the handler. Now I'll fix it:"));
        assert!(next("Нашёл ошибку. Сейчас исправлю провайдер"));
        assert!(next("Теперь обновлю компонент."));
        assert!(next("Let me check the config..."));
        assert!(!next("Готово: исправил обработчик в src/a.ts, сборка проходит."));
        assert!(!next("Теперь всё работает."));
        assert!(!next("Done. The build passes."));
        assert!(!next("Fixed it. Let me know if you want more."));
        assert!(!next("Какой вариант выбрать?"));
        assert!(!next(""));
    }
}

#[cfg(test)]
mod coerce_tests {
    use super::*;

    #[test]
    fn string_and_float_numbers_become_integers() {
        let v = norm_args(&json!({ "path": "a", "start_line": "2001", "end_line": 2500.0, "create": "true", "background": "false" }));
        assert_eq!(v, json!({ "path": "a", "start_line": 2001, "end_line": 2500, "create": true, "background": false }));
        // Arguments sent as a JSON string get the same treatment.
        let v = norm_args(&json!("{\"start_line\":\"7\"}"));
        assert_eq!(v["start_line"], 7);
        // Unknown keys and junk are left alone.
        assert_eq!(norm_args(&json!({ "start_line": "abc", "command": "1" })), json!({ "start_line": "abc", "command": "1" }));
    }
}

#[cfg(test)]
mod read_memo_tests {
    use super::*;

    #[test]
    fn rereads_return_the_file_and_then_nudge() {
        let dir = std::env::temp_dir().join(format!("memo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.ts"), "const a = 1;\n").unwrap();
        let memo = ReadMemo::default();
        let args = serde_json::json!({ "path": "a.ts" });
        for n in 1..=REREAD_NUDGE_AT {
            let res = memo.read(&dir, &args);
            assert!(res.ok && res.output.contains("const a = 1;"), "read {n} must be real");
            assert_eq!(res.output.contains("Stop reading it"), n >= REREAD_NUDGE_AT);
        }
        // Another range is paging, not a re-read.
        let res = memo.read(&dir, &serde_json::json!({ "path": "a.ts", "start_line": 1, "end_line": 1 }));
        assert!(!res.output.contains("Stop reading it"));
        // An edit starts the count over.
        memo.forget_path(&dir, "a.ts");
        assert!(!memo.read(&dir, &args).output.contains("Stop reading it"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod live_edit_tests {
    use super::*;

    #[test]
    fn json_string_reads_open_and_escaped_values() {
        let args = r#"{"path": "src/a.ts", "content": "line1\nПри\"вет\u00e9\ud83d\ude00 and mo"#;
        assert_eq!(json_string(args, "path", false).as_deref(), Some("src/a.ts"));
        assert_eq!(json_string(args, "content", false), None);
        assert_eq!(json_string(args, "content", true).as_deref(), Some("line1\nПри\"ветé😀 and mo"));
        // A dangling escape at the very end is simply not there yet.
        assert_eq!(json_string(r#"{"path": "a\"#, "path", true), None);
    }

    #[test]
    fn patch_preview_applies_finished_and_running_blocks() {
        let text = "a\nb\nc\nd";
        let diff = "<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nd\n=======\nD1\nD";
        assert_eq!(preview_patch(text, diff), "a\nB\nc\nD1\nD");
        // SEARCH still being written: nothing to place yet.
        assert_eq!(preview_patch(text, "<<<<<<< SEARCH\nc"), text);
    }
}

#[cfg(test)]
mod mcp_defer_tests {
    use super::*;

    fn binding(server: &str, tool: &str) -> McpBinding {
        let tool = crate::mcp::McpTool {
            name: tool.into(),
            description: format!("{tool} does things"),
            input_schema: json!({ "type": "object" }),
            read_only: false,
        };
        let server: crate::mcp::McpServer = serde_json::from_value(json!({
            "id": "s", "name": server, "transport": "http", "url": "http://x", "enabled": true
        }))
        .unwrap_or_else(|_| panic!("McpServer shape"));
        McpBinding { name: crate::mcp::tool_name(&server.name, &tool.name), server: Arc::new(server), tool }
    }

    #[test]
    fn deferred_lookup_by_full_or_bare_name() {
        let mcp = vec![binding("Browser", "navigate"), binding("Browser", "click"), binding("DevTools", "click")];
        assert_eq!(find_mcp(&mcp, "navigate").map(|b| b.tool.name.as_str()), Some("navigate"));
        assert!(find_mcp(&mcp, "click").is_none(), "ambiguous bare name");
        let full = mcp[2].name.clone();
        assert_eq!(find_mcp(&mcp, &full).map(|b| b.server.name.as_str()), Some("DevTools"));
        let cat = mcp_catalog(&mcp);
        assert!(cat.contains("- Browser: ") && cat.contains("- DevTools: "));
    }
}


