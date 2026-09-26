//! Task decomposition planning: one cheap model call splits the request into
//! independent subtasks; the task board events live here too.

use super::{emit_step, is_cancelled, AgentRequest};
use crate::tools;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

/* ---------- Task decomposition (async/parallel subtasks) ---------- */

/// One subtask of a decomposed run, as shown in the UI task list.
#[derive(Debug, Clone, Serialize)]
pub struct TaskState {
    pub id: usize,
    pub title: String,
    /// pending | running | done | error
    pub status: String,
    /// Short result summary once finished.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentTasks {
    pub run_id: String,
    pub tasks: Vec<TaskState>,
}

pub(super) fn emit_tasks(app: &AppHandle, run_id: &str, tasks: &[TaskState]) {
    // Buffered for reload re-attach: the latest board wins on replay.
    if let Ok(v) = serde_json::to_value(tasks) {
        crate::runs::push_event(run_id, crate::runs::RunEvent::Tasks { tasks: v });
    }
    let _ = app.emit(
        "agent://tasks",
        AgentTasks {
            run_id: run_id.to_string(),
            tasks: tasks.to_vec(),
        },
    );
}

const PLANNER_SYSTEM: &str = "You decompose coding requests into subtasks. Reply with ONLY a JSON array (no prose, no code fences) of 2 to 5 objects: [{\"title\": \"short label\", \"prompt\": \"self-contained instruction for an agent\"}]. Subtasks must be independently executable IN PARALLEL (no ordering dependencies, no shared files); if the request is a single simple action, reply with [].";

/// Asks the model (cheap, no tools, non-streamed) to split the user's prompt
/// into independent subtasks. Returns None when the request is simple enough
/// that decomposition would only waste tokens — then the caller falls back to
/// the normal single loop.
/// Reserved step index for the planner card — far above any real step count
/// and exactly representable as a JS number (usize::MAX is not, so the UI
/// could not match start/done events).
const PLAN_STEP_INDEX: usize = 999_999;

pub(super) async fn plan_subtasks(
    app: &AppHandle,
    run_id: &str,
    req: &AgentRequest,
    user_prompt: &str,
) -> Option<Vec<(String, String)>> {
    let url = if req.kind == "ollama" {
        format!("{}/api/chat", req.base_url.trim_end_matches('/'))
    } else if req.kind == "anthropic-messages" {
        format!("{}/messages", req.base_url.trim_end_matches('/'))
    } else {
        format!("{}/chat/completions", req.base_url.trim_end_matches('/'))
    };

    // Keep the planner FAST and cheap: a small output budget, zero sampling
    // temperature and the LOWEST reasoning effort — its only job is a short
    // JSON array, and a big thinking budget is what made this stage crawl.
    // 2048, not 512: a 5-subtask plan with real prompts is ~800-1400 tokens,
    // and a TRUNCATED array parses as "no plan" — the run silently fell back
    // to single-step mode right in front of the user.
    let mut body = if req.kind == "anthropic-messages" {
        json!({
            "model": req.model,
            "max_tokens": 2048,
            "temperature": 0.0,
            "system": PLANNER_SYSTEM,
            "messages": [{ "role": "user", "content": user_prompt }],
        })
    } else {
        json!({
            "model": req.model,
            "max_tokens": 2048,
            "temperature": 0.0,
            "messages": [
                { "role": "system", "content": PLANNER_SYSTEM },
                { "role": "user", "content": user_prompt }
            ],
        })
    };
    // Reasoning models (o-series, DeepSeek-R1-style): plan on low effort.
    if req.kind != "anthropic-messages" && req.kind != "ollama" {
        body["reasoning_effort"] = json!("low");
    }

    let mut request = reqwest::Client::new()
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body);
    if req.kind == "anthropic-messages" {
        request = request.header("anthropic-version", "2023-06-01");
        if !req.api_key.trim().is_empty() {
            request = request.header("x-api-key", req.api_key.trim());
        }
    } else if !req.api_key.trim().is_empty() {
        request = request.bearer_auth(req.api_key.trim());
    }

    // The planner call obeys the same provider limits as everything else.
    let key = if req.provider_id.is_empty() { req.base_url.clone() } else { req.provider_id.clone() };
    let _permit = crate::limiter::acquire(&key, req.rate_limit_rpm, req.concurrency, run_id).await;
    if is_cancelled(run_id) {
        return None;
    }
    // LIVE feedback while the provider thinks: a "plan" step card in the chat.
    emit_step(app, run_id, PLAN_STEP_INDEX, "plan", "Planning subtasks…".to_string(), false, &tools::ToolResult::ok(""));
    // Stop interrupts the send/body-read IMMEDIATELY (select! on cancel_signal)
    // instead of waiting for the provider to finish.
    let res = tokio::select! {
        r = request.send() => r.ok()?,
        _ = crate::cancel::cancel_signal(run_id) => return None,
    };
    if !res.status().is_success() {
        emit_step(app, run_id, PLAN_STEP_INDEX, "plan", "Planning subtasks…".to_string(), true, &tools::ToolResult::err("planner request failed".to_string()));
        return None;
    }
    let v: Value = tokio::select! {
        r = res.json() => r.ok()?,
        _ = crate::cancel::cancel_signal(run_id) => return None,
    };
    let text = if req.kind == "anthropic-messages" {
        match v["content"].as_array() {
            Some(blocks) => blocks
                .iter()
                .filter(|b| b["type"].as_str() == Some("text"))
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join(""),
            None => return None,
        }
    } else {
        v["choices"][0]["message"]["content"].as_str()?.to_string()
    };

    let parsed = parse_task_json(&text);
    // Honest labelling: an explicit "[]" from the model = genuinely
    // single-step; anything else that failed to parse is a planning FAILURE
    // (red card with the raw text), not a silent downgrade — the user must
    // see why decomposition didn't happen.
    let (label, result) = match &parsed {
        Some(items) => (
            format!("Plan ready: {} subtask{}", items.len(), if items.len() == 1 { "" } else { "s" }),
            tools::ToolResult::ok(&text),
        ),
        None if text.contains("[]") || text.trim().is_empty() => (
            "Single-step request — no decomposition needed".to_string(),
            tools::ToolResult::ok(&text),
        ),
        None => (
            "Could not read the plan — falling back to a single run".to_string(),
            tools::ToolResult::err(text.clone()),
        ),
    };
    emit_step(app, run_id, PLAN_STEP_INDEX, "plan", label, true, &result);
    parsed
}

