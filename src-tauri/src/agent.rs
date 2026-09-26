/// Agent loop — lets the model actually do work, not just talk.
///
/// The loop is provider-agnostic on the outside and protocol-specific on the
/// inside: each round asks the model for the next step, and if it requests
/// tools, they run here and their output is fed back as the next turn. Text the
/// model emits along the way is streamed to the UI immediately, so a long task
/// shows progress instead of going silent until it finishes.
///
/// Two wire protocols are supported because they cover every provider the app
/// can talk to: OpenAI-style `tool_calls` (OpenAI, DeepSeek, vLLM, LM Studio…)
/// and Anthropic's `tool_use` content blocks.
use crate::tools;
use futures_util::StreamExt;
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
    if let Some(map) = pending().lock().unwrap().as_mut() {
        if let Some(tx) = map.remove(run_id) {
            let _ = tx.send(approve);
        }
    }
}

/// Asks the UI to approve a command and waits for the answer. Returns as soon
/// as the user decides — or as soon as the run is stopped, so a Stop pressed
/// while the Allow/Deny banner is up does not hang the loop.
async fn ask_confirm(app: &AppHandle, run_id: &str, command: &str, cwd: &str) -> bool {
    let (tx, rx) = oneshot::channel();
    {
        let mut guard = pending().lock().unwrap();
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(run_id.to_string(), tx);
    }
    let _ = app.emit(
        "agent://confirm",
        json!({ "run_id": run_id, "command": command, "cwd": cwd }),
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

/// Upper bound on model→tool→model rounds, so a confused model cannot spin.
const MAX_STEPS: usize = 64;

/* ---------- Events ---------- */

#[derive(Debug, Clone, Serialize)]
pub struct AgentText {
    pub run_id: String,
    pub delta: String,
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

/* ---------- Tool schema exposed to the model ---------- */

/// Tool definitions in a neutral shape, converted per protocol when sent.
/// The ssh_exec tool is appended only when the project has saved SSH units,
/// so the model never sees a tool it cannot use.
fn tool_specs(req: &AgentRequest) -> Value {
    let mut specs = json!([
        {
            "name": "read_file",
            "description": "Read a text file. Returns the contents with line numbers. Use start_line/end_line for large files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path — absolute or relative to the workspace." },
                    "start_line": { "type": "integer", "description": "First line to return (1-based)." },
                    "end_line": { "type": "integer", "description": "Last line to return." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "apply_patch",
            "description": "THE ONLY way to change files (diff-only mode). The diff is one or more SEARCH/REPLACE blocks: <<<<<<< SEARCH / exact existing code / ======= / new code / >>>>>>> REPLACE. To create a new file send ONE block with an EMPTY SEARCH side. Every SEARCH side must match the file exactly once — read the file first and copy the text verbatim.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File path — absolute or relative to the workspace." },
                    "diff": { "type": "string", "description": "SEARCH/REPLACE blocks exactly as specified." }
                },
                "required": ["path", "diff"]
            }
        },
        {
            "name": "list_dir",
            "description": "List the entries of a directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory path — absolute or relative, or \"\" for the workspace root." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "grep",
            "description": "Search for a literal string across files. Returns matching lines with file paths and line numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Text to find." },
                    "path": { "type": "string", "description": "Optional directory to search in — absolute or relative." }
                },
                "required": ["pattern"]
            }
        },
        {
            "name": "run_command",
            "description": "Run a shell command and return its combined output and exit code. Use for builds, tests and git. On Windows this runs through cmd, elsewhere through sh.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Command line to execute." },
                    "cwd": { "type": "string", "description": "Optional working directory as an absolute path. Defaults to the workspace." },
                    "timeout_secs": { "type": "integer", "description": "Optional timeout, default 120." }
                },
                "required": ["command"]
            }
        }
    ]);
    if !req.ssh_units.is_empty() {
        let names: Vec<String> = req.ssh_units.iter().map(|u| u.name.clone()).collect();
        let hint = req
            .ssh_units
            .iter()
            .map(|u| format!("{} = {}", u.name, u.host))
            .collect::<Vec<_>>()
            .join(", ");
        specs.as_array_mut().unwrap().push(json!({
            "name": "ssh_exec",
            "description": format!(
                "Run a command on a remote server over SSH and return its output. \
                 Available units (server → host): {hint}. Connections are pooled \
                 and authenticated automatically from saved credentials."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "server": {
                        "type": "string",
                        "enum": names,
                        "description": "Which saved SSH unit to run on."
                    },
                    "command": { "type": "string", "description": "Command line to execute on the remote server." }
                },
                "required": ["server", "command"]
            }
        }));
    }
    specs
}

