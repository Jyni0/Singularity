//! Proxies for SSH connections — saved units (HTTP CONNECT or SOCKS5) that
//! a server can optionally route through.
//!
//! Storage mirrors key credentials: rows live in `ssh_proxies`, the password
//! is vault-encrypted and never sent back to the webview (listings carry
//! `has_password` only). `dial` opens the tunnelled TCP stream the SSH
//! handshake then runs over.

use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::ssh::{sql, unique_id};
use crate::vault;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProxy {
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// "http" | "socks5".
    pub kind: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: String,
    /// Plaintext only when saving (blank keeps the stored one, "-" clears it);
    /// always blank in listings.
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub has_password: bool,
}

fn validate(p: &SshProxy) -> Result<(), String> {
    if p.name.trim().is_empty() || p.name.len() > 120 {
        return Err("Give the proxy a name (up to 120 characters).".into());
    }
    if p.kind != "http" && p.kind != "socks5" {
        return Err("Proxy type must be HTTP or SOCKS5.".into());
    }
    crate::safety::validate_host(&p.host)?;
    if p.port == 0 {
        return Err("Port must be a number from 1 to 65535.".into());
    }
    // SOCKS5 user/password auth packs each field into one length byte.
    if p.username.len() > 255 || p.password.len() > 255 {
        return Err("Proxy username and password are limited to 255 bytes.".into());
    }
    if p.username.contains(['\r', '\n']) {
        return Err("Proxy username contains a line break.".into());
    }
    Ok(())
}

fn from_row(r: &sqlx::sqlite::SqliteRow, with_secret: bool) -> SshProxy {
    use sqlx::Row;
    let stored: String = r.try_get("password").unwrap_or_default();
    SshProxy {
        id: r.try_get("id").unwrap_or_default(),
        name: r.try_get("name").unwrap_or_default(),
        kind: r.try_get("kind").unwrap_or_default(),
        host: r.try_get("host").unwrap_or_default(),
        port: r.try_get::<i64, _>("port").unwrap_or(0) as u16,
        username: r.try_get("username").unwrap_or_default(),
        password: if with_secret { vault::decrypt(&stored) } else { String::new() },
        has_password: !stored.is_empty(),
    }
}

pub async fn list(app: &AppHandle) -> Result<Vec<SshProxy>, String> {
    let pool = sql(app).await.ok_or("database unavailable")?;
    let rows = sqlx::query(
        "SELECT id, name, kind, host, port, username, password FROM ssh_proxies ORDER BY sort_order ASC, created_at DESC",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("db error: {e}"))?;
    Ok(rows.iter().map(|r| from_row(r, false)).collect())
}

/// The proxy with its password decrypted — for dialing only.
pub async fn load(app: &AppHandle, id: &str) -> Result<SshProxy, String> {
    let pool = sql(app).await.ok_or("database unavailable")?;
    let row = sqlx::query("SELECT id, name, kind, host, port, username, password FROM ssh_proxies WHERE id = $1")
        .bind(id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| format!("db error: {e}"))?
        .ok_or_else(|| format!("the server's proxy no longer exists ({id}) — pick another one in its settings"))?;
    Ok(from_row(&row, true))
}

pub async fn save(app: &AppHandle, p: &SshProxy) -> Result<String, String> {
    validate(p)?;
    let pool = sql(app).await.ok_or("database unavailable")?;
    let id = if p.id.is_empty() { unique_id("prx") } else { p.id.clone() };
    let old: String = if p.id.is_empty() {
        String::new()
    } else {
        use sqlx::Row;
        sqlx::query("SELECT password FROM ssh_proxies WHERE id = $1")
            .bind(&id)
            .fetch_optional(&pool)
            .await
            .map_err(|e| format!("db error: {e}"))?
            .map(|r| r.try_get::<String, _>("password").unwrap_or_default())
            .unwrap_or_default()
    };
    let password = match p.password.as_str() {
        "-" => String::new(),
        "" => old,
        plain => vault::encrypt(plain),
    };
    sqlx::query(
        "INSERT INTO ssh_proxies (id, name, kind, host, port, username, password) VALUES ($1,$2,$3,$4,$5,$6,$7) \
         ON CONFLICT(id) DO UPDATE SET name=$2, kind=$3, host=$4, port=$5, username=$6, password=$7",
    )
    .bind(&id)
    .bind(p.name.trim())
    .bind(&p.kind)
    .bind(p.host.trim())
    .bind(p.port as i64)
    .bind(p.username.trim())
    .bind(&password)
    .execute(&pool)
    .await
    .map_err(|e| format!("cannot save proxy: {e}"))?;
    Ok(id)
}

