//! MCP (Model Context Protocol) client — external tool servers the agent can
//! use next to its built-in file/command tools.
//!
//! Two transports:
//!   * stdio — the server is a local process (`npx -y @modelcontextprotocol/
//!     server-github`, `uvx mcp-server-fetch`, …) speaking newline-delimited
//!     JSON-RPC on stdin/stdout;
//!   * http  — Streamable HTTP: JSON-RPC POSTed to one URL, answered with
//!     JSON or an SSE stream, the session kept in `Mcp-Session-Id`.
//!
//! Connections are pooled per server and reused across runs (a stdio server
//! is started once, not per prompt); saving or deleting a server drops its
//! connection. Config lives in `mcp_servers`; `env` and `headers` usually
//! hold tokens, so they are vault-encrypted at rest.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

use crate::ssh::{sql, unique_id};
use crate::vault;

const PROTOCOL_VERSION: &str = "2025-06-18";
/// First start may download the server package (npx / uvx).
const INIT_TIMEOUT: Duration = Duration::from_secs(90);
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const CALL_TIMEOUT: Duration = Duration::from_secs(600);
/// Tool output handed back to the model.
const MAX_RESULT_CHARS: usize = 40_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// "stdio" | "http".
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    /// The server says the tool only reads (annotations.readOnlyHint).
    pub read_only: bool,
}

/* ---------- Storage ---------- */

fn validate(s: &McpServer) -> Result<(), String> {
    if s.name.trim().is_empty() || s.name.len() > 80 {
        return Err("Give the MCP server a name (up to 80 characters).".into());
    }
    match s.transport.as_str() {
        "stdio" => {
            if s.command.trim().is_empty() {
                return Err("Enter the command that starts the server, e.g. npx.".into());
            }
        }
        "http" => {
            let u = s.url.trim();
            if !(u.starts_with("http://") || u.starts_with("https://")) {
                return Err("The server URL must start with http:// or https://.".into());
            }
        }
        _ => return Err("Transport must be stdio or http.".into()),
    }
    for k in s.env.keys().chain(s.headers.keys()) {
        if k.trim().is_empty() || k.contains(['\r', '\n', '=']) {
            return Err(format!("Invalid variable / header name {k:?}."));
        }
    }
    Ok(())
}

fn seal(map: &BTreeMap<String, String>) -> String {
    if map.is_empty() {
        String::new()
    } else {
        vault::encrypt(&serde_json::to_string(map).unwrap_or_default())
    }
}

fn open(stored: &str) -> BTreeMap<String, String> {
    if stored.is_empty() {
        return BTreeMap::new();
    }
    serde_json::from_str(&vault::decrypt(stored)).unwrap_or_default()
}

fn from_row(r: &sqlx::sqlite::SqliteRow) -> McpServer {
    use sqlx::Row;
    let args: String = r.try_get("args").unwrap_or_default();
    McpServer {
        id: r.try_get("id").unwrap_or_default(),
        name: r.try_get("name").unwrap_or_default(),
        transport: r.try_get("transport").unwrap_or_default(),
        command: r.try_get("command").unwrap_or_default(),
        args: serde_json::from_str(&args).unwrap_or_default(),
        env: open(&r.try_get::<String, _>("env").unwrap_or_default()),
        url: r.try_get("url").unwrap_or_default(),
        headers: open(&r.try_get::<String, _>("headers").unwrap_or_default()),
        enabled: r.try_get::<i64, _>("enabled").unwrap_or(1) != 0,
    }
}

pub async fn list(app: &AppHandle) -> Result<Vec<McpServer>, String> {
    let pool = sql(app).await.ok_or("database unavailable")?;
    let rows = sqlx::query(
        "SELECT id, name, transport, command, args, env, url, headers, enabled FROM mcp_servers ORDER BY sort_order ASC, created_at ASC",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("db error: {e}"))?;
    Ok(rows.iter().map(from_row).collect())
}

