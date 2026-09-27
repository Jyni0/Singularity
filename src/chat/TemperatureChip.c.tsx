/* ---------- Temperature chip ---------- */
import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronDown, Check, Thermometer } from "lucide-react";
import { CHIP, POPOVER, POPOVER_LABEL, popoverItem, popMotion } from "../ui/tokens.s";

/** Quick presets; "Auto" leaves the provider's default in place. */
const PRESETS: { label: string; value: number | null; hint: string }[] = [
  { label: "Auto", value: null, hint: "Provider default" },
  { label: "Precise", value: 0.2, hint: "Deterministic, focused edits" },
  { label: "Balanced", value: 0.7, hint: "Some variety" },
  { label: "Creative", value: 1.1, hint: "More varied wording" },
];

/** Dropdown chip that picks the sampling temperature (0–2 or Auto). */
export function TemperatureChip({
  value,
  onPick,
}: {
  value: number | null;
  onPick: (t: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const slider = value ?? 0.7;

  return (
    <div className="relative shrink-0" ref={ref}>
      <span
        className={`${CHIP} ${open ? "bg-[var(--hover-bg)] text-[var(--text-main)]" : ""}`}
        onClick={() => setOpen(!open)}
        title="Temperature"
      >
        <Thermometer size={12} strokeWidth={1.5} />
        {value === null ? "Auto" : value.toFixed(1)}
        <ChevronDown size={12} />
      </span>
      <AnimatePresence>
        {open && (
          <motion.div className={`${POPOVER} absolute bottom-[calc(100%+8px)] left-0 w-[240px] gap-0.5`} {...popMotion(true)}>
            <div className={POPOVER_LABEL}>
              <span>Temperature</span>
              <span className="font-mono normal-case tracking-normal text-[var(--text-muted)]">
                {value === null ? "auto" : value.toFixed(2)}
              </span>
            </div>
            <div className="px-2 pb-2 pt-1.5">
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={slider}
                onChange={(e) => onPick(Number(e.target.value))}
                className="range-theme"
                style={{ "--fill": `${(slider / 2) * 100}%` } as React.CSSProperties}
                aria-label="Temperature"
              />
              <div className="mt-1 flex justify-between font-mono text-[9.5px] text-[var(--text-dim)]">
                <span>0</span>
                <span>1</span>
                <span>2</span>
              </div>
            </div>
            <div className="mx-1 mb-1 h-px bg-[var(--border-soft)]" />
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className={popoverItem(value === p.value)}
                onClick={() => {
                  onPick(p.value);
                  setOpen(false);
                }}
              >
                <span className="w-9 shrink-0 font-mono text-[11px] text-[var(--text-dim)]">
                  {p.value === null ? "—" : p.value.toFixed(1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{p.label}</span>
                  <span className="block truncate text-[10.5px] text-[var(--text-dim)]">{p.hint}</span>
                </span>
                {value === p.value && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
