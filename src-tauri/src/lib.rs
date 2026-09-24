/// Singularity — Next-Gen Agentic Desktop.
/// Agent Harness Layer entry point.
mod agent;
mod cancel;
mod chat;
mod db;
mod discovery;
mod oauth;
mod runs;
mod tools;
mod tray;

use tauri::Manager;

/// Absolute path of the SQLite file, so the UI can show users where data lives.
#[tauri::command]
fn database_path(app: tauri::AppHandle) -> Result<String, String> {
    db::db_path(&app)
}

/// Default folder for the agent's file and command tools.
///
/// The agent always has a workspace, so there is nothing for the user to
/// choose: it works in a dedicated folder under the app's data directory.
#[tauri::command]
fn agent_workspace(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no data directory: {e}"))?
        .join("workspace");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create workspace: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// Points the agent at a specific folder and remembers it.
#[tauri::command]
fn set_agent_workspace(app: tauri::AppHandle, path: String) -> Result<String, String> {
    use tauri::Manager;
    let dir = std::path::PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("not a folder: {path}"));
    }
    if let Ok(cfg) = app.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&cfg);
        let _ = std::fs::write(cfg.join("workspace.txt"), dir.to_string_lossy().as_bytes());
    }
    Ok(dir.to_string_lossy().to_string())
}

/// Reads the remembered folder, falling back to the app's own workspace.
#[tauri::command]
fn current_agent_workspace(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    if let Ok(cfg) = app.path().app_config_dir() {
        if let Ok(saved) = std::fs::read_to_string(cfg.join("workspace.txt")) {
            let p = std::path::PathBuf::from(saved.trim());
            if p.is_dir() {
                return Ok(p.to_string_lossy().to_string());
            }
        }
    }
    agent_workspace(app)
}

/* ---------- Google sign-in (OAuth 2.0 + PKCE) ---------- */

/// Opens the browser, waits for the loopback redirect and returns tokens.
#[tauri::command]
async fn google_sign_in(
    app: tauri::AppHandle,
    client_id: String,
    client_secret: Option<String>,
) -> Result<oauth::SignInResult, String> {
    if client_id.trim().is_empty() {
        return Err("OAuth client ID is required".into());
    }
    oauth::run_flow(app, client_id, client_secret.unwrap_or_default()).await
}

/// Refreshes an expired Google access token.
#[tauri::command]
async fn google_refresh(
    client_id: String,
    client_secret: Option<String>,
    refresh_token: String,
) -> Result<oauth::Tokens, String> {
    let mut tokens =
        oauth::refresh(&client_id, &client_secret.unwrap_or_default(), &refresh_token).await?;
    tokens.email = oauth::fetch_email(&tokens.access_token).await;
    Ok(tokens)
}

/* ---------- Google model discovery ---------- */

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct GoogleModel {
    pub model_id: String,
    pub name: String,
    pub meta: String,
}

/// Lists Gemini models for an OAuth access token or a plain API key.
#[tauri::command]
async fn list_google_models(
    base_url: Option<String>,
    access_token: Option<String>,
    api_key: Option<String>,
) -> Result<Vec<GoogleModel>, String> {
    let base = base_url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| "https://generativelanguage.googleapis.com".into());
    let base = base.trim_end_matches('/').to_string();

    let token = access_token.filter(|t| !t.trim().is_empty());
    let key = api_key.filter(|k| !k.trim().is_empty());

    let url = match (&token, &key) {
        (Some(_), _) => format!("{base}/v1beta/models?pageSize=200"),
        (None, Some(k)) => format!(
            "{base}/v1beta/models?pageSize=200&key={}",
            urlencoding::encode(k.trim())
        ),
        (None, None) => return Err("Sign in with Google or provide an API key first".into()),
    };

    let mut req = reqwest::Client::new().get(&url);
    if let Some(t) = &token {
        req = req.bearer_auth(t.trim());
    }

    let res = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "Google returned {status}: {}",
            body.split_whitespace().collect::<Vec<_>>().join(" ")
        ));
    }

    #[derive(serde::Deserialize)]
    struct RawModel {
        name: String,
        #[serde(rename = "displayName")]
        display_name: Option<String>,
        #[serde(rename = "inputTokenLimit")]
        input_token_limit: Option<i64>,
        #[serde(rename = "supportedGenerationMethods")]
        methods: Option<Vec<String>>,
    }

    let raw: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("bad JSON: {e}"))?;
    let list = raw["models"].as_array().cloned().unwrap_or_default();

    let mut out: Vec<GoogleModel> = list
        .into_iter()
        .filter_map(|m| serde_json::from_value::<RawModel>(m).ok())
        // Only Gemini models that can actually generate content belong here.
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
            GoogleModel {
                name: m.display_name.unwrap_or_else(|| id.clone()),
                model_id: id,
                meta,
            }
        })
        .collect();

    out.sort_by(|a, b| a.model_id.cmp(&b.model_id));
    if out.is_empty() {
        return Err("No chat-capable Gemini models were returned".into());
    }
    Ok(out)
}

