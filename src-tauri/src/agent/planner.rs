//! Task decomposition planning: one cheap model call splits the request into
//! independent subtasks; the task board events live here too.

use super::context::one_line;
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

/// Output budget of the planner call. Thinking models can burn the whole
/// budget on reasoning and return an EMPTY text block — with the old 2048 a
/// big prompt then parsed as "no plan" and silently degraded to single-step.
const PLAN_MAX_TOKENS: u64 = 4096;

/// Headroom for a thinking planner: the reasoning budget (4096) must fit
/// INSIDE max_tokens alongside the JSON answer, or the reply is truncated to
/// nothing and parses as "no plan".
const PLAN_THINKING_MAX_TOKENS: u64 = 8192;

/// The planner sees at most the head of a huge prompt: its answer is a small
/// JSON array, while a 100k-char spec risks a context error that surfaced as
/// an opaque "planner request failed".
const PLAN_PROMPT_CHARS: usize = 12_000;

fn clip_prompt(s: &str) -> String {
    if s.chars().count() <= PLAN_PROMPT_CHARS {
        return s.to_string();
    }
    let head: String = s.chars().take(PLAN_PROMPT_CHARS).collect();
    format!("{head}\n…[truncated]")
}

/// One request shape to try. Providers reject different fields — thinking
/// models 400 on `temperature: 0`, o-series 400 on `temperature` outright,
/// some gateways 400 on unknown `reasoning_effort` — so the planner tries a
/// conservative shape first and falls back instead of dying on the first
/// rejection ("planner request failed" used to be the whole explanation).
fn plan_variants(req: &AgentRequest, prompt: &str) -> Vec<Value> {
    if req.kind == "ollama" {
        // Ollama's /api/chat wants its OWN shape: no max_tokens at the top
        // level, options nested, and it answers with message.content — the
        // OpenAI-shaped body this function used to send could never parse.
        return vec![json!({
            "model": req.model,
            "stream": false,
            "options": { "temperature": 0.0, "num_predict": PLAN_MAX_TOKENS },
            "messages": [
                { "role": "system", "content": PLANNER_SYSTEM },
                { "role": "user", "content": prompt }
            ],
        })];
    }
    if req.kind == "anthropic-messages" {
        // A) The maximally compatible shape: NO temperature (a thinking model
        //    has it forced to 1, and sending 0 next to thinking is a hard 400)
        //    and no thinking field at all — models without thinking support
        //    (3.5/3.7-era) reject the parameter outright.
        // B) Models that REQUIRE thinking (a "think" variant) get their own
        //    budget plus room for the JSON answer after it.
        return vec![
            json!({
                "model": req.model,
                "max_tokens": PLAN_MAX_TOKENS,
                "system": PLANNER_SYSTEM,
                "messages": [{ "role": "user", "content": prompt }],
            }),
            json!({
                "model": req.model,
                "max_tokens": PLAN_THINKING_MAX_TOKENS,
                "system": PLANNER_SYSTEM,
                "thinking": { "type": "enabled", "budget_tokens": 4096 },
                "messages": [{ "role": "user", "content": prompt }],
            }),
        ];
    }
    // OpenAI-compatible: A) low reasoning effort, NO temperature (o-series and
    //    other reasoning models reject temperature entirely — this alone was
    //    "planner request failed" for thinking models); B) the bare minimum,
    //    for gateways that 400 on an unknown reasoning_effort field.
    vec![
        json!({
            "model": req.model,
            "max_tokens": PLAN_MAX_TOKENS,
            "reasoning_effort": "low",
            "messages": [
                { "role": "system", "content": PLANNER_SYSTEM },
                { "role": "user", "content": prompt }
            ],
        }),
        json!({
            "model": req.model,
            "max_tokens": PLAN_MAX_TOKENS,
            "messages": [
                { "role": "system", "content": PLANNER_SYSTEM },
                { "role": "user", "content": prompt }
            ],
        }),
    ]
}

/// Pulls the answer text out of a planner response, whichever protocol sent
/// it. An absent/empty content field yields "" — the caller must label that
/// as a FAILURE, never as "no decomposition needed".
fn plan_text(req: &AgentRequest, v: &Value) -> String {
    if req.kind == "anthropic-messages" {
        return v["content"]
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b["type"].as_str() == Some("text"))
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();
    }
    if req.kind == "ollama" {
        return v["message"]["content"].as_str().unwrap_or("").to_string();
    }
    v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string()
}

