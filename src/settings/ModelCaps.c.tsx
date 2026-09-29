/**
 * A model's limits on its row in Settings → Models: context window and
 * longest answer.
 * Loaded when the row scrolls into view (pricing.rs: Ollama asks the model
 * itself, everything else comes from the OpenRouter catalog). For API models
 * the numbers set by hand (ModelCapsEditor) win and update live.
 */
import { useEffect, useRef, useState } from "react";
import * as db from "../core/db.r";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function ModelCaps({ kind, baseUrl, modelId, rowId }: { kind: string; baseUrl: string; modelId: string; rowId?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [info, setInfo] = useState<db.ModelInfo | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const load = () =>
      void (rowId ? db.effectiveModelInfo(kind, baseUrl, modelId, rowId) : db.modelInfo(kind, baseUrl, modelId))
        .then((i) => alive && setInfo(i))
        .catch(() => {});
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      load();
    });
    io.observe(el);
    const off = rowId ? db.onModelCapsChanged((id) => id === rowId && load()) : () => {};
    return () => {
      alive = false;
      io.disconnect();
      off();
    };
  }, [kind, baseUrl, modelId, rowId]);

  const known = info && (info.context !== null || info.maxOutput !== null);
  return (
    <span ref={ref} className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] text-[var(--text-dim)]">
      {info && !known && <span title="Not in the model catalog">—</span>}
      {info && known && (
        <>
          {info.context !== null && (
            <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-[1px] text-[var(--text-muted)]" title="Context window (tokens)">
              {fmtTokens(info.context)} ctx
            </span>
          )}
          {info.maxOutput !== null && (
            <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-[1px]" title="Longest answer (tokens)">
              {fmtTokens(info.maxOutput)} out
            </span>
          )}
        </>
      )}
    </span>
  );
}
