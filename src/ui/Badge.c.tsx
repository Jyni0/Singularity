

export function Badge({ kind, children }: { kind: "add" | "del" | "run"; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] ${
        kind === "add" ? "badge-add" : kind === "del" ? "badge-del" : "badge-run"
      }`}
    >
      {children}
    </span>
  );
}

/* ---------- Collapsible message ---------- */
