//! Stuck-loop guard: detects the model repeating identical tool-call rounds
//! and nudges it out of the loop (see REPEAT_* / FAIL_* constants).

/* ---------- Stuck-loop guard ----------
   The user-visible bug: the model read ONE file 64 times and the run died
   with "stopped after 64 steps" — discarding everything. This guard spots
   the repetition early, tells the model to stop repeating, and if it still
   loops, finishes the run WITH its partial output and a clear explanation
   instead of throwing the work away. */

/// Consecutive repeats of the same tool-call set that trigger a nudge.
pub(super) const REPEAT_NUDGE_AT: usize = 2;
/// Consecutive repeats that end the run (with partial output, not an error).
pub(super) const REPEAT_ABORT_AT: usize = 4;

#[derive(Default)]
pub(super) struct RepeatGuard {
    last: String,
    count: usize,
}

impl RepeatGuard {
    /// Records one round's call fingerprint, returning how many times in a row
    /// the SAME set of calls has now been requested.
    pub(super) fn record(&mut self, fingerprint: &str) -> usize {
        if fingerprint == self.last {
            self.count += 1;
        } else {
            self.last = fingerprint.to_string();
            self.count = 1;
        }
        self.count
    }
}

/// One line describing a round's calls, used as the repeat fingerprint.
pub(super) fn call_fingerprint(names_args: &[String]) -> String {
    names_args.join(" | ")
}

/// Consecutive FAILED tool results that trigger a visible re-plan nudge —
/// "keeps launching commands that crash somewhere" was a real complaint:
/// the model tried variation after variation instead of stopping to think.
pub(super) const FAIL_NUDGE_AT: usize = 4;

pub(super) fn fail_nudge(name: &str) -> String {
    format!(
        "SYSTEM: {name} has now failed {FAIL_NUDGE_AT}+ times in a row. STOP trying variations of the same thing. Re-read the actual error, verify your assumptions with read_file/list_dir, and either fix the root cause with ONE deliberate change or finish with an explanation of what is blocking you."
    )
}

/// The text injected when the model starts repeating itself.
pub(super) fn repeat_nudge(fingerprint: &str, count: usize) -> String {
    format!(
        "SYSTEM: you requested the exact same action {count} times in a row ({fingerprint}).
         Repeating it will not change the result. Try a DIFFERENT action, or stop calling tools and write your final answer now."
    )
}
#[cfg(test)]
mod guard_tests {
    use super::*;

    #[test]
    fn repeat_guard_counts_consecutive_identical_rounds() {
        let mut g = RepeatGuard::default();
        assert_eq!(g.record("read_file(a.rs)"), 1);
        assert_eq!(g.record("read_file(a.rs)"), 2);
        assert_eq!(g.record("read_file(a.rs)"), 3);
        // A different action resets the counter — normal iteration is fine.
        assert_eq!(g.record("edit_file(a.rs)"), 1);
        assert_eq!(g.record("read_file(a.rs)"), 1);
    }

    #[test]
    fn repeat_guard_fingerprint_ignores_order_inside_round() {
        // Same call set in the same order is a repeat; a different set is not.
        let a = call_fingerprint(&["read_file(a.rs)".into(), "read_file(b.rs)".into()]);
        let b = call_fingerprint(&["read_file(a.rs)".into(), "read_file(b.rs)".into()]);
        let c = call_fingerprint(&["read_file(a.rs)".into()]);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }
}
