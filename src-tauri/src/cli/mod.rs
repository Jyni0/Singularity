//! Subscription CLIs as model providers: OpenAI Codex, Claude Code and
//! Google Antigravity CLI (`agy`).
//!
//! The user signs in once with the vendor's own CLI (ChatGPT / Claude /
//! Google account); every model call then runs that CLI headless through
//! `tokio::process::Command` — no console window, JSON events on stdout —
//! behind [`CliModel`], a Rig `CompletionModel`. The chat and the agent loop
//! therefore drive these providers exactly like the HTTP ones.
//!
//! Binaries: a CLI already on PATH is used as is; otherwise the vendor's own
//! build is fetched in the background (install.rs) into the app's data
//! folder. Nothing is installed globally.

mod install;
mod model;
pub(crate) mod protocol;
mod usage;

pub use model::CliModel;

use serde::Serialize;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Cli {
    Codex,
    Claude,
    Antigravity,
}

impl Cli {
    /// Provider kinds that run through a CLI.
    pub fn from_kind(kind: &str) -> Option<Self> {
        match kind {
            "openai-cli" => Some(Cli::Codex),
            "anthropic-cli" => Some(Cli::Claude),
            "google-cli" => Some(Cli::Antigravity),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Cli::Codex => "codex",
            Cli::Claude => "claude",
            Cli::Antigravity => "antigravity",
        }
    }

    /// Executable name on PATH.
    fn bin(self) -> &'static str {
        match self {
            Cli::Codex => "codex",
            Cli::Claude => "claude",
            Cli::Antigravity => "agy",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Cli::Codex => "Codex CLI",
            Cli::Claude => "Claude Code",
            Cli::Antigravity => "Antigravity CLI",
        }
    }
}

/* ---------- Paths ---------- */

static ROOT: OnceLock<PathBuf> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Called once at startup: where managed installs live, and who hears progress.
pub fn init(app: &AppHandle) {
    let root = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("singularity"))
        .join("cli");
    let _ = ROOT.set(root);
    let _ = APP.set(app.clone());
    // Keep the app's own CLI copies current (older ones miss features the
    // app relies on, e.g. agy's read-only `/usage`).
    tauri::async_runtime::spawn(async {
        for cli in [Cli::Codex, Cli::Claude, Cli::Antigravity] {
            if let Err(e) = install::update(cli).await {
                eprintln!("[cli] {} update check failed: {e}", cli.label());
            }
        }
    });
}

/// Brings a CLI that is too old for the chosen model up to date: the app's
/// own copy through its installer, a copy on PATH through the CLI's own
/// `update` (startup updates only touch the app's copies). Returns the
/// version now installed.
pub(crate) async fn update_outdated(cli: Cli) -> Result<String, String> {
    static ONE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _one = ONE.lock().await;
    let launch = ensure(cli).await?;
    if launch.source == "managed" {
        install::update(cli).await?;
    } else {
        let args: &[&str] = match cli {
            Cli::Claude | Cli::Antigravity => &["update"],
            Cli::Codex => return Err("this Codex comes from npm — run `npm i -g @openai/codex@latest`".into()),
        };
        let (ok, text) = run_quiet(&launch, args, Duration::from_secs(300)).await?;
        if !ok {
            return Err(tail(&text, 400));
        }
    }
    let launch = resolve(cli).ok_or("the CLI is gone after updating")?;
    let (_, text) = run_quiet(&launch, &["--version"], Duration::from_secs(30)).await?;
    Ok(text.split_whitespace().next().unwrap_or("the newest version").to_string())
}

fn root() -> PathBuf {
    ROOT.get().cloned().unwrap_or_else(|| std::env::temp_dir().join("singularity-cli"))
}

/// Empty working folder for CLI runs: they never see the user's files.
fn scratch() -> PathBuf {
    let dir = root().join("scratch");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// The agy agent chat runs use (`--agent singularity`). Without it every
/// model call carried agy's own ~12k-token prompt with its 58 built-in tools
/// (measured: 12,205 tokens for "hi" vs 689 with this agent), and Gemini
/// sometimes used those tools — denied headless — instead of the app's.
pub(crate) const AGY_AGENT: &str = "singularity";
const AGY_AGENT_MD: &str = "---
name: singularity
description: Answers through the Singularity app, which runs the tools itself.
excludeDefaultComponents: true
tools: []
---

# System prompt

You answer the user of the Singularity desktop app. Follow the instructions in the user's message.
";

/// Writes the agent where agy finds project agents: the runs' working folder.
pub(crate) fn ensure_agy_agent() -> Result<(), String> {
    let file = scratch().join(".agents").join("agents").join(AGY_AGENT).join("agent.md");
    if std::fs::read_to_string(&file).ok().as_deref() == Some(AGY_AGENT_MD) {
        return Ok(());
    }
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&file, AGY_AGENT_MD).map_err(|e| e.to_string())
}

/// First `name` on PATH (with the Windows executable extensions).
fn which(name: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|e| e.to_ascii_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
        exts.iter()
            .map(|ext| dir.join(format!("{name}{ext}")))
            .find(|p| p.is_file())
    })
}

