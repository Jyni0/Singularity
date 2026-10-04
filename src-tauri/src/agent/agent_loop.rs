//! AgentLoop — the multi-turn loop of one agent (main or helper), driven
//! directly on a rig-core `CompletionModel`:
//!
//! ```text
//!   ┌─► compact? ─► prepare wire ─► stream model turn ─► tool calls? ─no─► answer
//!   │                (collapse)       (retries, usage)         │yes
//!   └──────────── tool results ◄── guard / dedupe / gate / run ┘
//! ```
//!
//! The request is split into a static half — system prompt + tool
//! definitions, byte-stable for the whole run so the provider's prompt cache
//! (Anthropic `cache_control` breakpoints, OpenAI prefix caching) keeps
//! hitting — and the dynamic history, which ContextManager shapes.

use super::context::{one_line, read_fingerprint, rebuild, split_point, summarize, ContextManager};
use super::guardrails::{repeat_warning, LoopGuard, Verdict, GUARD_STOP, MAX_TURNS};
use super::model::{self, ModelSetup};
use super::permissions::gate;
use super::run_ctx::RunCtx;
use super::tools::{live_summary, norm_args, summarize as call_summary, CallInfo, ToolRegistry};
use super::{cancelled_result, is_cancelled};
use crate::tools::ToolResult;
use futures_util::StreamExt;
use rig_agent::core::completion::message::{AssistantContent, Message, ToolCall, ToolResultContent, UserContent};
use rig_agent::core::completion::{CompletionModel, CompletionRequest, Usage};
use rig_agent::core::streaming::{StreamedAssistantContent, ToolCallDeltaContent};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::Ordering;

/// Argument growth (chars) between two live card updates.
const LIVE_ARGS_STEP: usize = 400;
/// Pause between retries of a failed model request.
const RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(5);

/// Why a turn did not complete.
enum Fail {
    /// The user pressed Stop.
    Stopped,
    Error(String),
}

/// One finished model turn.
struct Turn {
    /// Assistant content in canonical order: reasoning, text, tool calls.
    content: Vec<AssistantContent>,
    /// Tool call id → the UI card opened for it while it streamed.
    cards: HashMap<String, usize>,
    input_tokens: u64,
    message_id: Option<String>,
}

/// A call that streamed its arguments before it was complete.
#[derive(Default)]
struct LiveCall {
    name: String,
    args: String,
    shown: usize,
    card: Option<usize>,
}

/// What one tool call produced: the card's result and what the model reads.
struct Outcome {
    card: ToolResult,
    model: String,
}

impl Outcome {
    fn of(res: ToolResult) -> Self {
        let model = model_text(&res);
        Self { card: res, model }
    }
}

/// What the model reads back: the output, marked when it is an error.
fn model_text(res: &ToolResult) -> String {
    if res.ok {
        res.output.clone()
    } else {
        format!("ERROR: {}", res.output)
    }
}

/// One planned call of a turn.
struct Planned {
    call: ToolCall,
    card: usize,
    args: Value,
    summary: String,
    /// Decided before running (guard / dedupe / stop); None = run it.
    decided: Option<Outcome>,
}

pub(in crate::agent) struct AgentLoop<'a> {
    pub ctx: &'a RunCtx,
    /// System prompt — the static, cached half of every request.
    pub preamble: String,
    pub tools: &'a ToolRegistry,
    /// "[worker] " prefix of a helper's cards; empty for the main agent.
    pub label: String,
    /// Stream text and reasoning into the chat (main agent only).
    pub to_ui: bool,
    /// Tool calls of one turn that may run at once.
    pub parallel: usize,
}