/* ---------- Inference ---------- */

/// Streams a completion from the selected provider.
///
/// Deltas arrive as `chat://delta` events keyed by `request_id`; the closing
/// `chat://done` (or `chat://error`) ends the turn.
#[tauri::command]
async fn chat_stream(
    app: tauri::AppHandle,
    request_id: String,
    provider: chat::ProviderConfig,
    turns: Vec<chat::ChatTurn>,
) -> Result<(), String> {
    // Live runs feed the tray menu ("agents running right now"). Title
    // generation ("title-*") is plumbing, not an agent the user started,
    // so it stays out of the tray.
    let is_agent_run = !request_id.starts_with("title-");
    if is_agent_run {
        runs::start(&request_id, &format!("chat · {}", provider.model));
        tray::refresh(&app);
    }
    let out = chat::stream_chat(app.clone(), request_id.clone(), provider, turns).await;
    if is_agent_run {
        runs::stop(&request_id);
        tray::refresh(&app);
    }
    out
}

/// Runs the agent loop: the model can read, write and run commands, and its
/// progress arrives as `agent://text`, `agent://step`, `agent://done` events.
#[tauri::command]
async fn agent_run(
    app: tauri::AppHandle,
    run_id: String,
    request: agent::AgentRequest,
    turns: Vec<chat::ChatTurn>,
) -> Result<(), String> {
    // Live runs feed the tray menu ("agents running right now").
    runs::start(&run_id, &format!("agent · {}", request.model));
    tray::refresh(&app);
    let out = agent::run_agent(app.clone(), run_id.clone(), request, turns).await;
    runs::stop(&run_id);
    tray::refresh(&app);
    out
}

/// The user's answer to an `agent://confirm` request (allow/deny a command).
#[tauri::command]
fn agent_confirm(run_id: String, approve: bool) {
    agent::resolve_confirm(&run_id, approve);
}

/// Stops a running generation (the Stop button). Works for both the agent loop
/// and plain chat streams, which are keyed by the same id.
#[tauri::command]
fn stop_generation(run_id: String) {
    cancel::request(&run_id);
}

/* ---------- Dictation ---------- */

/// Transcribes recorded audio through an OpenAI-compatible
/// `POST /audio/transcriptions` endpoint (Whisper-style).
///
/// WebView2 has no Web Speech API, so dictation records audio in the frontend
/// and sends the blob here; the request goes through reqwest directly, which
/// sidesteps any CORS or capability restrictions of the webview.
#[tauri::command]
async fn transcribe_audio(
    base_url: String,
    api_key: String,
    model: String,
    language: Option<String>,
    audio_base64: String,
    mime: String,
) -> Result<String, String> {
    use base64::Engine;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_base64)
        .map_err(|e| format!("bad audio payload: {e}"))?;
    if bytes.is_empty() {
        return Err("empty audio".into());
    }

    let base = base_url.trim_end_matches('/');
    let url = format!("{base}/audio/transcriptions");
    let ext = match mime.as_str() {
        "audio/ogg" => "ogg",
        "audio/mp4" | "audio/m4a" => "m4a",
        "audio/mp3" | "audio/mpeg" => "mp3",
        _ => "webm",
    };
    let model = if model.trim().is_empty() { "whisper-1" } else { model.trim() };

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(format!("dictation.{ext}"))
        .mime_str(&mime)
        .map_err(|e| format!("cannot attach audio: {e}"))?;

    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model.to_string());
    if let Some(lang) = language.filter(|l| !l.trim().is_empty()) {
        form = form.text("language", lang.trim().to_string());
    }

    let mut req = reqwest::Client::new().post(&url).multipart(form);
    if !api_key.trim().is_empty() {
        req = req.bearer_auth(api_key.trim());
    }

    let res = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("transcription returned {status}: {body}"));
    }
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(|t| t.to_string()))
        .ok_or_else(|| format!("unexpected transcription response: {body}"))
}

pub fn run() {
    let migrations = db::migrations();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        // Folder picker for choosing the agent workspace.
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(db::DB_URL, migrations)
                .build(),
        )
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
            }
            // The tray keeps the app alive after the window closes: runs keep
            // streaming, and the menu shows them plus version and Quit.
            tray::init(app.handle())?;
            match db::db_path(app.handle()) {
                Ok(p) => println!("[singularity] database: {p}"),
                Err(e) => eprintln!("[singularity] database path unavailable: {e}"),
            }
            Ok(())
        })
        // Closing the window hides it instead of exiting; the process lives on
        // in the tray until the user picks "Quit Singularity" there.
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            database_path,
            agent_workspace,
            set_agent_workspace,
            current_agent_workspace,
            google_sign_in,
            google_refresh,
            list_google_models,
            discovery::list_provider_models,
            agent_run,
            agent_confirm,
            stop_generation,
            transcribe_audio,
            chat_stream
        ])
        .run(tauri::generate_context!())
        .expect("error while running singularity");
}