/* ---------- Launch ---------- */

/// How to start a CLI: the program plus arguments that come before ours
/// (`cmd /C codex.cmd …` for npm shims).
#[derive(Clone, Debug)]
pub struct Launch {
    pub program: PathBuf,
    pub pre_args: Vec<OsString>,
    pub source: &'static str,
}

impl Launch {
    fn direct(program: PathBuf, source: &'static str) -> Self {
        // npm shims on Windows are batch files; they need cmd to run.
        let batch = program
            .extension()
            .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
            .unwrap_or(false);
        if batch {
            Launch {
                program: PathBuf::from("cmd"),
                pre_args: vec!["/D".into(), "/C".into(), program.into_os_string()],
                source,
            }
        } else {
            Launch { program, pre_args: vec![], source }
        }
    }

    /// A hidden command: no console window, killed with its handle.
    pub fn command(&self) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(&self.program);
        cmd.args(&self.pre_args)
            .current_dir(scratch())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env("NO_COLOR", "1");
        // An app started from inside a Claude Code session inherits its
        // session variables; Claude Code then writes that session's scratchpad
        // (a fresh id per process) into every prompt, and nothing is ever
        // read back from the prompt cache.
        // The ones a user sets on purpose (auth, cloud, Git Bash) stay.
        const KEEP: [&str; 5] = [
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
            "CLAUDE_CODE_GIT_BASH_PATH",
        ];
        for (key, _) in std::env::vars_os() {
            let k = key.to_string_lossy();
            let session = k.starts_with("CLAUDE_CODE_") || k == "CLAUDECODE" || k == "CLAUDE_PID" || k == "CLAUDE_EFFORT";
            if session && !KEEP.contains(&k.as_ref()) {
                cmd.env_remove(&key);
            }
        }
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        cmd
    }
}

/// A usable CLI without installing anything: PATH first, then our own copy.
pub fn resolve(cli: Cli) -> Option<Launch> {
    if let Some(p) = which(cli.bin()).filter(|p| cli != Cli::Antigravity || agy_takes_stdin(p)) {
        return Some(Launch::direct(p, "path"));
    }
    install::managed(cli)
}

/// Older `agy` builds have no `--input-format` and cannot take the prompt on
/// stdin (a command line caps its size) — such a copy on PATH is skipped and
/// the app uses its own current one. Checked once per binary.
fn agy_takes_stdin(path: &std::path::Path) -> bool {
    static SEEN: std::sync::Mutex<Vec<(PathBuf, bool)>> = std::sync::Mutex::new(Vec::new());
    if let Some((_, ok)) = SEEN.lock().unwrap().iter().find(|(p, _)| p == path) {
        return *ok;
    }
    let mut cmd = std::process::Command::new(path);
    cmd.arg("--help").stdin(Stdio::null()).stderr(Stdio::piped()).stdout(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let ok = cmd
        .output()
        .map(|o| {
            let help = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
            help.contains("--input-format")
        })
        .unwrap_or(false);
    SEEN.lock().unwrap().push((path.to_path_buf(), ok));
    ok
}

/// A usable CLI, downloading it first when there is none.
pub async fn ensure(cli: Cli) -> Result<Launch, String> {
    if let Some(l) = resolve(cli) {
        return Ok(l);
    }
    install::install(cli).await
}

/* ---------- Progress ---------- */

#[derive(Clone, Serialize)]
pub struct Progress {
    pub cli: &'static str,
    /// "download" | "extract" | "done" | "error"
    pub stage: &'static str,
    /// 0–100 while downloading, else 0.
    pub percent: u8,
    pub message: String,
}

fn progress(cli: Cli, stage: &'static str, percent: u8, message: impl Into<String>) {
    if let Some(app) = APP.get() {
        let _ = app.emit(
            "cli://progress",
            Progress { cli: cli.id(), stage, percent, message: message.into() },
        );
    }
}

/* ---------- Status & sign-in ---------- */

#[derive(Clone, Serialize, Default)]
pub struct CliStatus {
    pub installed: bool,
    /// "path" (user's own), "managed" (downloaded by the app) or "".
    pub source: String,
    pub path: String,
    pub installing: bool,
    /// None when it cannot be told without asking the CLI.
    pub signed_in: Option<bool>,
    pub account: String,
}

/// Runs a short CLI command hidden and returns (success, stdout).
async fn run_quiet(launch: &Launch, args: &[&str], timeout: Duration) -> Result<(bool, String), String> {
    let mut cmd = launch.command();
    cmd.args(args);
    let out = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|e| format!("cannot start {}: {e}", launch.program.display()))?;
    let mut text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        text = String::from_utf8_lossy(&out.stderr).trim().to_string();
    }
    Ok((out.status.success(), text))
}

