//! Plain chat (agent mode off) on Rig: the same provider models as the agent
//! (model.rs — OpenAI Responses/Completions, Anthropic, Ollama and the
//! subscription CLIs), without tools. Streams `chat://delta` and
//! `chat://usage` for the chat surface.

use super::{model, AgentRequest};
use crate::chat::{ChatTurn, ChatUsage, ProviderConfig, StreamEvent};
use futures_util::StreamExt;
use rig_agent::agent::{AgentBuilder, MultiTurnStreamItem};
use rig_agent::core::completion::message::{ImageMediaType, Message, UserContent};
use rig_agent::core::streaming::StreamedAssistantContent;
use rig_agent::streaming::StreamingChat;
use serde_json::json;
use tauri::{AppHandle, Emitter};

pub async fn stream(app: &AppHandle, request_id: &str, p: &ProviderConfig, turns: &[ChatTurn]) -> Result<(), String> {
    let req: AgentRequest = serde_json::from_value(json!({
        "kind": p.kind,
        "base_url": p.base_url,
        "api_key": p.api_key,
        "model": p.model,
        "effort": p.effort,
        "max_tokens": p.max_tokens,
        "workspace": "",
        "chat_id": p.chat_id,
    }))
    .map_err(|e| e.to_string())?;
    let setup = model::build(&req)?;
    let mut b = AgentBuilder::from_model_handle(setup.handle).preamble(&p.system).default_max_turns(1);
    if let Some(t) = setup.temperature {
        b = b.temperature(t);
    }
    if let Some(m) = setup.max_tokens {
        b = b.max_tokens(m);
    }
    if let Some(params) = setup.params {
        b = b.additional_params(params);
    }
    let agent = b.build();
    let (history, prompt) = to_messages(p, turns);

    // Provider limits — the permit lives until the stream ends.
    let key = if p.provider_id.is_empty() { p.base_url.clone() } else { p.provider_id.clone() };
    let _permit = crate::limiter::acquire(&key, p.rate_limit_rpm, p.concurrency, request_id).await;
    if crate::cancel::is_requested(request_id) {
        return Err(crate::cancel::STOPPED.to_string());
    }

    let mut stream = agent.stream_chat(prompt, history).await;
    let mut saw_text = false;
    loop {
        let item = tokio::select! {
            it = stream.next() => match it {
                Some(it) => it,
                None => break,
            },
            // Dropping the stream aborts the request (and kills a CLI process).
            _ = crate::cancel::cancel_signal(request_id) => return Err(crate::cancel::STOPPED.to_string()),
        };
        match item.map_err(|e| e.to_string())? {
            MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(t)) if !t.text.is_empty() => {
                saw_text = true;
                delta(app, request_id, t.text);
            }
            MultiTurnStreamItem::CompletionCall(call) => {
                let u = call.usage;
                let _ = app.emit(
                    "chat://usage",
                    ChatUsage {
                        request_id: request_id.to_string(),
                        prompt_tokens: u.input_tokens + u.cache_creation_input_tokens
                            + if p.kind == "anthropic-messages" { u.cached_input_tokens } else { 0 },
                        completion_tokens: u.output_tokens,
                        cached_tokens: u.cached_input_tokens,
                    },
                );
            }
            MultiTurnStreamItem::FinalResponse(resp) if !saw_text && !resp.output.trim().is_empty() => {
                // Non-streaming providers: the answer only arrives here.
                delta(app, request_id, resp.output);
            }
            _ => {}
        }
    }
    Ok(())
}

fn delta(app: &AppHandle, request_id: &str, text: String) {
    let _ = app.emit(
        "chat://delta",
        StreamEvent { request_id: request_id.to_string(), delta: text, done: false },
    );
}

/// Chat turns → Rig history + the last user turn (with images) as the prompt.
fn to_messages(p: &ProviderConfig, turns: &[ChatTurn]) -> (Vec<Message>, Message) {
    let last_user = turns.iter().rposition(|t| t.role != "agent" && t.role != "assistant");
    let mut history = Vec::new();
    let mut prompt = Message::user("");
    for (i, t) in turns.iter().enumerate() {
        if Some(i) == last_user {
            let mut content = vec![UserContent::text(t.text.clone())];
            for img in &p.images {
                let mt = match img.mime.as_str() {
                    "image/png" => Some(ImageMediaType::PNG),
                    "image/jpeg" | "image/jpg" => Some(ImageMediaType::JPEG),
                    "image/gif" => Some(ImageMediaType::GIF),
                    "image/webp" => Some(ImageMediaType::WEBP),
                    _ => None,
                };
                content.push(UserContent::image_base64(crate::chat::base64_body(&img.data_url).to_string(), mt, None));
            }
            prompt = Message::User { content };
        } else if t.role == "agent" || t.role == "assistant" {
            if !t.text.trim().is_empty() {
                history.push(Message::assistant(t.text.clone()));
            }
        } else if !t.text.trim().is_empty() {
            history.push(Message::user(t.text.clone()));
        }
    }
    (history, prompt)
}
