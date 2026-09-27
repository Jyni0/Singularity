/* ---------- Reasoning effort chip ---------- */
import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronDown, Check, Gauge, Rabbit, Scale, Brain } from "lucide-react";
import { Effort, EFFORTS } from "../core/types.i";
import { CHIP, POPOVER, POPOVER_LABEL, popoverItem, popMotion } from "../ui/tokens.s";

export const EFFORT_INFO: Record<Effort, { label: string; hint: string; icon: typeof Gauge }> = {
  low: { label: "Fast", hint: "Quick answers, minimal reasoning", icon: Rabbit },
  medium: { label: "Balanced", hint: "Default balance of speed and depth", icon: Scale },
  high: { label: "Think", hint: "Deeper reasoning, slower", icon: Brain },
};

/** Dropdown chip that picks the reasoning effort. */
export function EffortChip({ effort, onPick }: { effort: Effort; onPick: (e: Effort) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Close on outside click / Escape, matching the other dropdowns.
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
  const info = EFFORT_INFO[effort];

  return (
    <div className="relative shrink-0" ref={ref}>
      <span
        className={`${CHIP} ${open ? "bg-[var(--hover-bg)] text-[var(--text-main)]" : ""}`}
        onClick={() => setOpen(!open)}
        title="Reasoning effort"
      >
        <Gauge size={12} strokeWidth={1.5} />
        {info.label}
        <ChevronDown size={12} />
      </span>

      <AnimatePresence>
        {open && (
          <motion.div className={`${POPOVER} absolute bottom-[calc(100%+8px)] left-0 w-[240px] gap-0.5`} {...popMotion(true)}>
            <div className={POPOVER_LABEL}>Reasoning effort</div>
            {EFFORTS.map((lvl) => {
              const Icon = EFFORT_INFO[lvl].icon;
              return (
                <button
                  key={lvl}
                  className={popoverItem(effort === lvl)}
                  onClick={() => {
                    onPick(lvl);
                    setOpen(false);
                  }}
                >
                  <Icon size={13} strokeWidth={1.6} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{EFFORT_INFO[lvl].label}</span>
                    <span className="block truncate text-[10.5px] text-[var(--text-dim)]">{EFFORT_INFO[lvl].hint}</span>
                  </span>
                  {effort === lvl && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