async fn signed_in(cli: Cli, launch: &Launch) -> (Option<bool>, String) {
    match cli {
        Cli::Codex => match run_quiet(launch, &["login", "status"], Duration::from_secs(20)).await {
            Ok((ok, _)) => (Some(ok), if ok { codex_email().unwrap_or_default() } else { String::new() }),
            Err(_) => (None, String::new()),
        },
        Cli::Claude => match run_quiet(launch, &["auth", "status"], Duration::from_secs(20)).await {
            Ok((ok, text)) => {
                let json: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                let logged = json["loggedIn"].as_bool().unwrap_or(ok);
                (Some(logged), if logged { find_email(&json).unwrap_or_default() } else { String::new() })
            }
            Err(_) => (None, String::new()),
        },
        // agy keeps its session in the OS keyring and has no status command:
        // listing models works only when signed in (it never opens a browser).
        Cli::Antigravity => match agy_models(launch).await {
            Ok(list) => (Some(!list.is_empty()), agy_email().unwrap_or_default()),
            Err(_) => (Some(false), String::new()),
        },
    }
}

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// First string value under a key containing "email", anywhere in the JSON.
fn find_email(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Object(map) => map.iter().find_map(|(k, v)| match v {
            serde_json::Value::String(s) if k.to_lowercase().contains("email") && s.contains('@') => Some(s.clone()),
            _ => find_email(v),
        }),
        serde_json::Value::Array(a) => a.iter().find_map(find_email),
        _ => None,
    }
}

/// Codex: the `email` claim of the ChatGPT id token in `~/.codex/auth.json`.
fn codex_email() -> Option<String> {
    use base64::Engine;
    let dir = std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".codex"));
    let auth: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("auth.json")).ok()?).ok()?;
    let token = auth["tokens"]["id_token"].as_str()?;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    find_email(&serde_json::from_slice(&bytes).ok()?)
}

/// agy: the newest log's `applyAuthResult: email=…,` line.
fn agy_email() -> Option<String> {
    let dir = home().join(".gemini").join("antigravity-cli").join("log");
    let mut logs: Vec<_> = std::fs::read_dir(dir).ok()?.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "log")).collect();
    logs.sort_by_key(|e| std::cmp::Reverse(e.metadata().and_then(|m| m.modified()).ok()));
    logs.iter().take(10).find_map(|e| {
        let text = std::fs::read_to_string(e.path()).ok()?;
        text.lines().rev().find_map(|l| {
            let rest = l.split("applyAuthResult: email=").nth(1)?;
            let email = rest.split(',').next()?.trim();
            email.contains('@').then(|| email.to_string())
        })
    })
}

/// Last `agy models` answer, for picking effort variants at request time.
static AGY_MODELS: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

/// `agy models` → (slug, display name).
async fn agy_models(launch: &Launch) -> Result<Vec<(String, String)>, String> {
    let mut cmd = launch.command();
    cmd.arg("models");
    let out = tokio::time::timeout(Duration::from_secs(45), cmd.output())
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    // "gemini-3.8-flash-high\tGemini 3.8 Flash (High)"
    let list: Vec<(String, String)> = text
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(id, name)| (id.trim().to_string(), name.trim().to_string()))
        .filter(|(id, _)| !id.is_empty() && !id.contains(' '))
        .collect();
    if out.status.success() && !list.is_empty() {
        *AGY_MODELS.lock().unwrap() = list.clone();
        Ok(list)
    } else {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        Err(tail(if err.trim().is_empty() { &text } else { &err }, 400))
    }
}

const EFFORT_SUFFIXES: [&str; 3] = ["low", "medium", "high"];

/// `gemini-3.8-flash-high` → (`gemini-3.8-flash`, Some("high")).
fn split_effort(slug: &str) -> (&str, Option<&str>) {
    for e in EFFORT_SUFFIXES {
        if let Some(base) = slug.strip_suffix(&format!("-{e}")) {
            return (base, Some(e));
        }
    }
    (slug, None)
}

/// Antigravity bakes the effort into model ids (`…-low` / `…-high`), and a
/// fixed-effort model plus `--effort` is rejected ("conflicts with
/// --effort"). The picker lists one entry per model; this turns (model,
/// effort) into the arguments to run it with.
pub(crate) async fn agy_model_args(launch: &Launch, model: &str, effort: &str) -> Vec<String> {
    if AGY_MODELS.lock().unwrap().is_empty() {
        let _ = agy_models(launch).await;
    }
    if AGY_MODELS.lock().unwrap().is_empty() {
        // The list could not be read (right after start, agy busy): a base
        // id then needs an explicit `--effort` — agy rejects it bare.
        let (base, _) = split_effort(model);
        let eff = match effort {
            "low" | "medium" | "high" => effort,
            "xhigh" | "max" | "ultra" | "ultracode" => "high",
            _ => "medium",
        };
        return if base == model {
            vec!["--model".into(), model.into(), "--effort".into(), eff.into()]
        } else {
            vec!["--model".into(), model.into()]
        };
    }
    vec!["--model".into(), agy_slug(model, effort)]
}

