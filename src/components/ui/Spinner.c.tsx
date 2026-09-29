import { LoaderCircle } from "lucide-react";
import { cx } from "../cx.u";

/** Busy indicator. */
export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <LoaderCircle size={size} className={cx("shrink-0 animate-spin", className)} aria-label="Loading" />;
}
