/// Model discovery — run entirely in Rust.
///
/// Listing a provider's models used to go through the frontend HTTP plugin,
/// which applies a capability allowlist to every URL. Third-party gateways
/// (anything that is not Google or localhost) were rejected by that allowlist.
/// Doing the request here instead means no CORS and no scope checks: the
/// desktop app talks to whatever endpoint the user configured.
use serde::{Deserialize, Serialize};

/// A model row as the UI stores it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredModel {
    pub model_id: String,
    pub name: String,
    pub meta: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DiscoveryRequest {
    /// `google`, `openai-completions`, `openai-responses`, `anthropic-messages`,
    /// `openai`, `openai-compatible`, `ollama`.
    pub kind: String,
    pub base_url: String,
    /// API key (or OAuth access token for signed-in Google providers).
    #[serde(default)]
    pub api_key: String,
    /// `key` or `bearer` — only matters for Google.
    #[serde(default)]
    pub auth: String,
}

/// Lists the models a provider currently serves.
#[tauri::command]
pub async fn list_provider_models(req: DiscoveryRequest) -> Result<Vec<DiscoveredModel>, String> {
    let base = req.base_url.trim().trim_end_matches('/').to_string();
    let key = req.api_key.trim().to_string();

    match req.kind.as_str() {
        "google" => list_google(&base, &key, &req.auth).await,
        "ollama" => list_ollama(&base).await,
        // Anthropic has a dedicated models endpoint.
        "anthropic-messages" => list_anthropic(&base, &key).await,
        // OpenAI and every compatible server expose GET /models.
        _ => list_openai_style(&base, &key).await,
    }
}

/* ---------- Google (Gemini) ---------- */

async fn list_google(base: &str, key: &str, auth: &str) -> Result<Vec<DiscoveredModel>, String> {
    if key.is_empty() {
        return Err("Sign in with Google or provide an API key first".into());
    }

    // A bearer token goes in the Authorization header; an API key in `?key=`.
    let bearer = auth == "bearer";
    let url = if bearer {
        format!("{base}/v1beta/models?pageSize=200")
    } else {
        format!("{base}/v1beta/models?pageSize=200&key={}", urlencoding::encode(key))
    };

    let mut request = reqwest::Client::new().get(&url);
    if bearer {
        request = request.bearer_auth(key);
    }

    let res = request.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Google returned {status}: {body}"));
    }

    let parsed: GoogleList =
        serde_json::from_str(&body).map_err(|e| format!("bad JSON: {e}"))?;

    let models = parsed
        .models
        .unwrap_or_default()
        .into_iter()
        // Only Gemini models that can generate content belong in the picker.
        .filter(|m| {
            m.name.contains("gemini")
                && m.methods
                    .as_ref()
                    .map(|x| x.iter().any(|s| s == "generateContent"))
                    .unwrap_or(true)
        })
        .map(|m| {
            let id = m.name.rsplit('/').next().unwrap_or(&m.name).to_string();
            let limit = m.input_token_limit.unwrap_or(0);
            let meta = if limit >= 1_000_000 {
                format!("{}M ctx", limit / 1_000_000)
            } else if limit >= 1_000 {
                format!("{}k ctx", limit / 1_000)
            } else {
                "cloud".to_string()
            };
            DiscoveredModel {
                name: m.display_name.unwrap_or_else(|| id.clone()),
                model_id: id,
                meta,
            }
        })
        .collect::<Vec<_>>();

    if models.is_empty() {
        return Err("No chat-capable Gemini models were returned".into());
    }
    Ok(models)
}

#[derive(Deserialize)]
struct GoogleList {
    models: Option<Vec<GoogleModel>>,
}

#[derive(Deserialize)]
struct GoogleModel {
    name: String,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "inputTokenLimit")]
    input_token_limit: Option<i64>,
    #[serde(rename = "supportedGenerationMethods")]
    methods: Option<Vec<String>>,
}

/* ---------- Ollama ---------- */

async fn list_ollama(base: &str) -> Result<Vec<DiscoveredModel>, String> {
    let res = reqwest::Client::new()
        .get(format!("{base}/api/tags"))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Ollama returned {status}: {body}"));
    }

    #[derive(Deserialize)]
    struct Tags {
        models: Option<Vec<Tag>>,
    }
    #[derive(Deserialize)]
    struct Tag {
        name: String,
        details: Option<TagDetails>,
    }
    #[derive(Deserialize)]
    struct TagDetails {
        parameter_size: Option<String>,
    }

    let parsed: Tags = serde_json::from_str(&body).map_err(|e| format!("bad JSON: {e}"))?;
    let models: Vec<DiscoveredModel> = parsed
        .models
        .unwrap_or_default()
        .into_iter()
        .map(|m| DiscoveredModel {
            name: m.name.clone(),
            model_id: m.name,
            meta: m.details.and_then(|d| d.parameter_size).unwrap_or_else(|| "local".into()),
        })
        .collect();

    if models.is_empty() {
        return Err("Ollama returned no models".into());
    }
    Ok(models)
}

/* ---------- Anthropic ---------- */

async fn list_anthropic(base: &str, key: &str) -> Result<Vec<DiscoveredModel>, String> {
    if key.is_empty() {
        return Err("An API key is required for Anthropic".into());
    }

    let res = reqwest::Client::new()
        .get(format!("{base}/models?limit=200"))
        // Anthropic requires these two headers on every request.
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Anthropic returned {status}: {body}"));
    }

    #[derive(Deserialize)]
    struct ModelsList {
        data: Option<Vec<AnthropicModel>>,
    }
    #[derive(Deserialize)]
    struct AnthropicModel {
        id: String,
        display_name: Option<String>,
    }

    let parsed: ModelsList =
        serde_json::from_str(&body).map_err(|e| format!("bad JSON: {e}"))?;
    let models: Vec<DiscoveredModel> = parsed
        .data
        .unwrap_or_default()
        .into_iter()
        .map(|m| DiscoveredModel {
            name: m.display_name.unwrap_or_else(|| m.id.clone()),
            model_id: m.id,
            meta: "anthropic".into(),
        })
        .collect();

    if models.is_empty() {
        return Err("Anthropic returned no models".into());
    }
    Ok(models)
}

/* ---------- OpenAI-compatible ---------- */

async fn list_openai_style(base: &str, key: &str) -> Result<Vec<DiscoveredModel>, String> {
    let mut request = reqwest::Client::new().get(format!("{base}/models"));
    if !key.is_empty() {
        request = request.bearer_auth(key);
    }

    let res = request.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Endpoint returned {status}: {body}"));
    }

    #[derive(Deserialize)]
    struct ModelsList {
        data: Option<Vec<OpenAiModel>>,
    }
    #[derive(Deserialize)]
    struct OpenAiModel {
        id: String,
        owned_by: Option<String>,
    }

    let parsed: ModelsList =
        serde_json::from_str(&body).map_err(|e| format!("bad JSON: {e}"))?;
    let models: Vec<DiscoveredModel> = parsed
        .data
        .unwrap_or_default()
        .into_iter()
        .map(|m| DiscoveredModel {
            name: m.id.clone(),
            model_id: m.id,
            meta: m.owned_by.unwrap_or_else(|| "remote".into()),
        })
        .collect();

    if models.is_empty() {
        return Err("Endpoint returned no models".into());
    }
    Ok(models)
}