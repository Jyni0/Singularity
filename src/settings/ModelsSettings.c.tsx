/**
 * Settings → Models.
 *
 * Adding a provider is two choices: the provider (OpenAI, Anthropic, Google,
 * Ollama or API) and, for API, the endpoint format (OpenAI Responses, OpenAI
 * Completions, Anthropic Messages).
 *
 *  * **OpenAI / Anthropic / Google** — account sign-in through the vendor CLI
 *    (Codex, Claude Code, Antigravity CLI), downloaded and run headless by Rust.
 *  * **Ollama / API** — Rig's built-in providers with a base URL and key.
 *  * Legacy Google cards keep their OAuth / AI Studio key flow.
 *
 * Either way, "Refresh" pulls the provider's live model list into SQLite so the
 * picker in the prompt box updates immediately.
 */
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Plus,
  RefreshCw,
  Trash2,
  Check,
  X,
  AlertTriangle,
  Eye,
  EyeOff,
  LogOut,
  CircleCheck,
  ChevronDown,
  Download,
  LogIn,
  SlidersHorizontal,
} from "lucide-react";
import type { Model, OAuthTokens, Provider, ProviderKind } from "../core/types.i";
import { PROVIDER_TEMPLATES, isCliKind, compareModels } from "../core/types.i";
import * as db from "../core/db.r";
import { ModelCaps } from "./ModelCaps.c";
import { ModelCapsEditor } from "./ModelCapsEditor.c";
import { Switch, ScrollBox, Button, IconButton, Input, Spinner, Segmented, SettingRow, Sep, GoogleMark, ProviderLogo } from "../components";

/** "https://api.example.com/v1" → "api.example.com" (empty for CLIs). */
function hostOf(url: string): string {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return url;
  }
}

