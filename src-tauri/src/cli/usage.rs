//! What a subscription allows and how much of it is used — the numbers the
//! context menu shows under "Subscription". Each vendor reports them its own
//! way:
//!
//! * Codex — its app server (`codex app-server`, JSON-RPC over stdio):
//!   `account/read` for the plan, `account/rateLimits/read` for the windows.
//! * Claude Code — the endpoint Claude Code itself reads for `/usage`
//!   (`/api/oauth/usage`), with the sign-in it keeps in
//!   `~/.claude/.credentials.json`; the token goes only to Anthropic.
//! * Antigravity — `agy -p /usage --output-format json`, a read-only print
//!   command that starts no agent turn and spends no quota.

use super::{ensure, home, Cli, Launch};
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Clone, Serialize, Default)]
pub struct CliUsage {
    /// "ChatGPT Plus", "Claude Max 20x"… ("" when the CLI does not say).
    pub plan: String,
    pub windows: Vec<UsageWindow>,
}

#[derive(Clone, Serialize)]
pub struct UsageWindow {
    /// The models the window covers ("Gemini models"), or "".
    pub group: String,
    /// "5-hour limit", "Weekly limit"…
    pub label: String,
    /// 0–100.
    pub used_percent: f64,
    /// When it refills, ISO 8601 (UTC).
    pub resets_at: Option<String>,
}

/// The last answer per CLI — the menu opens often, the numbers move slowly.
static CACHE: Mutex<Vec<(Cli, Instant, CliUsage)>> = Mutex::new(Vec::new());
const FRESH: Duration = Duration::from_secs(45);

pub async fn usage(cli: Cli) -> Result<CliUsage, String> {
    if let Some((_, _, u)) = CACHE.lock().unwrap().iter().find(|(c, at, _)| *c == cli && at.elapsed() < FRESH) {
        return Ok(u.clone());
    }
    let launch = ensure(cli).await?;
    let u = match cli {
        Cli::Codex => codex(&launch).await?,
        Cli::Claude => claude().await?,
        Cli::Antigravity => antigravity(&launch).await?,
    };
    let mut cache = CACHE.lock().unwrap();
    cache.retain(|(c, _, _)| *c != cli);
    cache.push((cli, Instant::now(), u.clone()));
    Ok(u)
}

/// "5-hour limit" / "Weekly limit" / "N-hour limit" from a window length.
fn window_label(minutes: i64) -> String {
    match minutes {
        300 => "5-hour limit".into(),
        10_080 => "Weekly limit".into(),
        1_440 => "Daily limit".into(),
        m if m % 1_440 == 0 => format!("{}-day limit", m / 1_440),
        m if m % 60 == 0 => format!("{}-hour limit", m / 60),
        m => format!("{m}-minute limit"),
    }
}

