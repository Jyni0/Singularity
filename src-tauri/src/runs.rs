//! Registry of live generation runs.
//!
//! The tray menu answers "which agents are running right now?" from here.
//! The inference commands register on start and unregister on finish
//! (success, error or user stop), so the list is always truthful without
//! the frontend having to report anything back.
//!
//! Each run also keeps a live OUTPUT BUFFER (streamed prose, step cards,
//! task board). When the WebView reloads mid-run, the frontend lost every
//! event emitted before the reload — now it asks for the buffer and rebuilds
//! the transcript, then keeps listening to the live events as usual.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// One buffered output event of a live run (text delta, step, task board).
/// Internally tagged: the WebView switches on the "kind" field after decode.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
pub enum RunEvent {
    Text {
        delta: String,
    },
    Think {
        delta: String,
    },
    Step {
        index: usize,
        name: String,
        input: String,
        done: bool,
        ok: bool,
        result: String,
        path: Option<String>,
        old_text: Option<String>,
        new_text: Option<String>,
    },
    Tasks {
        tasks: serde_json::Value,
    },
    /// A command waiting for Allow/Deny. Buffered so a WebView reload can
    /// re-show the banner — otherwise the run waits forever for an answer
    /// nobody can give anymore.
    Confirm {
        command: String,
        cwd: String,
    },
    Done {
        answer: String,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone)]
pub struct RunInfo {
    pub run_id: String,
    pub label: String,
    pub started_unix: u64,
}

struct RunSlot {
    info: RunInfo,
    events: Vec<RunEvent>,
}

static RUNS: Mutex<Option<HashMap<String, RunSlot>>> = Mutex::new(None);

/// Finished runs are kept for a short grace window: a WebView reload that
/// lands right as a run completes must still be able to replay the buffer
/// (with the terminal Done/Error event) instead of losing the whole answer.
static FINISHED: Mutex<Option<HashMap<String, (std::time::Instant, RunSlot)>>> = Mutex::new(None);
const FINISHED_RETENTION: std::time::Duration = std::time::Duration::from_secs(120);

/// Hard cap on buffered events per run so a marathon session cannot eat RAM.
const MAX_EVENTS: usize = 4000;

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
        .insert(run_id.to_string(), RunSlot { info, events: Vec::new() });
}

/// Buffers one output event of a live run (called from the emit helpers).
/// Adjacent text/think deltas are MERGED into one event — a token-per-event
/// stream would otherwise blow the cap and lose the beginning of the answer.
pub fn push_event(run_id: &str, ev: RunEvent) {
    if let Some(map) = RUNS.lock().unwrap().as_mut() {
        if let Some(slot) = map.get_mut(run_id) {
            match (&ev, slot.events.last_mut()) {
                (RunEvent::Text { delta }, Some(RunEvent::Text { delta: d })) => {
                    d.push_str(delta);
                    return;
                }
                (RunEvent::Think { delta }, Some(RunEvent::Think { delta: d })) => {
                    d.push_str(delta);
                    return;
                }
                _ => {}
            }
            slot.events.push(ev);
            if slot.events.len() > MAX_EVENTS {
                let over = slot.events.len() - MAX_EVENTS;
                slot.events.drain(0..over);
            }
        }
    }
}

/// Removes buffered Confirm events — the user answered, so a reload must not
/// resurrect a banner for a decision that was already made.
pub fn drop_confirms(run_id: &str) {
    if let Some(map) = RUNS.lock().unwrap().as_mut() {
        if let Some(slot) = map.get_mut(run_id) {
            slot.events.retain(|e| !matches!(e, RunEvent::Confirm { .. }));
        }
    }
    if let Some(map) = FINISHED.lock().unwrap().as_mut() {
        if let Some((_, slot)) = map.get_mut(run_id) {
            slot.events.retain(|e| !matches!(e, RunEvent::Confirm { .. }));
        }
    }
}

/// Buffered events of a live (or just-finished) run — None when unknown.
pub fn events(run_id: &str) -> Option<Vec<RunEvent>> {
    if let Some(slot) = RUNS.lock().unwrap().as_ref().and_then(|m| m.get(run_id)) {
        return Some(slot.events.clone());
    }
    prune_finished();
    FINISHED
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.get(run_id))
        .map(|(_, slot)| slot.events.clone())
}

/// Forgets a finished run — moves its buffer into the short retention window.
pub fn stop(run_id: &str) {
    let slot = RUNS
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|m| m.remove(run_id));
    if let Some(slot) = slot {
        prune_finished();
        FINISHED
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(run_id.to_string(), (std::time::Instant::now(), slot));
    }
}

fn prune_finished() {
    if let Some(map) = FINISHED.lock().unwrap().as_mut() {
        map.retain(|_, (at, _)| at.elapsed() < FINISHED_RETENTION);
    }
}

/// Live runs, oldest first — the tray menu's data source.
pub fn snapshot() -> Vec<RunInfo> {
    let mut out: Vec<RunInfo> = RUNS
        .lock()
        .unwrap()
        .as_ref()
        .map(|m| m.values().map(|s| s.info.clone()).collect())
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
