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
  Project,
  Provider,
  ProviderKind,
  ProviderStatus,
  StoredMessage,
} from "./types";

export type { Model, OAuthTokens, Provider, StoredMessage };

/** Shape returned by the in-memory fallback, mirroring the SQL rows. */
interface MemoryStore {
  projects: Project[];
  providers: Provider[];
  models: Model[];
  messages: StoredMessage[];
  settings: Record<string, string>;
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/* ---------- In-memory fallback (browser dev) ---------- */

const memory: MemoryStore = {
  projects: [],
  providers: [],
  models: [],
  messages: [],
  settings: {},
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
}

interface ConvRow {
  id: string;
  project_id: string;
  title: string;
  age_label: string;
  pinned: number;
}

/** Loads the whole project tree with its conversations, ordered for the sidebar. */
export async function loadProjects(): Promise<Project[]> {
  const db = await getDb();
  if (!db) return memory.projects;

  const projects = await db.select<ProjectRow[]>(
    "SELECT id, name, path, sort_order FROM projects ORDER BY sort_order, name"
  );
  const convs = await db.select<ConvRow[]>(
    `SELECT id, project_id, title, age_label, pinned
       FROM conversations
      ORDER BY pinned DESC, created_at DESC`
  );

  return projects.map((p) => ({
    name: p.name,
    path: p.path,
    conversations: convs
      .filter((c) => c.project_id === p.name)
      .map<Conversation>((c) => ({
        id: c.id,
        title: c.title,
        age: c.age_label,
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
    "INSERT OR IGNORE INTO projects (id, name, path, sort_order) VALUES ($1, $2, $3, $4)",
    [project.name, project.name, project.path, sortOrder]
  );
}

export async function deleteProject(name: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    memory.projects = memory.projects.filter((p) => p.name !== name);
    return;
  }
  await db.execute("DELETE FROM projects WHERE name = $1", [name]);
}

/* ---------- Conversations ---------- */

export async function insertConversation(
  project: string,
  conv: Conversation
): Promise<void> {
  const db = await getDb();
  if (!db) {
    const p = memory.projects.find((x) => x.name === project);
    p?.conversations.unshift(conv);
    return;
  }
  await db.execute(
    `INSERT OR IGNORE INTO conversations (id, project_id, title, age_label, pinned)
     VALUES ($1, $2, $3, $4, $5)`,
    [conv.id, project, conv.title, conv.age, conv.pinned ? 1 : 0]
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
  return db.select<StoredMessage[]>(
    `SELECT conversation_id, role, text, created_at
       FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at, rowid`,
    [conversationId]
  );
}

export async function appendMessage(
  conversationId: string,
  role: "user" | "agent",
  text: string
): Promise<void> {
  const db = await getDb();
  const row: StoredMessage = {
    conversation_id: conversationId,
    role,
    text,
    created_at: Math.floor(Date.now() / 1000),
  };
  if (!db) {
    memory.messages.push(row);
    return;
  }
  await db.execute(
    `INSERT INTO messages (id, conversation_id, role, text)
     VALUES ($1, $2, $3, $4)`,
    [memId(), conversationId, role, text]
  );
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
  /** Images attached to the final user turn. */
  images?: ImageAttachment[];
}

export interface AgentStepEvent {
  name: string;
  input: string;
  result: string;
  ok: boolean;
  index: number;
  /** False while the tool runs; the UI then shows a spinner instead of "done". */
  done: boolean;
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
  ]);

  try {
    await invoke("agent_run", { runId, request, turns });
    return full;
  } finally {
    listeners.forEach((off) => off());
  }
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
