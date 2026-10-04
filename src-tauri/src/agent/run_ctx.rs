//! State shared by the main agent, its tools and every subagent of one run.

use super::{ask_confirm, emit_retry, emit_step, emit_text, emit_think, emit_usage, AgentRequest, RunUsage};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

/// Context window assumed when the model's own is unknown.
pub(in crate::agent) const DEFAULT_WINDOW: u64 = 128_000;

/// Cheap to clone (all Arcs).
#[derive(Clone)]
pub(in crate::agent) struct RunCtx {
    /// The app to report to; None in tests (events are dropped, approvals
    /// read as denied).
    pub app: Option<AppHandle>,
    pub run_id: String,
    pub req: Arc<AgentRequest>,
    /// Workspace root.
    pub root: PathBuf,
    /// Next UI step index (shared by main agent and subagents).
    pub counter: Arc<AtomicUsize>,
    /// One Allow/Deny banner at a time, even with parallel tool calls.
    pub confirm_lock: Arc<tokio::sync::Mutex<()>>,
    /// Bounds concurrently working subagents.
    pub agent_slots: Arc<tokio::sync::Semaphore>,
    pub usage: Arc<Mutex<RunUsage>>,
    pub started: std::time::Instant,
    /// Working directory of file tools and commands; `change_dir` moves it.
    /// Starts at the workspace.
    pub cwd: Arc<Mutex<PathBuf>>,
    /// Set once the provider rejected the temperature parameter (reasoning
    /// models, out-of-range values): later requests go without it.
    pub no_temperature: Arc<AtomicBool>,
    /// The model's context window, tokens — drives auto-compaction.
    pub window: u64,
}

impl RunCtx {
    pub fn new(app: Option<&AppHandle>, run_id: &str, req: &AgentRequest, root: PathBuf, parallel: usize, window: u64) -> Self {
        Self {
            app: app.cloned(),
            run_id: run_id.to_string(),
            req: Arc::new(req.clone()),
            cwd: Arc::new(Mutex::new(root.clone())),
            root,
            counter: Arc::default(),
            confirm_lock: Arc::default(),
            agent_slots: Arc::new(tokio::sync::Semaphore::new(parallel)),
            usage: Arc::new(Mutex::new(RunUsage {
                run_id: run_id.to_string(),
                prompt_tokens: 0,
                completion_tokens: 0,
                cached_tokens: 0,
                elapsed_ms: 0,
                first_input: 0,
                first_est: 0,
                last_input: 0,
            })),
            started: std::time::Instant::now(),
            no_temperature: Arc::default(),
            window,
        }
    }

    pub fn cwd(&self) -> PathBuf {
        self.cwd.lock().unwrap().clone()
    }

    pub fn next_index(&self) -> usize {
        self.counter.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// How many UI steps the run produced so far.
    pub fn steps(&self) -> usize {
        self.counter.load(Ordering::SeqCst)
    }

    /// Emits a step card; `label` prefixes a helper's cards ("[worker] ").
    pub fn step(&self, label: &str, index: usize, name: &str, input: &str, done: bool, res: &crate::tools::ToolResult) {
        if let Some(app) = &self.app {
            emit_step(app, &self.run_id, index, name, format!("{label}{input}"), done, res);
        }
    }

    /// Streams answer text to the chat.
    pub fn text(&self, delta: String) {
        if let Some(app) = &self.app {
            emit_text(app, &self.run_id, delta);
        }
    }

    /// Streams reasoning to the chat's thinking block.
    pub fn think(&self, delta: String) {
        if let Some(app) = &self.app {
            emit_think(app, &self.run_id, delta);
        }
    }

    pub fn retry(&self, message: String, attempt: usize, max: usize) {
        if let Some(app) = &self.app {
            emit_retry(app, &self.run_id, message, attempt, max);
        }
    }

    /// Asks the user to Allow/Deny; one banner at a time.
    pub async fn confirm(&self, what: &str, place: &str, reason: &str) -> bool {
        let Some(app) = &self.app else {
            return false;
        };
        let _one_banner = self.confirm_lock.lock().await;
        ask_confirm(app, &self.run_id, what, place, reason).await
    }

    /// `main`: the call is the main agent's (not a helper's) — its input is
    /// the context gauge's live reading.
    pub fn add_usage(&self, input: u64, output: u64, cached: u64, main: bool) {
        let mut u = self.usage.lock().unwrap();
        if u.first_input == 0 {
            u.first_input = input;
        }
        if main {
            u.last_input = input;
        }
        u.prompt_tokens += input;
        u.completion_tokens += output;
        u.cached_tokens += cached;
        u.elapsed_ms = self.started.elapsed().as_millis() as u64;
        if let Some(app) = &self.app {
            emit_usage(app, &u);
        }
    }
}
