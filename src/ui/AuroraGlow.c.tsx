/**
 * Aurora Glow — the living light behind the prompt box.
 *
 * Yandex-Music-wave style: several soft radial blobs drifting, scaling and
 * breathing inside a heavily blurred, screen-blended layer. The palette is
 * tied to the agent's state (mood), and moods cross-fade over ~1.2s instead
 * of snapping: every mood renders its own blob set and only the active one
 * is opaque — CSS transitions handle the blend.
 *
 * Pure CSS animation (transform/opacity), so it stays on the compositor and
 * never steals frames from streaming text.
 */

export type AuroraMood = "idle" | "thinking" | "streaming" | "error";

/**
 * Blob palettes per mood, in the order back → mid → front:
 * idle      — deep emerald / mint (спокойное ожидание)
 * thinking  — indigo / neon violet (модель думает)
 * streaming — amber / coral (льётся ответ)
 * error     — ruby red (что-то сломалось)
 */
const PALETTES: Record<AuroraMood, [string, string, string]> = {
  idle: ["rgba(16, 185, 129, 0.50)", "rgba(52, 211, 153, 0.40)", "rgba(6, 95, 70, 0.55)"],
  thinking: ["rgba(99, 102, 241, 0.55)", "rgba(139, 92, 246, 0.45)", "rgba(67, 56, 202, 0.55)"],
  streaming: ["rgba(245, 158, 11, 0.50)", "rgba(251, 113, 82, 0.42)", "rgba(194, 65, 12, 0.50)"],
  error: ["rgba(225, 29, 72, 0.55)", "rgba(244, 63, 94, 0.40)", "rgba(136, 19, 55, 0.55)"],
};

const MOODS: AuroraMood[] = ["idle", "thinking", "streaming", "error"];

/**
 * One mood's blob set. Three blobs on staggered drift animations read as a
 * single amorphous plasma rather than three circles.
 */
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
        style={{ background: `radial-gradient(circle at 30% 30%, ${c1}, transparent 70%)` }}
      />
      <span
        className="aurora-blob aurora-blob--b"
        style={{ background: `radial-gradient(circle at 60% 40%, ${c2}, transparent 70%)` }}
      />
      <span
        className="aurora-blob aurora-blob--c"
        style={{ background: `radial-gradient(circle at 45% 70%, ${c3}, transparent 70%)` }}
      />
    </div>
  );
}

/**
 * Renders behind the glass prompt container. `intensity` scales the glow
 * strength — 1 while working, calmer when idle.
 */
export function AuroraGlow({ mood }: { mood: AuroraMood }) {
  const active = mood !== "idle";
  return (
    <div
      className="pointer-events-none absolute -inset-x-6 -inset-y-8 overflow-hidden rounded-[36px] transition-opacity duration-[1200ms]"
      style={{
        opacity: active ? 1 : 0.75,
        filter: active ? "blur(26px) saturate(1.35)" : "blur(30px) saturate(1.1)",
      }}
      aria-hidden
    >
      {MOODS.map((m) => (
        <MoodLayer key={m} mood={m} active={m === mood} />
      ))}
    </div>
  );
}
