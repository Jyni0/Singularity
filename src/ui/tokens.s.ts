

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

/** Chip in the prompt lip (model, effort): small and quiet. */
export const LIP_CHIP =
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";

/** Context chip: h 24px, padding 0 8px, 11px */
export const CHIP_CTX =
  "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px] text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";

/* Settings controls share ONE geometry: h-9 (36px) tall, 240px wide in the
   right-hand control column — selects (Combobox), inputs and buttons all
   line up. */

/** Small theme-aware button (settings / panels) */
export const SBUTTON =
  "flex h-9 shrink-0 items-center justify-center rounded-md bg-[var(--bg-elevated)] px-3 text-[12px] text-[var(--text-main)] transition-colors hover:bg-[var(--bg-input)] disabled:cursor-not-allowed disabled:opacity-50";

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

/* ---------- Prompt-box dropdowns ----------
   Model, project, effort, temperature, /commands and @files all share ONE
   look: the theme's surface colour, its border and popup shadow, the same
   radius, header and option rows. */

/** Dropdown panel. Position it with extra classes (bottom-full / top-full…). */
export const POPOVER =
  "z-[200] flex flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-1.5 shadow-[var(--shadow-popup)]";

/** Small uppercase heading inside a dropdown. */
export const POPOVER_LABEL =
  "flex items-center justify-between px-2 pb-1 pt-0.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--text-dim)]";

/** One option row; `active` = selected or keyboard-highlighted. */
export const popoverItem = (active: boolean) =>
  "flex min-h-8 w-full shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors " +
  (active
    ? "bg-[var(--hover-bg)] text-[var(--text-main)]"
    : "text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]");

/** Open/close animation shared by the dropdowns (`up` = opens above its chip). */
export const popMotion = (up = true) => ({
  initial: { opacity: 0, y: up ? 6 : -6, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: up ? 6 : -6, scale: 0.98 },
  transition: { duration: 0.13, ease: "easeOut" as const },
});

export const MENU_ITEM =
  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]";

/* ---------- Model selector (gateways → submenu flies right) ---------- */
