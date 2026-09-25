/**
 * Settings → Models.
 *
 * Two ways to connect a provider:
 *
 *  * **Sign in with Google** — OAuth 2.0 + PKCE. The browser opens Google's
 *    consent screen, the user picks an account, and a refresh token is stored
 *    locally so the connection survives restarts.
 *  * **API key** — paste a key (Google AI Studio, OpenAI, any compatible host).
 *
 * Either way, "Refresh" pulls the provider's live model list into SQLite so the
 * picker in the prompt box updates immediately.
 */
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Plus,
  RefreshCw,
  Trash2,
  Check,
  X,
  AlertTriangle,
  Loader2,
  Eye,
  EyeOff,
  Plug,
  KeyRound,
  LogOut,
  CircleCheck,
  ChevronDown,
  Pencil,
} from "lucide-react";
import type { Model, OAuthTokens, Provider, ProviderKind } from "../core/types.i";
import {
  PROVIDER_TEMPLATES,
} from "../core/types.i";
import * as db from "../core/db.r";
import { Switch } from "../ui/Switch.c";

const SBUTTON =
  "flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-md bg-[var(--bg-elevated)] px-3 text-[12px] text-[var(--text-main)] transition-colors hover:bg-[var(--bg-input)] disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON =
  "flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-[12px] text-white transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const SINPUT =
  "h-8 w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2.5 text-[12px] text-[var(--text-main)] outline-none focus:border-[var(--accent)]";

function StatusDot({ status }: { status: Provider["status"] }) {
  const color =
    status === "ready"
      ? "bg-[var(--accent)]"
      : status === "error"
        ? "bg-[var(--diff-del)]"
        : status === "checking"
          ? "animate-pulse bg-[var(--text-main)]"
          : "bg-[var(--text-dim)]";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} title={status} />;
}

/**
 * Turns raw Google error payloads into a sentence the user can act on.
 * The codes come from live testing against generativelanguage and cloudcode-pa.
 */
function explainGoogleError(raw: string): string {
  const text = raw.toLowerCase();
  if (text.includes("access_token_scope_insufficient")) {
    return "Signed in, but Google did not grant model access for this client. Use an API key, or sign in with your own OAuth client from a project where the Generative Language API is enabled.";
  }
  if (text.includes("subscription_required") || text.includes("unsupported_client")) {
    return "Google refuses subscription clients from third-party apps. Use an API key or your own OAuth client — a Google account subscription cannot be shared with other software.";
  }
  if (text.includes("401") || text.includes("invalid_client")) {
    return "Google does not recognize this OAuth client. Check the client ID (it must end with .apps.googleusercontent.com) and that the type is Desktop app.";
  }
  if (text.includes("invalid_scope")) {
    return "This OAuth client is not registered for the scopes we need. Create the client in a project with the Generative Language API enabled.";
  }
  if (text.includes("redirect_uri_mismatch")) {
    return "The OAuth client type must be Desktop app — Web clients reject the loopback redirect we use.";
  }
  return raw;
}

/** Small inline "Google" mark for the sign-in button. */
function GoogleMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45 24.5c0-1.6-.1-2.8-.4-4H24v8.5h11.9c-.2 2-1.5 5-4.5 6.9l-.1.1 6.6 5.1.5.1C42.5 37.1 45 31.3 45 24.5"
      />
      <path
        fill="#34A853"
        d="M24 46c5.9 0 10.9-1.9 14.4-5.3l-6.9-5.3c-1.9 1.3-4.4 2.2-7.5 2.2-5.9 0-10.9-3.9-12.7-9.3l-.1.1-6.8 5.3-.1.1C7.9 40.9 15.4 46 24 46"
      />
      <path
        fill="#FBBC05"
        d="M11.3 28.3c-.5-1.4-.8-2.8-.8-4.3s.3-3 .7-4.3v-.1L4.3 14.2l-.1.1C2.8 17.2 2 20.5 2 24s.8 6.8 2.2 9.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.1c4.2 0 7 1.8 8.6 3.3l6.3-6.1C35 3.9 30 2 24 2 15.4 2 7.9 7.1 4.2 14.3l7.1 5.4c1.8-5.4 6.8-9.6 12.7-9.6"
      />
    </svg>
  );
}

