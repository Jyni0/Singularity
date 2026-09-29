//! Picture generation for the agent's `generate_image` tool.
//!
//! The WebView picks where pictures come from (`ImageGenConfig`): an image
//! model of the chat's own provider when it lists one (gpt-image, dall-e,
//! imagen, flux…), else the chat provider itself when its API can draw
//! (OpenAI Responses' image tool, Gemini image models), else another
//! provider that has an image model. Each API family is called natively:
//!
//! * OpenAI-compatible — `POST /images/generations` (b64_json or url);
//! * OpenAI Responses without an image model — `POST /responses` with the
//!   hosted `image_generation` tool on the chat model;
//! * Google — Imagen `:predict` or Gemini `:generateContent` with IMAGE output;
//! * Ollama — `POST /api/generate` with an image model (`image` field).
//!
//! The picture is saved under the app's data folder; the chat shows it from
//! there and the model gets its path back.

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

/// Where pictures come from — set by the WebView per run.
#[derive(Debug, Clone, Deserialize)]
pub struct ImageGenConfig {
    pub kind: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    /// `key` or `bearer` (Google sign-in).
    #[serde(default)]
    pub auth: String,
    /// Image model id; empty = let the provider's own chat model draw.
    #[serde(default)]
    pub model: String,
    /// The chat model — used when `model` is empty.
    #[serde(default)]
    pub chat_model: String,
}

/// One generated picture.
pub struct Picture {
    pub bytes: Vec<u8>,
    pub ext: &'static str,
    /// Model that drew it (for the tool result).
    pub model: String,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        // Image models take a while; gpt-image at high quality ~1 min.
        .timeout(Duration::from_secs(240))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_default()
}

fn b64(data: &str) -> Result<Vec<u8>, String> {
    // Some gateways send a data URL instead of bare base64.
    let raw = data.split_once("base64,").map(|(_, d)| d).unwrap_or(data);
    base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|e| format!("bad image data: {e}"))
}

/// Picture format from its first bytes.
fn ext_of(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "png",
        [0xFF, 0xD8, ..] => "jpg",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "webp",
        [b'G', b'I', b'F', ..] => "gif",
        _ => "png",
    }
}

/// Error body of a failed request, short.
async fn fail(res: reqwest::Response) -> String {
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v["error"]["message"]
                .as_str()
                .or(v["error"].as_str())
                .or(v["message"].as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(300).collect());
    format!("HTTP {status}: {msg}")
}

async fn send(req: reqwest::RequestBuilder) -> Result<Value, String> {
    let res = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    if !res.status().is_success() {
        return Err(fail(res).await);
    }
    res.json::<Value>().await.map_err(|e| format!("unreadable answer: {e}"))
}

/// Draws one picture for `prompt`.
pub async fn generate(cfg: &ImageGenConfig, prompt: &str, size: &str) -> Result<Picture, String> {
    let base = cfg.base_url.trim().trim_end_matches('/').to_string();
    let key = cfg.api_key.trim();
    let http = client();
    let (bytes, model) = match cfg.kind.as_str() {
        "google" => google(&http, &base, key, &cfg.auth, &cfg.model, prompt).await?,
        "google-cli" => antigravity(prompt, size).await?,
        "openai-cli" => return Err("the Codex CLI cannot generate images in headless mode".into()),
        "anthropic-cli" => return Err("Claude models cannot generate images".into()),
        "ollama" => ollama(&http, &base, &cfg.model, prompt).await?,
        // No image model listed: the chat model draws through the hosted
        // image tool; a gateway without it may still serve the Images API.
        "openai-responses" if cfg.model.is_empty() => match responses(&http, &base, key, &cfg.chat_model, prompt, size).await {
            Ok(done) => done,
            Err(first) => images_api(&http, &base, key, "gpt-image-1", prompt, size)
                .await
                .map_err(|second| format!("{first}; Images API: {second}"))?,
        },
        "anthropic-messages" => return Err("Anthropic models cannot generate images".into()),
        _ => {
            let model = if cfg.model.is_empty() { "gpt-image-1" } else { &cfg.model };
            images_api(&http, &base, key, model, prompt, size).await?
        }
    };
    if bytes.is_empty() {
        return Err("the provider returned no image".into());
    }
    Ok(Picture { ext: ext_of(&bytes), bytes, model })
}

/// OpenAI-compatible `/images/generations`.
async fn images_api(
    http: &reqwest::Client,
    base: &str,
    key: &str,
    model: &str,
    prompt: &str,
    size: &str,
) -> Result<(Vec<u8>, String), String> {
    let mut body = json!({ "model": model, "prompt": prompt, "n": 1 });
    if !size.is_empty() && size != "auto" {
        body["size"] = json!(size);
    }
    // dall-e answers with a URL unless asked; gpt-image always sends base64
    // and rejects the parameter.
    if model.starts_with("dall-e") {
        body["response_format"] = json!("b64_json");
    }
    let v = send(http.post(format!("{base}/images/generations")).bearer_auth(key).json(&body)).await?;
    let item = &v["data"][0];
    if let Some(data) = item["b64_json"].as_str() {
        return Ok((b64(data)?, model.to_string()));
    }
    if let Some(url) = item["url"].as_str() {
        let res = http.get(url).send().await.map_err(|e| format!("download failed: {e}"))?;
        if !res.status().is_success() {
            return Err(fail(res).await);
        }
        let bytes = res.bytes().await.map_err(|e| format!("download failed: {e}"))?;
        return Ok((bytes.to_vec(), model.to_string()));
    }
    Err("the provider returned no image".into())
}

