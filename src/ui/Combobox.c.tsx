import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { OverlayScroll } from "./ScrollArea.c";

/** One selectable entry. */
export interface ComboboxOption {
  value: string;
  label: string;
  /** Right-aligned muted hint (e.g. a fingerprint). */
  hint?: string;
  /** Small colored mark before the label (e.g. "✦" for generated keys). */
  mark?: string;
  /** Color dots rendered before the label (e.g. a theme's preview palette). */
  swatch?: string[];
}

/** Three little color dots — a compact palette preview (theme picker). */
function SwatchDots({ colors }: { colors: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-[3px]" aria-hidden>
      {colors.map((c, i) => (
        <span
          key={i}
          className="h-2.5 w-2.5 rounded-full border border-black/20 dark:border-white/20"
          style={{ background: c }}
        />
      ))}
    </span>
  );
}

/**
 * Searchable dropdown — a <select>-like control with a filter box on top.
 * Same visual language as the app's fields (FIELD token height/border/
 * focus ring); the popup is a filtered list, keyboard navigable
 * (↑/↓ + Enter + Esc). Used for the key-credential picker and any other
 * list that can grow long.
 */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Search…",
  emptyText = "Nothing found",
  disabled,
  searchable = true,
}: {
  options: ComboboxOption[];
  /** Current option value ("" allowed when an explicit empty option exists). */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  /** Show the filter box on top of the list (default true). */
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  // Reset the filter every time the popup opens; clamp the cursor.
  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(Math.max(0, filtered.findIndex((o) => o.value === value)));
      // Focus the search box (or the list itself when there is no filter)
      // on the next frame so the popup is mounted and keys are captured.
      requestAnimationFrame(() =>
        searchable ? inputRef.current?.focus() : listRef.current?.focus(),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, searchable]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Click-outside closes the popup.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[cursor];
      if (opt) pick(opt.value);
    }
  };

  return (
    <div ref={boxRef} className="relative">
      {/* Closed state: looks exactly like a FIELD select */}
      <button
        type="button"
        disabled={disabled}
        className="flex h-9 w-full items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-input)] px-2.5 text-left text-[12.5px] outline-none transition-colors hover:border-[var(--text-dim)] disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => setOpen((v) => !v)}
      >
        {selected?.swatch && <SwatchDots colors={selected.swatch} />}
        {selected?.mark && <span className="shrink-0 text-[11px] text-[var(--accent)]">{selected.mark}</span>}
        <span className={"min-w-0 flex-1 truncate " + (selected ? "text-[var(--text-main)]" : "text-[var(--text-dim)]")}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown
          size={13}
          className={"shrink-0 text-[var(--text-dim)] transition-transform duration-150 " + (open ? "rotate-180" : "")}
        />
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-surface)] shadow-[var(--shadow-popup)]"
          onKeyDown={onKeyDown}
        >
          {/* Search input pinned on top of the list */}
          {searchable && (
            <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2.5">
              <Search size={12} className="shrink-0 text-[var(--text-dim)]" />
              <input
                ref={inputRef}
                className="h-8 w-full bg-transparent text-[12px] text-[var(--text-main)] outline-none placeholder:text-[var(--text-dim)]"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={placeholder}
              />
              {query && (
                <button
                  type="button"
                  className="shrink-0 text-[var(--text-dim)] hover:text-[var(--text-main)]"
                  onClick={() => {
                    setQuery("");
                    inputRef.current?.focus();
                  }}
                  title="Clear"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          )}
          <OverlayScroll innerRef={listRef} tabIndex={-1} className="max-h-52 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[11.5px] text-[var(--text-dim)]">{emptyText}</div>
            ) : (
              filtered.map((o, i) => (
                <button
                  key={o.value}
                  type="button"
                  className={
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors " +
                    (i === cursor ? "bg-[var(--hover-bg)]" : "")
                  }
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(o.value)}
                >
                  {o.swatch && <SwatchDots colors={o.swatch} />}
                  {o.mark && <span className="shrink-0 text-[11px] text-[var(--accent)]">{o.mark}</span>}
                  <span className="min-w-0 flex-1 truncate text-[var(--text-main)]">{o.label}</span>
                  {o.hint && <span className="shrink-0 font-mono text-[10px] text-[var(--text-dim)]">{o.hint}</span>}
                  {o.value === value && <Check size={12} className="shrink-0 text-[var(--accent)]" />}
                </button>
              ))
            )}
          </OverlayScroll>
        </div>
      )}
    </div>
  );
}
