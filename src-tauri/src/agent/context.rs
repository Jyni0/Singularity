//! Context pruning - keeps the outgoing request inside the token budget
//! without losing the task spec (USER messages) or the current work state.

use serde_json::{json, Value};

/* ---------- Context pruning ----------
   Every round re-checks the outgoing context and shrinks OLD material so the
   request stays small (~2–3k tokens ⇒ fast TTFT):
   * the last KEEP_RECENT messages survive untouched — they carry the current
     task state and the code actually being worked on;
   * older tool outputs and long texts collapse into one-line markers;
   * if that is not enough, the oldest assistant→tool-result PAIRS are dropped
     together (never split — both protocols require them paired);
   * system prompt and image parts are never touched. */

/// Budget in ESTIMATED tokens (~4 chars/token) for the whole message list.
/// 16k fits comfortably in every modern model's window and keeps REAL chat
/// context alive — the old 2.8k budget made the agent forget the conversation
/// it was having (the user-visible "не держит контекст" bug).
const CONTEXT_BUDGET_TOKENS: usize = 16_000;
/// Most recent messages survive as the "current task state" — but even they
/// get tail-clipped when oversized (KEEP_TOOL_CHARS / KEEP_TEXT_CHARS below),
/// so one giant tool output can never blow the budget by itself.
const KEEP_RECENT: usize = 12;
/// Old tool output above this length collapses to a one-line marker.
const PRUNE_TOOL_CHARS: usize = 400;
/// Old assistant text above this length gets truncated.
const PRUNE_TEXT_CHARS: usize = 800;
/// RECENT tool output is clipped to this many chars, keeping the TAIL — that
/// is where build errors and the ~20 lines of code being worked on live.
const KEEP_TOOL_CHARS: usize = 8_000;
/// Recent assistant prose clip — the task state stays, novels do not.
const KEEP_TEXT_CHARS: usize = 2_400;
/// USER messages (the task spec) are never cut below this — losing the
/// original requirements mid-run looked like "no context" to the user.
const USER_KEEP_CHARS: usize = 12_000;

/// Keeps only the LAST keep_chars characters (prefixed by an elision mark).
fn clip_head(s: &str, keep_chars: usize) -> String {
    let n = s.chars().count();
    if n <= keep_chars {
        return s.to_string();
    }
    let tail: String = s.chars().skip(n - keep_chars).collect();
    format!("[head pruned] {tail}")
}

fn est_tokens(msgs: &[Value]) -> usize {
    // Rough but stable: serialized JSON chars / 4.
    msgs.iter().map(|m| serde_json::to_string(m).map(|s| s.len() / 4).unwrap_or(0)).sum()
}

pub(super) fn one_line(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c == '\n' { ' ' } else { c }).collect();
    let flat = flat.trim();
    if flat.chars().count() <= max {
        flat.to_string()
    } else {
        flat.chars().take(max).collect::<String>() + "…[pruned]"
    }
}

/// Shrinks one OpenAI-shaped message in place (stage 1). Returns true when it
/// actually shrank something.
fn shrink_openai_msg(m: &mut Value) -> bool {
    let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("");
    match role {
        "tool" => {
            if let Some(s) = m.get("content").and_then(|v| v.as_str()).map(str::to_string) {
                if s.len() > PRUNE_TOOL_CHARS {
                    m["content"] = json!(format!("[pruned] {}", one_line(&s, 80)));
                    return true;
                }
            }
            false
        }
        "assistant" => {
            let mut changed = false;
            // Text content collapses when tool_calls ride along (the call
            // names/args are the informative part).
            if m.get("tool_calls").is_some() {
                if m.get("content").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false) {
                    m["content"] = Value::Null;
                    changed = true;
                }
            } else if let Some(s) = m.get("content").and_then(|v| v.as_str()).map(str::to_string) {
                if s.len() > PRUNE_TEXT_CHARS {
                    m["content"] = json!(one_line(&s, PRUNE_TEXT_CHARS));
                    changed = true;
                }
            }
            changed
        }
        "user" => {
            // USER messages are the task spec — the original request with all
            // its requirements must survive pruning intact. Only pathological
            // payloads (a pasted 50k-char log) get clipped, and generously.
            // Cutting these to 480 chars is what made the agent "forget" the
            // task mid-run.
            if let Some(s) = m.get("content").and_then(|v| v.as_str()).map(str::to_string) {
                if s.len() > USER_KEEP_CHARS {
                    m["content"] = json!(one_line(&s, USER_KEEP_CHARS));
                    return true;
                }
            }
            false
        }
        _ => false,
    }
}

