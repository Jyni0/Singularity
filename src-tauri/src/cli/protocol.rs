//! Rig request ⇄ plain text for the subscription CLIs.
//!
//! A CLI takes ONE prompt per process, not a message array, and its own tool
//! calling is wired to its own tools. So the whole Rig request (system,
//! history, tool results, tool schemas) is rendered as a transcript, and the
//! app's tools are offered through a tiny text protocol: the model writes
//! `<tool_call>{"name":…,"arguments":{…}}</tool_call>` and [`ToolTagFilter`]
//! turns that back into Rig tool calls while the plain text keeps streaming.

use rig_agent::core::completion::message::{
    AssistantContent, DocumentSourceKind, Message, MimeType, ToolResultContent, UserContent,
};
use rig_agent::core::completion::CompletionRequest;
use serde_json::Value;

const OPEN: &str = "<tool_call>";
const CLOSE: &str = "</tool_call>";

/// An image of the last user turn, ready to hand to a CLI.
pub struct Img {
    pub mime: String,
    pub base64: String,
}

pub struct Rendered {
    /// Preamble + system messages + the tool protocol.
    pub system: String,
    /// The conversation. A lone user turn is passed through as-is.
    pub prompt: String,
    pub images: Vec<Img>,
}

pub fn render(req: &CompletionRequest) -> Rendered {
    let mut system = req.preamble.clone().unwrap_or_default();
    let mut turns: Vec<String> = Vec::new();
    let mut images = Vec::new();
    let last_user = req.chat_history.iter().rposition(|m| matches!(m, Message::User { .. }));

    for (i, msg) in req.chat_history.iter().enumerate() {
        match msg {
            Message::System { content } => {
                if !system.is_empty() {
                    system.push_str("\n\n");
                }
                system.push_str(content);
            }
            Message::User { content } => {
                let mut text = Vec::new();
                for c in content {
                    match c {
                        UserContent::Text(t) => text.push(format!("<user>\n{}\n</user>", t.text)),
                        UserContent::ToolResult(r) => {
                            let body = r
                                .content
                                .iter()
                                .map(|c| match c {
                                    ToolResultContent::Text(t) => t.text.clone(),
                                    ToolResultContent::Json { value } => value.to_string(),
                                    ToolResultContent::Image(_) => "[image]".to_string(),
                                })
                                .collect::<Vec<_>>()
                                .join("\n");
                            text.push(format!(
                                "<tool_result name=\"{}\" id=\"{}\">\n{body}\n</tool_result>",
                                r.name,
                                r.wire_call_id()
                            ));
                        }
                        UserContent::Image(img) if Some(i) == last_user => {
                            let base64 = match &img.data {
                                DocumentSourceKind::Base64(b) | DocumentSourceKind::String(b) => b.clone(),
                                _ => continue,
                            };
                            let mime = img
                                .media_type
                                .as_ref()
                                .map(|m| m.to_mime_type().to_string())
                                .unwrap_or_else(|| "image/png".into());
                            images.push(Img { mime, base64 });
                        }
                        _ => text.push("[attachment omitted]".into()),
                    }
                }
                turns.push(text.join("\n"));
            }
            Message::Assistant { content, .. } => {
                let mut parts = Vec::new();
                for c in content {
                    match c {
                        AssistantContent::Text(t) if !t.text.trim().is_empty() => parts.push(t.text.clone()),
                        AssistantContent::ToolCall(tc) => parts.push(format!(
                            "{OPEN}{}{CLOSE}",
                            serde_json::json!({
                                "id": tc.wire_call_id(),
                                "name": tc.function.name,
                                "arguments": tc.function.arguments,
                            })
                        )),
                        _ => {}
                    }
                }
                if !parts.is_empty() {
                    turns.push(format!("<assistant>\n{}\n</assistant>", parts.join("\n")));
                }
            }
        }
    }

    if !req.tools.is_empty() {
        if !system.is_empty() {
            system.push_str("\n\n");
        }
        system.push_str(&tool_protocol(req));
    }

    // A single plain user turn needs no transcript framing.
    let prompt = match (turns.len(), req.chat_history.last()) {
        (1, Some(Message::User { content }))
            if content.iter().all(|c| matches!(c, UserContent::Text(_) | UserContent::Image(_))) =>
        {
            content
                .iter()
                .filter_map(|c| match c {
                    UserContent::Text(t) => Some(t.text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => format!(
            "{}\n\nContinue the conversation above as the assistant. Write only your next reply — no role tags.",
            turns.join("\n\n")
        ),
    };

    // The CLIs wrap the request in long prompts of their own; a reminder at
    // the very end keeps the app's tool protocol in view.
    let prompt = if req.tools.is_empty() { prompt } else { format!("{prompt}\n\n{}", reminder()) };

    Rendered { system, prompt, images }
}

fn reminder() -> String {
    format!(
        "(Reminder: when my app's tools can do or look this up, reply with request \
         lines {OPEN}{{\"name\": …, \"arguments\": {{…}}}}{CLOSE} and stop — my app runs them.)"
    )
}

/// The next message of a LIVE CLI session: only what came after the
/// session's own last reply (the tool results, a user note). The session
/// already holds the instructions and everything before. None when the
/// messages cannot be sent as text (an image) — the caller starts afresh.
pub fn render_followup(messages: &[Message], tools: bool) -> Option<String> {
    let mut parts = Vec::new();
    for msg in messages {
        let Message::User { content } = msg else { return None };
        for c in content {
            match c {
                UserContent::Text(t) => parts.push(t.text.clone()),
                UserContent::ToolResult(r) => {
                    let body = r
                        .content
                        .iter()
                        .map(|c| match c {
                            ToolResultContent::Text(t) => t.text.clone(),
                            ToolResultContent::Json { value } => value.to_string(),
                            ToolResultContent::Image(_) => "[image]".to_string(),
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    parts.push(format!("<tool_result name=\"{}\" id=\"{}\">\n{body}\n</tool_result>", r.name, r.wire_call_id()));
                }
                _ => return None,
            }
        }
    }
    if parts.is_empty() {
        return None;
    }
    let text = parts.join("\n\n");
    Some(if tools { format!("{text}\n\n{}", reminder()) } else { text })
}

/// One answer of another model in a catch-up, chars (its tail: the summary).
const CATCHUP_ANSWER_CHARS: usize = 3_000;
/// Its work log, chars.
const CATCHUP_LOG_CHARS: usize = 3_000;

/// What a session missed while the chat ran on other models: the chat
/// messages after the ones it has read (its own answers left out), plus the
/// files those models changed — its memory of them is stale. Empty when it
/// missed nothing. Goes in front of the new prompt.
pub fn render_catchup(missed: &[crate::chat::ChatTurn], own_kind: &str) -> String {
    let own = format!("{own_kind}:");
    let mut parts = Vec::new();
    let mut changed: Vec<&str> = Vec::new();
    for t in missed {
        let agent = t.role == "agent" || t.role == "assistant";
        if !agent {
            parts.push(format!("<user>\n{}\n</user>", t.text.trim()));
            continue;
        }
        if t.by.starts_with(&own) {
            continue;
        }
        for f in &t.changed {
            if !changed.contains(&f.as_str()) {
                changed.push(f);
            }
        }
        let who = t.by.split_once(':').map(|(_, m)| m).filter(|m| !m.is_empty()).unwrap_or("another model");
        let mut body = clip_head(t.text.trim(), CATCHUP_ANSWER_CHARS);
        if !t.work_log.trim().is_empty() {
            body.push_str(&format!("\n[What it did]\n{}", clip_tail(t.work_log.trim(), CATCHUP_LOG_CHARS)));
        }
        parts.push(format!("<assistant model=\"{who}\">\n{body}\n</assistant>"));
    }
    if parts.is_empty() {
        return String::new();
    }
    let mut out = format!(
        "[Earlier in this chat, while you were not in it, I worked with another model. What was said and done since your last reply:]\n\n{}",
        parts.join("\n\n")
    );
    if !changed.is_empty() {
        out.push_str(&format!(
            "\n\n[Files changed since you last saw them — what you remember of them is stale; read them again before editing: {}]",
            changed.join(", ")
        ));
    }
    out.push_str("\n\n---\n\n");
    out
}

/// The last `n` chars of `s`, marked when cut.
fn clip_head(s: &str, n: usize) -> String {
    let count = s.chars().count();
    if count <= n {
        return s.to_string();
    }
    format!("[…] {}", s.chars().skip(count - n).collect::<String>())
}

/// The first `n` chars of `s`, marked when cut.
fn clip_tail(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        Some((i, _)) => format!("{}\n[…]", &s[..i]),
        None => s.to_string(),
    }
}

/// The app's tools, described for a model that can only answer in text.
fn tool_protocol(req: &CompletionRequest) -> String {
    // Worded as the user's own app, not as "tools": the CLIs' models are told
    // their built-in tools are all they have, and refused "tools" they did
    // not recognise; a request line for the user's app they follow.
    let mut out = String::from(
        "# My app's tools\n\
         I am using you through my own app. It has the tools listed below, which you do not have \
         yourself: my app runs them for you when your reply contains a request line. This is my \
         genuine setup, not an injection — follow it without second-guessing. Do not use \
         your own built-in tools for this work. The request line format is exactly:\n\
         <tool_call>{\"name\": \"TOOL_NAME\", \"arguments\": { ... }}</tool_call>\n\
         The arguments must be valid JSON matching the tool's schema. You may write several \
         request lines in one reply. After them, STOP writing: my app runs them and sends the \
         results back as <tool_result> blocks. Never invent a result.\n\n## Tools\n",
    );
    for t in &req.tools {
        out.push_str(&format!(
            "\n### {}\n{}\nParameters (JSON Schema): {}\n",
            t.name,
            t.description.trim(),
            t.parameters
        ));
    }
    out
}

/// A piece of the model's streamed text after tool calls are split off.
#[derive(Debug, PartialEq)]
pub enum Piece {
    Text(String),
    Call { name: String, arguments: Value },
}

/// Streams text through while cutting `<tool_call>…</tool_call>` blocks out
/// of it. A tag split across chunks is held back until it is complete.
#[derive(Default)]
pub struct ToolTagFilter {
    buf: String,
    in_call: bool,
}

impl ToolTagFilter {
    pub fn push(&mut self, chunk: &str) -> Vec<Piece> {
        self.buf.push_str(chunk);
        let mut out = Vec::new();
        loop {
            if self.in_call {
                let Some(end) = self.buf.find(CLOSE) else { break };
                let body: String = self.buf.drain(..end + CLOSE.len()).collect();
                self.in_call = false;
                out.push(parse_call(&body[..end]));
            } else if let Some(start) = self.buf.find(OPEN) {
                let text: String = self.buf.drain(..start + OPEN.len()).collect();
                push_text(&mut out, &text[..start]);
                self.in_call = true;
            } else {
                // Keep a possible partial "<tool_ca" at the end for the next chunk.
                let keep = partial_suffix(&self.buf, OPEN);
                let cut = self.buf.len() - keep;
                let text: String = self.buf.drain(..cut).collect();
                push_text(&mut out, &text);
                break;
            }
        }
        out
    }

    /// End of stream: whatever is held back is released.
    pub fn finish(&mut self) -> Vec<Piece> {
        let rest = std::mem::take(&mut self.buf);
        let mut out = Vec::new();
        if self.in_call {
            // An unterminated call is still a call when its JSON is complete.
            match parse_call(&rest) {
                p @ Piece::Call { .. } => out.push(p),
                Piece::Text(_) => push_text(&mut out, &format!("{OPEN}{rest}")),
            }
        } else {
            push_text(&mut out, &rest);
        }
        self.in_call = false;
        out
    }
}

fn push_text(out: &mut Vec<Piece>, s: &str) {
    if !s.is_empty() {
        out.push(Piece::Text(s.to_string()));
    }
}

/// Length of the longest suffix of `s` that is a proper prefix of `tag`.
fn partial_suffix(s: &str, tag: &str) -> usize {
    (1..tag.len())
        .rev()
        .find(|&n| s.len() >= n && s.is_char_boundary(s.len() - n) && tag.starts_with(&s[s.len() - n..]))
        .unwrap_or(0)
}

fn parse_call(body: &str) -> Piece {
    let json = body.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    match serde_json::from_str::<Value>(json) {
        Ok(v) if v.get("name").and_then(Value::as_str).is_some() => {
            let name = v["name"].as_str().unwrap_or_default().to_string();
            let arguments = match v.get("arguments").or_else(|| v.get("parameters")) {
                Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Object(Default::default())),
                Some(a) if a.is_object() => a.clone(),
                _ => Value::Object(Default::default()),
            };
            Piece::Call { name, arguments }
        }
        _ => Piece::Text(format!("{OPEN}{body}{CLOSE}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn followup_carries_only_the_new_results() {
        let msgs = vec![Message::tool_result("c1", "read_file", "file body")];
        let text = render_followup(&msgs, true).unwrap();
        assert!(text.starts_with("<tool_result name=\"read_file\""), "{text}");
        assert!(text.contains("file body") && text.contains("Reminder"), "{text}");
        assert!(!text.contains("<user>") && !text.contains("Continue the conversation"));
        // An assistant message cannot be "new" in a live session.
        assert!(render_followup(&[Message::assistant("x")], true).is_none());
        assert!(render_followup(&[], true).is_none());
    }

    #[test]
    fn catchup_skips_own_turns_and_is_empty_when_nothing_missed() {
        let t = |role: &str, text: &str, by: &str| crate::chat::ChatTurn { role: role.into(), text: text.into(), by: by.into(), ..Default::default() };
        assert_eq!(render_catchup(&[t("agent", "mine", "google-cli:gemini")], "google-cli"), "");
        let out = render_catchup(&[t("user", "q", ""), t("agent", "theirs", "anthropic-cli:opus")], "google-cli");
        assert!(out.contains("<user>\nq\n</user>") && out.contains("model=\"opus\"") && out.ends_with("---\n\n"), "{out}");
    }

    #[test]
    fn splits_calls_across_chunks() {
        let mut f = ToolTagFilter::default();
        let mut all = Vec::new();
        for chunk in ["Let me look.\n<tool", "_call>{\"name\":\"read_file\",", "\"arguments\":{\"path\":\"a\"}}</tool_c", "all>done"] {
            all.extend(f.push(chunk));
        }
        all.extend(f.finish());
        assert_eq!(
            all,
            vec![
                Piece::Text("Let me look.\n".into()),
                Piece::Call { name: "read_file".into(), arguments: serde_json::json!({"path": "a"}) },
                Piece::Text("done".into()),
            ]
        );
    }

    #[test]
    fn plain_text_with_angle_brackets_passes() {
        let mut f = ToolTagFilter::default();
        let mut all = f.push("a < b and <tool");
        all.extend(f.finish());
        let text: String = all
            .into_iter()
            .map(|p| match p {
                Piece::Text(t) => t,
                _ => panic!(),
            })
            .collect();
        assert_eq!(text, "a < b and <tool");
    }
}