/// (model, effort) → the slug to run: the exact variant, else the nearest one.
fn agy_slug(model: &str, effort: &str) -> String {
    let list = AGY_MODELS.lock().unwrap().clone();
    if list.iter().any(|(id, _)| id == model) {
        return model.to_string(); // an exact slug (older saved picks)
    }
    let variants: Vec<&str> = list
        .iter()
        .filter_map(|(id, _)| (split_effort(id).0 == model).then_some(id.as_str()))
        .collect();
    let order: &[&str] = match effort {
        "low" => &["low", "medium", "high"],
        "high" | "xhigh" | "max" | "ultra" | "ultracode" => &["high", "medium", "low"],
        _ => &["medium", "high", "low"],
    };
    order
        .iter()
        .find_map(|e| variants.iter().find(|v| split_effort(v).1 == Some(*e)))
        .or(variants.first())
        .map(|v| v.to_string())
        .unwrap_or_else(|| model.to_string())
}

/// One picker entry per Antigravity model: effort variants collapse into
/// their base (`Gemini 3.1 Pro`), the effort chip picks the variant. The
/// third field is the model's meta: the effort levels it has variants for
/// (a model with no variants takes no effort at all).
fn agy_grouped(list: &[(String, String)]) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = Vec::new();
    for (id, name) in list {
        let (base, eff) = split_effort(id);
        let siblings: Vec<&str> = list
            .iter()
            .filter(|(o, _)| split_effort(o).0 == base)
            .filter_map(|(o, _)| split_effort(o).1)
            .collect();
        let (id, name, levels) = if eff.is_some() && siblings.len() > 1 {
            let clean = name.rsplit_once(" (").map(|(n, _)| n).unwrap_or(name);
            let levels: Vec<&str> = EFFORT_SUFFIXES.into_iter().filter(|e| siblings.contains(e)).collect();
            (base.to_string(), clean.to_string(), levels)
        } else {
            (id.clone(), name.clone(), vec![])
        };
        if !out.iter().any(|(o, _, _)| *o == id) {
            out.push((id, name, efforts_meta(&levels)));
        }
    }
    out
}

/// A model's meta for the picker: `subscription`, plus the effort levels the
/// model takes (`subscription;efforts=low,high`; `efforts=` = none).
fn efforts_meta(levels: &[&str]) -> String {
    format!("subscription;efforts={}", levels.join(","))
}

pub async fn status(cli: Cli) -> CliStatus {
    let installing = install::is_installing(cli);
    let Some(launch) = resolve(cli) else {
        return CliStatus { installing, ..Default::default() };
    };
    let (signed_in, account) = signed_in(cli, &launch).await;
    CliStatus {
        installed: true,
        source: launch.source.to_string(),
        // The script/shim for `node x.js` and `cmd /C x.cmd`, else the binary.
        path: launch
            .pre_args
            .last()
            .map(|a| PathBuf::from(a).display().to_string())
            .unwrap_or_else(|| launch.program.display().to_string()),
        installing,
        signed_in,
        account,
    }
}

/// Signs in through the CLI's own browser flow. Runs hidden: the CLI opens
/// the browser, waits for the redirect on localhost and exits.
pub async fn login(cli: Cli) -> Result<CliStatus, String> {
    let launch = ensure(cli).await?;
    let args: &[&str] = match cli {
        Cli::Codex => &["login"],
        Cli::Claude => &["auth", "login"],
        Cli::Antigravity => return login_agy(&launch).await,
    };
    let (ok, text) = run_login(&launch, args, Duration::from_secs(600)).await?;
    let st = status(cli).await;
    if st.signed_in == Some(true) || (ok && st.signed_in.is_none()) {
        Ok(st)
    } else {
        Err(if text.is_empty() { format!("{} sign-in did not complete", cli.label()) } else { tail(&text, 600) })
    }
}

/// agy signs in only from its own interactive screen ("Launch the CLI without
/// arguments to sign in") — it needs a real terminal. So this one step opens
/// a visible terminal running `agy`; the app polls until the session exists
/// (up to 10 minutes) and the user closes the window after signing in.
async fn login_agy(launch: &Launch) -> Result<CliStatus, String> {
    if agy_models(launch).await.is_ok() {
        return Ok(status(Cli::Antigravity).await);
    }
    open_agy_window(launch)?;

    let deadline = std::time::Instant::now() + Duration::from_secs(600);
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_secs(3)).await;
        if agy_models(launch).await.is_ok() {
            return Ok(status(Cli::Antigravity).await);
        }
    }
    Err("Antigravity sign-in did not complete — finish it in the agy window, then press Sign in again.".into())
}

/// agy has no logout command, only the `/logout` slash command. Print mode
/// expands slash commands, so that is tried hidden first; if the session
/// survives, agy's own window opens for the user to type /logout, and the app
/// waits until the session is gone.
async fn logout_agy(launch: &Launch) -> Result<CliStatus, String> {
    let _ = run_quiet(launch, &["-p", "/logout"], Duration::from_secs(60)).await;
    AGY_MODELS.lock().unwrap().clear();
    if agy_models(launch).await.is_err() {
        return Ok(status(Cli::Antigravity).await);
    }
    open_agy_window(launch)?;
    let deadline = std::time::Instant::now() + Duration::from_secs(600);
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_secs(3)).await;
        if agy_models(launch).await.is_err() {
            AGY_MODELS.lock().unwrap().clear();
            return Ok(status(Cli::Antigravity).await);
        }
    }
    Err("Still signed in — type /logout in the agy window, then press Sign out again.".into())
}

