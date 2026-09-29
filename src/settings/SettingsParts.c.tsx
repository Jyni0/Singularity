

export function Segmented({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex h-9 items-center gap-0.5 rounded-md bg-[var(--bg-input)] p-0.5">
      {options.map((o) => (
        <button
          key={o}
          className={`h-full whitespace-nowrap rounded px-2.5 text-[12px] transition-colors ${
            value === o
              ? "bg-[var(--bg-elevated)] text-[var(--text-main)]"
              : "text-[var(--text-muted)] hover:text-[var(--text-main)]"
          }`}
          onClick={() => onChange(o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

export function SettingRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
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

export function SettingsCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-[var(--border-soft)] bg-[var(--bg-surface)] px-4 py-3">
      {children}
    </div>
  );
}

export function Sep() {
  return <div className="h-px bg-[var(--border-soft)]" />;
}
