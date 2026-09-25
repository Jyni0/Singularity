import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Server,
  KeyRound,
  FileCode2,
  Plus,
  TerminalSquare,
  Power,
  PowerOff,
  Pencil,
  Trash2,
  LoaderCircle,
  X,
  Play,
  FolderOpen,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import * as db from "../core/db.r";
import type { SshKey, SshScript, SshServer, UnitsTab } from "../core/types.i";
import { Modal } from "../ui/Modal.c";

/**
 * Units — the SSH Client mode's home page: one grid, three collections.
 *
 * A segmented switcher (Servers / Credentials / Scripts) swaps the cards;
 * all three share one visual language: colored avatar + name + address +
 * actions. A server row opens the terminal page; edit/create and settings
 * live in the docked right-hand panel (SshPanel) — no dialogs.
 */
export function UnitsView({
  servers,
  keys,
  scripts,
  connected,
  busyIds,
  notice,
  vaultBacked,
  tab,
  onTab,
  onChanged,
  onEditUnit,
  onAddUnit,
  onConnect,
  onDisconnect,
  onOpenTerminal,
  onOpenFiles,
}: {
  servers: SshServer[];
  keys: SshKey[];
  scripts: SshScript[];
  connected: string[];
  busyIds: string[];
  notice?: string | null;
  /** True when the vault master key is safely persisted. */
  vaultBacked: boolean;
  tab: UnitsTab;
  onTab: (t: UnitsTab) => void;
  /** Reload the collections after a delete (saves happen inside SshPanel). */
  onChanged: () => void;
  /** Open the right-hand panel to edit a unit. */
  onEditUnit: (target: { kind: "server" | "key" | "script"; id: string }) => void;
  /** Open the right-hand panel to create a unit of the given kind. */
  onAddUnit: (kind: "server" | "key" | "script") => void;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
  onOpenTerminal: (serverId: string) => void;
  onOpenFiles: (serverId: string) => void;
}) {
  /** Script run in flight per script id. */
  const [runningScript, setRunningScript] = useState<string | null>(null);
  const [scriptResult, setScriptResult] = useState<{ name: string; ok: boolean; text: string } | null>(null);

  const runScript = async (serverId: string, s: SshScript) => {
    setRunningScript(s.id);
    setScriptResult(null);
    try {
      const out = await db.runSshScript(serverId, s.id);
      setScriptResult({ name: s.name, ok: true, text: out });
    } catch (e) {
      setScriptResult({ name: s.name, ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunningScript(null);
    }
  };

  const TABS: { id: UnitsTab; label: string; icon: typeof Server; count: number }[] = [
    { id: "servers", label: "Servers", icon: Server, count: servers.length },
    { id: "keys", label: "Credentials", icon: KeyRound, count: keys.length },
    { id: "scripts", label: "Scripts", icon: FileCode2, count: scripts.length },
  ];

  return (
    <motion.div
      className="mx-auto flex w-full max-w-[980px] flex-col"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      {/* No navbar: the switcher IS the header; Add sits on its right. */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-fit gap-1 rounded-lg border border-[var(--border)] bg-[var(--bg-input)] p-1">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              className={
                "relative flex h-6.5 items-center gap-1.5 rounded-md px-3 text-[12.5px] transition-colors " +
                (tab === t.id ? "text-[var(--text-main)]" : "text-[var(--text-muted)] hover:text-[var(--text-main)]")
              }
              onClick={() => onTab(t.id)}
            >
              {tab === t.id && (
                <motion.span
                  layoutId="units-tab-pill"
                  className="absolute inset-0 rounded-md bg-[var(--bg-surface)] shadow-sm"
                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                />
              )}
              <Icon size={13} strokeWidth={1.8} className="relative z-10" />
              <span className="relative z-10">{t.label}</span>
              <span className="relative z-10 text-[10px] text-[var(--text-dim)]">{t.count}</span>
            </button>
          );
        })}
        </div>
        <button
          className="flex h-9 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 text-[12px] font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
          onClick={() =>
            onAddUnit(tab === "servers" ? "server" : tab === "keys" ? "key" : "script")
          }
        >
          <Plus size={13} strokeWidth={2} />
          {tab === "servers" ? "Add server" : tab === "keys" ? "Add credential" : "Add script"}
        </button>
      </div>

      {notice && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--diff-del)]/40 bg-[var(--diff-del)]/10 px-3 py-2 text-[12px] text-[var(--diff-del)]">
          <X size={13} className="shrink-0" />
          <span className="min-w-0 flex-1" title={notice}>{notice}</span>
        </div>
      )}
      {tab === "keys" && !vaultBacked && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--diff-del)]/40 bg-[var(--diff-del)]/10 px-3 py-2 text-[12px] text-[var(--diff-del)]">
          <ShieldAlert size={13} className="shrink-0" />
          <span>
            The vault master key could not be persisted — stored secrets will
            only decrypt during this session. Fix OS keyring access to keep them.
          </span>
        </div>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          className="mt-4"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.12 }}
        >
          {tab === "servers" && (
            <ServerGrid
              servers={servers}
              connected={connected}
              busyIds={busyIds}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              onOpenTerminal={onOpenTerminal}
              onOpenFiles={onOpenFiles}
              onEdit={(s) => onEditUnit({ kind: "server", id: s.id })}
              onDelete={async (s) => {
                await db.deleteSshServer(s.id);
                onChanged();
              }}
            />
          )}

          {tab === "keys" && (
            <KeyGrid
              keys={keys}
              onEdit={(k) => onEditUnit({ kind: "key", id: k.id })}
              onDelete={async (k) => {
                await db.deleteSshKey(k.id);
                onChanged();
              }}
            />
          )}

          {tab === "scripts" && (
            <ScriptGrid
              scripts={scripts}
              servers={servers}
              runningScript={runningScript}
              onEdit={(s) => onEditUnit({ kind: "script", id: s.id })}
              onRun={runScript}
              onDelete={async (s) => {
                await db.deleteSshScript(s.id);
                onChanged();
              }}
            />
          )}
        </motion.div>
      </AnimatePresence>

      {/* Script run result (output viewer — not an edit dialog) */}
      {scriptResult && (
        <Modal title={scriptResult.ok ? scriptResult.name : scriptResult.name + " — failed"} onClose={() => setScriptResult(null)}>
          <pre
            className={
              "max-h-[45vh] overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--bg-input)] p-3 font-mono text-[12px] leading-[1.5] " +
              (scriptResult.ok ? "text-[var(--text-main)]" : "text-[var(--diff-del)]")
            }
          >
            {scriptResult.text}
          </pre>
        </Modal>
      )}
    </motion.div>
  );
}

