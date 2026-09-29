import { cx } from "./cx.u";

/* ==========================================================================
   Design tokens — the ONE place sizes, radii and control styles live.

   Scale
   - Control height: xs 24px (h-6) · sm 28px (h-7) · md 36px (h-9)
   - Radius follows the prompt box (the reference look): controls rounded-lg
     (xs/sm) · rounded-xl (md) · cards rounded-xl/2xl · menus / popovers
     rounded-2xl · dialogs rounded-3xl · round buttons and pills rounded-full
   - Fill: every control (button, input, select, segmented) sits on ONE
     surface, --bg-input, a step off the card behind it; hover and the
     selected segment go one step further, --bg-elevated.
   - Text: controls 12px · labels 11px · body 13px

   Components (components/ui) build on these strings; reach for a component
   first and use a token only where a component does not fit.
   ========================================================================== */

export type ControlSize = "xs" | "sm" | "md";

/** Corner radius of a control per size — bigger controls, rounder corners. */
export const CONTROL_RADIUS: Record<ControlSize, string> = {
  xs: "rounded-lg",
  sm: "rounded-lg",
  md: "rounded-xl",
};

/** The one fill every control shares, and its hover. */
export const CONTROL_FILL = "bg-[var(--bg-input)]";
export const CONTROL_FILL_HOVER = "hover:bg-[var(--bg-elevated)]";

/** Height + padding + text + radius of a control per size. */
export const CONTROL_SIZE: Record<ControlSize, string> = {
  xs: "h-6 px-2.5 text-[11.5px] gap-1 rounded-lg",
  sm: "h-7 px-3 text-[12px] gap-1.5 rounded-lg",
  md: "h-9 px-3.5 text-[12px] gap-1.5 rounded-xl",
};

/** Square icon-only control per size. */
export const ICON_SIZE: Record<ControlSize, string> = {
  xs: "h-6 w-6 rounded-lg",
  sm: "h-7 w-7 rounded-lg",
  md: "h-9 w-9 rounded-xl",
};

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";

export const BUTTON_BASE =
  "inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50";

export const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-[var(--accent)] font-medium text-white hover:bg-[var(--accent-hover)]",
  secondary: `${CONTROL_FILL} text-[var(--text-main)] ${CONTROL_FILL_HOVER}`,
  ghost: "text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]",
  danger: "bg-[var(--diff-del)] font-medium text-white hover:opacity-90",
  "danger-ghost": "text-[var(--diff-del)] hover:bg-[var(--diff-del)]/10",
};

/** Class string of a button — for the rare element that cannot be <Button>. */
export const button = (variant: ButtonVariant = "secondary", size: ControlSize = "md") =>
  `${BUTTON_BASE} ${CONTROL_SIZE[size]} ${BUTTON_VARIANT[variant]}`;

/** Icon-only button (toolbar / row actions). */
export const iconButton = (size: ControlSize = "sm", variant: "ghost" | "secondary" = "ghost") =>
  `inline-flex shrink-0 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${ICON_SIZE[size]} ${
    variant === "ghost"
      ? "text-[var(--text-dim)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
      : `${CONTROL_FILL} text-[var(--text-main)] ${CONTROL_FILL_HOVER}`
  }`;

/** Text field surface (input, textarea, closed select) without size.
 *  Same fill as buttons; the border only appears on hover / focus. */
export const FIELD_BASE =
  `w-full border border-transparent ${CONTROL_FILL} text-[var(--text-main)] outline-none transition-colors placeholder:text-[var(--text-dim)] hover:border-[var(--border)] focus:border-[var(--accent)] disabled:opacity-50`;

export const INPUT_SIZE: Record<ControlSize, string> = {
  xs: "h-6 px-2.5 text-[11.5px] rounded-lg",
  sm: "h-7 px-2.5 text-[12px] rounded-lg",
  md: "h-9 px-3 text-[12px] rounded-xl",
};

export const input = (size: ControlSize = "md") => `${FIELD_BASE} ${INPUT_SIZE[size]}`;

export const TEXTAREA = `${FIELD_BASE} resize-y rounded-xl px-3 py-2.5 text-[12px] leading-relaxed`;

/** Label above a form field. */
export const FIELD_LABEL = "mb-1.5 block text-[11px] font-medium text-[var(--text-muted)]";

/** Small uppercase heading over a group of cards / rows. */
export const SECTION_HEADING = "px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]";

/** Width of the right-hand control column in settings rows. */
export const CONTROL_W = "w-[240px]";

/* ---------- Layout rows (sidebar, titlebar, menus) ---------- */

/** Sidebar / titlebar row: h 32px, padding 0 8px, radius 12px, gap 10px — prefer <NavItem> */
export const ROW = "flex h-8 shrink-0 items-center gap-2.5 rounded-xl px-2 text-left text-[13px]";

/** Hover: text brightens only (no background) */
export const ROW_TEXT = "text-[var(--text-muted)] transition-colors hover:text-[var(--text-main)]";

/** Hover + active: background highlight (used by nav / settings) */
export const ROW_HOVER =
  "text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";

/** Active row: background highlight only (no other changes) */
export const ROW_ACTIVE = "bg-[var(--hover-bg)]";

/** Chip in prompt box: h 28px, padding 0 10px, radius 6px, 12px */
export const CHIP =
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";

/** Chip in the prompt lip (model, effort): small and quiet. */
export const LIP_CHIP =
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";

/** Context chip: h 24px, padding 0 8px, 11px */
export const CHIP_CTX =
  "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[11px] text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]";

/* Settings controls share ONE geometry: h-9 (36px) tall, 240px wide in the
   right-hand control column — selects (Combobox), inputs and buttons all
   line up. */

/** Settings button / input — kept for existing call sites; prefer <Button> / <Input>. */
export const SBUTTON = button("secondary", "md");
export const SINPUT = cx(input("md"), CONTROL_W);

/** Tiny icon button revealed on row hover (⋮, +, pin).
 *  Hover paints a solid grey pill instead of a faint translucent wash. */
export const ROW_ICON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--row-solid-hover)] hover:text-[var(--text-main)]";

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
  "z-[200] flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-1.5 shadow-[var(--shadow-popup)]";

/** Small uppercase heading inside a dropdown. */
export const POPOVER_LABEL =
  "flex items-center justify-between px-2 pb-1 pt-0.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--text-dim)]";

/** One option row; `active` = selected or keyboard-highlighted. */
export const popoverItem = (active: boolean) =>
  "flex min-h-8 w-full shrink-0 items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[12.5px] transition-colors " +
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
  "flex h-8 w-full items-center gap-2 rounded-xl px-2 text-left text-[13px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]";

/* ---------- Model selector (gateways → submenu flies right) ---------- */
