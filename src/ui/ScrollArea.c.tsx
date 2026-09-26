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
}: {
  children: React.ReactNode;
  className?: string;
  wrapperClassName?: string;
  tabIndex?: number;
  innerRef?: React.RefObject<HTMLDivElement>;
}) {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = innerRef ?? localRef;
  const thumb = useOverlayThumb(ref);
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
