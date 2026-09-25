import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Server,
  Plus,
  Terminal,
  Power,
  PowerOff,
  Pencil,
  Trash2,
  LoaderCircle,
  X,
  KeyRound,
} from "lucide-react";
import * as db from "../core/db.r";
import type { SshServer } from "../core/types.i";
import { Modal } from "../ui/Modal.c";

/**
 * Units — the SSH Client mode's home page: a grid of saved servers.
 *
 * Each card shows live status (a pooled connection in Rust), connects /
 * disconnects on demand and opens a small command console. Every action is
 * audit-logged on the Rust side and appears on the Logs page.
 */
export function UnitsView({
  servers,
  connected,
  busyIds,
  notice,
  addNonce,
  onChanged,
  onConnect,
  onDisconnect,
  selected,
  onSelect,
}: {
  servers: SshServer[];
  /** Server ids with a live pooled connection. */
  connected: string[];
  /** Server ids with an operation in flight (spinner). */
  busyIds: string[];
  /** Transient error banner (failed connect etc.); null hides it. */
  notice?: string | null;
  /** Bumped by the sidebar's add button to open the modal from outside. */
  addNonce?: number;
  onChanged: () => void;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
  /** Server whose console is open (the sidebar can set this too). */
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [editing, setEditing] = useState<SshServer | "new" | null>(null);

  // The sidebar's "+" raises the nonce; open the add-server modal for it.
  useEffect(() => {
    if (addNonce) setEditing("new");
  }, [addNonce]);

  const remove = async (s: SshServer) => {
    await db.deleteSshServer(s.id);
    if (selected === s.id) onSelect(null);
    onChanged();
  };

  return (
    <motion.div
      className="mx-auto flex w-full max-w-[980px] flex-col"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      <div className="flex items-center gap-2 text-[18px] font-semibold text-[var(--text-main)]">
        <Server size={18} strokeWidth={1.5} /> Units
        <button
          className="ml-auto flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 text-[12px] font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
          onClick={() => setEditing("new")}
        >
          <Plus size={13} strokeWidth={2} /> Add server
        </button>
      </div>
      <div className="mb-4 mt-1 text-[13px] text-[var(--text-muted)]">
        Saved SSH servers — connect, run commands, watch the audit trail on Logs.
      </div>

      {notice && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-[var(--diff-del)]/40 bg-[var(--diff-del)]/10 px-3 py-2 text-[12px] text-[var(--diff-del)]">
          <X size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={notice}>{notice}</span>
        </div>
      )}

      {servers.length === 0 && (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-[13px] text-[var(--text-muted)]">
          No servers yet — add your first unit.
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
        {servers.map((s) => {
          const live = connected.includes(s.id);
          const busy = busyIds.includes(s.id);
          const isSelected = selected === s.id;
          return (
            <div
              key={s.id}
              className={
                "group relative flex flex-col gap-2 rounded-xl border bg-[var(--bg-surface)] p-3.5 transition-colors " +
                (isSelected ? "border-[var(--accent)]/60" : "border-[var(--border)] hover:border-[var(--text-dim)]")
              }
            >
              <div className="flex items-center gap-2">
                <span
                  className={
                    "h-2 w-2 shrink-0 rounded-full " +
                    (live ? "bg-[var(--accent)] shadow-[0_0_6px_var(--accent)]" : "bg-[var(--text-dim)]")
                  }
                  title={live ? "Connected" : "Idle"}
                />
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[var(--text-main)]">
                  {s.name}
                </span>
                <button
                  className="rounded p-1 text-[var(--text-dim)] opacity-0 transition-all hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)] group-hover:opacity-100"
                  title="Edit"
                  onClick={() => setEditing(s)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="rounded p-1 text-[var(--text-dim)] opacity-0 transition-all hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)] group-hover:opacity-100"
                  title="Delete"
                  onClick={() => void remove(s)}
                >
                  <Trash2 size={13} />
                </button>
              </div>

              <div className="flex items-center gap-1.5 font-mono text-[12px] text-[var(--text-muted)]">
                {s.auth === "key" && <KeyRound size={12} className="shrink-0" />}
                <span className="min-w-0 truncate">
                  {s.username}@{s.host}
                  {s.port !== 22 ? ":" + s.port : ""}
                </span>
              </div>

              <div className="mt-1 flex items-center gap-2">
                {live ? (
                  <button
                    className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)]"
                    disabled={busy}
                    onClick={() => onDisconnect(s.id)}
                  >
                    {busy ? <LoaderCircle size={12} className="animate-spin" /> : <PowerOff size={12} />}
                    Disconnect
                  </button>
                ) : (
                  <button
                    className="flex h-7 items-center gap-1.5 rounded-md bg-[var(--accent)] px-2.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                    disabled={busy}
                    onClick={() => onConnect(s.id)}
                  >
                    {busy ? <LoaderCircle size={12} className="animate-spin" /> : <Power size={12} />}
                    Connect
                  </button>
                )}
                <button
                  className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                  onClick={() => onSelect(isSelected ? null : s.id)}
                >
                  <Terminal size={12} /> Console
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Console of the selected unit */}
      <AnimatePresence>
        {selected && servers.some((s) => s.id === selected) && (
          <motion.div
            className="mt-5"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
          >
            <SshConsole server={servers.find((s) => s.id === selected)!} onClose={() => onSelect(null)} />
          </motion.div>
        )}
      </AnimatePresence>

      {editing && (
        <ServerModal
          server={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </motion.div>
  );
}

/* ---------- Command console ---------- */

interface ConsoleEntry {
  id: number;
  kind: "in" | "out" | "err";
  text: string;
}

/**
 * A one-shot command console for a single unit. Not an interactive PTY —
 * each command is an independent SSH exec (auto-connecting when needed),
 * exactly like the agent's ssh_exec tool. Output appends like a terminal.
 */
function SshConsole({ server, onClose }: { server: SshServer; onClose: () => void }) {
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries]);

  const run = async () => {
    const cmd = input.trim();
    if (!cmd || running) return;
    setInput("");
    setRunning(true);
    const push = (kind: ConsoleEntry["kind"], text: string) =>
      setEntries((prev) => [...prev, { id: nextId.current++, kind, text }]);
    push("in", cmd);
    try {
      const out = await db.sshExec(server.id, cmd);
      push("out", out || "(no output)");
    } catch (e) {
      push("err", e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-surface)]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <Terminal size={13} className="text-[var(--accent)]" />
        <span className="truncate font-mono text-[12px] text-[var(--text-main)]">
          {server.username}@{server.host}
        </span>
        <span className="ml-auto text-[11px] text-[var(--text-dim)]">{server.name}</span>
        <button
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
          onClick={onClose}
          title="Close console"
        >
          <X size={12} />
        </button>
      </div>

      <div className="no-native-scrollbar max-h-[320px] min-h-[120px] overflow-y-auto bg-[var(--bg-input)] px-3 py-2 font-mono text-[12px] leading-[1.55]">
        {entries.length === 0 && (
          <div className="text-[var(--text-dim)]">Type a command and press Enter…</div>
        )}
        {entries.map((e) =>
          e.kind === "in" ? (
            <div key={e.id} className="whitespace-pre-wrap text-[var(--text-main)]">
              <span className="select-none text-[var(--accent)]">$ </span>
              {e.text}
            </div>
          ) : (
            <div
              key={e.id}
              className={
                "whitespace-pre-wrap " +
                (e.kind === "err" ? "text-[var(--diff-del)]" : "text-[var(--text-muted)]")
              }
            >
              {e.text}
            </div>
          ),
        )}
        {running && (
          <div className="flex items-center gap-1.5 py-0.5 text-[var(--text-dim)]">
            <LoaderCircle size={12} className="animate-spin" /> running…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] px-3 py-2">
        <span className="select-none font-mono text-[12px] text-[var(--accent)]">$</span>
        <input
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-[var(--text-main)] outline-none placeholder:text-[var(--text-dim)]"
          placeholder="uptime"
          value={input}
          autoFocus
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
        />
      </div>
    </div>
  );
}

/* ---------- Add / edit server modal ---------- */

function ServerModal({
  server,
  onClose,
  onSaved,
}: {
  server: SshServer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(server?.name ?? "");
  const [host, setHost] = useState(server?.host ?? "");
  const [port, setPort] = useState(String(server?.port ?? 22));
  const [username, setUsername] = useState(server?.username ?? "root");
  const [auth, setAuth] = useState<"password" | "key">(server?.auth ?? "password");
  const [password, setPassword] = useState(server?.password ?? "");
  const [key, setKey] = useState(server?.private_key ?? "");
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim() || !host.trim()) {
      setError("Name and host are required.");
      return;
    }
    if (auth === "password" && !password) {
      setError("Enter a password or switch to key authentication.");
      return;
    }
    if (auth === "key" && !key.trim()) {
      setError("Paste the private key or switch to password authentication.");
      return;
    }
    await db.saveSshServer({
      ...(server ? { id: server.id } : {}),
      name: name.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      username: username.trim() || "root",
      auth,
      password,
      private_key: key,
    });
    onSaved();
  };

  const field =
    "h-8 w-full rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2.5 text-[12px] text-[var(--text-main)] outline-none focus:border-[var(--accent)]";
  const label = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]";

  return (
    <Modal title={server ? "Edit server" : "Add server"} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={label}>Name</label>
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-web-1" autoFocus />
        </div>
        <div>
          <label className={label}>Username</label>
          <input className={field} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
        </div>
        <div>
          <label className={label}>Host</label>
          <input className={field} value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.5 or example.com" />
        </div>
        <div>
          <label className={label}>Port</label>
          <input className={field} value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" />
        </div>
      </div>

      <div>
        <label className={label}>Authentication</label>
        <div className="flex gap-1 rounded-md border border-[var(--border)] bg-[var(--bg-input)] p-0.5">
          {(["password", "key"] as const).map((a) => (
            <button
              key={a}
              className={
                "h-7 flex-1 rounded text-[12px] transition-colors " +
                (auth === a
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--text-muted)] hover:text-[var(--text-main)]")
              }
              onClick={() => setAuth(a)}
            >
              {a === "password" ? "Password" : "Private key"}
            </button>
          ))}
        </div>
      </div>

      {auth === "password" ? (
        <div>
          <label className={label}>Password</label>
          <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      ) : (
        <div>
          <label className={label}>Private key (PEM / OpenSSH)</label>
          <textarea
            className="h-28 w-full resize-none rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2.5 py-2 font-mono text-[11px] text-[var(--text-main)] outline-none focus:border-[var(--accent)]"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          />
        </div>
      )}

      {error && <div className="text-[12px] text-[var(--diff-del)]">{error}</div>}

      <div className="mt-1 flex justify-end gap-2">
        <button
          className="h-8 rounded-md border border-[var(--border)] px-3 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)]"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          className="h-8 rounded-md bg-[var(--accent)] px-4 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
          onClick={() => void save()}
        >
          {server ? "Save" : "Add"}
        </button>
      </div>
    </Modal>
  );
}
