//! Self-update from GitHub Releases.
//!
//! Publishing an update = creating a release on the repo with a tag like
//! `v0.3.0` and attaching the installer(s). The app compares the tag with its
//! own version (tauri.conf.json → `version`), picks the asset for this OS/CPU,
//! downloads it and launches it, then exits so the installer can replace it.
//!
//! The download URL never comes from the webview: `update_install` re-reads
//! the latest release itself, so a compromised page can't make the app fetch
//! and run an arbitrary file.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

const REPO: &str = "Jyni0/Singularity";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize, Clone)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub version: String,
    pub title: String,
    pub notes: String,
    pub page: String,
    pub asset: String,
    pub size: u64,
}

/// `v1.2.3` / `1.2.3-beta` → [1, 2, 3]; missing parts count as 0.
fn parse_version(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split(['-', '+'])
        .next()
        .unwrap_or("")
        .split('.')
        .map(|p| p.parse().unwrap_or(0))
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let (mut a, mut b) = (parse_version(latest), parse_version(current));
    let n = a.len().max(b.len());
    a.resize(n, 0);
    b.resize(n, 0);
    a > b
}

/// Installer extensions this OS can run, best first.
fn wanted_extensions() -> &'static [&'static str] {
    if cfg!(target_os = "windows") {
        &[".exe", ".msi"]
    } else if cfg!(target_os = "macos") {
        &[".dmg"]
    } else {
        &[".appimage", ".deb", ".rpm"]
    }
}

/// Name fragments that mark an asset as built for another CPU.
fn foreign_arch_tokens() -> &'static [&'static str] {
    if cfg!(target_arch = "aarch64") {
        &["x64", "x86_64", "amd64", "i686", "x86"]
    } else {
        &["arm64", "aarch64", "i686"]
    }
}

/// Picks the installer for this machine: first by extension preference, then
/// skipping assets whose name targets another CPU architecture.
fn pick_asset(assets: &[Asset]) -> Option<Asset> {
    for ext in wanted_extensions() {
        // Sidecars like `app.exe.sig` or `app.nsis.zip` fail the extension test.
        let all: Vec<&Asset> = assets
            .iter()
            .filter(|a| a.name.to_lowercase().ends_with(ext))
            .collect();
        let native = all.iter().find(|a| {
            let n = a.name.to_lowercase();
            !foreign_arch_tokens().iter().any(|t| n.contains(t))
        });
        if let Some(a) = native.or(all.first()) {
            return Some((*a).clone());
        }
    }
    None
}

async fn latest_release() -> Result<Option<Release>, String> {
    let res = reqwest::Client::new()
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("User-Agent", "Singularity-updater")
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("GitHub unreachable: {e}"))?;
    // 404 = the repo has no published release yet.
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(format!("GitHub answered {}", res.status()));
    }
    let rel: Release = res.json().await.map_err(|e| format!("Bad release data: {e}"))?;
    Ok((!rel.draft && !rel.prerelease).then_some(rel))
}

/// First `1.2` / `1.2.3`-style number in a string ("v0.3.0", "Singularity_0.3.0_x64-setup.exe").
fn version_in(text: &str) -> Option<String> {
    let re = regex::Regex::new(r"\d+(?:\.\d+)+").ok()?;
    re.find(text).map(|m| m.as_str().to_string())
}

/// The release's version: its tag when that holds one; otherwise the
/// installer's file name (the bundler stamps the real build version there),
/// then the release title. A tag like "Release" carries no version at all.
fn release_version(rel: &Release, asset: &Asset) -> Option<String> {
    version_in(&rel.tag_name)
        .or_else(|| version_in(&asset.name))
        .or_else(|| rel.name.as_deref().and_then(version_in))
}

/// The newer release with an installer for this OS, if there is one.
async fn find_update(current: &str) -> Result<Option<(Release, Asset, String)>, String> {
    let Some(rel) = latest_release().await? else { return Ok(None) };
    let Some(asset) = pick_asset(&rel.assets) else { return Ok(None) };
    let Some(version) = release_version(&rel, &asset) else { return Ok(None) };
    if !is_newer(&version, current) {
        return Ok(None);
    }
    Ok(Some((rel, asset, version)))
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let current = app.package_info().version.to_string();
    Ok(find_update(&current).await?.map(|(rel, asset, version)| UpdateInfo {
        title: format!("Singularity {version}"),
        version,
        notes: rel.body.unwrap_or_default(),
        page: rel.html_url,
        asset: asset.name,
        size: asset.size,
        current,
    }))
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: u64,
}

