//! SSH Client mode — real SSH connections, managed in Rust.
//!
//! The frontend saves server units (host + credentials) in SQLite; this
//! module owns the live connections:
//!
//! * `connect`    — TCP + password/private-key auth via russh, pooled by
//!                  server id so the UI and the agent tool share sessions;
//! * `exec`       — run one command on a pooled connection, collect output;
//! * `disconnect` — close and forget a pooled connection;
//! * every attempt (user or agent) is written to `ssh_logs` — the audit
//!   trail the Logs page renders.
//!
//! Credentials are read from the same SQLite file the SQL plugin manages
//! (sqlx, same version), so secrets never round-trip through the webview.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::PrivateKey;
use russh::{ChannelMsg, Disconnect};
use tauri::{AppHandle, Emitter};

use crate::db;

/* ---------- Types shared with the frontend ---------- */

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshServer {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    /// "password" | "key"
    #[serde(default = "default_auth")]
    pub auth: String,
    #[serde(default)]
    pub password: String,
    /// PEM/OpenSSH private key text (auth == "key").
    #[serde(default)]
    pub private_key: String,
}

fn default_port() -> u16 {
    22
}
fn default_auth() -> String {
    "password".into()
}

/* ---------- Connection pool ---------- */

struct ClientHandler;

impl russh::client::Handler for ClientHandler {
    type Error = russh::Error;

    // v1 trusts any host key (like `ssh -o StrictHostKeyChecking=accept-new`).
    // Known-host pinning is a later hardening step.
    async fn check_server_key(
        &mut self,
        _key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

type Conn = Arc<Handle<ClientHandler>>;

static POOL: Mutex<Option<HashMap<String, Conn>>> = Mutex::new(None);

fn pool_get(id: &str) -> Option<Conn> {
    POOL.lock().ok()?.as_ref()?.get(id).cloned()
}

fn pool_put(id: String, conn: Conn) {
    if let Ok(mut guard) = POOL.lock() {
        guard.get_or_insert_with(HashMap::new).insert(id, conn);
    }
}

fn pool_take(id: &str) -> Option<Conn> {
    POOL.lock().ok()?.as_mut()?.remove(id)
}

/// Ids of currently connected servers (the UI paints status dots from this).
pub fn connected_ids() -> Vec<String> {
    POOL.lock()
        .ok()
        .and_then(|g| g.as_ref().map(|m| m.keys().cloned().collect()))
        .unwrap_or_default()
}

/* ---------- Audit log (sqlx → the same singularity.db) ---------- */

/// Cached pool (cheap Arc clone). A tokio Mutex instead of OnceCell so a
/// failed connect is RETRIED on the next call rather than cached forever.
static SQL: tokio::sync::Mutex<Option<sqlx::SqlitePool>> = tokio::sync::Mutex::const_new(None);

async fn sql(app: &AppHandle) -> Option<sqlx::SqlitePool> {
    let mut guard = SQL.lock().await;
    if let Some(pool) = guard.as_ref() {
        return Some(pool.clone());
    }
    let path = db::db_path(app).ok()?;
    let opts = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(std::path::Path::new(&path))
        .create_if_missing(false);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(opts)
        .await
        .ok()?;
    *guard = Some(pool.clone());
    Some(pool)
}

/// One audit row: who did what to which server, and how it ended.
pub async fn write_log(
    app: &AppHandle,
    actor: &str,
    server: &SshServer,
    action: &str,
    ok: bool,
    detail: &str,
) {
    let Some(pool) = sql(app).await else { return };
    let id = unique_id("log");
    let res = sqlx::query(
        "INSERT INTO ssh_logs (id, actor, server_id, server_name, host, action, ok, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&id)
    .bind(actor)
    .bind(&server.id)
    .bind(&server.name)
    .bind(&server.host)
    .bind(action)
    .bind(ok as i64)
    .bind(detail)
    .execute(&pool)
    .await;
    if let Err(e) = res {
        eprintln!("[ssh] cannot write log: {e}");
    }
    // The Logs page refreshes live while it is open.
    let _ = app.emit("ssh://logged", ());
}

/// Cheap unique id (prefix + nanos + jitter) — no uuid crate for one column.
pub fn unique_id(prefix: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{prefix}-{:x}-{:x}", d.as_nanos(), d.subsec_nanos().wrapping_mul(2654435761))
}

/* ---------- Credentials from the database ---------- */

/// Loads one saved server row (credentials included) for Rust-side use.
async fn load_server(app: &AppHandle, id: &str) -> Result<SshServer, String> {
    let pool = sql(app).await.ok_or("database unavailable")?;
    let row = sqlx::query(
        "SELECT id, name, host, port, username, auth, password, private_key FROM ssh_servers WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| format!("db error: {e}"))?
    .ok_or_else(|| format!("unknown server: {id}"))?;

    use sqlx::Row;
    Ok(SshServer {
        id: row.try_get("id").unwrap_or_default(),
        name: row.try_get("name").unwrap_or_default(),
        host: row.try_get("host").unwrap_or_default(),
        port: row.try_get::<i64, _>("port").unwrap_or(22) as u16,
        username: row.try_get("username").unwrap_or_default(),
        auth: row.try_get("auth").unwrap_or_default(),
        password: row.try_get("password").unwrap_or_default(),
        private_key: row.try_get("private_key").unwrap_or_default(),
    })
}

/* ---------- Connect / exec / disconnect ---------- */

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const EXEC_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_OUTPUT: usize = 30_000;

/// Opens (or reuses) a pooled connection to a saved server.
pub async fn connect(app: &AppHandle, actor: &str, server_id: &str) -> Result<(), String> {
    if pool_get(server_id).is_some() {
        return Ok(()); // already connected — idempotent
    }
    let server = load_server(app, server_id).await?;
    let outcome = connect_inner(&server).await;
    match &outcome {
        Ok(_) => write_log(app, actor, &server, "connect", true, "").await,
        Err(e) => write_log(app, actor, &server, "connect", false, e).await,
    }
    let _ = app.emit("ssh://status", connected_ids());
    outcome
}

async fn connect_inner(server: &SshServer) -> Result<(), String> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });
    let addr = (server.host.as_str(), server.port);
    let mut session = tokio::time::timeout(
        CONNECT_TIMEOUT,
        client::connect(config, addr, ClientHandler),
    )
    .await
    .map_err(|_| format!("connection to {}:{} timed out", server.host, server.port))?
    .map_err(|e| format!("ssh handshake failed: {e}"))?;

    let auth = if server.auth == "key" {
        let key = PrivateKey::from_openssh(server.private_key.trim())
            .map_err(|e| format!("cannot parse private key: {e}"))?;
        // RSA keys need a hash algorithm the server advertises; russh asks
        // the server which SHA variant it prefers (None = legacy sha1).
        let hash = if key.algorithm().is_rsa() {
            session.best_supported_rsa_hash().await.ok().flatten().flatten()
        } else {
            None
        };
        let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
        session.authenticate_publickey(&server.username, key).await
    } else {
        session
            .authenticate_password(&server.username, &server.password)
            .await
    };

    let auth = auth.map_err(|e| format!("authentication error: {e}"))?;
    if !auth.success() {
        return Err(format!(
            "authentication rejected for user '{}'",
            server.username
        ));
    }
    pool_put(server.id.clone(), Arc::new(session));
    Ok(())
}

/// Runs one command on a connected server and returns combined output.
pub async fn exec(
    app: &AppHandle,
    actor: &str,
    server_id: &str,
    command: &str,
) -> Result<String, String> {
    // Auto-connect on demand: neither the UI nor the agent has to babysit
    // the pool; credentials come from the database, not from the request.
    if pool_get(server_id).is_none() {
        connect(app, actor, server_id).await?;
    }
    let conn = pool_get(server_id).ok_or("not connected")?;
    let server = load_server(app, server_id).await?;

    let outcome = exec_inner(&conn, command).await;
    let (ok, detail) = match &outcome {
        Ok(text) => (true, first_line(text)),
        Err(e) => (false, first_line(e)),
    };
    write_log(
        app,
        actor,
        &server,
        "exec",
        ok,
        &format!("{command} → {detail}"),
    )
    .await;
    outcome
}

fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("");
    if line.chars().count() > 120 {
        line.chars().take(120).collect::<String>() + "…"
    } else {
        line.to_string()
    }
}

