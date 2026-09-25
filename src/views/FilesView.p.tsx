import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  Folder,
  File,
  TerminalSquare,
  Upload,
  Download,
  RefreshCw,
  LoaderCircle,
  X,
  Home,
} from "lucide-react";
import * as db from "../core/db.r";
import type { SftpEntry, SshServer } from "../core/types.i";
import { OsLogo } from "../ui/OsLogo.c";

/**
 * Files page — SFTP browser over the same pooled SSH connection
 * (Termius-style). Remote listing on top, uploads/downloads with a live
 * progress bar driven by the ssh://transfer event. Transfers use native
 * file dialogs; Rust streams both directions in 32 KB chunks.
 */
export function FilesView({
  server,
  onOpenTerminal,
  onClose,
}: {
  server: SshServer;
  onOpenTerminal: () => void;
  onClose: () => void;
}) {
  const [cwd, setCwd] = useState<string>("~");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<db.SshTransferProgress | null>(null);
  const busyRef = useRef(false);

  const load = useCallback(
    async (path: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const target = path === "~" ? await db.sftpHome(server.id) : path;
        const list = await db.sftpList(server.id, target);
        setCwd(target);
        setEntries(list);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
        busyRef.current = false;
      }
    },
    [server.id],
  );

  useEffect(() => {
    void load("~");
  }, [load]);

  useEffect(() => {
    let off: (() => void) | undefined;
    db.onSshEvent({
      onTransfer: (t) => {
        if (t.serverId !== server.id) return;
        setTransfer(t);
        if (t.finished) setTimeout(() => setTransfer(null), 800);
      },
    }).then((fn) => {
      off = fn;
    });
    return () => off?.();
  }, [server.id]);

  const pickSave = async (suggestedName: string): Promise<string | null> => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    return (await save({ defaultPath: suggestedName })) as string | null;
  };

  const pickOpen = async (): Promise<string | null> => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    return (await open({ multiple: false })) as string | null;
  };

  const download = async (e: SftpEntry) => {
    const local = await pickSave(e.name);
    if (!local) return;
    try {
      await db.sftpDownload(server.id, e.path, local);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const upload = async () => {
    const local = await pickOpen();
    if (!local) return;
    const name = local.replace(/^.*[\\/]/, "");
    const remote = (cwd.endsWith("/") ? cwd : cwd + "/") + name;
    try {
      await db.sftpUpload(server.id, local, remote);
      await load(cwd);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (e: SftpEntry) => {
    try {
      await db.sftpRemove(server.id, e.path, e.isDir);
      await load(cwd);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const parts = cwd.split("/").filter(Boolean);
  const crumbs = parts.map((seg, i) => ({ label: seg, path: "/" + parts.slice(0, i + 1).join("/") }));

  const fmtSize = (n: number) =>
    n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : n >= 1e3 ? (n / 1e3).toFixed(1) + " KB" : n + " B";

  const headerBtn = "flex h-6 items-center gap-1.5 rounded-md border border-[var(--border)] px-2 text-[11.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";

  return (
    <motion.div
      className="flex h-full min-h-0 flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
    >
      {/* No navbar: one slim toolbar — OS logo + breadcrumbs left, actions right. */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border)] px-3 text-[11.5px]">
        {/* Detected-OS logo (same component as the sidebar / Units page) */}
        <span className="mr-1 flex shrink-0 items-center gap-1.5">
          <OsLogo os={server.os} seed={server.id} name={server.name} size={16} />
          <span className="max-w-[120px] truncate font-medium text-[var(--text-muted)]">{server.name}</span>
        </span>
        <button
          className="shrink-0 rounded px-1 py-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
          onClick={() => void load("/")}
          title="Root"
        >
          <Home size={12} />
        </button>
        <span className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            const cls = last
              ? "shrink-0 rounded px-1 py-0.5 font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
              : "shrink-0 rounded px-1 py-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";
            return (
              <span key={c.path} className="flex shrink-0 items-center">
                <span className="text-[var(--text-dim)]">/</span>
                <button className={cls} onClick={() => void load(c.path)}>
                  {c.label}
                </button>
              </span>
            );
          })}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <button className={headerBtn} onClick={() => void load(cwd)} title="Refresh">
            <RefreshCw size={12} />
          </button>
          <button className={headerBtn} onClick={onOpenTerminal} title="Terminal of this server">
            <TerminalSquare size={12} />
          </button>
          <button
            className="flex h-6 items-center gap-1.5 rounded-md bg-[var(--accent)] px-2.5 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90"
            onClick={() => void upload()}
            title="Upload file here"
          >
            <Upload size={11} /> Upload
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
            onClick={onClose}
            title="Close page"
          >
            <X size={12} />
          </button>
        </span>
      </div>

      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--diff-del)]/30 bg-[var(--diff-del)]/10 px-4 py-1.5 text-[12px] text-[var(--diff-del)]">
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button onClick={() => setError(null)}>
            <X size={12} />
          </button>
        </div>
      )}

      {transfer && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-surface)] px-4 py-1.5 text-[11.5px] text-[var(--text-muted)]">
          <span className="w-40 truncate font-mono">{transfer.file}</span>
          <div className="h-1 min-w-[120px] flex-1 overflow-hidden rounded bg-[var(--hover-bg)]">
            <div
              className="h-full rounded bg-[var(--accent)] transition-all"
              style={{
                width: transfer.total
                  ? Math.min(100, (transfer.done / transfer.total) * 100) + "%"
                  : "30%",
              }}
            />
          </div>
          <span className="shrink-0 font-mono">
            {fmtSize(transfer.done)}
            {transfer.total ? " / " + fmtSize(transfer.total) : ""}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center gap-2 p-8 text-[13px] text-[var(--text-muted)]">
            <LoaderCircle size={14} className="animate-spin" /> Listing…
          </div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-[var(--text-muted)]">Empty directory</div>
        ) : (
          <table className="w-full text-[12.5px]">
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.path}
                  className="group border-b border-[var(--border)]/40 transition-colors hover:bg-[var(--hover-bg)]"
                >
                  <td className="w-8 px-3 py-1.5">
                    {e.isDir ? (
                      <Folder size={14} className="text-[var(--accent)]" />
                    ) : (
                      <File size={14} className="text-[var(--text-dim)]" />
                    )}
                  </td>
                  <td className="py-1.5">
                    {e.isDir ? (
                      <button
                        className="font-medium text-[var(--text-main)] hover:underline"
                        onClick={() => void load(e.path)}
                      >
                        {e.name}
                      </button>
                    ) : (
                      <span className="text-[var(--text-main)]">{e.name}</span>
                    )}
                  </td>
                  <td className="w-24 px-2 py-1.5 text-right font-mono text-[11px] text-[var(--text-dim)]">
                    {e.isDir ? "—" : fmtSize(e.size)}
                  </td>
                  <td className="w-40 px-2 py-1.5 text-right font-mono text-[11px] text-[var(--text-dim)]">
                    {e.modified ? new Date(e.modified * 1000).toLocaleString() : "—"}
                  </td>
                  <td className="w-20 px-3 py-1.5 text-right">
                    <span className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      {!e.isDir && (
                        <button
                          className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--bg-input)] hover:text-[var(--text-main)]"
                          title="Download"
                          onClick={() => void download(e)}
                        >
                          <Download size={13} />
                        </button>
                      )}
                      <button
                        className="rounded p-1 text-[var(--text-dim)] hover:bg-[var(--bg-input)] hover:text-[var(--diff-del)]"
                        title="Delete"
                        onClick={() => void remove(e)}
                      >
                        <X size={13} />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </motion.div>
  );
}
