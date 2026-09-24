/// Singularity — persistence layer.
///
/// The workspace lives in a SQLite database (`sqlite:singularity.db`) managed by
/// `tauri-plugin-sql`. Migrations run on every start and are idempotent, so the
/// schema is created on first launch and the demo workspace is seeded once.
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

/// Path of the app database, relative to the app data directory.
pub const DB_URL: &str = "sqlite:singularity.db";

/// Demo workspace inserted on first run, mirroring the original mock data.
const SEED_PROJECTS: &[(&str, &str, i64)] = &[
    ("Singularity", r"C:\Users\nezuss\Documents\GitHub\Singularity", 0),
    ("accounting", r"C:\Users\nezuss\Documents\GitHub\accounting", 1),
    ("Auth", r"C:\Users\nezuss\Documents\GitHub\Auth", 2),
    ("CourcesPlatform", r"C:\Users\nezuss\Documents\GitHub\CourcesPlatform", 3),
    (
        "DataVisualizationMatplotlib",
        r"C:\Users\nezuss\Documents\GitHub\DataVisualizationMatplotlib",
        4,
    ),
    ("Education-Website", r"C:\Users\nezuss\Documents\GitHub\Education-Website", 5),
    ("Frontend_Booking", r"C:\Users\nezuss\Documents\GitHub\Frontend_Booking", 6),
    ("hosty", r"C:\Users\nezuss\Documents\GitHub\hosty", 7),
    ("landing", r"C:\Users\nezuss\Documents\GitHub\landing", 8),
    ("TermosClient", r"C:\Users\nezuss\Documents\GitHub\TermosClient", 9),
    ("TSKS_1gg7sgds", r"C:\Users\nezuss\Documents\GitHub\TSKS_1gg7sgds", 10),
    // Pseudo-project that holds chats belonging to no folder.
    ("No project", "", 999),
];

/// (project, conversation id, title, age label, pinned)
const SEED_CONVERSATIONS: &[(&str, &str, &str, &str, i64)] = &[
    ("Singularity", "fix-terminal-tests", "Fix flaky terminal tests", "1d", 1),
    ("Singularity", "model-router-fallback", "Add Model Router fallback", "2d", 0),
    ("Singularity", "git-sync", "Branchless git sync redesign", "3d", 0),
    ("Singularity", "sidebar-v2", "Sidebar v2 layout pass", "4d", 0),
    ("Singularity", "theme-tokens", "Theme tokens refactor", "6d", 0),
    ("Singularity", "cmd-palette", "Command palette wiring", "8d", 0),
    ("Singularity", "voice-input", "Voice input prototype", "11d", 0),
    ("Singularity", "tool-diff", "Tool diff review panel", "15d", 0),
    ("accounting", "acc-invoices", "Invoice parser refactor", "7d", 0),
    ("Auth", "auth-jwt", "JWT refresh flow", "12d", 0),
    ("Auth", "auth-oauth", "OAuth device flow", "14d", 0),
    ("Auth", "auth-sessions", "Session storage hardening", "18d", 0),
    ("Auth", "auth-mfa", "MFA enrollment", "21d", 0),
    ("Auth", "auth-keys", "Key rotation job", "25d", 0),
    ("Auth", "auth-audit", "Audit log table", "28d", 0),
    ("Auth", "auth-lockout", "Lockout policy", "31d", 0),
    ("Auth", "auth-passkeys", "Passkeys spike", "34d", 0),
    ("Education-Website", "edu-landing", "Landing page rewrite", "5d", 0),
    ("No project", "loose-scratch", "Scratch notes", "3h", 0),
    ("No project", "loose-quick", "Quick question about regex", "9h", 0),
    ("No project", "loose-draft", "Draft commit message", "2d", 0),
];

/// (id, name, kind, base_url, enabled, status)
const SEED_PROVIDERS: &[(&str, &str, &str, &str, i64, &str)] = &[
    ("antigravity", "Google Antigravity", "google", "https://generativelanguage.googleapis.com", 0, "disconnected"),
    ("dsh", "DeepSeek Harness", "openai-compatible", "http://127.0.0.1:8080", 1, "ready"),
    ("openai", "OpenAI · BYOK", "openai", "https://api.openai.com/v1", 0, "disconnected"),
];

