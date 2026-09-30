/**
 * Context gauge in the prompt lip, laid out like Claude's context menu: one
 * line "Context window   used / window (pct)" with a stacked bar, which opens
 * to what takes the space (messages, tool schemas, MCP, skills, system
 * prompt), each category expandable to its lines. For a subscription (the
 * vendor CLIs) the menu also shows the plan and how much of each limit
 * window is used and when it refills. Window sizes come from the model
 * catalog (pricing.rs); token counts are estimates.
 */
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import * as db from "../core/db.r";
import { isCliKind, type ProviderKind } from "../core/types.i";
import type { ContextReport } from "../hooks/useChat.h";
import { POPOVER, popMotion, ScrollArea, Spinner } from "../components";

type Group = db.ContextPart["group"];

/** Category colors (Claude's palette: blue messages, orange tools…). */
const COLOR: Record<Group, string> = {
  messages: "#4f8ff7",
  tools: "#e5673c",
  mcp: "#22a36b",
  skills: "#d9a521",
  system: "#e0508f",
};
const FREE_COLOR = "var(--bg-elevated)";

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

/** "in 4h 57m" / "in 2d 12h" / "now". */
function fmtReset(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "Resets now";
  const m = Math.round(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  const when = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${min}m` : `${min}m`;
  return `Resets in ${when}`;
}

/** Donut: one arc per category, free space as the track (the lip chip). */
function Donut({ parts, total, size, stroke }: { parts: db.ContextPart[]; total: number; size: number; stroke: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
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
  );
}

/** The subscription block: plan, then each limit window with its bar. */
/** How often the limits are re-read while a subscription model is picked. */
const USAGE_EVERY_MS = 60_000;

/**
 * The subscription's limits: the saved reading at once (db, survives
 * restarts), then fresh numbers every minute in the background.
 */
function useCliUsage(kind: ProviderKind | undefined) {
  const [usage, setUsage] = useState<db.CliUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!kind || !isCliKind(kind)) return;
    let alive = true;
    setUsage(null);
    setError(null);
    void db.savedCliUsage(kind).then((s) => alive && s && setUsage((u) => u ?? s.usage));
    const off = db.onCliUsage((k, s) => {
      if (k !== kind || !alive) return;
      setUsage(s.usage);
      setError(null);
    });
    const tick = () =>
      void db.refreshCliUsage(kind).catch((e) => alive && setError(String(e)));
    tick();
    const timer = setInterval(tick, USAGE_EVERY_MS);
    return () => {
      alive = false;
      off();
      clearInterval(timer);
    };
  }, [kind]);
  return { usage, error };
}

function Subscription({ usage, error }: { usage: db.CliUsage | null; error: string | null }) {

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-[var(--border)] px-4 py-2.5">
      <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
        <span className="text-[var(--text-muted)]">Subscription</span>
        <span className="truncate text-[var(--text-main)]">{usage?.plan || ""}</span>
      </div>
      {!usage && !error && (
        <div className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-dim)]">
          <Spinner size={11} /> Checking limits…
        </div>
      )}
      {error && !usage && <div className="text-[11.5px] text-[var(--text-dim)]">{error}</div>}
      {usage && usage.windows.length === 0 && <div className="text-[11.5px] text-[var(--text-dim)]">No limits reported.</div>}
      {usage?.windows.map((w, i) => {
        const used = Math.round(w.used_percent);
        const color = used >= 90 ? "var(--diff-del)" : used >= 70 ? "#f59e0b" : "var(--accent)";
        return (
          <div key={i} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3 text-[12px]">
              <span className="min-w-0 truncate text-[var(--text-main)]">
                {w.group ? <span className="text-[var(--text-muted)]">{w.group} · </span> : null}
                {w.label}
              </span>
              <span className="shrink-0 font-mono text-[11.5px] text-[var(--text-main)]">{used}% used</span>
            </div>
            <div className="h-[3px] overflow-hidden rounded-full bg-[var(--bg-elevated)]">
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, w.used_percent)}%`, background: color }} />
            </div>
            {w.resets_at && <div className="text-[10.5px] text-[var(--text-dim)]">{fmtReset(w.resets_at)}</div>}
          </div>
        );
      })}
    </div>
  );
}

