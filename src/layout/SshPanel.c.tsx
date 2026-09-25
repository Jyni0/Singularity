import { useEffect, useState } from "react";
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
} from "lucide-react";
import * as db from "../core/db.r";
import type { SshKey, SshScript, SshServer } from "../core/types.i";
import { ScrollArea } from "../ui/ScrollArea.c";

/**
 * SshPanel — the docked right-hand sidebar of SSH Client mode.
 *
 * Termius-style: creating, editing and configuring a unit is NOT a dialog.
 * A page-like column slides in from the right and stays there while you
 * work — forms are grouped into small-cap sections (Connection,
 * Authentication, Security…), saves surface errors inline, and the app's
 * SSH settings (terminal look, vault status) live here too.
 */
export type SshPanelTarget =
  | { kind: "server"; id?: string } // id undefined = create
  | { kind: "key"; id?: string }
  | { kind: "script"; id?: string };

const FIELD =
  "h-9 w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2.5 text-[12.5px] text-[var(--text-main)] outline-none transition-colors focus:border-[var(--accent)]";
const LABEL = "mb-1.5 block text-[11px] font-medium text-[var(--text-muted)]";
const AREA =
  "w-full resize-none rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2.5 py-2 font-mono text-[11px] leading-[1.5] text-[var(--text-main)] outline-none transition-colors focus:border-[var(--accent)]";

/** Termius-style section divider: small-caps label over a hairline. */
function Section({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mt-5 first:mt-0">
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
  width,
  onResizeStart,
  onChanged,
  onClose,
}: {
  target: SshPanelTarget;
  servers: SshServer[];
  keys: SshKey[];
  scripts: SshScript[];
  /** Current panel width in px — dragged by the handle on its left edge. */
  width: number;
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

  // Editing a row that vanished (deleted elsewhere) falls back to closing.
  useEffect(() => {
    if (target.kind === "server" && target.id && !server) onClose();
    if (target.kind === "key" && target.id && !sshKey) onClose();
    if (target.kind === "script" && target.id && !script) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, sshKey, script]);

  const title =
    target.kind === "server"
      ? server
        ? "Edit server"
        : "New server"
      : target.kind === "key"
        ? sshKey
          ? "Edit credential"
          : "New credential"
        : script
          ? "Edit script"
          : "New script";

  const TitleIcon =
    target.kind === "server" ? Server : target.kind === "key" ? KeyRound : FileCode2;

  // key=… forces a fresh form state when the panel switches rows.
  const formKey = target.kind + ":" + (target.id ?? "new");

  return (
    <motion.aside
      key="ssh-panel"
      className="selectable relative flex h-full shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg-sidebar)]"
      style={{ width }}
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      {/* Drag handle on the left edge — resizes the panel (copied from the
          chat inspection panel: same class, same left-edge mechanics). */}
      <div className="panel-resizer" onMouseDown={onResizeStart} />
      {/* Panel header */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border)] px-4">
        <TitleIcon size={14} className="shrink-0 text-[var(--accent)]" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text-main)]">{title}</span>
        <button
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
          onClick={onClose}
          title="Close panel"
        >
          <X size={13} />
        </button>
      </div>

      <ScrollArea className="min-h-0 flex-1" innerClassName="px-4 py-4">
        {target.kind === "server" && (
          <ServerForm key={formKey} server={server} keys={keys} onChanged={onChanged} onClose={onClose} />
        )}
        {target.kind === "key" && (
          <KeyForm key={formKey} value={sshKey} onChanged={onChanged} onClose={onClose} />
        )}
        {target.kind === "script" && (
          <ScriptForm key={formKey} value={script} onChanged={onChanged} onClose={onClose} />
        )}
      </ScrollArea>
    </motion.aside>
  );
}

/* ---------- Shared form bits ---------- */

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="mt-3 rounded-md border border-[var(--diff-del)]/40 bg-[var(--diff-del)]/10 px-3 py-2 text-[12px] leading-[1.5] text-[var(--diff-del)]">
      {error}
    </div>
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
          className="flex h-8 items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)]"
          onClick={onDelete}
        >
          <Trash2 size={13} /> Delete
        </button>
      )}
      <span className="flex-1" />
      <button
        className="h-8 rounded-md border border-[var(--border)] px-3 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
        onClick={onClose}
      >
        Cancel
      </button>
      <button
        className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent)] px-4 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={onSave}
        disabled={busy}
      >
        <Save size={13} /> {saveLabel}
      </button>
    </div>
  );
}