/// (id, provider, model id, display name, meta)
const SEED_MODELS: &[(&str, &str, &str, &str, &str)] = &[
    ("m-gemini-3-pro", "antigravity", "gemini-3-pro", "Gemini 3 Pro", "Artifacts"),
    ("m-gemini-3-flash", "antigravity", "gemini-3-flash", "Gemini 3 Flash", "fast"),
    ("m-deepseek-v4", "dsh", "deepseek-v4", "DeepSeek V4", "Reasoner"),
    ("m-deepseek-r2", "dsh", "deepseek-r2", "DeepSeek Reasoner R2", "thinking"),
    ("m-gpt-4o", "openai", "gpt-4o", "GPT-4o", "BYOK"),
    ("m-o3-mini", "openai", "o3-mini", "o3-mini", "BYOK"),
];

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
    // `Migration.sql` needs a `&'static str`, hence the leaked-once static.
    static SEED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let seed = Migration {
        version: 2,
        description: "seed demo workspace",
        sql: SEED.get_or_init(seed_sql).as_str(),
        kind: MigrationKind::Up,
    };

    // IMPORTANT: never edit an already-applied migration. sqlx records a
    // checksum per version in `_sqlx_migrations` and refuses to run ANY
    // migration when one of them no longer matches, which silently leaves the
    // schema behind while the frontend expects the new columns.
    // Schema changes therefore always go in a new version at the end.
    vec![
        schema,
        seed,
        oauth_migration(),
        clean_demo_migration(),
        finish_cleanup_migration(),
        activity_stamp_migration(),
        message_meta_migration(),
        project_permission_migration(),
    ]
}

/// Version 7 — messages carry generation time and attached images.
///
/// `duration_ms` is how long the agent spent producing this turn; `images` is
/// a JSON array of `{name, mime, data_url}` so photo attachments survive a
/// reload and can be re-opened from the chat.
fn message_meta_migration() -> Migration {
    Migration {
        version: 7,
        description: "message duration and images",
        sql: "
            ALTER TABLE messages ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE messages ADD COLUMN images TEXT NOT NULL DEFAULT '[]';
        ",
        kind: MigrationKind::Up,
    }
}

/// Version 8 — per-project command permission mode.
///
/// `default` inherits the global setting, `bypass` runs commands without
/// asking, `ask` always prompts. The older `auto_run` boolean is migrated
/// across so existing projects keep their behavior.
fn project_permission_migration() -> Migration {
    Migration {
        version: 8,
        description: "project permission mode",
        sql: "
            ALTER TABLE projects ADD COLUMN perm_mode TEXT NOT NULL DEFAULT 'default';
            UPDATE projects SET perm_mode = 'bypass' WHERE auto_run = 1;
        ",
        kind: MigrationKind::Up,
    }
}

/// Version 6 — conversations track when they were last used.
///
/// The sidebar used to show a frozen `age_label` string ("now") captured at
/// creation, so every chat claimed to be brand new forever. `updated_at` is
/// bumped on every stored message and the UI derives "41s / 2h / 3d" from it.
fn activity_stamp_migration() -> Migration {
    Migration {
        version: 6,
        description: "conversation last activity",
        sql: "
            ALTER TABLE conversations ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
            UPDATE conversations SET updated_at = created_at WHERE updated_at = 0;
            CREATE INDEX IF NOT EXISTS idx_conv_activity ON conversations(updated_at);
        ",
        kind: MigrationKind::Up,
    }
}

/// Version 5 — leftovers version 4 could not know about.
///
/// The three demo chats seeded back in version 2 live in the "No project"
/// bucket, which version 4 deliberately preserved (that is where real loose
/// chats belong). Their ids are stable strings, so they can be removed
/// exactly without touching anything the user created.
fn finish_cleanup_migration() -> Migration {
    Migration {
        version: 5,
        description: "remove remaining demo chats",
        sql: "
            DELETE FROM messages WHERE conversation_id IN ('loose-scratch','loose-quick','loose-draft');
            DELETE FROM conversations WHERE id IN ('loose-scratch','loose-quick','loose-draft');

            -- Safety net: any chat whose project row is gone moves into the
            -- loose bucket instead of vanishing from the sidebar forever.
            INSERT OR IGNORE INTO projects (id, name, path, sort_order)
              VALUES ('No project', 'No project', '', 999);
            UPDATE conversations SET project_id = 'No project'
             WHERE project_id NOT IN (SELECT id FROM projects);
        ",
        kind: MigrationKind::Up,
    }
}

