/// Google OAuth 2.0 sign-in for the Gemini / Antigravity provider.
///
/// Uses the standard "installed app" flow: PKCE + a loopback redirect. The user
/// only has to paste an OAuth *client ID* once (created as a "Desktop app" in
/// Google Cloud Console); from then on signing in is a single click.
///
/// Tokens are stored by the frontend in the `oauth_tokens` table and refreshed
/// through [`refresh`] when they expire.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

pub const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";

/// Scopes requested during sign-in.
///
/// These must match the built-in client: Google validates the requested scopes
/// against the client ID, and a shared client only accepts the scopes it was
/// registered for. `cloud-platform` also grants access to the Generative
/// Language API, which is what the chat calls use.
pub const SCOPES: &[&str] = &[
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
];

/// Space-separated form used in the authorization URL.
pub fn scope_param() -> String {
    SCOPES.join(" ")
}

/* ---------- Stored credentials ---------- */

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds.
    pub expires_at: i64,
    pub email: String,
    pub scope: String,
}

impl Tokens {
    /// Treats a token as expired 60s early to avoid racing the clock.
    #[allow(dead_code)]
    pub fn is_expired(&self) -> bool {
        self.access_token.is_empty() || self.expires_at - 60 <= now()
    }
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/* ---------- PKCE helpers ---------- */

/// Random URL-safe verifier (RFC 7636 allows 43–128 chars).
fn make_verifier() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect()
}

/// S256 challenge = base64url(sha256(verifier)), unpadded.
fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/* ---------- Token exchange ---------- */

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
    pub scope: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub error_description: Option<String>,
}

/// Human-readable message from a Google error payload.
fn oauth_error(parsed: &TokenResponse) -> Option<String> {
    parsed.error.as_ref().map(|e| {
        let desc = parsed.error_description.clone().unwrap_or_default();
        if desc.is_empty() {
            e.clone()
        } else {
            format!("{e}: {desc}")
        }
    })
}

/// Exchanges an authorization code for tokens.
pub async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<Tokens, String> {
    let mut form = vec![
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
    ];
    // Desktop clients still receive a secret; include it when present.
    if !client_secret.is_empty() {
        form.push(("client_secret", client_secret));
    }

    let res = reqwest::Client::new()
        .post(TOKEN_ENDPOINT)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;

    let body = res.text().await.map_err(|e| e.to_string())?;
    let parsed: TokenResponse =
        serde_json::from_str(&body).map_err(|e| format!("bad token response: {e} — {body}"))?;

    if let Some(err) = oauth_error(&parsed) {
        return Err(err);
    }
    let access_token = parsed.access_token.ok_or("no access_token in response")?;

    Ok(Tokens {
        access_token,
        refresh_token: parsed.refresh_token.unwrap_or_default(),
        expires_at: now() + parsed.expires_in.unwrap_or(3600),
        email: String::new(),
        scope: parsed.scope.unwrap_or_default(),
    })
}

/// Refreshes an expired access token.
pub async fn refresh(
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<Tokens, String> {
    let mut form = vec![
        ("client_id", client_id),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ];
    if !client_secret.is_empty() {
        form.push(("client_secret", client_secret));
    }

    let res = reqwest::Client::new()
        .post(TOKEN_ENDPOINT)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("refresh failed: {e}"))?;
    let body = res.text().await.map_err(|e| e.to_string())?;
    let parsed: TokenResponse =
        serde_json::from_str(&body).map_err(|e| format!("bad refresh response: {e} — {body}"))?;

    if let Some(err) = oauth_error(&parsed) {
        return Err(err);
    }
    let access_token = parsed.access_token.ok_or("no access_token on refresh")?;

    Ok(Tokens {
        access_token,
        // A refresh does not rotate the refresh token.
        refresh_token: parsed.refresh_token.unwrap_or_else(|| refresh_token.to_string()),
        expires_at: now() + parsed.expires_in.unwrap_or(3600),
        email: String::new(),
        scope: parsed.scope.unwrap_or_default(),
    })
}

/// Fetches the account email for the given access token (best effort).
pub async fn fetch_email(access_token: &str) -> String {
    #[derive(Deserialize)]
    struct UserInfo {
        email: Option<String>,
    }

    let Ok(res) = reqwest::Client::new()
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .bearer_auth(access_token)
        .send()
        .await
    else {
        return String::new();
    };
    let Ok(text) = res.text().await else {
        return String::new();
    };
    serde_json::from_str::<UserInfo>(&text)
        .ok()
        .and_then(|u| u.email)
        .unwrap_or_default()
}

