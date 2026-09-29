//! Background download of the CLIs from the vendors' own distribution
//! channels into `<app local data>/cli/<id>/<version>`:
//!
//! * Codex and Claude Code publish a native binary per platform as an npm
//!   package (`@openai/codex@<v>-win32-x64`, `@anthropic-ai/claude-code-win32-x64`),
//!   fetched straight from the npm registry — no Node needed. Checked against
//!   the registry's SHA-512 integrity.
//! * Antigravity CLI (`agy`) comes from Google's release manifest (the one its
//!   install script reads): a native binary (Windows) or a .tar.gz (macOS,
//!   Linux), checked against the manifest's SHA-512.

use super::{progress, root, Cli, Launch};
use base64::Engine;
use futures_util::StreamExt;
use sha2::{Digest, Sha512};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tokio::io::AsyncWriteExt;

const EXE: &str = if cfg!(windows) { ".exe" } else { "" };
const REGISTRY: &str = "https://registry.npmjs.org";
const AGY_MANIFESTS: &str = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

/// One install at a time; the set says which CLI is being fetched.
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static INSTALLING: Mutex<Vec<Cli>> = Mutex::new(Vec::new());

pub fn is_installing(cli: Cli) -> bool {
    INSTALLING.lock().unwrap().contains(&cli)
}

struct Busy(Cli);

impl Busy {
    fn new(cli: Cli) -> Self {
        INSTALLING.lock().unwrap().push(cli);
        Busy(cli)
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        INSTALLING.lock().unwrap().retain(|c| *c != self.0);
    }
}

/// npm's names for this machine: ("win32" | "darwin" | "linux", "x64" | "arm64").
fn platform() -> Result<(&'static str, &'static str), String> {
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        "linux" => "linux",
        other => return Err(format!("{other} is not supported by the vendor CLIs")),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => return Err(format!("{other} CPUs are not supported by the vendor CLIs")),
    };
    Ok((os, arch))
}

/* ---------- Installed copies ---------- */

fn current(dir: &Path) -> Option<PathBuf> {
    let ver = std::fs::read_to_string(dir.join("current")).ok()?;
    let p = dir.join(ver.trim());
    p.is_dir().then_some(p)
}

/// The app's own copy of a CLI, if one was installed.
pub fn managed(cli: Cli) -> Option<Launch> {
    let pkg = current(&root().join(cli.id()))?;
    let bin = match cli {
        // vendor/<target-triple>/bin/codex(.exe)
        Cli::Codex => std::fs::read_dir(pkg.join("vendor")).ok()?.flatten().find_map(|d| {
            [d.path().join("bin"), d.path().join("codex")]
                .into_iter()
                .map(|b| b.join(format!("codex{EXE}")))
                .find(|p| p.is_file())
        })?,
        Cli::Claude => pkg.join(format!("claude{EXE}")),
        // The Unix archives name the binary `antigravity`.
        Cli::Antigravity => [pkg.join(format!("agy{EXE}")), pkg.join("antigravity")]
            .into_iter()
            .find(|p| p.is_file())?,
    };
    bin.is_file().then(|| Launch::direct(bin, "managed"))
}