/// Closes the planner card. EVERY exit path must call this: an unfinished
/// card kept its spinner forever, and the UI read the live tail as "still
/// working" — the run looked frozen ("толи делает толи стоит на месте").
fn finish_plan_card(app: &AppHandle, run_id: &str, label: &str, res: &tools::ToolResult) {
    emit_step(app, run_id, PLAN_STEP_INDEX, "plan", label.to_string(), true, res);
}

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
    let prompt = clip_prompt(user_prompt);
    let variants = plan_variants(req, &prompt);

    // The planner call obeys the same provider limits as everything else.
    let key = if req.provider_id.is_empty() {
        req.base_url.clone()
    } else {
        req.provider_id.clone()
    };
    let _permit = crate::limiter::acquire(&key, req.rate_limit_rpm, req.concurrency, run_id).await;
    if is_cancelled(run_id) {
        return None;
    }
    // LIVE feedback while the provider thinks: a "plan" step card in the chat.
    emit_step(
        app,
        run_id,
        PLAN_STEP_INDEX,
        "plan",
        "Planning subtasks…".to_string(),
        false,
        &tools::ToolResult::ok(""),
    );

    let mut last_err = String::from("planner request failed");
    for (i, body) in variants.iter().enumerate() {
        let body_c = body.clone();
        let url_c = url.clone();
        let key_c = req.api_key.trim().to_string();
        let anthropic = req.kind == "anthropic-messages";
        let build = move || {
            let mut r = reqwest::Client::new()
                .post(&url_c)
                .header("Content-Type", "application/json")
                .json(&body_c);
            if anthropic {
                r = r.header("anthropic-version", "2023-06-01");
                if !key_c.is_empty() {
                    r = r.header("x-api-key", key_c.as_str());
                }
            } else if !key_c.is_empty() {
                r = r.bearer_auth(key_c.as_str());
            }
            r
        };

        // Stop interrupts the send immediately; transient 429/5xx retry.
        let res = match super::send_with_retry(app, run_id, build).await {
            Ok(r) => r,
            Err(e) if e.starts_with(crate::cancel::STOPPED) => {
                finish_plan_card(app, run_id, "Stopped", &tools::ToolResult::err(e));
                return None;
            }
            Err(e) => {
                last_err = e;
                continue;
            }
        };
        let status = res.status();
        if !status.is_success() {
            let detail = res.text().await.unwrap_or_default();
            last_err = format!("provider returned {status}: {}", one_line(&detail, 300));
            continue;
        }

        let v: Value = tokio::select! {
            r = res.json() => match r {
                Ok(v) => v,
                Err(e) => {
                    last_err = format!("unreadable planner response: {e}");
                    continue;
                }
            },
            _ = crate::cancel::cancel_signal(run_id) => {
                finish_plan_card(app, run_id, "Stopped", &tools::ToolResult::err(crate::cancel::STOPPED));
                return None;
            }
        };

        let text = plan_text(req, &v);
        // A thinking model that spent its whole budget on reasoning returns no
        // text at all. That is a FAILURE, not "no decomposition needed" — the
        // old code labelled it single-step and the user lost the task list.
        if text.trim().is_empty() {
            let _ = i;
            last_err = "the planner returned no text (reasoning-only response)".to_string();
            continue;
        }

        let parsed = parse_task_json(&text);
        // Honest labelling. A VALID array with 0–1 usable items means the model
        // judged this a single action — that is "no decomposition needed", NOT
        // an unreadable plan. Only truly unparsable output is a failure (red
        // card carrying the raw text).
        let array_len = plan_array_len(&text);
        let (label, result) = match &parsed {
            Some(items) => (
                format!(
                    "Plan ready: {} subtask{}",
                    items.len(),
                    if items.len() == 1 { "" } else { "s" }
                ),
                tools::ToolResult::ok(&text),
            ),
            None if matches!(array_len, Some(0) | Some(1)) => (
                "Single-step request — no decomposition needed".to_string(),
                tools::ToolResult::ok(&text),
            ),
            None => (
                "Could not read the plan — falling back to a single run".to_string(),
                tools::ToolResult::err(text.clone()),
            ),
        };
        finish_plan_card(app, run_id, &label, &result);
        return parsed;
    }

    // Every variant failed — say SO, with the provider's own words. The card
    // is closed, so the run visibly continues instead of looking frozen.
    finish_plan_card(
        app,
        run_id,
        "Planner failed — running without decomposition",
        &tools::ToolResult::err(last_err),
    );
    None
}

/// Is a prompt worth spending a planner call on? Short conversational text
/// ("Привет что там по серверу") is NEVER decomposition material — running the
/// planner on it burned ~10s and two LLM calls just to answer "no plan", and
/// the user watched pointless "Decomposing…" ceremony on a greeting.
/// Structured = long enough (240+ chars) OR multi-line (3+ lines) OR carries
/// explicit numbering markers.
pub(super) fn prompt_needs_planning(prompt: &str) -> bool {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.chars().count() >= 240 {
        return true;
    }
    if trimmed.lines().filter(|l| !l.trim().is_empty()).count() >= 3 {
        return true;
    }
    ["1.", "1)", "- [ ]", "шаг 1", "step 1"]
        .iter()
        .any(|m| trimmed.to_lowercase().contains(m))
}

/// Length of the outermost JSON array in the reply, when one parses at all.
/// Distinguishes "the model deliberately returned an empty/one-item plan"
/// from "the model returned something unparsable".
fn plan_array_len(text: &str) -> Option<usize> {
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Value>(&text[start..=end])
        .ok()?
        .as_array()
        .map(|a| a.len())
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
    fn single_item_array_is_single_step_not_failure() {
        let text = r#"[{"title":"Only one","prompt":"do it"}]"#;
        assert!(parse_task_json(text).is_none());
        assert_eq!(plan_array_len(text), Some(1));
        assert_eq!(plan_array_len("[]"), Some(0));
        assert_eq!(plan_array_len("{nope"), None);
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
    fn short_chat_is_not_planning_material() {
        assert!(!prompt_needs_planning("Привет что там по серверу"));
        assert!(!prompt_needs_planning("ok"));
        // Long-ish but still conversational single line: no structure, no plan.
        assert!(!prompt_needs_planning("проверь баги в файле src/main.rs и почини их быстро но аккуратно пожалуйста"));
    }

    #[test]
    fn long_or_structured_prompts_get_planned() {
        let long: String = "почини ".chars().cycle().take(400).collect();
        assert!(prompt_needs_planning(&long));
        assert!(prompt_needs_planning("1. сделай A\n2. сделай B"));
        assert!(prompt_needs_planning("step 1: read\nstep 2: fix"));
        assert!(!prompt_needs_planning("   "));
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
