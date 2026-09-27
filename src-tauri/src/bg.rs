//! Background tasks: long-running commands the agent started with
//! `run_command background:true` (dev servers, watchers, long builds).
//!
//! Each one gets a small id, its output goes to a log file, and the process
//! handle stays here so the agent (`background` tool) and the user (the
//! tasks panel under the prompt box) can list them, read their output and
//! stop them. Everything still running is stopped with the app.

use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

struct Task {
    id: u32,
    pid: u32,
    command: String,
    cwd: String,
    shell: String,
    log: PathBuf,
    started: u64,
    child: Child,
    /// Everything the command started (Windows job) — stopped as one.
    job: Option<crate::tools::ProcJob>,
    /// Exit code once the process ended (-1 = killed / unknown).
    exit: Option<i32>,
    stopped: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: u32,
    pub pid: u32,
    pub command: String,
    pub cwd: String,
    pub shell: String,
    pub log_path: String,
    /// Unix seconds.
    pub started: u64,
    pub running: bool,
    pub exit_code: Option<i32>,
    /// Stopped by the user or the agent (not a crash).
    pub stopped: bool,
}

static TASKS: Mutex<Vec<Task>> = Mutex::new(Vec::new());
static NEXT: AtomicU32 = AtomicU32::new(1);

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn refresh(t: &mut Task) {
    if t.exit.is_none() {
        if let Ok(Some(st)) = t.child.try_wait() {
            // A server can outlive the shell that started it: the task
            // runs as long as anything in its job does.
            if t.job.as_ref().is_none_or(|j| j.active() == 0) {
                t.exit = Some(st.code().unwrap_or(-1));
            }
        }
    }
}

fn info(t: &Task) -> TaskInfo {
    TaskInfo {
        id: t.id,
        pid: t.pid,
        command: t.command.clone(),
        cwd: t.cwd.clone(),
        shell: t.shell.clone(),
        log_path: t.log.display().to_string(),
        started: t.started,
        running: t.exit.is_none(),
        exit_code: t.exit,
        stopped: t.stopped,
    }
}

/// Takes ownership of a started background process; returns its task id.
pub fn register(child: Child, job: Option<crate::tools::ProcJob>, command: &str, cwd: &str, shell: &str, log: PathBuf) -> u32 {
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let task = Task {
        id,
        pid: child.id(),
        command: command.to_string(),
        cwd: cwd.to_string(),
        shell: shell.to_string(),
        log,
        started: now(),
        child,
        job,
        exit: None,
        stopped: false,
    };
    TASKS.lock().unwrap_or_else(|e| e.into_inner()).push(task);
    id
}

/// Every known task, newest first, with fresh running/exited state.
pub fn list() -> Vec<TaskInfo> {
    let mut tasks = TASKS.lock().unwrap_or_else(|e| e.into_inner());
    tasks.iter_mut().for_each(refresh);
    tasks.iter().rev().map(info).collect()
}

/// The last `max_chars` of a task's output (ANSI stripped).
pub fn output(id: u32, max_chars: usize) -> Result<(TaskInfo, String), String> {
    let (inf, log) = {
        let mut tasks = TASKS.lock().unwrap_or_else(|e| e.into_inner());
        let t = tasks.iter_mut().find(|t| t.id == id).ok_or_else(|| format!("no background task #{id}"))?;
        refresh(t);
        (info(t), t.log.clone())
    };
    let bytes = std::fs::read(&log).unwrap_or_default();
    let text = crate::tools::console_text(&bytes);
    let n = text.chars().count();
    let tail = if n > max_chars {
        format!("… (earlier output cut) …\n{}", text.chars().skip(n - max_chars).collect::<String>())
    } else {
        text
    };
    Ok((inf, tail))
}

