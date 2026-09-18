/// Singularity — Next-Gen Agentic Desktop.
/// Agent Harness Layer entry point.
use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Singularity ready. Hello, {name}!")
}

/// Placeholder: probe a local Ollama gateway (localhost:11434).
/// Real implementation will live in the agent harness module.
#[tauri::command]
async fn probe_ollama() -> Result<String, String> {
    // TODO: reqwest-based health check once the gateway layer lands.
    Ok("http://localhost:11434".into())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, probe_ollama])
        .run(tauri::generate_context!())
        .expect("error while running singularity");
}