pub async fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let pool = sql(app).await.ok_or("database unavailable")?;
    // Servers that used it connect directly again.
    sqlx::query("UPDATE ssh_servers SET proxy_id = '' WHERE proxy_id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .ok();
    sqlx::query("DELETE FROM ssh_proxies WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|e| format!("cannot delete proxy: {e}"))?;
    Ok(())
}

/* ---------- Dialing ---------- */

/// Opens a TCP stream to `host:port` through the proxy.
pub async fn dial(p: &SshProxy, host: &str, port: u16) -> Result<TcpStream, String> {
    let mut s = TcpStream::connect((p.host.as_str(), p.port))
        .await
        .map_err(|e| format!("proxy {}:{} unreachable: {e}", p.host, p.port))?;
    let _ = s.set_nodelay(true);
    match p.kind.as_str() {
        "http" => http_connect(&mut s, p, host, port).await?,
        "socks5" => socks5_connect(&mut s, p, host, port).await?,
        other => return Err(format!("unknown proxy type {other}")),
    }
    Ok(s)
}

async fn http_connect(s: &mut TcpStream, p: &SshProxy, host: &str, port: u16) -> Result<(), String> {
    // IPv6 literals need brackets in the authority.
    let authority = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let mut req = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if !p.username.is_empty() || !p.password.is_empty() {
        use base64::Engine;
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", p.username, p.password));
        req.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await.map_err(|e| format!("proxy write failed: {e}"))?;

    // Read the response head byte by byte so nothing past it (the SSH banner)
    // is swallowed.
    let mut head = Vec::with_capacity(256);
    let mut b = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 16 * 1024 {
            return Err("proxy sent an oversized response".into());
        }
        let n = s.read(&mut b).await.map_err(|e| format!("proxy read failed: {e}"))?;
        if n == 0 {
            return Err("proxy closed the connection".into());
        }
        head.push(b[0]);
    }
    let status = String::from_utf8_lossy(&head);
    let first = status.lines().next().unwrap_or("");
    let code = first.split_whitespace().nth(1).unwrap_or("");
    match code {
        "200" => Ok(()),
        "407" => Err("HTTP proxy rejected the credentials (407)".into()),
        _ => Err(format!("HTTP proxy refused the tunnel: {first}")),
    }
}

async fn socks5_connect(s: &mut TcpStream, p: &SshProxy, host: &str, port: u16) -> Result<(), String> {
    let io = |e: std::io::Error| format!("SOCKS5 proxy I/O failed: {e}");
    let with_auth = !p.username.is_empty() || !p.password.is_empty();
    // Greeting: offer "no auth", plus username/password when configured.
    if with_auth {
        s.write_all(&[5, 2, 0x00, 0x02]).await.map_err(io)?;
    } else {
        s.write_all(&[5, 1, 0x00]).await.map_err(io)?;
    }
    let mut reply = [0u8; 2];
    s.read_exact(&mut reply).await.map_err(io)?;
    if reply[0] != 5 {
        return Err("not a SOCKS5 proxy".into());
    }
    match reply[1] {
        0x00 => {}
        0x02 if with_auth => {
            // RFC 1929 username/password sub-negotiation.
            let mut msg = vec![1, p.username.len() as u8];
            msg.extend_from_slice(p.username.as_bytes());
            msg.push(p.password.len() as u8);
            msg.extend_from_slice(p.password.as_bytes());
            s.write_all(&msg).await.map_err(io)?;
            let mut r = [0u8; 2];
            s.read_exact(&mut r).await.map_err(io)?;
            if r[1] != 0 {
                return Err("SOCKS5 proxy rejected the credentials".into());
            }
        }
        0x02 => return Err("SOCKS5 proxy requires a username and password".into()),
        _ => return Err("SOCKS5 proxy accepts none of the offered auth methods".into()),
    }

    // CONNECT request; IP literals go as addresses, names are resolved by the proxy.
    let mut req = vec![5, 1, 0];
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            req.push(1);
            req.extend_from_slice(&ip.octets());
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            req.push(4);
            req.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            if host.len() > 255 {
                return Err("host name too long for SOCKS5".into());
            }
            req.push(3);
            req.push(host.len() as u8);
            req.extend_from_slice(host.as_bytes());
        }
    }
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await.map_err(io)?;

    let mut head = [0u8; 4];
    s.read_exact(&mut head).await.map_err(io)?;
    if head[1] != 0 {
        let why = match head[1] {
            1 => "general failure",
            2 => "connection not allowed by ruleset",
            3 => "network unreachable",
            4 => "host unreachable",
            5 => "connection refused",
            6 => "TTL expired",
            7 => "command not supported",
            8 => "address type not supported",
            _ => "unknown error",
        };
        return Err(format!("SOCKS5 proxy could not reach {host}:{port}: {why}"));
    }
    // Skip the bound address the proxy reports.
    let skip = match head[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut len = [0u8; 1];
            s.read_exact(&mut len).await.map_err(io)?;
            len[0] as usize
        }
        _ => return Err("SOCKS5 proxy sent a malformed reply".into()),
    };
    let mut rest = vec![0u8; skip + 2];
    s.read_exact(&mut rest).await.map_err(io)?;
    Ok(())
}