/// Default system prompt — tells the model it can act, not just answer.
fn default_system() -> String {
    "You are Singularity, a coding agent inside a desktop app running on the user's own \
     computer.\n\
     You have NATIVE system tools that act on the real filesystem — never ask the user to \
     run anything yourself, never output code for the user to paste: list_dir(path), \
     read_file(path, start_line, end_line), grep(pattern, path), run_command(command, cwd), \
     apply_patch(path, diff) and ssh_exec(server, command).\n\
     You can work anywhere on this machine. Pass absolute paths (for example \
     C:\\Users\\name\\Documents\\GitHub\\proj\\src\\main.rs); the workspace root is only the \
     default for relative paths.\n\
     \n\
     DIFF-ONLY RULE — you NEVER output or send a whole file. Every file change goes through \
     apply_patch with SEARCH/REPLACE blocks in EXACTLY this format:\n\
     <<<<<<< SEARCH\n\
     <exact existing code to replace>\n\
     =======\n\
     <new code>\n\
     >>>>>>> REPLACE\n\
     The SEARCH side must be copied verbatim from a fresh read_file (whitespace matters) and \
     match exactly once. To create a new file, send ONE block with an EMPTY SEARCH side. \
     Do not paste code blocks into your reply — prose + apply_patch calls only. Keep each \
     patch minimal: only the lines that change, plus just enough context to be unique.\n\
     \n\
     Work step by step: list_dir/grep/read_file the real files before changing them, then \
     apply_patch, then run_command to build or test when that helps. When an ssh_exec tool is \
     offered, remote servers are saved units — pick the right one by name.\n\
     Prefer doing the work over describing it. When you are done, give a short summary of \
     what changed."
        .to_string()
}

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

