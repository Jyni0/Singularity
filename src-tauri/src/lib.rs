/// Singularity — Next-Gen Agentic Desktop.
/// Agent Harness Layer entry point.
mod agent;
mod cancel;
mod chat;
mod cli;
mod limiter;
mod mcp;
mod db;
mod discovery;
mod oauth;
mod bg;
mod syntax;
mod pricing;
mod plugins;
mod runs;
mod safety;
mod skills;
mod stt;
mod vault;
mod tools;
mod tray;
mod updater;
mod utf8stream;
mod web;
mod imagegen;

use tauri::Manager;

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

/// Files and folders of a workspace for the prompt box's @-mention picker.
#[tauri::command]
async fn workspace_files(root: String) -> Result<Vec<String>, String> {
    let dir = std::path::PathBuf::from(&root);
    if !dir.is_dir() {
        return Err(format!("not a folder: {root}"));
    }
    tokio::task::spawn_blocking(move || tools::workspace_files(&dir))
        .await
        .map_err(|e| e.to_string())
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

/// The context gauge: what the next request of a conversation would carry.
#[tauri::command]
async fn agent_context(
    app: tauri::AppHandle,
    request: agent::AgentRequest,
    turns: Vec<chat::ChatTurn>,
) -> Result<Vec<agent::ContextPart>, String> {
    agent::agent_context(app, request, turns).await
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
/// Live state of a run for WebView re-attach: after a page reload the frontend
/// lost every event emitted before it — this returns the buffered transcript
/// of a STILL-RUNNING run so the chat can rebuild and keep listening.
#[tauri::command]
fn agent_snapshot(run_id: String) -> Option<Vec<runs::RunEvent>> {
    runs::events(&run_id)
}

/// True while a terminal has keyboard focus — only then does Ctrl+Shift+C
/// belong to the page (terminal copy) instead of the browser.
static TERMINAL_FOCUSED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The frontend reports terminal focus changes (see TerminalView).
#[tauri::command]
fn terminal_focus(focused: bool) {
    TERMINAL_FOCUSED.store(focused, std::sync::atomic::Ordering::Relaxed);
}

/// All currently live run ids — the frontend polls this once on boot to find
/// runs that survived a reload.
#[tauri::command]
fn agent_live_runs() -> Vec<String> {
    runs::snapshot().into_iter().map(|r| r.run_id).collect()
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

/// Logs to stderr. Filter with RUST_LOG (default: this crate at info), e.g.
/// `RUST_LOG=singularity_lib::agent=debug` for per-step agent detail.
fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("singularity_lib=info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).try_init();
}

pub fn run() {
    init_tracing();
    let migrations = db::migrations();

    tauri::Builder::default()
        // ONE app: a second launch (shortcut, installer "run", autostart)
        // only brings the running window forward and exits — every extra
        // process used to add its own taskbar button and tray icon.
        // Registered first, as the plugin requires.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main(app);
        }))
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
                #[cfg(windows)]
                keep_find_keys_for_the_page(&window);
            }
            // The tray keeps the app alive after the window closes: runs keep
            // streaming, and the menu shows them plus version and Quit.
            tray::init(app.handle())?;
            // Where downloaded vendor CLIs live; progress events go to the UI.
            cli::init(app.handle());
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
            agent_workspace,
            imagegen::read_generated_image,
            imagegen::save_generated_image,
            agent_context,
            pricing::model_info,
            plugins::plugin_install,
            set_agent_workspace,
            current_agent_workspace,
            google_sign_in,
            google_refresh,
            discovery::list_provider_models,
            cli::cli_status,
            cli::cli_install,
            cli::cli_login,
            cli::cli_logout,
            cli::cli_usage,
            cli::cli_end_chat,
            cli::cli_chat_sessions,
            agent_run,
            agent_confirm,
            agent_snapshot,
            agent_live_runs,
            terminal_focus,
            stop_generation,
            transcribe_audio,
            tray::tray_state,
            updater::update_check,
            updater::update_install,
            skills::skills_list,
            skills::skills_get,
            skills::skills_save,
            skills::skills_delete,
            skills::skills_set_enabled,
            skills::skills_import,
            skills::skills_folder,
            mcp::mcp_list,
            mcp::mcp_save,
            mcp::mcp_delete,
            mcp::mcp_test,
            workspace_files,
            tray::tray_action,
            tray::tray_resize,
            bg::bg_list,
            bg::bg_output,
            bg::bg_stop,
            bg::bg_remove,
            vault::vault_seal,
            vault::vault_open,
            chat_stream
        ])
        .build(tauri::generate_context!())
        .expect("error while building singularity")
        .run(|app_handle, event| {
            // MCP servers are child processes — stop them with the app.
            if let tauri::RunEvent::Exit = event {
                mcp::shutdown();
                // Background tasks the agent started die with the app too.
                bg::shutdown();
                // Remove the tray icon explicitly: an icon the process never
                // removed stays as a "ghost" in the tray until hovered.
                if let Some(tray) = app_handle.remove_tray_by_id(tray::TRAY_ID) {
                    let _ = tray.set_visible(false);
                }
            }
        });
}

/// WebView2 opens its own find bar on Ctrl+F before the page can say no —
/// preventDefault in JS does not stop it. Turn the browser handling of the
/// find keys off: the key still reaches the page, so the app's own search
/// (SFTP filter, code editor search) gets it instead.
#[cfg(windows)]
fn keep_find_keys_for_the_page(window: &tauri::WebviewWindow) {
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2AcceleratorKeyPressedEventArgs2;
    use windows_core::Interface;

    const VK_F: u32 = 0x46;
    const VK_G: u32 = 0x47;
    const VK_F3: u32 = 0x72;
    const VK_C: u32 = 0x43;

    let _ = window.with_webview(|webview| unsafe {
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut key = 0u32;
            args.VirtualKey(&mut key)?;
            // The event only fires for accelerators (Ctrl/Alt combos and
            // function keys), so a bare F/G typed into a field never lands here.
            // Ctrl+Shift+C is DevTools' "inspect element" — a focused
            // terminal copies with it, so there the browser must not take it
            // first. Everywhere else it keeps its usual meaning.
            let shift = windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyState(0x10) < 0;
            let terminal = TERMINAL_FOCUSED.load(std::sync::atomic::Ordering::Relaxed);
            if matches!(key, VK_F | VK_G | VK_F3) || (key == VK_C && shift && terminal) {
                if let Ok(args2) = args.cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>() {
                    args2.SetIsBrowserAcceleratorKeyEnabled(false)?;
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(e) = webview.controller().add_AcceleratorKeyPressed(&handler, &mut token) {
            eprintln!("[singularity] cannot hook find keys: {e}");
        }
    });
}