/* ---------- Tauri commands ---------- */

#[tauri::command]
pub async fn ssh_list_proxies(app: AppHandle) -> Result<Vec<SshProxy>, String> {
    list(&app).await
}

#[tauri::command]
pub async fn ssh_save_proxy(app: AppHandle, proxy: SshProxy) -> Result<String, String> {
    save(&app, &proxy).await
}

#[tauri::command]
pub async fn ssh_delete_proxy(app: AppHandle, proxy_id: String) -> Result<(), String> {
    delete(&app, &proxy_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn proxy(kind: &str, port: u16, user: &str, pass: &str) -> SshProxy {
        SshProxy {
            id: String::new(),
            name: "t".into(),
            kind: kind.into(),
            host: "127.0.0.1".into(),
            port,
            username: user.into(),
            password: pass.into(),
            has_password: false,
        }
    }

    #[tokio::test]
    async fn http_tunnel() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut c, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 1024];
            let n = c.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            c.write_all(b"HTTP/1.1 200 Connection established\r\n\r\nSSH-2.0-x").await.unwrap();
            req
        });
        let mut s = dial(&proxy("http", port, "u", "p"), "example.com", 22).await.unwrap();
        let req = server.await.unwrap();
        assert!(req.starts_with("CONNECT example.com:22 HTTP/1.1"));
        assert!(req.contains("Proxy-Authorization: Basic dTpw"));
        // Bytes after the response head stay in the stream.
        let mut banner = [0u8; 9];
        s.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"SSH-2.0-x");
    }

    #[tokio::test]
    async fn socks5_tunnel_with_auth() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut c, _) = l.accept().await.unwrap();
            let mut g = [0u8; 4];
            c.read_exact(&mut g).await.unwrap();
            assert_eq!(g, [5, 2, 0, 2]);
            c.write_all(&[5, 2]).await.unwrap();
            let mut a = [0u8; 5];
            c.read_exact(&mut a).await.unwrap();
            assert_eq!(a, [1, 1, b'u', 1, b'p']);
            c.write_all(&[1, 0]).await.unwrap();
            let mut r = [0u8; 5 + 11 + 2];
            c.read_exact(&mut r).await.unwrap();
            assert_eq!(&r[..5], &[5, 1, 0, 3, 11]);
            assert_eq!(&r[5..16], b"example.com");
            c.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
        });
        dial(&proxy("socks5", port, "u", "p"), "example.com", 22).await.unwrap();
    }
}
