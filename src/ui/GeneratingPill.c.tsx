/**
 * "The model is working" indicator — a pill whose border and label carry a
 * slowly flowing gradient (see .generating-* in styles.css). Replaces the
 * plain spinner so a running generation is visible at a glance.
 */
export function GeneratingPill({ label = "Generating…" }: { label?: string }) {
  return (
    <span className="generating-pill">
      <span className="generating-dot" />
      <span className="generating-text">{label}</span>
    </span>
  );
}