/* ---------- Install ---------- */

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("Singularity/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// The newest version the vendor publishes, named like the install folder.
async fn newest(http: &reqwest::Client, cli: Cli) -> Result<String, String> {
    let (os, arch) = platform()?;
    match cli {
        Cli::Codex => Ok(format!("{}-{os}-{arch}", latest(http, "@openai/codex").await?)),
        Cli::Claude => latest(http, "@anthropic-ai/claude-code").await,
        Cli::Antigravity => {
            let os = if os == "win32" { "windows" } else { os };
            let arch = if arch == "x64" { "amd64" } else { arch };
            let meta = get_json(http, &format!("{AGY_MANIFESTS}/{os}_{arch}.json")).await?;
            meta["version"].as_str().map(String::from).ok_or_else(|| "Antigravity manifest has no version".into())
        }
    }
}

/// Brings the app's own copy up to the vendor's newest release (a CLI the
/// user installed themselves is left alone). Returns true when it updated.
pub async fn update(cli: Cli) -> Result<bool, String> {
    let dir = root().join(cli.id());
    let Some(have) = std::fs::read_to_string(dir.join("current")).ok().map(|v| v.trim().to_string()) else {
        return Ok(false);
    };
    if super::resolve(cli).map(|l| l.source) != Some("managed") {
        return Ok(false);
    }
    let http = client()?;
    if newest(&http, cli).await? == have {
        return Ok(false);
    }
    let _busy = Busy::new(cli);
    let _one = LOCK.lock().await;
    match cli {
        Cli::Codex | Cli::Claude => install_npm(&http, cli, &dir).await?,
        Cli::Antigravity => install_agy(&http, &dir).await?,
    }
    progress(cli, "done", 100, format!("{} updated", cli.label()));
    Ok(true)
}

pub async fn install(cli: Cli) -> Result<Launch, String> {
    let _busy = Busy::new(cli);
    let _one = LOCK.lock().await;
    if let Some(l) = super::resolve(cli) {
        return Ok(l);
    }
    let http = client()?;
    progress(cli, "download", 0, format!("Looking up {}", cli.label()));
    let dir = root().join(cli.id());

    match cli {
        Cli::Codex | Cli::Claude => install_npm(&http, cli, &dir).await?,
        Cli::Antigravity => install_agy(&http, &dir).await?,
    }

    let launch = managed(cli).ok_or_else(|| format!("{} package has no executable for this platform", cli.label()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&launch.program, std::fs::Permissions::from_mode(0o755));
    }
    progress(cli, "done", 100, format!("{} installed", cli.label()));
    Ok(launch)
}

async fn install_npm(http: &reqwest::Client, cli: Cli, dir: &Path) -> Result<(), String> {
    let (os, arch) = platform()?;
    let (name, version) = match cli {
        Cli::Codex => {
            let v = latest(http, "@openai/codex").await?;
            ("@openai/codex".to_string(), format!("{v}-{os}-{arch}"))
        }
        _ => {
            let v = latest(http, "@anthropic-ai/claude-code").await?;
            (format!("@anthropic-ai/claude-code-{os}-{arch}"), v)
        }
    };
    let meta = get_json(http, &format!("{REGISTRY}/{}/{version}", name.replace('/', "%2f"))).await?;
    let tarball = meta["dist"]["tarball"].as_str().ok_or("registry entry has no tarball")?.to_string();
    let integrity = meta["dist"]["integrity"].as_str().unwrap_or("").to_string();

    let tmp = fresh(dir, &version)?;
    let archive = dir.join(format!("{version}.tgz"));
    progress(cli, "download", 0, format!("Downloading {} {version}", cli.label()));
    let sha512 = download_to(http, &tarball, &archive, cli).await?;
    if let Some(want) = integrity.strip_prefix("sha512-") {
        if want != base64::engine::general_purpose::STANDARD.encode(&sha512) {
            let _ = std::fs::remove_file(&archive);
            return Err(format!("{} download failed its integrity check", cli.label()));
        }
    }
    // npm tarballs keep everything under `package/`.
    unpack(cli, &archive, &tmp, true).await?;
    finish(dir, &tmp, &version)
}

/// Antigravity: `<manifests>/<os>_<arch>.json` → {version, url, sha512 (hex)}.
async fn install_agy(http: &reqwest::Client, dir: &Path) -> Result<(), String> {
    let (os, arch) = platform()?;
    let os = match os {
        "win32" => "windows",
        o => o,
    };
    let arch = if arch == "x64" { "amd64" } else { arch };
    let meta = get_json(http, &format!("{AGY_MANIFESTS}/{os}_{arch}.json")).await?;
    let version = meta["version"].as_str().ok_or("Antigravity manifest has no version")?.to_string();
    let url = meta["url"].as_str().ok_or("Antigravity manifest has no url")?.to_string();
    let want = meta["sha512"].as_str().unwrap_or("").to_lowercase();

    let tmp = fresh(dir, &version)?;
    let is_tgz = url.ends_with(".tar.gz") || url.ends_with(".tgz");
    let download = if is_tgz { dir.join(format!("{version}.tar.gz")) } else { tmp.join(format!("agy{EXE}")) };
    progress(Cli::Antigravity, "download", 0, format!("Downloading Antigravity CLI {version}"));
    let sha512 = download_to(http, &url, &download, Cli::Antigravity).await?;
    let got: String = sha512.iter().map(|b| format!("{b:02x}")).collect();
    if !want.is_empty() && got != want {
        let _ = std::fs::remove_file(&download);
        return Err("Antigravity CLI download failed its checksum".into());
    }
    if is_tgz {
        // The archive holds the bare binary, no top folder.
        unpack(Cli::Antigravity, &download, &tmp, false).await?;
    }
    finish(dir, &tmp, &version)
}

/// An empty `<dir>/<version>.part` to build the install in.
fn fresh(dir: &Path, version: &str) -> Result<PathBuf, String> {
    let tmp = dir.join(format!("{version}.part"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("cannot create {}: {e}", tmp.display()))?;
    Ok(tmp)
}

async fn unpack(cli: Cli, archive: &Path, out: &Path, strip: bool) -> Result<(), String> {
    progress(cli, "extract", 100, format!("Unpacking {}", cli.label()));
    let (src, dst) = (archive.to_path_buf(), out.to_path_buf());
    let res = tokio::task::spawn_blocking(move || extract_tgz(&src, &dst, strip))
        .await
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(archive);
    res
}

/// Moves a finished `<v>.part` into place, points `current` at it and drops
/// older versions (best effort — a running old binary stays locked).
fn finish(dir: &Path, tmp: &Path, version: &str) -> Result<(), String> {
    let dest = dir.join(version);
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(tmp, &dest).map_err(|e| format!("cannot finish install: {e}"))?;
    std::fs::write(dir.join("current"), version).map_err(|e| e.to_string())?;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.path().is_dir() && e.file_name() != version {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    Ok(())
}

async fn get_json(http: &reqwest::Client, url: &str) -> Result<serde_json::Value, String> {
    http.get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("{url}: {e}"))?
        .json()
        .await
        .map_err(|e| format!("{url}: {e}"))
}

async fn latest(http: &reqwest::Client, name: &str) -> Result<String, String> {
    let v = get_json(http, &format!("{REGISTRY}/{}/latest", name.replace('/', "%2f"))).await?;
    v["version"].as_str().map(String::from).ok_or_else(|| format!("{name}: no latest version"))
}

/// Streams `url` into `dest`, reporting percent; returns the SHA-512 digest.
async fn download_to(http: &reqwest::Client, url: &str, dest: &Path, cli: Cli) -> Result<Vec<u8>, String> {
    let res = http
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("download failed: {e}"))?;
    let total = res.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
    let mut hash = Sha512::new();
    let (mut got, mut last) = (0u64, 0u8);
    let mut body = res.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| format!("download interrupted: {e}"))?;
        hash.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if total > 0 {
            let pct = ((got * 100) / total).min(99) as u8;
            if pct != last {
                last = pct;
                progress(cli, "download", pct, format!("{} MB / {} MB", got >> 20, total >> 20));
            }
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(hash.finalize().to_vec())
}

/// Unpacks a .tar.gz, optionally dropping the top folder (`package/`).
fn extract_tgz(src: &Path, out: &Path, strip: bool) -> Result<(), String> {
    let file = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    archive.set_preserve_permissions(true);
    for entry in archive.entries().map_err(|e| format!("bad archive: {e}"))? {
        let mut entry = entry.map_err(|e| format!("bad archive: {e}"))?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        // Only plain relative parts: nothing may land outside `out`.
        let parts: Vec<_> = path
            .components()
            .filter(|c| !matches!(c, Component::CurDir))
            .skip(usize::from(strip))
            .collect();
        if parts.is_empty() || !parts.iter().all(|c| matches!(c, Component::Normal(_))) {
            continue;
        }
        let dest: PathBuf = parts.iter().fold(out.to_path_buf(), |p, c| p.join(c));
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        entry.unpack(&dest).map_err(|e| format!("cannot unpack {}: {e}", dest.display()))?;
    }
    Ok(())
}
