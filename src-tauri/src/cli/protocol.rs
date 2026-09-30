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
    /// The same conversation in pieces: `turns` then `tail` (the closing
    /// instructions) — joined with blank lines they are `prompt`. Claude
    /// gets them as separate blocks, so the history before the newest turn
    /// is a stable prefix its prompt cache hits on the next step.
    pub turns: Vec<String>,
    pub tail: String,
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
    let (turns, mut tail) = match (turns.len(), req.chat_history.last()) {
        (1, Some(Message::User { content }))
            if content.iter().all(|c| matches!(c, UserContent::Text(_) | UserContent::Image(_))) =>
        {
            let text = content
                .iter()
                .filter_map(|c| match c {
                    UserContent::Text(t) => Some(t.text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            (vec![text], String::new())
        }
        _ => (
            turns,
            "Continue the conversation above as the assistant. Write only your next reply — no role tags.".to_string(),
        ),
    };

    // The CLIs wrap the request in long prompts of their own; a reminder at
    // the very end keeps the app's tool protocol in view.
    if !req.tools.is_empty() {
        if !tail.is_empty() {
            tail.push_str("\n\n");
        }
        tail.push_str(&format!(
            "(Reminder: when my app's tools can do or look this up, reply with request \
             lines {OPEN}{{\"name\": …, \"arguments\": {{…}}}}{CLOSE} and stop — my app runs them.)"
        ));
    }
    let mut prompt = turns.join("\n\n");
    if !tail.is_empty() {
        prompt.push_str("\n\n");
        prompt.push_str(&tail);
    }

    Rendered { system, prompt, turns, tail, images }
}

/// The app's tools, described for a model that can only answer in text.
fn tool_protocol(req: &CompletionRequest) -> String {
    // Worded as the user's own app, not as "tools": the CLIs' models are told
    // their built-in tools are all they have, and refused "tools" they did
    // not recognise; a request line for the user's app they follow.
    let mut out = String::from(
        "# My app's tools\n\
         I am using you through my own app. It has the tools listed below, which you do not have \
         yourself: my app runs them for you when your reply contains a request line. Do not use \
         your own built-in tools for this work. The request line format is exactly:\n\
         <tool_call>{\"name\": \"TOOL_NAME\", \"arguments\": { ... }}</tool_call>\n\
         The arguments must be valid JSON matching the tool's schema: inside a string write a line \
         break as \\n, a quote as \\\" and a backslash as \\\\ (a diff or file body is ONE JSON \
         string). You may write several request lines in one reply. After them, STOP writing: my \
         app runs them and sends the results back as <tool_result> blocks. Never invent a result.\n\
         Your own built-in tools (shell, apply_patch, file edits) run in a read-only sandbox here: \
         they cannot change my files, and an edit made with them is lost. Every change to my files \
         goes through my app's apply_patch / write_file request lines.\n\n## Tools\n",
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
    /// The next part of a call still being written (its raw JSON text), so
    /// the app can show it live — an edit's file taking shape.
    CallDelta(String),
    Call { name: String, arguments: Value },
}

/// Streams text through while cutting `<tool_call>…</tool_call>` blocks out
/// of it. A tag split across chunks is held back until it is complete.
#[derive(Default)]
pub struct ToolTagFilter {
    buf: String,
    in_call: bool,
    /// Bytes of the open call's body already passed on as CallDelta.
    sent: usize,
}

impl ToolTagFilter {
    pub fn push(&mut self, chunk: &str) -> Vec<Piece> {
        self.buf.push_str(chunk);
        let mut out = Vec::new();
        loop {
            if self.in_call {
                let Some(end) = self.buf.find(CLOSE) else {
                    // Pass on what arrived, minus a possible partial "</tool_ca".
                    let upto = self.buf.len() - partial_suffix(&self.buf, CLOSE);
                    if upto > self.sent {
                        out.push(Piece::CallDelta(self.buf[self.sent..upto].to_string()));
                        self.sent = upto;
                    }
                    break;
                };
                let body: String = self.buf.drain(..end + CLOSE.len()).collect();
                self.in_call = false;
                self.sent = 0;
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
                _ => push_text(&mut out, &format!("{OPEN}{rest}")),
            }
        } else {
            push_text(&mut out, &rest);
        }
        self.in_call = false;
        self.sent = 0;
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
    // Strict first; then the usual slips of a model writing JSON by hand —
    // raw line breaks and bare quotes inside a diff, `C:\path` backslashes,
    // trailing commas. A call that still does not parse reaches the agent
    // as a call carrying the parse error, so the model is told exactly what
    // to fix — as plain text it was "a tool call written as text" and the
    // model went round in circles.
    let parsed = serde_json::from_str::<Value>(json).or_else(|e| serde_json::from_str::<Value>(&repair_json(json)).map_err(|_| e));
    match parsed {
        Ok(v) if v.get("name").and_then(Value::as_str).is_some() => {
            let name = v["name"].as_str().unwrap_or_default().to_string();
            let arguments = match v.get("arguments").or_else(|| v.get("parameters")) {
                Some(Value::String(s)) => serde_json::from_str(s)
                    .or_else(|_| serde_json::from_str(&repair_json(s)))
                    .unwrap_or_else(|e| serde_json::json!({ INVALID_JSON: e.to_string() })),
                Some(a) if a.is_object() => a.clone(),
                _ => Value::Object(Default::default()),
            };
            Piece::Call { name, arguments }
        }
        Err(e) => match call_name(json) {
            Some(name) => Piece::Call { name, arguments: serde_json::json!({ INVALID_JSON: e.to_string() }) },
            None => Piece::Text(format!("{OPEN}{body}{CLOSE}")),
        },
        _ => Piece::Text(format!("{OPEN}{body}{CLOSE}")),
    }
}

/// Argument key of a call whose JSON could not be read; the agent answers
/// such a call with the error instead of running the tool.
pub const INVALID_JSON: &str = "__invalid_json";

/// The tool name of a request line whose JSON is broken.
fn call_name(json: &str) -> Option<String> {
    static NAME: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r#""name"\s*:\s*"([A-Za-z_][\w.-]*)""#).unwrap());
    NAME.captures(json).map(|c| c[1].to_string())
}

/// Best-effort repair of hand-written JSON: inside strings, raw control
/// characters are escaped, a backslash before a non-escape char is doubled,
/// and a quote not followed by `, } ] :` (or the end) is taken as part of
/// the text; outside strings, trailing commas go.
fn repair_json(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len() + 16);
    let mut in_str = false;
    let next_solid = |from: usize| chars[from..].iter().find(|c| !c.is_whitespace()).copied();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if !in_str {
            match c {
                '"' => in_str = true,
                ',' if matches!(next_solid(i + 1), Some('}' | ']')) => {
                    i += 1;
                    continue;
                }
                _ => {}
            }
            out.push(c);
            i += 1;
            continue;
        }
        match c {
            '\\' => match chars.get(i + 1) {
                Some(n @ ('"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't')) => {
                    out.push('\\');
                    out.push(*n);
                    i += 2;
                    continue;
                }
                Some('u') if chars.get(i + 2..i + 6).is_some_and(|h| h.iter().all(|c| c.is_ascii_hexdigit())) => {
                    out.push('\\');
                }
                _ => out.push_str("\\\\"),
            },
            '"' => {
                if matches!(next_solid(i + 1), None | Some(',' | '}' | ']' | ':')) {
                    in_str = false;
                    out.push('"');
                } else {
                    out.push_str("\\\"");
                }
            }
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_calls_across_chunks() {
        let mut f = ToolTagFilter::default();
        let mut all = Vec::new();
        for chunk in ["Let me look.\n<tool", "_call>{\"name\":\"read_file\",", "\"arguments\":{\"path\":\"a\"}}</tool_c", "all>done"] {
            all.extend(f.push(chunk));
        }
        all.extend(f.finish());
        // The call's text streamed as deltas first — without the closing tag.
        let deltas: String = all
            .iter()
            .filter_map(|p| match p {
                Piece::CallDelta(d) => Some(d.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(deltas, "{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}}");
        all.retain(|p| !matches!(p, Piece::CallDelta(_)));
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
    fn hand_written_json_is_repaired() {
        let call = |body: &str| parse_call(body);
        // Raw line breaks, bare quotes and a Windows path inside strings.
        let body = "{\"name\": \"apply_patch\", \"arguments\": {\"path\": \"C:\\src\\a.ts\", \"diff\": \"<<<<<<< SEARCH\nconst a = \"x\";\n=======\nconst a = \"y\";\n>>>>>>> REPLACE\",}}";
        match call(body) {
            Piece::Call { name, arguments } => {
                assert_eq!(name, "apply_patch");
                assert_eq!(arguments["path"], "C:\\src\\a.ts");
                assert_eq!(arguments["diff"], "<<<<<<< SEARCH\nconst a = \"x\";\n=======\nconst a = \"y\";\n>>>>>>> REPLACE");
            }
            other => panic!("{other:?}"),
        }
        // Valid JSON is untouched.
        assert_eq!(
            call("{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\\\"b\"}}"),
            Piece::Call { name: "read_file".into(), arguments: serde_json::json!({"path": "a\"b"}) }
        );
        // Beyond repair: still a call, carrying the error for the model.
        match call("{\"name\": \"write_file\", \"arguments\": {\"path\": [}}") {
            Piece::Call { name, arguments } => {
                assert_eq!(name, "write_file");
                assert!(arguments[INVALID_JSON].is_string());
            }
            other => panic!("{other:?}"),
        }
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
