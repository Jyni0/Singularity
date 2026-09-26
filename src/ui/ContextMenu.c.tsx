/**
 * Right-click menu opened at a pointer position (RowMenu's look, but anchored
 * to a point instead of a trigger button). Clamped to the viewport; closes on
 * outside click, Escape, scroll or resize.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";

export type ContextMenuItem =
  | {
      icon?: React.ReactNode;
      label: string;
      onClick: () => void;
      danger?: boolean;
      disabled?: boolean;
      /** Right-aligned hint, e.g. a shortcut. */
      hint?: string;
    }
  | "separator";

export function ContextMenu({
  at,
  items,
  onClose,
}: {
  /** Client coordinates of the click; null = closed. */
  at: { x: number; y: number } | null;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!at) return;
    const w = ref.current?.offsetWidth ?? 200;
    const h = ref.current?.offsetHeight ?? items.length * 30;
    setPos({
      left: Math.max(8, Math.min(at.x, window.innerWidth - w - 8)),
      top: Math.max(8, at.y + h > window.innerHeight - 8 ? at.y - h : at.y),
    });
  }, [at, items.length]);

  useEffect(() => {
    if (!at) return;
    const close = () => onCloseRef.current();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [at]);

  return createPortal(
    <AnimatePresence>
      {at && (
        <motion.div
          ref={ref}
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          className="z-[600] flex min-w-[200px] flex-col gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-1 shadow-[var(--shadow-popup)]"
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.1, ease: "easeOut" }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {items.map((it, i) =>
            it === "separator" ? (
              <div key={"sep" + i} className="my-0.5 h-px bg-[var(--border-soft,var(--border))]" />
            ) : (
              <button
                key={it.label}
                disabled={it.disabled}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--hover-bg)] disabled:pointer-events-none disabled:opacity-40 ${
                  it.danger ? "text-[var(--diff-del)]" : "text-[var(--text-main)]"
                }`}
                onClick={() => {
                  onClose();
                  it.onClick();
                }}
              >
                <span className="flex w-4 shrink-0 justify-center">{it.icon}</span>
                <span className="flex-1">{it.label}</span>
                {it.hint && <span className="text-[11px] text-[var(--text-dim)]">{it.hint}</span>}
              </button>
            )
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
