//! Decomposed execution: parallel subtasks (bounded by the provider limits)
//! plus the streamed merge round that sees every summary.

use super::context::{one_line, prune_anthropic, prune_openai};
use super::planner::{emit_tasks, plan_subtasks, TaskState};
use super::prompt::{default_system, summarize, tool_specs};
use super::{
    cancelled_result, emit_step, emit_text, is_cancelled, run_protocol, run_protocol_from,
    run_ssh_tool, AgentRequest, MAX_STEPS,
};
use crate::tools;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Mutex;
use tauri::AppHandle;

/// Runs ONE subtask to completion: a non-streaming tool loop. Parallel
/// siblings each keep their own conversation; streaming all of them into the
/// single UI text feed would interleave into noise — the final merge round
/// streams, so the user still watches the answer appear.
async fn run_subtask(
    app: &AppHandle,
    req: &AgentRequest,
    root: &Path,
    run_id: &str,
    step_index: &std::sync::Arc<Mutex<usize>>,
    title: &str,
    prompt: &str,
) -> Result<String, String> {
    let system = format!(
        "{}\n\nYou are executing ONE subtask of a larger decomposed request: \"{}\". Stay strictly inside this subtask's scope; do not redo other parts. When done, answer with a SHORT factual summary of what you changed or found.",
        default_system(),
        title
    );
    let anthropic = req.kind == "anthropic-messages";
    let url = if req.kind == "ollama" {
        format!("{}/api/chat", req.base_url.trim_end_matches('/'))
    } else if anthropic {
        format!("{}/messages", req.base_url.trim_end_matches('/'))
    } else {
        format!("{}/chat/completions", req.base_url.trim_end_matches('/'))
    };
    let client = reqwest::Client::new();
    let mut messages: Vec<Value> = if anthropic {
        vec![json!({ "role": "user", "content": prompt })]
    } else {
        vec![
            json!({ "role": "system", "content": system }),
            json!({ "role": "user", "content": prompt }),
        ]
    };

    // Last text the model produced — returned as a partial result when the
    // step budget runs out instead of discarding everything ("subtask failed").
    let mut last_text = String::new();

    for _ in 0..MAX_STEPS {
        if is_cancelled(run_id) {
            return Err(crate::cancel::STOPPED.to_string());
        }
        let mut body = if anthropic {
            json!({
                "model": req.model,
                "max_tokens": 4096,
                "system": system,
                "messages": messages,
                "tools": tool_specs(req).as_array().map(|specs| specs.iter().map(|s| json!({
                    "name": s["name"], "description": s["description"], "input_schema": s["parameters"],
                })).collect::<Vec<_>>()).unwrap_or_default(),
                "stream": false,
            })
        } else {
            json!({
                "model": req.model,
                "messages": messages,
                "tools": tool_specs(req).as_array().map(|specs| specs.iter().map(|s| json!({
                    "type": "function",
                    "function": { "name": s["name"], "description": s["description"], "parameters": s["parameters"] },
                })).collect::<Vec<_>>()).unwrap_or_default(),
                "stream": false,
            })
        };
        if let Some(eff) = crate::chat::reasoning_effort(&req.effort) {
            if !anthropic {
                body["reasoning_effort"] = json!(eff);
            }
        }

        let mut request = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body);
        if anthropic {
            request = request.header("anthropic-version", "2023-06-01");
            if !req.api_key.trim().is_empty() {
                request = request.header("x-api-key", req.api_key.trim());
            }
        } else if !req.api_key.trim().is_empty() {
            request = request.bearer_auth(req.api_key.trim());
        }

        // Every subtask request obeys the provider's RPM/concurrency limits —
        // the whole point of running tasks in parallel without tripping quota.
        let key = if req.provider_id.is_empty() { req.base_url.clone() } else { req.provider_id.clone() };
        let _permit = crate::limiter::acquire(&key, req.rate_limit_rpm, req.concurrency, run_id).await;
        // Stop interrupts the send immediately instead of waiting for the wire.
        let res = tokio::select! {
            r = request.send() => r.map_err(|e| format!("subtask request failed: {e}"))?,
            _ = crate::cancel::cancel_signal(run_id) => return Err(crate::cancel::STOPPED.to_string()),
        };
        if !res.status().is_success() {
            let detail = res.text().await.unwrap_or_default();
            return Err(format!("subtask provider error: {}", trim_detail(&detail)));
        }
        // Stop interrupts the body read immediately, like everywhere else.
    let v: Value = tokio::select! {
        r = res.json() => r.map_err(|e| format!("bad subtask response: {e}"))?,
        _ = crate::cancel::cancel_signal(run_id) => return Err(crate::cancel::STOPPED.to_string()),
    };

        if anthropic {
            let blocks = v["content"].as_array().cloned().unwrap_or_default();
            let text: String = blocks.iter()
                .filter(|b| b["type"].as_str() == Some("text"))
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>().join("");
            let uses: Vec<Value> = blocks.iter()
                .filter(|b| b["type"].as_str() == Some("tool_use"))
                .cloned().collect();
            // LIVE progress: a subtask is non-streamed, so each round's text
            // is shown as it lands — the chat is never silent while tasks work.
            if !text.trim().is_empty() {
                last_text = text.clone();
                emit_text(app, run_id, format!("\n\n**▸ {}** {}\n", title, one_line(&text, 400)));
            }
            if uses.is_empty() {
                return Ok(text);
            }
            let mut asst = Vec::new();
            if !text.is_empty() {
                asst.push(json!({ "type": "text", "text": text }));
            }
            for u in &uses {
                asst.push(json!({ "type": "tool_use", "id": u["id"], "name": u["name"], "input": u["input"] }));
            }
            messages.push(json!({ "role": "assistant", "content": asst }));
            let mut results = Vec::new();
            for u in &uses {
                let name = u["name"].as_str().unwrap_or("");
                let args = u["input"].clone();
                let r = execute_subtask_tool(app, req, root, run_id, step_index, name, &args).await;
                results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": u["id"],
                    "content": r.output,
                    "is_error": !r.ok,
                }));
            }
            messages.push(json!({ "role": "user", "content": results }));
        } else {
            let msg = &v["choices"][0]["message"];
            let text = msg["content"].as_str().unwrap_or("").to_string();
            let calls = msg["tool_calls"].as_array().cloned().unwrap_or_default();
            // LIVE progress — same policy as the Anthropic branch.
            if !text.trim().is_empty() {
                last_text = text.clone();
                emit_text(app, run_id, format!("\n\n**▸ {}** {}\n", title, one_line(&text, 400)));
            }
            if calls.is_empty() {
                return Ok(text);
            }
            messages.push(msg.clone());
            for c in &calls {
                let name = c["function"]["name"].as_str().unwrap_or("");
                let args: Value = c["function"]["arguments"].as_str()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or(json!({}));
                let r = execute_subtask_tool(app, req, root, run_id, step_index, name, &args).await;
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": c["id"],
                    "content": r.output,
                }));
            }
        }
        // Keep subtask histories small: old tool outputs collapse to markers.
        if anthropic {
            prune_anthropic(&mut messages);
        } else {
            prune_openai(&mut messages);
        }
    }
    // Step budget exhausted: return the partial result — the merge round gets
    // a usable summary instead of treating the whole subtask as failed.
    Ok(format!(
        "(subtask hit the step limit; partial result)\n{}",
        last_text
    ))
}