/// Opens agy's own interactive screen in a visible terminal window.
fn open_agy_window(launch: &Launch) -> Result<(), String> {
    let program = launch.program.display().to_string();
    #[cfg(windows)]
    let spawned = {
        use std::os::windows::process::CommandExt;
        // A new console window of its own (CREATE_NEW_CONSOLE).
        std::process::Command::new(&launch.program)
            .current_dir(scratch())
            .creation_flags(0x0000_0010)
            .spawn()
    };
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").args(["-a", "Terminal", &program]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]
        .iter()
        .find_map(|t| {
            let args: Vec<&str> = if *t == "gnome-terminal" { vec!["--", &program] } else { vec!["-e", &program] };
            std::process::Command::new(t).args(args).spawn().ok()
        })
        .ok_or_else(|| std::io::Error::other("no terminal emulator found"));
    spawned
        .map(|_| ())
        .map_err(|e| format!("cannot open a terminal for `{program}`: {e} — run it yourself"))
}

/// Runs a sign-in command hidden, answering its yes/no questions (e.g.
/// "Opening authentication page in your browser. Do you want to continue?
/// [Y/n]") — with no answer the login never started. The answer is written
/// only once the question appears, so it can never be read as other input.
async fn run_login(launch: &Launch, args: &[&str], timeout: Duration) -> Result<(bool, String), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut cmd = launch.command();
    cmd.args(args).stdin(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("cannot start {}: {e}", launch.program.display()))?;
    let mut stdin = child.stdin.take();
    let mut out = child.stdout.take().ok_or("no stdout")?;
    let mut err = child.stderr.take().ok_or("no stderr")?;
    let mut text = String::new();
    let mut scanned = 0usize;
    let (mut ob, mut eb) = ([0u8; 4096], [0u8; 4096]);
    let (mut out_open, mut err_open) = (true, true);
    let work = async {
        while out_open || err_open {
            let n = tokio::select! {
                r = out.read(&mut ob), if out_open => match r {
                    Ok(0) | Err(_) => { out_open = false; continue; }
                    Ok(n) => String::from_utf8_lossy(&ob[..n]).to_string(),
                },
                r = err.read(&mut eb), if err_open => match r {
                    Ok(0) | Err(_) => { err_open = false; continue; }
                    Ok(n) => String::from_utf8_lossy(&eb[..n]).to_string(),
                },
            };
            text.push_str(&n);
            // Only output since the last answer counts as a new question.
            let low = text[scanned..].to_lowercase();
            if low.contains("[y/n]") || low.contains("(y/n)") {
                if let Some(s) = stdin.as_mut() {
                    // stdin stays open: an EOF could read as "no".
                    let _ = s.write_all(b"y\n").await;
                    let _ = s.flush().await;
                }
                scanned = text.len();
            }
        }
        child.wait().await.map(|s| s.success()).unwrap_or(false)
    };
    let ok = tokio::time::timeout(timeout, work).await.map_err(|_| "sign-in timed out".to_string())?;
    Ok((ok, text.trim().to_string()))
}

pub async fn logout(cli: Cli) -> Result<CliStatus, String> {
    let launch = resolve(cli).ok_or("not installed")?;
    let args: &[&str] = match cli {
        Cli::Codex => &["logout"],
        Cli::Claude => &["auth", "logout"],
        Cli::Antigravity => return logout_agy(&launch).await,
    };
    run_quiet(&launch, args, Duration::from_secs(30)).await?;
    Ok(status(cli).await)
}

/// Models offered for a CLI provider, read from the installed CLI itself so
/// the list follows the account and every CLI update:
/// * Codex — `codex debug models`, the account's catalog (visible entries);
/// * Antigravity — `agy models`, exactly what the account can use;
/// * Claude Code — the account's catalog from Anthropic's model list.
///
/// Only real models are listed (no "default" placeholder).
/// The CLI's models as (id, name, meta); meta carries the effort levels a
/// model takes when the CLI says (see `efforts_meta`).
pub async fn models(cli: Cli) -> Result<Vec<(String, String, String)>, String> {
    let launch = ensure(cli).await?;
    // Only real models — no "<CLI> default" placeholder.
    let mut list: Vec<(String, String, String)> = Vec::new();
    match cli {
        Cli::Codex => {
            let (ok, text) = run_quiet(&launch, &["debug", "models"], Duration::from_secs(60)).await?;
            let json: serde_json::Value = serde_json::from_str(&text)
                .map_err(|_| if ok { "unreadable model catalog".to_string() } else { tail(&text, 400) })?;
            for m in json["models"].as_array().into_iter().flatten() {
                let (Some(slug), vis) = (m["slug"].as_str(), m["visibility"].as_str().unwrap_or("list")) else { continue };
                if vis == "list" {
                    let levels: Vec<&str> = m["supported_reasoning_levels"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|l| l["effort"].as_str().or(l.as_str()))
                        .collect();
                    let meta = if levels.is_empty() { "subscription".into() } else { efforts_meta(&levels) };
                    list.push((slug.into(), m["display_name"].as_str().unwrap_or(slug).into(), meta));
                }
            }
        }
        Cli::Claude => list.extend(claude_models().await?),
        Cli::Antigravity => {
            let models = agy_models(&launch)
                .await
                .map_err(|e| format!("Sign in to Antigravity first ({e})"))?;
            list.extend(agy_grouped(&models));
        }
    }
    Ok(list)
}

