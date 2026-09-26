//! Provider → Rig model handle. One place maps the app's provider kinds to
//! Rig clients and turns the user's effort/temperature picks into the
//! provider-specific request parameters.

use super::AgentRequest;
use rig_agent::core::client::CompletionClient;
use rig_agent::core::providers::{anthropic, ollama, openai};
use rig_agent::ModelHandle;
use serde_json::{json, Value};

/// Everything the agent builder needs from the provider side.
pub(super) struct ModelSetup {
    pub handle: ModelHandle,
    /// Extra request fields (reasoning effort / thinking), merged by Rig.
    pub params: Option<Value>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u64>,
}

/// Anthropic thinking budget per effort level (None = thinking off).
fn anthropic_thinking(effort: &str) -> Option<u64> {
    match effort {
        "low" => None,
        "high" => Some(8192),
        _ => Some(2048),
    }
}

/// Builds the Rig model for this request's provider.
pub(super) fn build(req: &AgentRequest) -> Result<ModelSetup, String> {
    let key = req.api_key.trim().to_string();
    let base = req.base_url.trim().trim_end_matches('/').to_string();
    let fail = |e: rig_agent::core::http_client::Error| format!("provider client: {e}");
    let effort = req.effort.as_str();
    // "medium" is every provider's default — only low/high are sent.
    let pick = matches!(effort, "low" | "high").then_some(effort);
    let temperature = req.temperature.map(|t| t.clamp(0.0, 2.0));

    match req.kind.as_str() {
        "anthropic-messages" => {
            // The app stores ".../v1"; Rig appends "/v1/messages" itself.
            let base = base.strip_suffix("/v1").unwrap_or(&base);
            let client = anthropic::Client::builder()
                .api_key(key)
                .base_url(base)
                .build()
                .map_err(fail)?;
            // Prompt caching: system prompt + tool schemas are byte-stable
            // across rounds, so repeat rounds read them from Anthropic's cache.
            let model = client.completion_model(&req.model).with_automatic_caching();
            let thinking = anthropic_thinking(effort);
            Ok(ModelSetup {
                handle: ModelHandle::new(model),
                params: thinking.map(|b| json!({ "thinking": { "type": "enabled", "budget_tokens": b } })),
                // Extended thinking requires the default temperature.
                temperature: if thinking.is_some() { None } else { temperature },
                // max_tokens must exceed the thinking budget.
                max_tokens: Some(thinking.map(|b| b + 4096).unwrap_or(8192)),
            })
        }
        "ollama" => {
            let client = ollama::Client::builder()
                .api_key(key)
                .base_url(&base)
                .build()
                .map_err(fail)?;
            Ok(ModelSetup {
                handle: ModelHandle::new(client.completion_model(&req.model)),
                params: pick.map(|e| json!({ "think": e == "high" })),
                temperature,
                max_tokens: None,
            })
        }
        // OpenAI (incl. "openai-responses" providers), OpenAI-compatible
        // gateways, DeepSeek, Gemini's OpenAI endpoint…: plain
        // /chat/completions. Rig's Responses-API client decodes stream events
        // strictly, and gateways that emit loosely shaped `response.*` events
        // killed the run ("did not match any variant of untagged enum
        // StreamingCompletionChunk"); /chat/completions is what these
        // providers always served the agent through.
        _ => {
            let client = openai::Client::builder()
                .api_key(key)
                .base_url(&base)
                .build()
                .map_err(fail)?
                .completions_api();
            Ok(ModelSetup {
                handle: ModelHandle::new(client.completion_model(&req.model)),
                params: pick.map(|e| json!({ "reasoning_effort": e })),
                temperature,
                max_tokens: None,
            })
        }
    }
}
