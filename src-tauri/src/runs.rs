//! Registry of live generation runs.
//!
//! The tray menu answers "which agents are running right now?" from here.
//! The inference commands register on start and unregister on finish
//! (success, error or user stop), so the list is always truthful without
//! the frontend having to report anything back.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct RunInfo {
    pub run_id: String,
    pub label: String,
    pub started_unix: u64,
}

static RUNS: Mutex<Option<HashMap<String, RunInfo>>> = Mutex::new(None);

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Marks a run as live. The label is what the tray shows.
pub fn start(run_id: &str, label: &str) {
    let info = RunInfo {
        run_id: run_id.to_string(),
        label: label.to_string(),
        started_unix: now_unix(),
    };
    RUNS.lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(run_id.to_string(), info);
}

/// Forgets a finished run.
pub fn stop(run_id: &str) {
    if let Some(map) = RUNS.lock().unwrap().as_mut() {
        map.remove(run_id);
    }
}

/// Live runs, oldest first — the tray menu's data source.
pub fn snapshot() -> Vec<RunInfo> {
    let mut out: Vec<RunInfo> = RUNS
        .lock()
        .unwrap()
        .as_ref()
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default();
    out.sort_by_key(|r| r.started_unix);
    out
}

pub fn count() -> usize {
    RUNS.lock()
        .unwrap()
        .as_ref()
        .map(|m| m.len())
        .unwrap_or(0)
}