/* ---------- Interactive flow ---------- */

#[derive(Debug, Clone, Serialize)]
pub struct SignInResult {
    pub tokens: Tokens,
    pub redirect_uri: String,
}

/// Opens the consent page in the user's default browser.
///
/// Uses the opener plugin rather than `cmd /C start`: the consent URL contains
/// several `&` separators, and `cmd` treats those as command separators, which
/// truncates the URL and makes Google report a missing `response_type`.
fn open_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("cannot open browser: {e}"))
}

/// Runs the interactive flow: starts a one-shot loopback server, opens the
/// consent page, waits for the redirect, then exchanges the code for tokens.
///
/// Emits `oauth://waiting` with the consent URL so the UI can show progress.
pub async fn run_flow(
    app: AppHandle,
    client_id: String,
    client_secret: String,
) -> Result<SignInResult, String> {
    let verifier = make_verifier();
    let challenge = challenge_for(&verifier);
    let state: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(24)
        .map(char::from)
        .collect();

    // Bind an ephemeral port on loopback — this is the redirect target.
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| format!("cannot start local callback server: {e}"))?;
    // `server_addr` is always an IP for a TCP server, so this cannot fail.
    let tiny_http::ListenAddr::IP(addr) = server.server_addr();
    let redirect_uri = format!("http://127.0.0.1:{}", addr.port());

    let auth_url = format!(
        "{AUTH_ENDPOINT}?client_id={}&redirect_uri={}&response_type=code&scope={}\
         &code_challenge={}&code_challenge_method=S256&state={}\
         &access_type=offline&prompt=consent",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&scope_param()),
        challenge,
        state,
    );

    let _ = app.emit("oauth://waiting", auth_url.clone());
    open_browser(&app, &auth_url)?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
    let mut code: Option<String> = None;

    while std::time::Instant::now() < deadline {
        match server.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(Some(req)) => {
                let url = req.url().to_string();
                respond_ok(req);

                let Some(query) = url.split('?').nth(1) else {
                    continue;
                };
                let (mut got_code, mut got_state, mut err) = (None, None, None);
                for pair in query.split('&') {
                    let mut it = pair.splitn(2, '=');
                    let key = it.next().unwrap_or("");
                    let val = urlencoding::decode(it.next().unwrap_or(""))
                        .map(|c| c.into_owned())
                        .unwrap_or_default();
                    match key {
                        "code" => got_code = Some(val),
                        "state" => got_state = Some(val),
                        "error" => err = Some(val),
                        _ => {}
                    }
                }

                if let Some(e) = err {
                    return Err(format!("Google declined the sign-in: {e}"));
                }
                if got_state.as_deref() != Some(state.as_str()) {
                    return Err("OAuth state mismatch — sign-in aborted".into());
                }
                if let Some(c) = got_code {
                    code = Some(c);
                    break;
                }
            }
            Ok(None) => continue,
            Err(e) => return Err(format!("callback server error: {e}")),
        }
    }

    let code = code.ok_or("Timed out waiting for the Google sign-in to complete")?;

    let mut tokens =
        exchange_code(&client_id, &client_secret, &code, &verifier, &redirect_uri).await?;
    tokens.email = fetch_email(&tokens.access_token).await;

    let _ = app.emit("oauth://complete", tokens.email.clone());

    Ok(SignInResult {
        tokens,
        redirect_uri,
    })
}

/// Renders the small "you can close this tab" page.
fn respond_ok(req: tiny_http::Request) {
    const HTML: &str = "<!doctype html><meta charset=\"utf-8\"><title>Singularity</title>\
        <body style=\"font-family:system-ui;background:#111;color:#eee;display:grid;\
        place-items:center;height:100vh;margin:0\">\
        <div style=\"text-align:center\">\
        <h2 style=\"font-weight:600\">Signed in to Google</h2>\
        <p style=\"color:#888\">You can close this tab and return to Singularity.</p>\
        </div></body>";
    let header = tiny_http::Header::from_bytes(
        &b"Content-Type"[..],
        &b"text/html; charset=utf-8"[..],
    )
    .expect("static header is valid");
    let _ = req.respond(tiny_http::Response::from_string(HTML).with_header(header));
}