/// Real model inference.
///
/// Sends a chat request to the configured provider and streams the answer back
/// to the UI token by token. Two wire formats are supported because they cover
/// every provider Singularity can be pointed at:
///
/// * `google` — Gemini `generateContent` with `alt=sse`
/// * everything else — OpenAI-style `POST /chat/completions` with `stream: true`
///   (OpenAI, DeepSeek, OpenRouter, LM Studio, vLLM, Ollama's compatible API…)
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

/// OpenAI-style `reasoning_effort` value, or None when unset.
pub fn reasoning_effort(effort: &str) -> Option<&'static str> {
    match effort {
        "low" => Some("low"),
        "high" => Some("high"),
        // "medium" is the default everywhere, so it does not need sending.
        _ => None,
    }
}

/// Gemini thinking budget in tokens, or None to leave the default.
fn thinking_budget(effort: &str) -> Option<i64> {
    match effort {
        "low" => Some(256),
        "high" => Some(8192),
        _ => None,
    }
}

/// Anthropic extended-thinking budget in tokens, or None to disable thinking.
fn thinking_budget_anthropic(effort: &str) -> Option<u32> {
    match effort {
        "low" => None,
        "high" => Some(8192),
        _ => Some(2048),
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
        "anthropic-messages" => stream_anthropic(&app, &request_id, &provider, &turns).await,
        "openai-responses" => stream_responses(&app, &request_id, &provider, &turns).await,
        _ => stream_openai(&app, &request_id, &provider, &turns).await,
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
    let res = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let detail = res.text().await.unwrap_or_default();
        return Err(format!("Gemini returned {status}: {}", trim_error(&detail)));
    }

    let mut stream = res.bytes_stream();
    let mut buf = String::new();
    let mut saw_text = false;

    while let Some(chunk) = stream.next().await {
        // The Stop button aborts the stream; the UI keeps the partial text.
        if crate::cancel::is_requested(request_id) {
            return Err(crate::cancel::STOPPED.to_string());
        }
        let bytes = chunk.map_err(|e| format!("stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));

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

/* ---------- OpenAI-compatible ---------- */

#[derive(Deserialize)]
struct OpenAiStreamChunk {
    choices: Option<Vec<OpenAiChoice>>,
    error: Option<OpenAiError>,
    /// Final-chunk usage (needs stream_options.include_usage).
    #[serde(default)]
    usage: Option<crate::agent::OpenAiUsage>,
    /// Ollama reports token counts on the top level instead.
    #[serde(default)]
    prompt_eval_count: u64,
    #[serde(default)]
    eval_count: u64,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    delta: Option<OpenAiDelta>,
    #[serde(rename = "finishReason")]
    _finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiDelta {
    content: Option<String>,
    /// Some servers emit reasoning separately; keep it out of the answer body.
    reasoning: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiError {
    message: Option<String>,
}

async fn stream_openai(
    app: &AppHandle,
    request_id: &str,
    provider: &ProviderConfig,
    turns: &[ChatTurn],
) -> Result<(), String> {
    let base = provider.base_url.trim_end_matches('/');
    let model = provider.model.clone();

    let mut messages: Vec<serde_json::Value> = Vec::new();
    if !provider.system.trim().is_empty() {
        messages.push(serde_json::json!({ "role": "system", "content": provider.system }));
    }
    // Images attach to the final user turn as OpenAI-style image_url parts.
    let last_user = turns
        .iter()
        .rposition(|t| t.role != "agent" && t.role != "assistant");
    for (i, t) in turns.iter().enumerate() {
        let role = if t.role == "agent" || t.role == "assistant" {
            "assistant"
        } else {
            "user"
        };
        if Some(i) == last_user && !provider.images.is_empty() {
            let mut parts = vec![serde_json::json!({ "type": "text", "text": t.text })];
            for img in &provider.images {
                parts.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": img.data_url }
                }));
            }
            messages.push(serde_json::json!({ "role": role, "content": parts }));
        } else {
            messages.push(serde_json::json!({ "role": role, "content": t.text }));
        }
    }

    // Ollama speaks its own chat API, which differs from OpenAI only in path.
    let url = if provider.kind == "ollama" {
        format!("{base}/api/chat")
    } else {
        format!("{base}/chat/completions")
    };

    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": true,
    });
    // Ask for the final usage chunk (DEBUG HUD) — OpenAI-compatible only,
    // Ollama reports counts without asking.
    if provider.kind != "ollama" {
        body["stream_options"] = serde_json::json!({ "include_usage": true });
    }
    // Only sent when the user picked something other than the provider default,
    // because many OpenAI-compatible servers reject an unknown `reasoning_effort`.
    if let Some(eff) = reasoning_effort(&provider.effort) {
        body["reasoning_effort"] = serde_json::json!(eff);
    }

    let mut req = reqwest::Client::new()
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body);
    if !provider.api_key.trim().is_empty() {
        req = req.bearer_auth(provider.api_key.trim());
    }

    // Provider limits (RPM/concurrency). OpenAI applies prompt caching
    // automatically to any stable ≥1024-token prefix, so the only client-side
    // requirement is a byte-stable system prompt placed first — which is how
    // the messages above are built.
    let _permit = acquire_permit(provider, request_id).await;
    if crate::cancel::is_requested(request_id) {
        return Err(crate::cancel::STOPPED.to_string());
    }
    let res = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let detail = res.text().await.unwrap_or_default();
        return Err(format!(
            "{} returned {status}: {}",
            provider.kind,
            trim_error(&detail)
        ));
    }

    let mut stream = res.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        // The Stop button aborts the stream; the UI keeps the partial text.
        if crate::cancel::is_requested(request_id) {
            return Err(crate::cancel::STOPPED.to_string());
        }
        let bytes = chunk.map_err(|e| format!("stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(idx) = buf.find('\n') {
            let line = buf[..idx].trim().to_string();
            buf.drain(..idx + 1);
            if line.is_empty() {
                continue;
            }
            let data = line.strip_prefix("data: ").unwrap_or(&line);
            if data == "[DONE]" {
                return Ok(());
            }
            let Ok(parsed) = serde_json::from_str::<OpenAiStreamChunk>(data) else {
                continue;
            };
            if let Some(err) = parsed.error {
                return Err(err.message.unwrap_or_else(|| "provider error".into()));
            }
            // DEBUG HUD: usage on the final chunk (or Ollama's top-level counts).
            if let Some(u) = &parsed.usage {
                emit_usage(app, &ChatUsage {
                    request_id: request_id.to_string(),
                    prompt_tokens: u.prompt_tokens,
                    completion_tokens: u.completion_tokens,
                    cached_tokens: u.prompt_tokens_details.as_ref().map(|d| d.cached_tokens).unwrap_or(0),
                });
            }
            if parsed.prompt_eval_count > 0 || parsed.eval_count > 0 {
                emit_usage(app, &ChatUsage {
                    request_id: request_id.to_string(),
                    prompt_tokens: parsed.prompt_eval_count,
                    completion_tokens: parsed.eval_count,
                    cached_tokens: 0,
                });
            }
            if let Some(choices) = parsed.choices {
                for c in choices {
                    if let Some(delta) = c.delta {
                        if let Some(text) = delta.content {
                            if !text.is_empty() {
                                emit_delta(app, request_id, text);
                            }
                        }
                        let _ = delta.reasoning;
                    }
                }
            }
        }
    }

    Ok(())
}

