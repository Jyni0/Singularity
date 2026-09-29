import { useCallback, useEffect, useRef, useState } from "react";
import { shortcutKey } from "../utils/keys.u";
import { motion } from "motion/react";
import {
  Folder,
  File,
  TerminalSquare,
  Upload,
  Download,
  RefreshCw,
  X,
  Home,
  Save,
  FileCode2,
  FolderOpen,
  FolderPlus,
  FilePlus2,
  Pencil,
  Copy,
  Trash2,
  Search,
  CheckSquare,
} from "lucide-react";
import * as db from "../core/db.r";
import type { SftpEntry, SshServer } from "../core/types.i";
import { CodeEditor } from "../components/code/CodeEditor.c";
import { OsLogo, OverlayScroll, ScrollArea, ContextMenu, type ContextMenuItem, Button, Spinner, IconButton } from "../components";

/** A remote file open in the editor. */
type OpenFile = {
  path: string;
  name: string;
  /** Text as last loaded/saved — "dirty" is text !== saved. */
  saved: string;
  text: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
};

const joinRemote = (dir: string, name: string) => (dir.endsWith("/") ? dir : dir + "/") + name;

/** Minimal slice of the (non-standard, but WebView2/WebKit-supported) FileSystem entry API. */
type FsEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (e: FsEntry[]) => void, err: (e: unknown) => void) => void };
};

/** Every child of a dropped folder (readEntries hands them out in batches). */
async function readAll(dir: FsEntry): Promise<FsEntry[]> {
  const reader = dir.createReader!();
  const out: FsEntry[] = [];
  for (;;) {
    const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err));
    if (batch.length === 0) return out;
    out.push(...batch);
  }
}

