import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { FolderOpen, LoaderCircle, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import * as db from "../core/db.r";
import type { SshServer } from "../core/types.i";
import { DEFAULT_TERMINAL_THEME, terminalTheme } from "../ui/TerminalTheme.s";
import { OsLogo } from "../ui/OsLogo.c";

/** Fallbacks for the ssh_* appearance settings (persisted in SQLite). */
const DEFAULT_SSH_TERMINAL = {
  fontSize: 13,
  fontFamily: "Cascadia Mono, Consolas, 'Courier New', monospace",
  scrollback: 5000,
  cursorBlink: true,
  term: "xterm-256color",
};

/**
 * connId → live PTY session id. Module-level on purpose: connection pages
 * unmount when the user switches tabs (they are separate routes), and
 * remounting must RE-ATTACH to the same shell instead of spawning a second
 * one. The entry is dropped when the shell exits or the connection is
 * closed from the sidebar.
 */
const SESSION_BY_CONN = new Map<string, string>();

/** Drop a connection's cached session — called by the App when the
 *  Connections row is closed (the PTY itself is killed there too). */
export function forgetConnSession(connId: string) {
  SESSION_BY_CONN.delete(connId);
}

/**
 * Terminal page — a real interactive PTY session on one server, sized to
 * the window. One component instance == one connection (Termius-style
 * tabs): every instance opens its OWN shell and reports its session id up
 * via onSession, so the App can kill exactly this PTY when the connection
 * row is closed. The terminal box fills the remaining window; a
 * ResizeObserver keeps the PTY geometry in sync (the size is negotiated
 * with sshd at open time AND on every resize — that is what keeps `top`,
 * `vim` etc. from drawing at the default 80×24). Output arrives
 * base64-encoded on ssh://shell-data and is written as raw bytes, so
 * binary-safe. Unmounting closes the session: the connection page IS the
 * session's lifetime.
 */
export function TerminalView({
  server,
  connId,
  onSession,
  onOpenFiles,
  onClose,
}: {
  server: SshServer;
  /** Connection page id — identity of this instance. */
  connId: string;
  /** Reports the live PTY session id up to the App (for targeted close). */
  onSession: (sessionId: string | null) => void;
  onOpenFiles: () => void;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sessionRef = useRef<string | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  /** Bumped by Reconnect: the host div remounts (key) and the effect reruns. */
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let offEvents: (() => void) | undefined;
    let offResizeObs: (() => void) | undefined;
    const cleanupFns: (() => void)[] = [];

    const savedSession = SESSION_BY_CONN.get(connId);

    const boot = async () => {
      const host = hostRef.current;
      if (!host) return;

      // 0. SSH-mode terminal settings (Settings → Terminal persists them).
      const [fs, ff, sb, cb, termType, themeName] = await Promise.all([
        db.getSetting("ssh_font_size"),
        db.getSetting("ssh_font_family"),
        db.getSetting("ssh_scrollback"),
        db.getSetting("ssh_cursor_blink"),
        db.getSetting("ssh_term"),
        db.getSetting("ssh_theme"),
      ]);
      if (cancelled) {
        return;
      }
      const tset = {
        fontSize: fs ? Number(fs) || DEFAULT_SSH_TERMINAL.fontSize : DEFAULT_SSH_TERMINAL.fontSize,
        fontFamily: ff || DEFAULT_SSH_TERMINAL.fontFamily,
        scrollback: sb ? Number(sb) || DEFAULT_SSH_TERMINAL.scrollback : DEFAULT_SSH_TERMINAL.scrollback,
        cursorBlink: cb === null ? DEFAULT_SSH_TERMINAL.cursorBlink : cb === "1",
        term: termType || DEFAULT_SSH_TERMINAL.term,
        theme: themeName || DEFAULT_TERMINAL_THEME,
      };

      // 1. Terminal fills its box; the full palette comes from the picked
      //    theme (Settings → Terminal). A stored but unknown name falls back
      //    to the default palette.
      const css = getComputedStyle(document.documentElement);
      const term = new Terminal({
        cursorBlink: tset.cursorBlink,
        fontSize: tset.fontSize,
        fontFamily: tset.fontFamily,
        scrollback: tset.scrollback,
        theme: terminalTheme(tset.theme),
      });
      // Blend with the app surface: match the page background outside the
      // terminal box so the palette does not clash with the shell theme.
      host.style.backgroundColor = terminalTheme(tset.theme).background ?? css.getPropertyValue("--bg-input").trim();
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(host);
      fit.fit();
      termRef.current = term;
      fitRef.current = fit;

      // 2. Output listener FIRST, session second: the listener filters by
      //    sessionRef, so wiring it before the session id exists is safe and
      //    closes the race where a fresh PTY's first bytes (the login banner)
      //    are emitted before onSshEvent resolved. Bytes that arrive in that
      //    window are ALSO in the Rust ring buffer — step 3 re-syncs from the
      //    snapshot, and a duplicate of the pre-snapshot tail is corrected by
      //    writing the snapshot into a fresh terminal (reset + write).
      let off: (() => void) | undefined;
      let inputDisp: { dispose: () => void } | undefined;
      let binDisp: { dispose: () => void } | undefined;
      try {
        off = await db.onSshEvent({
          onShellData: (pl) => {
            if (pl.sessionId !== sessionRef.current) return;
            term.write(db.decodeB64(pl.data));
          },
          onShellExit: (pl) => {
            if (pl.sessionId !== sessionRef.current) return;
            setStatus("closed");
            const code = pl.code === null ? "" : " with code " + pl.code;
            term.writeln("\r\n\x1b[33m[session closed" + code + "]\x1b[0m");
            sessionRef.current = null;
            SESSION_BY_CONN.delete(connId);
            onSession(null);
          },
        });
        if (cancelled) {
          off();
          term.dispose();
          return;
        }
        offEvents = off;

        // One connection page == one PTY. When this page had a session
        // before (the user switched to another tab and back), re-attach to
        // it; otherwise open a fresh PTY WITH the measured size (cols×rows).
        let sessionId: string;
        let reattached = false;
        const live = await db.sshShellList();
        const own = savedSession && live.find(([sid]) => sid === savedSession);
        if (own) {
          sessionId = own[0];
          reattached = true;
        } else {
          sessionId = await db.sshShellOpen(server.id, term.cols, term.rows, tset.term);
        }
        if (cancelled) {
          // Unmounted mid-connect — do not leak the shell we just opened.
          if (!reattached) void db.sshShellClose(sessionId).catch(() => {});
          term.dispose();
          return;
        }
        sessionRef.current = sessionId;
        SESSION_BY_CONN.set(connId, sessionId);
        if (!reattached) onSession(sessionId);

        // 3. Re-sync from the ring-buffer snapshot: it covers everything up
        //    to now (including any banner bytes emitted while we awaited),
        //    so paint a clean screen from it rather than risking duplicates.
        const snapshot = await db.sshShellSnapshot(sessionId);
        if (!cancelled) {
          term.reset();
          if (snapshot.length) term.write(snapshot);
          setStatus("open");
        }

        // 4. Keyboard → PTY (only after the session exists).
        inputDisp = term.onData((data) => {
          if (sessionRef.current) void db.sshShellInput(sessionRef.current, data).catch(() => {});
        });
        binDisp = term.onBinary((data) => {
          if (sessionRef.current) void db.sshShellInput(sessionRef.current, data).catch(() => {});
        });
        cleanupFns.push(() => inputDisp?.dispose(), () => binDisp?.dispose());
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setError(e instanceof Error ? e.message : String(e));
          term.writeln("\x1b[31m" + (e instanceof Error ? e.message : String(e)) + "\x1b[0m");
        }
        return;
      }

      // 5. Window/panel resizes → refit → tell the remote PTY the new size.
      const sendResize = () => {
        try {
          fitRef.current?.fit();
        } catch {
          return;
        }
        const t = termRef.current;
        if (t && sessionRef.current) {
          void db.sshShellResize(sessionRef.current, t.cols, t.rows).catch(() => {});
        }
      };
      const ro = new ResizeObserver(() => sendResize());
      ro.observe(host);
      offResizeObs = () => ro.disconnect();

      cleanupFns.push(() => inputDisp.dispose(), () => binDisp.dispose());
    };

    void boot();

    return () => {
      cancelled = true;
      offEvents?.();
      offResizeObs?.();
      cleanupFns.forEach((f) => f());
      sessionRef.current = null;
      // The PTY itself stays alive in Rust: switching connection tabs only
      // unmounts the view — switching back re-attaches via SESSION_BY_CONN.
      // The session is killed by closeSshConn when the Connections row dies.
      termRef.current?.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, server.id, nonce]);

  const reconnect = () => {
    setStatus("connecting");
    setError(null);
    SESSION_BY_CONN.delete(connId);
    setNonce((n) => n + 1);
  };

  return (
    <motion.div
      className="relative flex h-full min-h-0 flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
    >
      {/* No navbar: the console IS the page. Only transient states float
          over the terminal as small pills (connecting / session closed /
          error) — they never occupy layout space. */}
      {/* Detected-OS badge floats top-left (Rust probes it on connect).
          Logo only — no OS name text over the terminal. */}
      {server.os && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center rounded-full border border-[var(--border)] bg-[var(--bg-surface)]/80 p-1 shadow-[var(--shadow-popup)] backdrop-blur">
          <OsLogo os={server.os} seed={server.id} name={server.name} size={16} />
        </div>
      )}
      {status === "connecting" && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-surface)]/95 px-3.5 py-1.5 text-[12px] text-[var(--text-muted)] shadow-[var(--shadow-popup)] backdrop-blur">
          <LoaderCircle size={12} className="animate-spin" />
          <span className="font-mono">
            {server.username}@{server.host}
          </span>
        </div>
      )}

      {(status === "closed" || status === "error") && (
        <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-surface)]/95 px-2 py-1.5 shadow-[var(--shadow-popup)] backdrop-blur">
          <button
            className="flex h-6 items-center gap-1.5 rounded-full bg-[var(--accent)] px-3 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90"
            onClick={reconnect}
          >
            Reconnect
          </button>
          <button
            className="flex h-6 items-center gap-1.5 rounded-full px-3 text-[11.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
            onClick={onOpenFiles}
            title="Files of this server"
          >
            <FolderOpen size={12} /> Files
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
            title="Back to Units (the session keeps running)"
            onClick={onClose}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {error && (
        <div className="pointer-events-none absolute left-1/2 top-14 z-10 max-w-[70%] -translate-x-1/2 rounded-full border border-[var(--diff-del)]/40 bg-[var(--bg-surface)]/95 px-3.5 py-1.5 text-[11.5px] text-[var(--diff-del)] shadow-[var(--shadow-popup)] backdrop-blur">
          <span className="block truncate" title={error}>{error}</span>
        </div>
      )}

      {/* The terminal fills the entire window — xterm measures this box. */}
      <div key={nonce} ref={hostRef} className="min-h-0 flex-1 overflow-hidden bg-[var(--bg-input)] px-1 py-1" />
    </motion.div>
  );
}