/* ---------- Anthropic Messages ---------- */

/// SSE events emitted by `POST /messages` with `stream: true`.
/// Only the ones that carry text matter to us.
#[derive(Deserialize)]
struct AnthropicEvent {
    #[serde(rename = "type")]
    kind: Option<String>,
    delta: Option<AnthropicDelta>,
    error: Option<OpenAiError>,
    /// message_start carries input tokens + cache hits; message_delta the output total.
    message: Option<AnthropicMsgUsage>,
    #[serde(default)]
    usage: Option<AnthropicUsageBlock>,
}

#[derive(Deserialize)]
struct AnthropicMsgUsage {
    #[serde(default)]
    usage: Option<AnthropicUsageBlock>,
}

#[derive(Deserialize)]
struct AnthropicUsageBlock {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

#[derive(Deserialize)]
struct AnthropicDelta {
    /// Present on `content_block_delta` events.
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
}

async fn stream_anthropic(
    app: &AppHandle,
    request_id: &str,
    provider: &ProviderConfig,
    turns: &[ChatTurn],
) -> Result<(), String> {
    let base = provider.base_url.trim_end_matches('/');
    let url = format!("{base}/messages");

    let messages: Vec<serde_json::Value> = {
        // Images attach to the final user turn as Anthropic image blocks.
        let last_user = turns
            .iter()
            .rposition(|t| t.role != "agent" && t.role != "assistant");
        turns
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let role = if t.role == "agent" || t.role == "assistant" {
                    "assistant"
                } else {
                    "user"
                };
                if Some(i) == last_user && !provider.images.is_empty() {
                    let mut parts = vec![serde_json::json!({ "type": "text", "text": t.text })];
                    for img in &provider.images {
                        parts.push(serde_json::json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": img.mime,
                                "data": base64_body(&img.data_url),
                            }
                        }));
                    }
                    serde_json::json!({ "role": role, "content": parts })
                } else {
                    serde_json::json!({ "role": role, "content": t.text })
                }
            })
            .collect()
    };

    let mut body = serde_json::json!({
        "model": provider.model,
        "max_tokens": 4096,
        "messages": messages,
        "stream": true,
    });
    // A system prompt goes top-level in Anthropic's protocol — as a block
    // array with an ephemeral cache_control breakpoint: the system prompt is
    // byte-stable across turns, so the provider serves repeat turns from its
    // prompt cache (cheaper input tokens, faster first token).
    if !provider.system.trim().is_empty() {
        body["system"] = serde_json::json!([{
            "type": "text",
            "text": provider.system,
            "cache_control": { "type": "ephemeral" }
        }]);
    }
    // Effort maps onto extended thinking; "low" leaves it off entirely.
    // Anthropic requires max_tokens to exceed budget_tokens, so raise it here.
    if let Some(budget) = thinking_budget_anthropic(&provider.effort) {
        body["thinking"] = serde_json::json!({ "type": "enabled", "budget_tokens": budget });
        body["max_tokens"] = serde_json::json!(budget.max(4096) + 2048);
    }

    let mut req = reqwest::Client::new()
        .post(&url)
        .header("Content-Type", "application/json")
        // Anthropic requires these two headers on every request.
        .header("anthropic-version", "2023-06-01")
        .json(&body);
    if !provider.api_key.trim().is_empty() {
        req = req.header("x-api-key", provider.api_key.trim());
    }

    let _permit = acquire_permit(provider, request_id).await;
    if crate::cancel::is_requested(request_id) {
        return Err(crate::cancel::STOPPED.to_string());
    }
    let res = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let detail = res.text().await.unwrap_or_default();
        return Err(format!("Anthropic returned {status}: {}", trim_error(&detail)));
    }

    let mut stream = res.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        // The Stop button aborts the stream; the UI keeps the partial text.
        if crate::cancel::is_requested(request_id) {
            return Err(crate::cancel::STOPPED.to_string());
        }
        let bytes = chunk.map_err(|e| format!("stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(idx) = buf.find('\n') {
            let line = buf[..idx].trim().to_string();
            buf.drain(..idx + 1);
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            let Ok(parsed) = serde_json::from_str::<AnthropicEvent>(data) else {
                continue;
            };
            if let Some(err) = parsed.error {
                return Err(err.message.unwrap_or_else(|| "provider error".into()));
            }
            // DEBUG HUD: Anthropic usage — input on message_start, output on
            // message_delta (cumulative for the stream).
            if parsed.kind.as_deref() == Some("message_start") {
                if let Some(u) = parsed.message.as_ref().and_then(|m| m.usage.as_ref()) {
                    emit_usage(app, &ChatUsage {
                        request_id: request_id.to_string(),
                        prompt_tokens: u.input_tokens + u.cache_creation_input_tokens,
                        completion_tokens: 0,
                        cached_tokens: u.cache_read_input_tokens,
                    });
                }
            }
            if parsed.kind.as_deref() == Some("message_delta") {
                if let Some(u) = parsed.usage.as_ref() {
                    if u.output_tokens > 0 {
                        emit_usage(app, &ChatUsage {
                            request_id: request_id.to_string(),
                            prompt_tokens: 0,
                            completion_tokens: u.output_tokens,
                            cached_tokens: 0,
                        });
                    }
                }
            }
            // Text arrives as `content_block_delta` with a `text_delta` inside.
            if parsed.kind.as_deref() == Some("content_block_delta") {
                if let Some(delta) = parsed.delta {
                    if delta.kind.as_deref() == Some("text_delta") {
                        if let Some(text) = delta.text {
                            if !text.is_empty() {
                                emit_delta(app, request_id, text);
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

/* ---------- OpenAI Responses ---------- */

#[derive(Deserialize)]
struct ResponsesEvent {
    #[serde(rename = "type")]
    kind: Option<String>,
    delta: Option<String>,
    error: Option<OpenAiError>,
}

async fn stream_responses(
    app: &AppHandle,
    request_id: &str,
    provider: &ProviderConfig,
    turns: &[ChatTurn],
) -> Result<(), String> {
    let base = provider.base_url.trim_end_matches('/');
    let url = format!("{base}/responses");

    let messages: Vec<serde_json::Value> = turns
        .iter()
        .map(|t| {
            let role = if t.role == "agent" || t.role == "assistant" {
                "assistant"
            } else {
                "user"
            };
            serde_json::json!({ "role": role, "content": t.text })
        })
        .collect();

    let mut body = serde_json::json!({
        "model": provider.model,
        "input": messages,
        "stream": true,
    });
    if !provider.system.trim().is_empty() {
        body["instructions"] = serde_json::json!(provider.system);
    }

    let mut req = reqwest::Client::new()
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body);
    if !provider.api_key.trim().is_empty() {
        req = req.bearer_auth(provider.api_key.trim());
    }

    let res = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let detail = res.text().await.unwrap_or_default();
        return Err(format!("Responses API returned {status}: {}", trim_error(&detail)));
    }

    let mut stream = res.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        // The Stop button aborts the stream; the UI keeps the partial text.
        if crate::cancel::is_requested(request_id) {
            return Err(crate::cancel::STOPPED.to_string());
        }
        let bytes = chunk.map_err(|e| format!("stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(idx) = buf.find('\n') {
            let line = buf[..idx].trim().to_string();
            buf.drain(..idx + 1);
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            if data == "[DONE]" {
                return Ok(());
            }
            let Ok(parsed) = serde_json::from_str::<ResponsesEvent>(data) else {
                continue;
            };
            if let Some(err) = parsed.error {
                return Err(err.message.unwrap_or_else(|| "provider error".into()));
            }
            // `response.output_text.delta` carries the incremental text.
            if parsed.kind.as_deref() == Some("response.output_text.delta") {
                if let Some(text) = parsed.delta {
                    if !text.is_empty() {
                        emit_delta(app, request_id, text);
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