async fn exec_inner(conn: &Handle<ClientHandler>, command: &str) -> Result<String, String> {
    let mut channel = conn
        .channel_open_session()
        .await
        .map_err(|e| format!("cannot open channel: {e}"))?;
    channel
        .exec(true, command)
        .await
        .map_err(|e| format!("exec failed: {e}"))?;

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut code: Option<u32> = None;

    let collect = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => {
                    if stdout.len() < MAX_OUTPUT {
                        stdout.push_str(&String::from_utf8_lossy(data));
                    }
                }
                ChannelMsg::ExtendedData { ref data, ext: 1 } => {
                    if stderr.len() < MAX_OUTPUT {
                        stderr.push_str(&String::from_utf8_lossy(data));
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
    };
    tokio::time::timeout(EXEC_TIMEOUT, collect)
        .await
        .map_err(|_| {
            format!("command timed out after {}s", EXEC_TIMEOUT.as_secs())
        })?;

    let mut out = String::new();
    if !stdout.is_empty() {
        out.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str("[stderr] ");
        out.push_str(&stderr);
    }
    if out.is_empty() {
        out = "(no output)".into();
    }
    match code {
        Some(0) | None => Ok(out),
        Some(c) => Err(format!("exit code {c}\n{out}")),
    }
}

/// Closes a pooled connection (idempotent).
pub async fn disconnect(app: &AppHandle, actor: &str, server_id: &str) -> Result<(), String> {
    let Some(conn) = pool_take(server_id) else {
        return Ok(());
    };
    let server = load_server(app, server_id).await?;
    let res = conn
        .disconnect(Disconnect::ByApplication, "", "en")
        .await;
    write_log(app, actor, &server, "disconnect", res.is_ok(), "").await;
    let _ = app.emit("ssh://status", connected_ids());
    res.map_err(|e| format!("disconnect failed: {e}"))
}
