//! System tray: the app keeps working when the window is closed.
//!
//! The tray menu is a CUSTOM popup — a small borderless webview window
//! (`tray-menu`, built from `tray.html`) anchored to the tray icon on
//! right-click. Native Windows tray menus proved unreliable (they simply
//! refuse to open in some shell states), and a webview popup also lets the
//! menu look exactly like the app.
//!
//! * left click  — bring the main window back;
//! * right click — toggle the custom menu (version, live agents, Show, Quit);
//! * the menu hides itself when it loses focus.

use crate::runs;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

pub const TRAY_ID: &str = "main-tray";
pub const MENU_WINDOW: &str = "tray-menu";

/// Logical size of the popup — must match the layout in `TrayMenu.c.tsx`.
const MENU_W: f64 = 300.0;
const MENU_H: f64 = 340.0;

/// When the popup was last hidden (ms since epoch). Clicking the tray icon
/// while the popup is open blurs it first — the blur hides the popup, then the
/// click arrives and would instantly re-open it. Within this window the click
/// is treated as "closing", not "toggling".
static LAST_HIDDEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
const REOPEN_GUARD_MS: u64 = 350;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn mark_hidden() {
    LAST_HIDDEN.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
}

fn just_hidden() -> bool {
    now_ms().saturating_sub(LAST_HIDDEN.load(std::sync::atomic::Ordering::Relaxed)) < REOPEN_GUARD_MS
}

#[derive(Clone, serde::Serialize)]
pub struct RunRow {
    pub run_id: String,
    pub label: String,
}

#[derive(Clone, serde::Serialize)]
pub struct TrayState {
    pub version: String,
    pub runs: Vec<RunRow>,
}

/// Everything the popup renders: app version + live agent runs.
pub fn state(app: &AppHandle) -> TrayState {
    TrayState {
        version: app.package_info().version.to_string(),
        runs: runs::snapshot()
            .into_iter()
            .map(|r| RunRow { run_id: r.run_id, label: r.label })
            .collect(),
    }
}

/// Pushes a fresh state to the popup (when open) and updates the tooltip.
pub fn refresh(app: &AppHandle) {
    let _ = app.emit("tray://state", state(app));
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let n = runs::count();
        let tooltip = if n == 0 {
            "Singularity".to_string()
        } else {
            format!("Singularity - {n} agent(s) running")
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

/// Brings the main window back: un-minimize, show, focus.
pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Positions the popup just above the tray icon and shows it (or hides it
/// when it is already open — a real toggle).
fn toggle_menu(app: &AppHandle, anchor: tauri::PhysicalPosition<f64>) {
    let Some(win) = app.get_webview_window(MENU_WINDOW) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        mark_hidden();
        return;
    }
    // The blur-close beat this click by milliseconds: the user meant to close.
    if just_hidden() {
        return;
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    let w = MENU_W * scale;
    let h = MENU_H * scale;
    // Right-align to the click and open upwards (taskbar sits at the bottom);
    // flip down when there is no room above.
    let mut x = anchor.x - w + 24.0 * scale;
    let mut y = anchor.y - h - 8.0 * scale;
    if y < 0.0 {
        y = anchor.y + 8.0 * scale;
    }
    if x < 0.0 {
        x = 0.0;
    }
    let _ = win.set_size(LogicalSize::new(MENU_W, MENU_H));
    let _ = win.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
    refresh(app); // the popup reads state on mount, this covers re-opens
    let _ = win.show();
    let _ = win.set_focus();
}

/// The popup's own commands.
#[tauri::command]
pub fn tray_state(app: AppHandle) -> TrayState {
    state(&app)
}

#[tauri::command]
pub fn tray_action(app: AppHandle, action: String) {
    match action.as_str() {
        "show" => {
            if let Some(win) = app.get_webview_window(MENU_WINDOW) {
                let _ = win.hide();
            }
            show_main(&app);
        }
        "close" => {
            if let Some(win) = app.get_webview_window(MENU_WINDOW) {
                if win.is_visible().unwrap_or(false) {
                    let _ = win.hide();
                    mark_hidden();
                }
            }
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Creates the tray icon and the hidden popup window. Called once from setup.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    // The custom menu: a tiny borderless webview, invisible until right-click.
    if app.get_webview_window(MENU_WINDOW).is_none() {
        WebviewWindowBuilder::new(app, MENU_WINDOW, WebviewUrl::App("tray.html".into()))
            .title("Singularity")
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .build()?;
    }

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Singularity")
        // No native menu at all — the popup replaces it.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { position, button, button_state, .. } = event {
                // Act on release, matching normal Windows menu behavior.
                if button_state == MouseButtonState::Up {
                    match button {
                        MouseButton::Left => show_main(tray.app_handle()),
                        MouseButton::Right => toggle_menu(tray.app_handle(), position),
                        _ => {}
                    }
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
