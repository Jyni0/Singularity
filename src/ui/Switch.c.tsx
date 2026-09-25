/**
 * Switch — the app's ONLY toggle. Copied verbatim from the Agent-mode
 * SettingsModal (h-5 w-9 track, knob anchored left so it never overflows,
 * translate-x-[16px]); every boolean setting in both modes uses this one
 * component instead of its own inline copy.
 */
export function Switch({
  on,
  onChange,
  ariaLabel = "toggle",
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-[var(--accent)]" : "bg-[var(--bg-elevated)]"
      }`}
      onClick={() => onChange(!on)}
    >
      {/* The knob is anchored left so it never overflows the track. */}
      <span
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          on ? "translate-x-[16px]" : "translate-x-0"
        }`}
      />
    </button>
  );
}
