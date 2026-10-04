//! What of the conversation reaches the model, and how big it is.
//!
//! * Before a run: `trim_history` bounds the chat handed to the agent.
//! * Inside a run, `ContextManager` owns the wire view of the history:
//!   - collapsing: the oldest bulky tool results become a one-line stub
//!     once the history outgrows CLEAR_TRIGGER_CHARS (in big, cache-stable
//!     jumps — see clear_old_results);
//!   - read dedupe: re-reading an unchanged file whose earlier output is
//!     still in full on the wire returns a pointer instead of the content;
//!   - the auto-compaction trigger (COMPACT_AT of the context window).
//! * `est_tokens` is the shared rough token count.

use rig_agent::core::completion::message::{Message, ToolResult, ToolResultContent, UserContent};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::SystemTime;

/* ---------- History handed to a run ---------- */

/// Chat turns sent with a run: the current prompt plus recent context only.
const HISTORY_TURNS: usize = 12;
/// Earlier agent answers are clipped to their tail (where the summary is).
const HISTORY_AGENT_CHARS: usize = 1_500;
/// The work log (a line per tool call) of each kept agent turn, chars.
const HISTORY_LOG_CHARS: usize = 4_000;
/// The latest agent turn also brings its read / search / command outputs —
/// what the agent saw — so the next message does not re-read every file.
const HISTORY_DETAIL_CHARS: usize = 24_000;

