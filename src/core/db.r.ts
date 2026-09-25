/**
 * Singularity — persistence layer (frontend side).
 *
 * Everything the workspace needs to survive a restart lives in SQLite through
 * `tauri-plugin-sql`. Outside Tauri (plain `vite dev` in a browser) the same API
 * transparently falls back to an in-memory store, so the UI always boots.
 */
import type {
  Conversation,
  Model,
  OAuthTokens,
  PermMode,
  Project,
  Provider,
  ProviderKind,
  ProviderStatus,
  SshLog,
  SshServer,
  StoredImage,
  StoredMessage,
} from "./types.i";
import { NO_PROJECT } from "./types.i";

export type { Model, OAuthTokens, Provider, StoredImage, StoredMessage };

/** Shape returned by the in-memory fallback, mirroring the SQL rows. */
interface MemoryStore {
  projects: Project[];
  providers: Provider[];
  models: Model[];
  messages: StoredMessage[];
  settings: Record<string, string>;
  sshServers: SshServer[];
  sshLogs: SshLog[];
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/* ---------- In-memory fallback (browser dev) ---------- */

const memory: MemoryStore = {
  projects: [],
  providers: [],
  models: [],
  messages: [],
  settings: {},
  sshServers: [],
  sshLogs: [],
};

const memId = () => `mem-${Math.random().toString(36).slice(2, 10)}`;

/* ---------- Connection ---------- */

type SqlDb = {
  select: <T>(query: string, bindValues?: unknown[]) => Promise<T>;
  execute: (query: string, bindValues?: unknown[]) => Promise<unknown>;
};

let dbPromise: Promise<SqlDb | null> | null = null;

async function getDb(): Promise<SqlDb | null> {
  if (!inTauri) return null;
  if (!dbPromise) {
    dbPromise = (async () => {
      const mod = await import("@tauri-apps/plugin-sql");
      return (await mod.default.load("sqlite:singularity.db")) as unknown as SqlDb;
    })().catch((e) => {
      console.error("[db] cannot open database, falling back to memory:", e);
      return null;
    });
  }
  return dbPromise;
}

/** True when the real database is in use (as opposed to the memory fallback). */
export async function isPersistent(): Promise<boolean> {
  return (await getDb()) !== null;
}

/* ---------- Workspace (projects + conversations) ---------- */

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  sort_order: number;
  auto_run: number;
  /** `bypass` / `ask` / `default`; absent on databases predating migration 8. */
  perm_mode?: string;
}

interface ConvRow {
  id: string;
  project_id: string;
  title: string;
  age_label: string;
  pinned: number;
  /** Unix seconds of the last message; 0 on databases predating migration 6. */
  updated_at?: number;
  created_at?: number;
}

/** Loads the whole project tree with its conversations, ordered for the sidebar. */
export async function loadProjects(): Promise<Project[]> {
  const db = await getDb();
  if (!db) return memory.projects;

  // `auto_run` arrived in migration 4, `perm_mode` in 8. If the schema is
  // somehow older, retry with fewer columns instead of failing the sidebar.
  let rows: ProjectRow[];
  try {
    rows = await db.select<ProjectRow[]>(
      "SELECT id, name, path, sort_order, auto_run, perm_mode FROM projects ORDER BY sort_order, name"
    );
  } catch {
    try {
      rows = await db.select<Omit<ProjectRow, "perm_mode">[]>(
        "SELECT id, name, path, sort_order, auto_run FROM projects ORDER BY sort_order, name"
      ).then((rs) => rs.map((r) => ({ ...r, perm_mode: undefined })));
    } catch {
      rows = await db.select<Omit<ProjectRow, "auto_run" | "perm_mode">[]>(
        "SELECT id, name, path, sort_order FROM projects ORDER BY sort_order, name"
      ).then((rs) => rs.map((r) => ({ ...r, auto_run: 0, perm_mode: undefined })));
    }
  }

  // `updated_at` arrived in migration 6; fall back to `created_at` on an
  // older schema so the sidebar still loads either way.
  let convs: ConvRow[];
  try {
    convs = await db.select<ConvRow[]>(
      `SELECT id, project_id, title, age_label, pinned, updated_at, created_at
         FROM conversations
        ORDER BY pinned DESC, updated_at DESC`
    );
  } catch {
    convs = await db.select<ConvRow[]>(
      `SELECT id, project_id, title, age_label, pinned, created_at
         FROM conversations
        ORDER BY pinned DESC, created_at DESC`
    );
  }

  return rows.map((p) => ({
    name: p.name,
    path: p.path,
    permMode: (["bypass", "ask", "default"].includes(p.perm_mode ?? "")
      ? p.perm_mode
      : p.auto_run === 1
        ? "bypass"
        : "default") as PermMode,
    conversations: convs
      .filter((c) => c.project_id === p.name)
      .map<Conversation>((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updated_at || c.created_at || 0,
        pinned: c.pinned === 1,
      })),
  }));
}