/**
 * Files page — SFTP browser over the same pooled SSH connection
 * (Termius-style). Remote listing on top, uploads/downloads with a live
 * progress bar driven by the ssh://transfer event. Upload picks a file with
 * the native dialog, or files/folders are dragged onto the page (or onto a
 * folder row). Click selects (Ctrl/Shift for more), double-click opens a
 * folder or edits a file, right-click opens the actions menu, Ctrl+F
 * filters the folder. Save in the editor writes the file back.
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
  const cwdRef = useRef("~");
  const [file, setFile] = useState<OpenFile | null>(null);
  /** Close pressed on an unsaved file: the button turns into "Discard?". */
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /** Drag-and-drop upload: overlay while OS files hover the page. */
  const [dragOver, setDragOver] = useState(false);
  /** Folder row the files hover — they go into it instead of cwd. */
  const [dropDir, setDropDir] = useState<string | null>(null);
  const dragDepth = useRef(0);
  /** Selected rows (paths): click, Ctrl+click, Shift+click, Ctrl+A. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Last plainly clicked row — the other end of a Shift+click range. */
  const anchorRef = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; targets: SftpEntry[] } | null>(null);
  /** Inline name input: a new file/folder row, or a row being renamed. */
  const [naming, setNaming] = useState<{ mode: "file" | "folder" | "rename"; path?: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SftpEntry[] | null>(null);
  /** Ctrl+F filter of the current folder; null = search closed. */
  const [query, setQuery] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (path: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const target = path === "~" ? await db.sftpHome(server.id) : path;
        const list = await db.sftpList(server.id, target);
        // A new folder starts with no selection and no filter.
        if (cwdRef.current !== target) {
          setSelected(new Set());
          setQuery(null);
          anchorRef.current = null;
        }
        cwdRef.current = target;
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

  /* ---- Editor ---- */

  const openFile = async (e: SftpEntry) => {
    setConfirmDiscard(false);
    setFile({ path: e.path, name: e.name, saved: "", text: "", loading: true, saving: false, error: null });
    try {
      const text = await db.sftpReadText(server.id, e.path);
      if (text.includes("\u0000")) throw new Error("This looks like a binary file — download it instead.");
      setFile((f) => (f && f.path === e.path ? { ...f, saved: text, text, loading: false } : f));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFile((f) => (f && f.path === e.path ? { ...f, loading: false, error: msg } : f));
    }
  };

  const saveFile = async () => {
    const f = fileRef.current;
    if (!f || f.loading || f.saving || f.error || f.text === f.saved) return;
    const text = f.text;
    setFile({ ...f, saving: true });
    try {
      await db.sftpWriteText(server.id, f.path, text);
      setFile((cur) => (cur && cur.path === f.path ? { ...cur, saving: false, saved: text } : cur));
      void load(cwd);
    } catch (err) {
      setFile((cur) => (cur && cur.path === f.path ? { ...cur, saving: false } : cur));
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  // The editor's Mod-S handler outlives renders; it reads the latest file here.
  const fileRef = useRef(file);
  fileRef.current = file;

  const closeFile = () => {
    if (file && file.text !== file.saved && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    setConfirmDiscard(false);
    setFile(null);
  };

  /* ---- Drag-and-drop upload (files and whole folders) ---- */

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  const uploadEntry = async (entry: FsEntry, dir: string): Promise<void> => {
    const remote = joinRemote(dir, entry.name);
    if (entry.isDirectory) {
      // Already there is fine — the contents merge into it.
      await db.sftpMkdir(server.id, remote).catch(() => {});
      for (const child of await readAll(entry)) await uploadEntry(child, remote);
    } else if (entry.isFile && entry.file) {
      const blob = await new Promise<File>((ok, err) => entry.file!(ok, err));
      await db.sftpUploadBlob(server.id, remote, blob);
    }
  };

  const onDrop = async (e: React.DragEvent, intoDir?: string) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDragOver(false);
    setDropDir(null);
    const target = intoDir ?? cwd;
    // Entries must be taken synchronously — the DataTransfer dies after the event.
    const items = Array.from(e.dataTransfer.items)
      .map((it) => (it.kind === "file" ? (it.webkitGetAsEntry() as FsEntry | null) : null))
      .filter((x): x is FsEntry => !!x);
    const loose = items.length === 0 ? Array.from(e.dataTransfer.files) : [];
    try {
      for (const entry of items) await uploadEntry(entry, target);
      for (const f of loose) await db.sftpUploadBlob(server.id, joinRemote(target, f.name), f);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await load(cwd);
  };

  const dropHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragOver(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) {
        setDragOver(false);
        setDropDir(null);
      }
    },
    onDrop: (e: React.DragEvent) => void onDrop(e),
  };

  /* ---- Selection, context menu, create / rename / delete ---- */

  /** Entries shown: the folder, narrowed by the Ctrl+F filter. */
  const visible = query ? entries.filter((e) => e.name.toLowerCase().includes(query.toLowerCase())) : entries;
  const selectedEntries = visible.filter((e) => selected.has(e.path));
  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const selectRow = (e: SftpEntry, ev: React.MouseEvent) => {
    const additive = ev.ctrlKey || ev.metaKey;
    if (ev.shiftKey && anchorRef.current) {
      const a = visible.findIndex((x) => x.path === anchorRef.current);
      const b = visible.findIndex((x) => x.path === e.path);
      if (a >= 0 && b >= 0) {
        const range = visible.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.path);
        setSelected((prev) => new Set(additive ? [...prev, ...range] : range));
        return;
      }
    }
    anchorRef.current = e.path;
    if (additive) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(e.path)) next.delete(e.path);
        else next.add(e.path);
        return next;
      });
    } else {
      setSelected(new Set([e.path]));
    }
  };

  const openEntry = (e: SftpEntry) => void (e.isDir ? load(e.path) : openFile(e));

  const downloadMany = async (list: SftpEntry[]) => {
    const files = list.filter((e) => !e.isDir);
    if (files.length === 0) return;
    if (files.length === 1) return download(files[0]);
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = (await open({ directory: true })) as string | null;
    if (!dir) return;
    const sep = dir.includes("\\") ? "\\" : "/";
    try {
      for (const f of files) await db.sftpDownload(server.id, f.path, dir.replace(/[\\/]$/, "") + sep + f.name);
    } catch (err) {
      setError(errText(err));
    }
  };

  const doDelete = async (list: SftpEntry[]) => {
    setConfirmDelete(null);
    listRef.current?.focus();
    try {
      for (const e of list) await db.sftpRemove(server.id, e.path, e.isDir);
    } catch (err) {
      setError(errText(err));
    }
    setSelected(new Set());
    await load(cwd);
  };

  const startNew = (mode: "file" | "folder") => {
    setMenu(null);
    setNaming({ mode, value: "" });
  };

  const startRename = (e: SftpEntry) => {
    setMenu(null);
    setNaming({ mode: "rename", path: e.path, value: e.name });
  };

  const commitNaming = async () => {
    const n = naming;
    if (!n) return;
    const name = n.value.trim();
    setNaming(null);
    listRef.current?.focus();
    if (!name || name === "." || name === "..") return;
    if (name.includes("/")) return setError("A name cannot contain '/'.");
    const target = joinRemote(cwd, name);
    const taken = entries.some((e) => e.name === name && e.path !== n.path);
    if (taken) return setError(`"${name}" already exists here.`);
    try {
      if (n.mode === "folder") await db.sftpMkdir(server.id, target);
      else if (n.mode === "file") await db.sftpWriteText(server.id, target, "");
      else if (n.path && target !== n.path) await db.sftpRename(server.id, n.path, target);
      await load(cwd);
      setSelected(new Set([target]));
      anchorRef.current = target;
      // A new file goes straight into the editor.
      if (n.mode === "file") void openFile({ name, path: target, isDir: false, size: 0, modified: 0 } as SftpEntry);
    } catch (err) {
      setError(errText(err));
    }
  };

  const copyText = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

  /** Right click: on a row acts on the selection (or just that row). */
  const openMenu = (ev: React.MouseEvent, e: SftpEntry | null) => {
    ev.preventDefault();
    ev.stopPropagation();
    let targets: SftpEntry[] = [];
    if (e) {
      targets = selected.has(e.path) ? selectedEntries : [e];
      if (!selected.has(e.path)) {
        setSelected(new Set([e.path]));
        anchorRef.current = e.path;
      }
    } else {
      setSelected(new Set());
    }
    setMenu({ x: ev.clientX, y: ev.clientY, targets });
  };

  const menuItems = (targets: SftpEntry[]): ContextMenuItem[] => {
    const one = targets.length === 1 ? targets[0] : null;
    const files = targets.filter((t) => !t.isDir);
    const items: ContextMenuItem[] = [];
    if (one) {
      items.push({
        icon: one.isDir ? <FolderOpen size={13} /> : <FileCode2 size={13} />,
        label: one.isDir ? "Open folder" : "Edit",
        hint: "Enter",
        onClick: () => openEntry(one),
      });
    }
    if (targets.length > 0) {
      items.push(
        {
          icon: <Download size={13} />,
          label: files.length > 1 ? `Download ${files.length} files` : "Download",
          disabled: files.length === 0,
          onClick: () => void downloadMany(targets),
        },
        { icon: <Pencil size={13} />, label: "Rename", hint: "F2", disabled: !one, onClick: () => one && startRename(one) },
        {
          icon: <Copy size={13} />,
          label: targets.length > 1 ? "Copy paths" : "Copy path",
          onClick: () => copyText(targets.map((t) => t.path).join("\n")),
        },
        "separator",
      );
    }
    items.push(
      { icon: <FilePlus2 size={13} />, label: "New file", onClick: () => startNew("file") },
      { icon: <FolderPlus size={13} />, label: "New folder", onClick: () => startNew("folder") },
      { icon: <Upload size={13} />, label: "Upload file…", onClick: () => void upload() },
      { icon: <RefreshCw size={13} />, label: "Refresh", onClick: () => void load(cwd) },
    );
    if (targets.length > 0) {
      items.push("separator", {
        icon: <Trash2 size={13} />,
        label: targets.length > 1 ? `Delete ${targets.length} items` : "Delete",
        hint: "Del",
        danger: true,
        onClick: () => setConfirmDelete(targets),
      });
    } else {
      items.push({
        icon: <CheckSquare size={13} />,
        label: "Select all",
        hint: "Ctrl+A",
        disabled: visible.length === 0,
        onClick: () => setSelected(new Set(visible.map((v) => v.path))),
      });
    }
    return items;
  };

  /** Keyboard on the focused list. */
  const onListKey = (ev: React.KeyboardEvent) => {
    if ((ev.target as HTMLElement).tagName === "INPUT") return;
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && shortcutKey(ev) === "A") {
      ev.preventDefault();
      setSelected(new Set(visible.map((v) => v.path)));
    } else if (ev.key === "Delete" && selectedEntries.length > 0) {
      ev.preventDefault();
      setConfirmDelete(selectedEntries);
    } else if (ev.key === "Enter" && selectedEntries.length === 1) {
      ev.preventDefault();
      openEntry(selectedEntries[0]);
    } else if (ev.key === "F2" && selectedEntries.length === 1) {
      ev.preventDefault();
      startRename(selectedEntries[0]);
    } else if (ev.key === "Backspace" && cwd !== "/") {
      ev.preventDefault();
      void load(cwd.replace(/\/[^/]+\/?$/, "") || "/");
    } else if (ev.key === "Escape") {
      setSelected(new Set());
    } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const cur = visible.findIndex((x) => x.path === anchorRef.current);
      const next = Math.max(0, Math.min(visible.length - 1, cur + (ev.key === "ArrowDown" ? 1 : -1)));
      const e = visible[next];
      if (!e) return;
      anchorRef.current = e.path;
      setSelected(new Set([e.path]));
      document.getElementById(rowId(e.path))?.scrollIntoView({ block: "nearest" });
    }
  };

  // Ctrl+F on this page opens the folder filter (the editor has its own).
  useEffect(() => {
    if (file) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && shortcutKey(e) === "F") {
        e.preventDefault();
        setQuery((q) => q ?? "");
        requestAnimationFrame(() => searchRef.current?.select());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file]);

  const parts = cwd.split("/").filter(Boolean);
  const crumbs = parts.map((seg, i) => ({ label: seg, path: "/" + parts.slice(0, i + 1).join("/") }));

  const fmtSize = (n: number) =>
    n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : n >= 1e3 ? (n / 1e3).toFixed(1) + " KB" : n + " B";

  const headerBtn = "flex h-6 items-center gap-1.5 rounded-lg border border-[var(--border)] px-2 text-[11.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";

  const nameInput = (placeholder: string) => (
    <input
      autoFocus
      className="w-full max-w-[360px] rounded-md border border-[var(--accent)] bg-[var(--bg-input)] px-1.5 py-0.5 text-[12.5px] text-[var(--text-main)] outline-none"
      placeholder={placeholder}
      value={naming?.value ?? ""}
      onChange={(ev) => setNaming((n) => (n ? { ...n, value: ev.target.value } : n))}
      onFocus={(ev) => {
        // Rename selects the name without its extension, like file managers do.
        const v = ev.target.value;
        const dot = v.lastIndexOf(".");
        ev.target.setSelectionRange(0, dot > 0 ? dot : v.length);
      }}
      onKeyDown={(ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") void commitNaming();
        if (ev.key === "Escape") {
          setNaming(null);
          listRef.current?.focus();
        }
      }}
      onBlur={() => setNaming(null)}
      onClick={(ev) => ev.stopPropagation()}
      onDoubleClick={(ev) => ev.stopPropagation()}
    />
  );

  return (
    <motion.div
      className="relative flex h-full min-h-0 flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      {...(file ? {} : dropHandlers)}
    >
      {dragOver && !file && (
        <div className="pointer-events-none absolute inset-2 top-11 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-[var(--accent)] bg-[var(--accent)]/10">
          <span className="flex items-center gap-2 rounded-xl bg-[var(--bg-surface)] px-3 py-2 text-[12.5px] text-[var(--text-main)] shadow-lg">
            <Upload size={14} className="text-[var(--accent)]" />
            Drop to upload to <span className="font-mono">{dropDir ?? cwd}</span>
          </span>
        </div>
      )}
      {/* No navbar: one slim toolbar — OS logo + breadcrumbs left, actions right. */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border)] px-3 text-[11.5px]">
        {/* Detected-OS logo (same component as the sidebar / Units page) */}
        <span className="mr-1 flex shrink-0 items-center gap-1.5">
          <OsLogo os={server.os} seed={server.id} name={server.name} size={16} />
          <span className="max-w-[120px] truncate font-medium text-[var(--text-muted)]">{server.name}</span>
        </span>
        <button
          className="shrink-0 rounded-md px-1 py-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
          onClick={() => void load("/")}
          title="Root"
        >
          <Home size={12} />
        </button>
        <OverlayScroll
          wheelX
          wrapperClassName="min-w-0 flex-1"
          className="flex items-center gap-0.5 overflow-x-auto"
        >
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            const cls = last
              ? "shrink-0 rounded-md px-1 py-0.5 font-medium text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
              : "shrink-0 rounded-md px-1 py-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";
            return (
              <span key={c.path} className="flex shrink-0 items-center">
                <span className="text-[var(--text-dim)]">/</span>
                <button className={cls} onClick={() => void load(c.path)}>
                  {c.label}
                </button>
              </span>
            );
          })}
        </OverlayScroll>
        <span className="flex shrink-0 items-center gap-1">
          {!file &&
            (query !== null ? (
              <span className="flex h-6 w-[190px] items-center gap-1.5 rounded-lg border border-[var(--accent)] bg-[var(--bg-input)] px-2">
                <Search size={11} className="shrink-0 text-[var(--text-dim)]" />
                <input
                  ref={searchRef}
                  autoFocus
                  className="min-w-0 flex-1 bg-transparent text-[11.5px] text-[var(--text-main)] outline-none"
                  placeholder="Filter this folder"
                  value={query}
                  onChange={(ev) => setQuery(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Escape") {
                      setQuery(null);
                      listRef.current?.focus();
                    } else if (ev.key === "Enter" || ev.key === "ArrowDown") {
                      ev.preventDefault();
                      const first = visible[0];
                      if (first) {
                        setSelected(new Set([first.path]));
                        anchorRef.current = first.path;
                        if (ev.key === "Enter" && visible.length === 1) openEntry(first);
                      }
                      listRef.current?.focus();
                    }
                  }}
                />
                <span className="shrink-0 font-mono text-[10px] text-[var(--text-dim)]">
                  {query ? `${visible.length}/${entries.length}` : ""}
                </span>
                <button
                  className="shrink-0 text-[var(--text-dim)] hover:text-[var(--text-main)]"
                  onClick={() => setQuery(null)}
                  title="Close search (Esc)"
                >
                  <X size={11} />
                </button>
              </span>
            ) : (
              <button
                className={headerBtn}
                onClick={() => {
                  setQuery("");
                }}
                title="Search this folder (Ctrl+F)"
              >
                <Search size={12} />
              </button>
            ))}
          <button className={headerBtn} onClick={() => void load(cwd)} title="Refresh">
            <RefreshCw size={12} />
          </button>
          <button className={headerBtn} onClick={onOpenTerminal} title="Terminal of this server">
            <TerminalSquare size={12} />
          </button>
          <Button
            variant="primary" size="xs"
            onClick={() => void upload()}
            title="Upload file here (or drag files and folders onto the page)"
          >
            <Upload size={11} /> Upload
          </Button>
          <IconButton
            label="Close page" size="xs"
            onClick={onClose}
          >
            <X size={12} />
          </IconButton>
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

      {confirmDelete && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--diff-del)]/30 bg-[var(--diff-del)]/10 px-4 py-1.5 text-[12px] text-[var(--text-main)]">
          <Trash2 size={12} className="shrink-0 text-[var(--diff-del)]" />
          <span className="min-w-0 flex-1 truncate">
            Delete {confirmDelete.length === 1 ? <span className="font-mono">{confirmDelete[0].name}</span> : `${confirmDelete.length} items`}
            {confirmDelete.some((e) => e.isDir) ? " — folders go with everything inside" : ""}?
          </span>
          <button
            autoFocus
            className="flex h-6 items-center rounded-lg bg-[var(--diff-del)] px-2.5 text-[11.5px] font-medium text-white hover:opacity-90"
            onClick={() => void doDelete(confirmDelete)}
          >
            Delete
          </button>
          <Button
            variant="secondary" size="xs"
            onClick={() => {
              setConfirmDelete(null);
              listRef.current?.focus();
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      {transfer && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-surface)] px-4 py-1.5 text-[11.5px] text-[var(--text-muted)]">
          <span className="w-40 truncate font-mono">{transfer.file}</span>
          <div className="h-1 min-w-[120px] flex-1 overflow-hidden rounded-md bg-[var(--hover-bg)]">
            <div
              className="h-full rounded-md bg-[var(--accent)] transition-all"
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

      {file ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 text-[12px]">
            <FileCode2 size={13} className="shrink-0 text-[var(--accent)]" />
            <span className="min-w-0 truncate font-mono text-[var(--text-main)]" title={file.path}>
              {file.path}
            </span>
            {file.text !== file.saved && (
              <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" title="Unsaved changes" />
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                variant="primary" size="xs"
                disabled={file.loading || file.saving || !!file.error || file.text === file.saved}
                onClick={() => void saveFile()}
                title="Save to the server (Ctrl+S)"
              >
                {file.saving ? <Spinner size={11} /> : <Save size={11} />} Save
              </Button>
              {confirmDiscard ? (
                <button
                  className="flex h-6 items-center rounded-lg px-2 text-[11.5px] text-[var(--diff-del)] transition-colors hover:bg-[var(--diff-del)]/10"
                  onClick={closeFile}
                  title="Close without saving"
                >
                  Discard changes?
                </button>
              ) : (
                <IconButton
                  label="Close file" size="xs"
                  onClick={closeFile}
                >
                  <X size={12} />
                </IconButton>
              )}
            </span>
          </div>
          {file.loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-[13px] text-[var(--text-muted)]">
              <Spinner size={14} /> Opening…
            </div>
          ) : file.error ? (
            <div className="p-8 text-center text-[13px] text-[var(--diff-del)]">{file.error}</div>
          ) : (
            <div className="min-h-0 flex-1">
              <CodeEditor
                docKey={file.path}
                initial={file.saved}
                fileName={file.name}
                onChange={(text) => {
                  setConfirmDiscard(false);
                  setFile((f) => (f ? { ...f, text } : f));
                }}
                onSave={() => void saveFile()}
              />
            </div>
          )}
        </div>
      ) : (
        <div
          ref={listRef}
          tabIndex={0}
          className="flex min-h-0 flex-1 flex-col outline-none"
          onKeyDown={onListKey}
          onContextMenu={(ev) => openMenu(ev, null)}
          onClick={() => setSelected(new Set())}
        >
          <ScrollArea className="min-h-0 flex-1">
            {loading && entries.length === 0 ? (
              <div className="flex items-center justify-center gap-2 p-8 text-[13px] text-[var(--text-muted)]">
                <Spinner size={14} /> Listing…
              </div>
            ) : visible.length === 0 && !(naming && naming.mode !== "rename") ? (
              <div className="p-8 text-center text-[13px] text-[var(--text-muted)]">
                {query ? `Nothing here matches "${query}"` : "Empty directory — right-click to create a file or folder"}
              </div>
            ) : (
              <table className="w-full select-none text-[12.5px]">
                <tbody>
                  {naming && naming.mode !== "rename" && (
                    <tr className="border-b border-[var(--border)]/40 bg-[var(--accent)]/10">
                      <td className="w-8 px-3 py-1.5">
                        {naming.mode === "folder" ? (
                          <Folder size={14} className="text-[var(--accent)]" />
                        ) : (
                          <File size={14} className="text-[var(--text-dim)]" />
                        )}
                      </td>
                      <td className="py-1" colSpan={4}>
                        {nameInput(naming.mode === "folder" ? "New folder name" : "New file name")}
                      </td>
                    </tr>
                  )}
                  {visible.map((e) => {
                    const isSel = selected.has(e.path);
                    const renaming = naming?.mode === "rename" && naming.path === e.path;
                    return (
                      <tr
                        key={e.path}
                        id={rowId(e.path)}
                        className={
                          "group cursor-default border-b border-[var(--border)]/40 transition-colors " +
                          (dropDir === e.path || isSel
                            ? "bg-[var(--accent)]/15"
                            : "hover:bg-[var(--hover-bg)]")
                        }
                        onClick={(ev) => {
                          ev.stopPropagation();
                          selectRow(e, ev);
                        }}
                        onDoubleClick={() => openEntry(e)}
                        onContextMenu={(ev) => openMenu(ev, e)}
                        title={e.isDir ? "Double-click to open" : "Double-click to edit"}
                        // Dropping onto a folder row uploads into that folder.
                        {...(e.isDir
                          ? {
                              onDragOver: (ev: React.DragEvent) => {
                                if (!hasFiles(ev)) return;
                                ev.preventDefault();
                                if (dropDir !== e.path) setDropDir(e.path);
                              },
                              onDragLeave: () => setDropDir((d) => (d === e.path ? null : d)),
                              onDrop: (ev: React.DragEvent) => void onDrop(ev, e.path),
                            }
                          : {})}
                      >
                        <td className="w-8 px-3 py-1.5">
                          {e.isDir ? (
                            <Folder size={14} className="text-[var(--accent)]" />
                          ) : (
                            <File size={14} className="text-[var(--text-dim)]" />
                          )}
                        </td>
                        <td className="py-1.5">
                          {renaming ? (
                            nameInput("New name")
                          ) : (
                            <span className={e.isDir ? "font-medium text-[var(--text-main)]" : "text-[var(--text-main)]"}>
                              {e.name}
                            </span>
                          )}
                        </td>
                        <td className="w-24 px-2 py-1.5 text-right font-mono text-[11px] text-[var(--text-dim)]">
                          {e.isDir ? "—" : fmtSize(e.size)}
                        </td>
                        <td className="w-42 px-2 py-1.5 text-right font-mono text-[11px] text-[var(--text-dim)]">
                          {e.modified ? new Date(e.modified * 1000).toLocaleString() : "—"}
                        </td>
                        <td className="w-20 px-3 py-1.5 text-right">
                          <span
                            className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100"
                            onClick={(ev) => ev.stopPropagation()}
                            onDoubleClick={(ev) => ev.stopPropagation()}
                          >
                            {!e.isDir && (
                              <button
                                className="rounded-md p-1 text-[var(--text-dim)] hover:bg-[var(--bg-input)] hover:text-[var(--text-main)]"
                                title="Download"
                                onClick={() => void download(e)}
                              >
                                <Download size={13} />
                              </button>
                            )}
                            <button
                              className="rounded-md p-1 text-[var(--text-dim)] hover:bg-[var(--bg-input)] hover:text-[var(--diff-del)]"
                              title="Delete"
                              onClick={() => setConfirmDelete([e])}
                            >
                              <X size={13} />
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </ScrollArea>
          {selectedEntries.length > 1 && (
            <div className="shrink-0 border-t border-[var(--border)] px-4 py-1 text-[11px] text-[var(--text-dim)]">
              {selectedEntries.length} selected — right-click for actions
            </div>
          )}
        </div>
      )}

      <ContextMenu at={menu} items={menu ? menuItems(menu.targets) : []} onClose={() => setMenu(null)} />
    </motion.div>
  );
}

/** DOM id of a row, for scrolling the keyboard selection into view. */
function rowId(path: string): string {
  return "sftp-row-" + path.replace(/[^a-zA-Z0-9_-]/g, "_");
}