/// Tail-clips one RECENT OpenAI-shaped message (stage 1.5). Recent messages
/// keep their END: that is where the current error / code being worked on
/// lives. Plain user turns and images are never touched.
fn clip_recent_openai_msg(m: &mut Value) {
    let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("");
    match role {
        "tool" => {
            if let Some(s) = m.get("content").and_then(|v| v.as_str()).map(str::to_string) {
                if s.len() > KEEP_TOOL_CHARS {
                    m["content"] = json!(clip_head(&s, KEEP_TOOL_CHARS));
                }
            }
        }
        "assistant" => {
            if let Some(s) = m.get("content").and_then(|v| v.as_str()).map(str::to_string) {
                if s.len() > KEEP_TEXT_CHARS {
                    m["content"] = json!(clip_head(&s, KEEP_TEXT_CHARS));
                }
            }
        }
        _ => {}
    }
}

/// Tail-clips one RECENT Anthropic-shaped message (stage 1.5).
fn clip_recent_anthropic_msg(m: &mut Value) {
    let Some(parts) = m.get("content").and_then(|v| v.as_array()).cloned() else {
        return;
    };
    let mut changed = false;
    let mut next: Vec<Value> = Vec::new();
    for pt in parts {
        match pt.get("type").and_then(|v| v.as_str()) {
            Some("tool_result") => {
                let mut q = pt.clone();
                if let Some(s) = q.get("content").and_then(|v| v.as_str()).map(str::to_string) {
                    if s.len() > KEEP_TOOL_CHARS {
                        q["content"] = json!(clip_head(&s, KEEP_TOOL_CHARS));
                        changed = true;
                    }
                }
                next.push(q);
            }
            Some("text") => {
                let mut q = pt.clone();
                if let Some(s) = q.get("text").and_then(|v| v.as_str()).map(str::to_string) {
                    if s.len() > KEEP_TEXT_CHARS {
                        q["text"] = json!(clip_head(&s, KEEP_TEXT_CHARS));
                        changed = true;
                    }
                }
                next.push(q);
            }
            _ => next.push(pt),
        }
    }
    if changed {
        m["content"] = Value::Array(next);
    }
}
/// Prunes the OpenAI-shaped history in place. messages[0] (system) is never
/// touched. Returns the estimated token count AFTER pruning.
pub(super) fn prune_openai(messages: &mut Vec<Value>) -> usize {
    if messages.len() < 3 {
        return est_tokens(messages);
    }
    let keep_from = messages.len().saturating_sub(KEEP_RECENT).max(1);

    // Stage 1 — collapse OLD tool outputs and long texts in place.
    for m in messages[1..keep_from].iter_mut() {
        shrink_openai_msg(m);
    }
    // Stage 1.5 — even RECENT messages get tail-clipped when oversized: the
    // current task state is their END (build errors, the code being edited),
    // and one 200KB tool dump must not blow the whole budget.
    for m in messages[keep_from..].iter_mut() {
        clip_recent_openai_msg(m);
    }
    if est_tokens(messages) <= CONTEXT_BUDGET_TOKENS {
        return est_tokens(messages);
    }

    // Stage 2 — drop the oldest assistant(tool_calls)→tool-result PAIRS until
    // under budget. Pairs are dropped together: an orphan tool message or a
    // tool_calls message without results is rejected by strict APIs.
    while est_tokens(messages) > CONTEXT_BUDGET_TOKENS {
        // Recomputed every iteration: each drain shifts the recent window left.
        let keep_from = messages.len().saturating_sub(KEEP_RECENT).max(1);
        // Find the first assistant-with-tool_calls at index >= 1 whose whole
        // run of following tool messages is still older than keep_from.
        let mut victim: Option<(usize, usize)> = None; // (start, end_exclusive)
        let mut i = 1usize;
        while i < messages.len() {
            let is_assistant_calls = messages[i].get("role").and_then(|v| v.as_str()) == Some("assistant")
                && messages[i].get("tool_calls").is_some();
            if is_assistant_calls {
                let mut j = i + 1;
                while j < messages.len()
                    && messages[j].get("role").and_then(|v| v.as_str()) == Some("tool")
                {
                    j += 1;
                }
                if j <= keep_from {
                    victim = Some((i, j));
                    break;
                }
                i = j.max(i + 1);
            } else {
                i += 1;
            }
        }
        let Some((start, end)) = victim else { break };
        messages.drain(start..end);
    }
    est_tokens(messages)
}

