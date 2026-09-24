/**
 * Shared domain types.
 *
 * Kept in its own module so both the UI (`App.tsx`) and the persistence layer
 * (`db.ts`) can import them without creating a circular dependency.
 */

export type Theme = "dark" | "light" | "slate" | "amoled" | "vibe";

export interface Conversation {
  id: string;
  title: string;
  /** Unix seconds of the last stored message; the sidebar renders "41s/2h/3d" from it. */
  updatedAt: number;
  pinned?: boolean;
}

/** Humanizes an age in seconds as 41sec / 5min / 2h / 3d / 1y (UI caps style). */
export function ageLabel(updatedAtUnix: number, nowUnix: number): string {
  if (!updatedAtUnix) return "";
  const s = Math.max(0, nowUnix - updatedAtUnix);
  if (s < 60) return `${s}sec`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 365) return `${d}d`;
  return `${Math.floor(d / 365)}y`;
}

/**
 * Per-project command permission:
 * `bypass` runs commands without asking, `ask` always prompts,
 * `default` inherits the global setting.
 */
export type PermMode = "bypass" | "default" | "ask";

export interface Project {
  name: string;
  path: string;
  conversations: Conversation[];
  /** Command permission mode; absent on older data means `default`. */
  permMode?: PermMode;
}

export type ViewKind = "chat" | "new" | "history" | "tasks";

export type ProviderKind =
  | "google"
  | "openai"
  | "openai-compatible"
  | "ollama"
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

export type ProviderStatus = "ready" | "disconnected" | "error" | "checking";

/** Reasoning effort requested from the model, where the provider supports it. */
export type Effort = "low" | "medium" | "high";

export const EFFORTS: Effort[] = ["low", "medium", "high"];

/** A file or image the user attached to a prompt. */
export interface Attachment {
  /** Stable id, used as the React key and for removal. */
  id: string;
  name: string;
  /** `image` renders as a preview, `text` is inlined into the prompt. */
  kind: "image" | "text";
  /** Media type, e.g. `image/png` or `text/plain`. */
  mime: string;
  /** Data URL for images, raw text for text files. */
  data: string;
  /** Size in bytes, for the chip label. */
  size: number;
}

/** A configured model provider (credentials + endpoint) — persisted in SQLite. */
export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string;
  api_key: string;
  enabled: boolean;
  status: ProviderStatus;
  last_sync: number | null;
  /** `key` = API key, `bearer` = OAuth access token obtained by signing in. */
  auth: "key" | "bearer";
}

/** Stored OAuth credentials for a provider (Google sign-in). */
export interface OAuthTokens {
  provider_id: string;
  access_token: string;
  refresh_token: string;
  /** Unix seconds. */
  expires_at: number;
  email: string;
  scope: string;
}

/** A single selectable model belonging to a provider. */
export interface Model {
  id: string;
  provider_id: string;
  model_id: string;
  name: string;
  meta: string;
  enabled: boolean;
}

/**
 * Humanizes a model id for display: `claude-fable-5` → `Claude Fable 5`.
 *
 * Dashes and slashes become spaces and each word is capitalized, but DOTS are
 * kept so version numbers stay intact: `gpt-4.1` → `Gpt 4.1`, never
 * `Gpt 4 1`. Ids that already look human (they contain a space) pass through
 * untouched, so a user's custom display name survives.
 */
export function prettyModelName(id: string): string {
  if (!id) return id;
  if (id.includes(" ")) return id;
  const words = id
    .replace(/[/:@]/g, " ")
    .split(/[-_]+/)
    .filter(Boolean);
  return words
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Provider plus its models, in the shape the picker needs. */
export interface Gateway {
  id: string;
  name: string;
  kind: ProviderKind;
  status: ProviderStatus;
  enabled: boolean;
  models: Array<{ id: string; name: string; meta: string }>;
}

export interface ModelOption {
  id: string;
  name: string;
  meta: string;
}

export interface StoredMessage {
  conversation_id: string;
  role: "user" | "agent";
  text: string;
  created_at: number;
  /** How long the model spent producing this turn (agent messages only). */
  duration_ms?: number;
  /** JSON array of `{name, mime, data_url}` image attachments. */
  images?: string;
}

/** An image stored with a message, ready to render again after a reload. */
export interface StoredImage {
  name: string;
  mime: string;
  data_url: string;
}

/** Pseudo-project holding chats that belong to no folder. */
export const NO_PROJECT = "No project";

/** How many conversations a project shows before "See all (N)". */
export const CONV_LIMIT = 6;

/* ---------- Provider catalogue ---------- */

export interface ProviderTemplate {
  kind: ProviderKind;
  label: string;
  /** Default API root, pre-filled when adding the provider. */
  base_url: string;
  hint: string;
  /** Whether the user must supply an API key. */
  needsKey: boolean;
  /** Local providers are reachable without credentials. */
  local?: boolean;
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    kind: "google",
    label: "Google Antigravity",
    base_url: "https://generativelanguage.googleapis.com",
    hint: "Gemini models. Sign in with your Google account or paste an AI Studio API key.",
    needsKey: false,
  },
  {
    kind: "openai-completions",
    label: "OpenAI Completions",
    base_url: "https://api.openai.com/v1",
    hint: "POST /chat/completions with stream — OpenAI, DeepSeek, OpenRouter, LM Studio, vLLM.",
    needsKey: true,
  },
  {
    kind: "openai-responses",
    label: "OpenAI Responses",
    base_url: "https://api.openai.com/v1",
    hint: "POST /responses with stream — the newer OpenAI protocol.",
    needsKey: true,
  },
  {
    kind: "anthropic-messages",
    label: "Anthropic Messages",
    base_url: "https://api.anthropic.com/v1",
    hint: "POST /messages with stream — Claude models.",
    needsKey: true,
  },
  {
    kind: "ollama",
    label: "Ollama (local)",
    base_url: "http://localhost:11434",
    hint: "Models served by a local Ollama instance. No API key required.",
    needsKey: false,
    local: true,
  },
];

/* ---------- OAuth client notes ---------- */

/**
 * Sign-in with a Google account only works with the user's own OAuth client.
 *
 * There is no usable built-in fallback: Google refuses third-party apps that
 * authenticate with its subscription clients (Gemini CLI / Antigravity) —
 * verified live against `cloudcode-pa`, which answers SUBSCRIPTION_REQUIRED /
 * UNSUPPORTED_CLIENT for them. The client ID therefore comes from the user's
 * Cloud Console, created as a "Desktop app" in a project where the Generative
 * Language API is enabled.
 */
