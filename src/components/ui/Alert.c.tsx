import { cx } from "../cx.u";

export type AlertTone = "error" | "warning" | "info" | "success";

const TONE: Record<AlertTone, string> = {
  error: "border-[var(--diff-del)]/40 bg-[var(--diff-del)]/10 text-[var(--diff-del)]",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-500",
  info: "border-[var(--border)] bg-[var(--bg-input)] text-[var(--text-muted)]",
  success: "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--text-main)]",
};

/** Inline message box (errors, warnings, notes). */
export function Alert({
  tone = "error",
  icon,
  className,
  children,
}: {
  tone?: AlertTone;
  icon?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cx("flex items-start gap-2 rounded-xl border px-3 py-2 text-[12px] leading-snug", TONE[tone], className)}
    >
      {icon && <span className="mt-px shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}
