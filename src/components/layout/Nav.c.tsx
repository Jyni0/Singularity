import { forwardRef } from "react";
import { cx } from "../cx.u";
import { ROW, ROW_ACTIVE, ROW_HOVER, ROW_TEXT } from "../tokens.s";

type NavItemProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** The page / item on screen: highlighted. */
  active?: boolean;
  /** Hovered or its menu is open: solid highlight, so the row actions read on it. */
  hovered?: boolean;
  /** Text-only hover, no background (folder rows). */
  quiet?: boolean;
  /** Icon before the label. */
  icon?: React.ReactNode;
};

/** A sidebar row: navigation (History, Settings), chats, servers, keys. */
export const NavItem = forwardRef<HTMLButtonElement, NavItemProps>(function NavItem(
  { active = false, hovered = false, quiet = false, icon, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        ROW,
        "w-full",
        active
          ? ROW_ACTIVE
          : hovered
            ? "bg-[var(--row-solid-hover)] text-[var(--text-main)]"
            : quiet
              ? ROW_TEXT
              : ROW_HOVER,
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});

/**
 * Hover actions over the right end of a NavItem (pin, ⋯, close). Spans the
 * row's full height and shares its right corners, so the fade never cuts a
 * square notch into the rounded row.
 */
export function RowActions({
  show,
  fade = true,
  className,
  children,
}: {
  show: boolean;
  /** Fade the row's text out under the buttons (off: buttons carry their own fill). */
  fade?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cx(
        "absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r-xl pr-1 transition-opacity duration-100",
        fade && "bg-gradient-to-l from-[var(--row-solid-gradient)] via-[var(--row-solid-gradient)] to-transparent pl-5",
        show ? "opacity-100" : "pointer-events-none opacity-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