pub async fn save(app: &AppHandle, s: &McpServer) -> Result<String, String> {
    validate(s)?;
    let pool = sql(app).await.ok_or("database unavailable")?;
    let id = if s.id.is_empty() { unique_id("mcp") } else { s.id.clone() };
    let args = serde_json::to_string(&s.args).unwrap_or_else(|_| "[]".into());
    sqlx::query(
        "INSERT INTO mcp_servers (id, name, transport, command, args, env, url, headers, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) \
         ON CONFLICT(id) DO UPDATE SET name=$2, transport=$3, command=$4, args=$5, env=$6, url=$7, headers=$8, enabled=$9",
    )
    .bind(&id)
    .bind(s.name.trim())
    .bind(&s.transport)
    .bind(s.command.trim())
    .bind(&args)
    .bind(seal(&s.env))
    .bind(s.url.trim())
    .bind(seal(&s.headers))
    .bind(s.enabled as i64)
    .execute(&pool)
    .await
    .map_err(|e| format!("cannot save MCP server: {e}"))?;
    disconnect(&id);
    Ok(id)
}

pub async fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let pool = sql(app).await.ok_or("database unavailable")?;
    sqlx::query("DELETE FROM mcp_servers WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|e| format!("cannot delete MCP server: {e}"))?;
    disconnect(id);
    Ok(())
}

/* ---------- JSON-RPC plumbing ---------- */

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

/// Turns a JSON-RPC response into the result or a readable error.
fn rpc_result(msg: &Value) -> Result<Value, String> {
    if let Some(err) = msg.get("error") {
        let text = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error");
        let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
        return Err(format!("{text} (code {code})"));
    }
    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
}

/// Answer to a request the SERVER sends us (ping, roots/list, …).
fn reply_to_server(msg: &Value) -> Value {
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    match msg.get("method").and_then(|m| m.as_str()) {
        Some("ping") => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        Some("roots/list") => json!({ "jsonrpc": "2.0", "id": id, "result": { "roots": [] } }),
        _ => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "not supported by this client" } }),
    }
}

/* ---------- stdio transport ---------- */

struct Stdio {
    _child: tokio::sync::Mutex<tokio::process::Child>,
    /// For killing the whole tree: on Windows `npx` is cmd.exe → node, and
    /// killing cmd.exe alone would leave node running.
    pid: Option<u32>,
    stdin: Arc<tokio::sync::Mutex<tokio::process::ChildStdin>>,
    pending: Pending,
    alive: Arc<AtomicBool>,
    stderr: Arc<Mutex<String>>,
}

/// Finds `npx` → `npx.cmd` etc. on Windows, where a bare name without the
/// extension cannot be spawned directly.
fn resolve_program(cmd: &str) -> std::path::PathBuf {
    let p = std::path::Path::new(cmd);
    if !cfg!(windows) || p.extension().is_some() || cmd.contains(['/', '\\']) {
        return p.to_path_buf();
    }
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for ext in exts.split(';').filter(|e| !e.is_empty()) {
                let cand = dir.join(format!("{cmd}{}", ext.to_lowercase()));
                if cand.is_file() {
                    return cand;
                }
            }
        }
    }
    p.to_path_buf()
}

fn push_tail(buf: &Mutex<String>, line: &str) {
    let mut b = buf.lock().unwrap();
    b.push_str(line);
    b.push('\n');
    if b.len() > 4000 {
        let cut = b.len() - 3000;
        let cut = (cut..b.len()).find(|i| b.is_char_boundary(*i)).unwrap_or(b.len());
        b.drain(..cut);
    }
}