/* ---------- Termius-style host rows ---------- */
/**
 * Visual language of Termius: a vertical list of rows instead of card
 * grids. Every unit gets a deterministic colored circular avatar (initial
 * letter, hue from the name hash), the name on top, the address/subtitle
 * under it in mono, and status + actions on the right edge. Servers,
 * credentials and scripts all share this row anatomy.
 */

const AVATAR_COLORS = [
  "#e06c75",
  "#e5c07b",
  "#98c379",
  "#56b6c2",
  "#61afef",
  "#c678dd",
  "#d19a66",
  "#be5046",
];

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function Avatar({ label, color, icon }: { label: string; color: string; icon?: typeof Server }) {
  const Icon = icon;
  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[14px] font-semibold text-white"
      style={{ backgroundColor: color }}
    >
      {Icon ? <Icon size={16} strokeWidth={1.8} /> : label.slice(0, 1).toUpperCase()}
    </span>
  );
}

const LIST = "flex flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-surface)]";
const LIST_ROW = "group flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-[var(--hover-bg)]";
const ROW_DIV = "h-px bg-[var(--border-soft)]";

function Empty({ icon: Icon, text }: { icon: typeof Server; text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] p-10 text-center text-[13px] text-[var(--text-muted)]">
      <Icon size={22} strokeWidth={1.4} className="mx-auto mb-2 text-[var(--text-dim)]" />
      {text}
    </div>
  );
}

