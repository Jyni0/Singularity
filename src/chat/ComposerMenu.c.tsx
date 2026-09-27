/* ---------- The prompt box's `/` and `@` menu ---------- */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { LoaderCircle } from "lucide-react";
import { POPOVER, POPOVER_LABEL, popoverItem, popMotion } from "../ui/tokens.s";
import { ScrollBox } from "../ui/ScrollArea.c";

export interface ComposerItem {
  id: string;
  /** Group heading shown above the first item of each group. */
  group: string;
  icon: React.ReactNode;
  /** Main text (`/plan`, `App.tsx`). */
  label: string;
  /** Dim text after the label (a folder, a short description). */
  detail?: string;
  /** Right-aligned hint, e.g. "action" or a badge. */
  badge?: string;
  mono?: boolean;
}

/**
 * Keyboard-driven list above the prompt. The textarea keeps focus: it owns
 * ↑/↓/Enter/Tab/Esc while the menu is open and tells this component which
 * row is active.
 */
export function ComposerMenu({
  title,
  items,
  active,
  loading,
  empty,
  onPick,
  onHover,
}: {
  title: string;
  items: ComposerItem[];
  active: number;
  loading?: boolean;
  empty: string;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  /** The list never grows past the space above the prompt box. */
  const [maxH, setMaxH] = useState(300);
  useLayoutEffect(() => {
    const fit = () => {
      const anchor = boxRef.current?.parentElement?.getBoundingClientRect();
      // 8px gap + header + footer + window margin ≈ 90px.
      if (anchor) setMaxH(Math.max(96, Math.min(300, anchor.top - 90)));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const grouped = new Set(items.map((it) => it.group)).size > 1;

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <motion.div
      ref={boxRef}
      className={`${POPOVER} absolute bottom-[calc(100%+8px)] left-0 right-0`}
      {...popMotion(true)}
      // Clicks must not blur the textarea (the caret decides what is typed).
      onMouseDown={(e) => e.preventDefault()}
    >
      {/* Grouped lists (commands) label each group instead of the whole list. */}
      {!grouped && (
        <div className={POPOVER_LABEL}>
          <span className="truncate">{title}</span>
          {loading && <LoaderCircle size={11} className="shrink-0 animate-spin" />}
        </div>
      )}
      <div ref={listRef}>
        <ScrollBox className="flex flex-col gap-0.5" style={{ maxHeight: maxH }}>
          {items.length === 0 && (
            <div className="px-2 py-2 text-[12px] text-[var(--text-dim)]">{loading ? "Loading…" : empty}</div>
          )}
          {items.map((it, i) => (
            <div key={it.id} className="flex flex-col">
              {grouped && (i === 0 || items[i - 1].group !== it.group) && (
                <div className={`${POPOVER_LABEL} ${i > 0 ? "mt-1.5" : ""}`}>{it.group}</div>
              )}
              <button
                data-idx={i}
                className={popoverItem(i === active)}
                onMouseMove={() => i !== active && onHover(i)}
                onClick={() => onPick(i)}
              >
                <span className="flex w-4 shrink-0 justify-center text-[var(--text-dim)]">{it.icon}</span>
                <span className={`shrink-0 truncate text-[var(--text-main)] ${it.mono ? "font-mono text-[12px]" : ""}`}>
                  {it.label}
                </span>
                {it.detail && <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-dim)]">{it.detail}</span>}
                {!it.detail && <span className="flex-1" />}
                {it.badge && (
                  <span className="shrink-0 rounded border border-[var(--border)] px-1.5 text-[10px] text-[var(--text-dim)]">
                    {it.badge}
                  </span>
                )}
              </button>
            </div>
          ))}
        </ScrollBox>
      </div>
      <div className="mt-1 flex gap-3 border-t border-[var(--border-soft)] px-2 pt-1.5 text-[10.5px] text-[var(--text-dim)]">
        <span>↑↓ move</span>
        <span>Enter / Tab pick</span>
        <span>Esc close</span>
      </div>
    </motion.div>
  );
}
