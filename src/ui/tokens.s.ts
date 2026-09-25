

/** Sidebar / titlebar row: h 32px, padding 0 8px, radius 6px, gap 10px */
export const ROW = "flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-[13px]";

/** Hover: text brightens only (no background) */
export const ROW_TEXT = "text-[var(--text-muted)] transition-colors hover:text-[var(--text-main)]";

/** Hover + active: background highlight (used by nav / settings) */
export const ROW_HOVER =
  "text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";

/** Active row: background highlight only (no other changes) */
export const ROW_ACTIVE = "bg-[var(--hover-bg)]";

/** Chip in prompt box: h 28px, padding 0 10px, radius 6px, 12px */
export const CHIP =
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";

/** Context chip: h 24px, padding 0 8px, 11px */
export const CHIP_CTX =
  "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px] text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";

/* Settings controls share ONE geometry: h-9 (36px) tall, 240px wide in the
   right-hand control column — selects (Combobox), inputs and buttons all
   line up. */

/** Small theme-aware button (settings / panels) */
export const SBUTTON =
  "flex h-9 shrink-0 items-center justify-center rounded-md bg-[var(--bg-elevated)] px-3 text-[12px] text-[var(--text-main)] transition-colors hover:bg-[var(--bg-input)] disabled:cursor-not-allowed disabled:opacity-50";

/** Select in settings */
export const SSELECT =
  "h-9 w-[240px] cursor-pointer rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2 text-[12px] text-[var(--text-main)] outline-none";

/** Text input in settings */
export const SINPUT =
  "h-9 w-[240px] rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2.5 text-[12px] text-[var(--text-main)] outline-none focus:border-[var(--accent)]";

/** Tiny icon button revealed on row hover (⋮, +, pin).
 *  Hover paints a solid grey pill instead of a faint translucent wash. */
export const ROW_ICON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:bg-[var(--row-solid-hover)] hover:text-[var(--text-main)]";

/* ---------- Custom overlay scrollbar ----------
   WebView2 draws its own "fluent" scrollbar (arrows, grows while scrolling,
   jumps width). We hide it with .no-native-scrollbar and render our own
   overlay thumb: constant 6px, no arrows, never shifts layout. */

export const MENU_ITEM =
  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]";

/* ---------- Model selector (gateways → submenu flies right) ---------- */