/* ---------- Google OAuth block ---------- */

function GoogleAuth({
  provider,
  tokens,
  onProviderChanged,
  onSignedIn,
  onSignedOut,
}: {
  provider: Provider;
  tokens: OAuthTokens | null;
  onProviderChanged: (p: Provider) => void;
  onSignedIn: (t: OAuthTokens) => void;
  onSignedOut: () => void;
}) {
  /** Empty means "use the built-in client" — the normal case. */
  const [clientId, setClientId] = useState(
    () => localStorage.getItem("google_client_id") ?? ""
  );
  const [clientSecret, setClientSecret] = useState(
    () => localStorage.getItem("google_client_secret") ?? ""
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<"idle" | "browser" | "exchanging">("idle");
  const [error, setError] = useState<string | null>(null);

  // Remember a custom client so it survives restarts.
  useEffect(() => {
    localStorage.setItem("google_client_id", clientId);
  }, [clientId]);
  useEffect(() => {
    localStorage.setItem("google_client_secret", clientSecret);
  }, [clientSecret]);

  const signedIn = !!tokens?.access_token;

  /**
   * Sign-in always uses the user's own client. Google refuses third-party apps
   * that authenticate with its subscription clients, so there is no usable
   * built-in fallback.
   */
  const effectiveId = clientId.trim();
  const effectiveSecret = clientSecret.trim();

  const signIn = async () => {
    setBusy(true);
    setError(null);
    setStage("browser");
    const res = await db.googleSignIn(provider.id, effectiveId, effectiveSecret);
    setStage("idle");
    setBusy(false);
    if (res.error || !res.tokens) {
      setError(res.error ?? "Sign-in failed");
      return;
    }
    onSignedIn(res.tokens);
    // Authenticate with the bearer token from now on, and pull the model list.
    const next: Provider = { ...provider, auth: "bearer", enabled: true };
    await db.upsertProvider(next);
    onProviderChanged(next);
    await pullModels({ ...next, auth: "bearer" });
  };

  const signOut = async () => {
    await db.clearTokens(provider.id);
    const next: Provider = { ...provider, auth: "key" as const, status: "disconnected" as const };
    await db.upsertProvider(next);
    onProviderChanged(next);
    onSignedOut();
  };

  /** Shared by sign-in and the Refresh button. */
  const pullModels = async (target: Provider) => {
    setBusy(true);
    setError(null);
    const result = await db.discoverModels(target, {
      clientId: effectiveId,
      clientSecret: effectiveSecret,
    });
    if (result.error || result.models.length === 0) {
      setError(explainGoogleError(result.error ?? "No models returned"));
      const failed: Provider = { ...target, status: "error" };
      await db.upsertProvider(failed);
      onProviderChanged(failed);
    } else {
      await db.replaceModels(target.id, result.models);
      const ok: Provider = { ...target, status: "ready" };
      await db.upsertProvider(ok);
      onProviderChanged(ok);
    }
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--border)] px-4 py-3">
      {signedIn ? (
        <div className="flex items-center gap-2">
          <CircleCheck size={14} className="shrink-0 text-[var(--accent)]" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-main)]">
            Connected as <span className="font-mono">{tokens?.email || "Google account"}</span>
          </span>
          <button className={SBUTTON} onClick={() => pullModels(provider)} disabled={busy}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Sync models
          </button>
          <button
            className="flex h-[30px] w-[30px] items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)]"
            onClick={signOut}
            title="Sign out"
          >
            <LogOut size={14} />
          </button>
        </div>
      ) : (
        <>
          <div className="text-[12px] text-[var(--text-dim)]">
            Google offers two ways to reach Gemini from a third-party app. The API key
            is the reliable one — it is the public API and works on the free tier.
          </div>

          <div className="flex flex-col gap-2 rounded-lg bg-[var(--bg-input)] px-3 py-2.5 text-[12px] text-[var(--text-muted)]">
            <div className="flex items-start gap-2">
              <span className="shrink-0 font-mono text-[var(--text-dim)]">1.</span>
              <span className="min-w-0 flex-1">
                Open{" "}
                <a
                  className="text-[var(--accent)] underline decoration-dotted hover:no-underline"
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noreferrer"
                >
                  Google AI Studio
                </a>{" "}
                and press <b>Create API key</b>. No Google Cloud project needed.
              </span>
            </div>
            <div className="flex items-start gap-2">
              <span className="shrink-0 font-mono text-[var(--text-dim)]">2.</span>
              <span className="min-w-0 flex-1">
                Paste it into the <b>API key</b> field on this card, then press{" "}
                <b>Refresh</b>.
              </span>
            </div>
          </div>

          {/* Sign-in stays available, but only with the user's own client. */}
          <button
            className="flex items-center gap-1.5 self-start text-[11px] text-[var(--text-dim)] transition-colors hover:text-[var(--text-main)]"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            <ChevronDown
              size={12}
              className={`transition-transform ${showAdvanced ? "" : "-rotate-90"}`}
            />
            Sign in with Google instead (needs your own OAuth client)
          </button>

          <AnimatePresence initial={false}>
            {showAdvanced && (
              <motion.div
                className="flex flex-col gap-2 overflow-hidden"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
              >
                <div className="text-[11px] text-[var(--text-dim)]">
                  Signing in with a Google account only works with <b>your own</b> OAuth
                  client — Google does not let third-party apps use its subscription
                  clients, and a shared client is rejected with{" "}
                  <span className="font-mono">SUBSCRIPTION_REQUIRED</span>. Create a
                  client of type <b>Desktop app</b> in{" "}
                  <a
                    className="text-[var(--accent)] underline decoration-dotted hover:no-underline"
                    href="https://console.cloud.google.com/auth/clients"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Cloud Console
                  </a>{" "}
                  and enable the Generative Language API in that project.
                </div>
                <input
                  className={`${SINPUT} font-mono`}
                  value={clientId}
                  placeholder="123456-abc123.apps.googleusercontent.com"
                  onChange={(e) => setClientId(e.target.value)}
                  autoComplete="off"
                />
                <input
                  className={`${SINPUT} font-mono`}
                  type="password"
                  value={clientSecret}
                  placeholder="GOCSPX-… (optional)"
                  onChange={(e) => setClientSecret(e.target.value)}
                  autoComplete="off"
                />
                <div className="flex justify-end">
                  <button
                    className={SBUTTON}
                    onClick={signIn}
                    disabled={busy || !clientId.trim()}
                    title={
                      clientId.trim()
                        ? "Opens your browser to sign in"
                        : "Paste your own client ID first"
                    }
                  >
                    {busy ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <GoogleMark />
                    )}
                    {stage === "browser" ? "Waiting for browser…" : "Sign in with Google"}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg px-2.5 py-2 text-[12px] text-[var(--diff-del)]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

/* ---------- Add-provider form ---------- */

function AddProvider({
  onCreate,
  onCancel,
}: {
  onCreate: (p: Provider) => Promise<void>;
  onCancel: () => void;
}) {
  const [template, setTemplate] = useState(PROVIDER_TEMPLATES[0]);
  const [name, setName] = useState(PROVIDER_TEMPLATES[0].label);
  const [baseUrl, setBaseUrl] = useState(PROVIDER_TEMPLATES[0].base_url);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);

  const pick = (kind: ProviderKind) => {
    const t = PROVIDER_TEMPLATES.find((x) => x.kind === kind)!;
    setTemplate(t);
    setName(t.label);
    setBaseUrl(t.base_url);
    setApiKey("");
  };

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    await onCreate({
      id: `p-${Date.now().toString(36)}`,
      name: name.trim(),
      kind: template.kind,
      base_url: baseUrl.trim(),
      api_key: apiKey.trim(),
      enabled: true,
      status: "disconnected",
      last_sync: null,
      auth: "key",
    });
    setBusy(false);
  };

  // Google is connected by signing in, not by pasting a key up front.
  const keyOptional = template.kind === "google";

  return (
    <motion.div
      className="flex flex-col gap-3 rounded-xl border border-[var(--accent)] bg-[var(--bg-surface)] px-4 py-3.5"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-[var(--text-main)]">Add a provider</span>
        <button
          className="rounded p-1 text-[var(--text-dim)] hover:text-[var(--text-main)]"
          onClick={onCancel}
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] uppercase tracking-wide text-[var(--text-dim)]">Type</label>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDER_TEMPLATES.map((t) => (
            <button
              key={t.kind}
              className={`flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors ${
                template.kind === t.kind
                  ? "border-[var(--accent)] bg-[var(--hover-bg)] text-[var(--text-main)]"
                  : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-main)]"
              }`}
              onClick={() => pick(t.kind)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="text-[12px] text-[var(--text-dim)]">{template.hint}</div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
          Display name
        </label>
        <input className={SINPUT} value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
          {template.local ? "Endpoint" : "Base URL"}
        </label>
        <input
          className={`${SINPUT} font-mono`}
          value={baseUrl}
          placeholder="https://…"
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>

      {template.needsKey && !keyOptional && (
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
            <KeyRound size={11} /> API key
          </label>
          <div className="relative">
            <input
              className={`${SINPUT} pr-9 font-mono`}
              type={showKey ? "text" : "password"}
              value={apiKey}
              placeholder="sk-…"
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
            <button
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--text-dim)] hover:text-[var(--text-main)]"
              onClick={() => setShowKey(!showKey)}
            >
              {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
        </div>
      )}

      {keyOptional && (
        <div className="rounded-lg bg-[var(--bg-input)] px-3 py-2 text-[12px] text-[var(--text-muted)]">
          After adding, open the card and press <b>Sign in with Google</b> — no API key required.
        </div>
      )}

      {template.kind !== "google" && template.needsKey && (
        <div className="text-[11px] text-[var(--text-dim)]">
          Stored locally in the app database and sent only to this provider.
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button className={SBUTTON} onClick={onCancel}>
          Cancel
        </button>
        <button
          className={PRIMARY_BUTTON}
          onClick={submit}
          disabled={busy || !name.trim() || (template.needsKey && !keyOptional && !apiKey.trim())}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
          Add provider
        </button>
      </div>
    </motion.div>
  );
}

/* ---------- Provider card ---------- */

function ProviderCard({
  provider,
  models,
  tokens,
  onChanged,
  onModelsChanged,
  onTokens,
  onRemoved,
}: {
  provider: Provider;
  models: Model[];
  tokens: OAuthTokens | null;
  onChanged: (p: Provider) => void;
  onModelsChanged: (next: Model[]) => void;
  onTokens: (t: OAuthTokens | null) => void;
  onRemoved: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [key, setKey] = useState(provider.api_key);
  const [showKey, setShowKey] = useState(false);
  const [url, setUrl] = useState(provider.base_url);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  /** Inline rename state. */
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(provider.name);
  /** Manual model creation state. */
  const [showAddModel, setShowAddModel] = useState(false);
  const [newModelId, setNewModelId] = useState("");
  const [newModelName, setNewModelName] = useState("");

  const template = PROVIDER_TEMPLATES.find((t) => t.kind === provider.kind);
  const mine = models.filter((m) => m.provider_id === provider.id);
  const isGoogle = provider.kind === "google";

  /** Adds a model row by hand and marks the provider usable. */
  const addModelRow = async () => {
    const modelId = newModelId.trim();
    if (!modelId) return;
    await db.addModel({
      id: `${provider.id}:${modelId}`,
      provider_id: provider.id,
      model_id: modelId,
      name: newModelName.trim() || modelId,
      meta: "manual",
      enabled: true,
    });
    // Reflect the new row in the parent state without a reload.
    onModelsChanged([
      ...models.filter((m) => m.id !== `${provider.id}:${modelId}`),
      {
        id: `${provider.id}:${modelId}`,
        provider_id: provider.id,
        model_id: modelId,
        name: newModelName.trim() || modelId,
        meta: "manual",
        enabled: true,
      },
    ]);
    if (!provider.enabled || provider.status !== "ready") {
      await persist({ enabled: true, status: "ready" });
    }
    setNewModelId("");
    setNewModelName("");
    setShowAddModel(false);
  };

  const removeModelRow = async (rowId: string) => {
    await db.removeModel(rowId);
    onModelsChanged(models.filter((m) => m.id !== rowId));
  };

  const persist = async (patch: Partial<Provider>) => {
    const next: Provider = { ...provider, api_key: key, base_url: url, ...patch };
    await db.upsertProvider(next);
    onChanged(next);
  };

  /** Pulls the provider's live model list and stores it. */
  const refresh = async () => {
    setBusy(true);
    setMessage(null);
    await persist({ status: "checking" });

    const result = await db.discoverModels(
      { ...provider, api_key: key, base_url: url },
      { clientId: localStorage.getItem("google_client_id") ?? "", clientSecret: localStorage.getItem("google_client_secret") ?? "" }
    );
    if (result.error || result.models.length === 0) {
      await persist({ status: "error" });
      setMessage({ kind: "err", text: explainGoogleError(result.error ?? "No models returned") });
    } else {
      await db.replaceModels(provider.id, result.models);
      // Swap this provider's models in the parent state so the list and the
      // picker update immediately — writing to the DB alone is not enough.
      onModelsChanged([
        ...models.filter((m) => m.provider_id !== provider.id),
        ...result.models,
      ]);
      await persist({ status: "ready", last_sync: Math.floor(Date.now() / 1000) });
      setMessage({ kind: "ok", text: `Found ${result.models.length} models` });
    }
    setBusy(false);
  };

  const remove = async () => {
    await db.clearTokens(provider.id);
    await db.removeProvider(provider.id);
    onRemoved(provider.id);
  };

  /** Saves the new display name; the id stays stable, so models survive. */
  const saveName = async () => {
    const next = nameDraft.trim();
    setRenaming(false);
    if (!next || next === provider.name) {
      setNameDraft(provider.name);
      return;
    }
    await persist({ name: next });
  };

  // Only offer Refresh once there is something to authenticate with.
  const canRefresh = isGoogle ? provider.auth === "bearer" || !!key.trim() : true;

  return (
    <div className="flex flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-surface)]">
      <div className="flex items-center gap-2.5 px-4 py-3">
        <StatusDot status={provider.status} />
        <button
          className="flex min-w-0 flex-1 flex-col items-start text-left"
          onClick={() => setExpanded(!expanded)}
        >
          {renaming ? (
            // Inline rename: Enter or blur saves, Escape cancels.
            <input
              autoFocus
              className="w-full max-w-[260px] rounded-md border border-[var(--accent)] bg-[var(--bg-input)] px-1.5 py-0.5 text-[13px] font-medium text-[var(--text-main)] outline-none"
              value={nameDraft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => void saveName()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName();
                if (e.key === "Escape") {
                  setNameDraft(provider.name);
                  setRenaming(false);
                }
              }}
            />
          ) : (
            <span className="flex items-center gap-1.5 truncate text-[13px] font-medium text-[var(--text-main)]">
              {provider.name}
              {isGoogle && provider.auth === "bearer" && tokens?.access_token && (
                <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
                  signed in
                </span>
              )}
            </span>
          )}
          <span className="truncate font-mono text-[11px] text-[var(--text-dim)]">
            {provider.kind}
            {provider.base_url ? ` · ${provider.base_url}` : ""}
          </span>
        </button>
        <span className="shrink-0 rounded-md bg-[var(--bg-elevated)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-dim)]">
          {mine.length} models
        </span>
        <button
          className={SBUTTON}
          onClick={refresh}
          disabled={busy || !canRefresh}
          title={canRefresh ? "Fetch the model list" : "Connect this provider first"}
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          Refresh
        </button>
        <button
          className="flex h-[30px] w-[30px] items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
          onClick={() => {
            setNameDraft(provider.name);
            setRenaming(true);
          }}
          title="Rename provider"
        >
          <Pencil size={14} />
        </button>
        <button
          className="flex h-[30px] w-[30px] items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)]"
          onClick={remove}
          title="Remove provider"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <AnimatePresence>
        {message && (
          <motion.div
            className={`mx-4 mb-2 flex items-start gap-2 rounded-lg px-2.5 py-2 text-[12px] ${
              message.kind === "ok"
                ? "bg-[var(--hover-bg)] text-[var(--text-main)]"
                : "text-[var(--diff-del)]"
            }`}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
          >
            {message.kind === "ok" ? <Check size={13} /> : <AlertTriangle size={13} />}
            <span>{message.text}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Google: the sign-in surface lives here, outside the collapse. */}
      {isGoogle && expanded && (
        <GoogleAuth
          provider={provider}
          tokens={tokens}
          onProviderChanged={onChanged}
          onSignedIn={onTokens}
          onSignedOut={() => onTokens(null)}
        />
      )}

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            <div className="flex flex-col gap-3 border-t border-[var(--border)] px-4 py-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
                  Base URL
                </label>
                <input
                  className={`${SINPUT} font-mono`}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onBlur={() => persist({})}
                />
              </div>

              {/* API key is an alternative to signing in for Google. */}
              {(!isGoogle || provider.auth !== "bearer") && template?.needsKey !== false && (
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
                    <KeyRound size={11} />
                    {isGoogle ? "API key (alternative to signing in)" : "API key"}
                  </label>
                  <div className="relative">
                    <input
                      className={`${SINPUT} pr-9 font-mono`}
                      type={showKey ? "text" : "password"}
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      onBlur={() => persist({})}
                      placeholder="not set"
                      autoComplete="off"
                    />
                    <button
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--text-dim)] hover:text-[var(--text-main)]"
                      onClick={() => setShowKey(!showKey)}
                    >
                      {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between rounded-lg bg-[var(--bg-input)] px-3 py-2">
                <span className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
                  <Plug size={13} />
                  Enabled for the model picker
                </span>
                <Switch
                  on={provider.enabled}
                  onChange={(next) => persist({ enabled: next })}
                  ariaLabel="toggle provider"
                />
              </div>

              {mine.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-[var(--text-dim)]">
                    Models
                  </span>
                  <div className="flex max-h-[320px] flex-col gap-0.5 overflow-y-auto pr-1">
                    {mine.map((m) => (
                      <div
                        key={m.id}
                        className="group flex items-center gap-2 rounded-md px-2 py-1 text-[12px] text-[var(--text-main)] hover:bg-[var(--hover-bg)]"
                      >
                        <span className="truncate font-mono">{m.name}</span>
                        <span className="ml-auto shrink-0 text-[11px] text-[var(--text-dim)]">
                          {m.meta}
                        </span>
                        <button
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-dim)] opacity-0 transition-opacity hover:text-[var(--diff-del)] group-hover:opacity-100"
                          onClick={() => removeModelRow(m.id)}
                          title="Remove model"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Manual model creation — for gateways without a list endpoint. */}
              <div className="flex flex-col gap-1.5">
                <button
                  className="flex items-center gap-1.5 self-start text-[11px] text-[var(--text-dim)] transition-colors hover:text-[var(--text-main)]"
                  onClick={() => setShowAddModel(!showAddModel)}
                >
                  <Plus
                    size={11}
                    className={`transition-transform ${showAddModel ? "rotate-45" : ""}`}
                  />
                  Add model manually
                </button>
                <AnimatePresence initial={false}>
                  {showAddModel && (
                    <motion.div
                      className="flex items-center gap-2 overflow-hidden"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15, ease: "easeOut" }}
                    >
                      <input
                        className={`${SINPUT} w-[38%] font-mono`}
                        placeholder="model id — e.g. claude-sonnet-4-5"
                        value={newModelId}
                        onChange={(e) => setNewModelId(e.target.value)}
                      />
                      <input
                        className={`${SINPUT} flex-1 font-mono`}
                        placeholder="display name (optional)"
                        value={newModelName}
                        onChange={(e) => setNewModelName(e.target.value)}
                      />
                      <button
                        className={SBUTTON}
                        onClick={addModelRow}
                        disabled={!newModelId.trim()}
                        title="Add this model to the picker"
                      >
                        <Plus size={13} />
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <div className="text-[11px] text-[var(--text-dim)]">
                {provider.last_sync
                  ? `Last synced ${new Date(provider.last_sync * 1000).toLocaleString()}`
                  : "Never synced — press Refresh to fetch the model list, or add models manually."}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- Page ---------- */

export function ModelsSettings({
  providers,
  models,
  persistent,
  onProvidersChanged,
  onModelsChanged,
}: {
  providers: Provider[];
  models: Model[];
  persistent: boolean;
  onProvidersChanged: (next: Provider[]) => void;
  onModelsChanged: (next: Model[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  /** OAuth tokens keyed by provider id, refreshed whenever one changes. */
  const [tokens, setTokens] = useState<Record<string, OAuthTokens | null>>({});

  // Load stored tokens so signed-in providers show their account straight away.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        providers.map(async (p) => [p.id, await db.loadTokens(p.id)] as const)
      );
      if (!cancelled) setTokens(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [providers]);

  const create = async (p: Provider) => {
    await db.upsertProvider(p);
    onProvidersChanged([...providers, p]);
    setAdding(false);
  };

  const update = (p: Provider) =>
    onProvidersChanged(providers.map((x) => (x.id === p.id ? p : x)));

  const remove = (id: string) => {
    onProvidersChanged(providers.filter((x) => x.id !== id));
    onModelsChanged(models.filter((m) => m.provider_id !== id));
  };

  return (
    <div className="flex flex-col gap-3">
      {!persistent && (
        <div className="flex items-start gap-2 rounded-xl border border-[var(--border)] px-4 py-3 text-[12px] text-[var(--text-muted)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            Running outside the desktop shell, so changes live in memory only. Launch with{" "}
            <code className="font-mono">npm run tauri:dev</code> to persist them and to call models.
          </span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-[12px] text-[var(--text-dim)]">
          {providers.length} provider{providers.length === 1 ? "" : "s"} · {models.length} model
          {models.length === 1 ? "" : "s"}
        </div>
        {!adding && (
          <button className={PRIMARY_BUTTON} onClick={() => setAdding(true)}>
            <Plus size={13} /> Add provider
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {adding && <AddProvider onCreate={create} onCancel={() => setAdding(false)} />}
      </AnimatePresence>

      {providers.map((p) => (
        <ProviderCard
          key={p.id}
          provider={p}
          models={models}
          tokens={tokens[p.id] ?? null}
          onChanged={update}
          onModelsChanged={onModelsChanged}
          onTokens={(t) => setTokens((prev) => ({ ...prev, [p.id]: t }))}
          onRemoved={remove}
        />
      ))}

      {providers.length === 0 && !adding && (
        <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-8 text-center text-[13px] text-[var(--text-dim)]">
          No providers yet. Connect Google, add an OpenAI/Anthropic gateway, or run Ollama.
        </div>
      )}
    </div>
  );
}