/// "pro" → "Pro", "self_serve_business" → "Self Serve Business".
fn title(s: &str) -> String {
    s.split(['_', '-', ' '])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect::<String>()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Unix seconds → ISO 8601 UTC (civil-from-days, Howard Hinnant).
fn iso(secs: i64) -> String {
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/* ---------- Codex ---------- */

async fn codex(launch: &Launch) -> Result<CliUsage, String> {
    let mut cmd = launch.command();
    cmd.arg("app-server").stdin(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("cannot start Codex: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("Codex has no stdin")?;
    let stdout = child.stdout.take().ok_or("Codex has no stdout")?;
    let requests = [
        r#"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"singularity","version":"1"}}}"#,
        r#"{"method":"initialized"}"#,
        r#"{"id":2,"method":"account/read","params":{}}"#,
        r#"{"id":3,"method":"account/rateLimits/read"}"#,
    ];
    for r in requests {
        stdin.write_all(format!("{r}\n").as_bytes()).await.map_err(|e| e.to_string())?;
    }
    stdin.flush().await.map_err(|e| e.to_string())?;

    let (mut account, mut limits) = (None, None);
    let read = async {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            match v["id"].as_i64() {
                Some(2) => account = Some(v),
                Some(3) => limits = Some(v),
                _ => {}
            }
            if account.is_some() && limits.is_some() {
                break;
            }
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(25), read).await;
    let _ = child.kill().await;

    let limits = limits.ok_or("Codex did not report its limits")?;
    if let Some(msg) = limits["error"]["message"].as_str() {
        return Err(msg.to_string());
    }
    let r = &limits["result"];
    let plan = account
        .as_ref()
        .and_then(|a| a["result"]["account"]["planType"].as_str())
        .or(r["rateLimits"]["planType"].as_str())
        .filter(|p| *p != "unknown")
        .map(|p| format!("ChatGPT {}", title(p)))
        .unwrap_or_default();

    // Several metered buckets when the backend sends them, else the single one.
    let buckets: Vec<&serde_json::Value> = match r["rateLimitsByLimitId"].as_object() {
        Some(m) if !m.is_empty() => m.values().collect(),
        _ => vec![&r["rateLimits"]],
    };
    let many = buckets.len() > 1;
    let mut windows = Vec::new();
    for b in buckets {
        let group = if many { b["limitName"].as_str().or(b["limitId"].as_str()).unwrap_or("").to_string() } else { String::new() };
        for key in ["primary", "secondary"] {
            let w = &b[key];
            let Some(used) = w["usedPercent"].as_f64() else { continue };
            windows.push(UsageWindow {
                group: group.clone(),
                label: w["windowDurationMins"].as_i64().map(window_label).unwrap_or_else(|| title(key)),
                used_percent: used,
                resets_at: w["resetsAt"].as_i64().map(iso),
            });
        }
    }
    Ok(CliUsage { plan, windows })
}

/* ---------- Claude Code ---------- */

/// Claude Code's OAuth sign-in (`claudeAiOauth`) from its credentials file.
pub(super) fn claude_oauth() -> Result<serde_json::Value, String> {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR").map(std::path::PathBuf::from).unwrap_or_else(|| home().join(".claude"));
    let raw = std::fs::read_to_string(dir.join(".credentials.json")).map_err(|_| "Sign in to Claude Code first".to_string())?;
    let creds: serde_json::Value = serde_json::from_str(&raw).map_err(|_| "unreadable Claude Code sign-in".to_string())?;
    let oauth = creds["claudeAiOauth"].clone();
    oauth["accessToken"].as_str().ok_or("Sign in to Claude Code first")?;
    Ok(oauth)
}

async fn claude() -> Result<CliUsage, String> {
    let oauth = claude_oauth()?;
    let token = oauth["accessToken"].as_str().unwrap_or_default();

    // "max" + "default_claude_max_20x" → "Claude Max 20x".
    let mut plan = oauth["subscriptionType"].as_str().map(|p| format!("Claude {}", title(p))).unwrap_or_default();
    if let Some(mult) = oauth["rateLimitTier"].as_str().and_then(|t| t.rsplit('_').next()).filter(|m| m.ends_with('x') && m[..m.len() - 1].parse::<u32>().is_ok()) {
        plan = format!("{plan} {mult}");
    }

    let res = reqwest::Client::new()
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        // An expired token: Claude Code refreshes it on its next run.
        return Ok(CliUsage { plan, windows: vec![] });
    }
    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let windows = [
        ("five_hour", "", "5-hour limit"),
        ("seven_day", "All models", "Weekly limit"),
        ("seven_day_opus", "Opus", "Weekly limit"),
        ("seven_day_sonnet", "Sonnet", "Weekly limit"),
    ]
    .into_iter()
    .filter_map(|(key, group, label)| {
        let w = &v[key];
        Some(UsageWindow {
            group: group.into(),
            label: label.into(),
            used_percent: w["utilization"].as_f64()?,
            resets_at: w["resets_at"].as_str().map(String::from),
        })
    })
    .collect();
    Ok(CliUsage { plan, windows })
}

/* ---------- Antigravity ---------- */

async fn antigravity(launch: &Launch) -> Result<CliUsage, String> {
    let mut cmd = launch.command();
    cmd.args(["-p", "/usage", "--output-format", "json"]);
    let out = tokio::time::timeout(Duration::from_secs(40), cmd.output())
        .await
        .map_err(|_| "Antigravity took too long to report its limits".to_string())?
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let v: serde_json::Value = text
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str(l.trim()).ok())
        .ok_or_else(|| super::tail(&String::from_utf8_lossy(&out.stderr), 300))?;
    // Print-mode commands came in 1.1.11; an older agy runs "/usage" as a
    // prompt — never report that as numbers.
    if v["command"]["name"].as_str() != Some("usage") {
        return Err(v["error"].as_str().map(String::from).unwrap_or_else(|| "This Antigravity CLI cannot report its limits".into()));
    }
    let mut windows = Vec::new();
    for g in v["command"]["data"]["groups"].as_array().into_iter().flatten() {
        let group = g["name"].as_str().unwrap_or("").to_string();
        for b in g["buckets"].as_array().into_iter().flatten() {
            let Some(left) = b["remaining_fraction"].as_f64() else { continue };
            windows.push(UsageWindow {
                group: group.clone(),
                label: match b["window"].as_str() {
                    Some("5h") => "5-hour limit".into(),
                    Some("weekly") => "Weekly limit".into(),
                    _ => b["name"].as_str().unwrap_or("Limit").trim_end_matches(" Remaining").to_string(),
                },
                used_percent: ((1.0 - left) * 100.0).clamp(0.0, 100.0),
                resets_at: b["reset_time"].as_str().map(String::from),
            });
        }
    }
    Ok(CliUsage { plan: String::new(), windows })
}

#[cfg(test)]
mod tests {
    #[test]
    fn iso_dates() {
        assert_eq!(super::iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(super::iso(1_790_691_196), "2026-09-29T14:13:16Z");
    }
}

/// `CLI_TEST_ROOT=<dir> cargo test --lib cli::usage::live -- --ignored --nocapture`
#[cfg(test)]
mod live {
    use super::super::{install, Cli, ROOT};

    #[tokio::test]
    #[ignore]
    async fn antigravity_updates_and_reports() {
        let _ = ROOT.set(std::env::var("CLI_TEST_ROOT").expect("CLI_TEST_ROOT").into());
        println!("updated: {:?}", install::update(Cli::Antigravity).await);
        let u = super::usage(Cli::Antigravity).await.expect("usage");
        println!("{}", serde_json::to_string_pretty(&u).unwrap());
        assert!(!u.windows.is_empty());
    }
}
