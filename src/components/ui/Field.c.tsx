import { cx } from "../cx.u";
import { FIELD_LABEL } from "../tokens.s";

/** A labelled form field: label on top, control, optional hint below. */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cx("flex min-w-0 flex-col", className)}>
      <span className={FIELD_LABEL}>{label}</span>
      {children}
      {hint && <span className="mt-1 text-[11px] leading-snug text-[var(--text-dim)]">{hint}</span>}
    </label>
  );
}