/// Shrinks one Anthropic-shaped message in place (stage 1).
fn shrink_anthropic_msg(m: &mut Value) -> bool {
    let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("");
    let Some(parts) = m.get("content").and_then(|v| v.as_array()).cloned() else {
        // String content (plain turns) — collapse long assistant text.
        if role == "assistant" {
            if let Some(s) = m.get("content").and_then(|v| v.as_str()).map(str::to_string) {
                if s.len() > PRUNE_TEXT_CHARS {
                    m["content"] = json!(one_line(&s, PRUNE_TEXT_CHARS));
                    return true;
                }
            }
        }
        return false;
    };
    let mut changed = false;
    let mut next: Vec<Value> = Vec::new();
    for pt in parts {
        match pt.get("type").and_then(|v| v.as_str()) {
            Some("tool_result") => {
                let mut q = pt.clone();
                if let Some(s) = q.get("content").and_then(|v| v.as_str()).map(str::to_string) {
                    if s.len() > PRUNE_TOOL_CHARS {
                        q["content"] = json!(format!("[pruned] {}", one_line(&s, 80)));
                        changed = true;
                    }
                }
                next.push(q);
            }
            Some("text") if role == "assistant" => {
                let mut q = pt.clone();
                if let Some(s) = q.get("text").and_then(|v| v.as_str()).map(str::to_string) {
                    if s.len() > PRUNE_TEXT_CHARS {
                        q["text"] = json!(one_line(&s, PRUNE_TEXT_CHARS));
                        changed = true;
                    }
                }
                next.push(q);
            }
            _ => next.push(pt),
        }
    }
    if changed {
        m["content"] = Value::Array(next);
    }
    changed
}

/// Prunes the Anthropic-shaped history in place. Same policy as OpenAI, but
/// the pairing is assistant(tool_use) followed by user(tool_result blocks).
pub(super) fn prune_anthropic(messages: &mut Vec<Value>) -> usize {
    if messages.len() < 3 {
        return est_tokens(messages);
    }
    let keep_from = messages.len().saturating_sub(KEEP_RECENT).max(1);

    for m in messages[..keep_from].iter_mut() {
        shrink_anthropic_msg(m);
    }
    // Stage 1.5 — tail-clip oversized RECENT messages (same policy as OpenAI).
    for m in messages[keep_from..].iter_mut() {
        clip_recent_anthropic_msg(m);
    }
    if est_tokens(messages) <= CONTEXT_BUDGET_TOKENS {
        return est_tokens(messages);
    }

    // Drop the oldest assistant(tool_use) → user(tool_result) pair while over
    // budget. tool_use/tool_result must stay paired or the API rejects the
    // request.
    while est_tokens(messages) > CONTEXT_BUDGET_TOKENS {
        // Recomputed every iteration: each drain shifts the recent window left.
        let keep_from = messages.len().saturating_sub(KEEP_RECENT).max(1);
        let mut found = false;
        let mut i = 0usize;
        while i + 1 < messages.len() {
            let a_calls = messages[i].get("role").and_then(|v| v.as_str()) == Some("assistant")
                && messages[i]
                    .get("content")
                    .and_then(|v| v.as_array())
                    .map(|ps| ps.iter().any(|q| q.get("type").and_then(|v| v.as_str()) == Some("tool_use")))
                    .unwrap_or(false);
            let u_result = messages[i + 1].get("role").and_then(|v| v.as_str()) == Some("user")
                && messages[i + 1]
                    .get("content")
                    .and_then(|v| v.as_array())
                    .map(|ps| ps.iter().any(|q| q.get("type").and_then(|v| v.as_str()) == Some("tool_result")))
                    .unwrap_or(false);
            if a_calls && u_result && i + 2 <= keep_from {
                messages.drain(i..i + 2);
                found = true;
                break;
            }
            i += 1;
        }
        if !found {
            break;
        }
    }
    est_tokens(messages)
}

/* ---------- Tests ---------- */

#[cfg(test)]
mod prune_tests {
    use super::*;

    fn big(n: usize) -> String {
        "x".repeat(n)
    }

