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
use std::sync::atomic::{AtomicUsize, Ordering};
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
}

impl RunCtx {
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

struct UiHook {
    ctx: RunCtx,
    /// "[Helper] " prefix for subagent cards; empty for the main agent.
    label: String,
    permit: Mutex<Option<crate::limiter::Permit>>,
    live: Mutex<HashMap<String, LiveCall>>,
    last_call: Mutex<(String, usize)>,
}

impl UiHook {
    fn new(ctx: RunCtx, label: Option<&str>) -> Self {
        Self {
            ctx,
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
    async fn on_completion_call(&self, _ctx: &HookContext, _event: CompletionCallEvent<'_>) -> CompletionCallAction {
        if is_cancelled(&self.ctx.run_id) {
            return CompletionCallAction::Stop(crate::cancel::STOPPED.to_string());
        }
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
            return ToolCallAction::Stop(format!("the model repeated the same action {repeats} times ({})", one_line(&fp, 120)));
        }
        if repeats >= REPEAT_SKIP_AT {
            self.step(idx, event.tool_name, summary, true, &tools::ToolResult::err("skipped: repeated call"));
            return ToolCallAction::Skip(
                "You already made this exact call and it will not give a different result. Change your approach or finish with an answer.".into(),
            );
        }

        self.step(idx, event.tool_name, summary.clone(), false, &tools::ToolResult::ok(""));

        // Permission gate: unless the project runs commands automatically,
        // run_command waits for the user's Allow/Deny in the UI.
        if event.tool_name == "run_command" && !self.ctx.req.auto_run {
            let cmd = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
            let cwd = args
                .get("cwd")
                .and_then(|v| v.as_str())
                .unwrap_or(self.ctx.req.workspace.as_str());
            let approved = {
                let _one_banner = self.ctx.confirm_lock.lock().await;
                ask_confirm(&self.ctx.app, &self.ctx.run_id, cmd, cwd).await
            };
            if !approved {
                self.step(idx, event.tool_name, summary, true, &tools::ToolResult::err("denied by the user"));
                return ToolCallAction::Skip("The user denied this command. Do not retry it — continue without it.".into());
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

/// Card input for a call whose JSON arguments may still be incomplete.
fn live_summary(name: &str, args: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(args) {
        return summarize(name, &v);
    }
    let key = match name {
        "run_command" | "ssh_exec" => "command",
        "grep" => "pattern",
        "delegate" => "agent",
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
                        let res = if tool_name == "ssh_exec" {
                            run_ssh_tool(&c.app, &c.req, &args).await
                        } else {
                            // Tools block (file IO, processes): keep the async
                            // workers free so events keep flowing.
                            let root = c.root.clone();
                            tokio::task::spawn_blocking(move || tools::dispatch(&root, &tool_name, &args))
                                .await
                                .unwrap_or_else(|e| tools::ToolResult::err(format!("tool task failed: {e}")))
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

/* ---------- Agent build + streaming ---------- */

/// Builds one Rig agent (main or helper) on the request's provider.
fn build_agent(ctx: &RunCtx, preamble: &str, tools: Vec<DynamicTool>) -> Result<rig_agent::Agent, String> {
    let setup = model::build(&ctx.req)?;
    let mut b = AgentBuilder::from_model_handle(setup.handle)
        .preamble(preamble)
        .default_max_turns(MAX_TURNS);
    if let Some(t) = setup.temperature {
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
/// `to_ui`), usage to the HUD. Returns the answer text. Stop drops the
/// stream immediately.
async fn drive(
    ctx: &RunCtx,
    mut stream: rig_agent::agent::StreamingResult,
    to_ui: bool,
    mut on_text: impl FnMut(&str),
) -> Result<String, String> {
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
                return cancelled_result(text);
            }
        };
        let item = match item {
            Ok(it) => it,
            Err(e) => {
                let msg = e.to_string();
                if is_cancelled(&ctx.run_id) || msg.contains(crate::cancel::STOPPED) {
                    return cancelled_result(text);
                }
                return Err(msg);
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
    Ok(text)
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
    let hook = UiHook::new(ctx.clone(), Some(&def.name));
    let agent = build_agent(ctx, &preamble, fs_tools(ctx))?;
    let stream = agent
        .stream_chat(task.to_string(), Vec::<Message>::new())
        .max_turns(MAX_TURNS)
        .add_hook(hook)
        .await;
    let summary = format!("{}: {}", def.name, one_line(task, 80));
    let mut partial = String::new();
    let mut shown = 0usize;
    let result = drive(ctx, stream, false, |t| {
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
    let ctx = RunCtx {
        app: app.clone(),
        run_id: run_id.to_string(),
        req: Arc::new(req.clone()),
        root: root.to_path_buf(),
        steps: Arc::default(),
        counter: Arc::new(AtomicUsize::new(0)),
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
    };

    let helpers: Vec<&SubagentDef> = req.subagents.iter().filter(|s| !s.name.trim().is_empty()).collect();
    let mut tools = fs_tools(&ctx);
    let mut preamble = system.to_string();
    if !helpers.is_empty() {
        tools.push(delegate_tool(&ctx));
        preamble.push_str(&format!(
            "\n\nHelper agents are available through the `delegate` tool (up to {parallel} at once). They are optional: do simple or tightly coupled work yourself, and delegate only self-contained parts that match a helper's specialty."
        ));
    }

    let agent = build_agent(&ctx, &preamble, tools)?;
    let (history, prompt) = to_messages(req, &turns);
    let stream = agent
        .stream_chat(prompt, history)
        .max_turns(MAX_TURNS)
        // Several delegate calls in one turn run side by side.
        .tool_concurrency(parallel)
        .add_hook(UiHook::new(ctx.clone(), None))
        .await;

    let text = drive(&ctx, stream, true, |_| {}).await?;
    if text.trim().is_empty() && ctx.counter.load(Ordering::SeqCst) == 0 {
        return Err(
            "the model returned an empty answer — its output may have been reasoning-only; retry, or try another model/effort level".into(),
        );
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

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
