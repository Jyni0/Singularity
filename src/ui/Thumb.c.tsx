import { ThumbState } from "../hooks/useOverlayThumb.h";

/**
 * The overlay scrollbar: a vertical thumb hugging the right edge and a
 * horizontal thumb along the bottom — the app's ONE scrollbar style, used
 * by every scrollable surface (ScrollArea / ScrollBox / OverlayScroll).
 */
export function Thumb({ thumb }: { thumb: ThumbState }) {
  return (
    <>
      <div className="pointer-events-none absolute right-0 top-0 h-full w-2">
        <div
          className={`scroll-thumb ${thumb.visible ? "" : "opacity-0"}`}
          style={{ top: `${thumb.top}px`, height: `${thumb.height}px` }}
        />
      </div>
      <div className="pointer-events-none absolute bottom-0 left-0 h-2 w-full">
        <div
          className={`scroll-thumb scroll-thumb--h ${thumb.hVisible ? "" : "opacity-0"}`}
          style={{ left: `${thumb.left}px`, width: `${thumb.width}px` }}
        />
      </div>
    </>
  );
}
