import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { FolderOpen, LoaderCircle, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { readText as clipboardRead, writeText as clipboardWrite } from "@tauri-apps/plugin-clipboard-manager";
import * as db from "../core/db.r";
import type { SshServer } from "../core/types.i";
import { DEFAULT_TERMINAL_THEME, terminalTheme } from "../ui/TerminalTheme.s";
// import { OsLogo } from "../ui/OsLogo.c";

/** Fallbacks for the ssh_* appearance settings (persisted in SQLite). */
const DEFAULT_SSH_TERMINAL = {
  fontSize: 13,
  fontFamily: "Cascadia Mono, Consolas, 'Courier New', monospace",
  scrollback: 5000,
  cursorBlink: true,
  term: "xterm-256color",
};

type TermStatus = "connecting" | "open" | "closed" | "error";

/**
 * One live terminal per connection page, kept for the page's whole life —
 * NOT per mount. Connection pages unmount when the user switches tabs;
 * disposing the xterm then and repainting it later from the 256 KB ring
 * buffer lost everything a full-screen program (htop, watch, a dev server's
 * status screen) drew before the buffer's cut: only the parts that kept
 * changing came back. Now the xterm, its screen, scrollback and selection
 * stay intact and keep receiving output while hidden; a remount only moves
 * its element back into the page. Disposed when the connection is closed
 * (forgetConnSession) or reconnected.
 */
interface LiveTerm {
  term: Terminal;
  fit: FitAddon;
  /** xterm's own box — moved between page mounts, never recreated. */
  el: HTMLDivElement;
  background: string;
  /** TERM value asked for the PTY. */
  termType: string;
  sessionId: string | null;
  status: TermStatus;
  error: string | null;
  /** The mounted page (null while the tab is hidden). */
  view: { setStatus: (s: TermStatus) => void; setError: (e: string | null) => void } | null;
  onSession: (sessionId: string | null) => void;
  dead: boolean;
  cleanup: (() => void)[];
}

// On globalThis so a hot reload of this module (dev) keeps the SAME map: a
// fresh one left the old xterms alive and subscribed, and every one of them
// answered the shell's terminal queries (background colour, cursor
// position) — the extra answers landed in the prompt as "11;rgb:…;1R".
const LIVE: Map<string, LiveTerm> = ((globalThis as { __sshTerms?: Map<string, LiveTerm> }).__sshTerms ??= new Map());

/** connId → "copied" toast of the page showing that connection. */
const COPIED_BY_CONN = new Map<string, () => void>();

/**
 * Pastes text into a connection's terminal as if the user pasted it: xterm
 * wraps it in bracketed-paste markers when the shell asked for them, so a
 * multi-line script lands in the prompt instead of executing line by line.
 * Returns false when that terminal is not mounted.
 */
export function pasteIntoConn(connId: string, text: string): boolean {
  const live = LIVE.get(connId);
  if (!live || live.dead) return false;
  live.term.paste(text);
  live.term.focus();
  return true;
}

function disposeLive(connId: string) {
  const live = LIVE.get(connId);
  if (!live) return;
  LIVE.delete(connId);
  live.dead = true;
  live.cleanup.forEach((f) => f());
  live.el.remove();
  live.term.dispose();
}

/** Drop a connection's terminal — called by the App when the Connections
 *  row is closed (the PTY itself is killed there too). */
export function forgetConnSession(connId: string) {
  disposeLive(connId);
}

function setLiveStatus(live: LiveTerm, status: TermStatus, error?: string | null) {
  live.status = status;
  live.view?.setStatus(status);
  if (error !== undefined) {
    live.error = error;
    live.view?.setError(error);
  }
}

/** Tells the shell whether a terminal has keyboard focus: Ctrl+Shift+C is
 *  taken from the browser (terminal copy) only then (lib.rs). */
let terminalFocused = false;
function trackTerminalFocus() {
  const sync = () => {
    const now = !!document.activeElement?.closest(".xterm");
    if (now === terminalFocused) return;
    terminalFocused = now;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("terminal_focus", { focused: now }))
      .catch(() => {});
  };
  document.addEventListener("focusin", sync);
  document.addEventListener("focusout", () => setTimeout(sync, 0));
}
if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) trackTerminalFocus();

/** Copy / paste. In xterm Ctrl+C is SIGINT and the app blocks the native
 *  context menu, so selected text could not be copied at all. Copying is
 *  explicit and only Ctrl+Shift+C (Ctrl+C stays an interrupt); Ctrl+V /
 *  Ctrl+Shift+V and right click paste. Through the system clipboard (Tauri
 *  plugin) — the WebView's navigator.clipboard silently failed here. */