/* ---------- Server form ---------- */

function ServerForm({
  server,
  keys,
  onChanged,
  onClose,
}: {
  server?: SshServer;
  keys: SshKey[];
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasStoredPassword = !!server?.has_password;

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

  const unpin = async () => {
    if (!server) return;
    setBusy(true);
    try {
      // "-" is the wire signal: Rust rewrites host_key to empty and the next
      // connect pins whatever key the host presents.
      await db.saveSshServer({ ...server, host_key: "-" });
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
    <div className="flex flex-col">
      <Section title="Connection">
        <div>
          <label className={LABEL}>Label</label>
          <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-web-1" autoFocus />
        </div>
        <div>
          <label className={LABEL}>Hostname or IP</label>
          <input className={FIELD} value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.5 or example.com" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>Port</label>
            <input className={FIELD} value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" />
          </div>
          <div>
            <label className={LABEL}>Username</label>
            <input className={FIELD} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
          </div>
        </div>
      </Section>

      <Section title="Authentication">
        {/* Termius-style: BOTH methods may be set at once. The connector
            tries the key first, then falls back to the password. */}
        <div className="flex items-start gap-1.5 text-[11px] leading-[1.5] text-[var(--text-dim)]">
          <Info size={12} className="mt-0.5 shrink-0" />
          You can set a password AND a key credential — on connect the key is
          tried first, the password is the fallback. Either one alone works too.
        </div>
        <div>
          <label className={LABEL}>
            Password
            {server ? " — blank keeps the stored one" : ""}
          </label>
          <div className="flex gap-2">
            <input
              className={FIELD}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={hasStoredPassword ? "•••••••• (stored)" : "optional"}
            />
            {hasStoredPassword && (
              <button
                type="button"
                className="flex h-9 shrink-0 items-center gap-1 rounded-md border border-[var(--border)] px-2 text-[11px] text-[var(--text-muted)] transition-colors hover:border-[var(--diff-del)]/50 hover:text-[var(--diff-del)]"
                onClick={() => void clearPassword()}
                title="Remove the stored password"
              >
                <RotateCcw size={11} /> Clear
              </button>
            )}
          </div>
        </div>
        <div>
          <label className={LABEL}>Key credential — from the Credentials list only</label>
          {keys.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-[11.5px] text-[var(--text-muted)]">
              No credentials yet — add or generate one in Credentials (sidebar +) first.
            </div>
          ) : (
            <select className={FIELD} value={keyId} onChange={(e) => setKeyId(e.target.value)}>
              <option value="">No key — password only</option>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                  {k.comment === "Generated By Singularity" ? " ✦" : ""}
                  {k.fingerprint ? " · " + k.fingerprint.slice(0, 20) : ""}
                </option>
              ))}
            </select>
          )}
          {keys.some((k) => k.id === keyId && k.comment === "Generated By Singularity") && (
            <div className="mt-1 text-[10.5px] text-[var(--accent)]">✦ Generated By Singularity</div>
          )}
        </div>
      </Section>

      <Section title="Security">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-3">
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-main)]">
            <ShieldCheck size={13} className="text-[var(--accent)]" /> Host key
          </div>
          {server?.host_key ? (
            <>
              <div className="mt-1 break-all font-mono text-[10.5px] text-[var(--text-muted)]">{server.host_key}</div>
              <div className="mt-1 text-[11px] leading-[1.5] text-[var(--text-dim)]">
                Every connect verifies this fingerprint. Clear it only after a
                legitimate host reinstall.
              </div>
              <button
                className="mt-2 flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)]"
                onClick={() => void unpin()}
              >
                <RotateCcw size={11} /> Clear pinned key
              </button>
            </>
          ) : (
            <div className="mt-1 text-[11px] leading-[1.5] text-[var(--text-muted)]">
              Not pinned yet — the first successful connect remembers the host
              key and verifies it from then on.
            </div>
          )}
        </div>
        <div className="flex items-start gap-1.5 text-[11px] leading-[1.5] text-[var(--text-dim)]">
          <Info size={12} className="mt-0.5 shrink-0" />
          Secrets are stored AES-256-GCM encrypted; the master key lives in the OS
          credential store, not in the database.
        </div>
      </Section>

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

  const gen = async () => {
    setError(null);
    setBusy(true);
    try {
      const row = await db.generateSshKey(name.trim(), algorithm, passphrase);
      setGenerated(row);
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
    if (!value && !privateKey.trim()) return setError("Paste the private key body.");
    setBusy(true);
    try {
      await db.saveSshKey({
        id: value?.id ?? "",
        name: name.trim(),
        // Blank on edit = keep the stored body (Rust validates new ones).
        private_key: privateKey,
        passphrase,
        has_key: value?.has_key ?? !!privateKey.trim(),
        fingerprint: value?.fingerprint ?? "",
        comment: value?.comment ?? "",
        public_key: value?.public_key ?? "",
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
            <label className={LABEL}>Name</label>
            <div className="text-[12.5px] text-[var(--text-main)]">{generated.name}</div>
          </div>
          <div>
            <label className={LABEL}>Fingerprint</label>
            <div className="break-all font-mono text-[10.5px] text-[var(--text-muted)]">{generated.fingerprint}</div>
          </div>
          <div>
            <label className={LABEL}>Public key — put it on the server (authorized_keys)</label>
            <textarea
              className={AREA + " h-24"}
              readOnly
              value={generated.public_key}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="mt-2 flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
              onClick={() => void copyPublic(generated.public_key ?? "")}
            >
              <Copy size={11} /> {copied ? "Copied" : "Copy public key"}
            </button>
          </div>
        </Section>
        <div className="sticky bottom-0 mt-4 flex justify-end gap-2 border-t border-[var(--border)] bg-[var(--bg-sidebar)] px-1 pt-3">
          <button
            type="button"
            className="flex h-8 items-center rounded-md bg-[var(--accent)] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[var(--accent-hover)]"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <Section title="Credential">
        <div>
          <label className={LABEL}>Label</label>
          <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} placeholder="deploy key" autoFocus />
        </div>
        {!value && (
          <div className="flex gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-input)] p-0.5">
            <button
              type="button"
              className={
                "h-7 flex-1 rounded text-[11.5px] transition-colors " +
                (mode === "generate" ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:text-[var(--text-main)]")
              }
              onClick={() => setMode("generate")}
            >
              Generate new
            </button>
            <button
              type="button"
              className={
                "h-7 flex-1 rounded text-[11.5px] transition-colors " +
                (mode === "paste" ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:text-[var(--text-main)]")
              }
              onClick={() => setMode("paste")}
            >
              Import existing
            </button>
          </div>
        )}
        {!value && mode === "generate" && (
          <>
            <div>
              <label className={LABEL}>Algorithm</label>
              <select className={FIELD} value={algorithm} onChange={(e) => setAlgorithm(e.target.value)}>
                {KEY_ALGORITHMS.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL}>Passphrase — optional</label>
              <input className={FIELD} type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="encrypts the generated key" />
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
            <label className={LABEL}>Private key (PEM / OpenSSH){value ? " — blank keeps the stored one" : ""}</label>
            <textarea
              className={AREA + " h-32"}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              spellCheck={false}
            />
          </div>
        )}
        {(value || mode === "paste") && (
          <div>
            <label className={LABEL}>Passphrase{value ? " — blank keeps the stored one" : " (if the key is encrypted)"}</label>
            <input className={FIELD} type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={value ? "••••••••" : ""} />
          </div>
        )}
        {value?.comment === "Generated By Singularity" && (
          <div className="text-[11px] font-medium text-[var(--accent)]">✦ Generated By Singularity</div>
        )}
        {value?.fingerprint && (
          <div className="flex items-center gap-1.5 rounded-md bg-[var(--bg-input)] px-3 py-2">
            <ShieldCheck size={12} className="shrink-0 text-[var(--accent)]" />
            <span className="min-w-0 break-all font-mono text-[10.5px] text-[var(--text-muted)]">{value.fingerprint}</span>
          </div>
        )}
        {value?.public_key && (
          <div>
            <label className={LABEL}>Public key</label>
            <textarea className={AREA + " h-16"} readOnly value={value.public_key} onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              className="mt-2 flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 text-[11px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
              onClick={() => void copyPublic(value.public_key ?? "")}
            >
              <Copy size={11} /> {copied ? "Copied" : "Copy public key"}
            </button>
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
    <div className="flex flex-col">
      <Section title="Script">
        <div>
          <label className={LABEL}>Label</label>
          <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} placeholder="Disk usage" autoFocus />
        </div>
        <div>
          <label className={LABEL}>Description</label>
          <input className={FIELD} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it does (optional)" />
        </div>
        <div>
          <label className={LABEL}>Command</label>
          <textarea
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
