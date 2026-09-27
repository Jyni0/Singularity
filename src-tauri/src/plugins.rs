//! One-click add-ons (Settings → Plugins): npm-published MCP servers are
//! installed into the app's own folder and started as `node <bin>`.
//!
//! `npx -y <pkg>` was the obvious way, but on Windows it kept failing after
//! the download — "'playwright-mcp' is not recognized as an internal or
//! external command" — because npx hands the package's bin shim to cmd.exe
//! and that lookup breaks easily (PATH/PATHEXT of a GUI app, cache races
//! when several servers start at once). A local install also starts in a
//! second instead of re-resolving the package on every launch.

use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, serde::Serialize)]
pub struct Installed {
    /// Absolute path of node.
    pub command: String,
    /// `[<bin script>]` — the caller appends the server's own arguments.
    pub args: Vec<String>,
}

/// `@playwright/mcp@latest` → `@playwright/mcp`; `tavily-mcp@0.2` → `tavily-mcp`.
fn package_name(spec: &str) -> &str {
    let start = if spec.starts_with('@') { 1 } else { 0 };
    match spec[start..].find('@') {
        Some(i) => &spec[..start + i],
        None => spec,
    }
}

/// The package's executable script: `bin` is a string or a map; with
/// several entries the one mentioning "mcp" wins.
fn bin_of(pkg_dir: &Path, name: &str) -> Result<PathBuf, String> {
    let manifest = std::fs::read_to_string(pkg_dir.join("package.json"))
        .map_err(|e| format!("{name} was not installed correctly: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&manifest).map_err(|e| format!("bad package.json of {name}: {e}"))?;
    let rel = match &v["bin"] {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(map) => {
            let short = name.rsplit('/').next().unwrap_or(name);
            map.iter()
                .find(|(k, _)| k.as_str() == short)
                .or_else(|| map.iter().find(|(k, _)| k.contains("mcp")))
                .or_else(|| map.iter().next())
                .and_then(|(_, p)| p.as_str().map(str::to_string))
                .ok_or_else(|| format!("{name} has no executable"))?
        }
        _ => return Err(format!("{name} has no executable (no \"bin\" in package.json)")),
    };
    let path = pkg_dir.join(rel);
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("{name}: {} is missing", path.display()))
    }
}

/// Installs (or updates) an npm package for add-on `id` and returns how to
/// start it.
#[tauri::command]
pub async fn plugin_install(app: AppHandle, id: String, package: String) -> Result<Installed, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("bad plugin id".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no data directory: {e}"))?
        .join("plugins")
        .join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let manifest = dir.join("package.json");
    if !manifest.is_file() {
        std::fs::write(&manifest, "{ \"private\": true }\n").map_err(|e| e.to_string())?;
    }

    let node = crate::mcp::resolve_program("node");
    if !node.is_absolute() {
        return Err("Node.js was not found — install it from nodejs.org and restart the app.".into());
    }
    let npm = crate::mcp::resolve_program("npm");
    let mut cmd = tokio::process::Command::new(&npm);
    cmd.args(["install", "--no-audit", "--no-fund", "--omit=dev", "--loglevel=error", &package])
        .current_dir(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = tokio::time::timeout(INSTALL_TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("npm install {package} took longer than {} minutes", INSTALL_TIMEOUT.as_secs() / 60))?
        .map_err(|e| format!("cannot run npm ({}): {e}", npm.display()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        let tail: String = err.chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!("npm install {package} failed:\n{tail}"));
    }

    let name = package_name(&package);
    let bin = bin_of(&dir.join("node_modules").join(name), name)?;
    Ok(Installed {
        command: node.display().to_string(),
        args: vec![bin.display().to_string()],
    })
}

#[cfg(test)]
mod tests {
    use super::package_name;

    #[test]
    fn package_names() {
        assert_eq!(package_name("@playwright/mcp@latest"), "@playwright/mcp");
        assert_eq!(package_name("@upstash/context7-mcp"), "@upstash/context7-mcp");
        assert_eq!(package_name("tavily-mcp@0.2.1"), "tavily-mcp");
        assert_eq!(package_name("chrome-devtools-mcp"), "chrome-devtools-mcp");
    }
}
