/* ---------- Model selector (gateways → submenu flies left) ---------- */
/* Sits in the lip under the prompt box; the effort has its own chip. */
import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Zap, Check, Server } from "lucide-react";
import { Gateway } from "../core/types.i";
import { LIP_CHIP, POPOVER, POPOVER_LABEL, popoverItem, popMotion } from "../ui/tokens.s";
import { OverlayScroll } from "../ui/ScrollArea.c";

export function ModelSelector({
  gateways,
  gatewayId,
  modelId,
  onSelect,
  openSignal = 0,
}: {
  gateways: Gateway[];
  gatewayId: string;
  modelId: string;
  onSelect: (gatewayId: string, modelId: string) => void;
  /** Bumping this number opens the menu (the /model command). */
  openSignal?: number;
}) {
  const [open, setOpen] = useState(false);
  const [hoveredGw, setHoveredGw] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // Providers with at least one enabled model are the ones worth showing.
  const usable = gateways.filter((g) => g.models.length > 0);
  const gw = usable.find((g) => g.id === gatewayId) ?? usable[0];
  const model = gw?.models.find((m) => m.id === modelId) ?? gw?.models[0];

  useEffect(() => {
    if (openSignal > 0) {
      setOpen(true);
      setHoveredGw(gw?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal]);

  if (!gw || !model) {
    return (
      <span className={`${LIP_CHIP} cursor-default opacity-60`} title="No models available — connect a provider in Settings → Models">
        <Zap size={12} strokeWidth={1.5} />
        No models
      </span>
    );
  }

  return (
    <div className="relative min-w-0" ref={ref}>
      <span
        className={`${LIP_CHIP} max-w-full ${open ? "bg-[var(--hover-bg)] text-[var(--text-main)]" : ""}`}
        onClick={() => setOpen(!open)}
        title={`${model.name} · ${gw.name}`}
      >
        <span className="truncate">{model.name}</span>
      </span>
      <AnimatePresence>
        {open && (
          <motion.div className={`${POPOVER} absolute bottom-[calc(100%+8px)] right-0 w-[240px] gap-0.5`} {...popMotion(true)}>
            <div className={POPOVER_LABEL}>Provider</div>
            {usable.map((g) => (
              <div
                key={g.id}
                className="relative"
                onMouseEnter={() => setHoveredGw(g.id)}
                onClick={() => setHoveredGw(g.id)}
              >
                <button className={popoverItem(hoveredGw === g.id || (hoveredGw === null && g.id === gw.id))}>
                  <Server size={13} strokeWidth={1.6} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{g.name}</span>
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      g.status === "ready" ? "bg-[var(--diff-add)]" : "bg-[var(--text-dim)]"
                    }`}
                    title={g.status}
                  />
                  {g.id === gw.id && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
                </button>
                <AnimatePresence>
                  {hoveredGw === g.id && (
                    <motion.div
                      className={`${POPOVER} absolute bottom-[-6px] right-[calc(100%+10px)] z-[210] w-[250px]`}
                      initial={{ opacity: 0, x: 6 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 6 }}
                      transition={{ duration: 0.12, ease: "easeOut" }}
                    >
                      <div className={POPOVER_LABEL}>
                        <span className="truncate">{g.name}</span>
                        <span className="normal-case tracking-normal">{g.models.length}</span>
                      </div>
                      {/* Long model lists scroll with the app's own bar. */}
                      <OverlayScroll className="flex max-h-[300px] flex-col gap-0.5 overflow-y-auto">
                        {g.models.map((m) => {
                          const current = g.id === gw.id && m.id === model.id;
                          return (
                            <button
                              key={m.id}
                              className={popoverItem(current)}
                              onClick={() => {
                                onSelect(g.id, m.id);
                                setOpen(false);
                                setHoveredGw(null);
                              }}
                            >
                              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{m.name}</span>
                              {current && <Check size={13} className="shrink-0 text-[var(--accent)]" />}
                            </button>
                          );
                        })}
                      </OverlayScroll>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