/// Stops a task and everything it started.
pub fn stop(id: u32) -> Result<TaskInfo, String> {
    let mut tasks = TASKS.lock().unwrap_or_else(|e| e.into_inner());
    let t = tasks.iter_mut().find(|t| t.id == id).ok_or_else(|| format!("no background task #{id}"))?;
    refresh(t);
    // The shell may have exited while the server it started still runs —
    // the job holds them all either way.
    if let Some(job) = &t.job {
        job.kill();
    }
    if t.exit.is_none() {
        crate::tools::kill_tree(&mut t.child);
        t.exit = Some(-1);
    }
    t.stopped = true;
    t.job = None;
    Ok(info(t))
}

/// Forgets a finished task (its log file is deleted too).
pub fn remove(id: u32) -> Result<(), String> {
    let mut tasks = TASKS.lock().unwrap_or_else(|e| e.into_inner());
    let Some(i) = tasks.iter().position(|t| t.id == id) else { return Ok(()) };
    refresh(&mut tasks[i]);
    if tasks[i].exit.is_none() {
        return Err("the task is still running — stop it first".into());
    }
    let t = tasks.remove(i);
    let _ = std::fs::remove_file(&t.log);
    Ok(())
}

/// Stops everything (app exit).
pub fn shutdown() {
    let mut tasks = TASKS.lock().unwrap_or_else(|e| e.into_inner());
    for t in tasks.iter_mut() {
        if let Some(job) = &t.job {
            job.kill();
        }
        refresh(t);
        if t.exit.is_none() {
            crate::tools::kill_tree(&mut t.child);
        }
    }
}

fn describe(i: &TaskInfo) -> String {
    let state = match (i.running, i.exit_code, i.stopped) {
        (true, _, _) => format!("running {}s", now().saturating_sub(i.started)),
        (false, _, true) => "stopped".to_string(),
        (false, Some(c), _) => format!("exited with code {c}"),
        _ => "exited".to_string(),
    };
    format!("#{} [{state}] pid {} — {}  (in {})", i.id, i.pid, i.command, i.cwd)
}

/// The agent's `background` tool: list | output | stop.
pub fn tool(args: &serde_json::Value) -> crate::tools::ToolResult {
    use crate::tools::ToolResult;
    let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("list");
    let id = args.get("id").and_then(|v| v.as_u64()).map(|v| v as u32);
    match (action, id) {
        ("list", _) => {
            let all = list();
            if all.is_empty() {
                ToolResult::ok("no background tasks")
            } else {
                ToolResult::ok(all.iter().map(describe).collect::<Vec<_>>().join("\n"))
            }
        }
        ("output" | "logs" | "log", Some(id)) => {
            let max = args.get("max_chars").and_then(|v| v.as_u64()).unwrap_or(6_000).clamp(200, 30_000) as usize;
            match output(id, max) {
                Ok((i, text)) => ToolResult::ok(format!(
                    "{}\n--- output ---\n{}",
                    describe(&i),
                    if text.trim().is_empty() { "(nothing yet)".into() } else { text }
                )),
                Err(e) => ToolResult::err(e),
            }
        }
        ("stop" | "kill", Some(id)) => match stop(id) {
            Ok(i) => ToolResult::ok(format!("stopped {}", describe(&i))),
            Err(e) => ToolResult::err(e),
        },
        (_, None) => ToolResult::err(format!("action {action:?} needs the task id (see action:list)")),
        (other, _) => ToolResult::err(format!("unknown action {other:?} — use list, output or stop")),
    }
}

/* ---------- Tauri commands (the tasks panel) ---------- */

#[tauri::command]
pub fn bg_list() -> Vec<TaskInfo> {
    list()
}

#[tauri::command]
pub fn bg_output(id: u32, max_chars: Option<usize>) -> Result<String, String> {
    output(id, max_chars.unwrap_or(40_000)).map(|(_, text)| text)
}

#[tauri::command]
pub fn bg_stop(id: u32) -> Result<(), String> {
    stop(id).map(|_| ())
}

#[tauri::command]
pub fn bg_remove(id: u32) -> Result<(), String> {
    remove(id)
}
