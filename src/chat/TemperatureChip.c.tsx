import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronDown, Thermometer } from "lucide-react";
import { CHIP_CTX } from "../ui/tokens.s";

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
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <span className={CHIP_CTX} onClick={() => setOpen(!open)} title="Temperature">
        <Thermometer size={12} strokeWidth={1.5} />
        {value === null ? "Auto" : value.toFixed(1)}
        <ChevronDown size={12} />
      </span>
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute bottom-full left-0 z-50 mb-1.5 w-[220px] rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-2 shadow-[0_12px_28px_-10px_rgba(0,0,0,0.55)]"
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
          >
            <div className="flex items-center justify-between px-1 pb-1.5 text-[10px] uppercase tracking-wide text-[var(--text-dim)]">
              <span>Temperature</span>
              <span className="font-mono normal-case">{value === null ? "auto" : value.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={value ?? 0.7}
              onChange={(e) => onPick(Number(e.target.value))}
              className="w-full accent-[var(--accent)]"
            />
            <div className="mt-1.5 grid grid-cols-2 gap-1">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  className={`rounded-lg px-2 py-1 text-left text-[11.5px] transition-colors ${
                    value === p.value
                      ? "bg-[var(--hover-bg)] text-[var(--text-main)]"
                      : "text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                  }`}
                  onClick={() => {
                    onPick(p.value);
                    setOpen(false);
                  }}
                  title={p.hint}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
