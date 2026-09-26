//! Anthropic tool_use protocol loop (Claude and /v1/messages-compatible APIs).

use super::context::prune_anthropic;
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

/* ---------- Anthropic tool_use protocol ---------- */

#[derive(Deserialize)]
pub(super) struct AnthropicStreamEvent {
    #[serde(rename = "type")]
    pub(super) kind: Option<String>,
    pub(super) index: Option<usize>,
    pub(super) content_block: Option<AnthropicBlock>,
    pub(super) delta: Option<AnthropicStreamDelta>,
    pub(super) error: Option<ApiError>,
    /// "message_start" carries the message with its initial usage block.
    message: Option<AnthropicMessage>,
    /// "message_delta" carries the round's cumulative output token count.
    #[serde(default)]
    usage: Option<AnthropicUsage>,
}

#[derive(Deserialize)]
struct AnthropicMessage {
    #[serde(default)]
    usage: Option<AnthropicUsage>,
}

/// Anthropic token accounting (prompt caching included).
#[derive(Debug, Clone, Deserialize)]
struct AnthropicUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    /// Prompt-cache hits — billed at ~10% and served much faster.
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

#[derive(Deserialize)]
pub(super) struct AnthropicBlock {
    #[serde(rename = "type")]
    pub(super) kind: Option<String>,
    pub(super) id: Option<String>,
    pub(super) name: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct AnthropicStreamDelta {
    #[serde(rename = "type")]
    pub(super) kind: Option<String>,
    pub(super) text: Option<String>,
    pub(super) partial_json: Option<String>,
    /// Extended thinking arrives as `thinking_delta` with the text here.
    pub(super) thinking: Option<String>,
}

pub(super) async fn run_anthropic(
    app: &AppHandle,
    run_id: &str,
    req: &AgentRequest,
    system: &str,
    root: &Path,
    turns: Vec<crate::chat::ChatTurn>,
    step_index_start: usize,
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
    let mut step_index = step_index_start;
    // Stuck-loop guard: identical consecutive tool-call rounds are nudged,
    // then aborted WITH partial output instead of spinning to MAX_STEPS.
    let mut guard = RepeatGuard::default();
    // Consecutive tool failures — a crash-looping model gets a visible nudge.
    let mut fail_streak = 0usize;
    // DEBUG HUD: cumulative usage across the run's rounds. Anthropic reports
    // input tokens + cache hits on "message_start" and the round's output
    // total on "message_delta".
    let started_at = std::time::Instant::now();
    let mut usage = RunUsage {
        run_id: run_id.to_string(),
        prompt_tokens: 0,
        completion_tokens: 0,
        cached_tokens: 0,
        elapsed_ms: 0,
    };

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

    for round in 0..MAX_STEPS {
        if is_cancelled(run_id) {
            return cancelled_result(final_text);
        }
        // Graceful finish: near the budget the model wraps up on its own
        // instead of being cut off mid-project at the hard limit.
        if round == WRAP_UP_AT {
            inject_wrap_up(&mut messages, true);
        }
        // Same pruning policy as the OpenAI loop: keep the context in budget.
        prune_anthropic(&mut messages);
        // PROMPT CACHING (Anthropic): the system prompt and the tool schemas
        // are byte-stable across rounds, so mark them with ephemeral
        // cache_control breakpoints — repeat rounds hit the provider-side
        // cache (~90% cheaper input, faster TTFT).
        let mut tools_arr: Vec<Value> = tool_specs(req)
            .as_array()
            .map(|specs| {
                specs
                    .iter()
                    .map(|s| {
                        json!({
                            "name": s["name"],
                            "description": s["description"],
                            "input_schema": s["parameters"],
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        if let Some(last) = tools_arr.last_mut() {
            last["cache_control"] = json!({ "type": "ephemeral" });
        }
        let mut body = json!({
            "model": req.model,
            "max_tokens": max_tokens,
            "system": [{
                "type": "text",
                "text": system,
                "cache_control": { "type": "ephemeral" }
            }],
            "messages": messages,
            "tools": tools_arr,
            "stream": true,
        });
        if let Some(budget) = thinking_budget {
            body["thinking"] = json!({ "type": "enabled", "budget_tokens": budget });
        }

        let body_final = body.clone();
        let url_c = url.clone();
        let key_c = req.api_key.trim().to_string();
        let client_ref = &client;
        let build = move || {
            let mut r = client_ref
                .post(&url_c)
                .header("Content-Type", "application/json")
                .header("anthropic-version", "2023-06-01")
                .json(&body_final);
            if !key_c.is_empty() {
                r = r.header("x-api-key", key_c.as_str());
            }
            r
        };

        // Provider limits (RPM + concurrency), shared with every other call
        // path for this provider.
        let limiter_key = if req.provider_id.is_empty() {
            req.base_url.clone()
        } else {
            req.provider_id.clone()
        };
        let _permit = crate::limiter::acquire(&limiter_key, req.rate_limit_rpm, req.concurrency, run_id).await;
        if is_cancelled(run_id) {
            return cancelled_result(final_text);
        }

        // Stop interrupts immediately; transient 429/5xx retry (visibly in
        // chat) instead of ending the run — a single 502 used to kill it.
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
            return Err(format!("Anthropic returned {status}: {detail}"));
        }

        let mut stream = res.bytes_stream();
        // Incremental UTF-8: a chunk boundary must not split a multi-byte char.
        let mut decoder = crate::utf8stream::StreamDecoder::new();
        let mut buf = String::new();
        let mut round_text = String::new();
        // Tool inputs stream as partial JSON keyed by content-block index.
        let mut blocks: Vec<PendingCall> = Vec::new();

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
                let Some(data) = line.strip_prefix("data: ") else {
                    continue;
                };
                let Ok(parsed) = serde_json::from_str::<AnthropicStreamEvent>(data) else {
                    continue;
                };
                if let Some(err) = parsed.error {
                    return Err(err.message.unwrap_or_else(|| "provider error".into()));
                }

                // DEBUG HUD usage accounting:
                // * message_start → input_tokens (+ cache_read_input_tokens)
                // * message_delta → the round's cumulative output_tokens
                match parsed.kind.as_deref() {
                    Some("message_start") => {
                        if let Some(u) = parsed.message.and_then(|m| m.usage) {
                            usage.prompt_tokens += u.input_tokens + u.cache_creation_input_tokens;
                            usage.cached_tokens += u.cache_read_input_tokens;
                            usage.elapsed_ms = started_at.elapsed().as_millis() as u64;
                            emit_usage(app, &usage);
                        }
                    }
                    Some("message_delta") => {
                        if let Some(u) = parsed.usage {
                            if u.output_tokens > 0 {
                                usage.completion_tokens += u.output_tokens;
                                usage.elapsed_ms = started_at.elapsed().as_millis() as u64;
                                emit_usage(app, &usage);
                            }
                        }
                    }
                    _ => {}
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
            // DIFF-ONLY mode: inline SEARCH/REPLACE blocks pasted into the
            // reply are applied here exactly like apply_patch tool calls.
            let patches = tools::extract_inline_patches(&round_text);
            if patches.is_empty() {
                // Never finish on a silent blank bubble — surface WHY instead.
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

        // Stuck-loop guard: fingerprint this round's calls BEFORE executing.
        let fp = call_fingerprint(
            &used
                .iter()
                .map(|b| {
                    let a: Value = serde_json::from_str(&b.args).unwrap_or(json!({}));
                    format!("{}({})", b.name, summarize(&b.name, &a))
                })
                .collect::<Vec<_>>(),
        );
        let repeats = guard.record(&fp);
        if repeats >= REPEAT_ABORT_AT {
            // Same calls N times in a row: stop WITH what we have, explained.
            let note = format!(
                "\n\n⚠️ Stopped early: the model repeated the same action {repeats} times in a row ({fp}). Everything it produced so far is above."
            );
            emit_text(app, run_id, note);
            return Ok(final_text);
        }
        if repeats >= REPEAT_NUDGE_AT {
            // Do NOT re-execute identical calls — but every tool_use MUST get
            // a tool_result or the API rejects the next request, so answer
            // synthetically with the nudge text.
            let nudge = repeat_nudge(&fp, repeats);
            emit_text(app, run_id, format!("\n\n🔁 Repeated action ({repeats}×) — nudging the model…\n"));
            let results: Vec<Value> = used
                .iter()
                .map(|b| {
                    json!({
                        "type": "tool_result",
                        "tool_use_id": b.id,
                        "content": nudge,
                        "is_error": true,
                    })
                })
                .collect();
            messages.push(json!({ "role": "user", "content": results }));
            continue;
        }

        // Results come back as tool_result blocks in a single user turn.
        let mut results: Vec<Value> = Vec::new();
        for b in &used {
            if is_cancelled(run_id) {
                return cancelled_result(final_text);
            }
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
            // ssh_exec is async itself (russh) and runs right here instead.
            let tool_root = root.to_path_buf();
            let tool_name = b.name.clone();
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

            emit_step(app, run_id, this_index, &b.name, summary, true, &result);

            // Failure-streak watch — same policy as the OpenAI loop.
            fail_streak = if result.ok { 0 } else { fail_streak + 1 };
            let mut content = result.output;
            if fail_streak >= FAIL_NUDGE_AT {
                content.push_str(&format!("\n\n{}", fail_nudge(&b.name)));
                emit_text(
                    app,
                    run_id,
                    format!("\n\n⚠️ {} failed {fail_streak} times in a row — asking the model to re-plan…\n", b.name),
                );
            }

            results.push(json!({
                "type": "tool_result",
                "tool_use_id": b.id,
                "content": content,
                "is_error": !result.ok,
            }));
        }
        messages.push(json!({ "role": "user", "content": results }));
    }

    // Step budget exhausted: keep the partial output, explain, never error.
    let note = format!(
        "\n\n⚠️ Stopped after {MAX_STEPS} rounds without a final answer — the task is too large for one run. Everything completed so far is above; continue the conversation to pick up where it stopped."
    );
    emit_text(app, run_id, note);
    Ok(final_text)
}
