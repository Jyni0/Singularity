import { useRef } from "react";
import { useOverlayThumb } from "../hooks/useOverlayThumb.h";
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
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const thumb = useOverlayThumb(ref);
  return (
    <div className="relative">
      <div ref={ref} className={`no-native-scrollbar overflow-y-auto ${className}`}>
        {children}
      </div>
      <Thumb thumb={thumb} />
    </div>
  );
}

/* ---------- Types (domain types live in ./types) ---------- */
