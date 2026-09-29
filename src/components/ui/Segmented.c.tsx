import { cx } from "../cx.u";
import { CONTROL_FILL, CONTROL_RADIUS, type ControlSize } from "../tokens.s";

export type SegmentOption<T extends string> = T | { value: T; label: React.ReactNode; title?: string };

const HEIGHT: Record<ControlSize, string> = { xs: "h-6", sm: "h-7", md: "h-9" };
/** Inner radius = outer radius minus the 3px inset, so the corners stay concentric. */
const INNER: Record<ControlSize, string> = { xs: "rounded-[5px]", sm: "rounded-[5px]", md: "rounded-[9px]" };

/** One-of-N switch ("Local | Remote", "Never ask | Default | Always ask"). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  fill = false,
  className,
}: {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (v: T) => void;
  size?: ControlSize;
  /** Stretch to the full width, options sharing it equally. */
  fill?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cx("flex items-center gap-0.5 p-[3px]", CONTROL_FILL, CONTROL_RADIUS[size], HEIGHT[size], fill && "w-full", className)}
      role="radiogroup"
    >
      {options.map((o) => {
        const opt = typeof o === "string" ? { value: o, label: o as React.ReactNode, title: undefined } : o;
        const on = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={opt.title}
            className={cx(
              "flex h-full items-center justify-center gap-1.5 whitespace-nowrap px-3 text-[12px] transition-colors",
              INNER[size],
              fill && "flex-1",
              on ? "bg-[var(--bg-elevated)] text-[var(--text-main)] shadow-sm" : "text-[var(--text-muted)] hover:text-[var(--text-main)]",
            )}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
