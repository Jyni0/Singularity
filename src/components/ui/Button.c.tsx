import { forwardRef } from "react";
import { cx } from "../cx.u";
import { BUTTON_BASE, BUTTON_VARIANT, CONTROL_SIZE, type ButtonVariant, type ControlSize } from "../tokens.s";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ControlSize;
  /** Icon before the label. */
  icon?: React.ReactNode;
};

/** The app's button: one geometry per size, one look per variant. */
export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "secondary", size = "md", icon, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cx(BUTTON_BASE, CONTROL_SIZE[size], BUTTON_VARIANT[variant], className)} {...rest}>
      {icon}
      {children}
    </button>
  );
});
