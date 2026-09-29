import { cx } from "../cx.u";

/** One settings line: title + hint on the left, the control on the right. */
export function SettingRow({
  title,
  hint,
  children,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-4 py-0.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-[var(--text-main)]">{title}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-snug text-[var(--text-dim)]">{hint}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center">{children}</div>}
    </div>
  );
}

/** A group of settings rows (or any panel content) on a card. */
export function SettingsCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("flex min-w-0 flex-col gap-3 rounded-2xl border border-[var(--border-soft)] bg-[var(--bg-surface)] px-4 py-3", className)}>
      {children}
    </div>
  );
}

/** Hairline between rows of a card. */
export function Sep() {
  return <div className="h-px bg-[var(--border-soft)]" />;
}

/** Small uppercase heading over a group of cards. */
export function SectionHeading({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-dim)]", className)}>{children}</div>
  );
}