impl Stdio {
    async fn spawn(s: &McpServer) -> Result<Self, String> {
        let program = resolve_program(s.command.trim());
        let mut cmd = tokio::process::Command::new(&program);
        cmd.args(&s.args)
            .envs(&s.env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("cannot start `{}`: {e}", program.display()))?;
        let stdin = Arc::new(tokio::sync::Mutex::new(child.stdin.take().ok_or("no stdin")?));
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr_pipe = child.stderr.take().ok_or("no stderr")?;
        let pending: Pending = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        let stderr = Arc::new(Mutex::new(String::new()));

        {
            let stderr = stderr.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr_pipe).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    push_tail(&stderr, &line);
                }
            });
        }
        {
            let (pending, alive, stderr, stdin) = (pending.clone(), alive.clone(), stderr.clone(), stdin.clone());
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else {
                        // Servers that log to stdout — keep it for errors.
                        if !line.trim().is_empty() {
                            push_tail(&stderr, line.trim());
                        }
                        continue;
                    };
                    if msg.get("method").is_some() {
                        if msg.get("id").is_some() {
                            let out = format!("{}\n", reply_to_server(&msg));
                            let _ = stdin.lock().await.write_all(out.as_bytes()).await;
                        }
                        continue;
                    }
                    if let Some(id) = msg.get("id").and_then(|v| v.as_i64()) {
                        if let Some(tx) = pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(rpc_result(&msg));
                        }
                    }
                }
                alive.store(false, Ordering::SeqCst);
                let tail = stderr.lock().unwrap().trim().to_string();
                let why = if tail.is_empty() {
                    "the MCP server exited".to_string()
                } else {
                    format!("the MCP server exited: {}", last_lines(&tail, 6))
                };
                for (_, tx) in pending.lock().unwrap().drain() {
                    let _ = tx.send(Err(why.clone()));
                }
            });
        }
        let pid = child.id();
        Ok(Self { _child: tokio::sync::Mutex::new(child), pid, stdin, pending, alive, stderr })
    }

    async fn send(&self, msg: &Value) -> Result<(), String> {
        let line = format!("{msg}\n");
        let mut w = self.stdin.lock().await;
        w.write_all(line.as_bytes()).await.map_err(|e| format!("MCP server stdin closed: {e}"))?;
        w.flush().await.map_err(|e| e.to_string())
    }

    async fn request(&self, id: i64, msg: Value, timeout: Duration) -> Result<Value, String> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(self.dead_reason());
        }
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if let Err(e) = self.send(&msg).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(self.dead_reason()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("the MCP server did not answer within {}s", timeout.as_secs()))
            }
        }
    }

    fn dead_reason(&self) -> String {
        let tail = self.stderr.lock().unwrap().trim().to_string();
        if tail.is_empty() {
            "the MCP server is not running".into()
        } else {
            format!("the MCP server stopped: {}", last_lines(&tail, 6))
        }
    }
}

impl Drop for Stdio {
    fn drop(&mut self) {
        // kill_on_drop ends the direct child; on Windows take its children
        // (the node process behind npx.cmd / uvx.exe) down with it.
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        #[cfg(not(windows))]
        let _ = self.pid;
    }
}

fn last_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    lines[lines.len().saturating_sub(n)..].join(" | ")
}

/* ---------- Streamable HTTP transport ---------- */

struct Http {
    client: reqwest::Client,
    url: String,
    headers: BTreeMap<String, String>,
    session: Mutex<Option<String>>,
    protocol: Mutex<Option<String>>,
}

impl Http {
    fn new(s: &McpServer) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            url: s.url.trim().to_string(),
            headers: s.headers.clone(),
            session: Mutex::new(None),
            protocol: Mutex::new(None),
        })
    }

    /// POSTs one message. For a request (`id` set) returns its response —
    /// from a JSON body or from the SSE stream the server opens.
    async fn post(&self, msg: &Value, id: Option<i64>, timeout: Duration) -> Result<Value, String> {
        let mut req = self
            .client
            .post(&self.url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .json(msg);
        for (k, v) in &self.headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if let Some(sid) = self.session.lock().unwrap().clone() {
            req = req.header("Mcp-Session-Id", sid);
        }
        if let Some(pv) = self.protocol.lock().unwrap().clone() {
            req = req.header("MCP-Protocol-Version", pv);
        }
        let work = async {
            let resp = req.send().await.map_err(|e| format!("MCP server unreachable: {e}"))?;
            if let Some(sid) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
                *self.session.lock().unwrap() = Some(sid.to_string());
            }
            let status = resp.status();
            if !status.is_success() {
                let body = resp.text().await.unwrap_or_default();
                let hint = if status.as_u16() == 401 || status.as_u16() == 403 {
                    " — check the server's auth header (e.g. Authorization: Bearer …)"
                } else {
                    ""
                };
                return Err(format!("HTTP {status}{hint}: {}", body.chars().take(300).collect::<String>()));
            }
            let Some(id) = id else { return Ok(Value::Null) };
            let ctype = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_lowercase();
            if ctype.starts_with("text/event-stream") {
                return read_sse(resp, id).await;
            }
            let body: Value = resp.json().await.map_err(|e| format!("bad MCP response: {e}"))?;
            let found = match &body {
                Value::Array(items) => items.iter().find(|m| m.get("id").and_then(|v| v.as_i64()) == Some(id)).cloned(),
                other => Some(other.clone()),
            };
            rpc_result(&found.ok_or("the MCP response did not answer the request")?)
        };
        tokio::time::timeout(timeout, work)
            .await
            .map_err(|_| format!("the MCP server did not answer within {}s", timeout.as_secs()))?
    }
}

