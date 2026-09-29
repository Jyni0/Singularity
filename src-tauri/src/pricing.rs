//! Context window, price and capabilities of a model — for the context
//! gauge, the cost read-outs and the model list in Settings.
//!
//! * Ollama: asked directly (`/api/show`): the model's trained context and
//!   the `num_ctx` it actually runs with. Local, so free.
//! * Everything else: OpenRouter's public model catalog (no key needed),
//!   which lists context length and per-token prices for the models of all
//!   major providers. Model ids are matched loosely (`claude-sonnet-4-5`
//!   vs `anthropic/claude-sonnet-4.5`, date suffixes, `:free`). The catalog
//!   is cached for a few hours. Nothing is guessed: unknown stays unknown.

use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const CATALOG_URL: &str = "https://openrouter.ai/api/v1/models";
const CATALOG_TTL: Duration = Duration::from_secs(6 * 3600);

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// Context window in tokens.
    pub context: Option<u64>,
    /// USD per million tokens.
    pub input_per_mtok: Option<f64>,
    pub output_per_mtok: Option<f64>,
    pub cache_read_per_mtok: Option<f64>,
    /// Where the numbers come from ("ollama", "openrouter", "").
    pub source: String,
    /// The catalog entry that matched (so the UI can show it).
    pub matched: String,
    /// Runs locally — costs nothing.
    pub local: bool,
    /// Longest answer the model can write, tokens.
    pub max_output: Option<u64>,
    /// Capabilities; None = the source does not say.
    pub vision: Option<bool>,
    pub tools: Option<bool>,
    pub reasoning: Option<bool>,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct Entry {
    id: String,
    #[serde(default)]
    context_length: Option<u64>,
    #[serde(default)]
    pricing: Option<Pricing>,
    #[serde(default)]
    top_provider: Option<TopProvider>,
    #[serde(default)]
    architecture: Option<Architecture>,
    #[serde(default)]
    supported_parameters: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct TopProvider {
    #[serde(default)]
    max_completion_tokens: Option<u64>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct Architecture {
    #[serde(default)]
    input_modalities: Vec<String>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct Pricing {
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    completion: Option<String>,
    #[serde(default)]
    input_cache_read: Option<String>,
}

#[derive(serde::Deserialize)]
struct Catalog {
    data: Vec<Entry>,
}

static CATALOG: Mutex<Option<(Instant, Vec<Entry>)>> = Mutex::new(None);

async fn catalog() -> Result<Vec<Entry>, String> {
    if let Some((at, list)) = CATALOG.lock().unwrap().as_ref() {
        if at.elapsed() < CATALOG_TTL {
            return Ok(list.clone());
        }
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let parsed: Catalog = client
        .get(CATALOG_URL)
        .send()
        .await
        .map_err(|e| format!("model catalog unreachable: {e}"))?
        .json()
        .await
        .map_err(|e| format!("model catalog unreadable: {e}"))?;
    *CATALOG.lock().unwrap() = Some((Instant::now(), parsed.data.clone()));
    Ok(parsed.data)
}

/// `anthropic/claude-sonnet-4.5:free` / `claude-sonnet-4-5-20250929` →
/// `claude-sonnet-4-5`.
fn norm(id: &str) -> String {
    let id = id.to_lowercase();
    let id = id.rsplit('/').next().unwrap_or(&id);
    let id = id.split(':').next().unwrap_or(id);
    let mut id = id.replace(['.', '_'], "-");
    // Gateway aliases for the same model: "-thinking", "-latest"…
    loop {
        let before = id.len();
        for suffix in ["-latest", "-preview", "-thinking", "-reasoning", "-think"] {
            if let Some(s) = id.strip_suffix(suffix) {
                id = s.to_string();
            }
        }
        if id.len() == before {
            break;
        }
    }
    // Date stamps: -20250929 / -2025-09-29.
    static DATE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"-(\d{8}|\d{4}-\d{2}-\d{2})$").unwrap());
    DATE.replace(&id, "").into_owned()
}

fn vendor_for(kind: &str, base_url: &str) -> Option<&'static str> {
    let b = base_url.to_lowercase();
    if kind == "anthropic-messages" || b.contains("anthropic") {
        Some("anthropic/")
    } else if kind == "google" || b.contains("generativelanguage") {
        Some("google/")
    } else if b.contains("deepseek") {
        Some("deepseek/")
    } else if b.contains("api.openai.com") {
        Some("openai/")
    } else if b.contains("x.ai") {
        Some("x-ai/")
    } else if b.contains("mistral") {
        Some("mistralai/")
    } else {
        None
    }
}

fn per_mtok(v: &Option<String>) -> Option<f64> {
    let p: f64 = v.as_deref()?.trim().parse().ok()?;
    (p >= 0.0).then_some((p * 1_000_000.0 * 10_000.0).round() / 10_000.0)
}

fn pick<'a>(list: &'a [Entry], kind: &str, base_url: &str, model: &str) -> Option<&'a Entry> {
    let exact = model.to_lowercase();
    if let Some(e) = list.iter().find(|e| e.id.to_lowercase() == exact) {
        return Some(e);
    }
    let want = norm(model);
    let mut hits: Vec<&Entry> = list.iter().filter(|e| norm(&e.id) == want).collect();
    if hits.is_empty() {
        return None;
    }
    // Canonical listing first: not ":free" / ":batch" variants, not "~" aliases.
    hits.sort_by_key(|e| (e.id.contains(':'), e.id.starts_with('~'), e.id.len()));
    if let Some(v) = vendor_for(kind, base_url) {
        if let Some(e) = hits.iter().find(|e| e.id.starts_with(v)) {
            return Some(e);
        }
    }
    hits.first().copied()
}