function ServerGrid({
  servers,
  connected,
  busyIds,
  onConnect,
  onDisconnect,
  onOpenTerminal,
  onOpenFiles,
  onEdit,
  onDelete,
}: {
  servers: SshServer[];
  connected: string[];
  busyIds: string[];
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
  onOpenTerminal: (id: string) => void;
  onOpenFiles: (id: string) => void;
  onEdit: (s: SshServer) => void;
  onDelete: (s: SshServer) => void;
}) {
  if (servers.length === 0) return <Empty icon={Server} text="No servers yet — add your first unit." />;
  return (
    <div className={LIST}>
      {servers.map((s, i) => {
        const live = connected.includes(s.id);
        const busy = busyIds.includes(s.id);
        return (
          <div key={s.id}>
            {i > 0 && <div className={ROW_DIV} />}
            <div
              className={LIST_ROW + " cursor-pointer"}
              onClick={() => (live ? onOpenTerminal(s.id) : onConnect(s.id))}
              title={live ? "Open terminal" : "Connect"}
            >
              <span className="relative">
                <Avatar label={s.name} color={avatarColor(s.id)} icon={Server} />
                {/* Live dot on the avatar, Termius-style */}
                <span
                  className={
                    "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[var(--bg-surface)] " +
                    (live ? "bg-[var(--diff-add,#4ec9b0)]" : "bg-[var(--text-dim)]")
                  }
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-[var(--text-main)]">{s.name}</span>
                <span className="block truncate font-mono text-[11.5px] text-[var(--text-dim)]">
                  {s.username}@{s.host}{s.port !== 22 ? ":" + s.port : ""}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                {s.host_key && (
                  <span title={"Host key pinned: " + s.host_key}>
                    <ShieldCheck size={13} className="text-[var(--diff-add,#4ec9b0)]" />
                  </span>
                )}
                {live ? (
                  <>
                    <button
                      className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                      title="Files (SFTP)"
                      onClick={() => onOpenFiles(s.id)}
                    >
                      <FolderOpen size={13} />
                    </button>
                    <button
                      className="flex h-7 items-center gap-1.5 rounded-full bg-[var(--accent)] px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                      onClick={() => onOpenTerminal(s.id)}
                    >
                      <TerminalSquare size={12} /> Console
                    </button>
                    <button
                      className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)]"
                      disabled={busy}
                      onClick={() => onDisconnect(s.id)}
                      title="Disconnect"
                    >
                      {busy ? <LoaderCircle size={13} className="animate-spin" /> : <PowerOff size={13} />}
                    </button>
                  </>
                ) : (
                  <button
                    className="flex h-7 items-center gap-1.5 rounded-full border border-[var(--border)] px-3 text-[12px] text-[var(--text-muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
                    disabled={busy}
                    onClick={() => onConnect(s.id)}
                  >
                    {busy ? <LoaderCircle size={12} className="animate-spin" /> : <Power size={12} />} Connect
                  </button>
                )}
                <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                    title="Edit"
                    onClick={() => onEdit(s)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)]"
                    title="Delete"
                    onClick={() => onDelete(s)}
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Credentials list ---------- */

function KeyGrid({
  keys,
  onEdit,
  onDelete,
}: {
  keys: SshKey[];
  onEdit: (k: SshKey) => void;
  onDelete: (k: SshKey) => void;
}) {
  if (keys.length === 0) return <Empty icon={KeyRound} text="No credentials yet — add a private key." />;
  return (
    <div className={LIST}>
      {keys.map((k, i) => (
        <div key={k.id}>
          {i > 0 && <div className={ROW_DIV} />}
          <div className={LIST_ROW + " cursor-pointer"} onClick={() => onEdit(k)} title="Edit credential">
            <Avatar label={k.name} color={avatarColor(k.id)} icon={KeyRound} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium text-[var(--text-main)]">{k.name}</span>
              <span className="block truncate font-mono text-[11.5px] text-[var(--text-dim)]">
                {k.fingerprint || (k.has_key ? "fingerprint pending" : "no key body")}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <span className="flex items-center gap-1 text-[11px] text-[var(--text-dim)]" title="AES-256-GCM, master key in the OS credential store">
                <ShieldCheck size={12} /> encrypted
              </span>
              <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                  title="Edit"
                  onClick={() => onEdit(k)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)]"
                  title="Delete"
                  onClick={() => onDelete(k)}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Scripts list ---------- */

function ScriptGrid({
  scripts,
  servers,
  runningScript,
  onEdit,
  onRun,
  onDelete,
}: {
  scripts: SshScript[];
  servers: SshServer[];
  runningScript: string | null;
  onEdit: (s: SshScript) => void;
  onRun: (serverId: string, s: SshScript) => void;
  onDelete: (s: SshScript) => void;
}) {
  const [target, setTarget] = useState<string>("");
  // Servers load async: fall back to the first one until a valid target is picked.
  const effectiveTarget = servers.some((s) => s.id === target) ? target : servers[0]?.id ?? "";
  if (scripts.length === 0) return <Empty icon={FileCode2} text="No scripts yet — save a command you run often." />;
  return (
    <div className={LIST}>
      {scripts.map((s, i) => (
        <div key={s.id}>
          {i > 0 && <div className={ROW_DIV} />}
          <div className={LIST_ROW + " cursor-pointer"} onClick={() => onEdit(s)} title="Edit script">
            <Avatar label={s.name} color={avatarColor(s.id)} icon={FileCode2} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium text-[var(--text-main)]">{s.name}</span>
              <span className="block truncate font-mono text-[11.5px] text-[var(--text-dim)]">
                {s.content.split("\n")[0]}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <select
                className="h-7 max-w-[140px] cursor-pointer rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-1.5 text-[11.5px] text-[var(--text-main)] outline-none"
                value={effectiveTarget}
                onChange={(e) => setTarget(e.target.value)}
                title="Run on server"
              >
                {servers.length === 0 && <option value="">No servers</option>}
                {servers.map((srv) => (
                  <option key={srv.id} value={srv.id}>{srv.name}</option>
                ))}
              </select>
              <button
                className="flex h-7 items-center gap-1.5 rounded-full bg-[var(--accent)] px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!effectiveTarget || runningScript === s.id}
                onClick={() => effectiveTarget && onRun(effectiveTarget, s)}
              >
                {runningScript === s.id ? <LoaderCircle size={12} className="animate-spin" /> : <Play size={12} />} Run
              </button>
              <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                  title="Edit"
                  onClick={() => onEdit(s)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--diff-del)]"
                  title="Delete"
                  onClick={() => onDelete(s)}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