/// Lenient JSON-array extraction: models love wrapping arrays in prose or
/// code fences, so take the outermost [ ... ] span and parse that.
fn parse_task_json(text: &str) -> Option<Vec<(String, String)>> {
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    if end <= start {
        return None;
    }
    let arr: Value = serde_json::from_str(&text[start..=end]).ok()?;
    let items = arr.as_array()?;
    let mut out = Vec::new();
    for it in items {
        let title = it["title"].as_str().unwrap_or("").trim().to_string();
        let prompt = it["prompt"].as_str().unwrap_or("").trim().to_string();
        if !title.is_empty() && !prompt.is_empty() {
            out.push((title, prompt));
        }
    }
    // Fewer than 2 subtasks = nothing to parallelize.
    if out.len() < 2 {
        None
    } else {
        Some(out)
    }
}

/* ---------- Tests ---------- */

#[cfg(test)]
mod decompose_tests {
    use super::*;

    #[test]
    fn parses_clean_array() {
        let text = r#"[{"title":"Fix bug","prompt":"Fix the null check"},{"title":"Add test","prompt":"Write a unit test"}]"#;
        let out = parse_task_json(text).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].0, "Fix bug");
        assert!(out[1].1.contains("unit test"));
    }

    #[test]
    fn parses_array_wrapped_in_prose_and_fences() {
        let text = "Here is the plan:\n\n```json\n[{\"title\":\"A\",\"prompt\":\"do a\"},{\"title\":\"B\",\"prompt\":\"do b\"}]\n```\nHope that helps!";
        let out = parse_task_json(text).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].0, "A");
    }

    #[test]
    fn single_task_is_not_decomposable() {
        let text = r#"[{"title":"One thing","prompt":"do it"}]"#;
        assert!(parse_task_json(text).is_none());
    }

    #[test]
    fn empty_array_is_not_decomposable() {
        assert!(parse_task_json("[]").is_none());
        assert!(parse_task_json("no json here").is_none());
    }

    #[test]
    fn incomplete_items_are_dropped() {
        // Two valid + two broken: only the valid pair survives.
        let text = r#"[{"title":"","prompt":"x"},{"title":"Good","prompt":"do"},{"title":"T","prompt":""},{"title":"Also good","prompt":"do2"}]"#;
        let out = parse_task_json(text).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].0, "Good");
        assert_eq!(out[1].0, "Also good");
    }

    #[test]
    fn single_valid_item_is_not_a_plan() {
        // One valid subtask = nothing to parallelize, even among junk items.
        let text = r#"[{"title":"","prompt":"x"},{"title":"Only","prompt":"do"}]"#;
        assert!(parse_task_json(text).is_none());
    }
}
