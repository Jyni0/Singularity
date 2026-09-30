//! History bounding: what of the conversation is handed to the agent.
//! Inside a run, Rig owns the message list; this only shapes the input.

/// Chat turns sent with a run: at least HISTORY_TURNS of the latest…
const HISTORY_TURNS: usize = 12;
/// …and the cut moves in steps of this many turns. A window sliding by one
/// turn per message changed the very start of the prompt every time, so the
/// provider's prompt cache never hit and each message paid the whole history
/// again; stepped, the prefix stays byte-stable for HISTORY_STEP messages.
const HISTORY_STEP: usize = 12;
/// Earlier agent answers are clipped to their tail (where the summary is).
const HISTORY_AGENT_CHARS: usize = 1_500;
/// Heads the list of tool calls the frontend appends to an agent turn.
const ACTIONS_MARKER: &str = "\n\n[Tool calls of this turn]";
/// Longest kept list of tool calls per earlier turn.
const HISTORY_ACTIONS_CHARS: usize = 2_000;

/// Bounds the conversation handed to the agent: the latest HISTORY_TURNS to
/// HISTORY_TURNS + HISTORY_STEP - 1 turns, starting on a user turn
/// (Anthropic requires it), with previous agent answers tail-clipped. User
/// turns stay intact — they are the task spec.
pub(super) fn trim_history(turns: Vec<crate::chat::ChatTurn>) -> Vec<crate::chat::ChatTurn> {
    let is_agent = |r: &str| r == "agent" || r == "assistant";
    let mut start = turns.len().saturating_sub(HISTORY_TURNS) / HISTORY_STEP * HISTORY_STEP;
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
                t.text = clip_agent(&t.text);
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

/// An earlier agent answer: its prose tail-clipped, its list of tool calls
/// (what it already read, changed and ran — so the next turn does not redo
/// it) kept separately.
fn clip_agent(text: &str) -> String {
    match text.split_once(ACTIONS_MARKER) {
        Some((prose, actions)) => format!(
            "{}{ACTIONS_MARKER}{}",
            clip_head(prose, HISTORY_AGENT_CHARS),
            clip_head(actions, HISTORY_ACTIONS_CHARS)
        ),
        None => clip_head(text, HISTORY_AGENT_CHARS),
    }
}

/// What trim_history left out of `full` (the chat) to get `sent`, for the
/// context view: older messages not sent at all, and how much of the
/// earlier answers was cut. Both are notes — not part of the request.
pub(super) fn left_out(full: &[crate::chat::ChatTurn], sent: &[crate::chat::ChatTurn]) -> Vec<super::runtime::ContextItem> {
    use super::runtime::est_tokens;
    let dropped = full.len().saturating_sub(sent.len());
    let mut out = Vec::new();
    if dropped > 0 {
        let tokens: usize = full[..dropped].iter().map(|t| est_tokens(&t.text)).sum();
        out.push(super::runtime::ContextItem {
            name: format!("Not sent · {dropped} older messages (only the latest {} go to the model)", sent.len()),
            tokens,
            note: true,
        });
    }
    let (mut shortened, mut cut) = (0usize, 0usize);
    for (orig, kept) in full[dropped..].iter().zip(sent) {
        if matches!(orig.role.as_str(), "agent" | "assistant") {
            let lost = est_tokens(&orig.text).saturating_sub(est_tokens(&kept.text));
            if lost > 0 {
                shortened += 1;
                cut += lost;
            }
        }
    }
    if shortened > 0 {
        out.push(super::runtime::ContextItem {
            name: format!("Cut · {shortened} earlier answers sent as their last {HISTORY_AGENT_CHARS} chars"),
            tokens: cut,
            note: true,
        });
    }
    out
}

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
        assert!(out.len() >= HISTORY_TURNS - 1 && out.len() < HISTORY_TURNS + HISTORY_STEP);
        assert_eq!(out[0].role, "user");
        assert_eq!(out.last().unwrap().text, "now");
        assert!(out.iter().all(|t| t.text.chars().count() <= HISTORY_AGENT_CHARS + 20));
    }

    /// Message after message the history keeps the same start (a stable
    /// prefix the prompt cache hits) until the cut jumps a whole step.
    #[test]
    fn history_start_holds_between_messages() {
        let turn = |role: &str, text: String| crate::chat::ChatTurn { role: role.into(), text };
        let mut turns = Vec::new();
        let mut firsts = Vec::new();
        for i in 0..40 {
            turns.push(turn("user", format!("q{i}")));
            firsts.push(trim_history(turns.clone())[0].text.clone());
            turns.push(turn("agent", format!("a{i}")));
        }
        let changes = firsts.windows(2).filter(|w| w[0] != w[1]).count();
        assert!(changes <= 80 / HISTORY_STEP, "the start moved {changes} times in 40 messages");
    }

    #[test]
    fn tool_calls_of_earlier_turns_survive_the_clip() {
        let long = format!("{}{ACTIONS_MARKER}\n- read_file: src/a.ts\n- apply_patch: src/b.ts", "x".repeat(5000));
        let out = clip_agent(&long);
        assert!(out.ends_with("- apply_patch: src/b.ts"));
        assert!(out.contains("[head pruned]"));
        assert!(out.chars().count() < HISTORY_AGENT_CHARS + HISTORY_ACTIONS_CHARS);
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
