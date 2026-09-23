/// Singularity — persistence layer.
///
/// The workspace lives in a SQLite database (`sqlite:singularity.db`) managed by
/// `tauri-plugin-sql`. Migrations run on every start and are idempotent, so the
/// schema is created on first launch and the demo workspace is seeded once.
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

/// Path of the app database, relative to the app data directory.
pub const DB_URL: &str = "sqlite:singularity.db";

/// Builds the migration list handed to the SQL plugin.
pub fn migrations() -> Vec<Migration> {
    let schema = Migration {
        version: 1,
        description: "create workspace schema",
        sql: "
            CREATE TABLE IF NOT EXISTS projects (
              id          TEXT PRIMARY KEY,
              name        TEXT NOT NULL UNIQUE,
              path        TEXT NOT NULL DEFAULT '',
              sort_order  INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS conversations (
              id          TEXT PRIMARY KEY,
              project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              title       TEXT NOT NULL,
              age_label   TEXT NOT NULL DEFAULT 'now',
              pinned      INTEGER NOT NULL DEFAULT 0,
              created_at  INTEGER NOT NULL DEFAULT (unixepoch())
            );
            CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id);

            CREATE TABLE IF NOT EXISTS messages (
              id              TEXT PRIMARY KEY,
              conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
              role            TEXT NOT NULL,
              text            TEXT NOT NULL,
              created_at      INTEGER NOT NULL DEFAULT (unixepoch())
            );
            CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);

            CREATE TABLE IF NOT EXISTS providers (
              id          TEXT PRIMARY KEY,
              name        TEXT NOT NULL,
              kind        TEXT NOT NULL,
              base_url    TEXT NOT NULL DEFAULT '',
              api_key     TEXT NOT NULL DEFAULT '',
              enabled     INTEGER NOT NULL DEFAULT 0,
              status      TEXT NOT NULL DEFAULT 'disconnected',
              last_sync   INTEGER
            );

            CREATE TABLE IF NOT EXISTS models (
              id          TEXT PRIMARY KEY,
              provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
              model_id    TEXT NOT NULL,
              name        TEXT NOT NULL,
              meta        TEXT NOT NULL DEFAULT '',
              enabled     INTEGER NOT NULL DEFAULT 1,
              UNIQUE(provider_id, model_id)
            );

            CREATE TABLE IF NOT EXISTS settings (
              key   TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
        ",
        kind: MigrationKind::Up,
    };

    // Seed is a separate migration so it runs exactly once, after the schema.
    let seed = Migration {
        version: 2,
        description: "seed workspace",
        sql: "INSERT OR IGNORE INTO projects (id, name, path, sort_order) VALUES ('No project', 'No project', '', 999);",
        kind: MigrationKind::Up,
    };

    // A fresh install starts empty: only the pseudo-project that holds loose
    // chats exists, and no demo providers, models, projects or conversations.
    let clean = Migration {
        version: 4,
        description: "clean demo data, add project permissions",
        sql: "
            DELETE FROM messages WHERE conversation_id IN (
              SELECT id FROM conversations WHERE project_id <> 'No project'
            );
            DELETE FROM conversations WHERE project_id <> 'No project';
            DELETE FROM projects WHERE id <> 'No project';
            DELETE FROM models WHERE provider_id IN ('antigravity','dsh','openai');
            DELETE FROM providers WHERE id IN ('antigravity','dsh','openai');
            INSERT OR IGNORE INTO projects (id, name, path, sort_order)
              VALUES ('No project', 'No project', '', 999);

            -- Per-project permission: run commands without asking (1) or
            -- confirm every command first (0, the default).
            ALTER TABLE projects ADD COLUMN auto_run INTEGER NOT NULL DEFAULT 0;
        ",
        kind: MigrationKind::Up,
    };

    vec![schema, seed, oauth_migration(), clean]
}

/// Adds OAuth support: stored tokens plus an `auth` mode on providers.
///
/// Kept as its own migration so databases created before sign-in existed are
/// upgraded in place instead of needing a reset.
fn oauth_migration() -> Migration {
    Migration {
        version: 3,
        description: "oauth tokens",
        sql: "
            CREATE TABLE IF NOT EXISTS oauth_tokens (
              provider_id   TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
              access_token  TEXT NOT NULL DEFAULT '',
              refresh_token TEXT NOT NULL DEFAULT '',
              expires_at    INTEGER NOT NULL DEFAULT 0,
              email         TEXT NOT NULL DEFAULT '',
              scope         TEXT NOT NULL DEFAULT ''
            );

            -- How the provider authenticates: 'key' (API key) or 'bearer' (OAuth).
            ALTER TABLE providers ADD COLUMN auth TEXT NOT NULL DEFAULT 'key';
        ",
        kind: MigrationKind::Up,
    }
}

/// Absolute path of the database file, resolved from the app data directory.
pub fn db_path(app: &tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {dir:?}: {e}"))?;
    Ok(dir.join("singularity.db").to_string_lossy().to_string())
}