export function ContextMeter({
  load,
  refreshKey,
  busy,
}: {
  /** Fetches the report for the current conversation + model. */
  load: () => Promise<ContextReport | null>;
  /** Changes whenever the conversation or model changes → re-measure. */
  refreshKey: string;
  /** A run is in progress — no re-measuring mid-run. */
  busy?: boolean;
}) {
  const [report, setReport] = useState<ContextReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  /** The category list under the header (collapsed = just header + bar). */
  const [detailed, setDetailed] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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
  const free = Math.max(0, total - used);
  const pct = report ? Math.round((used / total) * 100) : 0;
  const warn = pct >= 85 ? "var(--diff-del)" : pct >= 60 ? "#f59e0b" : undefined;
  const summary = report ? `${fmtTokens(used)} / ${fmtTokens(total)} (${pct}%)` : "";
  const kind = report?.providerKind as ProviderKind | undefined;
  const withItems = parts.filter((p) => p.items.length > 0);
  // Kept current in the background, so the menu opens on numbers.
  const limits = useCliUsage(kind);

  return (
    <div className="relative shrink-0" ref={ref}>
      {/* Square hit area; the small donut sits in it. */}
      <button
        className={`flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-bg)] ${
          open ? "bg-[var(--hover-bg)]" : ""
        }`}
        onClick={() => {
          setOpen(!open);
          if (!open) refresh();
        }}
        title={report ? `Context: ${summary}` : "Context usage"}
      >
        {loading && !report ? <Spinner size={12} /> : <Donut parts={parts} total={total} size={13} stroke={2.5} />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className={`${POPOVER} absolute bottom-[calc(100%+8px)] right-0 w-[340px] max-w-[calc(100vw-24px)] gap-0 overflow-hidden !p-0`}
            style={{ maxHeight: maxH }}
            {...popMotion(true)}
          >
            {!report ? (
              <div className="px-4 py-3 text-[12px] text-[var(--text-dim)]">
                {loading ? "Measuring…" : "Pick a model to see the context usage."}
              </div>
            ) : (
              <>
                {/* Header: "Context window   11.4k / 1M (1%)  ›" — opens the list. */}
                <button
                  className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3 text-left transition-colors hover:text-[var(--text-main)]"
                  onClick={() => setDetailed(!detailed)}
                >
                  <span className="flex-1 text-[13px] text-[var(--text-muted)]">Context window</span>
                  <span className="font-mono text-[12.5px] text-[var(--text-muted)]" style={warn ? { color: warn } : undefined}>
                    {summary}
                  </span>
                  {detailed ? (
                    <ChevronDown size={13} className="shrink-0 text-[var(--text-dim)]" />
                  ) : (
                    <ChevronRight size={13} className="shrink-0 text-[var(--text-dim)]" />
                  )}
                </button>

                {/* Stacked bar. */}
                <div className="mx-4 mb-3 flex h-[5px] shrink-0 gap-[2px] overflow-hidden rounded-full" style={{ background: FREE_COLOR }}>
                  {parts.map((p, i) => (
                    <div key={i} className="rounded-full" style={{ width: `${(p.tokens / total) * 100}%`, background: COLOR[p.group] }} />
                  ))}
                </div>

                {detailed && (
                  <ScrollArea className="flex-1">
                    {/* Categories: "■ Messages   138.8k   13.9%". */}
                    <div className="flex flex-col px-4 pb-2">
                      {parts.map((p) => (
                        <div key={p.label} className="flex items-center gap-2.5 py-[3px] text-[13px]">
                          <span className="h-3 w-3 shrink-0 rounded-[3px]" style={{ background: COLOR[p.group] }} />
                          <span className="min-w-0 flex-1 truncate text-[var(--text-main)]">{p.label}</span>
                          <span className="w-[56px] shrink-0 text-right text-[12.5px] text-[var(--text-dim)]">{fmtTokens(p.tokens)}</span>
                          <span className="w-[48px] shrink-0 text-right text-[12.5px] font-semibold text-[var(--text-main)]">{fmtPct(p.tokens, total)}</span>
                        </div>
                      ))}
                      <div className="flex items-center gap-2.5 py-[3px] text-[13px]">
                        <span className="h-3 w-3 shrink-0 rounded-[3px] border border-[var(--border)]" style={{ background: FREE_COLOR }} />
                        <span className="min-w-0 flex-1 text-[var(--text-main)]">Free space</span>
                        <span className="w-[56px] shrink-0 text-right text-[12.5px] text-[var(--text-dim)]">{fmtTokens(free)}</span>
                        <span className="w-[48px] shrink-0 text-right text-[12.5px] font-semibold text-[var(--text-main)]">{fmtPct(free, total)}</span>
                      </div>
                    </div>

                    {/* Each category's lines: "› MCP tools   55.1k   132". */}
                    {withItems.length > 0 && (
                      <div className="flex flex-col border-t border-[var(--border)] px-2 py-1.5">
                        {withItems.map((p) => {
                          const isOpen = !!expanded[p.label];
                          return (
                            <div key={p.label}>
                              <button
                                className="flex w-full items-center gap-2 rounded-lg px-2 py-[3px] text-[13px] text-[var(--text-main)] transition-colors hover:bg-[var(--hover-bg)]"
                                onClick={() => setExpanded((e) => ({ ...e, [p.label]: !isOpen }))}
                              >
                                <ChevronRight size={12} className={`shrink-0 text-[var(--text-dim)] transition-transform ${isOpen ? "rotate-90" : ""}`} />
                                <span className="min-w-0 flex-1 truncate text-left">{p.label}</span>
                                <span className="w-[56px] shrink-0 text-right text-[12.5px] text-[var(--text-dim)]">{fmtTokens(p.tokens)}</span>
                                <span className="w-[40px] shrink-0 text-right text-[12.5px] text-[var(--text-dim)]">{p.items.filter((it) => !it.note).length}</span>
                              </button>
                              {isOpen && (
                                <div className="mb-1 ml-[26px]">
                                  {p.items.map((it, i) =>
                                    it.note ? (
                                      // Not in the request: what the history bound left out.
                                      <div key={i} className="flex items-center gap-2 py-[2px] pr-2 text-[12px] italic">
                                        <span className="min-w-0 flex-1 truncate text-[var(--text-dim)]" title={it.name}>{it.name}</span>
                                        <span className="w-[56px] shrink-0 text-right text-[var(--text-dim)]">~{fmtTokens(it.tokens)}</span>
                                        <span className="w-[40px] shrink-0 text-right text-[var(--text-dim)]">—</span>
                                      </div>
                                    ) : (
                                      <div key={i} className="flex items-center gap-2 py-[2px] pr-2 text-[12px]">
                                        <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]" title={it.name}>{it.name}</span>
                                        <span className="w-[56px] shrink-0 text-right text-[var(--text-dim)]">{fmtTokens(it.tokens)}</span>
                                        <span className="w-[40px] shrink-0 text-right text-[var(--text-dim)]">{fmtPct(it.tokens, total)}</span>
                                      </div>
                                    )
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </ScrollArea>
                )}

                {kind && isCliKind(kind) && <Subscription usage={limits.usage} error={limits.error} />}

              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
