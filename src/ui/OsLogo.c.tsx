import { OS_ICONS } from "../core/types.i";

/** Deterministic avatar color from an id — Termius-style palette. */
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

export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/**
 * Server OS logo — the distribution Rust detects on connect ("ubuntu",
 * "fedora", "windows", …) rendered from /icons/os. While the OS is unknown
 * (never connected / undetected), falls back to the colored initial avatar.
 * The same component everywhere: SSH sidebar, Connections rows, Units page.
 */
export function OsLogo({
  os,
  seed,
  name,
  size = 20,
}: {
  /** Detected OS token (SshServer.os); "" or undefined = unknown. */
  os?: string;
  /** Color seed for the fallback avatar (server id). */
  seed: string;
  /** First letter for the fallback avatar (server name). */
  name: string;
  /** Rendered size in px (square). */
  size?: number;
}) {
  const src = os ? OS_ICONS[os] || "" : "";
  if (src) {
    return (
      <img
        src={src}
        alt={os}
        title={os}
        className="shrink-0 rounded-full object-contain"
        style={{ width: size, height: size }}
        draggable={false}
      />
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
      style={{ backgroundColor: avatarColor(seed), width: size, height: size }}
      title={os ? os : "OS not detected yet"}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
