/// Real model inference.
///
/// Sends a chat request to the configured provider and streams the answer back
/// to the UI token by token:
///
/// * `google` — Gemini `generateContent` with `alt=sse` (API key / Google OAuth)
/// * everything else — Rig (agent/plain.rs): OpenAI Responses / Completions,
///   Anthropic Messages, Ollama and the subscription CLIs (cli/)
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Who wrote a turn in the conversation being sent to the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatTurn {
    pub role: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamEvent {
    pub request_id: String,
    /// Incremental text; concatenating every delta yields the full answer.
    pub delta: String,
    /// True on the final event of a successful stream.
    pub done: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamError {
    pub request_id: String,
    pub message: String,
}

/* ---------- Provider description ---------- */

#[derive(Debug, Clone, Deserialize)]
pub struct ProviderConfig {
    /// `google`, `openai`, `openai-compatible` or `ollama`.
    pub kind: String,
    pub base_url: String,
    /// Either an API key or an OAuth access token, depending on `auth`.
    #[serde(default)]
    pub api_key: String,
    /// `key` (query/header API key) or `bearer` (OAuth access token).
    #[serde(default = "default_auth")]
    pub auth: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub system: String,
    /// `low`, `medium`, `high` — mapped onto each provider's reasoning knob.
    #[serde(default)]
    pub effort: String,
    /// Images attached to the last user turn.
    #[serde(default)]
    pub images: Vec<ImageAttachment>,
    /// Stable provider id — the key the limiter budgets requests under.
    #[serde(default)]
    pub provider_id: String,
    /// Max requests/minute for this provider (0 = unlimited).
    #[serde(default)]
    pub rate_limit_rpm: usize,
    /// Max parallel in-flight requests (0 = unlimited).
    #[serde(default)]
    pub concurrency: usize,
    /// Longest answer, tokens (API models, set by hand); None = default.
    #[serde(default)]
    pub max_tokens: Option<u64>,
}

/// One attached image, carried as a `data:` URL from the frontend.
#[derive(Debug, Clone, Deserialize)]
pub struct ImageAttachment {
    pub mime: String,
    pub data_url: String,
}

/// Strips the `data:...;base64,` prefix, returning the raw base64 body.
pub fn base64_body(data_url: &str) -> &str {
    match data_url.find("base64,") {
        Some(i) => &data_url[i + 7..],
        None => data_url,
    }
}

fn default_auth() -> String {
    "key".to_string()
}

/// Reserves one request slot under the provider's configured limits
/// (RPM + concurrency; 0 = unlimited). Shared with the agent loop, so a
/// parallel decomposed run and a chat stream budget against the same pool.
async fn acquire_permit(
    provider: &ProviderConfig,
    request_id: &str,
) -> crate::limiter::Permit {
    let key = if provider.provider_id.is_empty() {
        provider.base_url.clone()
    } else {
        provider.provider_id.clone()
    };
    crate::limiter::acquire(&key, provider.rate_limit_rpm, provider.concurrency, request_id).await
}

/// Gemini thinking budget in tokens, or None to leave the default.
fn thinking_budget(effort: &str) -> Option<i64> {
    match effort {
        "low" => Some(256),
        "high" => Some(8192),
        _ => None,
    }
}


/// Token usage of a chat stream, pushed to the Debug HUD (chat://usage).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ChatUsage {
    pub request_id: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cached_tokens: u64,
}

fn emit_usage(app: &AppHandle, u: &ChatUsage) {
    let _ = app.emit("chat://usage", u);
}
/* ---------- Public entry point ---------- */

/// Streams a completion, emitting `chat://delta`, `chat://done` and
/// `chat://error` events tagged with `request_id`.
pub async fn stream_chat(
    app: AppHandle,
    request_id: String,
    provider: ProviderConfig,
    turns: Vec<ChatTurn>,
) -> Result<(), String> {
    let result = match provider.kind.as_str() {
        "google" => stream_google(&app, &request_id, &provider, &turns).await,
        _ => crate::agent::stream_plain(&app, &request_id, &provider, &turns).await,
    };

    match result {
        Ok(()) => {
            let _ = app.emit(
                "chat://done",
                StreamEvent {
                    request_id,
                    delta: String::new(),
                    done: true,
                },
            );
            Ok(())
        }
        Err(e) => {
            crate::cancel::clear(&request_id);
            let _ = app.emit(
                "chat://error",
                StreamError {
                    request_id,
                    message: e.clone(),
                },
            );
            Err(e)
        }
    }
}

/* ---------- Google Gemini ---------- */

#[derive(Deserialize)]
struct GeminiStreamChunk {
    candidates: Option<Vec<GeminiCandidate>>,
    #[serde(rename = "promptFeedback")]
    prompt_feedback: Option<GeminiPromptFeedback>,
    /// Cumulative token counts — the final chunk carries the totals.
    #[serde(rename = "usageMetadata")]
    usage_metadata: Option<GeminiUsage>,
}

#[derive(Deserialize)]
struct GeminiUsage {
    #[serde(rename = "promptTokenCount", default)]
    prompt_token_count: u64,
    #[serde(rename = "candidatesTokenCount", default)]
    candidates_token_count: u64,
    #[serde(rename = "cachedContentTokenCount", default)]
    cached_content_token_count: u64,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiContent>,
    #[serde(rename = "finishReason")]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct GeminiContent {
    parts: Option<Vec<GeminiPart>>,
}

#[derive(Deserialize)]
struct GeminiPart {
    text: Option<String>,
}

#[derive(Deserialize)]
struct GeminiPromptFeedback {
    #[serde(rename = "blockReason")]
    block_reason: Option<String>,
}

async fn stream_google(
    app: &AppHandle,
    request_id: &str,
    provider: &ProviderConfig,
    turns: &[ChatTurn],
) -> Result<(), String> {
    let base = provider.base_url.trim_end_matches('/');
    let model = if provider.model.is_empty() {
        "gemini-2.0-flash".to_string()
    } else {
        provider.model.clone()
    };

    // Build the `contents` array: Gemini calls the assistant role "model".
    // Images ride along on the final user turn as `inlineData` parts.
    let last_user = turns
        .iter()
        .rposition(|t| t.role != "agent" && t.role != "assistant");
    let contents: Vec<serde_json::Value> = turns
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let role = if t.role == "agent" || t.role == "assistant" {
                "model"
            } else {
                "user"
            };
            let mut parts = vec![serde_json::json!({ "text": t.text })];
            if Some(i) == last_user {
                for img in &provider.images {
                    parts.push(serde_json::json!({
                        "inlineData": {
                            "mimeType": img.mime,
                            "data": base64_body(&img.data_url),
                        }
                    }));
                }
            }
            serde_json::json!({ "role": role, "parts": parts })
        })
        .collect();

    let mut body = serde_json::json!({ "contents": contents });
    if !provider.system.trim().is_empty() {
        body["systemInstruction"] =
            serde_json::json!({ "parts": [{ "text": provider.system }] });
    }
    // Effort maps onto Gemini's thinking budget: more tokens = deeper reasoning.
    if let Some(budget) = thinking_budget(&provider.effort) {
        body["generationConfig"] = serde_json::json!({
            "thinkingConfig": { "thinkingBudget": budget }
        });
    }

    // An OAuth token goes in the Authorization header; an API key in `?key=`.
    let url = if provider.auth == "bearer" {
        format!("{base}/v1beta/models/{model}:streamGenerateContent?alt=sse")
    } else {
        format!(
            "{base}/v1beta/models/{model}:streamGenerateContent?alt=sse&key={}",
            urlencoding::encode(provider.api_key.trim())
        )
    };

    let mut req = reqwest::Client::new()
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body);
    if provider.auth == "bearer" {
        req = req.bearer_auth(provider.api_key.trim());
    }

    // Provider limits — the permit lives until the stream finishes below.
    // Gemini caches common prefixes implicitly; nothing to send client-side.
    let _permit = acquire_permit(provider, request_id).await;
    if crate::cancel::is_requested(request_id) {
        return Err(crate::cancel::STOPPED.to_string());
    }
    // Stop interrupts the send immediately instead of waiting for the wire.
    let res = tokio::select! {
        r = req.send() => r.map_err(|e| format!("request failed: {e}"))?,
        _ = crate::cancel::cancel_signal(request_id) => {
            return Err(crate::cancel::STOPPED.to_string());
        }
    };
    let status = res.status();
    if !status.is_success() {
        let detail = res.text().await.unwrap_or_default();
        return Err(format!("Gemini returned {status}: {}", trim_error(&detail)));
    }

    let mut stream = res.bytes_stream();
    // Incremental UTF-8: a chunk boundary must not split a multi-byte char
    // (Cyrillic/emoji in streamed answers must arrive intact).
    let mut decoder = crate::utf8stream::StreamDecoder::new();
    let mut buf = String::new();
    let mut saw_text = false;

    loop {
        // The Stop button aborts IMMEDIATELY — the cancel signal races the
        // next chunk instead of waiting for the provider to emit one.
        let chunk = tokio::select! {
            c = stream.next() => match c {
                Some(c) => c,
                None => break,
            },
            _ = crate::cancel::cancel_signal(request_id) => {
                return Err(crate::cancel::STOPPED.to_string());
            }
        };
        let bytes = chunk.map_err(|e| format!("stream error: {e}"))?;
        buf.push_str(&decoder.push(&bytes));

        // SSE frames are separated by a blank line.
        while let Some(idx) = buf.find("\n\n") {
            let frame = buf[..idx].to_string();
            buf.drain(..idx + 2);
            for line in frame.lines() {
                let Some(data) = line.strip_prefix("data: ") else {
                    continue;
                };
                if data.trim() == "[DONE]" {
                    return Ok(());
                }
                let Ok(parsed) = serde_json::from_str::<GeminiStreamChunk>(data) else {
                    continue;
                };
                if let Some(fb) = parsed.prompt_feedback {
                    if let Some(reason) = fb.block_reason {
                        return Err(format!("prompt blocked by Gemini ({reason})"));
                    }
                }
                // DEBUG HUD: Gemini reports cumulative usage; the totals ride
                // on the final chunk (the one with a finishReason).
                if let Some(u) = parsed.usage_metadata.as_ref() {
                    if parsed.candidates.as_ref().and_then(|c| c.first()).and_then(|c| c.finish_reason.as_deref()).is_some() {
                        emit_usage(app, &ChatUsage {
                            request_id: request_id.to_string(),
                            prompt_tokens: u.prompt_token_count,
                            completion_tokens: u.candidates_token_count,
                            cached_tokens: u.cached_content_token_count,
                        });
                    }
                }
                if let Some(cands) = parsed.candidates {
                    for c in cands {
                        if let Some(parts) = c.content.and_then(|x| x.parts) {
                            for p in parts {
                                if let Some(text) = p.text {
                                    if !text.is_empty() {
                                        saw_text = true;
                                        emit_delta(app, request_id, text);
                                    }
                                }
                            }
                        }
                        // A safety stop with no text needs surfacing, or the UI
                        // would just hang on an empty answer.
                        if !saw_text && c.finish_reason.as_deref() == Some("SAFETY") {
                            return Err("Gemini stopped the response on a safety filter".into());
                        }
                    }
                }
            }
        }
    }

    Ok(())
}


/* ---------- Helpers ---------- */

fn emit_delta(app: &AppHandle, request_id: &str, delta: String) {
    let _ = app.emit(
        "chat://delta",
        StreamEvent {
            request_id: request_id.to_string(),
            delta,
            done: false,
        },
    );
}

/// Shortens a provider error body so it fits in a toast.
fn trim_error(body: &str) -> String {
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.len() > 400 {
        format!("{}…", &compact[..400])
    } else if compact.is_empty() {
        "empty response".into()
    } else {
        compact
    }
}