fn emit_tasks(app: &AppHandle, run_id: &str, tasks: &[TaskState]) {
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
async fn plan_subtasks(
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

    let body = if req.kind == "anthropic-messages" {
        json!({
            "model": req.model,
            "max_tokens": 1024,
            "system": PLANNER_SYSTEM,
            "messages": [{ "role": "user", "content": user_prompt }],
        })
    } else {
        json!({
            "model": req.model,
            "messages": [
                { "role": "system", "content": PLANNER_SYSTEM },
                { "role": "user", "content": user_prompt }
            ],
        })
    };

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
    let _permit = crate::limiter::acquire(&key, req.rate_limit_rpm, req.concurrency, "planner").await;
    let res = request.send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let v: Value = res.json().await.ok()?;
    let text = if req.kind == "anthropic-messages" {
        v["content"]
            .as_array()?
            .iter()
            .filter(|b| b["type"].as_str() == Some("text"))
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("")
    } else {
        v["choices"][0]["message"]["content"].as_str()?.to_string()
    };

    parse_task_json(&text)
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
        let res = request.send().await.map_err(|e| format!("subtask request failed: {e}"))?;
        if !res.status().is_success() {
            let detail = res.text().await.unwrap_or_default();
            return Err(format!("subtask provider error: {}", trim_detail(&detail)));
        }
        let v: Value = res.json().await.map_err(|e| format!("bad subtask response: {e}"))?;

        if anthropic {
            let blocks = v["content"].as_array().cloned().unwrap_or_default();
            let text: String = blocks.iter()
                .filter(|b| b["type"].as_str() == Some("text"))
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>().join("");
            let uses: Vec<Value> = blocks.iter()
                .filter(|b| b["type"].as_str() == Some("tool_use"))
                .cloned().collect();
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
    Err("subtask exceeded the step limit".to_string())
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
async fn run_decomposed(
    app: &AppHandle,
    run_id: &str,
    req: &AgentRequest,
    system: &str,
    root: &Path,
    turns: Vec<super::chat::ChatTurn>,
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
    let plan = match plan_subtasks(req, &user_prompt).await {
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

    let mut tasks: Vec<TaskState> = plan
        .iter()
        .enumerate()
        .map(|(i, (title, _))| TaskState {
            id: i + 1,
            title: title.clone(),
            status: "pending".into(),
            summary: String::new(),
        })
        .collect();
    emit_tasks(app, run_id, &tasks);

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
        handles.push(tokio::spawn(async move {
            let permit = sem_c.acquire().await.map_err(|e| e.to_string())?;
            let out = run_subtask(&app_c, &req_c, &root_c, &run_c, &idx_c, &title_c, &prompt_c).await;
            drop(permit);
            Ok::<(usize, Result<String, String>), String>((i, out))
        }));
        // Mark running as tasks are spawned (bounded by the semaphore).
        tasks[i].status = "running".into();
    }
    emit_tasks(app, run_id, &tasks);

    let mut summaries: Vec<String> = vec![String::new(); plan.len()];
    for h in handles {
        let (i, out) = match h.await {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => return Err(e),
            Err(e) => return Err(format!("subtask panicked: {e}")),
        };
        match out {
            Ok(s) => {
                tasks[i].status = "done".into();
                tasks[i].summary = one_line_summary(&s);
                summaries[i] = format!("### Subtask {}: {}\n{}\n", i + 1, tasks[i].title, s);
            }
            Err(e) => {
                if e.starts_with(crate::cancel::STOPPED) {
                    return cancelled_result(String::new());
                }
                tasks[i].status = "error".into();
                tasks[i].summary = one_line_summary(&e);
                summaries[i] = format!("### Subtask {}: {} FAILED\n{}\n", i + 1, tasks[i].title, e);
            }
        }
        emit_tasks(app, run_id, &tasks);
    }

    if is_cancelled(run_id) {
        return cancelled_result(String::new());
    }

    // Merge round: the original conversation PLUS every subtask summary,
    // streamed to the user. It can still call tools (deferred run_command
    // approvals happen here through the normal gate).
    let merged_summary = summaries.join("\n");
    let merge_note = super::chat::ChatTurn {
        role: "user".into(),
        text: format!(
            "Subtask results (already executed in parallel):\n\n{merged_summary}\nMerge these into the final answer for the original request; fix inconsistencies or run the deferred commands if needed."
        ),
    };
    let mut merge_turns = turns;
    merge_turns.push(super::chat::ChatTurn {
        role: "agent".into(),
        text: "Subtasks executed in parallel; results collected.".into(),
    });
    merge_turns.push(merge_note);
    run_protocol(app, run_id, req, system, root, merge_turns).await
}

fn one_line_summary(s: &str) -> String {
    let first = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if first.chars().count() > 140 {
        first.chars().take(140).collect::<String>() + "…"
    } else {
        first.to_string()
    }
}

/// Dispatches to the provider's protocol loop (used by both the plain and
/// decomposed paths).
async fn run_protocol(
    app: &AppHandle,
    run_id: &str,
    req: &AgentRequest,
    system: &str,
    root: &Path,
    turns: Vec<super::chat::ChatTurn>,
) -> Result<String, String> {
    match req.kind.as_str() {
        "anthropic-messages" => run_anthropic(app, run_id, req, system, root, turns).await,
        _ => run_openai(app, run_id, req, system, root, turns).await,
    }
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
    /// Stable provider id — the key the limiter budgets requests under.
    #[serde(default)]
    pub provider_id: String,
    /// Max requests/minute for this provider (0 = unlimited).
    #[serde(default)]
    pub rate_limit_rpm: usize,
    /// Max parallel in-flight requests (0 = unlimited).
    #[serde(default)]
    pub concurrency: usize,
    /// Decompose the user's prompt into parallel subtasks (Task list) before
    /// executing. Off by default; the prompt box toggles it per message.
    #[serde(default)]
    pub decompose: bool,
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

/// Runs the agent loop, streaming text and reporting each tool call.
pub async fn run_agent(
    app: AppHandle,
    run_id: String,
    req: AgentRequest,
    turns: Vec<super::chat::ChatTurn>,
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
        default_system()
    } else {
        req.system.clone()
    };

    // A stale stop request must never kill a fresh run that reuses the id.
    crate::cancel::clear(&run_id);

    // Decomposition (opt-in per message): plan → parallel subtasks → merge.
    // Falls back to the plain single loop when the prompt is too simple.
    let result = if req.decompose {
        run_decomposed(&app, &run_id, &req, &system, &root, turns).await
    } else {
        run_protocol(&app, &run_id, &req, &system, &root, turns).await
    };

    crate::cancel::clear(&run_id);

    match result {
        Ok(answer) => {
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
    let _ = app.emit(
        "agent://text",
        AgentText {
            run_id: run_id.to_string(),
            delta: delta.into(),
        },
    );
}

fn emit_think(app: &AppHandle, run_id: &str, delta: impl Into<String>) {
    let _ = app.emit(
        "agent://think",
        AgentThink {
            run_id: run_id.to_string(),
            delta: delta.into(),
        },
    );
}

/// Emits a step. `done=false` marks "this tool just started" so the UI shows the
/// card immediately; `done=true` carries the result.
fn emit_step(app: &AppHandle, run_id: &str, index: usize, name: &str, input: String, done: bool, res: &tools::ToolResult) {
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
        },
    );
}

/// Short, human-readable rendering of a tool's arguments for the UI.
fn summarize(name: &str, args: &Value) -> String {
    let get = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("");
    match name {
        "run_command" => get("command").to_string(),
        "read_file" => {
            let s = get("start_line");
            let e = get("end_line");
            if s.is_empty() && e.is_empty() {
                get("path").to_string()
            } else {
                format!("{} ({}–{})", get("path"), s, e)
            }
        }
        "grep" => format!("\"{}\" in {}", get("pattern"), if get("path").is_empty() { "." } else { get("path") }),
        "write_file" => format!("{} ({} bytes)", get("path"), get("content").len()),
        "apply_patch" => {
            let hunks = tools::parse_patch(get("diff")).len();
            format!("{} ({} hunks)", get("path"), hunks)
        }
        _ => get("path").to_string(),
    }
}

/* ---------- Context pruning ----------
   Every round re-checks the outgoing context and shrinks OLD material so the
   request stays small (~2–3k tokens ⇒ fast TTFT):
   * the last KEEP_RECENT messages survive untouched — they carry the current
     task state and the code actually being worked on;
   * older tool outputs and long texts collapse into one-line markers;
   * if that is not enough, the oldest assistant→tool-result PAIRS are dropped
     together (never split — both protocols require them paired);
   * system prompt and image parts are never touched. */

/// Budget in ESTIMATED tokens (~4 chars/token) for the whole message list.
const CONTEXT_BUDGET_TOKENS: usize = 2800;
/// Most recent messages survive as the "current task state" — but even they
/// get tail-clipped when oversized (KEEP_TOOL_CHARS / KEEP_TEXT_CHARS below),
/// so one giant tool output can never blow the budget by itself.
const KEEP_RECENT: usize = 6;
/// Old tool output above this length collapses to a one-line marker.
const PRUNE_TOOL_CHARS: usize = 120;
/// Old assistant text above this length gets truncated.
const PRUNE_TEXT_CHARS: usize = 240;
/// RECENT tool output is clipped to this many chars, keeping the TAIL — that
/// is where build errors and the ~20 lines of code being worked on live.
const KEEP_TOOL_CHARS: usize = 1600;
/// Recent assistant prose clip — the task state stays, novels do not.
const KEEP_TEXT_CHARS: usize = 400;

/// Keeps only the LAST keep_chars characters (prefixed by an elision mark).
fn clip_head(s: &str, keep_chars: usize) -> String {
    let n = s.chars().count();
    if n <= keep_chars {
        return s.to_string();
    }
    let tail: String = s.chars().skip(n - keep_chars).collect();
    format!("[head pruned] {tail}")
}

fn est_tokens(msgs: &[Value]) -> usize {
    // Rough but stable: serialized JSON chars / 4.
    msgs.iter().map(|m| serde_json::to_string(m).map(|s| s.len() / 4).unwrap_or(0)).sum()
}

fn one_line(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c == '\n' { ' ' } else { c }).collect();
    let flat = flat.trim();
    if flat.chars().count() <= max {
        flat.to_string()
    } else {
        flat.chars().take(max).collect::<String>() + "…[pruned]"
    }
}

/// Shrinks one OpenAI-shaped message in place (stage 1). Returns true when it
/// actually shrank something.
fn shrink_openai_msg(m: &mut Value) -> bool {
    let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("");
    match role {
        "tool" => {
            if let Some(s) = m.get("content").and_then(|v| v.as_str()).map(str::to_string) {
                if s.len() > PRUNE_TOOL_CHARS {
                    m["content"] = json!(format!("[pruned] {}", one_line(&s, 80)));
                    return true;
                }
            }
            false
        }
        "assistant" => {
            let mut changed = false;
            // Text content collapses when tool_calls ride along (the call
            // names/args are the informative part).
            if m.get("tool_calls").is_some() {
                if m.get("content").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false) {
                    m["content"] = Value::Null;
                    changed = true;
                }
            } else if let Some(s) = m.get("content").and_then(|v| v.as_str()).map(str::to_string) {
                if s.len() > PRUNE_TEXT_CHARS {
                    m["content"] = json!(one_line(&s, PRUNE_TEXT_CHARS));
                    changed = true;
                }
            }
            changed
        }
        "user" => {
            // Only plain-string users; image-part arrays stay untouched.
            if let Some(s) = m.get("content").and_then(|v| v.as_str()).map(str::to_string) {
                if s.len() > PRUNE_TEXT_CHARS * 2 {
                    m["content"] = json!(one_line(&s, PRUNE_TEXT_CHARS * 2));
                    return true;
                }
            }
            false
        }
        _ => false,
    }
}

/// Tail-clips one RECENT OpenAI-shaped message (stage 1.5). Recent messages
/// keep their END: that is where the current error / code being worked on
/// lives. Plain user turns and images are never touched.
fn clip_recent_openai_msg(m: &mut Value) {
    let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("");
    match role {
        "tool" => {
            if let Some(s) = m.get("content").and_then(|v| v.as_str()).map(str::to_string) {
                if s.len() > KEEP_TOOL_CHARS {
                    m["content"] = json!(clip_head(&s, KEEP_TOOL_CHARS));
                }
            }
        }
        "assistant" => {
            if let Some(s) = m.get("content").and_then(|v| v.as_str()).map(str::to_string) {
                if s.len() > KEEP_TEXT_CHARS {
                    m["content"] = json!(clip_head(&s, KEEP_TEXT_CHARS));
                }
            }
        }
        _ => {}
    }
}

/// Tail-clips one RECENT Anthropic-shaped message (stage 1.5).
fn clip_recent_anthropic_msg(m: &mut Value) {
    let Some(parts) = m.get("content").and_then(|v| v.as_array()).cloned() else {
        return;
    };
    let mut changed = false;
    let mut next: Vec<Value> = Vec::new();
    for pt in parts {
        match pt.get("type").and_then(|v| v.as_str()) {
            Some("tool_result") => {
                let mut q = pt.clone();
                if let Some(s) = q.get("content").and_then(|v| v.as_str()).map(str::to_string) {
                    if s.len() > KEEP_TOOL_CHARS {
                        q["content"] = json!(clip_head(&s, KEEP_TOOL_CHARS));
                        changed = true;
                    }
                }
                next.push(q);
            }
            Some("text") => {
                let mut q = pt.clone();
                if let Some(s) = q.get("text").and_then(|v| v.as_str()).map(str::to_string) {
                    if s.len() > KEEP_TEXT_CHARS {
                        q["text"] = json!(clip_head(&s, KEEP_TEXT_CHARS));
                        changed = true;
                    }
                }
                next.push(q);
            }
            _ => next.push(pt),
        }
    }
    if changed {
        m["content"] = Value::Array(next);
    }
}
/// Prunes the OpenAI-shaped history in place. messages[0] (system) is never
/// touched. Returns the estimated token count AFTER pruning.
fn prune_openai(messages: &mut Vec<Value>) -> usize {
    if messages.len() < 3 {
        return est_tokens(messages);
    }
    let keep_from = messages.len().saturating_sub(KEEP_RECENT).max(1);

    // Stage 1 — collapse OLD tool outputs and long texts in place.
    for m in messages[1..keep_from].iter_mut() {
        shrink_openai_msg(m);
    }
    // Stage 1.5 — even RECENT messages get tail-clipped when oversized: the
    // current task state is their END (build errors, the code being edited),
    // and one 200KB tool dump must not blow the whole budget.
    for m in messages[keep_from..].iter_mut() {
        clip_recent_openai_msg(m);
    }
    if est_tokens(messages) <= CONTEXT_BUDGET_TOKENS {
        return est_tokens(messages);
    }

    // Stage 2 — drop the oldest assistant(tool_calls)→tool-result PAIRS until
    // under budget. Pairs are dropped together: an orphan tool message or a
    // tool_calls message without results is rejected by strict APIs.
    while est_tokens(messages) > CONTEXT_BUDGET_TOKENS {
        // Recomputed every iteration: each drain shifts the recent window left.
        let keep_from = messages.len().saturating_sub(KEEP_RECENT).max(1);
        // Find the first assistant-with-tool_calls at index >= 1 whose whole
        // run of following tool messages is still older than keep_from.
        let mut victim: Option<(usize, usize)> = None; // (start, end_exclusive)
        let mut i = 1usize;
        while i < messages.len() {
            let is_assistant_calls = messages[i].get("role").and_then(|v| v.as_str()) == Some("assistant")
                && messages[i].get("tool_calls").is_some();
            if is_assistant_calls {
                let mut j = i + 1;
                while j < messages.len()
                    && messages[j].get("role").and_then(|v| v.as_str()) == Some("tool")
                {
                    j += 1;
                }
                if j <= keep_from {
                    victim = Some((i, j));
                    break;
                }
                i = j.max(i + 1);
            } else {
                i += 1;
            }
        }
        let Some((start, end)) = victim else { break };
        messages.drain(start..end);
    }
    est_tokens(messages)
}

/// Shrinks one Anthropic-shaped message in place (stage 1).
fn shrink_anthropic_msg(m: &mut Value) -> bool {
    let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("");
    let Some(parts) = m.get("content").and_then(|v| v.as_array()).cloned() else {
        // String content (plain turns) — collapse long assistant text.
        if role == "assistant" {
            if let Some(s) = m.get("content").and_then(|v| v.as_str()).map(str::to_string) {
                if s.len() > PRUNE_TEXT_CHARS {
                    m["content"] = json!(one_line(&s, PRUNE_TEXT_CHARS));
                    return true;
                }
            }
        }
        return false;
    };
    let mut changed = false;
    let mut next: Vec<Value> = Vec::new();
    for pt in parts {
        match pt.get("type").and_then(|v| v.as_str()) {
            Some("tool_result") => {
                let mut q = pt.clone();
                if let Some(s) = q.get("content").and_then(|v| v.as_str()).map(str::to_string) {
                    if s.len() > PRUNE_TOOL_CHARS {
                        q["content"] = json!(format!("[pruned] {}", one_line(&s, 80)));
                        changed = true;
                    }
                }
                next.push(q);
            }
            Some("text") if role == "assistant" => {
                let mut q = pt.clone();
                if let Some(s) = q.get("text").and_then(|v| v.as_str()).map(str::to_string) {
                    if s.len() > PRUNE_TEXT_CHARS {
                        q["text"] = json!(one_line(&s, PRUNE_TEXT_CHARS));
                        changed = true;
                    }
                }
                next.push(q);
            }
            _ => next.push(pt),
        }
    }
    if changed {
        m["content"] = Value::Array(next);
    }
    changed
}

/// Prunes the Anthropic-shaped history in place. Same policy as OpenAI, but
/// the pairing is assistant(tool_use) followed by user(tool_result blocks).
fn prune_anthropic(messages: &mut Vec<Value>) -> usize {
    if messages.len() < 3 {
        return est_tokens(messages);
    }
    let keep_from = messages.len().saturating_sub(KEEP_RECENT).max(1);

    for m in messages[..keep_from].iter_mut() {
        shrink_anthropic_msg(m);
    }
    // Stage 1.5 — tail-clip oversized RECENT messages (same policy as OpenAI).
    for m in messages[keep_from..].iter_mut() {
        clip_recent_anthropic_msg(m);
    }
    if est_tokens(messages) <= CONTEXT_BUDGET_TOKENS {
        return est_tokens(messages);
    }

    // Drop the oldest assistant(tool_use) → user(tool_result) pair while over
    // budget. tool_use/tool_result must stay paired or the API rejects the
    // request.
    while est_tokens(messages) > CONTEXT_BUDGET_TOKENS {
        // Recomputed every iteration: each drain shifts the recent window left.
        let keep_from = messages.len().saturating_sub(KEEP_RECENT).max(1);
        let mut found = false;
        let mut i = 0usize;
        while i + 1 < messages.len() {
            let a_calls = messages[i].get("role").and_then(|v| v.as_str()) == Some("assistant")
                && messages[i]
                    .get("content")
                    .and_then(|v| v.as_array())
                    .map(|ps| ps.iter().any(|q| q.get("type").and_then(|v| v.as_str()) == Some("tool_use")))
                    .unwrap_or(false);
            let u_result = messages[i + 1].get("role").and_then(|v| v.as_str()) == Some("user")
                && messages[i + 1]
                    .get("content")
                    .and_then(|v| v.as_array())
                    .map(|ps| ps.iter().any(|q| q.get("type").and_then(|v| v.as_str()) == Some("tool_result")))
                    .unwrap_or(false);
            if a_calls && u_result && i + 2 <= keep_from {
                messages.drain(i..i + 2);
                found = true;
                break;
            }
            i += 1;
        }
        if !found {
            break;
        }
    }
    est_tokens(messages)
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

/* ---------- OpenAI tool_calls protocol ---------- */

#[derive(Deserialize)]
struct ToolCallDelta {
    index: Option<usize>,
    id: Option<String>,
    function: Option<FunctionDelta>,
}

#[derive(Deserialize)]
struct FunctionDelta {
    name: Option<String>,
    arguments: Option<String>,
}

#[derive(Deserialize)]
struct StreamChoice {
    delta: Option<StreamDelta>,
    #[serde(rename = "finish_reason")]
    _finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct StreamDelta {
    content: Option<String>,
    /// DeepSeek and OpenAI o-series stream reasoning separately from content.
    reasoning_content: Option<String>,
    reasoning: Option<String>,
    tool_calls: Option<Vec<ToolCallDelta>>,
}

#[derive(Deserialize)]
struct StreamChunk {
    choices: Option<Vec<StreamChoice>>,
    error: Option<ApiError>,
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


/// Aggregated usage of one run — what the Debug HUD displays.
#[derive(Debug, Clone, Serialize)]
pub struct RunUsage {
    pub run_id: String,
    /// Sum of prompt tokens over all rounds of this run.
    pub prompt_tokens: u64,
    /// Sum of completion tokens over all rounds.
    pub completion_tokens: u64,
    /// Prompt tokens served from cache (Anthropic cache_read / OpenAI cached).
    pub cached_tokens: u64,
    /// Wall time of the run so far, ms — the frontend derives tokens/sec.
    pub elapsed_ms: u64,
}

#[derive(Deserialize)]
struct ApiError {
    message: Option<String>,
}

/// One accumulated tool call. Arguments arrive split across chunks.
#[derive(Default, Clone)]
struct PendingCall {
    id: String,
    name: String,
    args: String,
}

async fn run_openai(
    app: &AppHandle,
    run_id: &str,
    req: &AgentRequest,
    system: &str,
    root: &Path,
    turns: Vec<super::chat::ChatTurn>,
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
    let mut step_index = 0usize;
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

    for _ in 0..MAX_STEPS {
        if is_cancelled(run_id) {
            return cancelled_result(final_text);
        }
        // Context pruning runs before EVERY request: old tool outputs collapse,
        // oldest tool-call pairs drop, so the wire context stays ~2–3k tokens.
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

        let mut request = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body);
        if !req.api_key.trim().is_empty() {
            request = request.bearer_auth(req.api_key.trim());
        }

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

        let res = request.send().await.map_err(|e| format!("request failed: {e}"))?;
        let status = res.status();
        if !status.is_success() {
            let detail = res.text().await.unwrap_or_default();
            return Err(format!("provider returned {status}: {detail}"));
        }

        // Parse the stream, collecting text and any tool calls.
        let mut stream = res.bytes_stream();
        let mut buf = String::new();
        let mut calls: Vec<PendingCall> = Vec::new();
        let mut round_text = String::new();

        while let Some(chunk) = stream.next().await {
            if is_cancelled(run_id) {
                drop(stream);
                return cancelled_result(final_text.clone() + &round_text);
            }
            let bytes = chunk.map_err(|e| format!("stream error: {e}"))?;
            buf.push_str(&String::from_utf8_lossy(&bytes));

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

            messages.push(json!({
                "role": "tool",
                "tool_call_id": call.id,
                "content": result.output,
            }));
        }
    }

    Err(format!("stopped after {MAX_STEPS} steps without finishing"))
}

/* ---------- Tests ---------- */

#[cfg(test)]
mod prune_tests {
    use super::*;

    fn big(n: usize) -> String {
        "x".repeat(n)
    }

    #[test]
    fn openai_collapses_old_tool_outputs_keeps_recent() {
        let mut messages = vec![json!({ "role": "system", "content": "sys" })];
        // 12 old tool rounds with huge outputs
        for i in 0..12 {
            messages.push(json!({
                "role": "assistant", "content": big(2000),
                "tool_calls": [{ "id": format!("c{i}"), "type": "function", "function": { "name": "read_file", "arguments": "{}" } }]
            }));
            messages.push(json!({ "role": "tool", "tool_call_id": format!("c{i}"), "content": big(8000) }));
        }
        let before = est_tokens(&messages);
        let after = prune_openai(&mut messages);
        assert!(after < before, "pruning must shrink: {before} -> {after}");
        assert!(after <= CONTEXT_BUDGET_TOKENS + 2000, "budget-ish: {after}");
        // System survives untouched
        assert_eq!(messages[0]["content"], "sys");
        // Last KEEP_RECENT messages keep their full content
        let tail = &messages[messages.len() - KEEP_RECENT..];
        assert!(tail.iter().any(|m| m.get("content").and_then(|v| v.as_str()).map(|s| s.len() > 1000).unwrap_or(false)));
        // No orphan tool messages: every tool msg follows an assistant with tool_calls
        for (i, m) in messages.iter().enumerate().skip(1) {
            if m.get("role").and_then(|v| v.as_str()) == Some("tool") {
                let prev = &messages[i - 1];
                assert!(prev.get("role").and_then(|v| v.as_str()) == Some("assistant") || prev.get("role").and_then(|v| v.as_str()) == Some("tool"));
            }
        }
    }

    #[test]
    fn anthropic_drops_paired_blocks_only() {
        let mut messages: Vec<Value> = Vec::new();
        for i in 0..10 {
            messages.push(json!({
                "role": "assistant",
                "content": [{ "type": "tool_use", "id": format!("t{i}"), "name": "read_file", "input": {} },
                            { "type": "text", "text": big(3000) }]
            }));
            messages.push(json!({
                "role": "user",
                "content": [{ "type": "tool_result", "tool_use_id": format!("t{i}"), "content": big(8000) }]
            }));
        }
        let before = est_tokens(&messages);
        let after = prune_anthropic(&mut messages);
        assert!(after < before);
        // Pairing invariant: every tool_use id still has its tool_result
        let uses: Vec<String> = messages.iter().filter_map(|m|
            m.get("content").and_then(|v| v.as_array()).and_then(|ps|
                ps.iter().find(|q| q.get("type").and_then(|v| v.as_str()) == Some("tool_use"))
            ).and_then(|q| q.get("id").and_then(|v| v.as_str()).map(str::to_string))
        ).collect();
        let results: Vec<String> = messages.iter().filter_map(|m|
            m.get("content").and_then(|v| v.as_array()).and_then(|ps|
                ps.iter().find(|q| q.get("type").and_then(|v| v.as_str()) == Some("tool_result"))
            ).and_then(|q| q.get("tool_use_id").and_then(|v| v.as_str()).map(str::to_string))
        ).collect();
        assert_eq!(uses, results, "tool_use and tool_result must stay paired");
    }

    #[test]
    fn short_history_is_untouched() {
        let mut messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "hi" }),
        ];
        prune_openai(&mut messages);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["content"], "hi");
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

/* ---------- Anthropic tool_use protocol ---------- */

#[derive(Deserialize)]
struct AnthropicStreamEvent {
    #[serde(rename = "type")]
    kind: Option<String>,
    index: Option<usize>,
    content_block: Option<AnthropicBlock>,
    delta: Option<AnthropicStreamDelta>,
    error: Option<ApiError>,
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
struct AnthropicBlock {
    #[serde(rename = "type")]
    kind: Option<String>,
    id: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicStreamDelta {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
    partial_json: Option<String>,
    /// Extended thinking arrives as `thinking_delta` with the text here.
    thinking: Option<String>,
}

async fn run_anthropic(
    app: &AppHandle,
    run_id: &str,
    req: &AgentRequest,
    system: &str,
    root: &Path,
    turns: Vec<super::chat::ChatTurn>,
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
    let mut step_index = 0usize;
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

    for _ in 0..MAX_STEPS {
        if is_cancelled(run_id) {
            return cancelled_result(final_text);
        }
        // Same pruning policy as the OpenAI loop: keep the context ~2–3k tokens.
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

        let mut request = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("anthropic-version", "2023-06-01")
            .json(&body);
        if !req.api_key.trim().is_empty() {
            request = request.header("x-api-key", req.api_key.trim());
        }

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

        let res = request.send().await.map_err(|e| format!("request failed: {e}"))?;
        let status = res.status();
        if !status.is_success() {
            let detail = res.text().await.unwrap_or_default();
            return Err(format!("Anthropic returned {status}: {detail}"));
        }

        let mut stream = res.bytes_stream();
        let mut buf = String::new();
        let mut round_text = String::new();
        // Tool inputs stream as partial JSON keyed by content-block index.
        let mut blocks: Vec<PendingCall> = Vec::new();

        while let Some(chunk) = stream.next().await {
            if is_cancelled(run_id) {
                drop(stream);
                return cancelled_result(final_text.clone() + &round_text);
            }
            let bytes = chunk.map_err(|e| format!("stream error: {e}"))?;
            buf.push_str(&String::from_utf8_lossy(&bytes));

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

            results.push(json!({
                "type": "tool_result",
                "tool_use_id": b.id,
                "content": result.output,
                "is_error": !result.ok,
            }));
        }
        messages.push(json!({ "role": "user", "content": results }));
    }

    Err(format!("stopped after {MAX_STEPS} steps without finishing"))
}