/// Version 4 — a fresh install starts empty, plus per-project permissions.
///
/// Deletes only the *known* demo rows by id, so anything the user created
/// before this migration runs is left alone. The seed migration above stays
/// untouched (it must keep matching its recorded checksum); on a brand-new
/// database it inserts the demo rows and this one removes them again, so the
/// end state is clean either way.
fn clean_demo_migration() -> Migration {
    Migration {
        version: 4,
        description: "remove demo data, add project auto_run",
        sql: "
            DELETE FROM messages WHERE conversation_id IN (
              SELECT id FROM conversations WHERE project_id IN (
                'Singularity','accounting','Auth','CourcesPlatform',
                'DataVisualizationMatplotlib','Education-Website',
                'Frontend_Booking','hosty','landing','TermosClient','TSKS_1gg7sgds'
              )
            );
            DELETE FROM conversations WHERE project_id IN (
              'Singularity','accounting','Auth','CourcesPlatform',
              'DataVisualizationMatplotlib','Education-Website',
              'Frontend_Booking','hosty','landing','TermosClient','TSKS_1gg7sgds'
            );
            DELETE FROM projects WHERE id IN (
              'Singularity','accounting','Auth','CourcesPlatform',
              'DataVisualizationMatplotlib','Education-Website',
              'Frontend_Booking','hosty','landing','TermosClient','TSKS_1gg7sgds'
            );
            DELETE FROM models WHERE provider_id IN ('antigravity','dsh','openai');
            DELETE FROM providers WHERE id IN ('antigravity','dsh','openai');

            -- The bucket for chats that belong to no project must always exist.
            INSERT OR IGNORE INTO projects (id, name, path, sort_order)
              VALUES ('No project', 'No project', '', 999);

            -- Per-project permission: run commands without asking (1) or
            -- confirm every command first (0, the default).
            ALTER TABLE projects ADD COLUMN auto_run INTEGER NOT NULL DEFAULT 0;
        ",
        kind: MigrationKind::Up,
    }
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

/// Renders the seed rows as one SQL script (skipped when data already exists).
fn seed_sql() -> String {
    let mut sql = String::new();

    sql.push_str("INSERT OR IGNORE INTO providers (id, name, kind, base_url, enabled, status) VALUES ");
    sql.push_str(
        &SEED_PROVIDERS
            .iter()
            .map(|(id, name, kind, url, enabled, status)| {
                format!("('{id}', '{name}', '{kind}', '{url}', {enabled}, '{status}')")
            })
            .collect::<Vec<_>>()
            .join(", "),
    );
    sql.push_str(";\n");

    sql.push_str("INSERT OR IGNORE INTO models (id, provider_id, model_id, name, meta) VALUES ");
    sql.push_str(
        &SEED_MODELS
            .iter()
            .map(|(id, provider, model_id, name, meta)| {
                format!("('{id}', '{provider}', '{model_id}', '{name}', '{meta}')")
            })
            .collect::<Vec<_>>()
            .join(", "),
    );
    sql.push_str(";\n");

    sql.push_str("INSERT OR IGNORE INTO projects (id, name, path, sort_order) VALUES ");
    sql.push_str(
        &SEED_PROJECTS
            .iter()
            .map(|(name, path, order)| {
                let escaped = path.replace('\\', "\\\\");
                format!("('{name}', '{name}', '{escaped}', {order})")
            })
            .collect::<Vec<_>>()
            .join(", "),
    );
    sql.push_str(";\n");

    sql.push_str("INSERT OR IGNORE INTO conversations (id, project_id, title, age_label, pinned) VALUES ");
    sql.push_str(
        &SEED_CONVERSATIONS
            .iter()
            .map(|(project, id, title, age, pinned)| {
                format!("('{id}', '{project}', '{title}', '{age}', {pinned})")
            })
            .collect::<Vec<_>>()
            .join(", "),
    );
    sql.push_str(";\n");

    sql
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