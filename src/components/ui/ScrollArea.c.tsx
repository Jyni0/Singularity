import { useEffect, useRef } from "react";
import { useOverlayThumb } from "../../hooks/useOverlayThumb.h";
import { Thumb } from "./Thumb.c";

/** Scroll container with the custom overlay bar (fills its parent box). */
export function ScrollArea({
  children,
  className = "",
  innerClassName = "",
  scrollRef,
}: {
  children: React.ReactNode;
  className?: string;
  innerClassName?: string;
  scrollRef?: React.RefObject<HTMLDivElement>;
}) {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = scrollRef ?? localRef;
  const thumb = useOverlayThumb(ref);

  return (
    <div className={`relative flex min-h-0 flex-col ${className}`}>
      <div ref={ref} className={`no-native-scrollbar min-h-0 flex-1 overflow-y-auto ${innerClassName}`}>
        {children}
      </div>
      <Thumb thumb={thumb} />
    </div>
  );
}

/** Scroll wrapper whose height is driven by its content classes (max-h-*, etc.). */
export function ScrollBox({
  children,
  className = "",
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const thumb = useOverlayThumb(ref);
  return (
    <div className="relative">
      <div ref={ref} className={`no-native-scrollbar overflow-y-auto ${className}`} style={style}>
        {children}
      </div>
      <Thumb thumb={thumb} />
    </div>
  );
}

/**
 * Fully flexible scroll wrapper — YOU own the overflow classes (overflow-auto,
 * overflow-x-auto, min-h-0 flex-1 …). The native bar is hidden and the app's
 * overlay thumb is drawn instead, so every scrollable surface in the app
 * scrolls the same way. wrapperClassName styles the positioned box (use it
 * for flex sizing like "min-h-0 flex-1").
 */
export function OverlayScroll({
  children,
  className = "",
  wrapperClassName = "",
  tabIndex,
  innerRef,
  wheelX = false,
}: {
  children: React.ReactNode;
  className?: string;
  wrapperClassName?: string;
  tabIndex?: number;
  innerRef?: React.RefObject<HTMLDivElement>;
  /** A one-row strip (tabs, breadcrumbs): the plain mouse wheel scrolls it
   *  sideways — without this only Shift+wheel did. */
  wheelX?: boolean;
}) {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = innerRef ?? localRef;
  const thumb = useOverlayThumb(ref);
  useEffect(() => {
    const el = ref.current;
    if (!wheelX || !el) return;
    const onWheel = (e: WheelEvent) => {
      // Trackpads already scroll sideways; only turn vertical wheel motion.
      if (e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const max = el.scrollWidth - el.clientWidth;
      const next = Math.max(0, Math.min(max, el.scrollLeft + step));
      if (next === el.scrollLeft) return;
      e.preventDefault();
      el.scrollLeft = next;
    };
    // Non-passive: preventDefault keeps the page behind from scrolling too.
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref, wheelX]);
  return (
    <div className={"relative " + wrapperClassName}>
      <div ref={ref} tabIndex={tabIndex} className={"no-native-scrollbar outline-none " + className}>
        {children}
      </div>
      <Thumb thumb={thumb} />
    </div>
  );
}

/* ---------- Types (domain types live in ./types) ---------- */