/// Reads an SSE response until the event that answers request `id`.
async fn read_sse(resp: reqwest::Response, id: i64) -> Result<Value, String> {
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut data = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("MCP stream broke: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if !data.is_empty() {
                    if let Ok(msg) = serde_json::from_str::<Value>(&data) {
                        if msg.get("id").and_then(|v| v.as_i64()) == Some(id) && msg.get("method").is_none() {
                            return rpc_result(&msg);
                        }
                    }
                    data.clear();
                }
            } else if let Some(d) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(d.strip_prefix(' ').unwrap_or(d));
            }
        }
    }
    if !data.is_empty() {
        if let Ok(msg) = serde_json::from_str::<Value>(&data) {
            return rpc_result(&msg);
        }
    }
    Err("the MCP stream ended without an answer".into())
}

/* ---------- Connection ---------- */

enum Transport {
    Stdio(Stdio),
    Http(Http),
}

pub struct Conn {
    config: McpServer,
    transport: Transport,
    next_id: AtomicI64,
    pub tools: Vec<McpTool>,
}

impl Conn {
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        match &self.transport {
            Transport::Stdio(s) => s.request(id, msg, timeout).await,
            Transport::Http(h) => h.post(&msg, Some(id), timeout).await,
        }
    }

    async fn notify(&self, method: &str) -> Result<(), String> {
        let msg = json!({ "jsonrpc": "2.0", "method": method });
        match &self.transport {
            Transport::Stdio(s) => s.send(&msg).await,
            Transport::Http(h) => h.post(&msg, None, LIST_TIMEOUT).await.map(|_| ()),
        }
    }

    fn alive(&self) -> bool {
        match &self.transport {
            Transport::Stdio(s) => s.alive.load(Ordering::SeqCst),
            Transport::Http(_) => true,
        }
    }

    /// Starts the transport, runs the MCP handshake and lists the tools.
    async fn open(config: &McpServer) -> Result<Self, String> {
        let transport = match config.transport.as_str() {
            "http" => Transport::Http(Http::new(config)?),
            _ => Transport::Stdio(Stdio::spawn(config).await?),
        };
        let mut conn = Conn { config: config.clone(), transport, next_id: AtomicI64::new(1), tools: Vec::new() };
        let init = conn
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": "Singularity", "version": env!("CARGO_PKG_VERSION") }
                }),
                INIT_TIMEOUT,
            )
            .await
            .map_err(|e| format!("initialize failed: {e}"))?;
        if let Transport::Http(h) = &conn.transport {
            let pv = init.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or(PROTOCOL_VERSION);
            *h.protocol.lock().unwrap() = Some(pv.to_string());
        }
        conn.notify("notifications/initialized").await?;
        conn.tools = conn.list_tools().await?;
        Ok(conn)
    }

    async fn list_tools(&self) -> Result<Vec<McpTool>, String> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..20 {
            let params = match &cursor {
                Some(c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let res = self
                .request("tools/list", params, LIST_TIMEOUT)
                .await
                .map_err(|e| format!("tools/list failed: {e}"))?;
            for t in res.get("tools").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
                let Some(name) = t.get("name").and_then(|v| v.as_str()) else { continue };
                out.push(McpTool {
                    name: name.to_string(),
                    description: t.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    input_schema: normalize_schema(t.get("inputSchema").cloned()),
                    read_only: t
                        .pointer("/annotations/readOnlyHint")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                });
            }
            cursor = res.get("nextCursor").and_then(|v| v.as_str()).map(String::from);
            if cursor.is_none() {
                break;
            }
        }
        Ok(out)
    }

    /// Calls a tool; Ok((text, is_error)).
    pub async fn call(&self, tool: &str, args: Value) -> Result<(String, bool), String> {
        let args = if args.is_object() { args } else { json!({}) };
        let res = self
            .request("tools/call", json!({ "name": tool, "arguments": args }), CALL_TIMEOUT)
            .await?;
        let is_error = res.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
        Ok((render_content(&res), is_error))
    }
}

/// Providers reject tool schemas without `type: object` / `properties`.
fn normalize_schema(schema: Option<Value>) -> Value {
    let mut s = match schema {
        Some(Value::Object(m)) => Value::Object(m),
        _ => json!({}),
    };
    let obj = s.as_object_mut().unwrap();
    obj.insert("type".into(), json!("object"));
    if !obj.get("properties").is_some_and(|p| p.is_object()) {
        obj.insert("properties".into(), json!({}));
    }
    obj.remove("$schema");
    s
}