/// Bounds the conversation handed to the agent: the last HISTORY_TURNS turns,
/// starting on a user turn (Anthropic requires it), with previous agent
/// answers tail-clipped. User turns stay intact — they are the task spec.
pub(in crate::agent) fn trim_history(turns: Vec<crate::chat::ChatTurn>) -> Vec<crate::chat::ChatTurn> {
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
    let last_agent = turns.iter().rposition(|t| is_agent(&t.role));
    let mut out: Vec<crate::chat::ChatTurn> = turns
        .into_iter()
        .enumerate()
        .skip(start)
        .map(|(i, mut t)| {
            if is_agent(&t.role) {
                t.text = clip_head(&t.text, HISTORY_AGENT_CHARS);
                let log = std::mem::take(&mut t.work_log);
                let detail = std::mem::take(&mut t.work_detail);
                if !log.trim().is_empty() {
                    t.text.push_str(&format!("\n\n[What I did in this turn]\n{}", clip_tail(&log, HISTORY_LOG_CHARS)));
                }
                if Some(i) == last_agent && !detail.trim().is_empty() {
                    t.text.push_str(&format!(
                        "\n\n[What those tools returned — still current unless changed above]\n{}",
                        clip_tail(&detail, HISTORY_DETAIL_CHARS)
                    ));
                }
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

/// Keeps only the FIRST keep_chars characters (marking the cut).
fn clip_tail(s: &str, keep_chars: usize) -> String {
    match s.char_indices().nth(keep_chars) {
        Some((i, _)) => format!("{}\n[… cut]", &s[..i]),
        None => s.to_string(),
    }
}

/// Keeps only the LAST keep_chars characters (prefixed by an elision mark).
fn clip_head(s: &str, keep_chars: usize) -> String {
    let n = s.chars().count();
    if n <= keep_chars {
        return s.to_string();
    }
    let tail: String = s.chars().skip(n - keep_chars).collect();
    format!("[head pruned] {tail}")
}

pub(in crate::agent) fn one_line(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c == '\n' { ' ' } else { c }).collect();
    let flat = flat.trim();
    if flat.chars().count() <= max {
        flat.to_string()
    } else {
        flat.chars().take(max).collect::<String>() + "…"
    }
}

/* ---------- Context editing inside a run ---------- */

/// Context editing — the client-side twin of Anthropic's `clear_tool_uses`:
/// once the conversation inside a run grows past CLEAR_TRIGGER_CHARS, the
/// OLDEST bulky tool results are replaced by a stub until it is back under
/// CLEAR_TARGET_CHARS. The most recent results always stay. Clearing jumps
/// in big steps and then holds still, so the prompt prefix stays byte-stable
/// between jumps and the provider's prompt cache keeps hitting.
const CLEAR_TRIGGER_CHARS: usize = 160_000;
const CLEAR_TARGET_CHARS: usize = 80_000;
/// Newest tool results that are never cleared.
const CLEAR_KEEP_RECENT: usize = 6;
/// Results shorter than this are not worth clearing.
const CLEAR_MIN_CHARS: usize = 600;
/// Every stub starts with this; the manager finds stubbed results by it.
const STUB_PREFIX: &str = "[Output of tool '";
/// Rough length of a stub — what clearing a result does NOT free.
const STUB_CHARS: usize = 110;

/// What replaces a collapsed result. Deterministic per result, so a stubbed
/// prefix stays byte-identical across rounds (prompt cache).
fn stub(name: &str, step: usize) -> String {
    format!("{STUB_PREFIX}{name}' from step {step} truncated to save context — call the tool again if you still need it]")
}

/// Text size of one tool result.
fn result_chars(r: &ToolResult) -> usize {
    r.content
        .iter()
        .map(|c| match c {
            ToolResultContent::Text(t) => t.text.len(),
            ToolResultContent::Json { value } => value.to_string().len(),
            ToolResultContent::Image(_) => 1_000,
        })
        .sum()
}

/// Returns the history to send with the oldest bulky tool results stubbed
/// (None = send it unchanged). `cleared` is the caller's watermark: it only
/// ever moves forward, and only when the history outgrew the trigger.
pub(in crate::agent) fn clear_old_results(history: &[Message], cleared: &mut usize) -> Option<Vec<Message>> {
    // Clearable results in order: (message, content index, size). A helper's
    // report and loaded skill instructions are the agent's working notes —
    // they are never cleared.
    let mut results = Vec::new();
    for (mi, m) in history.iter().enumerate() {
        if let Message::User { content } = m {
            for (ci, c) in content.iter().enumerate() {
                if let UserContent::ToolResult(r) = c {
                    let size = result_chars(r);
                    if size >= CLEAR_MIN_CHARS && r.name != "delegate" && r.name != "skill" {
                        results.push((mi, ci, size));
                    }
                }
            }
        }
    }
    let clearable = results.len().saturating_sub(CLEAR_KEEP_RECENT);
    *cleared = (*cleared).min(clearable);
    let before = *cleared;
    let total: usize = history.iter().map(|m| serde_json::to_string(m).map(|j| j.len()).unwrap_or(0)).sum();
    let freed = |n: usize| results[..n].iter().map(|r| r.2.saturating_sub(STUB_CHARS)).sum::<usize>();
    if total.saturating_sub(freed(*cleared)) > CLEAR_TRIGGER_CHARS {
        while *cleared < clearable && total.saturating_sub(freed(*cleared)) > CLEAR_TARGET_CHARS {
            *cleared += 1;
        }
    }
    if *cleared != before {
        tracing::info!(
            history_chars = total,
            cleared_from = before,
            cleared_to = *cleared,
            freed_chars = freed(*cleared),
            "context editing: old tool results stubbed"
        );
    }
    if *cleared == 0 {
        return None;
    }
    let mut out = history.to_vec();
    for &(mi, ci, _) in &results[..*cleared] {
        let step = step_of(history, mi);
        if let Message::User { content } = &mut out[mi] {
            if let Some(UserContent::ToolResult(r)) = content.get_mut(ci) {
                r.content = vec![ToolResultContent::text(stub(&r.name, step))];
            }
        }
    }
    Some(out)
}

/// The step (model turn) a message belongs to: assistant turns before it.
fn step_of(history: &[Message], index: usize) -> usize {
    history[..index].iter().filter(|m| matches!(m, Message::Assistant { .. })).count()
}

/// Whether a tool result was collapsed to a stub.
fn is_stub(r: &ToolResult) -> bool {
    matches!(r.content.first(), Some(ToolResultContent::Text(t)) if t.text.starts_with(STUB_PREFIX))
}

fn history_tokens(history: &[Message]) -> u64 {
    history.iter().map(|m| est_tokens(&serde_json::to_string(m).unwrap_or_default()) as u64).sum()
}

/* ---------- Per-run context state ---------- */

/// Share of the context window at which the history is compacted.
pub(in crate::agent) const COMPACT_AT: f64 = 0.70;
/// After a compaction, the next one waits until the estimate grew by this
/// share of the window — the static prefix alone may exceed the threshold
/// on a small local window, and compacting again would not help.
const COMPACT_REGROW: f64 = 0.15;

/// Size + mtime of a file at read time; a change of either invalidates it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::agent) struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
}

struct ReadRecord {
    stamp: FileStamp,
    /// The lines that read returned.
    from: usize,
    to: usize,
    /// Tool call id whose result holds the content.
    call_id: String,
    step: usize,
}

/// The wire view of one agent's history. Owned by the agent loop.
pub(in crate::agent) struct ContextManager {
    window: u64,
    /// Watermark of clear_old_results.
    cleared: usize,
    /// Call ids whose results are currently stubbed on the wire.
    stubbed: HashSet<String>,
    /// Reads per file (key: normalized path).
    reads: HashMap<String, Vec<ReadRecord>>,
    /// Input tokens of the latest model call, as the provider reported them.
    last_input: u64,
    /// History length when that call went out.
    len_at_last_call: usize,
    /// Estimated size right after the latest compaction.
    compacted_at: Option<u64>,
    /// Stub old bulky tool results (see `without_collapsing`).
    collapse: bool,
}

impl ContextManager {
    pub fn new(window: u64) -> Self {
        Self {
            window,
            cleared: 0,
            stubbed: HashSet::new(),
            reads: HashMap::new(),
            last_input: 0,
            len_at_last_call: 0,
            compacted_at: None,
            collapse: true,
        }
    }

    /// Never rewrites earlier messages. For the subscription CLIs: a CLI
    /// session holds the conversation itself (and compacts it itself), and
    /// a rewritten earlier message would force a new session that re-sends
    /// everything.
    pub fn without_collapsing(mut self) -> Self {
        self.collapse = false;
        self
    }

    pub fn window(&self) -> u64 {
        self.window
    }

    /// The history as it goes on the wire (old bulky results collapsed).
    pub fn prepare(&mut self, history: &[Message]) -> Vec<Message> {
        if !self.collapse {
            return history.to_vec();
        }
        let out = clear_old_results(history, &mut self.cleared).unwrap_or_else(|| history.to_vec());
        self.stubbed = out
            .iter()
            .filter_map(|m| match m {
                Message::User { content } => Some(content),
                _ => None,
            })
            .flatten()
            .filter_map(|c| match c {
                UserContent::ToolResult(r) if is_stub(r) => Some(r.call.as_str().to_string()),
                _ => None,
            })
            .collect();
        out
    }

    /// Records what the provider counted for the call that just went out.
    pub fn note_usage(&mut self, input_tokens: u64, history_len: usize) {
        if input_tokens > 0 {
            self.last_input = input_tokens;
            self.len_at_last_call = history_len;
        }
    }

    /// Estimated input tokens of the next call: the provider's count of the
    /// last one plus what was appended since. None until a call reported.
    pub fn estimate(&self, history: &[Message]) -> Option<u64> {
        if self.last_input == 0 {
            return None;
        }
        Some(self.last_input + history_tokens(history.get(self.len_at_last_call..).unwrap_or(&[])))
    }

    /// Some(estimate) when the next call would cross COMPACT_AT of the window.
    pub fn needs_compaction(&self, history: &[Message]) -> Option<u64> {
        let est = self.estimate(history)?;
        if est < (self.window as f64 * COMPACT_AT) as u64 {
            return None;
        }
        if let Some(after) = self.compacted_at {
            if est < after + (self.window as f64 * COMPACT_REGROW) as u64 {
                return None;
            }
        }
        Some(est)
    }

    /// `old` was replaced by `new` (summary + recent tail): everything keyed
    /// to the old history is void.
    pub fn after_compaction(&mut self, old: &[Message], new: &[Message]) {
        // The static prefix (system + tools) is what the last count holds
        // beyond the history it was sent with.
        let sent = history_tokens(old.get(..self.len_at_last_call).unwrap_or(old));
        let fixed = self.last_input.saturating_sub(sent);
        self.compacted_at = Some(fixed + history_tokens(new));
        self.cleared = 0;
        self.stubbed.clear();
        self.reads.clear();
        self.last_input = 0;
        self.len_at_last_call = 0;
    }

    /// Compaction was not possible (too little history, summary failed):
    /// wait until the history regrows before trying again.
    pub fn defer_compaction(&mut self, est: u64) {
        self.compacted_at = Some(est);
    }

    /// For a read_file call: Some(step) when an earlier read of the file
    /// already returned every line asked for, the file has not changed
    /// since, and that output is still in full on the wire — re-reading it
    /// would only duplicate the content (Claude Code's "file unchanged").
    pub fn unchanged_read(&self, r: &ReadSpan) -> Option<usize> {
        self.reads.get(&r.file)?.iter().rev().find_map(|rec| {
            (rec.stamp == r.stamp && rec.from <= r.from && r.to <= rec.to && !self.stubbed.contains(&rec.call_id)).then_some(rec.step)
        })
    }

    pub fn note_read(&mut self, r: ReadSpan, call_id: String, step: usize) {
        let list = self.reads.entry(r.file).or_default();
        // Older reads of a changed file are useless now.
        list.retain(|rec| rec.stamp == r.stamp);
        list.push(ReadRecord { stamp: r.stamp, from: r.from, to: r.to, call_id, step });
    }
}

/// What a read_file call reads: the file, its stamp, and the lines it
/// returns (read_file's own window).
#[derive(Debug, Clone)]
pub(in crate::agent) struct ReadSpan {
    file: String,
    stamp: FileStamp,
    from: usize,
    to: usize,
}

pub(in crate::agent) fn read_fingerprint(cwd: &Path, args: &Value) -> Option<ReadSpan> {
    let path = args.get("path")?.as_str()?;
    let full = crate::agent::permissions::full_path(&cwd.to_string_lossy(), path);
    let meta = std::fs::metadata(&full).ok().filter(|m| m.is_file() && m.len() <= 400_000)?;
    let text = std::fs::read(&full).ok()?;
    let lines = text.split(|b| *b == b'\n').count() - usize::from(text.ends_with(b"\n"));
    let num = |k: &str| args.get(k).and_then(|v| v.as_u64()).map(|n| n as usize);
    let (from, to, _) = crate::tools::read_window(lines, text.len(), num("start_line"), num("end_line"));
    let mut file = full.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        file = file.to_lowercase();
    }
    Some(ReadSpan { file, stamp: FileStamp { len: meta.len(), modified: meta.modified().ok() }, from, to })
}

/* ---------- Token accounting ---------- */

/// Rough token count: ~4 characters per token for ASCII (English, code),
/// ~2.5 for other scripts (Cyrillic, CJK tokenize denser). Real tokenizers
/// differ by model; this is for the "how full is it" gauge.
pub(crate) fn est_tokens(text: &str) -> usize {
    let (mut ascii, mut other) = (0usize, 0usize);
    for c in text.chars() {
        if c.is_ascii() {
            ascii += 1;
        } else {
            other += 1;
        }
    }
    (ascii as f64 / 4.0 + other as f64 / 2.5).ceil() as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_is_bounded_and_starts_on_user() {
        let turn = |role: &str, text: String| crate::chat::ChatTurn { role: role.into(), text, ..Default::default() };
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

    /// Every kept agent turn says what it did; the latest also brings what
    /// its tools returned — the next message need not re-read it all.
    #[test]
    fn agent_work_rides_into_the_next_message() {
        let agent = |text: &str, log: &str, detail: &str| crate::chat::ChatTurn {
            role: "agent".into(),
            text: text.into(),
            work_log: log.into(),
            work_detail: detail.into(),
        };
        let user = |text: &str| crate::chat::ChatTurn { role: "user".into(), text: text.into(), ..Default::default() };
        let turns = vec![
            user("fix the button"),
            agent(&"y".repeat(3000), "- read_file src/a.ts → ok", "### read_file src/a.ts\nOLD BODY"),
            user("now the header"),
            agent("done", "- apply_patch src/h.tsx → changed (+3 −1)", "### read_file src/h.tsx\nHEADER BODY"),
            user("and the footer"),
        ];
        let out = trim_history(turns);
        // The long answer is still tail-clipped, the log is NOT cut with it.
        assert!(out[1].text.starts_with("[head pruned]") && out[1].text.contains("- read_file src/a.ts → ok"));
        // Only the latest turn carries the outputs.
        assert!(!out[1].text.contains("OLD BODY"));
        assert!(out[3].text.contains("changed (+3 −1)") && out[3].text.contains("HEADER BODY"));
    }

    #[test]
    fn compact_summary_survives_the_cut() {
        let turn = |role: &str, text: String| crate::chat::ChatTurn { role: role.into(), text, ..Default::default() };
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

    #[test]
    fn old_tool_results_are_cleared_in_steps() {
        let stub_count = |h: &[Message]| {
            h.iter()
                .filter(|m| serde_json::to_string(m).unwrap().contains("truncated to save context"))
                .count()
        };
        // 30 bulky results ≈ 300k chars: well past the trigger.
        let mut history = vec![Message::user("task")];
        for i in 0..30 {
            history.push(Message::tool_result(format!("c{i}"), "read_file", "x".repeat(10_000)));
        }
        history.push(Message::tool_result("d", "delegate", "y".repeat(10_000)));
        let mut cleared = 0;
        let out = clear_old_results(&history, &mut cleared).expect("history over the trigger is edited");
        assert!(cleared > 0 && cleared <= 30 - CLEAR_KEEP_RECENT);
        assert_eq!(stub_count(&out), cleared);
        // The newest results and the helper's report stay verbatim.
        assert!(serde_json::to_string(&out[30]).unwrap().contains("xxxx"));
        assert!(serde_json::to_string(out.last().unwrap()).unwrap().contains("yyyy"));
        // Next turn with one more small result: the watermark holds (cache-stable).
        history.push(Message::tool_result("e", "list_dir", "z"));
        let before = cleared;
        clear_old_results(&history, &mut cleared);
        assert_eq!(cleared, before);
        // Small histories are sent untouched.
        let mut zero = 0;
        assert!(clear_old_results(&history[..3], &mut zero).is_none());
    }

    #[test]
    fn stub_names_the_tool_and_step() {
        let mut history = vec![Message::user("task")];
        for i in 0..30 {
            history.push(Message::assistant(format!("step {i}")));
            history.push(Message::tool_result(format!("c{i}"), "read_file", "x".repeat(10_000)));
        }
        let mut m = ContextManager::new(200_000);
        let out = m.prepare(&history);
        let first = serde_json::to_string(&out[2]).unwrap();
        assert!(first.contains("[Output of tool 'read_file' from step 1 truncated to save context"), "{first}");
        assert!(m.stubbed.contains("c0"));
        assert!(!m.stubbed.contains("c29"));
    }

    #[test]
    fn unchanged_reads_are_deduped_until_stubbed() {
        let dir = std::env::temp_dir().join(format!("sing-ctx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        let body: String = (1..=50).map(|i| format!("line {i}\n")).collect();
        std::fs::write(dir.join("a.txt"), &body).unwrap();
        let args = serde_json::json!({"path": "a.txt"});
        let whole = read_fingerprint(&dir, &args).expect("file exists");
        assert_eq!((whole.from, whole.to), (1, 50));
        let mut m = ContextManager::new(100_000);
        assert_eq!(m.unchanged_read(&whole), None);
        m.note_read(whole.clone(), "call1".into(), 3);
        assert_eq!(m.unchanged_read(&whole), Some(3));
        // A range inside what was read is a re-read too...
        let part = read_fingerprint(&dir, &serde_json::json!({"path": "a.txt", "start_line": 10, "end_line": 20})).unwrap();
        assert_eq!(m.unchanged_read(&part), Some(3));
        // ...but not after only a part was read.
        let mut m2 = ContextManager::new(100_000);
        m2.note_read(part.clone(), "c".into(), 1);
        assert_eq!(m2.unchanged_read(&whole), None);
        // A changed file reads again.
        std::fs::write(dir.join("a.txt"), format!("{body}more\n")).unwrap();
        let changed = read_fingerprint(&dir, &args).unwrap();
        assert_eq!(m.unchanged_read(&changed), None);
        // A stubbed earlier result reads again too.
        m.stubbed.insert("call1".into());
        assert_eq!(m.unchanged_read(&whole), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compaction_triggers_at_threshold_and_waits_to_regrow() {
        let mut m = ContextManager::new(10_000);
        let history = vec![Message::user("task")];
        assert_eq!(m.needs_compaction(&history), None, "no usage reported yet");
        m.note_usage(5_000, 1);
        assert_eq!(m.needs_compaction(&history), None);
        m.note_usage(7_500, 1);
        assert!(m.needs_compaction(&history).is_some());
        m.after_compaction(&history, &history);
        assert_eq!(m.needs_compaction(&history), None, "nothing reported since compaction");
        m.note_usage(7_500, 1);
        assert_eq!(m.needs_compaction(&history), None, "static prefix alone must not loop compaction");
        m.note_usage(9_000, 1);
        assert!(m.needs_compaction(&history).is_some());
    }
}