export async function insertProject(project: Project, sortOrder: number): Promise<void> {
  const db = await getDb();
  if (!db) {
    memory.projects.push(project);
    return;
  }
  await db.execute(
    `INSERT OR IGNORE INTO projects (id, name, path, sort_order, auto_run, perm_mode)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      project.name,
      project.name,
      project.path,
      sortOrder,
      project.permMode === "bypass" ? 1 : 0,
      project.permMode ?? "default",
    ]
  );
}

/**
 * Deletes a project. Its conversations are NOT deleted — they move into the
 * "No project" bucket so no chat history is ever lost.
 */
export async function deleteProject(name: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    const victim = memory.projects.find((p) => p.name === name);
    const bucket = memory.projects.find((p) => p.name === NO_PROJECT);
    if (victim && bucket) bucket.conversations.unshift(...victim.conversations);
    memory.projects = memory.projects.filter((p) => p.name !== name);
    return;
  }
  await db.execute(
    `UPDATE conversations SET project_id = $1 WHERE project_id = $2`,
    [NO_PROJECT, name]
  );
  await db.execute("DELETE FROM projects WHERE name = $1", [name]);
}

/** Sets the per-project command permission mode (bypass / default / ask). */
export async function setProjectPermMode(name: string, mode: PermMode): Promise<void> {
  const db = await getDb();
  if (!db) {
    const p = memory.projects.find((x) => x.name === name);
    if (p) p.permMode = mode;
    return;
  }
  try {
    await db.execute("UPDATE projects SET perm_mode = $1, auto_run = $2 WHERE name = $3", [
      mode,
      mode === "bypass" ? 1 : 0,
      name,
    ]);
  } catch {
    // Schema predating migration 8 — keep the old boolean working.
    await db.execute("UPDATE projects SET auto_run = $1 WHERE name = $2", [
      mode === "bypass" ? 1 : 0,
      name,
    ]);
  }
}

/** Renames a project everywhere: the row itself and all chats that point at it. */
export async function renameProject(oldName: string, newName: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    const p = memory.projects.find((x) => x.name === oldName);
    if (p) p.name = newName;
    return;
  }
  await db.execute("UPDATE projects SET id = $1, name = $1 WHERE name = $2", [
    newName,
    oldName,
  ]);
  await db.execute("UPDATE conversations SET project_id = $1 WHERE project_id = $2", [
    newName,
    oldName,
  ]);
}

/* ---------- Conversations ---------- */

export async function insertConversation(
  project: string,
  conv: Conversation
): Promise<void> {
  const db = await getDb();
  const stamp = conv.updatedAt || Math.floor(Date.now() / 1000);
  if (!db) {
    const p = memory.projects.find((x) => x.name === project);
    p?.conversations.unshift({ ...conv, updatedAt: stamp });
    return;
  }
  await db.execute(
    `INSERT OR IGNORE INTO conversations (id, project_id, title, age_label, pinned, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [conv.id, project, conv.title, "", conv.pinned ? 1 : 0, stamp]
  );
}

export async function updateConversationTitle(id: string, title: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    for (const p of memory.projects) {
      const c = p.conversations.find((x) => x.id === id);
      if (c) c.title = title;
    }
    return;
  }
  await db.execute("UPDATE conversations SET title = $1 WHERE id = $2", [title, id]);
}

export async function updateConversationPinned(id: string, pinned: boolean): Promise<void> {
  const db = await getDb();
  if (!db) {
    for (const p of memory.projects) {
      const c = p.conversations.find((x) => x.id === id);
      if (c) c.pinned = pinned;
    }
    return;
  }
  await db.execute("UPDATE conversations SET pinned = $1 WHERE id = $2", [
    pinned ? 1 : 0,
    id,
  ]);
}

export async function removeConversation(id: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    for (const p of memory.projects) {
      p.conversations = p.conversations.filter((c) => c.id !== id);
    }
    memory.messages = memory.messages.filter((m) => m.conversation_id !== id);
    return;
  }
  await db.execute("DELETE FROM messages WHERE conversation_id = $1", [id]);
  await db.execute("DELETE FROM conversations WHERE id = $1", [id]);
}

/* ---------- Messages ---------- */

