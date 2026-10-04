//! Auto-compaction: when a run's history nears the context window, the
//! older steps are summarized by the same model into one
//! `SummaryOfPreviousSteps` message; the most recent steps stay verbatim.
//!
//! The summary request carries the old steps as plain text (no tool_use
//! blocks): some providers reject tool blocks in a request without tools.

use super::one_line;
use rig_agent::core::completion::message::{AssistantContent, Message, ToolResultContent, UserContent};
use rig_agent::core::completion::{CompletionModel, CompletionRequest};

/// Model turns kept verbatim after the summary.
const KEEP_TURNS: usize = 2;
/// Heads the summary message.
pub(in crate::agent) const SUMMARY_MARKER: &str = "[SummaryOfPreviousSteps — earlier steps of this task were compacted to save context]";
/// Longest single entry of the transcript sent for summarizing.
const ENTRY_CHARS: usize = 2_000;
const SUMMARY_MAX_TOKENS: u64 = 2_048;

const SUMMARIZER: &str = "You compress the transcript of a coding agent's work so it can continue without the full history. \
Write a dense factual summary in English, at most ~600 words, with these headings:\n\
Goal — what the user asked for.\n\
Done — what was changed, created or verified (exact file paths, commands, key results).\n\
Findings — facts learned that are still needed (paths, APIs, error messages, decisions).\n\
Open — what remains to do and any blocker.\n\
No preamble, no advice, no code blocks longer than 5 lines.";

/// Index where the verbatim tail starts: the KEEP_TURNS-th assistant
/// message from the end. None when there is too little to summarize.
pub(in crate::agent) fn split_point(history: &[Message]) -> Option<usize> {
    let assistants: Vec<usize> = history
        .iter()
        .enumerate()
        .filter(|(_, m)| matches!(m, Message::Assistant { .. }))
        .map(|(i, _)| i)
        .collect();
    let at = *assistants.get(assistants.len().checked_sub(KEEP_TURNS)?)?;
    // Something worth summarizing must precede it (more than the task).
    (at >= 2).then_some(at)
}

/// The old steps as plain text for the summarizer.
pub(in crate::agent) fn render_transcript(head: &[Message]) -> String {
    let mut out = String::new();
    let clip = |s: &str| {
        if s.chars().count() <= ENTRY_CHARS {
            s.to_string()
        } else {
            format!("{}… [clipped]", s.chars().take(ENTRY_CHARS).collect::<String>())
        }
    };
    for m in head {
        match m {
            Message::System { .. } => {}
            Message::User { content } => {
                for c in content {
                    match c {
                        UserContent::Text(t) => out.push_str(&format!("USER: {}\n\n", clip(&t.text))),
                        UserContent::ToolResult(r) => {
                            let text: String = r
                                .content
                                .iter()
                                .map(|c| match c {
                                    ToolResultContent::Text(t) => t.text.clone(),
                                    ToolResultContent::Json { value } => value.to_string(),
                                    ToolResultContent::Image(_) => "[image]".into(),
                                })
                                .collect();
                            out.push_str(&format!("RESULT of {}: {}\n\n", r.name, clip(&text)));
                        }
                        _ => out.push_str("USER: [attachment]\n\n"),
                    }
                }
            }
            Message::Assistant { content, .. } => {
                for c in content {
                    match c {
                        AssistantContent::Text(t) if !t.text.trim().is_empty() => {
                            out.push_str(&format!("AGENT: {}\n\n", clip(&t.text)))
                        }
                        AssistantContent::ToolCall(tc) => out.push_str(&format!(
                            "CALL {}({})\n\n",
                            tc.function.name,
                            one_line(&tc.function.arguments.to_string(), 300)
                        )),
                        _ => {}
                    }
                }
            }
        }
    }
    out
}

/// Asks the model for the summary of `head`.
pub(in crate::agent) async fn summarize<M: CompletionModel>(model: &M, head: &[Message]) -> Result<String, String> {
    let request = CompletionRequest {
        model: None,
        preamble: None,
        chat_history: vec![
            Message::system(SUMMARIZER),
            Message::user(format!("Transcript to summarize:\n\n{}", render_transcript(head))),
        ],
        documents: Vec::new(),
        tools: Vec::new(),
        temperature: None,
        max_tokens: Some(SUMMARY_MAX_TOKENS),
        tool_choice: None,
        additional_params: None,
        output_schema: None,
        record_telemetry_content: false,
    };
    let resp = model.completion(request).await.map_err(|e| e.to_string())?;
    let text: String = resp
        .choice
        .iter()
        .filter_map(|c| match c {
            AssistantContent::Text(t) => Some(t.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        return Err("the model returned an empty summary".into());
    }
    Ok(text)
}

/// The compacted history: the summary (with the task verbatim) as the
/// first user message, then the tail. The tail starts on an assistant
/// message, so user/assistant still alternate and every tool_use keeps its
/// tool_result.
pub(in crate::agent) fn rebuild(task: &str, summary: &str, tail: &[Message]) -> Vec<Message> {
    let head = format!(
        "{SUMMARY_MARKER}\n\nOriginal request:\n{task}\n\nSummary of the steps so far:\n{}\n\nContinue the task from here.",
        summary.trim()
    );
    let mut out = vec![Message::user(head)];
    out.extend_from_slice(tail);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn history(turns: usize) -> Vec<Message> {
        let mut h = vec![Message::user("fix the bug")];
        for i in 0..turns {
            h.push(Message::assistant(format!("step {i}")));
            h.push(Message::tool_result(format!("c{i}"), "read_file", format!("content {i}")));
        }
        h
    }

    #[test]
    fn split_keeps_the_last_turns() {
        let h = history(5);
        let at = split_point(&h).unwrap();
        assert!(matches!(h[at], Message::Assistant { .. }));
        assert_eq!(h.len() - at, KEEP_TURNS * 2);
        assert_eq!(split_point(&history(2)), None, "only the task precedes the tail");
    }

    #[test]
    fn rebuilt_history_alternates_and_carries_the_task() {
        let h = history(5);
        let at = split_point(&h).unwrap();
        let out = rebuild("fix the bug", "did things", &h[at..]);
        assert!(matches!(out[0], Message::User { .. }));
        assert!(matches!(out[1], Message::Assistant { .. }));
        let first = serde_json::to_string(&out[0]).unwrap();
        assert!(first.contains(SUMMARY_MARKER) && first.contains("fix the bug") && first.contains("did things"));
    }

    #[test]
    fn transcript_is_plain_text() {
        let t = render_transcript(&history(2));
        assert!(t.contains("USER: fix the bug") && t.contains("AGENT: step 0") && t.contains("RESULT of read_file: content 1"));
    }
}
