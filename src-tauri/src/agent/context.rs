//! History bounding: what of the conversation is handed to the agent.
//! Inside a run, Rig owns the message list; this only shapes the input.

/// Chat turns sent with a run: the current prompt plus recent context only.
const HISTORY_TURNS: usize = 12;
/// Earlier agent answers are clipped to their tail (where the summary is).
const HISTORY_AGENT_CHARS: usize = 1_500;

/// Bounds the conversation handed to the agent: the last HISTORY_TURNS turns,
/// starting on a user turn (Anthropic requires it), with previous agent
/// answers tail-clipped. User turns stay intact — they are the task spec.
pub(super) fn trim_history(turns: Vec<crate::chat::ChatTurn>) -> Vec<crate::chat::ChatTurn> {
    let is_agent = |r: &str| r == "agent" || r == "assistant";
    let mut start = turns.len().saturating_sub(HISTORY_TURNS);
    while start < turns.len() && is_agent(&turns[start].role) {
        start += 1;
    }
    // A /compact summary heads the first turn; it stands for everything
    // before it and must survive the cut — it moves onto the first kept turn.
    let pinned = (start > 0)
        .then(|| turns.first())
        .flatten()
        .filter(|t| t.text.starts_with(COMPACT_MARKER))
        .map(|t| t.text.split(COMPACT_SEPARATOR).next().unwrap_or(&t.text).to_string());
    let mut out: Vec<crate::chat::ChatTurn> = turns
        .into_iter()
        .skip(start)
        .map(|mut t| {
            if is_agent(&t.role) {
                t.text = clip_head(&t.text, HISTORY_AGENT_CHARS);
            }
            t
        })
        .collect();
    if let (Some(summary), Some(first)) = (pinned, out.first_mut()) {
        first.text = format!("{summary}{COMPACT_SEPARATOR}{}", first.text);
    }
    out
}

/// Heads a compacted history (the frontend's COMPACT_MARKER).
const COMPACT_MARKER: &str = "[Summary of the earlier conversation — older messages were compacted]";
/// Separates the summary from the message it rides on.
const COMPACT_SEPARATOR: &str = "

---

";

/// Keeps only the LAST keep_chars characters (prefixed by an elision mark).
pub(super) fn clip_head(s: &str, keep_chars: usize) -> String {
    let n = s.chars().count();
    if n <= keep_chars {
        return s.to_string();
    }
    let tail: String = s.chars().skip(n - keep_chars).collect();
    format!("[head pruned] {tail}")
}

pub(super) fn one_line(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c == '\n' { ' ' } else { c }).collect();
    let flat = flat.trim();
    if flat.chars().count() <= max {
        flat.to_string()
    } else {
        flat.chars().take(max).collect::<String>() + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_is_bounded_and_starts_on_user() {
        let turn = |role: &str, text: String| crate::chat::ChatTurn { role: role.into(), text };
        let mut turns = Vec::new();
        for i in 0..20 {
            turns.push(turn("user", format!("q{i}")));
            turns.push(turn("agent", "x".repeat(5000)));
        }
        turns.push(turn("user", "now".into()));
        let out = trim_history(turns);
        assert!(out.len() <= HISTORY_TURNS);
        assert_eq!(out[0].role, "user");
        assert_eq!(out.last().unwrap().text, "now");
        assert!(out.iter().all(|t| t.text.chars().count() <= HISTORY_AGENT_CHARS + 20));
    }

    #[test]
    fn compact_summary_survives_the_cut() {
        let turn = |role: &str, text: String| crate::chat::ChatTurn { role: role.into(), text };
        let mut turns = vec![turn("user", format!("{COMPACT_MARKER}
we built X{COMPACT_SEPARATOR}first"))];
        turns.push(turn("agent", "a".into()));
        for i in 0..20 {
            turns.push(turn("user", format!("q{i}")));
            turns.push(turn("agent", "x".into()));
        }
        turns.push(turn("user", "now".into()));
        let out = trim_history(turns);
        assert!(out[0].text.starts_with(COMPACT_MARKER) && out[0].text.contains("we built X"), "{}", out[0].text);
        assert!(!out[0].text.contains("first"));
    }

    #[test]
    fn one_line_flattens_and_clips() {
        assert_eq!(one_line("a\nb", 10), "a b");
        assert_eq!(one_line("abcdef", 3), "abc…");
    }
}