    #[test]
    fn openai_collapses_old_tool_outputs_keeps_recent() {
        let mut messages = vec![json!({ "role": "system", "content": "sys" })];
        // 12 old tool rounds with huge outputs
        for i in 0..12 {
            messages.push(json!({
                "role": "assistant", "content": big(2000),
                "tool_calls": [{ "id": format!("c{i}"), "type": "function", "function": { "name": "read_file", "arguments": "{}" } }]
            }));
            messages.push(json!({ "role": "tool", "tool_call_id": format!("c{i}"), "content": big(8000) }));
        }
        let before = est_tokens(&messages);
        let after = prune_openai(&mut messages);
        assert!(after < before, "pruning must shrink: {before} -> {after}");
        assert!(after <= CONTEXT_BUDGET_TOKENS + 2000, "budget-ish: {after}");
        // System survives untouched
        assert_eq!(messages[0]["content"], "sys");
        // Last KEEP_RECENT messages keep their full content
        let tail = &messages[messages.len() - KEEP_RECENT..];
        assert!(tail.iter().any(|m| m.get("content").and_then(|v| v.as_str()).map(|s| s.len() > 1000).unwrap_or(false)));
        // No orphan tool messages: every tool msg follows an assistant with tool_calls
        for (i, m) in messages.iter().enumerate().skip(1) {
            if m.get("role").and_then(|v| v.as_str()) == Some("tool") {
                let prev = &messages[i - 1];
                assert!(prev.get("role").and_then(|v| v.as_str()) == Some("assistant") || prev.get("role").and_then(|v| v.as_str()) == Some("tool"));
            }
        }
    }

    #[test]
    fn anthropic_drops_paired_blocks_only() {
        let mut messages: Vec<Value> = Vec::new();
        for i in 0..10 {
            messages.push(json!({
                "role": "assistant",
                "content": [{ "type": "tool_use", "id": format!("t{i}"), "name": "read_file", "input": {} },
                            { "type": "text", "text": big(3000) }]
            }));
            messages.push(json!({
                "role": "user",
                "content": [{ "type": "tool_result", "tool_use_id": format!("t{i}"), "content": big(8000) }]
            }));
        }
        let before = est_tokens(&messages);
        let after = prune_anthropic(&mut messages);
        assert!(after < before);
        // Pairing invariant: every tool_use id still has its tool_result
        let uses: Vec<String> = messages.iter().filter_map(|m|
            m.get("content").and_then(|v| v.as_array()).and_then(|ps|
                ps.iter().find(|q| q.get("type").and_then(|v| v.as_str()) == Some("tool_use"))
            ).and_then(|q| q.get("id").and_then(|v| v.as_str()).map(str::to_string))
        ).collect();
        let results: Vec<String> = messages.iter().filter_map(|m|
            m.get("content").and_then(|v| v.as_array()).and_then(|ps|
                ps.iter().find(|q| q.get("type").and_then(|v| v.as_str()) == Some("tool_result"))
            ).and_then(|q| q.get("tool_use_id").and_then(|v| v.as_str()).map(str::to_string))
        ).collect();
        assert_eq!(uses, results, "tool_use and tool_result must stay paired");
    }

    #[test]
    fn user_task_spec_survives_pruning() {
        // The original request (a long multi-requirement spec) must NOT be
        // truncated to a one-liner — that was the "не держит контекст" bug.
        let spec = "requirement line\n".repeat(200); // ~3.6k chars
        let mut messages = vec![json!({ "role": "system", "content": "sys" })];
        messages.push(json!({ "role": "user", "content": spec.clone() }));
        // Pad with old tool rounds so pruning actually engages.
        for i in 0..20 {
            messages.push(json!({
                "role": "assistant", "content": "x".repeat(2000),
                "tool_calls": [{ "id": format!("c{i}"), "type": "function", "function": { "name": "read_file", "arguments": "{}" } }]
            }));
            messages.push(json!({ "role": "tool", "tool_call_id": format!("c{i}"), "content": "y".repeat(8000) }));
        }
        prune_openai(&mut messages);
        let user_text = messages[1]["content"].as_str().unwrap_or("").to_string();
        assert!(
            user_text.len() > spec.len() / 2,
            "task spec must survive: {} -> {}",
            spec.len(),
            user_text.len()
        );
    }

    #[test]
    fn short_history_is_untouched() {
        let mut messages = vec![
            json!({ "role": "system", "content": "sys" }),
            json!({ "role": "user", "content": "hi" }),
        ];
        prune_openai(&mut messages);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["content"], "hi");
    }
}
