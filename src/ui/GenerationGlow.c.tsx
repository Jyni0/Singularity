/**
 * The animation behind the chat while the model works — Settings → General
 * → "Generation animation":
 *   pixels — Aceternity's canvas reveal: a field of squares lights up from
 *            the centre and twinkles (default);
 *   aurora — the soft light curtains (AuroraGlow);
 *   off    — nothing.
 *
 * Pixels is WebGL (three.js), so it is lazy-loaded and only MOUNTED while a
 * generation runs (+ its fade-out); an idle chat has no canvas at all.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { AuroraGlow, type AuroraMood } from "./AuroraGlow.c";

export type GenAnimation = "pixels" | "aurora" | "off";

export const GEN_ANIMATIONS: Array<{ id: GenAnimation; label: string }> = [
  { id: "pixels", label: "Pixels" },
  { id: "aurora", label: "Aurora" },
  { id: "off", label: "Off" },
];

const CanvasRevealEffect = lazy(() => import("./CanvasRevealEffect.c"));

/** Colours per mood — module constants, so the shader is not rebuilt per render. */
const PIXEL_COLORS: Record<"thinking" | "streaming", number[][]> = {
  thinking: [
    [99, 102, 241],
    [167, 109, 246],
  ],
  streaming: [
    [245, 158, 11],
    [251, 113, 82],
  ],
};

/** How long the band fades out before its canvas is unmounted (ms). */
const FADE_MS = 700;

function PixelsGlow({ mood }: { mood: AuroraMood }) {
  const active = mood === "thinking" || mood === "streaming";
  const [mounted, setMounted] = useState(active);
  // Remember the last generating mood so the fade-out keeps its colours.
  const [colorMood, setColorMood] = useState<"thinking" | "streaming">("thinking");

  useEffect(() => {
    if (active) {
      setMounted(true);
      setColorMood(mood as "thinking" | "streaming");
      return;
    }
    const t = window.setTimeout(() => setMounted(false), FADE_MS);
    return () => window.clearTimeout(t);
  }, [active, mood]);

  // Same soft edges as the aurora: fade upwards and towards both sides.
  const maskV = "linear-gradient(to top, black 0%, rgba(0,0,0,0.6) 35%, transparent 92%)";
  const maskH = "linear-gradient(to right, transparent 0%, black 10%, black 90%, transparent 100%)";
  return (
    <div
      className="pointer-events-none absolute inset-x-2 bottom-0 h-[220px] transition-opacity ease-in-out"
      style={{
        opacity: active ? 0.5 : 0,
        transitionDuration: `${FADE_MS}ms`,
        maskImage: maskV + ", " + maskH,
        WebkitMaskImage: maskV + ", " + maskH,
        maskComposite: "intersect",
        WebkitMaskComposite: "source-in",
      }}
      aria-hidden
    >
      {mounted && (
        <Suspense fallback={null}>
          <CanvasRevealEffect animationSpeed={3} colors={PIXEL_COLORS[colorMood]} dotSize={12} totalSize={20} />
        </Suspense>
      )}
    </div>
  );
}

export function GenerationGlow({ mood, style }: { mood: AuroraMood; style: GenAnimation }) {
  if (style === "off") return null;
  if (style === "aurora") return <AuroraGlow mood={mood} />;
  return <PixelsGlow mood={mood} />;
}
