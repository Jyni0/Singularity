/**
 * Aurora Borealis — flowing light curtains behind the chat's lower half.
 *
 * Mounted at the CHAT COLUMN level (App), so the band spans almost the full
 * chat width and rises well above the prompt box — not a strip trapped
 * inside the 760px input container.
 *
 * Visible ONLY while the model is generating: thinking (indigo/violet) or
 * streaming (amber/coral). Idle and error fade the glow out completely.
 *
 * Softness: no hard edges anywhere — a two-axis mask (vertical haze falloff
 * × horizontal edge fade) dissolves the band into the background before any
 * clipping boundary, so nothing ever looks "cut off".
 *
 * Animations are transform/opacity only — compositor-friendly, never steals
 * frames from streaming text.
 */

export type AuroraMood = "idle" | "thinking" | "streaming" | "error";

/** The two generation moods that actually get a palette. */
type GlowMood = "thinking" | "streaming";

/**
 * Curtain colors per mood, back → mid → front. Airy rather than dense: the
 * band is large now, and a heavy fill would read as a solid slab of color.
 * thinking  — indigo / neon violet
 * streaming — amber / coral
 */
const PALETTES: Record<GlowMood, [string, string, string]> = {
  thinking: ["rgba(99, 102, 241, 0.44)", "rgba(167, 109, 246, 0.36)", "rgba(59, 130, 246, 0.34)"],
  streaming: ["rgba(245, 158, 11, 0.42)", "rgba(251, 113, 82, 0.34)", "rgba(244, 63, 94, 0.30)"],
};

const GLOW_MOODS: GlowMood[] = ["thinking", "streaming"];

/**
 * One mood's curtain set. The gradient stacks a soft white-hot base under
 * the mood color: light pools along the bottom and hazes upward, like a
 * northern-lights curtain hanging from its bright lower border.
 */
function MoodLayer({ mood, active }: { mood: GlowMood; active: boolean }) {
  const [c1, c2, c3] = PALETTES[mood];
  const curtain = (color: string) =>
    "radial-gradient(ellipse 75% 95% at 50% 100%, rgba(255,255,255,0.22) 0%, " +
    color + " 34%, transparent 72%)";
  return (
    <div
      className="absolute inset-0 transition-opacity duration-[1200ms] ease-in-out"
      style={{ opacity: active ? 1 : 0 }}
      aria-hidden
    >
      <span className="aurora-blob aurora-blob--a" style={{ background: curtain(c1) }} />
      <span className="aurora-blob aurora-blob--b" style={{ background: curtain(c2) }} />
      <span className="aurora-blob aurora-blob--c" style={{ background: curtain(c3) }} />
    </div>
  );
}

/**
 * The band itself. Sized by CSS classes for the chat-column mount:
 * almost full width, ~420px tall, anchored to the column's bottom edge.
 * The mask pair makes every border dissolve: vertical haze → transparent
 * well before the top, horizontal fade → transparent before both sides.
 */
export function AuroraGlow({ mood }: { mood: AuroraMood }) {
  // The glow exists only while text is being produced.
  const visible = mood === "thinking" || mood === "streaming";
  const maskV = "linear-gradient(to top, black 0%, rgba(0,0,0,0.55) 42%, transparent 88%)";
  const maskH = "linear-gradient(to right, transparent 0%, black 9%, black 91%, transparent 100%)";
  return (
    <div
      className="pointer-events-none absolute inset-x-2 bottom-0 h-[220px] overflow-hidden transition-opacity duration-700 ease-in-out"
      style={{
        opacity: visible ? 1 : 0,
        // Soft haze: welds the curtains together while the ray and grain
        // textures still shimmer through.
        filter: "blur(14px) saturate(1.3)",
        maskImage: maskV + ", " + maskH,
        WebkitMaskImage: maskV + ", " + maskH,
        maskComposite: "intersect",
        WebkitMaskComposite: "source-in",
      }}
      aria-hidden
    >
      {GLOW_MOODS.map((m) => (
        <MoodLayer key={m} mood={m} active={visible && m === mood} />
      ))}
    </div>
  );
}