/// Context length of the model as currently loaded (`/api/ps`), if it is.
async fn ollama_running_ctx(client: &reqwest::Client, base_url: &str, model: &str) -> Option<u64> {
    let url = format!("{}/api/ps", base_url.trim_end_matches('/'));
    let v: serde_json::Value = client.get(url).send().await.ok()?.json().await.ok()?;
    v.get("models")?
        .as_array()?
        .iter()
        .find(|m| m.get("name").and_then(|n| n.as_str()) == Some(model) || m.get("model").and_then(|n| n.as_str()) == Some(model))?
        .get("context_length")?
        .as_u64()
        .filter(|&n| n > 0)
}

async fn ollama_info(base_url: &str, model: &str) -> ModelInfo {
    let mut info = ModelInfo { source: "ollama".into(), local: true, input_per_mtok: Some(0.0), output_per_mtok: Some(0.0), ..Default::default() };
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(8)).build() else { return info };
    let url = format!("{}/api/show", base_url.trim_end_matches('/'));
    let Ok(resp) = client.post(url).json(&serde_json::json!({ "model": model })).send().await else { return info };
    let Ok(v) = resp.json::<serde_json::Value>().await else { return info };
    // The window it actually runs with (num_ctx) beats the trained maximum.
    let num_ctx = v
        .get("parameters")
        .and_then(|p| p.as_str())
        .and_then(|p| p.lines().find_map(|l| l.trim().strip_prefix("num_ctx").map(|n| n.trim().parse::<u64>().ok())))
        .flatten();
    let trained = v.get("model_info").and_then(|m| m.as_object()).and_then(|m| {
        m.iter().find(|(k, _)| k.ends_with(".context_length")).and_then(|(_, n)| n.as_u64())
    });
    // A loaded model reports the window the server really runs it with —
    // often far below the trained one (32k of 262k). Showing the trained
    // one hid that Ollama silently cuts the prompt's start past it.
    let running = ollama_running_ctx(&client, base_url, model).await;
    info.context = running.or(num_ctx).or(trained);
    info.matched = model.to_string();
    // Newer Ollama lists capabilities: ["completion", "tools", "vision", "thinking"].
    if let Some(caps) = v.get("capabilities").and_then(|c| c.as_array()) {
        let has = |name: &str| Some(caps.iter().any(|c| c.as_str() == Some(name)));
        info.vision = has("vision");
        info.tools = has("tools");
        info.reasoning = has("thinking");
    }
    info
}

/// Context window + prices of one model.
#[tauri::command]
pub async fn model_info(kind: String, base_url: String, model: String) -> ModelInfo {
    let local = kind == "ollama" || {
        let b = base_url.to_lowercase();
        b.contains("localhost") || b.contains("127.0.0.1") || b.contains("0.0.0.0") || b.contains("host.docker.internal")
    };
    if kind == "ollama" {
        return ollama_info(&base_url, &model).await;
    }
    let mut info = ModelInfo { local, ..Default::default() };
    if local {
        info.input_per_mtok = Some(0.0);
        info.output_per_mtok = Some(0.0);
    }
    if let Ok(list) = catalog().await {
        if let Some(e) = pick(&list, &kind, &base_url, &model) {
            info.context = e.context_length;
            info.max_output = e.top_provider.as_ref().and_then(|t| t.max_completion_tokens);
            if let Some(a) = &e.architecture {
                info.vision = Some(a.input_modalities.iter().any(|m| m == "image"));
            }
            if let Some(params) = &e.supported_parameters {
                info.tools = Some(params.iter().any(|p| p == "tools"));
                info.reasoning = Some(params.iter().any(|p| p == "reasoning" || p == "include_reasoning"));
            }
            info.source = "openrouter".into();
            info.matched = e.id.clone();
            if !local {
                let p = e.pricing.clone().unwrap_or_default();
                info.input_per_mtok = per_mtok(&p.prompt);
                info.output_per_mtok = per_mtok(&p.completion);
                info.cache_read_per_mtok = per_mtok(&p.input_cache_read);
            }
        }
    }
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(id: &str) -> Entry {
        Entry { id: id.into(), context_length: Some(1), pricing: None, top_provider: None, architecture: None, supported_parameters: None }
    }

    #[test]
    fn ids_match_loosely() {
        assert_eq!(norm("anthropic/claude-sonnet-4.5"), "claude-sonnet-4-5");
        assert_eq!(norm("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
        assert_eq!(norm("deepseek/deepseek-chat:free"), "deepseek-chat");
        assert_eq!(norm("claude-opus-5-thinking"), "claude-opus-5");
        let list = vec![e("anthropic/claude-sonnet-4.5:batch"), e("somehost/claude-sonnet-4.5"), e("anthropic/claude-sonnet-4.5"), e("openai/gpt-4o"), e("openai/gpt-4o:free")];
        assert_eq!(pick(&list, "anthropic-messages", "https://api.anthropic.com/v1", "claude-sonnet-4-5").unwrap().id, "anthropic/claude-sonnet-4.5");
        assert_eq!(pick(&list, "openai-completions", "https://gateway.example", "gpt-4o").unwrap().id, "openai/gpt-4o");
        assert!(pick(&list, "openai-completions", "", "unknown-model").is_none());
        assert_eq!(per_mtok(&Some("0.000003".into())), Some(3.0));
    }
}
