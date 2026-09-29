import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  X,
  Server,
  KeyRound,
  FileCode2,
  Save,
  Trash2,
  ShieldCheck,
  RotateCcw,
  Info,
  Copy,
  Eye,
  EyeOff,
  Waypoints,
} from "lucide-react";
import * as db from "../core/db.r";
import type { SshKey, SshProxy, SshScript, SshServer } from "../core/types.i";
import { useOverlayThumb } from "../hooks/useOverlayThumb.h";
import { ScrollArea, Combobox, Thumb, FIELD_LABEL, Input, Button, Alert, Segmented, Spinner, IconButton, cx, TEXTAREA } from "../components";

/**
 * SshPanel — the docked right-hand sidebar of SSH Client mode.
 *
 * Termius-style: creating, editing and configuring a unit is NOT a dialog.
 * A page-like column slides in from the right and stays there while you
 * work — forms are grouped into small-cap sections (Connection,
 * Authentication…) and saves surface errors inline. App SSH settings
 * (terminal theme/look) live in Settings → Terminal, not here.
 */
export type SshPanelTarget =
  | { kind: "server"; id?: string } // id undefined = create
  | { kind: "key"; id?: string }
  | { kind: "script"; id?: string }
  | { kind: "proxy"; id?: string };

const AREA = cx(TEXTAREA, "resize-none font-mono text-[11px] leading-[1.5]");

/**
 * PEM-key textarea with the app's OWN scrollbar: the native bar is hidden
 * globally (styles.css) and the overlay thumb is drawn on top — the same
 * look as every other scrollable surface (creds, scripts, the prompt box).
 */
function AreaField({
  className = AREA,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const thumb = useOverlayThumb(ref);
  return (
    <div className="relative">
      <textarea ref={ref} className={className} {...rest} />
      <Thumb thumb={thumb} />
    </div>
  );
}

/** Termius-style section divider: small-caps label over a hairline. */
function Section({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="h-full mt-5 first:mt-0">
      <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-dim)]">
        {title}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

export function SshPanel({
  target,
  servers,
  keys,
  scripts,
  proxies,
  width,
  resizing,
  onResizeStart,
  onChanged,
  onClose,
}: {
  target: SshPanelTarget;
  servers: SshServer[];
  keys: SshKey[];
  scripts: SshScript[];
  proxies: SshProxy[];
  /** Current panel width in px — dragged by the handle on its left edge. */
  width: number;
  /** True while dragging the edge: the width animation is switched off so the
   *  panel tracks the cursor 1:1 (open/close still animates). */
  resizing?: boolean;
  /** Starts a drag-resize (same mechanics as the chat inspection panel). */
  onResizeStart: (e: React.MouseEvent) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  // Escape closes the panel (dialogs are gone; the panel owns the shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const server = target.kind === "server" && target.id ? servers.find((s) => s.id === target.id) : undefined;
  const sshKey = target.kind === "key" && target.id ? keys.find((k) => k.id === target.id) : undefined;
  const script = target.kind === "script" && target.id ? scripts.find((s) => s.id === target.id) : undefined;
  const proxy = target.kind === "proxy" && target.id ? proxies.find((p) => p.id === target.id) : undefined;

  // Editing a row that vanished (deleted elsewhere) falls back to closing.
  useEffect(() => {
    if (target.kind === "server" && target.id && !server) onClose();
    if (target.kind === "key" && target.id && !sshKey) onClose();
    if (target.kind === "script" && target.id && !script) onClose();
    if (target.kind === "proxy" && target.id && !proxy) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, sshKey, script, proxy]);

  const editing = !!(server || sshKey || script || proxy);
  const noun = { server: "server", key: "credential", script: "script", proxy: "proxy" }[target.kind];
  const title = (editing ? "Edit " : "New ") + noun;

  const TitleIcon = { server: Server, key: KeyRound, script: FileCode2, proxy: Waypoints }[target.kind];

  // key=… forces a fresh form state when the panel switches rows.
  const formKey = target.kind + ":" + (target.id ?? "new");

  return (
    <motion.aside
      key="ssh-panel"
      className="selectable relative flex h-full shrink-0 flex-col overflow-hidden border-l border-[var(--border)] bg-[var(--bg-sidebar)]"
      /* Smooth adjust: the panel GROWS its width from 0 (and collapses back
         on close), so the main column compresses/expands gradually instead
         of jumping — the same feel as the chat page's content reflow. */
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={
        resizing
          ? { width: { duration: 0 }, opacity: { duration: 0.15 } }
          : { width: { duration: 0.24, ease: [0.32, 0.72, 0, 1] }, opacity: { duration: 0.15 } }
      }
    >
      {/* Drag handle on the left edge — resizes the panel (copied from the
          chat inspection panel: same class, same left-edge mechanics). */}
      <div className="panel-resizer" onMouseDown={onResizeStart} />
      {/* Panel header */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border)] px-4">
        <TitleIcon size={14} className="shrink-0 text-[var(--accent)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text-main)]">{title}</span>
        <IconButton
          label="Close panel" size="xs"
          onClick={onClose}
        >
          <X size={13} />
        </IconButton>
      </div>

      <ScrollArea className="min-h-0 flex-1" innerClassName="px-4 pt-4">
        {target.kind === "server" && (
          <ServerForm key={formKey} server={server} keys={keys} proxies={proxies} onChanged={onChanged} onClose={onClose} />
        )}
        {target.kind === "key" && (
          <KeyForm key={formKey} value={sshKey} onChanged={onChanged} onClose={onClose} />
        )}
        {target.kind === "script" && (
          <ScriptForm key={formKey} value={script} onChanged={onChanged} onClose={onClose} />
        )}
        {target.kind === "proxy" && (
          <ProxyForm key={formKey} value={proxy} onChanged={onChanged} onClose={onClose} />
        )}
      </ScrollArea>
    </motion.aside>
  );
}

/* ---------- Shared form bits ---------- */

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <Alert className="mt-3">{error}</Alert>
  );
}

