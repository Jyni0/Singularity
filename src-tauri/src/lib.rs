/// Singularity — Next-Gen Agentic Desktop.
/// Agent Harness Layer entry point.
mod agent;
mod cancel;
mod chat;
mod limiter;
mod db;
mod discovery;
mod oauth;
mod runs;
mod ssh;
mod stt;
mod vault;
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

/* ---------- Dictation (fully local) ---------- */

/// Transcribes recorded audio on-device with Whisper.cpp — no cloud service,
/// no API key, nothing leaves the machine.
///
/// WebView2 has no Web Speech API, so dictation records the mic in the
/// frontend, encodes a 16 kHz mono WAV and hands the raw bytes here. The GGML
/// model is downloaded once (into the app data dir) and reused.
#[tauri::command]
async fn transcribe_audio(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    // The audio arrives as the raw IPC body (Tauri v2 binary invoke); the
    // language hint rides in a header set by the frontend.
    let audio = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("dictation expects a raw audio body".into()),
    };
    let language = request
        .headers()
        .get("x-dictation-language")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    stt::transcribe(app, audio, language).await
}

/* ---------- SSH Client mode ---------- */

/// Connects (or reuses a pooled session) to a saved server. The frontend
/// never sends credentials here — Rust reads them from the database, so the
/// audit log and the agent tool see the exact same stored units.
#[tauri::command]
async fn ssh_connect(app: tauri::AppHandle, server_id: String) -> Result<(), String> {
    ssh::connect(&app, "user", &server_id).await
}

/// Disconnects a pooled session (idempotent — an unknown id is a no-op).
#[tauri::command]
async fn ssh_disconnect(app: tauri::AppHandle, server_id: String) -> Result<(), String> {
    ssh::disconnect(&app, "user", &server_id).await
}

/// Runs one command on a server, auto-connecting when needed.
#[tauri::command]
async fn ssh_exec(app: tauri::AppHandle, server_id: String, command: String) -> Result<String, String> {
    ssh::exec(&app, "user", &server_id, &command).await
}

/// Server ids with a live connection — the Units grid paints status from it.
#[tauri::command]
fn ssh_connected(app: tauri::AppHandle) -> Vec<String> {
    let _ = app;
    ssh::connected_ids()
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
            // Warm up local dictation in the background (download + load the
            // Whisper model) so the first mic press is instant. Never blocks
            // startup and swallows its own errors — dictation just retries on use.
            let stt_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                stt::preload(stt_handle).await;
            });
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
            tray::tray_state,
            tray::tray_action,
            tray::tray_resize,
            ssh_connect,
            ssh_disconnect,
            ssh_exec,
            ssh_connected,
            ssh::ssh_list_servers,
            ssh::ssh_save_server,
            ssh::ssh_delete_server,
            ssh::ssh_list_keys,
            ssh::ssh_save_key,
            ssh::ssh_delete_key,
            ssh::ssh_get_key,
            ssh::ssh_derive_public,
            ssh::ssh_generate_key,
            ssh::ssh_detect_os,
            ssh::ssh_list_scripts,
            ssh::ssh_save_script,
            ssh::ssh_delete_script,
            ssh::ssh_run_script,
            ssh::ssh_shell_open,
            ssh::ssh_shell_input,
            ssh::ssh_shell_resize,
            ssh::ssh_shell_snapshot,
            ssh::ssh_shell_close,
            ssh::ssh_shell_list,
            ssh::ssh_sftp_list,
            ssh::ssh_sftp_home,
            ssh::ssh_sftp_download,
            ssh::ssh_sftp_upload,
            ssh::ssh_sftp_read_text,
            ssh::ssh_sftp_rename,
            ssh::ssh_sftp_remove,
            ssh::ssh_sftp_mkdir,
            ssh::ssh_vault_status,
            chat_stream
        ])
        .run(tauri::generate_context!())
        .expect("error while running singularity");
}