export async function loadMessages(conversationId: string): Promise<StoredMessage[]> {
  const db = await getDb();
  if (!db) {
    return memory.messages.filter((m) => m.conversation_id === conversationId);
  }
  // duration_ms/images arrived in migration 7, segments in 9; fall back
  // stepwise on older schemas instead of failing the chat.
  try {
    return await db.select<StoredMessage[]>(
      `SELECT conversation_id, role, text, created_at, duration_ms, images, segments
         FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at, rowid`,
      [conversationId]
    );
  } catch {
    try {
      return await db.select<StoredMessage[]>(
        `SELECT conversation_id, role, text, created_at, duration_ms, images
           FROM messages
          WHERE conversation_id = $1
          ORDER BY created_at, rowid`,
        [conversationId]
      );
    } catch {
      return db.select<StoredMessage[]>(
        `SELECT conversation_id, role, text, created_at
           FROM messages
          WHERE conversation_id = $1
          ORDER BY created_at, rowid`,
        [conversationId]
      );
    }
  }
}

export interface MessageMeta {
  /** How long the model spent producing this turn (agent messages). */
  durationMs?: number;
  /** Image attachments carried with a user message. */
  images?: StoredImage[];
  /**
   * Serialized interleaved segments of an agent turn (Segment[] from
   * message.i) — the tool steps and their outputs the chat renders between
   * prose blocks. Storing them keeps a conversation's "actions" visible
   * after a restart, panel tabs included.
   */
  segmentsJson?: string;
}

export async function appendMessage(
  conversationId: string,
  role: "user" | "agent",
  text: string,
  meta: MessageMeta = {}
): Promise<void> {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const imagesJson = JSON.stringify(meta.images ?? []);
  const segmentsJson = meta.segmentsJson ?? "[]";
  const row: StoredMessage = {
    conversation_id: conversationId,
    role,
    text,
    created_at: now,
    duration_ms: meta.durationMs ?? 0,
    images: imagesJson,
    segments: segmentsJson,
  };
  if (!db) {
    memory.messages.push(row);
    for (const p of memory.projects) {
      const c = p.conversations.find((x) => x.id === conversationId);
      if (c) c.updatedAt = now;
    }
    return;
  }
  try {
    await db.execute(
      `INSERT INTO messages (id, conversation_id, role, text, duration_ms, images, segments)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        memId(),
        conversationId,
        role,
        text,
        meta.durationMs ?? 0,
        imagesJson,
        segmentsJson,
      ]
    );
  } catch {
    try {
      // Schema predating migration 9 — store without the segments column.
      await db.execute(
        `INSERT INTO messages (id, conversation_id, role, text, duration_ms, images)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [memId(), conversationId, role, text, meta.durationMs ?? 0, imagesJson]
      );
    } catch {
      // Schema predating migration 7 — the bare minimum.
      await db.execute(
        `INSERT INTO messages (id, conversation_id, role, text)
         VALUES ($1, $2, $3, $4)`,
        [memId(), conversationId, role, text]
      );
    }
  }
  // Bump the conversation's activity stamp so the sidebar shows a live age.
  // Guarded: on a database predating migration 6 the column does not exist.
  try {
    await db.execute("UPDATE conversations SET updated_at = $1 WHERE id = $2", [
      now,
      conversationId,
    ]);
  } catch {
    /* older schema — the sidebar falls back to created_at */
  }
}

/** Touches a conversation's activity stamp without storing a message. */
export async function touchConversation(conversationId: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const db = await getDb();
  if (!db) {
    for (const p of memory.projects) {
      const c = p.conversations.find((x) => x.id === conversationId);
      if (c) c.updatedAt = now;
    }
    return now;
  }
  try {
    await db.execute("UPDATE conversations SET updated_at = $1 WHERE id = $2", [
      now,
      conversationId,
    ]);
  } catch {
    /* older schema */
  }
  return now;
}

/* ---------- Providers & models ---------- */

interface ProviderRow {
  id: string;
  name: string;
  kind: string;
  base_url: string;
  api_key: string;
  enabled: number;
  status: string;
  last_sync: number | null;
  auth: string | null;
}

interface ModelRow {
  id: string;
  provider_id: string;
  model_id: string;
  name: string;
  meta: string;
  enabled: number;
}

