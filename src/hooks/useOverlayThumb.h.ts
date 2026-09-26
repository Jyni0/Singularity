import { useState, useEffect } from "react";

export type ThumbState = {
  /** Vertical thumb (right edge). */
  top: number;
  height: number;
  visible: boolean;
  /** Horizontal thumb (bottom edge) — for overflow-x surfaces. */
  left: number;
  width: number;
  hVisible: boolean;
};

const EMPTY: ThumbState = { top: 0, height: 0, visible: false, left: 0, width: 0, hVisible: false };

export function useOverlayThumb(elRef: React.RefObject<HTMLElement | null>) {
  const [thumb, setThumb] = useState<ThumbState>(EMPTY);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    let timer: number | undefined;
    let hovering = false;

    const update = (active = false) => {
      const { scrollHeight, clientHeight, scrollTop, scrollWidth, clientWidth, scrollLeft } = el;
      const show = active || hovering;
      // Vertical
      const ratio = clientHeight / Math.max(scrollHeight, 1);
      const needBar = scrollHeight > clientHeight + 1;
      const height = Math.max(ratio * clientHeight, 28);
      const maxTop = clientHeight - height;
      const top = ratio >= 1 ? 0 : (scrollTop / (scrollHeight - clientHeight)) * maxTop;
      // Horizontal
      const hRatio = clientWidth / Math.max(scrollWidth, 1);
      const needHBar = scrollWidth > clientWidth + 1;
      const width = Math.max(hRatio * clientWidth, 28);
      const maxLeft = clientWidth - width;
      const left = hRatio >= 1 ? 0 : (scrollLeft / (scrollWidth - clientWidth)) * maxLeft;
      setThumb({
        top,
        height,
        visible: needBar && show,
        left,
        width,
        hVisible: needHBar && show,
      });
    };

    const onScroll = () => {
      update(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => update(hovering), 800);
    };
    const onEnter = () => {
      hovering = true;
      update(false);
    };
    const onLeave = () => {
      hovering = false;
      update(false);
    };
    const onResize = () => update(false);

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("mouseleave", onLeave);
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    update(false);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("mouseenter", onEnter);
      el.removeEventListener("mouseleave", onLeave);
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [elRef]);

  return thumb;
}