impl AgentLoop<'_> {
    /// Runs to the final answer. `history` ends with the prompt. Returns all
    /// text the model wrote; a Stop returns `cancelled_result`.
    pub async fn run(&self, history: Vec<Message>, on_text: &mut (dyn FnMut(&str) + Send)) -> Result<String, String> {
        let setup = model::build(&self.ctx.req)?;
        self.run_with(&setup, history, on_text).await
    }

    /// `run` on a given model (tests script one).
    async fn run_with(
        &self,
        setup: &ModelSetup,
        history: Vec<Message>,
        on_text: &mut (dyn FnMut(&str) + Send),
    ) -> Result<String, String> {
        let task = last_user_text(&history);
        let mut messages = history;
        let mut cm = ContextManager::new(self.ctx.window);
        let cli = crate::cli::Cli::from_kind(&self.ctx.req.kind);
        if cli.is_some() {
            cm = cm.without_collapsing();
        }
        // A CLI session keeps (and compacts) its own context: summarizing
        // here would change the history and start a NEW session.
        let own_context = cli.is_some_and(crate::cli::keeps_session);
        let mut guard = LoopGuard::default();
        let mut text = String::new();
        tracing::debug!(
            run_id = %self.ctx.run_id,
            agent = %self.label.trim(),
            tools = self.tools.definitions().len(),
            preamble_tokens = super::context::est_tokens(&self.preamble),
            window = self.ctx.window,
            "agent loop started"
        );

        for step in 1..=MAX_TURNS {
            if is_cancelled(&self.ctx.run_id) {
                return cancelled_result(text);
            }
            if let Some(est) = cm.needs_compaction(&messages).filter(|_| !own_context) {
                if let Err(Fail::Stopped) = self.compact(setup, &mut cm, &mut messages, &task, est).await {
                    return cancelled_result(text);
                }
            }
            let wire = cm.prepare(&messages);
            let turn = match self.model_turn(setup, wire, &mut text, on_text).await {
                Ok(t) => t,
                Err(Fail::Stopped) => return cancelled_result(text),
                Err(Fail::Error(e)) => return Err(e),
            };
            cm.note_usage(turn.input_tokens, messages.len());
            tracing::debug!(
                run_id = %self.ctx.run_id,
                step,
                input_tokens = turn.input_tokens,
                est_next = cm.estimate(&messages),
                history_messages = messages.len(),
                "model turn done"
            );

            let calls: Vec<(ToolCall, usize)> = turn
                .content
                .iter()
                .filter_map(|c| match c {
                    AssistantContent::ToolCall(tc) => Some(tc.clone()),
                    _ => None,
                })
                .map(|tc| {
                    let card = turn.cards.get(tc.id.as_str()).copied().unwrap_or_else(|| self.ctx.next_index());
                    (tc, card)
                })
                .collect();
            if !turn.content.is_empty() {
                messages.push(Message::Assistant { id: turn.message_id, content: turn.content });
            }
            if calls.is_empty() {
                return Ok(text);
            }
            let (results, stop) = match self.run_tools(calls, step, &mut guard, &mut cm).await {
                Ok(r) => r,
                Err(Fail::Stopped) => return cancelled_result(text),
                Err(Fail::Error(e)) => return Err(e),
            };
            messages.push(Message::User { content: results });
            if let Some(reason) = stop {
                return Err(reason);
            }
        }
        Err(format!("the agent reached its limit of {MAX_TURNS} model calls"))
    }

    /* ---------- Model turn ---------- */

    /// The request: static system prompt + tools, then the wire history.
    fn request(&self, setup: &ModelSetup, wire: Vec<Message>) -> CompletionRequest {
        let mut chat_history = Vec::with_capacity(wire.len() + 1);
        chat_history.push(Message::system(self.preamble.clone()));
        chat_history.extend(wire);
        CompletionRequest {
            model: None,
            preamble: None,
            chat_history,
            documents: Vec::new(),
            tools: self.tools.definitions().to_vec(),
            temperature: setup.temperature.filter(|_| !self.ctx.no_temperature.load(Ordering::Relaxed)),
            max_tokens: setup.max_tokens,
            tool_choice: None,
            additional_params: setup.params.clone(),
            output_schema: None,
            record_telemetry_content: false,
        }
    }

    /// One model call, retrying ANY failure — HTTP 5xx/429, broken JSON, a
    /// cut connection — up to `req.max_retries` times, every RETRY_DELAY.
    /// The history is ours, so a retry resends exactly the failed request
    /// and finished tool work is never redone.
    async fn model_turn(
        &self,
        setup: &ModelSetup,
        wire: Vec<Message>,
        text: &mut String,
        on_text: &mut (dyn FnMut(&str) + Send),
    ) -> Result<Turn, Fail> {
        let ctx = self.ctx;
        let mut attempt = 0usize;
        loop {
            let request = self.request(setup, wire.clone());
            let req = &ctx.req;
            let key = if req.provider_id.is_empty() { req.base_url.clone() } else { req.provider_id.clone() };
            // Provider limits (RPM + concurrency) gate every model call; the
            // slot is free once the stream ends — tools and approval banners
            // must not hold it.
            let permit = crate::limiter::acquire(&key, req.rate_limit_rpm, req.concurrency, &ctx.run_id).await;
            let res = self.stream_turn(setup, request, text, on_text).await;
            drop(permit);
            let err = match res {
                Ok(turn) => return Ok(turn),
                Err(Fail::Stopped) => return Err(Fail::Stopped),
                Err(Fail::Error(e)) => e,
            };
            if is_cancelled(&ctx.run_id) {
                return Err(Fail::Stopped);
            }
            // The provider refused the temperature (reasoning models take
            // none, Anthropic caps it at 1): drop it and go again at once.
            if req.temperature.is_some() && !ctx.no_temperature.load(Ordering::Relaxed) && err.to_lowercase().contains("temperature") {
                ctx.no_temperature.store(true, Ordering::Relaxed);
                tracing::warn!(run_id = %ctx.run_id, "provider rejected the temperature; continuing without it");
                if self.to_ui {
                    ctx.text("\n\n⚠️ This model does not accept the chosen temperature — continuing with its default.\n\n".to_string());
                }
                continue;
            }
            if attempt >= req.max_retries {
                return Err(Fail::Error(err));
            }
            attempt += 1;
            tracing::warn!(run_id = %ctx.run_id, attempt, error = %one_line(&err, 300), "model request failed; retrying");
            ctx.retry(format!("{}{}", self.label, one_line(&err, 300)), attempt, req.max_retries);
            tokio::select! {
                _ = tokio::time::sleep(RETRY_DELAY) => {}
                _ = crate::cancel::cancel_signal(&ctx.run_id) => return Err(Fail::Stopped),
            }
        }
    }

    /// Streams one model call: text / reasoning to the UI, live cards for
    /// tool calls whose arguments are still streaming, usage to the HUD.
    async fn stream_turn(
        &self,
        setup: &ModelSetup,
        request: CompletionRequest,
        text: &mut String,
        on_text: &mut (dyn FnMut(&str) + Send),
    ) -> Result<Turn, Fail> {
        let ctx = self.ctx;
        let stopped_or = |msg: String| {
            if is_cancelled(&ctx.run_id) || msg.contains(crate::cancel::STOPPED) {
                Fail::Stopped
            } else {
                Fail::Error(msg)
            }
        };
        let mut stream = tokio::select! {
            r = setup.handle.stream(request) => r.map_err(|e| stopped_or(e.to_string()))?,
            _ = crate::cancel::cancel_signal(&ctx.run_id) => return Err(Fail::Stopped),
        };
        let mut live: HashMap<String, LiveCall> = HashMap::new();
        let mut cards: HashMap<String, usize> = HashMap::new();
        let mut usage: Option<Usage> = None;
        let mut turn_text = false;
        // Providers that stream reasoning deltas also send the full block at
        // the end of the turn — show it only when no deltas came.
        let mut saw_reasoning_delta = false;
        loop {
            let item = tokio::select! {
                it = stream.next() => match it {
                    Some(it) => it,
                    None => break,
                },
                _ = crate::cancel::cancel_signal(&ctx.run_id) => return Err(Fail::Stopped),
            };
            match item.map_err(|e| stopped_or(e.to_string()))? {
                StreamedAssistantContent::Text(t) => {
                    if !t.text.is_empty() {
                        turn_text = true;
                        self.text_out(&t.text, text, on_text);
                    }
                }
                StreamedAssistantContent::ReasoningDelta { reasoning, .. } => {
                    saw_reasoning_delta = true;
                    if self.to_ui && !reasoning.is_empty() {
                        ctx.think(reasoning);
                    }
                }
                StreamedAssistantContent::Reasoning { reasoning, .. } => {
                    if self.to_ui && !saw_reasoning_delta {
                        let full = reasoning.display_text();
                        if !full.trim().is_empty() {
                            ctx.think(full);
                        }
                    }
                    saw_reasoning_delta = false;
                }
                StreamedAssistantContent::ToolCallDelta { internal_call_id, content } => {
                    self.live_card(&mut live, internal_call_id, content);
                }
                StreamedAssistantContent::ToolCall { tool_call, internal_call_id } => {
                    let card = live.remove(&internal_call_id).and_then(|l| l.card).unwrap_or_else(|| ctx.next_index());
                    cards.insert(tool_call.id.as_str().to_string(), card);
                }
                StreamedAssistantContent::Final(f) => usage = Some(f.usage),
                _ => {}
            }
        }
        let usage = usage.or_else(|| stream.response.as_ref().map(|r| r.usage.clone()));
        let input_tokens = self.account(setup, usage);
        let content = normalize(std::mem::take(&mut stream.choice));
        if !turn_text {
            // Non-streaming providers: the text only arrives aggregated.
            for c in &content {
                if let AssistantContent::Text(t) = c {
                    self.text_out(&t.text, text, on_text);
                }
            }
        }
        Ok(Turn { content, cards, input_tokens, message_id: stream.message_id.clone() })
    }

    fn text_out(&self, delta: &str, text: &mut String, on_text: &mut (dyn FnMut(&str) + Send)) {
        text.push_str(delta);
        on_text(delta);
        if self.to_ui {
            self.ctx.text(delta.to_string());
        }
    }

    /// The card appears while the model is still writing the call, and grows
    /// with its arguments — a long apply_patch is never a silent pause.
    fn live_card(&self, live: &mut HashMap<String, LiveCall>, id: String, content: ToolCallDeltaContent) {
        let call = live.entry(id).or_default();
        match content {
            ToolCallDeltaContent::Name(n) => {
                if call.name.is_empty() {
                    call.name = n;
                }
            }
            ToolCallDeltaContent::Delta(d) => call.args.push_str(&d),
        }
        if call.name.is_empty() || (call.card.is_some() && call.args.len() < call.shown + LIVE_ARGS_STEP) {
            return;
        }
        call.shown = call.args.len().max(1);
        let card = *call.card.get_or_insert_with(|| self.ctx.next_index());
        self.ctx.step(&self.label, card, &call.name, &live_summary(&call.name, &call.args), false, &ToolResult::ok(""));
    }

    /// Usage of one call to the HUD and the log. Returns the call's input
    /// tokens — the WHOLE prompt, cache reads included, for every provider.
    fn account(&self, setup: &ModelSetup, usage: Option<Usage>) -> u64 {
        let u = usage.unwrap_or_else(Usage::new);
        // Anthropic reports cache reads apart from input.
        let (mut input, mut cached) = if self.ctx.req.kind == "anthropic-messages" {
            (u.input_tokens + u.cache_creation_input_tokens + u.cached_input_tokens, u.cached_input_tokens)
        } else {
            (u.input_tokens + u.cache_creation_input_tokens, u.cached_input_tokens)
        };
        // What the gateway itself reported (fields Rig does not read).
        if let Some(s) = setup.cache_seen.as_ref().and_then(|s| s.lock().unwrap().take()) {
            cached = cached.max(s.cached);
            input = input.max(s.prompt);
            if s.cached > 0 && s.prompt < s.cached {
                // Anthropic-style report behind the gateway: reads apart from input.
                input = input.max(s.prompt + s.cached + s.created);
            }
        }
        tracing::info!(
            run_id = %self.ctx.run_id,
            agent = %self.label.trim(),
            input,
            output = u.output_tokens,
            cached,
            cache_hit_pct = if input > 0 { cached * 100 / input } else { 0 },
            "model call usage"
        );
        self.ctx.add_usage(input, u.output_tokens, cached, self.label.is_empty());
        input
    }

    /* ---------- Tools ---------- */

    /// Runs the tool calls of one turn and returns their results in call
    /// order (every tool_use gets its tool_result), plus the reason to end
    /// the run when the loop guard stopped it.
    async fn run_tools(
        &self,
        calls: Vec<(ToolCall, usize)>,
        step: usize,
        guard: &mut LoopGuard,
        cm: &mut ContextManager,
    ) -> Result<(Vec<UserContent>, Option<String>), Fail> {
        let ctx = self.ctx;
        let cwd = ctx.cwd();
        let mut stop: Option<String> = None;

        // Decide in call order: loop guard, read dedupe.
        let mut plan: Vec<Planned> = Vec::with_capacity(calls.len());
        for (call, card) in calls {
            let name = call.function.name.clone();
            let args = norm_args(&call.function.arguments);
            let summary = call_summary(&name, &args);
            let decided = if stop.is_some() {
                Some(Outcome { card: ToolResult::err("not run: the run was stopped"), model: "Not run: the run was stopped.".into() })
            } else {
                match guard.check(&name, &args) {
                    Verdict::Stop { repeats } => {
                        stop = Some(format!("{GUARD_STOP} {repeats} times ({name} {})", one_line(&args.to_string(), 120)));
                        Some(Outcome {
                            card: ToolResult::err("stopped: repeated call"),
                            model: format!("SYSTEM: the run was stopped — {name} was called {repeats} times with identical parameters."),
                        })
                    }
                    Verdict::Skip { repeats } => {
                        Some(Outcome { card: ToolResult::err("skipped: repeated call"), model: repeat_warning(&name, repeats) })
                    }
                    Verdict::Run if name == "read_file" => read_fingerprint(&cwd, &args)
                        .and_then(|span| cm.unchanged_read(&span))
                        .map(|seen| {
                            tracing::debug!(run_id = %ctx.run_id, step, seen, "read_file deduped");
                            Outcome {
                                card: ToolResult::ok(format!("unchanged since step {seen} — not read again")),
                                model: format!(
                                    "These lines have not changed since you read them at step {seen}; that output is still above in \
                                     this conversation — use it instead of reading again. Need a part you have not seen? Read just \
                                     that range (start_line/end_line) or grep."
                                ),
                            }
                        }),
                    Verdict::Run => None,
                }
            };
            if let Some(o) = &decided {
                ctx.step(&self.label, card, &name, &summary, true, &o.card);
            }
            plan.push(Planned { call, card, args, summary, decided });
        }

        // Run the rest side by side; approvals still show one at a time.
        // Owned inputs and no iterator-adapter closures: the run future must
        // stay Send for the Tauri command (higher-ranked closure lifetimes
        // break that).
        let mut runs = Vec::new();
        for (i, p) in plan.iter().enumerate() {
            if p.decided.is_none() {
                let (name, args, card, summary) = (p.call.function.name.clone(), p.args.clone(), p.card, p.summary.clone());
                runs.push(async move { (i, self.exec(&name, args, card, &summary).await) });
            }
        }
        let done: Vec<(usize, Outcome)> = tokio::select! {
            r = futures_util::stream::iter(runs).buffer_unordered(self.parallel.max(1)).collect::<Vec<_>>() => r,
            _ = crate::cancel::cancel_signal(&ctx.run_id) => return Err(Fail::Stopped),
        };
        let mut done: HashMap<usize, Outcome> = done.into_iter().collect();

        let mut results = Vec::with_capacity(plan.len());
        for (i, p) in plan.into_iter().enumerate() {
            let name = p.call.function.name.clone();
            let ran = p.decided.is_none();
            let outcome = match p.decided {
                Some(o) => o,
                None => done.remove(&i).unwrap_or_else(|| Outcome::of(ToolResult::err("the tool did not finish"))),
            };
            if ran && name == "read_file" && outcome.card.ok {
                if let Some(span) = read_fingerprint(&cwd, &p.args) {
                    cm.note_read(span, p.call.id.as_str().to_string(), step);
                }
            }
            results.push(UserContent::tool_result_for(
                p.call.id.clone(),
                p.call.provider.clone(),
                name,
                vec![ToolResultContent::text(outcome.model)],
            ));
        }
        Ok((results, stop))
    }

    /// One call: start card, permission gate, the tool, result card.
    async fn exec(&self, name: &str, args: Value, card: usize, summary: &str) -> Outcome {
        let ctx = self.ctx;
        ctx.step(&self.label, card, name, summary, false, &ToolResult::ok(""));
        let Some(tool) = self.tools.get(name) else {
            let res = ToolResult::err(format!("unknown tool {name:?}; available: {}", self.tools.names().join(", ")));
            ctx.step(&self.label, card, name, summary, true, &res);
            return Outcome::of(res);
        };
        if let Some(g) = gate(self.tools, name, &args, &ctx.req.workspace, &ctx.cwd().to_string_lossy(), ctx.req.auto_run) {
            if !ctx.confirm(&g.what, &g.place, &g.reason).await {
                let res = ToolResult::err("denied by the user");
                ctx.step(&self.label, card, name, summary, true, &res);
                return Outcome {
                    card: res,
                    model: "The user denied this action. Do not retry it or work around it — continue without it, or explain what you would need.".into(),
                };
            }
        }
        let started = std::time::Instant::now();
        let res = tool.call(args, CallInfo { card }).await;
        tracing::debug!(
            run_id = %ctx.run_id,
            tool = name,
            source = ?tool.source(),
            ok = res.ok,
            ms = started.elapsed().as_millis() as u64,
            output_chars = res.output.len(),
            "tool call"
        );
        ctx.step(&self.label, card, name, summary, true, &res);
        Outcome::of(res)
    }

    /* ---------- Compaction ---------- */

    /// Replaces the older steps with a model-written summary. A failure is
    /// logged and the run goes on uncompacted (collapsing still applies).
    async fn compact(
        &self,
        setup: &ModelSetup,
        cm: &mut ContextManager,
        messages: &mut Vec<Message>,
        task: &str,
        est: u64,
    ) -> Result<(), Fail> {
        let ctx = self.ctx;
        let Some(at) = split_point(messages) else {
            cm.defer_compaction(est);
            return Ok(());
        };
        let pct = est * 100 / cm.window().max(1);
        let card = ctx.next_index();
        let summary_line = format!("context {pct}% full — summarizing {at} earlier messages");
        ctx.step(&self.label, card, "compact_context", &summary_line, false, &ToolResult::ok(""));
        tracing::info!(run_id = %ctx.run_id, est, window = cm.window(), messages = at, "compacting history");
        let req = &ctx.req;
        let key = if req.provider_id.is_empty() { req.base_url.clone() } else { req.provider_id.clone() };
        let permit = crate::limiter::acquire(&key, req.rate_limit_rpm, req.concurrency, &ctx.run_id).await;
        let res = tokio::select! {
            r = summarize(&setup.handle, &messages[..at]) => r,
            _ = crate::cancel::cancel_signal(&ctx.run_id) => return Err(Fail::Stopped),
        };
        drop(permit);
        match res {
            Ok(summary) => {
                let compacted = rebuild(task, &summary, &messages[at..]);
                cm.after_compaction(messages, &compacted);
                tracing::info!(run_id = %ctx.run_id, before = messages.len(), after = compacted.len(), "history compacted");
                *messages = compacted;
                ctx.step(
                    &self.label,
                    card,
                    "compact_context",
                    &summary_line,
                    true,
                    &ToolResult::ok(format!("Earlier steps summarized:\n\n{summary}")),
                );
            }
            Err(e) => {
                tracing::warn!(run_id = %ctx.run_id, error = %e, "compaction failed; continuing without it");
                cm.defer_compaction(est);
                ctx.step(&self.label, card, "compact_context", &summary_line, true, &ToolResult::err(format!("compaction failed: {e}")));
            }
        }
        Ok(())
    }
}

