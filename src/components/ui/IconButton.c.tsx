import { forwardRef } from "react";
import { cx } from "../cx.u";
import { iconButton, type ControlSize } from "../tokens.s";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: ControlSize;
  variant?: "ghost" | "secondary";
  /** "danger": turns red on hover (delete / remove actions). */
  tone?: "default" | "danger";
  /** Hidden until the surrounding `group` row is hovered. */
  reveal?: boolean;
  /** Tooltip + accessible name — an icon alone says nothing. */
  label: string;
};

/** Square icon-only button (toolbars, row actions, close ×). */
export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  { size = "sm", variant = "ghost", tone = "default", reveal = false, label, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      title={label}
      aria-label={label}
      className={cx(
        iconButton(size, variant),
        tone === "danger" && "hover:bg-[var(--diff-del)]/15 hover:text-[var(--diff-del)]",
        reveal && "opacity-0 transition-all focus-visible:opacity-100 group-hover:opacity-100",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
