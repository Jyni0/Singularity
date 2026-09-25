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
  TerminalSquare,
  Info,
} from "lucide-react";
import * as db from "../core/db.r";
import type { SshKey, SshScript, SshServer } from "../core/types.i";
import { APP_VERSION } from "../core/types.i";
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
  | { kind: "script"; id?: string }
  | { kind: "settings" };

/** Terminal appearance/behaviour persisted as app settings. */
export interface SshTerminalSettings {
  fontSize: number;
  fontFamily: string;
  scrollback: number;
  cursorBlink: boolean;
  /** "xterm-256color" covers virtually every server. */
  term: string;
}

export const DEFAULT_SSH_TERMINAL: SshTerminalSettings = {
  fontSize: 13,
  fontFamily: "Cascadia Mono, Consolas, 'Courier New', monospace",
  scrollback: 5000,
  cursorBlink: true,
  term: "xterm-256color",
};

const FIELD =
  "h-9 w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2.5 text-[12.5px] text-[var(--text-main)] outline-none transition-colors focus:border-[var(--accent)]";
const LABEL = "mb-1.5 block text-[11px] font-medium text-[var(--text-muted)]";
const AREA =
  "w-full resize-none rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2.5 py-2 font-mono text-[11px] leading-[1.5] text-[var(--text-main)] outline-none transition-colors focus:border-[var(--accent)]";

