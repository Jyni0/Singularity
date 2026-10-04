//! Guardrails of one agent: the stuck-loop detector and the turn budget.
//!
//! The model sometimes re-issues the exact same tool call over and over
//! (re-reading a file, re-running a failing command). `LoopGuard` keys every
//! call by `tool_name` + a hash of its canonical arguments and counts
//! consecutive repeats: at REPEAT_SKIP_AT the call is not executed and the
//! model reads a SYSTEM WARNING instead; at REPEAT_STOP_AT the run ends with
//! what exists.

use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// Upper bound on model calls of one run (the agent loop's turn budget).
/// The repeat guard stops pathological loops long before this.
pub(in crate::agent) const MAX_TURNS: usize = 128;

/// Identical consecutive tool calls tolerated before they are skipped.
const REPEAT_SKIP_AT: usize = 3;
/// …and before the run is stopped outright.
const REPEAT_STOP_AT: usize = 5;

/// Marker of the repeat guard's stop — deliberate, never retried.
pub(in crate::agent) const GUARD_STOP: &str = "the model repeated the same action";

/// What the model reads back instead of a skipped repeat — the call's
/// tool_result (Anthropic requires one per tool_use, so the warning cannot
/// be a separate system message mid-history).
pub(in crate::agent) fn repeat_warning(tool: &str, repeats: usize) -> String {
    format!(
        "SYSTEM WARNING: You have invoked tool {tool} with identical parameters {repeats} times. \
         The call was NOT executed again — its result would not change. Stop reading/retrying and \
         state your next step or report a blocker."
    )
}

/// What the guard decided about one call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::agent) enum Verdict {
    Run,
    /// Same call `repeats` times in a row: skip it, nudge the model.
    Skip { repeats: usize },
    /// Same call `repeats` times in a row: end the run.
    Stop { repeats: usize },
}

/// Counts consecutive identical calls (`tool_name` + args hash).
#[derive(Debug, Default)]
pub(in crate::agent) struct LoopGuard {
    last: Option<(String, u64)>,
    repeats: usize,
}

impl LoopGuard {
    /// Records a call about to run and decides whether it may.
    /// `args` must already be normalized (see runtime::norm_args).
    pub fn check(&mut self, tool: &str, args: &Value) -> Verdict {
        let key = (tool.to_string(), args_hash(args));
        if self.last.as_ref() == Some(&key) {
            self.repeats += 1;
        } else {
            self.last = Some(key);
            self.repeats = 1;
        }
        let verdict = match self.repeats {
            n if n >= REPEAT_STOP_AT => Verdict::Stop { repeats: n },
            n if n >= REPEAT_SKIP_AT => Verdict::Skip { repeats: n },
            _ => Verdict::Run,
        };
        if verdict != Verdict::Run {
            tracing::warn!(tool, repeats = self.repeats, ?verdict, "loop guard tripped");
        }
        verdict
    }
}

/// Hash of the canonical JSON text of the arguments. serde_json keeps
/// object keys sorted (no `preserve_order`), so formatting and key order of
/// the provider's raw string do not matter.
fn args_hash(args: &Value) -> u64 {
    let mut h = DefaultHasher::new();
    serde_json::to_string(args).unwrap_or_default().hash(&mut h);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn repeats_skip_then_stop() {
        let mut g = LoopGuard::default();
        let a = json!({"path": "a.rs"});
        assert_eq!(g.check("read_file", &a), Verdict::Run);
        assert_eq!(g.check("read_file", &a), Verdict::Run);
        assert_eq!(g.check("read_file", &a), Verdict::Skip { repeats: 3 });
        assert_eq!(g.check("read_file", &a), Verdict::Skip { repeats: 4 });
        assert_eq!(g.check("read_file", &a), Verdict::Stop { repeats: 5 });
    }

    #[test]
    fn a_different_call_resets_the_count() {
        let mut g = LoopGuard::default();
        let a = json!({"path": "a.rs"});
        g.check("read_file", &a);
        g.check("read_file", &a);
        assert_eq!(g.check("read_file", &json!({"path": "b.rs"})), Verdict::Run);
        assert_eq!(g.check("list_dir", &a), Verdict::Run);
        assert_eq!(g.check("read_file", &a), Verdict::Run);
    }

    #[test]
    fn warning_names_the_tool() {
        let w = repeat_warning("read_file", 3);
        assert!(w.starts_with("SYSTEM WARNING: You have invoked tool read_file with identical parameters 3 times."));
    }

    #[test]
    fn key_order_does_not_matter() {
        let mut g = LoopGuard::default();
        let a: Value = serde_json::from_str(r#"{"a":1,"b":2}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{ "b": 2, "a": 1 }"#).unwrap();
        g.check("t", &a);
        g.check("t", &b);
        assert_eq!(g.check("t", &a), Verdict::Skip { repeats: 3 });
    }
}
