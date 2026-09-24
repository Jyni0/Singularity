//! System tray: the app keeps working when the window is closed.
//!
//! Closing the main window hides it instead of exiting, so background
//! generations survive. The tray icon then is the whole UI surface:
//!
//! * left click — bring the window back;
//! * menu — app version, the list of agents running right now,
//!   "Show" and a real "Quit".
//!
//! The menu is rebuilt whenever a run starts or finishes, so it never lies.

use crate::runs;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

pub const TRAY_ID: &str = "main-tray";

const ID_SHOW: &str = "show";
const ID_QUIT: &str = "quit";

/// Builds the current tray menu: version header, live runs, actions.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let version = app.package_info().version.to_string();

    // Header is a disabled item so it renders as inert text on every platform.
    let header = MenuItem::with_id(
        app,
        "header",
        format!("Singularity v{version}"),
        false,
        None::<&str>,
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;

    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<_>>> = Vec::new();

    let live = runs::snapshot();
    if live.is_empty() {
        let none = MenuItem::with_id(app, "no-runs", "No agents running", false, None::<&str>)?;
        items.push(Box::new(none));
    } else {
        let title = MenuItem::with_id(
            app,
            "runs-title",
            format!("Running agents: {}", live.len()),
            false,
            None::<&str>,
        )?;
        items.push(Box::new(title));
        for run in live.iter() {
            // The run id doubles as the menu item id — disabled items never
            // fire events, so it just keeps every row uniquely addressable.
            let item = MenuItem::with_id(
                app,
                &run.run_id,
                format!("  ●  {}", run.label),
                false,
                None::<&str>,
            )?;
            items.push(Box::new(item));
        }
    }

    let sep2 = PredefinedMenuItem::separator(app)?;
    let show = MenuItem::with_id(app, ID_SHOW, "Show window", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "Quit Singularity", true, None::<&str>)?;

    let mut all: Vec<&dyn tauri::menu::IsMenuItem<_>> = vec![&header, &sep1];
    all.extend(items.iter().map(|b| b.as_ref()));
    all.push(&sep2);
    all.push(&show);
    all.push(&quit);

    Menu::with_items(app, &all)
}

/// Replaces the tray's menu with a freshly built one.
pub fn refresh(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_menu(app) {
            let _ = tray.set_menu(Some(menu));
            let n = runs::count();
            let tooltip = if n == 0 {
                "Singularity".to_string()
            } else {
                format!("Singularity - {n} agent(s) running")
            };
            let _ = tray.set_tooltip(Some(tooltip));
        }
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

/// Creates the tray icon and wires its events. Called once from setup.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Singularity")
        .on_menu_event(|app, event| match event.id.as_ref() {
            ID_SHOW => show_main(app),
            ID_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // A left click brings the window back; any click first rebuilds
            // the menu so the runs list is current by the time it opens.
            if let TrayIconEvent::Click { .. } = event {
                refresh(tray.app_handle());
            }
            if let TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
