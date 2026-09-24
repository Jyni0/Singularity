import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";

export function RowMenu({
  open,
  anchor,
  items,
  onClose,
}: {
  open: boolean;
  /** The element the menu should be anchored to (its trigger button). */
  anchor: React.RefObject<HTMLElement | null>;
  items: Array<{ icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, flipped: false });
  // Keep callbacks/refs out of the effect deps so positioning never loops.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const itemCount = items.length;

  /**
   * Positioned with `position: fixed` against the trigger's viewport rect and
   * re-measured on scroll/resize — so it is never clipped by the sidebar's
   * overflow and never drifts out of view when the list is scrolled.
   */
  useEffect(() => {
    if (!open) return;

    const place = () => {
      const el = anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const menuH = ref.current?.offsetHeight ?? itemCount * 32 + 12;
      const menuW = ref.current?.offsetWidth ?? 200;
      const gap = 6;
      const below = r.bottom + gap;
      const fitBelow = below + menuH <= window.innerHeight - 8;
      const top = fitBelow ? below : Math.max(8, r.top - gap - menuH);
      const left = Math.min(Math.max(8, r.right - menuW), window.innerWidth - menuW - 8);
      setPos((p) =>
        p.top === top && p.left === left && p.flipped === !fitBelow
          ? p // bail out: identical position must not trigger a re-render
          : { top, left, flipped: !fitBelow }
      );
    };

    place();
    const raf = requestAnimationFrame(place); // second pass with real size

    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseRef.current();

    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    // capture:true also catches scrolling inside nested scroll containers
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchor, itemCount]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          className="z-[600] flex min-w-[200px] flex-col gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-1 shadow-[var(--shadow-popup)]"
          initial={{ opacity: 0, y: pos.flipped ? 4 : -4, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: pos.flipped ? 4 : -4, scale: 0.97 }}
          transition={{ duration: 0.12, ease: "easeOut" }}
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((it) => (
            <button
              key={it.label}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-[var(--hover-bg)] ${
                it.danger ? "text-[var(--diff-del)]" : "text-[var(--text-main)]"
              }`}
              onClick={() => {
                it.onClick();
                onClose();
              }}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

/* ---------- Sidebar ---------- */
