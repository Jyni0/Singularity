/* ---------- Reasoning effort ---------- */
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Check } from "lucide-react";
import { Effort, ProviderKind, effortsFor } from "../core/types.i";
import { LIP_CHIP, POPOVER, POPOVER_LABEL, popoverItem, popMotion } from "../components";

const EFFORT_LABEL: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "xHigh",
  max: "Max",
  ultra: "Ultra",
  ultracode: "Ultracode",
};

/** OpenAI (Codex) names its levels its own way. */
const OPENAI_LABEL: Partial<Record<Effort, string>> = { low: "Light", xhigh: "Extra High" };

/** Label of a level for this provider — Anthropic calls xhigh "Extra". */
export function effortLabel(level: Effort, kind?: ProviderKind): string {
  if (kind === "openai-cli" && OPENAI_LABEL[level]) return OPENAI_LABEL[level]!;
  if (level === "xhigh" && kind === "anthropic-cli") return "Extra";
  return EFFORT_LABEL[level];
}

/**
 * The effort section of the model menu: just the levels the selected
 * provider and model accept, one short row each.
 */
export function EffortMenu({
  current,
  kind,
  meta,
  onPick,
}: {
  /** The pick as it applies to this model (already clamped). */
  current: Effort;
  kind?: ProviderKind;
  /** The selected model's meta — narrows the levels to what the model has. */
  meta?: string;
  onPick: (e: Effort) => void;
}) {
  return (
    <>
      <div className={POPOVER_LABEL}>Effort</div>
      {effortsFor(kind, meta).map((lvl) => (
        <button key={lvl} className={popoverItem(current === lvl)} onClick={() => onPick(lvl)}>
          <span className="min-w-0 flex-1">{effortLabel(lvl, kind)}</span>
          {current === lvl && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
        </button>
      ))}
    </>
  );
}

/** Lip chip with its own dropdown: "High ⌄" → the levels, nothing else. */
export function EffortChip({
  effort,
  kind,
  meta,
  onPick,
}: {
  /** The pick as it applies to this model (already clamped). */
  effort: Effort;
  kind?: ProviderKind;
  meta?: string;
  onPick: (e: Effort) => void;
}) {
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

  return (
    <div className="relative shrink-0" ref={ref}>
      <span className={`${LIP_CHIP} ${open ? "bg-[var(--hover-bg)] text-[var(--text-main)]" : ""}`} onClick={() => setOpen(!open)} title="Reasoning effort">
        {effortLabel(effort, kind)}
      </span>
      <AnimatePresence>
        {open && (
          <motion.div className={`${POPOVER} absolute bottom-[calc(100%+8px)] right-0 w-[150px] gap-0.5`} {...popMotion(true)}>
            <EffortMenu
              current={effort}
              kind={kind}
              meta={meta}
              onPick={(e) => {
                onPick(e);
                setOpen(false);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
