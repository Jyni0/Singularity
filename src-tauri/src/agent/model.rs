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
    /// Cache numbers the provider reported for the latest response
    /// (OpenAI-compatible transport, see cachenet.rs).
    pub cache_seen: Option<std::sync::Arc<std::sync::Mutex<Option<super::cachenet::CacheSeen>>>>,
}

/// Anthropic thinking budget per effort level (None = thinking off).
fn anthropic_thinking(effort: &str) -> Option<u64> {
    match effort {
        // "none": the model has reasoning switched off (Settings → Models).
        "low" | "none" => None,
        "high" => Some(8192),
        _ => Some(2048),
    }
}

/// The temperature actually sent for the user's pick (0–2), or None to use
/// the provider default.
///
/// An agent must emit exact JSON tool calls, file paths and code; sampling
/// above ~1.2 turns them into noise — the model then never produced a valid
/// call ("nothing generates") or rambled until the context ran out ("takes
/// forever"). The upper half of the slider is therefore compressed into
/// 1.0–1.3: still noticeably more varied, never broken. Anthropic accepts
/// at most 1.0, and OpenAI's reasoning models (o-series, gpt-5) accept no
/// temperature at all — sending one was a 400 on every retry.
pub(super) fn agent_temperature(kind: &str, model: &str, t: f64) -> Option<f64> {
    let m = model.to_lowercase();
    let m = m.rsplit('/').next().unwrap_or(&m);
    let reasoning = m.starts_with("o1") || m.starts_with("o3") || m.starts_with("o4") || m.starts_with("gpt-5");
    if reasoning && kind != "anthropic-messages" && kind != "ollama" {
        return None;
    }
    let t = t.clamp(0.0, 2.0);
    let soft = if t <= 1.0 { t } else { 1.0 + (t - 1.0) * 0.3 };
    let cap = if kind == "anthropic-messages" { 1.0 } else { 1.3 };
    Some((soft.min(cap) * 100.0).round() / 100.0)
}

/// Builds the Rig model for this request's provider.
pub(super) fn build(req: &AgentRequest) -> Result<ModelSetup, String> {
    let mut setup = build_model(req)?;
    // The user's own cap for an API model (Settings → Models → model caps).
    if let Some(cap) = req.max_tokens.filter(|m| *m > 0) {
        setup.max_tokens = Some(match setup.max_tokens {
            // Anthropic thinking needs room above its budget (default = budget + 4096).
            Some(cur) if req.kind == "anthropic-messages" && setup.params.is_some() => cap.max(cur - 4096 + 1024),
            _ => cap,
        });
    }
    Ok(setup)
}

fn build_model(req: &AgentRequest) -> Result<ModelSetup, String> {
    let key = req.api_key.trim().to_string();
    let base = req.base_url.trim().trim_end_matches('/').to_string();
    let fail = |e: rig_agent::core::http_client::Error| format!("provider client: {e}");
    let effort = match req.effort.as_str() {
        // Levels above High exist only for the subscription CLIs; an API
        // provider gets its highest level instead.
        "xhigh" | "max" | "ultra" | "ultracode" if crate::cli::Cli::from_kind(&req.kind).is_none() => "high",
        e => e,
    };
    // "medium" is every provider's default — only low/high are sent.
    let pick = matches!(effort, "low" | "high").then_some(effort);
    let temperature = req.temperature.and_then(|t| agent_temperature(&req.kind, &req.model, t));

    // Subscription CLIs (Codex / Claude Code / Antigravity CLI): a custom Rig model
    // over the headless CLI process. Effort goes on its command line; the
    // CLIs take no sampling parameters.
    if let Some(cli) = crate::cli::Cli::from_kind(&req.kind) {
        return Ok(ModelSetup {
            handle: ModelHandle::new(crate::cli::CliModel::new(cli, &req.model, effort)),
            params: None,
            temperature: None,
            max_tokens: None,
            cache_seen: None,
        });
    }

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
            // Plus explicit breakpoints on tools + system, so that layer stays
            // cached across turns while the automatic one follows the history.
            let model = client.completion_model(&req.model).with_automatic_caching().with_prompt_caching();
            let thinking = anthropic_thinking(effort);
            Ok(ModelSetup {
                handle: ModelHandle::new(model),
                params: thinking.map(|b| json!({ "thinking": { "type": "enabled", "budget_tokens": b } })),
                // Extended thinking requires the default temperature.
                temperature: if thinking.is_some() { None } else { temperature },
                // max_tokens must exceed the thinking budget.
                max_tokens: Some(thinking.map(|b| b + 4096).unwrap_or(8192)),
                cache_seen: None,
            })
        }
        "ollama" => {
            let client = ollama::Client::builder()
                .api_key(key)
                .base_url(&base)
                .build()
                .map_err(fail)?;
            // `think` is always sent: thinking models (Qwen3, DeepSeek-R1…)
            // think by default, and on a local box that generates a few
            // tokens a second that meant minutes of reasoning before the
            // first word — "it thinks forever". Only High turns it on.
            // keep_alive: a 10+ GB model evicted after Ollama's default 5
            // idle minutes is reloaded from disk on the next message.
            Ok(ModelSetup {
                handle: ModelHandle::new(client.completion_model(&req.model)),
                params: Some(json!({ "think": effort == "high", "keep_alive": "30m" })),
                temperature,
                max_tokens: None,
                cache_seen: None,
            })
        }
        // API → "OpenAI Responses": Rig's Responses-API client (POST /responses).
        "openai-responses" => {
            // Same transport as chat/completions: Claude behind a Responses
            // gateway gets cache marks, and the HUD sees real cache hits.
            let http = super::cachenet::CacheClient::new(&req.model);
            let seen = http.seen.clone();
            let client = openai::Client::builder()
                .api_key(key)
                .base_url(&base)
                .http_client(http)
                .build()
                .map_err(fail)?;
            Ok(ModelSetup {
                handle: ModelHandle::new(client.completion_model(&req.model)),
                params: pick.map(|e| json!({ "reasoning": { "effort": e } })),
                temperature,
                max_tokens: None,
                cache_seen: Some(seen),
            })
        }
        // OpenAI Completions, OpenAI-compatible gateways, DeepSeek, Gemini's
        // OpenAI endpoint…: plain /chat/completions — what loosely shaped
        // gateways serve reliably (Rig decodes `response.*` events strictly).
        _ => {
            let http = super::cachenet::CacheClient::new(&req.model);
            let seen = http.seen.clone();
            let client = openai::Client::builder()
                .api_key(key)
                .base_url(&base)
                .http_client(http)
                .build()
                .map_err(fail)?
                .completions_api();
            Ok(ModelSetup {
                handle: ModelHandle::new(client.completion_model(&req.model)),
                params: pick.map(|e| json!({ "reasoning_effort": e })),
                temperature,
                max_tokens: None,
                cache_seen: Some(seen),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::agent_temperature;

    #[test]
    fn temperature_stays_usable() {
        assert_eq!(agent_temperature("openai", "gpt-4o", 0.7), Some(0.7));
        assert_eq!(agent_temperature("openai", "gpt-4o", 2.0), Some(1.3));
        assert_eq!(agent_temperature("anthropic-messages", "claude-sonnet-5", 2.0), Some(1.0));
        assert_eq!(agent_temperature("openai", "o3-mini", 0.5), None);
        assert_eq!(agent_temperature("openai", "openai/gpt-5", 1.0), None);
    }
}
