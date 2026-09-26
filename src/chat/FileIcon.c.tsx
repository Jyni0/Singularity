/**
 * Language badge for a file — the small colored "JS" / "TS" / "RS" tile shown
 * next to file names in tool rows and the "Worked for" header, so a glance at
 * the transcript says which kind of file each action touched.
 */
import { FileText, Folder } from "lucide-react";

interface Lang {
  label: string;
  bg: string;
  fg?: string;
}

const LANGS: Record<string, Lang> = {
  ts: { label: "TS", bg: "#3178c6" },
  tsx: { label: "TSX", bg: "#3178c6" },
  mts: { label: "TS", bg: "#3178c6" },
  js: { label: "JS", bg: "#f7df1e", fg: "#1f1f1f" },
  jsx: { label: "JSX", bg: "#f7df1e", fg: "#1f1f1f" },
  mjs: { label: "JS", bg: "#f7df1e", fg: "#1f1f1f" },
  cjs: { label: "JS", bg: "#f7df1e", fg: "#1f1f1f" },
  rs: { label: "RS", bg: "#ce7e4f" },
  py: { label: "PY", bg: "#3776ab" },
  go: { label: "GO", bg: "#00add8" },
  java: { label: "JV", bg: "#b07219" },
  kt: { label: "KT", bg: "#a97bff" },
  swift: { label: "SW", bg: "#f05138" },
  c: { label: "C", bg: "#5c6bc0" },
  h: { label: "H", bg: "#5c6bc0" },
  cpp: { label: "C++", bg: "#f34b7d" },
  cc: { label: "C++", bg: "#f34b7d" },
  hpp: { label: "H++", bg: "#f34b7d" },
  cs: { label: "C#", bg: "#178600" },
  rb: { label: "RB", bg: "#cc342d" },
  php: { label: "PHP", bg: "#777bb4" },
  lua: { label: "LUA", bg: "#000080" },
  dart: { label: "DT", bg: "#00b4ab" },
  vue: { label: "V", bg: "#41b883" },
  svelte: { label: "S", bg: "#ff3e00" },
  html: { label: "<>", bg: "#e34c26" },
  htm: { label: "<>", bg: "#e34c26" },
  css: { label: "#", bg: "#663399" },
  scss: { label: "#", bg: "#c6538c" },
  less: { label: "#", bg: "#1d365d" },
  json: { label: "{}", bg: "#a8a820", fg: "#1f1f1f" },
  toml: { label: "TM", bg: "#9c4221" },
  yaml: { label: "YM", bg: "#cb171e" },
  yml: { label: "YM", bg: "#cb171e" },
  xml: { label: "<>", bg: "#0060ac" },
  md: { label: "MD", bg: "#519aba" },
  sql: { label: "SQL", bg: "#e38c00" },
  sh: { label: "$", bg: "#4eaa25" },
  bash: { label: "$", bg: "#4eaa25" },
  ps1: { label: "PS", bg: "#012456" },
  bat: { label: "$", bg: "#c1f12e", fg: "#1f1f1f" },
  cmd: { label: "$", bg: "#c1f12e", fg: "#1f1f1f" },
  lock: { label: "LK", bg: "#6b7280" },
  env: { label: "ENV", bg: "#ecd53f", fg: "#1f1f1f" },
  svg: { label: "SVG", bg: "#ffb13b", fg: "#1f1f1f" },
  png: { label: "IMG", bg: "#a074c4" },
  jpg: { label: "IMG", bg: "#a074c4" },
  jpeg: { label: "IMG", bg: "#a074c4" },
  gif: { label: "IMG", bg: "#a074c4" },
  webp: { label: "IMG", bg: "#a074c4" },
  ico: { label: "IMG", bg: "#a074c4" },
  txt: { label: "TXT", bg: "#6b7280" },
};

/** Special whole-file names. */
const NAMES: Record<string, Lang> = {
  dockerfile: { label: "DK", bg: "#2496ed" },
  makefile: { label: "MK", bg: "#427819" },
  "cargo.toml": { label: "RS", bg: "#ce7e4f" },
  "package.json": { label: "NPM", bg: "#cb3837" },
};

/** Basename of a path (both separators). */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/** Parent directory of a path, "" at the root. */
export function dirName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(0, -1).join("/");
}

function langOf(path: string): Lang | null {
  const name = baseName(path).toLowerCase();
  if (NAMES[name]) return NAMES[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0 && !name.startsWith(".")) return null;
  const ext = name.slice(dot + 1);
  return LANGS[ext] ?? null;
}

export function FileIcon({ path, folder, size = 14 }: { path: string; folder?: boolean; size?: number }) {
  if (folder) return <Folder size={size} strokeWidth={1.6} className="shrink-0 text-[#dcb67a]" />;
  const lang = langOf(path);
  if (!lang) return <FileText size={size} strokeWidth={1.6} className="shrink-0 text-[var(--text-dim)]" />;
  const long = lang.label.length > 2;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[3px] font-bold leading-none tracking-tight"
      style={{
        width: size + (long ? 4 : 0),
        height: size,
        background: lang.bg,
        color: lang.fg ?? "#fff",
        fontSize: long ? size * 0.45 : size * 0.55,
      }}
      title={baseName(path)}
      aria-hidden
    >
      {lang.label}
    </span>
  );
}