/// OpenAI Responses: the chat model draws through the hosted image tool.
async fn responses(
    http: &reqwest::Client,
    base: &str,
    key: &str,
    model: &str,
    prompt: &str,
    size: &str,
) -> Result<(Vec<u8>, String), String> {
    let mut tool = json!({ "type": "image_generation" });
    if !size.is_empty() && size != "auto" {
        tool["size"] = json!(size);
    }
    let body = json!({
        "model": model,
        "input": prompt,
        "tools": [tool],
        "tool_choice": { "type": "image_generation" },
    });
    let v = send(http.post(format!("{base}/responses")).bearer_auth(key).json(&body)).await?;
    let data = v["output"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|o| o["type"] == "image_generation_call")
        .and_then(|o| o["result"].as_str())
        .ok_or_else(|| format!("{model} returned no image — it may not support image generation"))?;
    Ok((b64(data)?, model.to_string()))
}

/// Google: Imagen (`:predict`) or a Gemini image model (`:generateContent`).
async fn google(
    http: &reqwest::Client,
    base: &str,
    key: &str,
    auth: &str,
    model: &str,
    prompt: &str,
) -> Result<(Vec<u8>, String), String> {
    let model = if model.is_empty() { "gemini-2.5-flash-image" } else { model };
    let model = model.trim_start_matches("models/");
    // The provider stores the bare host; an OpenAI-style base loses its tail.
    let root = base.split("/v1").next().unwrap_or(base);
    let imagen = model.contains("imagen");
    let url = format!("{root}/v1beta/models/{model}:{}", if imagen { "predict" } else { "generateContent" });
    let body = if imagen {
        json!({ "instances": [{ "prompt": prompt }], "parameters": { "sampleCount": 1 } })
    } else {
        json!({
            "contents": [{ "parts": [{ "text": prompt }] }],
            "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] },
        })
    };
    let req = if auth == "bearer" {
        http.post(url).bearer_auth(key)
    } else {
        http.post(url).header("x-goog-api-key", key)
    };
    let v = send(req.json(&body)).await?;
    let data = if imagen {
        v["predictions"][0]["bytesBase64Encoded"].as_str().map(str::to_string)
    } else {
        v["candidates"][0]["content"]["parts"]
            .as_array()
            .into_iter()
            .flatten()
            .find_map(|p| p["inlineData"]["data"].as_str().or(p["inline_data"]["data"].as_str()))
            .map(str::to_string)
    };
    let data = data.ok_or_else(|| format!("{model} returned no image"))?;
    Ok((b64(&data)?, model.to_string()))
}