function wireClipboard(live: LiveTerm, onCopied: () => void) {
  const { term, el } = live;
  const write = (text: string) =>
    clipboardWrite(text)
      .catch(() => navigator.clipboard.writeText(text))
      .then(onCopied)
      .catch((e) => console.error("[terminal] copy failed", e));
  const copySelection = () => {
    const text = term.getSelection();
    if (!text) return false;
    void write(text);
    term.clearSelection();
    return true;
  };
  const paste = () => {
    void clipboardRead()
      .catch(() => navigator.clipboard.readText())
      .then((text) => {
        if (text) term.paste(text);
      })
      .catch((e) => console.error("[terminal] paste failed", e));
  };
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !(e.ctrlKey || e.metaKey) || e.altKey) return true;
    if (e.code === "KeyC" && e.shiftKey) {
      e.preventDefault();
      copySelection();
      return false;
    }
    if (e.code === "KeyV") {
      e.preventDefault();
      paste();
      return false;
    }
    return true;
  });
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    paste();
  };
  el.addEventListener("contextmenu", onContextMenu);
  live.cleanup.push(
    () => el.removeEventListener("contextmenu", onContextMenu),
  );
}

/** Creates the connection's terminal and its PTY session (or re-attaches to
 *  a session that outlived a reload). Runs detached from any mount. */
async function createLive(onSession: (sessionId: string | null) => void): Promise<LiveTerm> {
  // 0. SSH-mode terminal settings (Settings → Terminal persists them).
  const [fs, ff, sb, cb, termType, themeName] = await Promise.all([
    db.getSetting("ssh_font_size"),
    db.getSetting("ssh_font_family"),
    db.getSetting("ssh_scrollback"),
    db.getSetting("ssh_cursor_blink"),
    db.getSetting("ssh_term"),
    db.getSetting("ssh_theme"),
  ]);
  const tset = {
    fontSize: fs ? Number(fs) || DEFAULT_SSH_TERMINAL.fontSize : DEFAULT_SSH_TERMINAL.fontSize,
    fontFamily: ff || DEFAULT_SSH_TERMINAL.fontFamily,
    scrollback: sb ? Number(sb) || DEFAULT_SSH_TERMINAL.scrollback : DEFAULT_SSH_TERMINAL.scrollback,
    cursorBlink: cb === null ? DEFAULT_SSH_TERMINAL.cursorBlink : cb === "1",
    term: termType || DEFAULT_SSH_TERMINAL.term,
    theme: themeName || DEFAULT_TERMINAL_THEME,
  };

  // 1. The full palette comes from the picked theme (Settings → Terminal);
  //    a stored but unknown name falls back to the default palette.
  const css = getComputedStyle(document.documentElement);
  const term = new Terminal({
    cursorBlink: tset.cursorBlink,
    fontSize: tset.fontSize,
    fontFamily: tset.fontFamily,
    scrollback: tset.scrollback,
    theme: terminalTheme(tset.theme),
  });
  const el = document.createElement("div");
  el.style.width = "100%";
  el.style.height = "100%";
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  const live: LiveTerm = {
    term,
    fit,
    el,
    // Blend with the app surface: match the page background outside the
    // terminal box so the palette does not clash with the shell theme.
    background: terminalTheme(tset.theme).background ?? css.getPropertyValue("--bg-input").trim(),
    termType: tset.term,
    sessionId: null,
    status: "connecting",
    error: null,
    view: null,
    onSession,
    dead: false,
    cleanup: [],
  };
  return live;
}

/** Opens the session of a fresh live terminal (its element is mounted and
 *  fitted by now, so cols×rows are the real ones). */
async function connectLive(live: LiveTerm, server: SshServer) {
  const { term } = live;
  // 2. Output listener FIRST, session second: the listener filters by
  //    sessionId, so wiring it before the session id exists is safe and
  //    closes the race where a fresh PTY's first bytes (the login banner)
  //    are emitted before onSshEvent resolved. Those bytes are ALSO in the
  //    Rust ring buffer — step 3 paints the screen from the snapshot.
  try {
    const off = await db.onSshEvent({
      onShellData: (pl) => {
        if (pl.sessionId === live.sessionId) term.write(db.decodeB64(pl.data));
      },
      onShellExit: (pl) => {
        if (pl.sessionId !== live.sessionId) return;
        const code = pl.code === null ? "" : " with code " + pl.code;
        term.writeln("\r\n\x1b[33m[session closed" + code + "]\x1b[0m");
        live.sessionId = null;
        setLiveStatus(live, "closed");
        live.onSession(null);
      },
    });
    live.cleanup.push(off);
    if (live.dead) return;

    const sessionId = await db.sshShellOpen(server.id, term.cols, term.rows, live.termType);
    if (live.dead) {
      // Closed mid-connect — do not leak the shell we just opened.
      void db.sshShellClose(sessionId).catch(() => {});
      return;
    }
    live.sessionId = sessionId;
    live.onSession(sessionId);

    // 3. Paint a clean screen from the ring-buffer snapshot: it covers
    //    everything up to now, including banner bytes emitted meanwhile.
    const snapshot = await db.sshShellSnapshot(sessionId);
    if (live.dead) return;
    term.reset();
    if (snapshot.length) term.write(snapshot);
    setLiveStatus(live, "open");

    // 4. Keyboard → PTY.
    const send = (data: string) => {
      if (live.sessionId) void db.sshShellInput(live.sessionId, data).catch(() => {});
    };
    const inputDisp = term.onData(send);
    const binDisp = term.onBinary(send);
    live.cleanup.push(() => inputDisp.dispose(), () => binDisp.dispose());
  } catch (e) {
    if (live.dead) return;
    const msg = e instanceof Error ? e.message : String(e);
    setLiveStatus(live, "error", msg);
    term.writeln("\x1b[31m" + msg + "\x1b[0m");
  }
}

