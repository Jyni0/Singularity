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
 * Brand color of each OS — the round background UNDER the logo, so every
 * distribution is recognizable at a glance even at 14px. Keys match the
 * detected-os tokens Rust reports (lowercased).
 */
export const OS_BRAND_COLORS: Record<string, string> = {
  ubuntu: "#E95420",   // Canonical orange
  debian: "#A81D33",   // Debian red
  fedora: "#294172",   // Fedora blue
  redhat: "#CC0000",   // Red Hat red
  arch: "#1793D1",     // Arch blue
  centos: "#932279",   // CentOS magenta
  alpine: "#0D597F",   // Alpine blue
  opensuse: "#73BA25", // openSUSE green
  gentoo: "#54487A",   // Gentoo purple
  void: "#478061",     // Void green
  nixos: "#5277C3",    // NixOS blue
  freebsd: "#AB2B28",  // FreeBSD red
  openbsd: "#f2ca30",  // OpenBSD yellow
  macos: "#6E6E73",    // Apple gray
  windows: "#0078D6",  // Windows blue
};

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
  const key = (os ?? "").toLowerCase();
  const src = os ? OS_ICONS[os] || "" : "";
  if (src) {
    // The logo sits on its OS brand color — every distro instantly readable.
    const brand = OS_BRAND_COLORS[key];
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-full"
        style={{ width: size, height: size, background: brand ?? "var(--bg-elevated)" }}
        title={os}
      >
        <img
          src={src}
          alt={os}
          className="object-contain"
          style={{ width: size * 0.68, height: size * 0.68 }}
          draggable={false}
        />
      </span>
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
