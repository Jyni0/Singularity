import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Zap, ChevronDown, ChevronRight, Check } from "lucide-react";
import { Gateway } from "../core/types.i";
import { CHIP, MENU_ITEM } from "../ui/tokens.s";

export function ModelSelector({
  gateways,
  gatewayId,
  modelId,
  onSelect,
}: {
  gateways: Gateway[];
  gatewayId: string;
  modelId: string;
  onSelect: (gatewayId: string, modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hoveredGw, setHoveredGw] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  // Providers with at least one enabled model are the ones worth showing.
  const usable = gateways.filter((g) => g.models.length > 0);
  const gw = usable.find((g) => g.id === gatewayId) ?? usable[0];
  const model = gw?.models.find((m) => m.id === modelId) ?? gw?.models[0];

  if (!gw || !model) {
    return (
      <span className={`${CHIP} cursor-default opacity-60`} title="No models available — connect a provider in Settings → Models">
        <Zap size={12} strokeWidth={1.5} />
        No models
      </span>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <span className={CHIP} onClick={() => setOpen(!open)}>
        <Zap size={12} strokeWidth={1.5} />
        {model.name}
        <span className="text-[var(--text-dim)]">· {gw.name}</span>
        <ChevronDown size={12} />
      </span>
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute bottom-[calc(100%+8px)] left-0 z-[200] flex min-w-[240px] flex-col gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-2 shadow-[var(--shadow-popup)]"
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            {usable.map((g) => (
              <div
                key={g.id}
                className="relative"
                onMouseEnter={() => setHoveredGw(g.id)}
                onClick={() => setHoveredGw(g.id)}
              >
                <button className={MENU_ITEM}>
                  <span>{g.name}</span>
                  {g.id === gw.id && <Check size={12} />}
                  <span
                    className={`ml-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                      g.status === "ready" ? "bg-[var(--accent)]" : "bg-[var(--text-dim)]"
                    }`}
                    title={g.status}
                  />
                  <ChevronRight size={12} className="ml-auto text-[var(--text-dim)]" />
                </button>
                <AnimatePresence>
                  {hoveredGw === g.id && (
                    <motion.div
                      className="absolute bottom-[-4px] left-[calc(100%+4px)] z-[210] flex min-w-[220px] flex-col gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-2 shadow-[var(--shadow-popup)]"
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -6 }}
                      transition={{ duration: 0.12, ease: "easeOut" }}
                    >
                      {g.models.map((m) => (
                        <button
                          key={m.id}
                          className={`${MENU_ITEM} ${g.id === gw.id && m.id === model.id ? "bg-[var(--hover-bg)]" : ""}`}
                          onClick={() => {
                            onSelect(g.id, m.id);
                            setOpen(false);
                            setHoveredGw(null);
                          }}
                        >
                          <span className="font-mono">{m.name}</span>
                        </button>
                      ))}
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

/* ---------- Project breadcrumb picker (new chat) ---------- */