/// Google subscription (Antigravity CLI): its agent has a built-in
/// `generate_image` tool that saves the picture in the conversation's
/// folder (`~/.gemini/antigravity-cli/brain/<conversation id>/`). The run is
/// asked to call it once; the newest picture of that folder is the result.
async fn antigravity(prompt: &str, size: &str) -> Result<(Vec<u8>, String), String> {
    let launch = crate::cli::ensure(crate::cli::Cli::Antigravity).await?;
    let shape = match size {
        "1536x1024" => " Landscape format.",
        "1024x1536" => " Portrait format.",
        "1024x1024" => " Square format.",
        _ => "",
    };
    let ask = format!(
        "Call your generate_image tool exactly once for the picture below, then reply 'done'. \
         Do nothing else — no files, no commands.\n\nPicture: {prompt}{shape}"
    );
    let mut cmd = launch.command();
    cmd.args(["-p", &ask, "--output-format", "stream-json"]);
    let out = tokio::time::timeout(Duration::from_secs(300), cmd.output())
        .await
        .map_err(|_| "Antigravity took too long".to_string())?
        .map_err(|e| format!("cannot start Antigravity: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let events: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let conversation = events
        .iter()
        .find_map(|e| {
            e["result"]["conversation_id"]
                .as_str()
                .or(e["step_update"]["conversation_id"].as_str())
                .map(str::to_string)
        })
        .ok_or_else(|| {
            let err = String::from_utf8_lossy(&out.stderr);
            format!("Antigravity did not run: {}", err.trim().chars().take(300).collect::<String>())
        })?;
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or("no home folder")?;
    let dir = home.join(".gemini").join("antigravity-cli").join("brain").join(&conversation);
    let newest = std::fs::read_dir(&dir)
        .map_err(|_| "Antigravity made no picture".to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_lowercase();
            [".png", ".jpg", ".jpeg", ".webp"].iter().any(|x| n.ends_with(x))
        })
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok())
        .ok_or_else(|| {
            let said = events
                .iter()
                .rev()
                .find_map(|e| e["result"]["response"].as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if said.is_empty() { "Antigravity made no picture".to_string() } else { format!("Antigravity made no picture: {said}") }
        })?;
    let bytes = std::fs::read(newest.path()).map_err(|e| format!("cannot read the picture: {e}"))?;
    Ok((bytes, "Antigravity (Gemini)".to_string()))
}

/// Ollama image models (`/api/generate` answers with `image`).
async fn ollama(http: &reqwest::Client, base: &str, model: &str, prompt: &str) -> Result<(Vec<u8>, String), String> {
    if model.is_empty() {
        return Err("no Ollama image model is installed".into());
    }
    let body = json!({ "model": model, "prompt": prompt, "stream": false });
    let v = send(http.post(format!("{base}/api/generate")).json(&body)).await?;
    let data = v["image"]
        .as_str()
        .or(v["images"][0].as_str())
        .ok_or_else(|| format!("{model} returned no image"))?;
    Ok((b64(data)?, model.to_string()))
}

/// Folder the pictures are kept in.
pub fn folder(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no data directory: {e}"))?
        .join("generated");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// File name from the prompt: a few words, then a timestamp.
fn file_name(prompt: &str, ext: &str) -> String {
    let words: String = prompt
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(5)
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase()
        .chars()
        .take(48)
        .collect();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stem = if words.is_empty() { "image".to_string() } else { words };
    format!("{stem}-{stamp}.{ext}")
}

/// Runs the tool: draw, save, report.
pub async fn tool(app: &tauri::AppHandle, cfg: Option<&ImageGenConfig>, args: &Value) -> crate::tools::ToolResult {
    use crate::tools::ToolResult;
    let Some(cfg) = cfg else {
        return ToolResult::err("No image model is available — add one in Settings → Models (e.g. gpt-image-1).");
    };
    let prompt = args["prompt"].as_str().unwrap_or("").trim();
    if prompt.is_empty() {
        return ToolResult::err("prompt is empty");
    }
    let size = args["size"].as_str().unwrap_or("auto");
    let pic = match generate(cfg, prompt, size).await {
        Ok(p) => p,
        Err(e) => return ToolResult::err(format!("image generation failed: {e}")),
    };
    let path = match folder(app) {
        Ok(dir) => dir.join(file_name(prompt, pic.ext)),
        Err(e) => return ToolResult::err(e),
    };
    if let Err(e) = std::fs::write(&path, &pic.bytes) {
        return ToolResult::err(format!("cannot save the image: {e}"));
    }
    let shown = path.to_string_lossy().to_string();
    let mut res = ToolResult::ok(format!(
        "Image generated with {} and already shown to the user in the chat. Saved at {shown} — \
         copy it from there if it belongs in the project. Do not embed or link it again.",
        pic.model
    ));
    res.image = Some(shown);
    res
}

/// Resolves `path` only when it lies in the pictures folder — these commands
/// are not a general file reader.
fn generated(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    let dir = folder(app)?;
    let real = PathBuf::from(path).canonicalize().map_err(|e| format!("{path}: {e}"))?;
    if !real.starts_with(dir.canonicalize().unwrap_or(dir)) {
        return Err("not a generated image".into());
    }
    Ok(real)
}

/// "Download": copies a generated picture to where the user picked in the save dialog.
#[tauri::command]
pub fn save_generated_image(app: tauri::AppHandle, path: String, dest: String) -> Result<(), String> {
    let real = generated(&app, &path)?;
    std::fs::copy(&real, &dest).map_err(|e| format!("{dest}: {e}"))?;
    Ok(())
}

/// The WebView reads a generated picture back as a data URL.
#[tauri::command]
pub fn read_generated_image(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let real = generated(&app, &path)?;
    let bytes = std::fs::read(&real).map_err(|e| format!("{path}: {e}"))?;
    let mime = match ext_of(&bytes) {
        "jpg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_formats() {
        let n = file_name("A house on a field, sunset!", "png");
        assert!(n.starts_with("a-house-on-a-field-"), "{n}");
        assert!(n.ends_with(".png"));
        assert_eq!(ext_of(&[0xFF, 0xD8, 0xFF]), "jpg");
        assert_eq!(b64("data:image/png;base64,aGk=").unwrap(), b"hi");
    }
}

#[cfg(test)]
mod live {
    /// Draws through the signed-in Antigravity CLI (network, quota).
    #[tokio::test]
    #[ignore]
    async fn antigravity_draws() {
        let cfg = super::ImageGenConfig {
            kind: "google-cli".into(),
            base_url: String::new(),
            api_key: String::new(),
            auth: String::new(),
            model: String::new(),
            chat_model: String::new(),
        };
        let pic = super::generate(&cfg, "a small blue cup on a wooden table", "1024x1024").await.unwrap();
        assert!(pic.bytes.len() > 10_000, "{} bytes", pic.bytes.len());
        println!("{} bytes, {}", pic.bytes.len(), pic.ext);
    }
}