fn trim_detail(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() > 300 {
        t.chars().take(300).collect::<String>() + "…"
    } else {
        t.to_string()
    }
}

/// Tool execution for a subtask round — same dispatch as the main loop.
/// run_command still honours the permission mode, but parallel subtasks
/// cannot show an approval banner without racing the UI, so in "ask" mode
/// commands are deferred to the final merge round (which has the normal gate).
async fn execute_subtask_tool(
    app: &AppHandle,
    req: &AgentRequest,
    root: &Path,
    run_id: &str,
    step_index: &std::sync::Arc<Mutex<usize>>,
    name: &str,
    args: &Value,
) -> tools::ToolResult {
    if name == "run_command" && !req.auto_run {
        return tools::ToolResult::err(
            "run_command needs user approval, which parallel subtasks cannot request. Note it in your summary — the final round will run it.".to_string(),
        );
    }
    if name == "ssh_exec" {
        return run_ssh_tool(app, req, args).await;
    }
    let summary = summarize(name, args);
    let idx = {
        let mut s = step_index.lock().unwrap();
        *s += 1;
        *s
    };
    emit_step(app, run_id, idx, name, summary.clone(), false, &tools::ToolResult::ok(""));
    let tool_root = root.to_path_buf();
    let tool_name = name.to_string();
    let tool_args = args.clone();
    let result = tokio::task::spawn_blocking(move || tools::dispatch(&tool_root, &tool_name, &tool_args))
        .await
        .unwrap_or_else(|e| tools::ToolResult::err(format!("tool task failed: {e}")));
    emit_step(app, run_id, idx, name, summary, true, &result);
    result
}
/// Decomposed execution: plan → parallel subtasks (bounded by the provider's
/// concurrency limit) → streamed merge round that sees every summary.
pub(super) async fn run_decomposed(
    app: &AppHandle,
    run_id: &str,
    req: &AgentRequest,
    system: &str,
    root: &Path,
    turns: Vec<crate::chat::ChatTurn>,
) -> Result<String, String> {
    // The prompt being decomposed is the LAST user turn.
    let user_prompt = turns
        .iter()
        .rev()
        .find(|t| t.role != "agent" && t.role != "assistant")
        .map(|t| t.text.clone())
        .unwrap_or_default();
    if user_prompt.trim().is_empty() {
        return run_protocol(app, run_id, req, system, root, turns).await;
    }

    emit_text(app, run_id, "Decomposing the request into subtasks…\n\n");
    let plan = match plan_subtasks(app, run_id, req, &user_prompt).await {
        Some(p) if !is_cancelled(run_id) => p,
        _ => {
            // Simple request (or planning failed): normal single loop, no
            // tokens wasted on ceremony.
            if is_cancelled(run_id) {
                return cancelled_result(String::new());
            }
            emit_text(app, run_id, "Single-step request — running directly.\n\n");
            return run_protocol(app, run_id, req, system, root, turns).await;
        }
    };

    // Shared task board — each subtask flips its own status to running the
    // moment it grabs a concurrency slot, so the list in the chat shows
    // EXACTLY what is happening right now (queued vs working).
    let board: std::sync::Arc<Mutex<Vec<TaskState>>> = std::sync::Arc::new(Mutex::new(
        plan.iter()
            .enumerate()
            .map(|(i, (title, _))| TaskState {
                id: i + 1,
                title: title.clone(),
                status: "pending".into(),
                summary: String::new(),
            })
            .collect(),
    ));
    emit_tasks(app, run_id, &board.lock().unwrap());

    // Concurrency: the provider's configured limit (fallback 3). The limiter
    // ALSO enforces it globally — this semaphore just avoids spawning dozens
    // of futures that would all sit in the limiter queue.
    let parallel = if req.concurrency > 0 { req.concurrency } else { 3 };
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(parallel));
    let step_index = std::sync::Arc::new(Mutex::new(0usize));

    let mut handles = Vec::new();
    for (i, (title, prompt)) in plan.iter().enumerate() {
        let app_c = app.clone();
        let req_c = req.clone();
        let root_c = root.to_path_buf();
        let run_c = run_id.to_string();
        let title_c = title.clone();
        let prompt_c = prompt.clone();
        let sem_c = sem.clone();
        let idx_c = step_index.clone();
        let board_c = board.clone();
        handles.push(tokio::spawn(async move {
            let permit = sem_c.acquire().await.map_err(|e| e.to_string())?;
            // The task really starts NOW — mark it running and refresh the board.
            {
                let mut b = board_c.lock().unwrap();
                b[i].status = "running".into();
                emit_tasks(&app_c, &run_c, &b);
            }
            let out = run_subtask(&app_c, &req_c, &root_c, &run_c, &idx_c, &title_c, &prompt_c).await;
            drop(permit);
            Ok::<(usize, Result<String, String>), String>((i, out))
        }));
    }

    let mut summaries: Vec<String> = vec![String::new(); plan.len()];
    for h in handles {
        let (i, out) = match h.await {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => return Err(e),
            Err(e) => return Err(format!("subtask panicked: {e}")),
        };
        // Update the board under the lock, then tell the user what finished —
        // the run is never silent while subtasks work.
        let mut b = board.lock().unwrap();
        match out {
            Ok(s) => {
                b[i].status = "done".into();
                b[i].summary = one_line_summary(&s);
                emit_tasks(app, run_id, &b);
                summaries[i] = format!("### Subtask {}: {}\n{}\n", i + 1, b[i].title, s);
                emit_text(app, run_id, format!("\n\n✓ **{}** — done\n", b[i].title));
            }
            Err(e) => {
                if e.starts_with(crate::cancel::STOPPED) {
                    return cancelled_result(String::new());
                }
                b[i].status = "error".into();
                b[i].summary = one_line_summary(&e);
                emit_tasks(app, run_id, &b);
                summaries[i] = format!("### Subtask {}: {} FAILED\n{}\n", i + 1, b[i].title, e);
                emit_text(app, run_id, format!("\n\n✗ **{}** — failed\n", b[i].title));
            }
        }
        drop(b);
    }

    if is_cancelled(run_id) {
        return cancelled_result(String::new());
    }

    // Merge round: the original conversation PLUS every subtask summary,
    // streamed to the user. It can still call tools (deferred run_command
    // approvals happen here through the normal gate).
    let merged_summary = summaries.join("\n");
    let merge_note = crate::chat::ChatTurn {
        role: "user".into(),
        text: format!(
            "Subtask results (already executed in parallel):\n\n{merged_summary}\nMerge these into the final answer for the original request; fix inconsistencies or run the deferred commands if needed."
        ),
    };
    let mut merge_turns = turns;
    merge_turns.push(crate::chat::ChatTurn {
        role: "agent".into(),
        text: "Subtasks executed in parallel; results collected.".into(),
    });
    merge_turns.push(merge_note);
    emit_text(app, run_id, "\n\n**Composing the final answer…**\n\n");
    // Continue step numbering AFTER the subtask steps — otherwise the merge
    // round's tool cards would overwrite subtask cards in the transcript.
    let next_index = {
        let s = step_index.lock().unwrap();
        *s + 1
    };
    run_protocol_from(app, run_id, req, system, root, merge_turns, next_index).await
}

fn one_line_summary(s: &str) -> String {
    let first = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if first.chars().count() > 140 {
        first.chars().take(140).collect::<String>() + "…"
    } else {
        first.to_string()
    }
}