/// A tools/call result as the text the model reads.
fn render_content(res: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    for c in res.get("content").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let kind = c.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let s = |k: &str| c.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        match kind {
            "text" => parts.push(s("text")),
            "image" | "audio" => parts.push(format!("[{kind} {} — {} bytes base64, not shown]", s("mimeType"), s("data").len())),
            "resource" => {
                let r = c.get("resource").cloned().unwrap_or(Value::Null);
                let uri = r.get("uri").and_then(|v| v.as_str()).unwrap_or("");
                match r.get("text").and_then(|v| v.as_str()) {
                    Some(t) => parts.push(format!("[resource {uri}]\n{t}")),
                    None => parts.push(format!("[binary resource {uri}]")),
                }
            }
            "resource_link" => parts.push(format!("[link {} {}]", s("name"), s("uri"))),
            _ => parts.push(c.to_string()),
        }
    }
    if parts.is_empty() {
        if let Some(sc) = res.get("structuredContent") {
            parts.push(sc.to_string());
        }
    }
    let text = parts.join("\n");
    if text.chars().count() > MAX_RESULT_CHARS {
        let cut: String = text.chars().take(MAX_RESULT_CHARS).collect();
        format!("{cut}\n… [truncated — the result was {} characters]", text.chars().count())
    } else {
        text
    }
}

/* ---------- Pool ---------- */

static POOL: LazyLock<Mutex<HashMap<String, Arc<Conn>>>> = LazyLock::new(Mutex::default);

fn disconnect(id: &str) {
    let gone = POOL.lock().unwrap().remove(id);
    drop(gone); // outside the lock: dropping may wait on taskkill
}

/// Stops every pooled server (app exit).
pub fn shutdown() {
    let all: Vec<_> = POOL.lock().unwrap().drain().collect();
    drop(all);
}

/// A live connection for this server config — reused while it is running
/// and its config has not changed, started otherwise.
pub async fn connect(server: &McpServer) -> Result<Arc<Conn>, String> {
    if let Some(c) = POOL.lock().unwrap().get(&server.id) {
        if c.alive() && c.config == *server {
            return Ok(c.clone());
        }
    }
    let conn = Arc::new(Conn::open(server).await?);
    POOL.lock().unwrap().insert(server.id.clone(), conn.clone());
    Ok(conn)
}

/// Calls a tool, reconnecting once if the server died since the last use.
pub async fn call(server: &McpServer, tool: &str, args: Value) -> Result<(String, bool), String> {
    let conn = connect(server).await?;
    match conn.call(tool, args.clone()).await {
        Err(e) if !conn.alive() || e.contains("HTTP 404") => {
            disconnect(&server.id);
            connect(server).await?.call(tool, args).await
        }
        other => other,
    }
}

/// `mcp__<server>__<tool>`, reduced to what every provider accepts
/// (`^[a-zA-Z0-9_-]{1,64}$`).
pub fn tool_name(server: &str, tool: &str) -> String {
    let clean = |s: &str| -> String {
        s.chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
            .collect()
    };
    let full = format!("mcp__{}__{}", clean(server), clean(tool));
    if full.len() <= 64 {
        return full;
    }
    let tool = clean(tool);
    let keep = 64usize.saturating_sub(tool.len() + 7).max(4);
    let server: String = clean(server).chars().take(keep).collect();
    format!("mcp__{server}__{tool}").chars().take(64).collect()
}

/* ---------- Commands ---------- */

#[tauri::command]
pub async fn mcp_list(app: AppHandle) -> Result<Vec<McpServer>, String> {
    list(&app).await
}

#[tauri::command]
pub async fn mcp_save(app: AppHandle, server: McpServer) -> Result<String, String> {
    save(&app, &server).await
}

#[tauri::command]
pub async fn mcp_delete(app: AppHandle, id: String) -> Result<(), String> {
    delete(&app, &id).await
}

