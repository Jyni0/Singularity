import { ThumbState } from "../hooks/useOverlayThumb.h";

/** The thumb hugs the right edge of its scroll container — no padding gap. */
export function Thumb({ thumb }: { thumb: ThumbState }) {
  return (
    <div className="pointer-events-none absolute right-0 top-0 h-full w-2">
      <div
        className={`scroll-thumb ${thumb.visible ? "" : "opacity-0"}`}
        style={{ top: `${thumb.top}px`, height: `${thumb.height}px` }}
      />
    </div>
  );
}
