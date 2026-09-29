import { forwardRef } from "react";
import { cx } from "../cx.u";
import { FIELD_BASE, INPUT_SIZE, TEXTAREA, type ControlSize } from "../tokens.s";

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & {
  size?: ControlSize;
  /** Monospace text (paths, URLs, keys, commands). */
  mono?: boolean;
};

/** Single-line text field. Full width by default; pass a width class to change it. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = "md", mono, className, spellCheck = false, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      spellCheck={spellCheck}
      className={cx(FIELD_BASE, INPUT_SIZE[size], mono && "font-mono", className)}
      {...rest}
    />
  );
});

type AreaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean };

/** Multi-line text field. */
export const TextArea = forwardRef<HTMLTextAreaElement, AreaProps>(function TextArea(
  { mono, className, spellCheck = false, ...rest },
  ref,
) {
  return <textarea ref={ref} spellCheck={spellCheck} className={cx(TEXTAREA, mono && "font-mono", className)} {...rest} />;
});