/// Starts the server (or reuses its connection) and returns its tools — the
/// Settings "Test" button. Unsaved configs are tested on a throwaway id.
#[tauri::command]
pub async fn mcp_test(server: McpServer) -> Result<Vec<McpTool>, String> {
    validate(&server)?;
    if server.id.is_empty() {
        let conn = Conn::open(&server).await?;
        return Ok(conn.tools.clone());
    }
    Ok(connect(&server).await?.tools.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[test]
    fn tool_names_fit_provider_rules() {
        assert_eq!(tool_name("github", "create_issue"), "mcp__github__create_issue");
        assert_eq!(tool_name("My Server", "a.b"), "mcp__My_Server__a_b");
        let long = tool_name(&"s".repeat(80), &"t".repeat(40));
        assert!(long.len() <= 64 && long.starts_with("mcp__"));
    }

    #[test]
    fn schema_is_normalized() {
        let s = normalize_schema(Some(json!({ "$schema": "x", "type": "object" })));
        assert_eq!(s, json!({ "type": "object", "properties": {} }));
        assert_eq!(normalize_schema(None)["type"], "object");
    }

    #[test]
    fn content_renders_text_and_resources() {
        let r = json!({ "content": [
            { "type": "text", "text": "hello" },
            { "type": "resource", "resource": { "uri": "file:///a", "text": "body" } }
        ]});
        assert_eq!(render_content(&r), "hello\n[resource file:///a]\nbody");
    }

    #[test]
    fn rpc_errors_are_readable() {
        let e = rpc_result(&json!({ "id": 1, "error": { "code": -32602, "message": "bad args" } }));
        assert_eq!(e.unwrap_err(), "bad args (code -32602)");
    }

    /// Full handshake + tools/list + tools/call against a tiny Python stdio
    /// server (skipped where Python is not installed).
    #[tokio::test]
    async fn stdio_handshake_with_python_server() {
        let py = if cfg!(windows) { "python" } else { "python3" };
        if std::process::Command::new(py).arg("--version").output().is_err() {
            return;
        }
        let script = r#"
import sys, json
for line in sys.stdin:
    m = json.loads(line)
    if "id" not in m: continue
    if m["method"] == "initialize":
        r = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "t", "version": "1"}}
    elif m["method"] == "tools/list":
        r = {"tools": [{"name": "echo", "description": "Echo", "inputSchema": {"type": "object", "properties": {"x": {"type": "string"}}}, "annotations": {"readOnlyHint": True}}]}
    elif m["method"] == "tools/call":
        r = {"content": [{"type": "text", "text": "got " + m["params"]["arguments"]["x"]}]}
    else:
        r = {}
    print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": r}), flush=True)
"#;
        let server = McpServer {
            id: "t1".into(),
            name: "test".into(),
            transport: "stdio".into(),
            command: py.into(),
            args: vec!["-u".into(), "-c".into(), script.into()],
            env: BTreeMap::new(),
            url: String::new(),
            headers: BTreeMap::new(),
            enabled: true,
        };
        let conn = connect(&server).await.expect("connect");
        assert_eq!(conn.tools.len(), 1);
        assert!(conn.tools[0].read_only);
        let (text, is_err) = call(&server, "echo", json!({ "x": "hi" })).await.expect("call");
        assert_eq!(text, "got hi");
        assert!(!is_err);
        disconnect("t1");
    }

    #[tokio::test]
    async fn http_json_and_sse_responses() {
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 65536];
                    let mut got = Vec::new();
                    loop {
                        let n = sock.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        got.extend_from_slice(&buf[..n]);
                        let text = String::from_utf8_lossy(&got).to_string();
                        if let Some(h) = text.find("\r\n\r\n") {
                            let len = text[..h]
                                .lines()
                                .find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                                .unwrap_or(0);
                            if got.len() >= h + 4 + len {
                                let body: Value = serde_json::from_slice(&got[h + 4..h + 4 + len]).unwrap_or(Value::Null);
                                let resp = match body.get("method").and_then(|m| m.as_str()) {
                                    Some("initialize") => {
                                        let b = json!({"jsonrpc":"2.0","id":body["id"],"result":{"protocolVersion":"2025-06-18"}}).to_string();
                                        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: s1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}", b.len())
                                    }
                                    Some("tools/list") => {
                                        assert!(text.to_lowercase().contains("mcp-session-id: s1"));
                                        let b = format!("event: message\ndata: {}\n\n", json!({"jsonrpc":"2.0","id":body["id"],"result":{"tools":[{"name":"t","inputSchema":{}}]}}));
                                        format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}", b.len())
                                    }
                                    _ => "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                                };
                                let _ = sock.write_all(resp.as_bytes()).await;
                                return;
                            }
                        }
                    }
                });
            }
        });
        let server = McpServer {
            id: String::new(),
            name: "h".into(),
            transport: "http".into(),
            command: String::new(),
            args: vec![],
            env: BTreeMap::new(),
            url: format!("http://{addr}/mcp"),
            headers: BTreeMap::new(),
            enabled: true,
        };
        let tools = mcp_test(server).await.expect("http mcp");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].input_schema["type"], "object");
    }
}