/// Downloads the installer for the latest release, starts it and quits.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let current = app.package_info().version.to_string();
    let (_, asset, _) = find_update(&current)
        .await?
        .ok_or("No newer release for this system")?;

    // Only ever download from GitHub itself.
    if !asset.browser_download_url.starts_with("https://github.com/") {
        return Err("Unexpected download location".into());
    }
    // Asset names come from GitHub; keep just a safe file name.
    let file_name: String = asset
        .name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' })
        .collect();
    let dir = std::env::temp_dir().join("singularity-update");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let path = dir.join(&file_name);

    let res = reqwest::Client::new()
        .get(&asset.browser_download_url)
        .header("User-Agent", "Singularity-updater")
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Download failed: {}", res.status()));
    }
    let total = res.content_length().unwrap_or(asset.size);
    let mut file = tokio::fs::File::create(&path).await.map_err(|e| e.to_string())?;
    let mut stream = res.bytes_stream();
    let mut downloaded = 0u64;
    let mut last_emit = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emit > 256 * 1024 || downloaded == total {
            last_emit = downloaded;
            let _ = app.emit("update://progress", Progress { downloaded, total });
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if asset.size > 0 && downloaded != asset.size {
        let _ = tokio::fs::remove_file(&path).await;
        return Err("Download incomplete — try again".into());
    }

    launch_installer(&path)?;
    // Give the installer a moment to start, then leave so it can replace us.
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    app.exit(0);
    Ok(())
}

fn launch_installer(path: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    let lower = path.to_string_lossy().to_lowercase();
    let spawn = |cmd: &mut Command| cmd.spawn().map(|_| ()).map_err(|e| format!("Could not start the installer: {e}"));

    if lower.ends_with(".msi") {
        return spawn(Command::new("msiexec").arg("/i").arg(path));
    }
    if lower.ends_with(".exe") {
        return spawn(&mut Command::new(path));
    }
    if lower.ends_with(".dmg") {
        return spawn(Command::new("open").arg(path));
    }
    if lower.ends_with(".appimage") {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Running from an AppImage: swap the file in place and relaunch it.
            let target = std::env::var_os("APPIMAGE").map(std::path::PathBuf::from);
            let run = match target {
                Some(t) => {
                    std::fs::copy(path, &t).map_err(|e| format!("Could not replace the AppImage: {e}"))?;
                    t
                }
                None => path.to_path_buf(),
            };
            std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
            return spawn(&mut Command::new(run));
        }
    }
    // .deb / .rpm: hand to the system's package installer.
    spawn(Command::new("xdg-open").arg(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(is_newer("v0.3.0", "0.2.0"));
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(is_newer("1.0", "0.9.9"));
        assert!(!is_newer("v0.2.0", "0.2.0"));
        assert!(!is_newer("0.1.9", "0.2.0"));
    }

    #[test]
    fn version_from_asset_when_tag_has_none() {
        let rel = Release {
            tag_name: "Release".into(),
            name: Some("Release 0.2.0".into()),
            body: None,
            html_url: String::new(),
            draft: false,
            prerelease: false,
            assets: vec![],
        };
        let asset = Asset { name: "Singularity_0.3.0_x64-setup.exe".into(), browser_download_url: String::new(), size: 1 };
        assert_eq!(release_version(&rel, &asset).as_deref(), Some("0.3.0"));
        let tagged = Release { tag_name: "v0.4.1".into(), ..rel };
        assert_eq!(release_version(&tagged, &asset).as_deref(), Some("0.4.1"));
    }

    #[test]
    fn picks_installer() {
        let a = |n: &str| Asset { name: n.into(), browser_download_url: String::new(), size: 1 };
        let assets = [
            a("Singularity_0.3.0_x64_en-US.msi"),
            a("Singularity_0.3.0_arm64-setup.exe"),
            a("Singularity_0.3.0_x64-setup.exe"),
            a("Singularity_0.3.0_x64-setup.nsis.zip"),
            a("Singularity_0.3.0_aarch64.dmg"),
        ];
        let got = pick_asset(&assets).unwrap().name;
        if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
            assert_eq!(got, "Singularity_0.3.0_x64-setup.exe");
        }
    }
}
