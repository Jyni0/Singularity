//! Cooperative cancellation registry.
//!
//! The UI's Stop button calls `cancel_run` with the active run/request id;
//! the agent loop and the chat streams check the flag between chunks and
//! unwind with a "stopped by user" error, which the frontend recognizes and
//! turns into "keep whatever already streamed".

use std::collections::HashSet;
use std::sync::Mutex;

static CANCELLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Marks a run as cancelled.
pub fn request(run_id: &str) {
    CANCELLED
        .lock()
        .unwrap()
        .get_or_insert_with(HashSet::new)
        .insert(run_id.to_string());
}

pub fn is_requested(run_id: &str) -> bool {
    CANCELLED
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.contains(run_id))
        .unwrap_or(false)
}

/// Resolves the moment run_id is cancelled. Use with tokio::select! so a
/// blocking await (HTTP send, JSON read, a silent SSE stream) is interrupted
/// IMMEDIATELY when the user presses Stop — not at the next chunk boundary.
pub async fn cancel_signal(run_id: &str) {
    loop {
        if is_requested(run_id) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    }
}

/// Forgets the flag once a run has finished, so ids never accumulate.
pub fn clear(run_id: &str) {
    if let Some(s) = CANCELLED.lock().unwrap().as_mut() {
        s.remove(run_id);
    }
}

/// The canonical error text — the frontend matches on this prefix.
pub const STOPPED: &str = "stopped by user";
