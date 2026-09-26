//! OpenAI-compatible tool_calls protocol loop (OpenAI, DeepSeek, Ollama,
//! vLLM, LM Studio and anything else that speaks /chat/completions).

use super::context::prune_openai;
use super::guard::{
    call_fingerprint, fail_nudge, repeat_nudge, RepeatGuard, FAIL_NUDGE_AT, REPEAT_ABORT_AT,
    REPEAT_NUDGE_AT,
};
use super::prompt::{summarize, tool_specs};
use super::{
    ask_confirm, cancelled_result, emit_step, emit_text, emit_think, emit_usage, inject_wrap_up,
    is_cancelled, run_ssh_tool, send_with_retry, AgentRequest, ApiError, PendingCall, RunUsage,
    MAX_STEPS, WRAP_UP_AT,
};
use crate::tools;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;
use tauri::AppHandle;

/* ---------- OpenAI tool_calls protocol ---------- */

#[derive(Deserialize)]
pub(super) struct ToolCallDelta {
    pub(super) index: Option<usize>,
    pub(super) id: Option<String>,
    pub(super) function: Option<FunctionDelta>,
}

#[derive(Deserialize)]
pub(super) struct FunctionDelta {
    pub(super) name: Option<String>,
    pub(super) arguments: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct StreamChoice {
    pub(super) delta: Option<StreamDelta>,
    #[serde(rename = "finish_reason")]
    _finish_reason: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct StreamDelta {
    pub(super) content: Option<String>,
    /// DeepSeek and OpenAI o-series stream reasoning separately from content.
    reasoning_content: Option<String>,
    reasoning: Option<String>,
    pub(super) tool_calls: Option<Vec<ToolCallDelta>>,
}

#[derive(Deserialize)]
pub(super) struct StreamChunk {
    pub(super) choices: Option<Vec<StreamChoice>>,
    pub(super) error: Option<ApiError>,
    /// Final-chunk usage accounting (requires stream_options.include_usage).
    #[serde(default)]
    usage: Option<OpenAiUsage>,
    /// Ollama reports token counts on the top level instead.
    #[serde(default)]
    prompt_eval_count: u64,
    #[serde(default)]
    eval_count: u64,
}

/// Token accounting as reported by OpenAI-compatible providers.
#[derive(Debug, Clone, Deserialize)]
pub struct OpenAiUsage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
    #[serde(default)]
    pub prompt_tokens_details: Option<PromptTokensDetails>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PromptTokensDetails {
    /// Tokens served from the provider's prompt cache (cheaper, faster).
    #[serde(default)]
    pub cached_tokens: u64,
}

pub(super) async fn run_openai(
    app: &AppHandle,
    run_id: &str,
    req: &AgentRequest,
    system: &str,
    root: &Path,
    turns: Vec<crate::chat::ChatTurn>,
    step_index_start: usize,
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
    let mut step_index = step_index_start;
    // Stuck-loop guard: identical consecutive tool-call rounds are nudged,
    // then aborted WITH partial output instead of spinning to MAX_STEPS.
    let mut guard = RepeatGuard::default();
    // Consecutive tool failures — a crash-looping model gets a visible nudge
    // to re-plan instead of trying variation after variation.
    let mut fail_streak = 0usize;
    // DEBUG HUD: cumulative usage of the whole run (all rounds). Ollama reports
    // usage under different field names, so keep both shapes handy.
    let started_at = std::time::Instant::now();
    let mut usage = RunUsage {
        run_id: run_id.to_string(),
        prompt_tokens: 0,
        completion_tokens: 0,
        cached_tokens: 0,
        elapsed_ms: 0,
    };

    for round in 0..MAX_STEPS {
        if is_cancelled(run_id) {
            return cancelled_result(final_text);
        }
        // Graceful finish: near the budget the model wraps up on its own
        // instead of being cut off mid-project at the hard limit.
        if round == WRAP_UP_AT {
            inject_wrap_up(&mut messages, false);
        }
        // Context pruning runs before EVERY request: old tool outputs collapse,
        // oldest tool-call pairs drop, so the wire context stays inside budget.
        prune_openai(&mut messages);
        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "tools": tool_specs(req).as_array().map(|specs| {
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
        // Ask for the final usage chunk (OpenAI-compatible providers; harmless
        // elsewhere — unknown fields are ignored).
        if req.kind != "ollama" {
            body["stream_options"] = json!({ "include_usage": true });
        }
        // Reasoning effort, only when the user picked a non-default level.
        if let Some(eff) = crate::chat::reasoning_effort(&req.effort) {
            body["reasoning_effort"] = json!(eff);
        }

        let body_final = body.clone();
        let url_c = url.clone();
        let key_c = req.api_key.trim().to_string();
        // Borrow the client — the closure is rebuilt every round, and moving
        // the client into it would leave later rounds without one.
        let client_ref = &client;
        let build = move || {
            let mut r = client_ref
                .post(&url_c)
                .header("Content-Type", "application/json")
                .json(&body_final);
            if !key_c.is_empty() {
                r = r.bearer_auth(key_c.as_str());
            }
            r
        };

        // Provider limits (RPM + concurrency) — the permit lives until the
        // streamed response finishes, so in-flight accounting is exact.
        let limiter_key = if req.provider_id.is_empty() {
            req.base_url.clone()
        } else {
            req.provider_id.clone()
        };
        let _permit = crate::limiter::acquire(&limiter_key, req.rate_limit_rpm, req.concurrency, run_id).await;
        if is_cancelled(run_id) {
            return cancelled_result(final_text);
        }

        // Stop interrupts the send immediately; transient 429/5xx get RETRIED
        // (with the retry visible in chat) instead of killing the whole run —
        // "provider returned 502" used to end generations outright.
        let res = match send_with_retry(app, run_id, build).await {
            Ok(r) => r,
            Err(e) if e.starts_with(crate::cancel::STOPPED) => {
                return cancelled_result(final_text.clone());
            }
            Err(e) => return Err(e),
        };
        let status = res.status();
        if !status.is_success() {
            let detail = res.text().await.unwrap_or_default();
            return Err(format!("provider returned {status}: {detail}"));
        }

        // Parse the stream, collecting text and any tool calls. The decoder
        // keeps an incomplete multi-byte tail across chunks — splitting a
        // Cyrillic character mid-chunk must not mangle the text.
        let mut stream = res.bytes_stream();
        let mut decoder = crate::utf8stream::StreamDecoder::new();
        let mut buf = String::new();
        let mut calls: Vec<PendingCall> = Vec::new();
        let mut round_text = String::new();

        loop {
            // Stop fires IMMEDIATELY, even while the provider is silent: the
            // cancel signal races the next stream chunk instead of waiting for it.
            let chunk = tokio::select! {
                c = stream.next() => match c {
                    Some(c) => c,
                    None => break,
                },
                _ = crate::cancel::cancel_signal(run_id) => {
                    drop(stream);
                    return cancelled_result(final_text.clone() + &round_text);
                }
            };
            let bytes = chunk.map_err(|e| format!("stream error: {e}"))?;
            buf.push_str(&decoder.push(&bytes));

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
                // DEBUG HUD usage accounting — providers that report it:
                // OpenAI-compatible (final chunk), Ollama (every line).
                if let Some(u) = &parsed.usage {
                    usage.prompt_tokens += u.prompt_tokens;
                    usage.completion_tokens += u.completion_tokens;
                    if let Some(d) = &u.prompt_tokens_details {
                        usage.cached_tokens += d.cached_tokens;
                    }
                    usage.elapsed_ms = started_at.elapsed().as_millis() as u64;
                    emit_usage(app, &usage);
                }
                if parsed.prompt_eval_count > 0 || parsed.eval_count > 0 {
                    usage.prompt_tokens += parsed.prompt_eval_count;
                    usage.completion_tokens += parsed.eval_count;
                    usage.elapsed_ms = started_at.elapsed().as_millis() as u64;
                    emit_usage(app, &usage);
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

        // No tools requested — but DIFF-ONLY mode also catches inline
        // SEARCH/REPLACE blocks pasted into the reply text: they are applied
        // exactly like apply_patch calls and the model is told to continue.
        if calls.iter().all(|c| c.name.is_empty()) {
            let patches = tools::extract_inline_patches(&round_text);
            if patches.is_empty() {
                // A completely empty answer is a failure the user must SEE,
                // not a silent blank bubble (reasoning-only output, cut
                // stream, over-pruned prompt…).
                if final_text.trim().is_empty() {
                    return Err(
                        "the model returned an empty answer — its output may have been reasoning-only or the stream was cut; retry, or try another model/effort level".into(),
                    );
                }
                return Ok(final_text);
            }
            messages.push(json!({ "role": "assistant", "content": round_text }));
            let mut results_text = String::new();
            for (path, diff) in &patches {
                if is_cancelled(run_id) {
                    return cancelled_result(final_text);
                }
                step_index += 1;
                let this_index = step_index;
                let summary = format!("{path} (inline patch)");
                emit_step(
                    app,
                    run_id,
                    this_index,
                    "apply_patch",
                    summary.clone(),
                    false,
                    &tools::ToolResult::ok(""),
                );
                let tool_root = root.to_path_buf();
                let (path_c, diff_c) = (path.clone(), diff.clone());
                let result = tokio::task::spawn_blocking(move || {
                    tools::apply_patch(&tool_root, &path_c, &diff_c)
                })
                .await
                .unwrap_or_else(|e| tools::ToolResult::err(format!("tool task failed: {e}")));
                emit_step(app, run_id, this_index, "apply_patch", summary, true, &result);
                results_text.push_str(&format!("{path}: {}\n", result.output));
            }
            messages.push(json!({
                "role": "user",
                "content": format!(
                    "Your reply contained inline SEARCH/REPLACE blocks; they were applied via apply_patch. Results:\n{results_text}\nDo not paste code into replies — call the apply_patch tool instead. Continue the task or give the final summary."
                ),
            }));
            continue;
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

        // Stuck-loop guard: fingerprint this round's calls BEFORE executing.
        let fp = call_fingerprint(
            &calls
                .iter()
                .filter(|c| !c.name.is_empty())
                .map(|c| {
                    let a: Value = serde_json::from_str(&c.args).unwrap_or(json!({}));
                    format!("{}({})", c.name, summarize(&c.name, &a))
                })
                .collect::<Vec<_>>(),
        );
        let repeats = guard.record(&fp);
        if repeats >= REPEAT_ABORT_AT {
            // Same calls N times in a row: stop WITH what we have, explained —
            // never throw the run away as an error (the old MAX_STEPS behaviour).
            let note = format!(
                "\n\n⚠️ Stopped early: the model repeated the same action {repeats} times in a row ({fp}). Everything it produced so far is above."
            );
            emit_text(app, run_id, note);
            return Ok(final_text);
        }
        if repeats >= REPEAT_NUDGE_AT {
            // Do NOT re-execute identical calls (same inputs, same outputs,
            // wasted tokens, frozen transcript). But every tool_call MUST be
            // answered with a tool message or strict APIs reject the next
            // request — so answer synthetically with the nudge text.
            let nudge = repeat_nudge(&fp, repeats);
            emit_text(app, run_id, format!("\n\n🔁 Repeated action ({repeats}×) — nudging the model…\n"));
            for call in calls.iter().filter(|c| !c.name.is_empty()) {
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": nudge,
                }));
            }
            continue;
        }

        // Run each tool and feed the results back. The step event carries the
        // call, so the UI can place it inline — do not inject it into the text.
        for call in calls.iter().filter(|c| !c.name.is_empty()) {
            if is_cancelled(run_id) {
                return cancelled_result(final_text);
            }
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
            // ssh_exec is async itself (russh) and runs right here instead.
            let tool_root = root.to_path_buf();
            let tool_name = call.name.clone();
            let tool_args = args.clone();
            let result = if denied {
                tools::ToolResult::err(
                    "The user denied this command. Do not retry it — continue without it.",
                )
            } else if tool_name == "ssh_exec" {
                run_ssh_tool(app, req, &tool_args).await
            } else {
                tokio::task::spawn_blocking(move || {
                    tools::dispatch(&tool_root, &tool_name, &tool_args)
                })
                .await
                .unwrap_or_else(|e| tools::ToolResult::err(format!("tool task failed: {e}")))
            };

            emit_step(app, run_id, this_index, &call.name, summary, true, &result);

            // Failure-streak watch: keep the pairing valid by APPENDING the
            // nudge to the tool result, and show the user what is happening.
            fail_streak = if result.ok { 0 } else { fail_streak + 1 };
            let mut content = result.output;
            if fail_streak >= FAIL_NUDGE_AT {
                content.push_str(&format!("\n\n{}", fail_nudge(&call.name)));
                emit_text(
                    app,
                    run_id,
                    format!("\n\n⚠️ {} failed {fail_streak} times in a row — asking the model to re-plan…\n", call.name),
                );
            }

            messages.push(json!({
                "role": "tool",
                "tool_call_id": call.id,
                "content": content,
            }));
        }
    }

    // Step budget exhausted: NEVER throw the work away — the user keeps
    // everything produced so far plus a clear explanation of why it stopped.
    let note = format!(
        "\n\n⚠️ Stopped after {MAX_STEPS} rounds without a final answer — the task is too large for one run. Everything completed so far is above; continue the conversation to pick up where it stopped."
    );
    emit_text(app, run_id, note);
    Ok(final_text)
}
