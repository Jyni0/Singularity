/**
 * A model's limits and abilities, set by hand — API providers only (every
 * other provider is automatic). Context window and longest answer feed the
 * context gauge and the request's max_tokens; the switches decide whether the
 * prompt box takes images / files, whether agent mode may use tools, and
 * whether a reasoning effort is sent.
 */
import { useEffect, useState } from "react";
import { Image, FileText, Wrench, Brain, RotateCcw } from "lucide-react";
import * as db from "../core/db.r";
import { Switch, Input, Button } from "../components";

/** "128k" / "1M" / "200000" → tokens; "" → null (automatic). */
function parseTokens(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/[\s_,]/g, "");
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1);
  return n > 0 ? Math.round(n) : null;
}

function fmt(n: number | null | undefined): string {
  if (!n) return "";
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}k`;
  return String(n);
}

export function ModelCapsEditor({ kind, baseUrl, modelId, rowId }: { kind: string; baseUrl: string; modelId: string; rowId: string }) {
  const [detected, setDetected] = useState<db.ModelInfo | null>(null);
  const [caps, setCaps] = useState<db.ModelCapsOverride | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [ctxDraft, setCtxDraft] = useState("");
  const [outDraft, setOutDraft] = useState("");

  useEffect(() => {
    let alive = true;
    void Promise.all([db.modelInfo(kind, baseUrl, modelId).catch(() => null), db.loadModelCaps(rowId)]).then(([info, saved]) => {
      if (!alive) return;
      setDetected(info);
      setCaps(saved);
      setCtxDraft(fmt(saved?.context));
      setOutDraft(fmt(saved?.maxOutput));
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [kind, baseUrl, modelId, rowId]);

  /** What applies now: the saved values, else what the catalog says, else "yes". */
  const current: db.ModelCapsOverride = caps ?? {
    context: null,
    maxOutput: null,
    vision: detected?.vision ?? true,
    files: true,
    tools: detected?.tools ?? true,
    reasoning: detected?.reasoning ?? true,
  };

  const save = async (patch: Partial<db.ModelCapsOverride>) => {
    const next = { ...current, ...patch };
    setCaps(next);
    await db.saveModelCaps(rowId, next);
  };

  const reset = async () => {
    setCaps(null);
    setCtxDraft("");
    setOutDraft("");
    await db.saveModelCaps(rowId, null);
  };

  if (!loaded) return null;

  const toggles: { key: "vision" | "files" | "tools" | "reasoning"; label: string; hint: string; icon: typeof Image }[] = [
    { key: "vision", label: "Images", hint: "Reads attached pictures and screenshots", icon: Image },
    { key: "files", label: "Files", hint: "Takes attached text / code files", icon: FileText },
    { key: "tools", label: "Tools", hint: "Agent mode: reads, edits and runs things", icon: Wrench },
    { key: "reasoning", label: "Reasoning", hint: "Accepts a reasoning effort", icon: Brain },
  ];

  return (
    <div className="mx-2 mb-1.5 mt-0.5 flex flex-col gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2.5">
      <div className="flex items-end gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[11px] text-[var(--text-dim)]">Context window — tokens</span>
          <Input className="font-mono"
            value={ctxDraft}
            placeholder={detected?.context ? `auto · ${fmt(detected.context)}` : "e.g. 128k"}
            onChange={(e) => setCtxDraft(e.target.value)}
            onBlur={() => {
              const n = parseTokens(ctxDraft);
              setCtxDraft(fmt(n));
              void save({ context: n });
            }}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[11px] text-[var(--text-dim)]">Longest answer — tokens</span>
          <Input className="font-mono"
            value={outDraft}
            placeholder={detected?.maxOutput ? `auto · ${fmt(detected.maxOutput)}` : "provider default"}
            onChange={(e) => setOutDraft(e.target.value)}
            onBlur={() => {
              const n = parseTokens(outDraft);
              setOutDraft(fmt(n));
              void save({ maxOutput: n });
            }}
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        {toggles.map(({ key, label, hint, icon: Icon }) => (
          <div key={key} className="flex items-center gap-2" title={hint}>
            <Icon size={13} className="shrink-0 text-[var(--text-muted)]" />
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] text-[var(--text-main)]">{label}</span>
              <span className="block truncate text-[10.5px] text-[var(--text-dim)]">{hint}</span>
            </span>
            <Switch on={current[key]} onChange={(v) => void save({ [key]: v })} ariaLabel={`toggle ${label}`} />
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[10.5px] text-[var(--text-dim)]">
          {caps ? "Set by hand." : "Automatic — from the model catalog where it knows the model."}
        </span>
        {caps && (
          <Button variant="ghost" size="xs" icon={<RotateCcw size={11} />} onClick={() => void reset()}>
            Automatic
          </Button>
        )}
      </div>
    </div>
  );
}