/**
 * Terminal page — a real interactive PTY session on one server, sized to
 * the window. One connection page == one terminal and one PTY
 * (Termius-style tabs), reported up via onSession so the App can kill
 * exactly this PTY when the connection row is closed. The terminal box
 * fills the remaining window; a ResizeObserver keeps the PTY geometry in
 * sync (the size is negotiated with sshd at open time AND on every resize —
 * that is what keeps `top`, `vim` etc. from drawing at the default 80×24).
 * Output arrives base64-encoded on ssh://shell-data and is written as raw
 * bytes, so binary-safe. The terminal outlives the page mount (see LIVE).
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
  const existing = LIVE.get(connId);
  const [status, setStatus] = useState<TermStatus>(existing?.status ?? "connecting");
  const [error, setError] = useState<string | null>(existing?.error ?? null);
  const [copied, setCopied] = useState(0);
  /** Bumped by Reconnect: the effect reruns with a fresh terminal. */
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(0), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  useEffect(() => {
    let unmounted = false;
    let ro: ResizeObserver | undefined;
    let live: LiveTerm | undefined;

    const mount = (l: LiveTerm) => {
      const host = hostRef.current;
      if (!host || unmounted) return;
      live = l;
      l.view = { setStatus, setError };
      l.onSession = onSession;
      setStatus(l.status);
      setError(l.error);
      host.style.backgroundColor = l.background;
      host.appendChild(l.el);
      if (!l.term.element) l.term.open(l.el);
      // 5. Window/panel resizes → refit → tell the remote PTY the new size.
      const sendResize = () => {
        try {
          l.fit.fit();
        } catch {
          return;
        }
        if (l.sessionId) void db.sshShellResize(l.sessionId, l.term.cols, l.term.rows).catch(() => {});
      };
      sendResize();
      l.term.refresh(0, l.term.rows - 1);
      ro = new ResizeObserver(sendResize);
      ro.observe(host);
      l.term.focus();
    };

    const known = LIVE.get(connId);
    if (known) {
      mount(known);
    } else {
      void createLive(onSession).then((l) => {
        if (LIVE.has(connId)) {
          // A second mount won the race — use its terminal.
          l.term.dispose();
          if (!unmounted) mount(LIVE.get(connId)!);
          return;
        }
        LIVE.set(connId, l);
        wireClipboard(l, () => COPIED_BY_CONN.get(connId)?.());
        mount(l);
        void connectLive(l, server);
      });
    }

    return () => {
      unmounted = true;
      ro?.disconnect();
      if (live) {
        live.view = null;
        // Hidden, not destroyed: output keeps landing in it.
        live.el.remove();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, server.id, nonce]);

  // The copy toast of whichever page shows this connection.
  useEffect(() => {
    const f = () => setCopied(Date.now());
    COPIED_BY_CONN.set(connId, f);
    return () => {
      if (COPIED_BY_CONN.get(connId) === f) COPIED_BY_CONN.delete(connId);
    };
  }, [connId]);

  const reconnect = () => {
    const old = LIVE.get(connId);
    if (old?.sessionId) void db.sshShellClose(old.sessionId).catch(() => {});
    disposeLive(connId);
    setStatus("connecting");
    setError(null);
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

      {copied > 0 && (
        <div className="pointer-events-none absolute bottom-3 right-3 z-10 rounded-full border border-[var(--border)] bg-[var(--bg-surface)]/95 px-3 py-1 text-[11.5px] text-[var(--text-muted)] shadow-[var(--shadow-popup)] backdrop-blur">
          Copied
        </div>
      )}

      {/* The terminal fills the entire window — xterm measures this box. */}
      <div key={nonce} ref={hostRef} className="min-h-0 flex-1 overflow-hidden bg-[var(--bg-input)] px-1 py-1" />
    </motion.div>
  );
}