/// Assistant content in the order providers expect it back: reasoning
/// first (Anthropic requires thinking blocks to lead a tool_use turn), then
/// text, then tool calls. Whitespace-only text is dropped.
fn normalize(choice: Vec<AssistantContent>) -> Vec<AssistantContent> {
    let (mut reasoning, mut body, mut calls) = (Vec::new(), Vec::new(), Vec::new());
    for c in choice {
        match c {
            AssistantContent::Reasoning(_) => reasoning.push(c),
            AssistantContent::ToolCall(_) => calls.push(c),
            AssistantContent::Text(ref t) if t.text.trim().is_empty() => {}
            _ => body.push(c),
        }
    }
    reasoning.extend(body);
    reasoning.extend(calls);
    reasoning
}

/// The text of the last user message — the task a compaction must keep.
fn last_user_text(history: &[Message]) -> String {
    history
        .iter()
        .rev()
        .find_map(|m| match m {
            Message::User { content } => {
                let text: Vec<&str> = content
                    .iter()
                    .filter_map(|c| match c {
                        UserContent::Text(t) => Some(t.text.as_str()),
                        _ => None,
                    })
                    .collect();
                (!text.is_empty()).then(|| text.join("\n"))
            }
            _ => None,
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rig_agent::core::completion::message::ToolFunction;

    #[test]
    fn normalize_orders_reasoning_text_calls() {
        let call = AssistantContent::ToolCall(ToolCall::new(
            rig_agent::core::completion::message::ToolCallId::mint(),
            ToolFunction::new("read_file".into(), serde_json::json!({"path": "a"})),
        ));
        let out = normalize(vec![
            call.clone(),
            AssistantContent::text("  "),
            AssistantContent::text("plan"),
            AssistantContent::Reasoning(rig_agent::core::completion::message::Reasoning::new("think")),
        ]);
        assert_eq!(out.len(), 3);
        assert!(matches!(out[0], AssistantContent::Reasoning(_)));
        assert!(matches!(&out[1], AssistantContent::Text(t) if t.text == "plan"));
        assert!(matches!(out[2], AssistantContent::ToolCall(_)));
    }

    /* ---------- The loop on a scripted model ---------- */

    use crate::agent::tools::builtin_tools;
    use crate::agent::AgentRequest;
    use rig_agent::core::completion::{CompletionError, CompletionResponse};
    use rig_agent::core::streaming::StreamingCompletionResponse;
    use rig_agent::core::test_utils::{MockCompletionModel, MockStreamEvent, MockTurn};
    use rig_agent::ModelHandle;
    use serde_json::json;
    use std::path::PathBuf;

    /// Streams from one script, answers unary calls (the compaction
    /// summary) from another.
    struct Scripted {
        stream: MockCompletionModel,
        unary: MockCompletionModel,
    }

    impl CompletionModel for Scripted {
        fn completion(
            &self,
            request: CompletionRequest,
        ) -> impl std::future::Future<Output = Result<CompletionResponse, CompletionError>> + Send {
            CompletionModel::completion(&self.unary, request)
        }
        fn stream(
            &self,
            request: CompletionRequest,
        ) -> impl std::future::Future<Output = Result<StreamingCompletionResponse, CompletionError>> + Send {
            CompletionModel::stream(&self.stream, request)
        }
    }

    struct Fixture {
        dir: PathBuf,
        ctx: RunCtx,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn fixture(name: &str, window: u64) -> Fixture {
        let dir = std::env::temp_dir().join(format!("sing-loop-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "hello from a").unwrap();
        let req: AgentRequest = serde_json::from_value(json!({
            "kind": "openai", "base_url": "http://x", "model": "m",
            "workspace": dir.to_string_lossy(), "auto_run": true, "max_retries": 0
        }))
        .unwrap();
        let ctx = RunCtx::new(None, &format!("loop-test-{name}"), &req, dir.clone(), 1, window);
        Fixture { dir, ctx }
    }

    fn setup(stream: &MockCompletionModel, unary: MockCompletionModel) -> ModelSetup {
        ModelSetup {
            handle: ModelHandle::new(Scripted { stream: stream.clone(), unary }),
            params: None,
            temperature: None,
            max_tokens: None,
            cache_seen: None,
        }
    }

    fn usage(input: u64) -> MockStreamEvent {
        MockStreamEvent::final_response(Usage { input_tokens: input, output_tokens: 10, ..Usage::new() })
    }

    fn call(id: &str, tool: &str, args: Value) -> Vec<MockStreamEvent> {
        vec![MockStreamEvent::tool_call(id, tool, args), usage(100)]
    }

    fn answer(text: &str) -> Vec<MockStreamEvent> {
        vec![MockStreamEvent::text(text), usage(100)]
    }

    async fn run(f: &Fixture, model: &MockCompletionModel, unary: MockCompletionModel) -> Result<String, String> {
        let mut tools = ToolRegistry::new(Default::default());
        tools.extend(builtin_tools(&f.ctx));
        let agent = AgentLoop {
            ctx: &f.ctx,
            preamble: "SYSTEM PROMPT".into(),
            tools: &tools,
            label: String::new(),
            to_ui: false,
            parallel: 4,
        };
        agent.run_with(&setup(model, unary), vec![Message::user("read a.txt")], &mut |_| {}).await
    }

    /// The tool_result texts of the LAST message of a request.
    fn last_results(req: &CompletionRequest) -> Vec<String> {
        match req.chat_history.last() {
            Some(Message::User { content }) => content
                .iter()
                .filter_map(|c| match c {
                    UserContent::ToolResult(r) => Some(serde_json::to_string(&r.content).unwrap()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    #[test]
    fn tool_call_then_answer() {
        let f = fixture("basic", 100_000);
        let model = MockCompletionModel::from_stream_turns([call("c1", "read_file", json!({"path": "a.txt"})), answer("done")]);
        let out = rt().block_on(run(&f, &model, MockCompletionModel::default()));
        assert_eq!(out.as_deref(), Ok("done"));
        let reqs = model.requests();
        assert_eq!(reqs.len(), 2);
        // Static half first: the system prompt, then the tools.
        assert!(matches!(&reqs[0].chat_history[0], Message::System { content } if content == "SYSTEM PROMPT"));
        assert!(reqs[0].tools.iter().any(|t| t.name == "read_file"));
        assert_eq!(reqs[0].tools.iter().map(|t| &t.name).collect::<Vec<_>>(), reqs[1].tools.iter().map(|t| &t.name).collect::<Vec<_>>());
        // The second request carries the assistant's call and its result.
        assert!(matches!(reqs[1].chat_history[reqs[1].chat_history.len() - 2], Message::Assistant { .. }));
        let results = last_results(&reqs[1]);
        assert_eq!(results.len(), 1);
        assert!(results[0].contains("hello from a"), "{results:?}");
        assert_eq!(f.ctx.usage.lock().unwrap().prompt_tokens, 200);
    }

    #[test]
    fn unchanged_reread_is_deduped() {
        let f = fixture("dedupe", 100_000);
        let model = MockCompletionModel::from_stream_turns([
            call("c1", "read_file", json!({"path": "a.txt"})),
            call("c2", "list_dir", json!({"path": ""})),
            call("c3", "read_file", json!({"path": "a.txt"})),
            answer("ok"),
        ]);
        rt().block_on(run(&f, &model, MockCompletionModel::default())).unwrap();
        let results = last_results(&model.requests()[3]);
        assert!(results[0].contains("have not changed since you read them at step 1"), "{results:?}");
        assert!(!results[0].contains("hello from a"));
    }

    #[test]
    fn third_identical_call_gets_a_system_warning_fifth_stops() {
        let f = fixture("guard", 100_000);
        let same = || json!({"path": ""});
        let mut turns: Vec<Vec<MockStreamEvent>> = (1..=5).map(|i| call(&format!("c{i}"), "list_dir", same())).collect();
        turns.push(answer("never"));
        let model = MockCompletionModel::from_stream_turns(turns);
        let out = rt().block_on(run(&f, &model, MockCompletionModel::default()));
        let reqs = model.requests();
        let third = last_results(&reqs[3]);
        assert!(
            third[0].contains("SYSTEM WARNING: You have invoked tool list_dir with identical parameters 3 times"),
            "{third:?}"
        );
        assert!(out.unwrap_err().contains(GUARD_STOP));
        assert_eq!(reqs.len(), 5, "no request after the stop");
    }

    #[test]
    fn unknown_tool_is_an_error_result_not_a_crash() {
        let f = fixture("unknown", 100_000);
        let model = MockCompletionModel::from_stream_turns([call("c1", "no_such_tool", json!({})), answer("fine")]);
        assert_eq!(rt().block_on(run(&f, &model, MockCompletionModel::default())).as_deref(), Ok("fine"));
        let results = last_results(&model.requests()[1]);
        assert!(results[0].contains("ERROR: unknown tool"), "{results:?}");
    }

    #[test]
    fn history_is_compacted_near_the_window() {
        let f = fixture("compact", 10_000);
        let model = MockCompletionModel::from_stream_turns([
            call("c1", "read_file", json!({"path": "a.txt"})),
            call("c2", "list_dir", json!({"path": ""})),
            vec![MockStreamEvent::tool_call("c3", "find_files", json!({"pattern": "*.txt"})), usage(8_000)],
            answer("finished"),
        ]);
        let unary = MockCompletionModel::from_turns([MockTurn::text("Goal: read a.txt. Done: read it.")]);
        let out = rt().block_on(run(&f, &model, unary));
        assert_eq!(out.as_deref(), Ok("finished"));
        let last = model.requests().pop().unwrap();
        let first_user = serde_json::to_string(&last.chat_history[1]).unwrap();
        assert!(first_user.contains("SummaryOfPreviousSteps") && first_user.contains("read a.txt"), "{first_user}");
        assert!(first_user.contains("Goal: read a.txt. Done: read it."));
        // System + summary + the last two turns (call + results each).
        assert_eq!(last.chat_history.len(), 1 + 1 + 4);
    }

    #[test]
    fn failed_compaction_does_not_stop_the_run() {
        let f = fixture("compact-fail", 10_000);
        let model = MockCompletionModel::from_stream_turns([
            call("c1", "read_file", json!({"path": "a.txt"})),
            call("c2", "list_dir", json!({"path": ""})),
            vec![MockStreamEvent::tool_call("c3", "find_files", json!({"pattern": "*.txt"})), usage(8_000)],
            answer("finished"),
        ]);
        // No unary turn scripted: the summary request fails.
        let out = rt().block_on(run(&f, &model, MockCompletionModel::default()));
        assert_eq!(out.as_deref(), Ok("finished"));
        assert_eq!(model.requests().last().unwrap().chat_history.len(), 1 + 7, "history kept whole");
    }

    #[test]
    fn task_is_the_last_user_text() {
        let h = vec![
            Message::user("old"),
            Message::assistant("a"),
            Message::user("fix it"),
            Message::tool_result("c", "read_file", "x"),
        ];
        assert_eq!(last_user_text(&h), "fix it");
    }
}