function StatusDot({ status }: { status: Provider["status"] }) {
  const color =
    status === "ready"
      ? "bg-[var(--diff-add)]"
      : status === "error"
        ? "bg-[var(--diff-del)]"
        : status === "checking"
          ? "animate-pulse bg-[var(--text-main)]"
          : "bg-[var(--text-dim)]";
  return <span className={`block h-2.5 w-2.5 shrink-0 rounded-full ${color}`} title={status} />;
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

/** The same for any other provider: say what a status code means, keep the details. */
function explainProviderError(raw: string): string {
  const text = raw.toLowerCase();
  if (/\b401\b/.test(text) || text.includes("unauthorized") || text.includes("invalid_api_key") || text.includes("invalid api key")) {
    return `The provider rejected the API key — check the key and that it belongs to this Base URL.\n${raw}`;
  }
  if (/\b403\b/.test(text) || text.includes("forbidden")) {
    return `The key has no access to the model list on this endpoint.\n${raw}`;
  }
  if (/\b404\b/.test(text)) {
    return `Nothing at this address — check the Base URL (it usually ends with /v1).\n${raw}`;
  }
  return raw;
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
          <Button onClick={() => pullModels(provider)} disabled={busy}>
            {busy ? <Spinner size={13} /> : <RefreshCw size={13} />}
            Sync models
          </Button>
          <IconButton tone="danger" label="Sign out" onClick={signOut}>
            <LogOut size={14} />
          </IconButton>
        </div>
      ) : (
        <>
          <div className="text-[12px] text-[var(--text-dim)]">
            Google offers two ways to reach Gemini from a third-party app. The API key
            is the reliable one — it is the public API and works on the free tier.
          </div>

          <div className="flex flex-col gap-2 rounded-xl bg-[var(--bg-input)] px-3 py-2.5 text-[12px] text-[var(--text-muted)]">
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
          <Button
            variant="ghost"
            size="xs"
            className="-ml-2.5 self-start"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            <ChevronDown
              size={12}
              className={`transition-transform ${showAdvanced ? "" : "-rotate-90"}`}
            />
            Sign in with Google instead (needs your own OAuth client)
          </Button>

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
                <Input className="font-mono"
                  value={clientId}
                  placeholder="123456-abc123.apps.googleusercontent.com"
                  onChange={(e) => setClientId(e.target.value)}
                  autoComplete="off"
                />
                <Input className="font-mono"
                  type="password"
                  value={clientSecret}
                  placeholder="GOCSPX-… (optional)"
                  onChange={(e) => setClientSecret(e.target.value)}
                  autoComplete="off"
                />
                <div className="flex justify-end">
                  <Button
                    onClick={signIn}
                    disabled={busy || !clientId.trim()}
                    title={
                      clientId.trim()
                      ? "Opens your browser to sign in"
                      : "Paste your own client ID first"
                    }
                  >
                    {busy ? (
                      <Spinner size={13} />
                    ) : (
                      <GoogleMark />
                    )}
                    {stage === "browser" ? "Waiting for browser…" : "Sign in with Google"}
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl px-2.5 py-2 text-[12px] text-[var(--diff-del)]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

/* ---------- Add-provider form ---------- */

/** Step 1: who the models come from. OpenAI / Anthropic / Google sign in */
/** through the vendor CLI; API is any endpoint in one of three formats. */
type AuthChoice = "openai" | "anthropic" | "google" | "ollama" | "api";

const AUTH_CHOICES: { id: AuthChoice; label: string; kind?: ProviderKind }[] = [
  { id: "openai", label: "OpenAI", kind: "openai-cli" },
  { id: "anthropic", label: "Anthropic", kind: "anthropic-cli" },
  { id: "google", label: "Google", kind: "google-cli" },
  { id: "ollama", label: "Ollama", kind: "ollama" },
  { id: "api", label: "API" },
];

/** Step 2 (API only): the wire format of the endpoint. */
const API_FORMATS: { kind: ProviderKind; label: string }[] = [
  { kind: "openai-responses", label: "OpenAI Responses" },
  { kind: "openai-completions", label: "OpenAI Completions" },
  { kind: "anthropic-messages", label: "Anthropic Messages" },
];

/** A provider setting: title + hint on the left, a fixed-width control on the right. */
function Row({ title, hint, children }: { title: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <SettingRow title={title} hint={hint}>
      <div className="w-[300px]">{children}</div>
    </SettingRow>
  );
}

/** Password-style field with a show / hide toggle (API keys). */
function SecretInput({
  value,
  onChange,
  onBlur,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        className="pr-9 font-mono"
        type={show ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        autoComplete="off"
      />
      <IconButton
        size="xs"
        className="absolute right-1.5 top-1/2 -translate-y-1/2"
        label={show ? "Hide key" : "Show key"}
        onClick={() => setShow(!show)}
      >
        {show ? <EyeOff size={13} /> : <Eye size={13} />}
      </IconButton>
    </div>
  );
}

function ChoiceRow<T extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onPick: (id: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] uppercase tracking-wide text-[var(--text-dim)]">{label}</label>
      <Segmented
        className="w-fit"
        options={options.map((o) => ({ value: o.id, label: o.label }))}
        value={value}
        onChange={onPick}
      />
    </div>
  );
}

function AddProvider({
  onCreate,
  onCancel,
}: {
  onCreate: (p: Provider) => Promise<void>;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<AuthChoice>("openai");
  const [apiKind, setApiKind] = useState<ProviderKind>("openai-responses");
  const kindOf = (c: AuthChoice, api: ProviderKind) =>
    AUTH_CHOICES.find((x) => x.id === c)?.kind ?? api;
  const templateOf = (kind: ProviderKind) => PROVIDER_TEMPLATES.find((x) => x.kind === kind)!;
  /** API formats are named by format, subscriptions by vendor. */
  const defaultName = (c: AuthChoice, kind: ProviderKind) =>
    c === "api" ? API_FORMATS.find((f) => f.kind === kind)!.label : templateOf(kind).label;

  const kind = kindOf(choice, apiKind);
  const template = templateOf(kind);
  const cli = isCliKind(kind);
  const [name, setName] = useState(defaultName("openai", "openai-cli"));
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  const pick = (c: AuthChoice, api: ProviderKind) => {
    const k = kindOf(c, api);
    setChoice(c);
    setApiKind(api);
    setName(defaultName(c, k));
    setBaseUrl(templateOf(k).base_url);
    setApiKey("");
  };

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    await onCreate({
      id: `p-${Date.now().toString(36)}`,
      name: name.trim(),
      kind,
      base_url: cli ? "" : baseUrl.trim(),
      api_key: cli ? "" : apiKey.trim(),
      enabled: true,
      status: "disconnected",
      last_sync: null,
      auth: "key",
      // Unlimited by default — the provider card exposes the knobs.
      rate_limit_rpm: 0,
      concurrency: 0,
    });
    // The CLI starts downloading right away, before the card is opened.
    if (cli) void db.cliInstall(kind).catch(() => {});
    setBusy(false);
  };

  return (
    <motion.div
      className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3.5"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-[var(--text-main)]">Add a provider</span>
        <IconButton label="Cancel" onClick={onCancel}>
          <X size={14} />
        </IconButton>
      </div>

      <ChoiceRow label="Provider" options={AUTH_CHOICES} value={choice} onPick={(c) => pick(c, apiKind)} />

      <AnimatePresence initial={false}>
        {choice === "api" && (
          <motion.div
            className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            <ChoiceRow
              label="Endpoint format"
              options={API_FORMATS.map((f) => ({ id: f.kind, label: f.label }))}
              value={apiKind}
              onPick={(k) => pick("api", k)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="text-[12px] text-[var(--text-dim)]">{template.hint}</div>

      <div className="flex flex-col gap-3 rounded-xl bg-[var(--bg-app)]/40 px-3 py-3">
        <Row title="Name" hint="How it shows in the model picker">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Row>
        {!cli && (
          <Row title={template.local ? "Endpoint" : "Base URL"} hint="Where requests go">
            <Input className="font-mono" value={baseUrl} placeholder="https://…" onChange={(e) => setBaseUrl(e.target.value)} />
          </Row>
        )}
        {template.needsKey && (
          <Row title="API key" hint="Stored locally, sent only to this provider">
            <SecretInput value={apiKey} onChange={setApiKey} placeholder="sk-…" />
          </Row>
        )}
      </div>

      {cli && (
        <div className="rounded-xl bg-[var(--bg-input)] px-3 py-2 text-[12px] text-[var(--text-muted)]">
          No API key. After adding, the CLI downloads in the background — open the card and press{" "}
          <b>Sign in</b> to connect your account.
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary"
          onClick={submit}
          disabled={busy || !name.trim() || (template.needsKey && !db.isLocalUrl(baseUrl) && !apiKey.trim())}
        >
          {busy ? <Spinner size={13} /> : <Plus size={13} />}
          Add provider
        </Button>
      </div>
    </motion.div>
  );
}

/* ---------- Subscription CLI block ---------- */

const CLI_NAME: Record<string, string> = {
  "openai-cli": "Codex CLI",
  "anthropic-cli": "Claude Code",
  "google-cli": "Antigravity CLI",
};

const CLI_ACCOUNT: Record<string, string> = {
  "openai-cli": "ChatGPT",
  "anthropic-cli": "Claude",
  "google-cli": "Google",
};

/**
 * Install + sign-in state of a CLI provider. The binary downloads in the
 * background as soon as the card mounts; "Sign in" runs the CLI's own browser
 * login hidden and resolves when the account is connected.
 */
function CliAuth({
  provider,
  hasModels,
  onSignedIn,
}: {
  provider: Provider;
  /** The provider already has models in the picker. */
  hasModels: boolean;
  /** Pulls the model list (after sign-in, or once the CLI is ready). */
  onSignedIn: () => void;
}) {
  const [status, setStatus] = useState<db.CliStatus | null>(null);
  const [progress, setProgress] = useState<db.CliProgress | null>(null);
  const [busy, setBusy] = useState<"login" | "logout" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tool = CLI_NAME[provider.kind];
  const account = CLI_ACCOUNT[provider.kind];
  /** Antigravity signs in only in its own interactive window (no hidden login). */
  const ownWindowLogin = provider.kind === "google-cli";

  const load = async (install: boolean) => {
    try {
      const st = await (install ? db.cliInstall(provider.kind) : db.cliStatus(provider.kind));
      setStatus(st);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load(true);
    let off = () => {};
    void db
      .onCliProgress((p) => {
        if (p.cli !== db.cliIdOf(provider.kind)) return;
        setProgress(p);
        if (p.stage === "error") setError(p.message);
        if (p.stage === "done") {
          setError(null);
          void load(false);
        }
      })
      .then((fn) => (off = fn));
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.kind]);

  // Models arrive by themselves: as soon as the CLI is installed (and, for
  // Antigravity, whose list depends on the account, signed in), once.
  const autoPulled = useRef(false);
  useEffect(() => {
    if (!status?.installed || hasModels || autoPulled.current) return;
    if (ownWindowLogin && status.signed_in !== true) return;
    autoPulled.current = true;
    onSignedIn();
  }, [status, hasModels, ownWindowLogin, onSignedIn]);

  const signIn = async () => {
    setBusy("login");
    setError(null);
    try {
      setStatus(await db.cliLogin(provider.kind));
      onSignedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };

  const signOut = async () => {
    setBusy("logout");
    try {
      setStatus(await db.cliLogout(provider.kind));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };

  const installing = !status?.installed && (status?.installing || (progress && progress.stage !== "error"));
  const signedIn = status?.signed_in === true;

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--border)] px-4 py-3">
      {!status ? (
        <div className="flex items-center gap-2 text-[12px] text-[var(--text-dim)]">
          <Spinner size={13} /> Checking {tool}…
        </div>
      ) : !status.installed ? (
        installing ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-[12px] text-[var(--text-muted)]">
              <span className="flex items-center gap-2">
                <Download size={13} className="text-[var(--accent)]" />
                {progress?.stage === "extract" ? `Unpacking ${tool}…` : `Downloading ${tool}…`}
              </span>
              <span className="font-mono text-[11px] text-[var(--text-dim)]">{progress && progress.stage !== "extract" ? `${progress.percent}%` : ""}</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-[var(--bg-input)]">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
                style={{ width: `${progress?.stage === "extract" ? 100 : (progress?.percent ?? 2)}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[12px] text-[var(--text-muted)]">
              {tool} is not installed yet.
            </span>
            <Button onClick={() => void load(true)}>
              <Download size={13} /> Download
            </Button>
          </div>
        )
      ) : signedIn ? (
        <div className="flex items-center gap-2">
          <CircleCheck size={14} className="shrink-0 text-[var(--accent)]" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-main)]">
            Signed in{status.account ? <> as <span className="font-mono">{status.account}</span></> : ` with ${account}`}
          </span>
          {busy === "logout" && ownWindowLogin && (
            <span className="shrink-0 text-[11px] text-[var(--text-dim)]">If an agy window opens, type /logout there</span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="hover:text-[var(--diff-del)]"
            icon={busy === "logout" ? <Spinner size={14} /> : <LogOut size={14} />}
            onClick={signOut}
            disabled={busy !== null}
            title="Sign out — then Sign in with another account"
          >
            Sign out
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[12px] text-[var(--text-muted)]">
            {busy === "login"
              ? ownWindowLogin
                ? `Sign in in the ${tool} window that opened, then close it…`
                : "Finish signing in in your browser…"
              : `Connect your ${account} account — requests then run on its subscription.`}
          </span>
          <Button variant="primary" onClick={signIn} disabled={busy !== null}>
            {busy === "login" ? <Spinner size={13} /> : <LogIn size={13} />}
            {busy === "login" ? "Waiting for sign-in…" : "Sign in"}
          </Button>
        </div>
      )}

      {status?.installed && (
        <div className="truncate font-mono text-[10.5px] text-[var(--text-dim)]" title={status.path}>
          {tool} · {status.source === "path" ? "your install" : "managed by Singularity"} · {status.path}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl px-2.5 py-2 text-[12px] text-[var(--diff-del)]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 whitespace-pre-wrap break-words">{error}</span>
        </div>
      )}
    </div>
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
  initiallyExpanded = false,
}: {
  provider: Provider;
  models: Model[];
  /** Open from the start — a card that was just added. */
  initiallyExpanded?: boolean;
  tokens: OAuthTokens | null;
  onChanged: (p: Provider) => void;
  onModelsChanged: (next: Model[]) => void;
  onTokens: (t: OAuthTokens | null) => void;
  onRemoved: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [key, setKey] = useState(provider.api_key);
  const [url, setUrl] = useState(provider.base_url);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  /** Short result of a Refresh, shown where the button was, then gone. */
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const showFlash = (f: { ok: boolean; text: string }) => {
    setFlash(f);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1600);
  };
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  /** Display name draft — saved on blur / Enter. */
  const [nameDraft, setNameDraft] = useState(provider.name);
  /** Manual model creation state. */
  const [showAddModel, setShowAddModel] = useState(false);
  const [newModelId, setNewModelId] = useState("");
  const [newModelName, setNewModelName] = useState("");
  /** Rate/concurrency drafts — string state so typing "0"→"60" feels natural;
   *  persisted (and pushed to the Rust limiter) on blur. */
  const [rpmDraft, setRpmDraft] = useState(String(provider.rate_limit_rpm ?? 0));
  const [concDraft, setConcDraft] = useState(String(provider.concurrency ?? 0));
  /** Max agents of this provider's runs (a model may set its own). */
  const [agentsDraft, setAgentsDraft] = useState("1");
  useEffect(() => {
    void db.loadProviderAgents(provider.id).then((n) => setAgentsDraft(String(n)));
  }, [provider.id]);
  const noLimits = (provider.rate_limit_rpm ?? 0) === 0 && (provider.concurrency ?? 0) === 0;
  /** "" / garbage → 0 (unlimited); anything else clamps to a sane ceiling. */
  const clampLimit = (v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.floor(n), 10000);
  };

  const template = PROVIDER_TEMPLATES.find((t) => t.kind === provider.kind);
  const mine = models
    .filter((m) => m.provider_id === provider.id)
    .sort((a, b) => compareModels(a.name || a.model_id, b.name || b.model_id));
  const isGoogle = provider.kind === "google";
  const isCli = isCliKind(provider.kind);
  /** API endpoints: each model's limits and abilities are set by hand. */
  const isApi = db.isApiKind(provider.kind);
  const [capsOpen, setCapsOpen] = useState<string | null>(null);

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
      const raw = result.error ?? "No models returned";
      setMessage({ kind: "err", text: isGoogle ? explainGoogleError(raw) : explainProviderError(raw) });
      showFlash({ ok: false, text: "Failed" });
    } else {
      await db.replaceModels(provider.id, result.models);
      // Swap this provider's models in the parent state so the list and the
      // picker update immediately — writing to the DB alone is not enough.
      onModelsChanged([
        ...models.filter((m) => m.provider_id !== provider.id),
        ...result.models,
      ]);
      await persist({ status: "ready", last_sync: Math.floor(Date.now() / 1000) });
      showFlash({ ok: true, text: `${result.models.length} models` });
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
    if (!next || next === provider.name) {
      setNameDraft(provider.name);
      return;
    }
    await persist({ name: next });
  };

  // Only offer Refresh once there is something to authenticate with.
  const canRefresh = isGoogle ? provider.auth === "bearer" || !!key.trim() : true;

  return (
    <div className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)]">
      {/* Header: the whole row opens the card; actions are same-size icon buttons. */}
      <div
        className={`group flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-[var(--hover-bg)] ${
          expanded ? "rounded-t-2xl" : "rounded-2xl"
        }`}
        onClick={() => setExpanded(!expanded)}
      >
        {/* Monogram tile with the connection status in its corner. */}
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--bg-input)] text-[14px] font-semibold text-[var(--text-main)]">
          {ProviderLogo({ kind: provider.kind, size: 18 }) ?? (provider.name.trim()[0] ?? "?").toUpperCase()}
          <span className="absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-[var(--bg-surface)]">
            <StatusDot status={provider.status} />
          </span>
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 truncate text-[13px] font-medium text-[var(--text-main)]">
            {provider.name}
            {isGoogle && provider.auth === "bearer" && tokens?.access_token && (
              <span className="rounded-md bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
                signed in
              </span>
            )}
          </span>
          <span className="truncate text-[11.5px] text-[var(--text-dim)]">
            {template?.label ?? provider.kind}
            {hostOf(provider.base_url) && ` · ${hostOf(provider.base_url)}`}
            {` · ${mine.length} model${mine.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {flash ? (
            <motion.span
              key={flash.text}
              className={`flex h-7 items-center gap-1 px-1.5 text-[12px] ${flash.ok ? "text-[var(--diff-add)]" : "text-[var(--diff-del)]"}`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.12 }}
            >
              {flash.ok ? <Check size={13} /> : <AlertTriangle size={13} />}
              {flash.text}
            </motion.span>
          ) : (
            <IconButton
              label={canRefresh ? "Refresh the model list" : "Connect this provider first"}
              onClick={refresh}
              disabled={busy || !canRefresh}
            >
              {busy ? <Spinner size={14} /> : <RefreshCw size={14} />}
            </IconButton>
          )}
          <IconButton tone="danger" label="Remove provider" onClick={remove}>
            <Trash2 size={14} />
          </IconButton>
          <IconButton label={expanded ? "Collapse" : "Expand"} onClick={() => setExpanded(!expanded)}>
            <ChevronDown size={15} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
          </IconButton>
        </div>
      </div>

      <AnimatePresence>
        {message && (
          <motion.div
            className="mx-4 mb-2 flex items-start gap-2 rounded-xl px-2.5 py-2 text-[12px] text-[var(--diff-del)]"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
          >
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span className="whitespace-pre-line break-words">{message.text}</span>
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

      {/* Subscription CLIs: download + account sign-in, then the model list. */}
      {isCli && expanded && (
        <CliAuth provider={provider} hasModels={mine.length > 0} onSignedIn={() => void refresh()} />
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
            <div className="flex flex-col gap-3 border-t border-[var(--border-soft)] px-4 py-3.5">
              {/* ---- Connection ---- */}
              <Row title="Name" hint="How it shows in the model picker">
                <Input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => void saveName()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                      setNameDraft(provider.name);
                      requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
                    }
                  }}
                />
              </Row>
              {!isCli && (
                <Row title="Base URL" hint="Where requests go">
                  <Input className="font-mono" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => persist({})} />
                </Row>
              )}
              {/* API key is an alternative to signing in for Google. */}
              {!isCli && (!isGoogle || provider.auth !== "bearer") && template?.needsKey !== false && (
                <Row title="API key" hint={isGoogle ? "Instead of signing in" : "Stored locally, sent only to this provider"}>
                  <SecretInput value={key} onChange={setKey} onBlur={() => persist({})} placeholder="not set" />
                </Row>
              )}

              {/* Subscriptions (CLIs) are automatic: always on, the vendor */}
              {/* meters them, and the model list comes from the CLI. */}
              {!isCli && (
                <>
                  <SettingRow title="Show in the model picker" hint="Off hides its models without deleting them">
                    <Switch on={provider.enabled} onChange={(next) => persist({ enabled: next })} ariaLabel="toggle provider" />
                  </SettingRow>

                  <SettingRow
                    title="Max agents"
                    hint="How many agents a run may use at once. 1 = the agent works alone (cheapest); above 1 it may hand parts of the work to helpers working side by side, each one a separate conversation with the model that costs as much again. A model can override it (its sliders)."
                  >
                    <Input
                      className="w-[110px]"
                      type="number"
                      min={1}
                      max={52}
                      value={agentsDraft}
                      onChange={(e) => setAgentsDraft(e.target.value)}
                      onBlur={() => {
                        const n = Math.min(52, Math.max(1, Math.floor(Number(agentsDraft)) || 1));
                        setAgentsDraft(String(n));
                        void db.saveProviderAgents(provider.id, n);
                      }}
                    />
                  </SettingRow>

                  <Sep />
                  {/* Rate limits — enforced in Rust (limiter.rs) before every */}
                  {/* provider call: chat streams, the agent loop and parallel */}
                  {/* decomposed subtasks all share this budget. */}
                  <SettingRow
                    title="Limit requests"
                    hint={noLimits ? "Unlimited — requests go out as fast as they come" : "Extra requests wait instead of failing"}
                  >
                    <Switch
                      on={!noLimits}
                      onChange={(limit) => {
                        setRpmDraft(limit ? String(rpmDraft === "0" ? 60 : rpmDraft) : "0");
                        setConcDraft(limit ? String(concDraft === "0" ? 3 : concDraft) : "0");
                        persist(limit ? { rate_limit_rpm: 60, concurrency: 3 } : { rate_limit_rpm: 0, concurrency: 0 });
                      }}
                      ariaLabel="toggle provider limits"
                    />
                  </SettingRow>
                  {!noLimits && (
                    <>
                      <SettingRow title="Requests per minute" hint="0 = no cap">
                        <Input
                          className="w-[110px]"
                          type="number"
                          min={0}
                          value={rpmDraft}
                          onChange={(e) => setRpmDraft(e.target.value)}
                          onBlur={() => persist({ rate_limit_rpm: clampLimit(rpmDraft) })}
                        />
                      </SettingRow>
                      <SettingRow title="Parallel requests" hint="Also caps how many subtasks run at once · 0 = no cap">
                        <Input
                          className="w-[110px]"
                          type="number"
                          min={0}
                          value={concDraft}
                          onChange={(e) => setConcDraft(e.target.value)}
                          onBlur={() => persist({ concurrency: clampLimit(concDraft) })}
                        />
                      </SettingRow>
                    </>
                  )}
                </>
              )}

              {/* ---- Models ---- */}
              <Sep />
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-[var(--text-main)]">Models</div>
                  <div className="mt-0.5 text-[12px] leading-snug text-[var(--text-dim)]">
                    {provider.last_sync
                      ? `${mine.length} · synced ${new Date(provider.last_sync * 1000).toLocaleString()}`
                      : isCli
                        ? "Load from the CLI once it is installed and signed in"
                        : "Press Refresh to fetch the list, or add models by hand"}
                  </div>
                </div>
                {/* Manual model creation — for gateways without a list endpoint. */}
                {!isCli && (
                  <Button size="sm" icon={<Plus size={13} className={`transition-transform ${showAddModel ? "rotate-45" : ""}`} />} onClick={() => setShowAddModel(!showAddModel)}>
                    {showAddModel ? "Cancel" : "Add model"}
                  </Button>
                )}
              </div>
              <AnimatePresence initial={false}>
                {showAddModel && (
                  <motion.div
                    className="flex items-center gap-2 overflow-hidden"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.15, ease: "easeOut" }}
                  >
                    <Input
                      size="sm"
                      className="flex-1 font-mono"
                      placeholder="model id — e.g. claude-sonnet-4-5"
                      value={newModelId}
                      onChange={(e) => setNewModelId(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && void addModelRow()}
                    />
                    <Input
                      size="sm"
                      className="flex-1"
                      placeholder="display name (optional)"
                      value={newModelName}
                      onChange={(e) => setNewModelName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && void addModelRow()}
                    />
                    <Button size="sm" variant="primary" onClick={addModelRow} disabled={!newModelId.trim()}>
                      Add
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>
              {mine.length > 0 && (
                <ScrollBox className="-mx-2 flex max-h-[320px] flex-col gap-0.5 px-0.5">
                  {mine.map((m) => (
                    <div key={m.id} className="flex flex-col">
                      <div className="group flex h-8 items-center gap-2 rounded-lg px-2 text-[12px] text-[var(--text-main)] hover:bg-[var(--hover-bg)]">
                        <span className="min-w-0 flex-1 truncate font-mono" title={m.model_id}>{m.name}</span>
                        <ModelCaps kind={provider.kind} baseUrl={provider.base_url} modelId={m.model_id} rowId={m.id} />
                        {/* API models: context, answer length and abilities by hand; every
                            non-CLI model: how many agents it may use. */}
                        {!isCli && (
                          <IconButton
                            size="xs"
                            reveal={capsOpen !== m.id}
                            className={capsOpen === m.id ? "text-[var(--accent)]" : ""}
                            label={isApi ? "Context, images, files, tools, agents…" : "Agents at once"}
                            onClick={() => setCapsOpen(capsOpen === m.id ? null : m.id)}
                          >
                            <SlidersHorizontal size={12} />
                          </IconButton>
                        )}
                        <IconButton size="xs" tone="danger" reveal label="Remove model" onClick={() => removeModelRow(m.id)}>
                          <Trash2 size={12} />
                        </IconButton>
                      </div>
                      {!isCli && capsOpen === m.id && (
                        <ModelCapsEditor kind={provider.kind} baseUrl={provider.base_url} modelId={m.model_id} rowId={m.id} providerId={provider.id} />
                      )}
                    </div>
                  ))}
                </ScrollBox>
              )}
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

  /** The card just added opens by itself (CLI providers download and sign in there). */
  const [justAdded, setJustAdded] = useState<string | null>(null);

  const create = async (p: Provider) => {
    await db.upsertProvider(p);
    onProvidersChanged([...providers.filter((x) => x.id !== p.id), p]);
    setAdding(false);
    setJustAdded(p.id);
    // API and Ollama: pull the model list right away. CLI providers pull it
    // from their card once the CLI is installed (and signed in).
    if (isCliKind(p.kind)) return;
    const result = await db.discoverModels(p, {
      clientId: localStorage.getItem("google_client_id") ?? "",
      clientSecret: localStorage.getItem("google_client_secret") ?? "",
    });
    const next: Provider = result.error || result.models.length === 0
      ? { ...p, status: "error" }
      : { ...p, status: "ready", last_sync: Math.floor(Date.now() / 1000) };
    if (next.status === "ready") {
      await db.replaceModels(p.id, result.models);
      onModelsChanged([...models.filter((m) => m.provider_id !== p.id), ...result.models]);
    }
    await db.upsertProvider(next);
    onProvidersChanged([...providers.filter((x) => x.id !== p.id), next]);
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
        <div className="flex items-start gap-2 rounded-2xl border border-[var(--border)] px-4 py-3 text-[12px] text-[var(--text-muted)]">
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
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus size={13} /> Add provider
          </Button>
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
          initiallyExpanded={p.id === justAdded}
        />
      ))}

      {providers.length === 0 && !adding && (
        <div className="rounded-2xl border border-dashed border-[var(--border)] px-4 py-8 text-center text-[13px] text-[var(--text-dim)]">
          No providers yet. Sign in with OpenAI, Anthropic or Google, run Ollama, or add an API endpoint.
        </div>
      )}
    </div>
  );
}
