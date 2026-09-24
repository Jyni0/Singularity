/**
 * Aurora Glow — the living light under the prompt box.
 *
 * Gemini-on-iPhone style: a soft band of colored light hugging the BOTTOM
 * edge of the input, not a big dense halo around everything. Three
 * horizontally-stretched blobs drift sideways along that band, blurred and
 * screen-blended so they read as one flowing aurora.
 *
 * The palette follows the agent's mood, and moods cross-fade over ~1.2s:
 * every mood renders its own blob set and only the active one is opaque.
 *
 * Pure CSS animation (transform/opacity), so it stays on the compositor and
 * never steals frames from streaming text.
 */

export type AuroraMood = "idle" | "thinking" | "streaming" | "error";

/**
 * Blob palettes per mood, back → mid → front:
 * idle      — deep emerald / mint (calm standby)
 * thinking  — indigo / neon violet (the model is working)
 * streaming — amber / coral (the answer is flowing)
 * error     — ruby red (the last run failed)
 */
const PALETTES: Record<AuroraMood, [string, string, string]> = {
  idle: ["rgba(16, 185, 129, 0.42)", "rgba(52, 211, 153, 0.34)", "rgba(6, 95, 70, 0.40)"],
  thinking: ["rgba(99, 102, 241, 0.46)", "rgba(139, 92, 246, 0.38)", "rgba(67, 56, 202, 0.42)"],
  streaming: ["rgba(245, 158, 11, 0.42)", "rgba(251, 113, 82, 0.36)", "rgba(194, 65, 12, 0.40)"],
  error: ["rgba(225, 29, 72, 0.46)", "rgba(244, 63, 94, 0.34)", "rgba(136, 19, 55, 0.42)"],
};

const MOODS: AuroraMood[] = ["idle", "thinking", "streaming", "error"];

/** One mood's blob set — three stretched lights on staggered drifts. */
function MoodLayer({ mood, active }: { mood: AuroraMood; active: boolean }) {
  const [c1, c2, c3] = PALETTES[mood];
  return (
    <div
      className="absolute inset-0 transition-opacity duration-[1200ms] ease-in-out"
      style={{ opacity: active ? 1 : 0 }}
      aria-hidden
    >
      <span
        className="aurora-blob aurora-blob--a"
        style={{ background: "radial-gradient(ellipse 60% 100% at 50% 100%, " + c1 + ", transparent 72%)" }}
      />
      <span
        className="aurora-blob aurora-blob--b"
        style={{ background: "radial-gradient(ellipse 55% 100% at 50% 100%, " + c2 + ", transparent 72%)" }}
      />
      <span
        className="aurora-blob aurora-blob--c"
        style={{ background: "radial-gradient(ellipse 50% 100% at 50% 100%, " + c3 + ", transparent 72%)" }}
      />
    </div>
  );
}

/**
 * Renders behind the glass prompt container. The band covers only the lower
 * part of the input and spills a little under it — quiet when idle, brighter
 * while the model works.
 */
export function AuroraGlow({ mood }: { mood: AuroraMood }) {
  const active = mood !== "idle";
  return (
    <div
      className="pointer-events-none absolute inset-x-3 bottom-[-14px] top-[45%] overflow-hidden rounded-[28px] transition-opacity duration-[1200ms]"
      style={{
        opacity: active ? 0.95 : 0.6,
        filter: "blur(22px) saturate(1.3)",
        maskImage: "linear-gradient(to bottom, transparent, black 55%)",
        WebkitMaskImage: "linear-gradient(to bottom, transparent, black 55%)",
      }}
      aria-hidden
    >
      {MOODS.map((m) => (
        <MoodLayer key={m} mood={m} active={m === mood} />
      ))}
    </div>
  );
}
