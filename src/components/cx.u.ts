import { twMerge } from "tailwind-merge";

/** Joins class names; a later Tailwind class wins over an earlier conflicting
 *  one ("h-9 … h-7" → h-7), so callers can override a component's defaults. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return twMerge(parts.filter(Boolean).join(" "));
}