export async function loadProviders(): Promise<Provider[]> {
  const db = await getDb();
  if (!db) return memory.providers;
  const rows = await db.select<ProviderRow[]>(
    `SELECT id, name, kind, base_url, api_key, enabled, status, last_sync, auth
       FROM providers ORDER BY name`
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind as ProviderKind,
    base_url: r.base_url,
    api_key: r.api_key,
    enabled: r.enabled === 1,
    status: r.status as ProviderStatus,
    last_sync: r.last_sync,
    auth: (r.auth as Provider["auth"]) ?? "key",
  }));
}

export async function loadModels(): Promise<Model[]> {
  const db = await getDb();
  if (!db) return memory.models;
  const rows = await db.select<ModelRow[]>(
    "SELECT id, provider_id, model_id, name, meta, enabled FROM models ORDER BY name"
  );
  return rows.map((r) => ({
    id: r.id,
    provider_id: r.provider_id,
    model_id: r.model_id,
    name: r.name,
    meta: r.meta,
    enabled: r.enabled === 1,
  }));
}

export async function upsertProvider(p: Provider): Promise<void> {
  const db = await getDb();
  if (!db) {
    const i = memory.providers.findIndex((x) => x.id === p.id);
    if (i >= 0) memory.providers[i] = p;
    else memory.providers.push(p);
    return;
  }
  await db.execute(
    `INSERT INTO providers (id, name, kind, base_url, api_key, enabled, status, auth)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       kind = excluded.kind,
       base_url = excluded.base_url,
       api_key = excluded.api_key,
       enabled = excluded.enabled,
       status = excluded.status,
       auth = excluded.auth`,
    [p.id, p.name, p.kind, p.base_url, p.api_key, p.enabled ? 1 : 0, p.status, p.auth]
  );
}

export async function removeProvider(id: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    memory.providers = memory.providers.filter((p) => p.id !== id);
    memory.models = memory.models.filter((m) => m.provider_id !== id);
    return;
  }
  await db.execute("DELETE FROM models WHERE provider_id = $1", [id]);
  await db.execute("DELETE FROM providers WHERE id = $1", [id]);
}

/**
 * Replaces a provider's model list with a freshly discovered one.
 * Runs as delete-then-insert so removed models actually disappear.
 */
export async function replaceModels(providerId: string, models: Model[]): Promise<void> {
  const db = await getDb();
  if (!db) {
    memory.models = [
      ...memory.models.filter((m) => m.provider_id !== providerId),
      ...models,
    ];
    return;
  }
  await db.execute("DELETE FROM models WHERE provider_id = $1", [providerId]);
  for (const m of models) {
    await db.execute(
      `INSERT INTO models (id, provider_id, model_id, name, meta, enabled)
       VALUES ($1, $2, $3, $4, $5, 1)`,
      [m.id, m.provider_id, m.model_id, m.name, m.meta]
    );
  }
  await db.execute("UPDATE providers SET last_sync = $1 WHERE id = $2", [
    Math.floor(Date.now() / 1000),
    providerId,
  ]);
}

/* ---------- Settings ---------- */

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return memory.settings[key] ?? null;
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = $1",
    [key]
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    memory.settings[key] = value;
    return;
  }
  await db.execute(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

/** Seeds the in-memory store so browser dev shows the same demo workspace. */
export function seedMemory(projects: Project[], providers: Provider[], models: Model[]) {
  memory.projects = projects;
  memory.providers = providers;
  memory.models = models;
}


/* ---------- OAuth tokens (Google sign-in) ---------- */

interface TokenRow {
  provider_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  email: string;
  scope: string;
}

/** In-memory token mirror used when SQLite is unavailable. */
const memoryTokens = new Map<string, OAuthTokens>();

export async function loadTokens(providerId: string): Promise<OAuthTokens | null> {
  const db = await getDb();
  if (!db) return memoryTokens.get(providerId) ?? null;
  const rows = await db.select<TokenRow[]>(
    `SELECT provider_id, access_token, refresh_token, expires_at, email, scope
       FROM oauth_tokens WHERE provider_id = $1`,
    [providerId]
  );
  return rows[0] ?? null;
}

export async function saveTokens(tokens: OAuthTokens): Promise<void> {
  const db = await getDb();
  if (!db) {
    memoryTokens.set(tokens.provider_id, tokens);
    return;
  }
  await db.execute(
    `INSERT INTO oauth_tokens (provider_id, access_token, refresh_token, expires_at, email, scope)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(provider_id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       email = excluded.email,
       scope = excluded.scope`,
    [
      tokens.provider_id,
      tokens.access_token,
      tokens.refresh_token,
      tokens.expires_at,
      tokens.email,
      tokens.scope,
    ]
  );
}

export async function clearTokens(providerId: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    memoryTokens.delete(providerId);
    return;
  }
  await db.execute("DELETE FROM oauth_tokens WHERE provider_id = $1", [providerId]);
}

