/**
 * Context gauge in the prompt toolbar, laid out like Claude Code's
 * `/context`: how full the model's context window will be with the next
 * request, what takes the space (messages, tool schemas, MCP, skills,
 * system prompt) with each category expandable to its lines, and what it
 * costs. Window sizes and prices come from the model catalog (pricing.rs);
 * token counts are estimates.
 */
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronRight, Loader2, Minimize2, RefreshCw } from "lucide-react";
import type * as db from "../core/db.r";
import type { ContextReport } from "../hooks/useChat.h";
import { CHIP, POPOVER, popMotion } from "../ui/tokens.s";
import { ScrollArea } from "../ui/ScrollArea.c";

type Group = db.ContextPart["group"];

/** Category colors (Claude's palette: blue messages, orange tools…). */
const COLOR: Record<Group, string> = {
  messages: "#4f8ff7",
  tools: "#e5673c",
  mcp: "#22a36b",
  skills: "#d9a521",
  system: "#9aa0a6",
};
const FREE_COLOR = "#3f3f46";

/** Used when the catalog does not know the model. */
const FALLBACK_WINDOW = 128_000;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtPct(part: number, whole: number): string {
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/** Donut: one arc per category, free space as the track. */
function Donut({ parts, total, size, stroke, label }: { parts: db.ContextPart[]; total: number; size: number; stroke: number; label?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={FREE_COLOR} strokeWidth={stroke} />
        {parts.map((p, i) => {
          const len = Math.min(c, (p.tokens / total) * c);
          const el = (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={COLOR[p.group]}
              strokeWidth={stroke}
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
            />
          );
          offset += len;
          return el;
        })}
      </svg>
      {label && (
        <span className="absolute inset-0 flex items-center justify-center font-mono text-[11px] font-semibold text-[var(--text-main)]">
          {label}
        </span>
      )}
    </div>
  );
}

export function ContextMeter({
  load,
  refreshKey,
  busy,
  onCompact,
}: {
  /** Fetches the report for the current conversation + model. */
  load: () => Promise<ContextReport | null>;
  /** Changes whenever the conversation or model changes → re-measure. */
  refreshKey: string;
  /** A run is in progress — compacting waits. */
  busy?: boolean;
  /** Resolves with an error message, or null when done. */
  onCompact?: () => Promise<string | null>;
}) {
  const [report, setReport] = useState<ContextReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [compacting, setCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  /** Room above the chip — the popover never runs past the window's top. */
  const [maxH, setMaxH] = useState(560);
  const ref = useRef<HTMLDivElement>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = () => {
    setLoading(true);
    void loadRef
      .current()
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setLoading(false));
  };

  // Re-measure when the conversation / model changes (debounced; not mid-run).
  useEffect(() => {
    if (busy) return;
    const t = setTimeout(refresh, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, busy]);

  useEffect(() => {
    if (!open) return;
    const fit = () => {
      const top = ref.current?.getBoundingClientRect().top ?? 600;
      setMaxH(Math.max(160, Math.min(640, top - 8 - 12)));
    };
    fit();
    window.addEventListener("resize", fit);
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", fit);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const parts = (report?.parts ?? []).filter((p) => p.tokens > 0);
  const used = parts.reduce((a, p) => a + p.tokens, 0);
  const total = report?.info.context ?? FALLBACK_WINDOW;
  const pct = report ? Math.round((used / total) * 100) : 0;
  const warn = pct >= 85 ? "var(--diff-del)" : pct >= 60 ? "#f59e0b" : undefined;
  const summary = report ? `${fmtTokens(used)} / ${fmtTokens(total)} (${pct}%)` : "";

  return (
    <div className="relative shrink-0" ref={ref}>
      <span
        className={`${CHIP} ${open ? "bg-[var(--hover-bg)] text-[var(--text-main)]" : ""}`}
        onClick={() => {
          setOpen(!open);
          if (!open) refresh();
        }}
        title={report ? `Context: ${summary}` : "Context usage"}
      >
        {loading && !report ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <Donut parts={parts} total={total} size={16} stroke={3} />
        )}
      </span>

      <AnimatePresence>
        {open && (
          <motion.div
            className={`${POPOVER} absolute bottom-[calc(100%+8px)] right-0 w-[380px] max-w-[calc(100vw-24px)] gap-0 overflow-hidden !p-0`}
            style={{ maxHeight: maxH }}
            {...popMotion(true)}
          >
            {!report ? (
              <div className="px-4 py-3 text-[12px] text-[var(--text-dim)]">
                {loading ? "Measuring…" : "Pick a model to see the context usage."}
              </div>
            ) : (
              <>
                {/* Header: donut with the fill + "used / window (pct)". */}
                <div className="flex shrink-0 items-center gap-3 px-4 pb-2 pt-3">
                  <Donut parts={parts} total={total} size={44} stroke={6} label={`${pct}%`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12.5px] text-[var(--text-muted)]">Context window</span>
                      <button
                        className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                        title="Measure again"
                        onClick={refresh}
                      >
                        <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
                      </button>
                    </div>
                    <div className="font-mono text-[13px] text-[var(--text-main)]" style={warn ? { color: warn } : undefined}>
                      {summary}
                    </div>
                    <div className="truncate text-[11px] text-[var(--text-dim)]">{report.modelName}</div>
                  </div>
                </div>

                {/* Thin stacked bar. */}
                <div className="mx-4 flex h-[5px] shrink-0 overflow-hidden rounded-full" style={{ background: FREE_COLOR }}>
                  {parts.map((p, i) => (
                    <div key={i} style={{ width: `${(p.tokens / total) * 100}%`, background: COLOR[p.group] }} />
                  ))}
                </div>

                <ScrollArea className="mt-2 flex-1">
                {/* Categories. */}
                <div className="flex flex-col px-4 pb-1">
                  {parts.map((p) => (
                    <div key={p.label} className="flex items-center gap-2.5 py-[3px] text-[12.5px]">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: COLOR[p.group] }} />
                      <span className="min-w-0 flex-1 truncate text-[var(--text-main)]">{p.label}</span>
                      <span className="w-[56px] shrink-0 text-right font-mono text-[11.5px] text-[var(--text-dim)]">{fmtTokens(p.tokens)}</span>
                      <span className="w-[48px] shrink-0 text-right font-mono text-[11.5px] font-semibold text-[var(--text-main)]">{fmtPct(p.tokens, total)}</span>
                    </div>
                  ))}
                  <div className="flex items-center gap-2.5 py-[3px] text-[12.5px]">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: FREE_COLOR }} />
                    <span className="min-w-0 flex-1 text-[var(--text-muted)]">Free space</span>
                    <span className="w-[56px] shrink-0 text-right font-mono text-[11.5px] text-[var(--text-dim)]">{fmtTokens(Math.max(0, total - used))}</span>
                    <span className="w-[48px] shrink-0 text-right font-mono text-[11.5px] font-semibold text-[var(--text-main)]">
                      {fmtPct(Math.max(0, total - used), total)}
                    </span>
                  </div>
                </div>

                {/* Expandable detail per category: "› MCP tools   55.6k   135". */}
                <div className="flex flex-col border-t border-[var(--border)] px-2 py-1">
                  {parts
                    .filter((p) => p.items.length > 0)
                    .map((p) => {
                      const isOpen = !!expanded[p.label];
                      return (
                        <div key={p.label}>
                          <button
                            className="flex w-full items-center gap-2 rounded-md px-2 py-[3px] text-[12.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)]"
                            onClick={() => setExpanded((e) => ({ ...e, [p.label]: !isOpen }))}
                          >
                            <ChevronRight size={12} className={`shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                            <span className="min-w-0 flex-1 truncate text-left">{p.label}</span>
                            <span className="w-[56px] shrink-0 text-right font-mono text-[11.5px] text-[var(--text-dim)]">{fmtTokens(p.tokens)}</span>
                            <span className="w-[40px] shrink-0 text-right font-mono text-[11.5px] text-[var(--text-dim)]">{p.items.length}</span>
                          </button>
                          {isOpen && (
                            <div className="mb-1 ml-6">
                              {p.items.map((it, i) => (
                                <div key={i} className="flex items-center gap-2 px-2 py-[2px] text-[11.5px]">
                                  <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-muted)]" title={it.name}>{it.name}</span>
                                  <span className="w-[56px] shrink-0 text-right font-mono text-[var(--text-dim)]">{fmtTokens(it.tokens)}</span>
                                  <span className="w-[40px] shrink-0 text-right font-mono text-[var(--text-dim)]">{fmtPct(it.tokens, total)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>

                </ScrollArea>

                {onCompact && (
                  <div className="shrink-0 border-t border-[var(--border)] px-4 py-2">
                    <button
                      className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--border)] py-1.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--text-main)] disabled:opacity-50"
                      disabled={busy || compacting}
                      title="Summarize the conversation and continue from the summary (/compact)"
                      onClick={() => {
                        setCompacting(true);
                        setCompactError(null);
                        void onCompact()
                          .then((err) => {
                            setCompactError(err);
                            if (!err) {
                              setOpen(false);
                              refresh();
                            }
                          })
                          .finally(() => setCompacting(false));
                      }}
                    >
                      {compacting ? <Loader2 size={12} className="animate-spin" /> : <Minimize2 size={12} />}
                      {compacting ? "Compacting…" : "Compact conversation"}
                    </button>
                    {compactError && <div className="mt-1 text-[11px] text-[var(--diff-del)]">{compactError}</div>}
                  </div>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