/// Claude Code's models: the account's catalog from Anthropic's model list
/// (signed in with Claude Code's own token; it goes only to Anthropic), with
/// the effort levels each model takes. `claude --model` accepts these ids.
async fn claude_models() -> Result<Vec<(String, String, String)>, String> {
    let oauth = usage::claude_oauth()?;
    let res = reqwest::Client::new()
        .get("https://api.anthropic.com/v1/models?limit=1000")
        .bearer_auth(oauth["accessToken"].as_str().unwrap_or_default())
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("anthropic-version", "2023-06-01")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        // An expired token: any Claude Code run refreshes it.
        return Err(format!("Claude Code sign-in expired ({}) — run a chat with it or sign in again", res.status()));
    }
    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(claude_catalog(&json))
}

/// (id, name, meta) for each model of an Anthropic `/v1/models` page.
fn claude_catalog(json: &serde_json::Value) -> Vec<(String, String, String)> {
    const LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
    json["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m["id"].as_str()?;
            let effort = &m["capabilities"]["effort"];
            let levels: Vec<&str> = LEVELS.into_iter().filter(|l| effort[*l]["supported"].as_bool() == Some(true)).collect();
            let meta = if levels.is_empty() { "subscription".into() } else { efforts_meta(&levels) };
            Some((id.into(), m["display_name"].as_str().unwrap_or(id).into(), meta))
        })
        .collect()
}

