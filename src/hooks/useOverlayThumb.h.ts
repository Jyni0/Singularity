import { useState, useEffect } from "react";

export type ThumbState = { top: number; height: number; visible: boolean };

export function useOverlayThumb(elRef: React.RefObject<HTMLElement | null>) {
  const [thumb, setThumb] = useState<ThumbState>({ top: 0, height: 0, visible: false });

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    let timer: number | undefined;
    let hovering = false;

    const update = (active = false) => {
      const { scrollHeight, clientHeight, scrollTop } = el;
      const ratio = clientHeight / Math.max(scrollHeight, 1);
      const needBar = scrollHeight > clientHeight + 1;
      const height = Math.max(ratio * clientHeight, 28);
      const maxTop = clientHeight - height;
      const top = ratio >= 1 ? 0 : (scrollTop / (scrollHeight - clientHeight)) * maxTop;
      setThumb({ top, height, visible: needBar && (active || hovering) });
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
