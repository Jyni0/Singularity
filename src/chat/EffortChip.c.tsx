import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronDown, Check, Gauge } from "lucide-react";
import { Effort, EFFORTS } from "../core/types.i";
import { CHIP_CTX } from "../ui/tokens.s";

export const EFFORT_INFO: Record<Effort, { label: string; hint: string }> = {
  low: { label: "Fast", hint: "Low effort — quick answers, minimal reasoning" },
  medium: { label: "Balanced", hint: "Medium effort — default balance of speed and depth" },
  high: { label: "Think", hint: "High effort — deeper reasoning, slower" },
};

/** Dropdown chip that picks the reasoning effort. */
export function EffortChip({ effort, onPick }: { effort: Effort; onPick: (e: Effort) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Close on outside click, matching the other dropdowns.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const info = EFFORT_INFO[effort];

  return (
    <div className="relative shrink-0" ref={ref}>
      <span
        className={CHIP_CTX}
        onClick={() => setOpen(!open)}
        title="Reasoning effort"
      >
        <Gauge size={12} strokeWidth={1.5} />
        {info.label}
        <ChevronDown size={12} />
      </span>

      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute bottom-full left-0 z-50 mb-1.5 w-[210px] rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-1.5 shadow-[0_12px_28px_-10px_rgba(0,0,0,0.55)]"
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
          >
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--text-dim)]">
              Reasoning effort
            </div>
            {EFFORTS.map((lvl) => (
              <button
                key={lvl}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors ${
                  effort === lvl
                    ? "bg-[var(--hover-bg)] text-[var(--text-main)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                }`}
                onClick={() => {
                  onPick(lvl);
                  setOpen(false);
                }}
              >
                {effort === lvl ? <Check size={13} /> : <span className="w-[13px]" />}
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{EFFORT_INFO[lvl].label}</span>
                  <span className="block truncate text-[10px] text-[var(--text-dim)]">
                    {EFFORT_INFO[lvl].hint}
                  </span>
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- Prompt box ---------- */
