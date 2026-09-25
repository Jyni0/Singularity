//! Secrets at rest — the vault.
//!
//! Every credential (server password, private key, key passphrase) is stored
//! in SQLite only as AES-256-GCM ciphertext, base64 with an `enc:v1:` marker.
//! The 32-byte master key never lives in the database: it is kept in the OS
//! credential store (Windows Credential Manager via the `keyring` crate);
//! if that is unavailable the fallback is a file in the app-data dir.
//!
//! Legacy plaintext values (rows written before the vault existed) decrypt
//! as themselves and are re-encrypted on the next save.

use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::{Aead, Generate, Key, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;

const MARKER: &str = "enc:v1:";
const KEYRING_SERVICE: &str = "singularity.vault";
const KEYRING_USER: &str = "master-key";

static MASTER: Mutex<Option<[u8; 32]>> = Mutex::new(None);

fn fallback_path() -> Option<PathBuf> {
    dirs_fallback()
}

/// App-data dir without a Tauri handle: mirror of db::db_path's location.
fn dirs_fallback() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("APPDATA").ok()?;
        Some(PathBuf::from(base).join("com.singularity.app"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(home).join(".local/share/com.singularity.app"))
    }
}

fn load_master() -> [u8; 32] {
    // 1. Cached in memory.
    if let Ok(guard) = MASTER.lock() {
        if let Some(k) = guard.as_ref() {
            return *k;
        }
    }
    // 2. OS credential store.
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        if let Ok(b64) = entry.get_password() {
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                if bytes.len() == 32 {
                    let mut key = [0u8; 32];
                    key.copy_from_slice(&bytes);
                    cache_master(key);
                    return key;
                }
            }
        }
        // First run: create and persist a fresh key.
        let key = Key::<Aes256Gcm>::generate();
        let bytes: [u8; 32] = key.into();
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        if entry.set_password(&b64).is_ok() {
            cache_master(bytes);
            return bytes;
        }
    }
    // 3. Fallback file (still out-of-band from the database).
    if let Some(dir) = fallback_path() {
        let path = dir.join("vault.key");
        if let Ok(b64) = std::fs::read_to_string(&path) {
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                if bytes.len() == 32 {
                    let mut key = [0u8; 32];
                    key.copy_from_slice(&bytes);
                    cache_master(key);
                    return key;
                }
            }
        }
        let key = Key::<Aes256Gcm>::generate();
        let bytes: [u8; 32] = key.into();
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        let _ = std::fs::create_dir_all(&dir);
        if std::fs::write(&path, b64).is_ok() {
            cache_master(bytes);
            return bytes;
        }
    }
    // 4. Last resort: ephemeral key — secrets decrypt only this session.
    let key = Key::<Aes256Gcm>::generate();
    key.into()
}

fn cache_master(key: [u8; 32]) {
    if let Ok(mut guard) = MASTER.lock() {
        *guard = Some(key);
    }
}

/// True when the master key is safely persisted (keyring or file).
pub fn vault_backed() -> bool {
    if keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .and_then(|e| e.get_password())
        .is_ok()
    {
        return true;
    }
    fallback_path()
        .map(|d| d.join("vault.key").exists())
        .unwrap_or(false)
}

/// Encrypts a secret: `enc:v1:<base64(nonce || ciphertext || tag)>`.
/// Empty input stays empty (nothing to protect).
pub fn encrypt(plain: &str) -> String {
    if plain.is_empty() {
        return String::new();
    }
    let master = load_master();
    let cipher = Aes256Gcm::new(&master.into());
    let nonce = Nonce::generate();
    match cipher.encrypt(&nonce, plain.as_bytes()) {
        Ok(ct) => {
            let mut buf = nonce.to_vec();
            buf.extend_from_slice(&ct);
            format!("{MARKER}{}", base64::engine::general_purpose::STANDARD.encode(buf))
        }
        Err(e) => {
            eprintln!("[vault] encrypt failed: {e}");
            plain.to_string()
        }
    }
}

/// Decrypts a vault value. Legacy plaintext passes through unchanged.
pub fn decrypt(stored: &str) -> String {
    let Some(b64) = stored.strip_prefix(MARKER) else {
        return stored.to_string(); // legacy plaintext or empty
    };
    let Ok(buf) = base64::engine::general_purpose::STANDARD.decode(b64) else {
        return String::new();
    };
    if buf.len() < 12 {
        return String::new();
    }
    let master = load_master();
    let cipher = Aes256Gcm::new(&master.into());
    let (nonce, ct) = buf.split_at(12);
    let Ok(nonce) = Nonce::try_from(nonce) else {
        return String::new();
    };
    match cipher.decrypt(&nonce, ct) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) => {
            eprintln!("[vault] decrypt failed: {e}");
            String::new()
        }
    }
}

// Note: legacy plaintext rows need no explicit migration — decrypt()
// passes values without the "enc:v1:" marker through unchanged, and the
// next save re-encrypts them (save_server/save_key keep-or-encrypt).