pub(crate) fn tail(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

/* ---------- Tauri commands ---------- */

fn cli_of(kind: &str) -> Result<Cli, String> {
    Cli::from_kind(kind).ok_or_else(|| format!("{kind} is not a CLI provider"))
}

#[tauri::command]
pub async fn cli_status(kind: String) -> Result<CliStatus, String> {
    Ok(status(cli_of(&kind)?).await)
}

/// Starts the background download (no-op when a CLI is already usable) and
/// returns at once; progress arrives on `cli://progress`.
#[tauri::command]
pub async fn cli_install(kind: String) -> Result<CliStatus, String> {
    let cli = cli_of(&kind)?;
    if resolve(cli).is_none() && !install::is_installing(cli) {
        tauri::async_runtime::spawn(async move {
            if let Err(e) = install::install(cli).await {
                progress(cli, "error", 0, e);
            }
        });
        // Give the task a moment to mark itself as installing.
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(status(cli).await)
}

#[tauri::command]
pub async fn cli_login(kind: String) -> Result<CliStatus, String> {
    login(cli_of(&kind)?).await
}

/// The subscription's plan and how much of each limit window is used.
#[tauri::command]
pub async fn cli_usage(kind: String) -> Result<usage::CliUsage, String> {
    usage::usage(cli_of(&kind)?).await
}

#[tauri::command]
pub async fn cli_logout(kind: String) -> Result<CliStatus, String> {
    logout(cli_of(&kind)?).await
}

/// Live checks against the real vendor CLIs (downloads them; run by hand):
/// `CLI_TEST_ROOT=<dir> cargo test --lib cli::live -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::*;
    use futures_util::StreamExt;
    use rig_agent::core::completion::message::Message;
    use rig_agent::core::completion::{CompletionModel, CompletionRequest};

    async fn run(cli: Cli) {
        let _ = ROOT.set(PathBuf::from(std::env::var("CLI_TEST_ROOT").expect("CLI_TEST_ROOT")));
        let launch = install::managed(cli).map(Ok).unwrap_or(install::install(cli).await).expect("install");
        println!("{cli:?}: {launch:?}");
        println!("status: {:?}", serde_json::to_string(&status(cli).await).unwrap());
        println!("models: {:?}", models(cli).await);
        if std::env::var("CLI_TEST_MODELS_ONLY").is_ok() {
            return;
        }
        let req = CompletionRequest {
            model: None,
            preamble: Some("Answer in one word.".into()),
            chat_history: vec![Message::user("Say hi")],
            documents: vec![],
            tools: vec![],
            temperature: None,
            max_tokens: None,
            tool_choice: None,
            additional_params: None,
            output_schema: None,
            record_telemetry_content: false,
        };
        match CliModel::new(cli, "default", "low").stream(req).await {
            Err(e) => println!("open error: {e}"),
            Ok(mut s) => {
                while let Some(item) = s.next().await {
                    println!("item: {item:?}");
                }
            }
        }
    }

    /// A yes/no question on stdin (as CLIs ask before opening the browser) gets answered instead of hanging the sign-in.
    #[cfg(windows)]
    #[tokio::test]
    async fn login_answers_yes_no_prompt() {
        let launch = Launch {
            program: PathBuf::from("cmd"),
            pre_args: vec!["/V:ON".into(), "/D".into(), "/C".into()],
            source: "path",
        };
        let script = "set /p a=Opening authentication page in your browser. Do you want to continue? [Y/n]: & echo got !a!";
        let (ok, text) = run_login(&launch, &[script], Duration::from_secs(20)).await.unwrap();
        assert!(ok, "{text}");
        assert!(text.contains("got y"), "{text}");
    }

    #[tokio::test]
    #[ignore]
    async fn claude() {
        run(Cli::Claude).await;
    }

    #[tokio::test]
    #[ignore]
    async fn codex() {
        run(Cli::Codex).await;
    }

    /// Uses the machine's Antigravity session (sign in first).
    #[tokio::test]
    #[ignore]
    async fn antigravity() {
        run(Cli::Antigravity).await;
    }

    /// The agent's tool protocol end to end: the model must answer with a
    /// `<tool_call>` that comes back as a Rig tool call.
    #[tokio::test]
    #[ignore]
    async fn antigravity_tool_call() {
        let _ = ROOT.set(PathBuf::from(std::env::var("CLI_TEST_ROOT").expect("CLI_TEST_ROOT")));
        let req = CompletionRequest {
            model: None,
            preamble: Some("You are an agent. Use tools when they help.".into()),
            chat_history: vec![Message::user("What is the access code of vault 7?")],
            documents: vec![],
            tools: vec![rig_agent::core::completion::ToolDefinition {
                name: "vault_code".into(),
                description: "Returns the access code of a vault by number".into(),
                parameters: serde_json::json!({"type":"object","properties":{"vault":{"type":"integer"}},"required":["vault"]}),
            }],
            temperature: None,
            max_tokens: None,
            tool_choice: None,
            additional_params: None,
            output_schema: None,
            record_telemetry_content: false,
        };
        let mut s = CliModel::new(Cli::Antigravity, "default", "low").stream(req).await.expect("open");
        while let Some(item) = s.next().await {
            println!("item: {item:?}");
        }
        println!("choice: {:?}", s.choice);
    }

    /// The reported bug: a fixed-effort model plus an effort that it lacks.
    #[tokio::test]
    #[ignore]
    async fn antigravity_effort_variant() {
        let _ = ROOT.set(PathBuf::from(std::env::var("CLI_TEST_ROOT").expect("CLI_TEST_ROOT")));
        let st = status(Cli::Antigravity).await;
        println!("signed_in={:?} email_found={}", st.signed_in, st.account.contains('@'));
        println!("models: {:?}", models(Cli::Antigravity).await);
        let launch = resolve(Cli::Antigravity).unwrap();
        println!("args(gemini-3.1-pro, medium) = {:?}", agy_model_args(&launch, "gemini-3.1-pro", "medium").await);
        let req = CompletionRequest {
            model: None,
            preamble: None,
            chat_history: vec![Message::user("Reply with exactly: pong")],
            documents: vec![],
            tools: vec![],
            temperature: None,
            max_tokens: None,
            tool_choice: None,
            additional_params: None,
            output_schema: None,
            record_telemetry_content: false,
        };
        let mut s = CliModel::new(Cli::Antigravity, "gemini-3.1-pro", "medium").stream(req).await.expect("open");
        while let Some(item) = s.next().await {
            println!("item: {item:?}");
        }
    }

    /// A PATH copy too old for a model updates itself.
    #[tokio::test]
    #[ignore]
    async fn outdated_claude_updates() {
        let _ = ROOT.set(PathBuf::from(std::env::var("CLI_TEST_ROOT").expect("CLI_TEST_ROOT")));
        println!("{:?}", update_outdated(Cli::Claude).await);
    }

    /// Two agent steps in a row: the second reads the first one's history
    /// from Claude's prompt cache instead of paying it again.
    #[tokio::test]
    #[ignore]
    async fn claude_history_is_cached_between_steps() {
        let _ = ROOT.set(PathBuf::from(std::env::var("CLI_TEST_ROOT").expect("CLI_TEST_ROOT")));
        let salt = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let doc = |n: usize| (0..600).map(|i| format!("row {n}-{i}: value {}", (i * 7 + n) % 13)).collect::<Vec<_>>().join("; ");
        let tool = rig_agent::core::completion::ToolDefinition {
            name: "read_file".into(),
            description: "Reads a file of the user's project".into(),
            parameters: serde_json::json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
        };
        let call = |path: &str| Message::assistant(format!("<tool_call>{{\"name\": \"read_file\", \"arguments\": {{\"path\": \"{path}\"}}}}</tool_call>"));
        let result = |n: usize| Message::user(format!("<tool_result name=\"read_file\">\n{}\n</tool_result>", doc(n)));
        let mut history = vec![Message::user(format!("[{salt}] Read a.txt and b.txt, then tell me the value of row 1-5. {}", doc(0)))];
        history.push(call("a.txt"));
        history.push(result(1));
        for step in 0..2 {
            let req = CompletionRequest {
                model: None,
                preamble: Some("You are an agent.".into()),
                chat_history: history.clone(),
                documents: vec![],
                tools: vec![tool.clone()],
                temperature: None,
                max_tokens: None,
                tool_choice: None,
                additional_params: None,
                output_schema: None,
                record_telemetry_content: false,
            };
            let mut s = CliModel::new(Cli::Claude, "claude-haiku-4-5-20251001", "low").stream(req).await.expect("open");
            while s.next().await.is_some() {}
            let u = s.response.as_ref().map(|r| r.usage).unwrap_or_default();
            println!("step {step}: input {} (cache read {}, cache write {})", u.input_tokens, u.cached_input_tokens, u.cache_creation_input_tokens);
            history.push(call("b.txt"));
            history.push(result(2 + step));
        }
    }

    /// Right after app start: nothing has listed the models yet.
    #[tokio::test]
    #[ignore]
    async fn cold_start_answers() {
        let _ = ROOT.set(PathBuf::from(std::env::var("CLI_TEST_ROOT").expect("CLI_TEST_ROOT")));
        let (cli, model, effort) = match std::env::var("COLD_CLI").as_deref() {
            Ok("codex") => (Cli::Codex, "gpt-6-luna", "medium"),
            Ok("claude") => (Cli::Claude, "claude-opus-5-5", "medium"),
            _ => (Cli::Antigravity, "gemini-3.8-flash", "medium"),
        };
        if std::env::var("COLD_BROKEN").is_ok() {
            // What a failed `agy models` leaves behind: no variants known.
            let launch = resolve(Cli::Antigravity).unwrap();
            println!("args without a list: {:?}", agy_model_args(&launch, "gemini-3.8-flash", effort).await);
        }
        let t = std::time::Instant::now();
        let req = CompletionRequest {
            model: None,
            preamble: Some("You are an agent. Use tools when they help.".into()),
            chat_history: vec![Message::user(
                std::env::var("COLD_PROMPT").unwrap_or_else(|_| "Привет! Ответь одним словом: как дела?".into()),
            )],
            documents: vec![],
            tools: if std::env::var_os("COLD_NOTOOLS").is_some() { vec![] } else { vec![rig_agent::core::completion::ToolDefinition {
                name: "list_dir".into(),
                description: "Lists the files of a folder in the user's project".into(),
                parameters: serde_json::json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
            }] },
            temperature: None,
            max_tokens: None,
            tool_choice: None,
            additional_params: None,
            output_schema: None,
            record_telemetry_content: false,
        };
        let mut s = CliModel::new(cli, model, effort).stream(req).await.expect("open");
        while let Some(item) = s.next().await {
            println!("item: {item:?}");
        }
        println!("choice: {:?} in {:?}; cached: {:?}", s.choice, t.elapsed(), AGY_MODELS.lock().unwrap().len());
    }
}
#[cfg(test)]
mod tests {
    use super::agy_grouped;

    #[test]
    fn claude_catalog_reads_versions_and_efforts() {
        let page = serde_json::json!({ "data": [
            { "id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "capabilities": { "effort": {
                "supported": true, "low": { "supported": true }, "medium": { "supported": true },
                "high": { "supported": true }, "xhigh": { "supported": true }, "max": { "supported": false } } } },
            { "id": "claude-haiku-4-5-20251001", "display_name": "Claude Haiku 4.5", "capabilities": {} },
        ] });
        assert_eq!(
            super::claude_catalog(&page),
            vec![
                ("claude-opus-5-5".into(), "Claude Opus 5.5".into(), "subscription;efforts=low,medium,high,xhigh".into()),
                ("claude-haiku-4-5-20251001".into(), "Claude Haiku 4.5".into(), "subscription".into()),
            ]
        );
    }

    #[test]
    fn agy_variants_collapse_with_their_efforts() {
        let list: Vec<(String, String)> = [
            ("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"),
            ("gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"),
            ("gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"),
            ("gemini-3.1-pro-high", "Gemini 3.1 Pro (High)"),
            ("gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)"),
            ("claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"),
            ("gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"),
        ]
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
        let g = agy_grouped(&list);
        let meta = |id: &str| g.iter().find(|(i, _, _)| i == id).map(|(_, n, m)| (n.as_str(), m.as_str())).unwrap();
        assert_eq!(g.len(), 4);
        assert_eq!(meta("gemini-3.8-flash"), ("Gemini 3.8 Flash", "subscription;efforts=low,medium,high"));
        assert_eq!(meta("gemini-3.1-pro"), ("Gemini 3.1 Pro", "subscription;efforts=low,high"));
        assert_eq!(meta("claude-sonnet-4-6").1, "subscription;efforts=");
        assert_eq!(meta("gpt-oss-120b-medium").1, "subscription;efforts=");
    }
}