/** Termius-style toggle switch for boolean settings. */
function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={
        "relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 " +
        (on ? "bg-[var(--accent)]" : "bg-[var(--hover-bg)]")
      }
    >
      <span
        className={
          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-150 " +
          (on ? "translate-x-[18px]" : "translate-x-0.5")
        }
      />
    </button>
  );
}

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
  connected,
  vaultBacked,
  width,
  onResizeStart,
  onChanged,
  onClose,
}: {
  target: SshPanelTarget;
  servers: SshServer[];
  keys: SshKey[];
  scripts: SshScript[];
  connected: string[];
  vaultBacked: boolean;
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
    target.kind === "settings"
      ? "Settings"
      : target.kind === "server"
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
    target.kind === "settings"
      ? TerminalSquare
      : target.kind === "server"
        ? Server
        : target.kind === "key"
          ? KeyRound
          : FileCode2;

  // key=… forces a fresh form state when the panel switches rows.
  const formKey = target.kind + ":" + (target.kind !== "settings" ? target.id ?? "new" : "app");

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
        {target.kind === "settings" && (
          <SettingsForm key={formKey} servers={servers} keys={keys} scripts={scripts} connected={connected} vaultBacked={vaultBacked} />
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
  const [auth, setAuth] = useState<SshServer["auth"]>(server?.auth ?? "password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [keyId, setKeyId] = useState(server?.key_id || keys[0]?.id || "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    if (!name.trim()) return setError("Give the server a name.");
    if (!host.trim()) return setError("Host is required.");
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return setError("Port must be a number from 1 to 65535.");
    }
    if (auth === "password" && !server && !password) return setError("Enter the password (or choose another method).");
    if (auth === "key" && !server && !privateKey.trim()) return setError("Paste the private key (or choose another method).");
    if (auth === "cred" && !keyId) return setError("Pick a saved credential — or add one under Credentials first.");
    setBusy(true);
    try {
      await db.saveSshServer({
        id: server?.id ?? "",
        name: name.trim(),
        host: host.trim(),
        port: portNum,
        username: username.trim() || "root",
        auth,
        // Blank secrets mean "keep stored" when editing — Rust never sends
        // plaintext back to the webview, so there is nothing to resend.
        password,
        private_key: privateKey,
        key_id: auth === "cred" ? keyId : "",
        host_key: server?.host_key ?? "",
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

  const seg = (id: SshServer["auth"], label: string) => (
    <button
      type="button"
      className={
        "h-7 flex-1 rounded text-[11.5px] transition-colors " +
        (auth === id ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:text-[var(--text-main)]")
      }
      onClick={() => setAuth(id)}
    >
      {label}
    </button>
  );

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
        <div className="flex gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-input)] p-0.5">
          {seg("password", "Password")}
          {seg("key", "Key")}
          {seg("cred", "Credential")}
        </div>
        {auth === "password" && (
          <div>
            <label className={LABEL}>Password{server ? " — blank keeps the stored one" : ""}</label>
            <input className={FIELD} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={server ? "••••••••" : ""} />
          </div>
        )}
        {auth === "key" && (
          <div>
            <label className={LABEL}>Private key (PEM / OpenSSH){server ? " — blank keeps the stored one" : ""}</label>
            <textarea
              className={AREA + " h-28"}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              spellCheck={false}
            />
          </div>
        )}
        {auth === "cred" && (
          <div>
            <label className={LABEL}>Saved credential</label>
            {keys.length === 0 ? (
              <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-[11.5px] text-[var(--text-muted)]">
                None saved — open Credentials (sidebar +) and add a private key first.
              </div>
            ) : (
              <select className={FIELD} value={keyId} onChange={(e) => setKeyId(e.target.value)}>
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                    {k.fingerprint ? " · " + k.fingerprint.slice(0, 20) : ""}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
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

  return (
    <div className="flex flex-col">
      <Section title="Credential">
        <div>
          <label className={LABEL}>Label</label>
          <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} placeholder="deploy key" autoFocus />
        </div>
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
        <div>
          <label className={LABEL}>Passphrase{value ? " — blank keeps the stored one" : " (if the key is encrypted)"}</label>
          <input className={FIELD} type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={value ? "••••••••" : ""} />
        </div>
        {value?.fingerprint && (
          <div className="flex items-center gap-1.5 rounded-md bg-[var(--bg-input)] px-3 py-2">
            <ShieldCheck size={12} className="shrink-0 text-[var(--accent)]" />
            <span className="min-w-0 break-all font-mono text-[10.5px] text-[var(--text-muted)]">{value.fingerprint}</span>
          </div>
        )}
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

/* ---------- App SSH settings (Terminal / Security / Units) ---------- */

const FONT_FAMILIES = [
  "Cascadia Mono, Consolas, 'Courier New', monospace",
  "Consolas, 'Courier New', monospace",
  "'JetBrains Mono', 'Fira Code', monospace",
  "'Courier New', monospace",
];

function SettingsForm({
  servers,
  keys,
  scripts,
  connected,
  vaultBacked,
}: {
  servers: SshServer[];
  keys: SshKey[];
  scripts: SshScript[];
  connected: string[];
  vaultBacked: boolean;
}) {
  const [term, setTerm] = useState<SshTerminalSettings>(DEFAULT_SSH_TERMINAL);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [fs, ff, sb, cb, t] = await Promise.all([
        db.getSetting("ssh_font_size"),
        db.getSetting("ssh_font_family"),
        db.getSetting("ssh_scrollback"),
        db.getSetting("ssh_cursor_blink"),
        db.getSetting("ssh_term"),
      ]);
      if (cancelled) return;
      setTerm((prev) => ({
        fontSize: fs ? Number(fs) || prev.fontSize : prev.fontSize,
        fontFamily: ff || prev.fontFamily,
        scrollback: sb ? Number(sb) || prev.scrollback : prev.scrollback,
        cursorBlink: cb === null ? prev.cursorBlink : cb === "1",
        term: t || prev.term,
      }));
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = (patch: Partial<SshTerminalSettings>) => {
    setTerm((prev) => {
      const next = { ...prev, ...patch };
      if (patch.fontSize !== undefined) void db.setSetting("ssh_font_size", String(next.fontSize));
      if (patch.fontFamily !== undefined) void db.setSetting("ssh_font_family", next.fontFamily);
      if (patch.scrollback !== undefined) void db.setSetting("ssh_scrollback", String(next.scrollback));
      if (patch.cursorBlink !== undefined) void db.setSetting("ssh_cursor_blink", next.cursorBlink ? "1" : "0");
      if (patch.term !== undefined) void db.setSetting("ssh_term", next.term);
      return next;
    });
  };

  const pinned = servers.filter((s) => s.host_key).length;
  const chip = "rounded-md bg-[var(--bg-input)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-main)]";

  return (
    <div className="flex flex-col pb-4">
      <Section title="Terminal">
        <div>
          <label className={LABEL}>Font size — {term.fontSize}px</label>
          <input
            type="range"
            min={10}
            max={22}
            value={term.fontSize}
            onChange={(e) => persist({ fontSize: Number(e.target.value) })}
            className="w-full accent-[var(--accent)]"
          />
        </div>
        <div>
          <label className={LABEL}>Font family</label>
          <select className={FIELD} value={term.fontFamily} onChange={(e) => persist({ fontFamily: e.target.value })}>
            {FONT_FAMILIES.map((f) => (
              <option key={f} value={f}>
                {f.split(",")[0].replace(/['"]/g, "")}
              </option>
            ))}
          </select>
        </div>
        {/* Termius-style setting row: label + hint left, control right */}
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[12.5px] text-[var(--text-main)]">Cursor blink</div>
            <div className="mt-0.5 text-[11px] text-[var(--text-dim)]">Animate the terminal cursor</div>
          </div>
          <Switch on={term.cursorBlink} onChange={(v) => persist({ cursorBlink: v })} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[12.5px] text-[var(--text-main)]">Scrollback</div>
            <div className="mt-0.5 text-[11px] text-[var(--text-dim)]">Lines kept in history</div>
          </div>
          <select
            className={FIELD + " w-40 shrink-0"}
            value={String(term.scrollback)}
            onChange={(e) => persist({ scrollback: Number(e.target.value) })}
          >
            {[1000, 5000, 10000, 50000].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()} lines
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={LABEL}>TERM</label>
          <input
            className={FIELD + " font-mono"}
            value={term.term}
            onChange={(e) => persist({ term: e.target.value })}
            spellCheck={false}
          />
        </div>
        {/* Live preview — renders with the saved settings once loaded. */}
        {loaded && (
          <div
            className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-input)] p-3"
            style={{ fontFamily: term.fontFamily, fontSize: term.fontSize + "px" }}
          >
            <div className="text-[var(--text-muted)]">{`root@${servers[0]?.host ?? "host"}:~# uptime`}</div>
            <div className="text-[var(--text-main)]"> 14:02:11 up 12 days,  3:41,  1 user,  load average: 0.08, 0.12, 0.09</div>
            <div className="text-[var(--text-muted)]">
              {`root@${servers[0]?.host ?? "host"}:~# `}
              <span className={term.cursorBlink ? "animate-pulse" : undefined}>▊</span>
            </div>
          </div>
        )}
      </Section>

      <Section title="Security">
        <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2">
          <span className="text-[12px] text-[var(--text-main)]">Credential vault</span>
          <span
            className={
              "flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium " +
              (vaultBacked
                ? "bg-[var(--diff-add,#4ec9b0)]/10 text-[var(--diff-add,#4ec9b0)]"
                : "bg-[var(--diff-del)]/10 text-[var(--diff-del)]")
            }
          >
            <ShieldCheck size={12} />
            {vaultBacked ? "Protected" : "Session-only"}
          </span>
        </div>
        <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2">
          <span className="text-[12px] text-[var(--text-main)]">Host keys pinned</span>
          <span className={chip}>{pinned}/{servers.length}</span>
        </div>
        <div className="text-[11px] leading-[1.6] text-[var(--text-dim)]">
          Secrets are AES-256-GCM ciphertext in SQLite; the master key lives in
          the OS credential store. First connect pins the host key; a changed
          key is refused as a possible MITM.
          {!vaultBacked && (
            <span className="text-[var(--diff-del)]">
              {" "}Neither keyring nor key-file is reachable right now — secrets
              decrypt only until restart.
            </span>
          )}
        </div>
      </Section>

      <Section title="Units">
        <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2">
          <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-main)]">
            <Server size={12} className="text-[var(--text-dim)]" /> Servers
          </span>
          <span className={chip}>{connected.length}/{servers.length} live</span>
        </div>
        <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2">
          <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-main)]">
            <KeyRound size={12} className="text-[var(--text-dim)]" /> Credentials
          </span>
          <span className={chip}>{keys.length}</span>
        </div>
        <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2">
          <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-main)]">
            <FileCode2 size={12} className="text-[var(--text-dim)]" /> Scripts
          </span>
          <span className={chip}>{scripts.length}</span>
        </div>
      </Section>

      <Section title="About">
        <div className="text-[11px] leading-[1.6] text-[var(--text-dim)]">
          SSH Client mode v{APP_VERSION} — connections, PTY terminals, SFTP and
          the credential vault run natively in Rust (russh + russh-sftp); the
          agent shares the same pool via the ssh_exec tool. Every action is
          written to the audit log (Logs page).
        </div>
      </Section>
    </div>
  );
}