/* ---------- Google sign-in (Rust commands) ---------- */

interface RustTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  email: string;
  scope: string;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call<T>(cmd, args);
}

/**
 * Runs the interactive OAuth flow: opens the browser, waits for the loopback
 * redirect, and returns tokens ready to be persisted.
 */
export async function googleSignIn(
  providerId: string,
  clientId: string,
  clientSecret: string
): Promise<{ tokens?: OAuthTokens; error?: string }> {
  if (!inTauri) {
    return { error: "Google sign-in needs the desktop shell (npm run tauri:dev)" };
  }
  try {
    const res = await invoke<{ tokens: RustTokens }>("google_sign_in", {
      clientId,
      clientSecret,
    });
    const tokens: OAuthTokens = { provider_id: providerId, ...res.tokens };
    await saveTokens(tokens);
    return { tokens };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Returns a valid access token, refreshing it first when it is about to expire.
 * This is what makes a signed-in provider keep working across restarts.
 */
export async function validAccessToken(
  providerId: string,
  clientId: string,
  clientSecret: string
): Promise<{ token?: string; error?: string }> {
  const stored = await loadTokens(providerId);
  if (!stored) return { error: "Not signed in" };

  const now = Math.floor(Date.now() / 1000);
  if (stored.access_token && stored.expires_at - 60 > now) {
    return { token: stored.access_token };
  }
  if (!stored.refresh_token) return { error: "Session expired — sign in again" };
  if (!inTauri) return { error: "Refreshing needs the desktop shell" };

  try {
    const res = await invoke<RustTokens>("google_refresh", {
      clientId,
      clientSecret,
      refreshToken: stored.refresh_token,
    });
    const merged: OAuthTokens = {
      ...stored,
      ...res,
      // A refresh may omit the refresh token; keep the original.
      refresh_token: res.refresh_token || stored.refresh_token,
      email: res.email || stored.email,
    };
    await saveTokens(merged);
    return { token: merged.access_token };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Adds a single model row (manual creation in Settings). */
export async function addModel(model: Model): Promise<void> {
  const db = await getDb();
  if (!db) {
    if (!memory.models.some((m) => m.id === model.id)) memory.models.push(model);
    return;
  }
  await db.execute(
    `INSERT INTO models (id, provider_id, model_id, name, meta, enabled)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       meta = excluded.meta,
       enabled = excluded.enabled`,
    [
      model.id,
      model.provider_id,
      model.model_id,
      model.name,
      model.meta,
      model.enabled ? 1 : 0,
    ]
  );
}

/** Removes one model row by id. */
export async function removeModel(modelId: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    memory.models = memory.models.filter((m) => m.id !== modelId);
    return;
  }
  await db.execute("DELETE FROM models WHERE id = $1", [modelId]);
}

/* ---------- Model discovery (runs in Rust — no CORS, no allowlist) ---------- */

/** Generates a stable id for a model row. */
export function modelRowId(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export interface DiscoveryResult {
  models: Model[];
  error?: string;
}

interface RustModel {
  model_id: string;
  name: string;
  meta: string;
}

/**
 * Asks a provider which models it currently serves and returns `Model` rows
 * ready to be written with `replaceModels`.
 *
 * The request runs through the Rust command `list_provider_models`, which uses
 * reqwest directly — the frontend HTTP plugin's capability allowlist does not
 * apply, so third-party gateways (any duckdns/vps endpoint) work exactly like
 * localhost ones.
 */
export async function discoverModels(
  provider: Provider,
  oauth?: { clientId: string; clientSecret: string }
): Promise<DiscoveryResult> {
  try {
    if (provider.kind === "google" && provider.auth === "bearer" && oauth) {
      // Resolve a fresh OAuth token before listing.
      const res = await validAccessToken(provider.id, oauth.clientId, oauth.clientSecret);
      if (res.error) return { models: [], error: res.error };
      return await invokeDiscovery(provider, res.token ?? "");
    }
    if (provider.kind === "google" && !provider.api_key.trim() && provider.auth !== "bearer") {
      return { models: [], error: "Sign in with Google or provide an API key" };
    }
    return await invokeDiscovery(provider, provider.api_key);
  } catch (e) {
    return { models: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Calls the Rust discovery command and maps rows for the database. */
async function invokeDiscovery(provider: Provider, apiKey: string): Promise<DiscoveryResult> {
  if (!inTauri) {
    return {
      models: [],
      error: "Model discovery needs the desktop shell (npm run tauri:dev)",
    };
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const listed = await invoke<RustModel[]>("list_provider_models", {
      req: {
        kind: provider.kind,
        base_url: provider.base_url,
        api_key: apiKey,
        auth: provider.auth,
      },
    });
    return {
      models: listed.map((m) => ({
        id: modelRowId(provider.id, m.model_id),
        provider_id: provider.id,
        model_id: m.model_id,
        name: m.name,
        meta: m.meta,
        enabled: true,
      })),
    };
  } catch (e) {
    return { models: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/* ---------- Inference ---------- */

export interface ChatTurn {
  role: "user" | "agent";
  text: string;
}

/** An image attachment, carried as a data URL and converted per protocol. */
export interface ImageAttachment {
  /** Original filename — stored with the message for later viewing; the Rust
   * side ignores it (serde skips unknown fields). */
  name?: string;
  mime: string;
  data_url: string;
}

export interface ProviderConfig {
  kind: string;
  base_url: string;
  api_key: string;
  auth: "key" | "bearer";
  model: string;
  system: string;
  /** `low`, `medium` or `high` — ignored by providers without reasoning modes. */
  effort?: "low" | "medium" | "high";
  /** Images attached to the final user turn. */
  images?: ImageAttachment[];
}

/**
 * Starts a streaming completion and wires the Rust events to `onDelta`.
 *
 * Resolves with the full answer text. Errors from the provider come back as a
 * thrown Error so the chat surface can show them inline.
 */
export async function streamChat(
  requestId: string,
  provider: ProviderConfig,
  turns: ChatTurn[],
  onDelta: (delta: string) => void
): Promise<string> {
  if (!inTauri) {
    throw new Error("Model calls need the desktop shell (npm run tauri:dev)");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  let full = "";
  const unlisten = await listen<{ request_id: string; delta: string }>("chat://delta", (e) => {
    if (e.payload.request_id !== requestId) return;
    full += e.payload.delta;
    onDelta(e.payload.delta);
  });

  try {
    await invoke("chat_stream", { requestId, provider, turns });
    return full;
  } catch (e) {
    // Stop is not a failure: whatever streamed in is the answer.
    if (isStopError(e instanceof Error ? e.message : String(e))) return full;
    throw e;
  } finally {
    unlisten();
  }
}

/** Resolves the credential a provider should authenticate with at call time. */
export async function credentialFor(
  provider: Provider,
  oauth?: { clientId: string; clientSecret: string }
): Promise<{ apiKey: string; auth: "key" | "bearer"; error?: string }> {
  if (provider.auth === "bearer" && provider.kind === "google" && oauth) {
    const res = await validAccessToken(provider.id, oauth.clientId, oauth.clientSecret);
    if (res.error) return { apiKey: "", auth: "key", error: res.error };
    return { apiKey: res.token ?? "", auth: "bearer" };
  }
  if (!provider.api_key.trim()) {
    return { apiKey: "", auth: "key", error: `${provider.name} has no credentials` };
  }
  return { apiKey: provider.api_key, auth: "key" };
}

/* ---------- Agent (tool-using) run ---------- */

export interface AgentRequest {
  kind: string;
  base_url: string;
  api_key: string;
  auth: "key" | "bearer";
  model: string;
  system: string;
  workspace: string;
  /** `low`, `medium` or `high` — reasoning depth where the provider supports it. */
  effort?: "low" | "medium" | "high";
  /** When true, commands run without asking; false shows an Allow/Deny prompt. */
  auto_run?: boolean;
  /** Images attached to the final user turn. */
  images?: ImageAttachment[];
  /**
   * Saved SSH units the agent may use through the ssh_exec tool. Name + host
   * only — credentials stay in the database and are resolved server-side.
   */
  ssh_units?: { id: string; name: string; host: string }[];
}

export interface AgentStepEvent {
  name: string;
  input: string;
  result: string;
  ok: boolean;
  index: number;
  /** False while the tool runs; the UI then shows a spinner instead of "done". */
  done: boolean;
  /** Set by write_file/edit_file — the file the Changes panel can diff. */
  path?: string;
  /** Content before the change; undefined when the file was newly created. */
  old_text?: string;
  /** Content after the change. */
  new_text?: string;
}

/** Marks an error as "the user pressed Stop", so callers keep partial output. */
export const STOPPED = "stopped by user";
export function isStopError(message: string): boolean {
  return message.startsWith(STOPPED);
}

/** Asks Rust to stop a running generation (agent loop or chat stream). */
export async function stopGeneration(runId: string): Promise<void> {
  if (!inTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("stop_generation", { runId });
}

/**
 * Dictation — fully local. The recorded blob is decoded in the browser,
 * downsampled to a 16 kHz mono WAV and handed to Rust, where Whisper.cpp
 * transcribes it on-device. No provider, no API key, no network ever.
 *
 * Throws when the desktop shell is missing so the caller can show a notice.
 */
export async function transcribeAudio(
  audioBlob: Blob,
  language?: string
): Promise<string> {
  if (!inTauri) throw new Error("Dictation needs the desktop shell (npm run tauri:dev)");
  const { invoke } = await import("@tauri-apps/api/core");
  const wav = await encodeWav16k(audioBlob);
  // The WAV crosses as the RAW invoke body (Tauri v2 binary IPC — no JSON
  // number-array detour); the language rides along in a request header.
  return invoke<string>("transcribe_audio", wav, {
    headers: { "x-dictation-language": language ?? "" },
  });
}

/**
 * Progress of the one-time local voice model download (Rust → UI).
 * Returns a disposer. Emissions: {percent, done} — percent < 100 while the
 * model downloads, done=true once it is usable.
 */
export async function onSttProgress(
  handler: (p: { percent: number; done: boolean }) => void
): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ percent: number; done: boolean }>("stt://progress", (e) => handler(e.payload));
}

/* ---------- WAV encoding (browser side) ---------- */

/**
 * Decodes any recorded blob (webm/opus, mp4…) with the browser's own decoder
 * and re-renders it as a 16 kHz mono 16-bit WAV — the exact format the Rust
 * side feeds to Whisper. Doing it here means Rust needs no container/codec
 * support beyond plain WAV.
 */
async function encodeWav16k(blob: Blob): Promise<Uint8Array> {
  const raw = await blob.arrayBuffer();
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error("Audio decoding is unavailable in this environment");
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(raw);
    const rate = 16000;
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return floatToWav(rendered.getChannelData(0), rate);
  } finally {
    void ctx.close();
  }
}

/** Packs mono f32 samples into a canonical 16-bit PCM WAV. */
function floatToWav(samples: Float32Array, rate: number): Uint8Array {
  const bytes = 44 + samples.length * 2;
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, bytes - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** A command waiting for the user's permission. */
export interface ConfirmRequest {
  run_id: string;
  command: string;
  cwd: string;
}

/**
 * Runs the agent loop in Rust.
 *
 * Progress arrives on `agent://think` (model reasoning, shown but never stored),
 * `agent://text` (the answer prose), `agent://step` (each tool call and its
 * output) and terminates with `agent://done` or `agent://error`.
 * Returns the final answer text.
 */
export async function runAgent(
  runId: string,
  request: AgentRequest,
  turns: ChatTurn[],
  handlers: {
    onText: (delta: string) => void;
    onStep: (step: AgentStepEvent) => void;
    /** Reasoning deltas — optional, so plain chat callers are unaffected. */
    onThink?: (delta: string) => void;
    /** A command is waiting for permission; the UI shows Allow/Deny. */
    onConfirm?: (req: ConfirmRequest) => void;
  }
): Promise<string> {
  if (!inTauri) {
    throw new Error("The agent needs the desktop shell (npm run tauri:dev)");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  let full = "";
  const listeners = await Promise.all([
    listen<{ run_id: string; delta: string }>("agent://text", (e) => {
      if (e.payload.run_id !== runId) return;
      full += e.payload.delta;
      handlers.onText(e.payload.delta);
    }),
    listen<AgentStepEvent & { run_id: string }>("agent://step", (e) => {
      if (e.payload.run_id !== runId) return;
      handlers.onStep(e.payload);
    }),
    listen<{ run_id: string; delta: string }>("agent://think", (e) => {
      if (e.payload.run_id !== runId) return;
      // Reasoning is deliberately excluded from `full`, so it never ends up in
      // the stored answer or in the next request's history.
      handlers.onThink?.(e.payload.delta);
    }),
    listen<ConfirmRequest>("agent://confirm", (e) => {
      if (e.payload.run_id !== runId) return;
      handlers.onConfirm?.(e.payload);
    }),
  ]);

  try {
    await invoke("agent_run", { runId, request, turns });
    return full;
  } catch (e) {
    // Stop is not a failure: keep the partial answer and any steps shown.
    if (isStopError(e instanceof Error ? e.message : String(e))) return full;
    throw e;
  } finally {
    listeners.forEach((off) => off());
  }
}

/** Sends the user's Allow/Deny decision for a pending command back to Rust. */
export async function confirmCommand(runId: string, approve: boolean): Promise<void> {
  if (!inTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("agent_confirm", { runId, approve });
}

/** The folder the agent's tools operate in — always available, no UI needed. */
export async function defaultWorkspace(): Promise<string> {
  if (!inTauri) return "";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("current_agent_workspace");
  } catch {
    return "";
  }
}

/** Points the agent at a folder and remembers it for next launch. */
export async function setWorkspace(path: string): Promise<string> {
  if (!inTauri) return path;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<string>("set_agent_workspace", { path });
}

/* ---------- SSH Client mode ---------- */

interface SshServerRow {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: string;
  password: string;
  private_key: string;
}

function rowToServer(r: SshServerRow): SshServer {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port || 22,
    username: r.username || "root",
    auth: r.auth === "key" ? "key" : "password",
    password: r.password ?? "",
    private_key: r.private_key ?? "",
  };
}

/** All saved SSH units, newest first. */
export async function loadSshServers(): Promise<SshServer[]> {
  const db = await getDb();
  if (!db) return [...memory.sshServers];
  const rows = await db.select<SshServerRow[]>(
    "SELECT id, name, host, port, username, auth, password, private_key FROM ssh_servers ORDER BY created_at DESC",
  );
  return rows.map(rowToServer);
}

/** Inserts or replaces one unit (id is generated when missing). */
export async function saveSshServer(
  server: Omit<SshServer, "id"> & { id?: string },
): Promise<string> {
  const id = server.id || memId() + "-ssh";
  const db = await getDb();
  if (!db) {
    const next: SshServer = { ...server, id };
    memory.sshServers = [next, ...memory.sshServers.filter((s) => s.id !== id)];
    return id;
  }
  await db.execute(
    "INSERT INTO ssh_servers (id, name, host, port, username, auth, password, private_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET name=$2, host=$3, port=$4, username=$5, auth=$6, password=$7, private_key=$8",
    [id, server.name, server.host, server.port || 22, server.username || "root", server.auth, server.password ?? "", server.private_key ?? ""],
  );
  return id;
}

/** Deletes a unit (its logs stay — the audit trail outlives the server). */
export async function deleteSshServer(id: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    memory.sshServers = memory.sshServers.filter((s) => s.id !== id);
    return;
  }
  await db.execute("DELETE FROM ssh_servers WHERE id = $1", [id]);
}

interface SshLogRow {
  id: string;
  actor: string;
  server_id: string;
  server_name: string;
  host: string;
  action: string;
  ok: number;
  detail: string;
  created_at: number;
}

/** The audit trail, newest first, capped for the Logs page. */
export async function loadSshLogs(limit = 300): Promise<SshLog[]> {
  const db = await getDb();
  if (!db) return [...memory.sshLogs];
  const rows = await db.select<SshLogRow[]>(
    "SELECT id, actor, server_id, server_name, host, action, ok, detail, created_at FROM ssh_logs ORDER BY created_at DESC, id DESC LIMIT $1",
    [limit],
  );
  return rows.map((r) => ({ ...r, ok: !!r.ok }));
}

/* ---------- Live SSH connections (Rust owns the pool) ---------- */

async function sshInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!inTauri) throw new Error("SSH needs the desktop shell (npm run tauri:dev)");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Connects to a saved unit (idempotent — a live session is reused). */
export async function sshConnect(serverId: string): Promise<void> {
  await sshInvoke("ssh_connect", { serverId });
}

/** Disconnects a unit (unknown ids are a no-op). */
export async function sshDisconnect(serverId: string): Promise<void> {
  await sshInvoke("ssh_disconnect", { serverId });
}

/** Runs one command on a unit, auto-connecting when needed. */
export async function sshExec(serverId: string, command: string): Promise<string> {
  return sshInvoke<string>("ssh_exec", { serverId, command });
}

/** Server ids with a live connection right now. */
export async function sshConnected(): Promise<string[]> {
  if (!inTauri) return [];
  return sshInvoke<string[]>("ssh_connected", {});
}

/**
 * Subscribes to live SSH events: connection status changes (ssh://status,
 * the full connected-id list) and new audit rows (ssh://logged). Returns a
 * disposer.
 */
export async function onSshEvent(handlers: {
  onStatus?: (connectedIds: string[]) => void;
  onLogged?: () => void;
}): Promise<() => void> {
  if (!inTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const offs = await Promise.all([
    listen<string[]>("ssh://status", (e) => handlers.onStatus?.(e.payload)),
    listen("ssh://logged", () => handlers.onLogged?.()),
  ]);
  return () => offs.forEach((off) => off());
}
