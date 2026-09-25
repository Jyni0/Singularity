//! Per-provider request limiter — rate limit (requests/minute) and
//! concurrency (parallel in-flight requests).
//!
//! The frontend passes each provider's configured limits with every request;
//! this registry enforces them in Rust so ALL call paths — chat streams, the
//! agent loop, and parallel decomposed subtasks — share one budget per
//! provider. Limits of 0 mean "no limit".
//!
//! Usage: `let _permit = limiter::acquire(key, rpm, concurrency).await;` —
//! the permit releases automatically when it drops (request finished).
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Slot {
    /// Start timestamps of requests admitted in the last minute (RPM window).
    starts: VecDeque<Instant>,
    /// Requests currently in flight (concurrency).
    inflight: usize,
    /// Set when a cancellation for the waiting key was requested — waiters
    /// poll this via the cancel registry instead, so it stays simple here.
    _unused: AtomicBool,
}

static SLOTS: Mutex<Option<HashMap<String, Arc<Mutex<Slot>>>>> = Mutex::new(None);

fn slot(key: &str) -> Arc<Mutex<Slot>> {
    let mut guard = SLOTS.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    map.entry(key.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(Slot::default())))
        .clone()
}

/// RAII permit: releases the concurrency slot when dropped.
pub struct Permit {
    slot: Arc<Mutex<Slot>>,
}

impl Drop for Permit {
    fn drop(&mut self) {
        if let Ok(mut s) = self.slot.lock() {
            s.inflight = s.inflight.saturating_sub(1);
        }
    }
}

/// Waits until the provider allows another request, then reserves the slot.
/// `key` should be stable per provider (its row id). Both limits may be 0
/// (= unlimited). While waiting, the run's cancellation is honoured so Stop
/// never hangs on a queue.
pub async fn acquire(key: &str, rpm: usize, concurrency: usize, run_id: &str) -> Permit {
    let slot = slot(key);
    loop {
        {
            let mut s = slot.lock().unwrap();
            // Age out RPM window entries older than one minute.
            let cutoff = Instant::now() - Duration::from_secs(60);
            while s.starts.front().map(|t| *t < cutoff).unwrap_or(false) {
                s.starts.pop_front();
            }
            let rpm_ok = rpm == 0 || s.starts.len() < rpm;
            let conc_ok = concurrency == 0 || s.inflight < concurrency;
            if rpm_ok && conc_ok {
                s.starts.push_back(Instant::now());
                s.inflight += 1;
                return Permit { slot: slot.clone() };
            }
        }
        // Queue full — back off briefly, but keep watching the Stop button.
        if crate::cancel::is_requested(run_id) {
            // Still return a permit (it drops immediately); the caller checks
            // cancellation itself right after acquiring.
            let mut s = slot.lock().unwrap();
            s.inflight += 1;
            return Permit { slot: slot.clone() };
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unlimited_acquires_immediately() {
        let _p = acquire("prov-unlimited", 0, 0, "run1").await;
    }

    #[tokio::test]
    async fn concurrency_caps_inflight() {
        let key = "prov-conc";
        let p1 = acquire(key, 0, 2, "r").await;
        let p2 = acquire(key, 0, 2, "r").await;
        // Third acquire must block while two permits are alive:
        let slot = slot(key);
        {
            let s = slot.lock().unwrap();
            assert_eq!(s.inflight, 2);
        }
        drop(p1);
        drop(p2);
        {
            let s = slot.lock().unwrap();
            assert_eq!(s.inflight, 0);
        }
        let _p3 = acquire(key, 0, 2, "r").await;
    }

    #[tokio::test]
    async fn rpm_window_admits_then_throttles() {
        let key = "prov-rpm";
        let _a = acquire(key, 2, 0, "r").await;
        let _b = acquire(key, 2, 0, "r").await;
        // Third would block; verify the window state instead of waiting a minute.
        let slot = slot(key);
        let s = slot.lock().unwrap();
        assert_eq!(s.starts.len(), 2);
    }
}