function FormButtons({
  onSave,
  saveLabel,
  busy,
  onDelete,
  onClose,
}: {
  onSave: () => void;
  saveLabel: string;
  busy?: boolean;
  onDelete?: () => void;
  onClose: () => void;
}) {
  return (
    <div className="sticky bottom-0 -mx-4 mt-6 flex items-center gap-2 border-t border-[var(--border)] bg-[var(--bg-sidebar)] px-4 py-3">
      {onDelete && (
        <button
          className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)]"
          onClick={onDelete}
        >
          <Trash2 size={13} /> Delete
        </button>
      )}
      <span className="flex-1" />
      <Button
        variant="secondary"
        onClick={onClose}
      >
        Cancel
      </Button>
      <Button
        variant="primary"
        onClick={onSave}
        disabled={busy}
      >
        <Save size={13} /> {saveLabel}
      </Button>
    </div>
  );
}

/* ---------- Server form ---------- */

function ServerForm({
  server,
  keys,
  proxies,
  onChanged,
  onClose,
}: {
  server?: SshServer;
  keys: SshKey[];
  proxies: SshProxy[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(server?.name ?? "");
  const [host, setHost] = useState(server?.host ?? "");
  const [port, setPort] = useState(String(server?.port ?? 22));
  const [username, setUsername] = useState(server?.username ?? "root");
  // Termius-style dual auth: BOTH a password and a saved credential key may
  // be set at once — the connector tries the key first, then the password.
  // Inline key paste is gone: private bodies live only in Credentials.
  const [password, setPassword] = useState("");
  const [keyId, setKeyId] = useState(server?.key_id ?? "");
  const [proxyId, setProxyId] = useState(server?.proxy_id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasStoredPassword = !!server?.has_password;
  /** Password shown as plain text (typed, or the stored one fetched on demand). */
  const [showPassword, setShowPassword] = useState(false);
  /** The stored password was pulled into the field — saving re-stores it as is. */
  const [revealed, setRevealed] = useState(false);

  // A revealed password hides itself again after 30 s.
  useEffect(() => {
    if (!showPassword) return;
    const id = setTimeout(() => setShowPassword(false), 30_000);
    return () => clearTimeout(id);
  }, [showPassword]);

  const toggleShow = async () => {
    if (showPassword) return setShowPassword(false);
    // Blank field on a server with a stored password: fetch it (audit-logged).
    if (server && hasStoredPassword && !password && !revealed) {
      try {
        setPassword(await db.sshRevealPassword(server.id));
        setRevealed(true);
      } catch (e) {
        return setError(e instanceof Error ? e.message : String(e));
      }
    }
    setShowPassword(true);
  };

  const forgetHostKey = async () => {
    if (!server) return;
    if (!confirm("Forget the pinned host key? The next connect trusts whatever key the server presents — only do this after reinstalling the server.")) return;
    setBusy(true);
    try {
      // "-" is the wire signal to clear the pinned fingerprint.
      await db.saveSshServer({ ...server, password: "", host_key: "-" });
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setError(null);
    if (!name.trim()) return setError("Give the server a name.");
    if (!host.trim()) return setError("Host is required.");
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return setError("Port must be a number from 1 to 65535.");
    }
    if (!server && !password && !keyId) {
      return setError("Set a password and/or pick a saved key credential.");
    }
    setBusy(true);
    try {
      await db.saveSshServer({
        id: server?.id ?? "",
        name: name.trim(),
        host: host.trim(),
        port: portNum,
        username: username.trim() || "root",
        // "cred" when a key is linked (tried first on connect), else password.
        auth: keyId ? "cred" : "password",
        // Blank password means "keep stored" when editing — Rust never sends
        // plaintext back; "-" (clear button) removes it.
        password,
        private_key: "",
        key_id: keyId,
        host_key: server?.host_key ?? "",
        has_password: hasStoredPassword,
        os: server?.os ?? "",
        proxy_id: proxyId,
      });
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!confirm("Delete this server? Its audit rows stay in Logs.")) return;
    setBusy(true);
    try {
      if (server) await db.deleteSshServer(server.id);
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearPassword = async () => {
    if (!server) return;
    setBusy(true);
    try {
      // "-" is the wire signal to REMOVE the stored password (key-only host).
      await db.saveSshServer({ ...server, password: "-" });
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <Section title="Connection">
        <div>
          <label className={FIELD_LABEL}>Label</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-web-1" autoFocus />
        </div>
        <div>
          <label className={FIELD_LABEL}>Hostname or IP</label>
          <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.5 or example.com" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={FIELD_LABEL}>Port</label>
            <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" />
          </div>
          <div>
            <label className={FIELD_LABEL}>Username</label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
          </div>
        </div>
      </Section>

      <Section title="Authentication">
        <div>
          <label className={FIELD_LABEL}>
            Password
            {server ? " — blank keeps the stored one" : ""}
          </label>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Input
                className="pr-9"
                type={showPassword ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={hasStoredPassword ? "•••••••• (stored)" : "optional"}
              />
              {(password || hasStoredPassword) && (
                <IconButton
                  type="button"
                  label={showPassword ? "Hide password" : "Show password (hides again after 30 s; logged)"} size="xs" className="absolute right-1.5 top-1/2"
                  onClick={() => void toggleShow()}
                >
                  {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                </IconButton>
              )}
            </div>
            {hasStoredPassword && (
              <button
                type="button"
                className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] px-2 text-[11px] text-[var(--text-muted)] transition-colors hover:border-[var(--diff-del)]/50 hover:text-[var(--diff-del)]"
                onClick={() => void clearPassword()}
                title="Remove the stored password"
              >
                <RotateCcw size={11} /> Clear
              </button>
            )}
          </div>
        </div>
        <div>
          <label className={FIELD_LABEL}>Key credential — from the Credentials list only</label>
          {keys.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-[11.5px] text-[var(--text-muted)]">
              No credentials yet — add or generate one in Credentials (sidebar +) first.
            </div>
          ) : (
            /* Searchable dropdown — the credential list can grow long */
            <Combobox
              value={keyId}
              onChange={setKeyId}
              placeholder="No key — password only"
              emptyText="No credential matches"
              options={[
                { value: "", label: "No key — password only" },
                ...keys.map((k) => ({
                  value: k.id,
                  label: k.name,
                  hint: k.fingerprint ? k.fingerprint.slice(0, 20) : undefined,
                  mark: k.comment === "Generated By Singularity" ? "✦" : undefined,
                })),
              ]}
            />
          )}
        </div>
      </Section>

      <Section title="Proxy">
        <div>
          <label className={FIELD_LABEL}>Connect through — optional</label>
          {proxies.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-[11.5px] text-[var(--text-muted)]">
              No proxies yet — add one on the Units page (Proxies tab). Without one the server is reached directly.
            </div>
          ) : (
            <Combobox
              value={proxyId}
              onChange={setProxyId}
              placeholder="Direct connection"
              emptyText="No proxy matches"
              options={[
                { value: "", label: "Direct connection" },
                ...proxies.map((p) => ({
                  value: p.id,
                  label: p.name,
                  hint: `${p.kind === "socks5" ? "SOCKS5" : "HTTP"} ${p.host}:${p.port}`,
                })),
              ]}
            />
          )}
        </div>
      </Section>

      {server && (
        <Section title="Security">
          <div>
            <label className={FIELD_LABEL}>Host key (pinned on first connect)</label>
            <div className="flex items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate rounded-lg border border-[var(--border)] bg-[var(--bg-input)] px-2.5 py-2 font-mono text-[11px] text-[var(--text-muted)]"
                title={server.host_key || undefined}
              >
                {server.host_key ? (
                  <>
                    <ShieldCheck size={11} className="mr-1 inline text-[var(--diff-add,#4ec9b0)]" />
                    {server.host_key}
                  </>
                ) : (
                  "Not pinned yet — the first connect pins it"
                )}
              </span>
              {server.host_key && (
                <button
                  type="button"
                  className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] px-2 text-[11px] text-[var(--text-muted)] transition-colors hover:border-[var(--diff-del)]/50 hover:text-[var(--diff-del)]"
                  onClick={() => void forgetHostKey()}
                  title="Only after the server was reinstalled — a changed key can mean an attack"
                >
                  <RotateCcw size={11} /> Forget
                </button>
              )}
            </div>
          </div>
        </Section>
      )}

      <ErrorLine error={error} />
      <FormButtons
        onSave={() => void save()}
        saveLabel={server ? "Save" : "Create"}
        busy={busy}
        onDelete={server ? () => void del() : undefined}
        onClose={onClose}
      />
    </div>
  );
}

/* ---------- Key form ---------- */

/** Algorithms the generator offers — labels mirror ssh-keygen -t values. */
const KEY_ALGORITHMS: Array<{ id: string; label: string }> = [
  { id: "ed25519", label: "Ed25519 — modern default" },
  { id: "ecdsa-p256", label: "ECDSA P-256" },
  { id: "ecdsa-p384", label: "ECDSA P-384" },
  { id: "ecdsa-p521", label: "ECDSA P-521" },
  { id: "rsa", label: "RSA 4096 — max compatibility" },
];

function KeyForm({
  value,
  onChanged,
  onClose,
}: {
  value?: SshKey;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(value?.name ?? "");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Create mode: paste an existing body OR generate a fresh keypair. */
  const [mode, setMode] = useState<"paste" | "generate">("generate");
  const [algorithm, setAlgorithm] = useState("ed25519");
  /** Set right after generation: shows the public key to copy to servers. */
  const [generated, setGenerated] = useState<SshKey | null>(null);
  const [copied, setCopied] = useState(false);
  /**
   * Secrets are DECRYPTED ONLY WHEN THIS FORM OPENS: editing an existing
   * credential fetches the full row (private key + passphrase visible);
   * listings and every other screen never see plaintext.
   */
  const [publicKey, setPublicKey] = useState(value?.public_key ?? "");
  const [fingerprint, setFingerprint] = useState(value?.fingerprint ?? "");
  const [comment, setComment] = useState(value?.comment ?? "");
  const [loadingSecrets, setLoadingSecrets] = useState(!!value);
  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    (async () => {
      try {
        const full = await db.getSshKey(value.id);
        if (cancelled) return;
        setPrivateKey(full.private_key);
        setPassphrase(full.passphrase);
        setPublicKey(full.public_key ?? "");
        setFingerprint(full.fingerprint ?? "");
        setComment(full.comment ?? "");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingSecrets(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [value]);

  // Import mode: derive the public half live from the pasted body (debounced)
  // so the user sees Name / PrivateKey / PublicKey before saving.
  useEffect(() => {
    if (value || mode !== "paste") return;
    if (!privateKey.trim()) {
      setPublicKey("");
      setFingerprint("");
      return;
    }
    const t = setTimeout(() => {
      void db
        .deriveSshPublicKey(privateKey, passphrase)
        .then((d) => {
          setPublicKey(d.publicKey);
          setFingerprint(d.fingerprint);
        })
        .catch(() => {
          setPublicKey("");
          setFingerprint("");
        });
    }, 400);
    return () => clearTimeout(t);
  }, [privateKey, passphrase, mode, value]);

  const gen = async () => {
    setError(null);
    setBusy(true);
    try {
      const row = await db.generateSshKey(name.trim(), algorithm, passphrase);
      // Fetch the FULL row (secrets decrypted) so the generated screen can
      // show the private key too — the only moment it is ever displayed.
      const full = await db.getSshKey(row.id).catch(() => row);
      setGenerated(full);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setError(null);
    if (!name.trim()) return setError("Give the credential a name.");
    if (!privateKey.trim()) return setError("The private key body is empty.");
    setBusy(true);
    try {
      // The form holds the DECRYPTED body (loaded on open), so every save
      // ships the full key; Rust re-validates, re-encrypts and re-derives
      // the public half + fingerprint when the body/passphrase changed.
      await db.saveSshKey({
        id: value?.id ?? "",
        name: name.trim(),
        private_key: privateKey,
        passphrase,
        has_key: true,
        fingerprint,
        comment,
        public_key: publicKey,
      });
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyPublic = async (pub: string) => {
    try {
      await navigator.clipboard.writeText(pub);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the key is selectable in the box anyway */
    }
  };

  const del = async () => {
    if (!confirm("Delete this credential? Servers using it fall back to password auth.")) return;
    setBusy(true);
    try {
      if (value) await db.deleteSshKey(value.id);
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Right after generation: show the public half + copy button instead of
  // the form (the row is already saved; Done closes the panel).
  if (generated) {
    return (
      <div className="flex flex-col">
        <Section title="Generated">
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--accent)]">
            <ShieldCheck size={13} /> {generated.comment || "Generated By Singularity"}
          </div>
          <div>
            <label className={FIELD_LABEL}>Name</label>
            <div className="text-[12.5px] text-[var(--text-main)]">{generated.name}</div>
          </div>
          <div>
            <label className={FIELD_LABEL}>Fingerprint</label>
            <div className="break-all font-mono text-[10.5px] text-[var(--text-muted)]">{generated.fingerprint}</div>
          </div>
          {generated.private_key && (
            <div>
              <label className={FIELD_LABEL}>Private key — shown only here, this once</label>
              <AreaField
                className={AREA + " h-28"}
                readOnly
                value={generated.private_key}
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
          )}
          <div>
            <label className={FIELD_LABEL}>Public key — put it on the server (authorized_keys)</label>
            <AreaField
              className={AREA + " h-24"}
              readOnly
              value={generated.public_key}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="mt-2 flex h-7 items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
              onClick={() => void copyPublic(generated.public_key ?? "")}
            >
              <Copy size={11} /> {copied ? "Copied" : "Copy public key"}
            </button>
          </div>
        </Section>
        <div className="sticky bottom-0 mt-4 flex justify-end gap-2 border-t border-[var(--border)] bg-[var(--bg-sidebar)] px-1 pt-3">
          <Button
            type="button"
            variant="primary"
            onClick={onClose}
          >
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <Section title="Credential">
        <div>
          <label className={FIELD_LABEL}>Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="deploy key" autoFocus />
        </div>
        {!value && (
          <Segmented
            fill
            options={[
              { value: "generate", label: "Generate new" },
              { value: "paste", label: "Import existing" },
            ]}
            value={mode}
            onChange={setMode}
          />
        )}
        {!value && mode === "generate" && (
          <>
            <div>
              <label className={FIELD_LABEL}>Algorithm</label>
              <Combobox
                searchable={false}
                value={algorithm}
                onChange={setAlgorithm}
                options={KEY_ALGORITHMS.map((a) => ({ value: a.id, label: a.label }))}
              />
            </div>
            <div>
              <label className={FIELD_LABEL}>Passphrase — optional</label>
              <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="encrypts the generated key" />
            </div>
            <div className="flex items-start gap-1.5 text-[11px] leading-[1.5] text-[var(--text-dim)]">
              <Info size={12} className="mt-0.5 shrink-0" />
              The keypair is created on this machine and stored encrypted; its
              comment will read “Generated By Singularity”.
            </div>
          </>
        )}
        {(value || mode === "paste") && (
          <div>
            <label className={FIELD_LABEL}>Passphrase{value ? "" : " (if the key is encrypted)"}</label>
            <Input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              disabled={loadingSecrets}
              placeholder={loadingSecrets ? "••••••••" : ""}
            />
          </div>
        )}
        {(value || mode === "paste") && (
          <div>
            <label className={FIELD_LABEL}>Private key</label>
            {loadingSecrets ? (
              <div className="flex h-32 items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-input)] text-[11.5px] text-[var(--text-dim)]">
                <Spinner size={13} /> Decrypting…
              </div>
            ) : (
              <AreaField
                className={AREA + " h-32"}
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                spellCheck={false}
              />
            )}
          </div>
        )}
        {/* Public key — derived automatically, read-only (Name / PrivateKey /
            PublicKey structure): in import mode it appears live while typing,
            when editing it comes from the decrypted row. */}
        {(value || mode === "paste") && (
          <div>
            <label className={FIELD_LABEL}>Public key</label>
            {publicKey ? (
              <>
                <AreaField className={AREA + " h-16"} readOnly value={publicKey} onFocus={(e) => e.currentTarget.select()} />
                <div className="mt-1.5 flex items-center gap-2">
                  <button
                    type="button"
                    className="flex h-7 w-38 items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                    onClick={() => void copyPublic(publicKey)}
                  >
                    <Copy size={11} /> {copied ? "Copied" : "Copy public key"}
                  </button>
                  {fingerprint && (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ShieldCheck size={11} className="shrink-0 text-[var(--accent)]" />
                      <span className="truncate font-mono text-[10px] text-[var(--text-dim)]">{fingerprint}</span>
                    </span>
                  )}
                </div>
              </>
            ) : (
              <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-[11px] text-[var(--text-dim)]">
                {privateKey.trim()
                  ? "Cannot parse this private key yet — check the body and passphrase."
                  : "Appears here once a private key is pasted."}
              </div>
            )}
          </div>
        )}
      </Section>
      <ErrorLine error={error} />
      <FormButtons
        onSave={mode === "generate" && !value ? () => void gen() : () => void save()}
        saveLabel={!value && mode === "generate" ? "Generate" : value ? "Save" : "Create"}
        busy={busy}
        onDelete={value ? () => void del() : undefined}
        onClose={onClose}
      />
    </div>
  );
}

/* ---------- Script form ---------- */

function ScriptForm({
  value,
  onChanged,
  onClose,
}: {
  value?: SshScript;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(value?.name ?? "");
  const [description, setDescription] = useState(value?.description ?? "");
  const [content, setContent] = useState(value?.content ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    if (!name.trim()) return setError("Give the script a name.");
    if (!content.trim()) return setError("The command body is empty.");
    setBusy(true);
    try {
      await db.saveSshScript({
        id: value?.id ?? "",
        name: name.trim(),
        description: description.trim(),
        content,
      });
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!confirm("Delete this script?")) return;
    setBusy(true);
    try {
      if (value) await db.deleteSshScript(value.id);
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <Section title="Script">
        <div>
          <label className={FIELD_LABEL}>Label</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Disk usage" autoFocus />
        </div>
        <div>
          <label className={FIELD_LABEL}>Description</label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it does (optional)" />
        </div>
        <div>
          <label className={FIELD_LABEL}>Command</label>
          <AreaField
            className={AREA + " h-44 text-[12px]"}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={"df -h"}
            spellCheck={false}
          />
        </div>
      </Section>
      <ErrorLine error={error} />
      <FormButtons
        onSave={() => void save()}
        saveLabel={value ? "Save" : "Create"}
        busy={busy}
        onDelete={value ? () => void del() : undefined}
        onClose={onClose}
      />
    </div>
  );
}

/* ---------- Proxy form ---------- */

const DEFAULT_PROXY_PORT = { http: 8080, socks5: 1080 } as const;

function ProxyForm({
  value,
  onChanged,
  onClose,
}: {
  value?: SshProxy;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(value?.name ?? "");
  const [kind, setKind] = useState<SshProxy["kind"]>(value?.kind ?? "socks5");
  const [host, setHost] = useState(value?.host ?? "");
  const [port, setPort] = useState(String(value?.port ?? DEFAULT_PROXY_PORT.socks5));
  const [username, setUsername] = useState(value?.username ?? "");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stored = !!value?.has_password && !clearPassword;

  const pickKind = (k: SshProxy["kind"]) => {
    // Swap the port along with the type while it is still the other default.
    if (port === String(DEFAULT_PROXY_PORT[kind])) setPort(String(DEFAULT_PROXY_PORT[k]));
    setKind(k);
  };

  const save = async () => {
    setError(null);
    if (!name.trim()) return setError("Give the proxy a name.");
    if (!host.trim()) return setError("Host is required.");
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return setError("Port must be a number from 1 to 65535.");
    }
    setBusy(true);
    try {
      await db.saveSshProxy({
        id: value?.id ?? "",
        name: name.trim(),
        kind,
        host: host.trim(),
        port: portNum,
        username: username.trim(),
        // "" keeps the stored password, "-" removes it.
        password: password || (clearPassword ? "-" : ""),
        has_password: stored,
      });
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!confirm("Delete this proxy? Servers using it will connect directly.")) return;
    setBusy(true);
    try {
      if (value) await db.deleteSshProxy(value.id);
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <Section title="Proxy">
        <div>
          <label className={FIELD_LABEL}>Label</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="office socks" autoFocus />
        </div>
        <div>
          <label className={FIELD_LABEL}>Type</label>
          <Segmented
            fill
            options={[
              { value: "socks5", label: "SOCKS5" },
              { value: "http", label: "HTTP" },
            ]}
            value={kind}
            onChange={pickKind}
          />
        </div>
        <div className="grid grid-cols-[1fr_96px] gap-3">
          <div>
            <label className={FIELD_LABEL}>Host</label>
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="proxy.example.com" />
          </div>
          <div>
            <label className={FIELD_LABEL}>Port</label>
            <Input value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
        </div>
      </Section>

      <Section title="Authentication — optional">
        <div>
          <label className={FIELD_LABEL}>Username</label>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="none" autoComplete="off" />
        </div>
        <div>
          <label className={FIELD_LABEL}>Password{stored ? " — blank keeps the stored one" : ""}</label>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Input
                className="pr-9"
                type={showPassword ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={stored ? "•••••••• (stored)" : "none"}
              />
              {password && (
                <IconButton
                  type="button"
                  label={showPassword ? "Hide password" : "Show password"} size="xs" className="absolute right-1.5 top-1/2"
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                </IconButton>
              )}
            </div>
            {stored && (
              <button
                type="button"
                className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] px-2 text-[11px] text-[var(--text-muted)] transition-colors hover:border-[var(--diff-del)]/50 hover:text-[var(--diff-del)]"
                onClick={() => {
                  setClearPassword(true);
                  setPassword("");
                }}
                title="Remove the stored password on save"
              >
                <RotateCcw size={11} /> Clear
              </button>
            )}
          </div>
        </div>
      </Section>

      <ErrorLine error={error} />
      <FormButtons
        onSave={() => void save()}
        saveLabel={value ? "Save" : "Create"}
        busy={busy}
        onDelete={value ? () => void del() : undefined}
        onClose={onClose}
      />
    </div>
  );
}
